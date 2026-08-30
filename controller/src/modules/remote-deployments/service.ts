import { randomUUID } from "node:crypto";
import { Effect, Semaphore } from "effect";
import type {
  RemoteComputeOffer,
  RemoteComputeProviderId,
  RemoteComputeRequirements,
  RemoteDeploymentCreateRequest,
  RemoteDeploymentView,
  RemoteOfferResponse,
} from "@local-studio/contracts/remote-deployments";
import type { Config } from "../../config/env";
import type { ProviderConfig } from "../../config/persisted-config";
import { removeProviderConfig, upsertProviderConfig } from "../../services/provider-configs";
import type { DownloadStore } from "../engines/downloads/download-store";
import type { RecipeStore } from "../models/recipes/recipe-store";
import type { EventManager } from "../system/event-manager";
import { makeRemoteBootstrap } from "./bootstrap";
import type { RemoteDeploymentCredentialManager } from "./credential-manager";
import type { RemoteDeploymentFailure, RemoteDeploymentRecord } from "./contracts";
import { probeRemoteVllm, type RemoteReadinessProbe } from "./readiness";
import { resolveRemoteComputeRequirements } from "./requirements";
import {
  pendingRemoteProviderConfig,
  remoteDeploymentFailure as failure,
  remoteDeploymentNow as now,
  remoteDeploymentView,
} from "./state";
import type { RemoteDeploymentStore } from "./store";

const PROVIDER_IDS: readonly RemoteComputeProviderId[] = ["vast", "runpod"];
const OFFER_CACHE_TTL_MS = 5 * 60 * 1000;

type CachedOffer = {
  readonly recipeId: string;
  readonly offer: RemoteComputeOffer;
  readonly expiresAt: number;
};

export interface RemoteDeploymentServiceDependencies {
  readonly config: Config;
  readonly credentialManager: RemoteDeploymentCredentialManager;
  readonly store: RemoteDeploymentStore;
  readonly recipeStore: RecipeStore;
  readonly downloadStore: DownloadStore;
  readonly eventManager: EventManager;
  readonly readinessProbe?: RemoteReadinessProbe;
}

export class RemoteDeploymentService {
  private readonly operationLocks = new Map<string, Semaphore.Semaphore>();
  private readonly offerCache = new Map<string, CachedOffer>();

  public constructor(private readonly dependencies: RemoteDeploymentServiceDependencies) {}

  private withDeploymentLock<A, E, R>(
    id: string,
    operation: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    const existing = this.operationLocks.get(id);
    const lock = existing ?? Semaphore.makeUnsafe(1);
    if (!existing) this.operationLocks.set(id, lock);
    return lock.withPermit(Effect.suspend(operation));
  }

  private getRecord(id: string): Effect.Effect<RemoteDeploymentRecord, RemoteDeploymentFailure> {
    return this.dependencies.store.get(id).pipe(
      Effect.mapError(() => failure("remote-deployment.get", "Could not read deployment state")),
      Effect.flatMap((record) =>
        record
          ? Effect.succeed(record)
          : Effect.fail(failure("remote-deployment.get", "Remote deployment was not found")),
      ),
    );
  }

  private save(
    record: RemoteDeploymentRecord,
  ): Effect.Effect<RemoteDeploymentRecord, RemoteDeploymentFailure> {
    const updated = { ...record, updatedAt: now() } satisfies RemoteDeploymentRecord;
    return this.dependencies.store.save(updated).pipe(
      Effect.mapError(() => failure("remote-deployment.save", "Could not save deployment state")),
      Effect.tap(() =>
        this.dependencies.eventManager.publishRemoteDeployment(remoteDeploymentView(updated)),
      ),
      Effect.as(updated),
    );
  }

  private resolveRequirements(
    recipeId: string,
  ): Effect.Effect<RemoteComputeRequirements, RemoteDeploymentFailure> {
    return this.dependencies.recipeStore.get(recipeId).pipe(
      Effect.mapError(() => failure("remote-requirements.recipe", "Could not read the recipe")),
      Effect.flatMap((recipe) =>
        recipe
          ? resolveRemoteComputeRequirements({
              recipe,
              downloadStore: this.dependencies.downloadStore,
              huggingFaceToken: this.dependencies.credentialManager.huggingFaceToken(),
            })
          : Effect.fail(failure("remote-requirements.recipe", "Recipe was not found")),
      ),
    );
  }

  private offerCacheKey(provider: RemoteComputeProviderId, offerId: string): string {
    return `${provider}:${offerId}`;
  }

  private rememberOffers(recipeId: string, offers: readonly RemoteComputeOffer[]): void {
    const timestamp = Date.now();
    for (const [key, cached] of this.offerCache) {
      if (cached.expiresAt <= timestamp) this.offerCache.delete(key);
    }
    const expiresAt = timestamp + OFFER_CACHE_TTL_MS;
    for (const offer of offers) {
      this.offerCache.set(this.offerCacheKey(offer.provider, offer.id), {
        recipeId,
        offer,
        expiresAt,
      });
    }
  }

  private cachedOffer(request: RemoteDeploymentCreateRequest): RemoteComputeOffer | null {
    const key = this.offerCacheKey(request.provider, request.offer_id);
    const cached = this.offerCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now() || cached.recipeId !== request.recipe_id) {
      this.offerCache.delete(key);
      return null;
    }
    return cached.offer;
  }

  public offers(
    recipeId: string,
    selectedProviders?: readonly RemoteComputeProviderId[],
  ): Effect.Effect<RemoteOfferResponse, RemoteDeploymentFailure> {
    const service = this;
    return Effect.gen(function* () {
      const requirements = yield* service.resolveRequirements(recipeId);
      const ids = selectedProviders?.length ? selectedProviders : PROVIDER_IDS;
      const results = yield* Effect.forEach(ids, (id) =>
        service.dependencies.credentialManager.provider(id).pipe(
          Effect.flatMap((provider) => provider.listOffers(requirements)),
          Effect.match({
            onFailure: (error) => ({
              offers: [] as readonly RemoteComputeOffer[],
              error: { provider: id, message: error.message, retryable: error.retryable },
            }),
            onSuccess: (offers) => ({ offers, error: null }),
          }),
        ),
      );
      const offers = results
        .flatMap((result) => result.offers)
        .sort(
          (left, right) =>
            Number(right.compatible) - Number(left.compatible) ||
            left.hourly_price - right.hourly_price,
        );
      service.rememberOffers(recipeId, offers);
      return {
        requirements,
        offers,
        provider_errors: results.flatMap((result) => (result.error ? [result.error] : [])),
      };
    });
  }

  public list(recipeId?: string): Effect.Effect<RemoteDeploymentView[], RemoteDeploymentFailure> {
    return this.dependencies.store.list().pipe(
      Effect.mapError(() => failure("remote-deployment.list", "Could not read deployment state")),
      Effect.map((records) =>
        records
          .filter((record) => !recipeId || record.recipeId === recipeId)
          .map(remoteDeploymentView),
      ),
    );
  }

  public get(id: string): Effect.Effect<RemoteDeploymentView, RemoteDeploymentFailure> {
    return this.getRecord(id).pipe(Effect.map(remoteDeploymentView));
  }

  private upsertRoute(provider: ProviderConfig): Effect.Effect<void, RemoteDeploymentFailure> {
    return upsertProviderConfig(this.dependencies, provider).pipe(
      Effect.mapError(() =>
        failure("remote-deployment.provider-route", "Could not save provider routing"),
      ),
    );
  }

  private removeRoute(
    record: RemoteDeploymentRecord,
  ): Effect.Effect<void, RemoteDeploymentFailure> {
    return removeProviderConfig(this.dependencies, record.providerRouteId).pipe(
      Effect.mapError(() =>
        failure("remote-deployment.provider-route", "Could not remove provider routing"),
      ),
    );
  }

  private disableRoute(
    record: RemoteDeploymentRecord,
  ): Effect.Effect<void, RemoteDeploymentFailure> {
    const route = this.dependencies.config.providers.find(
      (provider) =>
        provider.id === record.providerRouteId &&
        provider.managed_by_remote_deployment_id === record.id,
    );
    return route ? this.upsertRoute({ ...route, enabled: false }) : Effect.void;
  }

  public create(
    request: RemoteDeploymentCreateRequest,
  ): Effect.Effect<RemoteDeploymentView, RemoteDeploymentFailure> {
    const service = this;
    return Effect.gen(function* () {
      const recipe = yield* service.dependencies.recipeStore.get(request.recipe_id).pipe(
        Effect.mapError(() => failure("remote-deployment.recipe", "Could not read the recipe")),
        Effect.flatMap((value) =>
          value
            ? Effect.succeed(value)
            : Effect.fail(failure("remote-deployment.recipe", "Recipe was not found")),
        ),
      );
      const requirements = yield* service.resolveRequirements(recipe.id);
      const provider = yield* service.dependencies.credentialManager.provider(request.provider);
      const offer =
        service.cachedOffer(request) ??
        (yield* provider
          .listOffers(requirements)
          .pipe(
            Effect.map((offers) => offers.find((candidate) => candidate.id === request.offer_id)),
          ));
      if (!offer?.compatible) {
        return yield* Effect.fail(
          failure(
            "remote-deployment.offer",
            "The selected offer is no longer compatible or available",
            false,
            request.provider,
          ),
        );
      }
      const bootstrap = yield* Effect.try({
        try: () =>
          makeRemoteBootstrap({
            recipe,
            requirements,
            config: service.dependencies.config,
            huggingFaceToken: service.dependencies.credentialManager.huggingFaceToken(),
          }),
        catch: () =>
          failure("remote-deployment.bootstrap", "Could not build the remote vLLM launch plan"),
      });
      const createdAt = now();
      const id = randomUUID();
      const record: RemoteDeploymentRecord = {
        id,
        provider: request.provider,
        providerInstanceId: null,
        providerRouteId: `remote-${request.provider}-${id}`,
        recipeId: recipe.id,
        modelId: requirements.model_id,
        backend: "vllm",
        status: "provisioning",
        stage: "provisioning",
        message: "Creating remote instance",
        offer,
        requirements,
        remoteBaseUrl: null,
        routeModelId: bootstrap.routeModelId,
        createdAt,
        updatedAt: createdAt,
        readinessDeadlineAt: new Date(Date.now() + bootstrap.readyDeadlineMs).toISOString(),
        lastHealthAt: null,
        lastHealthStatus: "unknown",
        error: null,
      };
      return yield* service.withDeploymentLock(id, () =>
        Effect.gen(function* () {
          yield* service.save(record);
          yield* service
            .upsertRoute(
              pendingRemoteProviderConfig({
                record,
                recipeName: recipe.name,
                apiKey: bootstrap.apiKey,
              }),
            )
            .pipe(
              Effect.catch((error) =>
                service
                  .save({
                    ...record,
                    status: "failed",
                    stage: "error",
                    message: error.message,
                    error: error.message,
                  })
                  .pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
          const instance = yield* provider
            .createInstance({
              deploymentId: id,
              offer,
              requirements,
              container: bootstrap.container,
            })
            .pipe(
              Effect.catch((error) =>
                service.removeRoute(record).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(
                    service.save({
                      ...record,
                      status: "failed",
                      stage: "error",
                      message: error.message,
                      error: error.message,
                    }),
                  ),
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            );
          const provisioned = {
            ...record,
            providerInstanceId: instance.id,
            message: "Remote instance is provisioning",
          } satisfies RemoteDeploymentRecord;
          return remoteDeploymentView(
            yield* service.save(provisioned).pipe(
              Effect.catch((error) =>
                provider.destroyInstance(instance.id).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(service.removeRoute(record).pipe(Effect.catch(() => Effect.void))),
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            ),
          );
        }),
      );
    });
  }

  private routeFor(record: RemoteDeploymentRecord): ProviderConfig | null {
    return (
      this.dependencies.config.providers.find(
        (provider) =>
          provider.id === record.providerRouteId &&
          provider.managed_by_remote_deployment_id === record.id,
      ) ?? null
    );
  }

  private failAndDestroy(
    record: RemoteDeploymentRecord,
    message: string,
  ): Effect.Effect<RemoteDeploymentRecord, RemoteDeploymentFailure> {
    const service = this;
    return Effect.gen(function* () {
      yield* service.disableRoute(record).pipe(Effect.catch(() => Effect.void));
      const provider = yield* service.dependencies.credentialManager.provider(record.provider);
      const destroyed = record.providerInstanceId
        ? yield* provider.destroyInstance(record.providerInstanceId).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
        : true;
      if (destroyed) yield* service.removeRoute(record).pipe(Effect.catch(() => Effect.void));
      return yield* service.save({
        ...record,
        status: destroyed ? "failed" : "destroy_failed",
        stage: "error",
        message,
        lastHealthAt: now(),
        lastHealthStatus: "unhealthy",
        error: destroyed ? message : `${message}; provider teardown failed`,
      });
    });
  }

  private markMissing(
    record: RemoteDeploymentRecord,
  ): Effect.Effect<RemoteDeploymentRecord, RemoteDeploymentFailure> {
    return this.removeRoute(record).pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(
        this.save({
          ...record,
          status: "missing",
          stage: "missing",
          message: "Provider instance no longer exists",
          lastHealthAt: now(),
          lastHealthStatus: "unhealthy",
          error: "Provider instance no longer exists",
        }),
      ),
    );
  }

  private reconcileUnlocked(
    id: string,
  ): Effect.Effect<RemoteDeploymentView, RemoteDeploymentFailure> {
    const service = this;
    return Effect.gen(function* () {
      const record = yield* service.getRecord(id);
      if (record.status === "destroying")
        return remoteDeploymentView(yield* service.destroyRecord(record));
      if (record.status !== "provisioning" && record.status !== "ready") {
        return remoteDeploymentView(record);
      }
      if (!record.providerInstanceId)
        return remoteDeploymentView(yield* service.markMissing(record));
      const provider = yield* service.dependencies.credentialManager.provider(record.provider);
      const instance = yield* provider.getInstance(record.providerInstanceId);
      if (!instance) return remoteDeploymentView(yield* service.markMissing(record));
      if (instance.state === "exited" || instance.state === "stopped") {
        return remoteDeploymentView(
          yield* service.failAndDestroy(
            record,
            instance.message ?? "Remote runtime exited before readiness",
          ),
        );
      }
      const deadlineExpired = Date.now() >= Date.parse(record.readinessDeadlineAt);
      if (instance.state !== "running") {
        if (deadlineExpired) {
          return remoteDeploymentView(
            yield* service.failAndDestroy(record, "Remote readiness deadline expired"),
          );
        }
        return remoteDeploymentView(
          yield* service.save({
            ...record,
            stage: "provisioning",
            message: "Remote instance is provisioning",
            error: null,
          }),
        );
      }
      const connection = yield* provider.getConnectionInfo(instance);
      if (!connection) {
        if (deadlineExpired) {
          return remoteDeploymentView(
            yield* service.failAndDestroy(
              record,
              "Remote endpoint was not assigned before the deadline",
            ),
          );
        }
        return remoteDeploymentView(
          yield* service.save({
            ...record,
            stage: "bootstrapping",
            message: "Waiting for the remote endpoint",
            error: null,
          }),
        );
      }
      const route = service.routeFor(record);
      if (!route) {
        return remoteDeploymentView(
          yield* service.failAndDestroy(record, "Remote inference credential is unavailable"),
        );
      }
      const healthy = yield* (service.dependencies.readinessProbe ?? probeRemoteVllm)(
        connection.baseUrl,
        route.api_key,
        record.routeModelId ?? record.modelId,
      );
      if (!healthy) {
        yield* service.upsertRoute({ ...route, base_url: connection.baseUrl, enabled: false });
        if (record.status === "provisioning" && deadlineExpired) {
          return remoteDeploymentView(
            yield* service.failAndDestroy(record, "Remote vLLM readiness deadline expired"),
          );
        }
        return remoteDeploymentView(
          yield* service.save({
            ...record,
            remoteBaseUrl: connection.baseUrl,
            stage: "checking_health",
            message: "Waiting for authenticated vLLM readiness",
            lastHealthAt: now(),
            lastHealthStatus: "unhealthy",
            error: record.status === "ready" ? "Remote health check failed" : null,
          }),
        );
      }
      yield* service.upsertRoute({ ...route, base_url: connection.baseUrl, enabled: true });
      return remoteDeploymentView(
        yield* service.save({
          ...record,
          status: "ready",
          stage: "ready",
          message: "Remote vLLM deployment is ready",
          remoteBaseUrl: connection.baseUrl,
          lastHealthAt: now(),
          lastHealthStatus: "healthy",
          error: null,
        }),
      );
    });
  }

  public reconcile(id: string): Effect.Effect<RemoteDeploymentView, RemoteDeploymentFailure> {
    return this.withDeploymentLock(id, () => this.reconcileUnlocked(id));
  }

  private recordReconcileError(id: string, message: string): Effect.Effect<void> {
    return this.withDeploymentLock(id, () =>
      this.getRecord(id).pipe(
        Effect.flatMap((record) =>
          ["provisioning", "ready", "destroying"].includes(record.status)
            ? this.save({ ...record, error: message }).pipe(Effect.asVoid)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.catch(() => Effect.void));
  }

  public reconcileAll(): Effect.Effect<void> {
    return this.dependencies.store.list().pipe(
      Effect.flatMap((records) =>
        Effect.forEach(
          records.filter((record) =>
            ["provisioning", "ready", "destroying"].includes(record.status),
          ),
          (record) =>
            this.reconcile(record.id).pipe(
              Effect.catch((error) => this.recordReconcileError(record.id, error.message)),
            ),
          { concurrency: 4, discard: true },
        ),
      ),
      Effect.catch(() => Effect.void),
    );
  }

  private destroyRecord(
    record: RemoteDeploymentRecord,
  ): Effect.Effect<RemoteDeploymentRecord, RemoteDeploymentFailure> {
    const service = this;
    return Effect.gen(function* () {
      if (record.status === "destroyed") {
        yield* service.removeRoute(record).pipe(Effect.catch(() => Effect.void));
        return record;
      }
      yield* service.disableRoute(record);
      const destroying = yield* service.save({
        ...record,
        status: "destroying",
        stage: "destroying",
        message: "Destroying remote instance",
        error: null,
      });
      const provider = yield* service.dependencies.credentialManager.provider(record.provider);
      const destroyed = destroying.providerInstanceId
        ? yield* provider.destroyInstance(destroying.providerInstanceId).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
        : true;
      if (!destroyed) {
        return yield* service.save({
          ...destroying,
          status: "destroy_failed",
          stage: "error",
          message: "Provider teardown failed; retry destroy",
          error: "Provider teardown failed",
        });
      }
      yield* service.removeRoute(destroying).pipe(Effect.catch(() => Effect.void));
      return yield* service.save({
        ...destroying,
        status: "destroyed",
        stage: "destroyed",
        message: "Remote instance was destroyed",
        remoteBaseUrl: null,
        lastHealthAt: now(),
        lastHealthStatus: "unknown",
        error: null,
      });
    });
  }

  public destroy(id: string): Effect.Effect<RemoteDeploymentView, RemoteDeploymentFailure> {
    return this.withDeploymentLock(id, () =>
      this.getRecord(id).pipe(
        Effect.flatMap((record) => this.destroyRecord(record)),
        Effect.map(remoteDeploymentView),
      ),
    );
  }
}
