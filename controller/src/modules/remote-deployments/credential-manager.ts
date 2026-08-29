import { Effect, Semaphore } from "effect";
import type {
  RemoteComputeProviderId,
  RemoteDeploymentCredentialStatus,
  RemoteDeploymentCredentialUpdate,
  RemoteProviderStatus,
} from "@local-studio/contracts/remote-deployments";
import type {
  ControllerSettingsStore,
  StoredRemoteDeploymentCredentials,
} from "../../stores/controller-settings-store";
import {
  mergeRemoteDeploymentCredentials,
  providerConfigured,
  remoteDeploymentCredentialStatuses,
  type RemoteDeploymentCredentials,
} from "./credentials";
import type { RemoteComputeProvider, RemoteDeploymentFailure } from "./contracts";
import { makeRunPodProvider } from "./providers/runpod";
import { makeVastProvider } from "./providers/vast";
import { remoteDeploymentFailure as failure } from "./state";

const PROVIDER_IDS: readonly RemoteComputeProviderId[] = ["vast", "runpod"];

export interface RemoteDeploymentCredentialManagerDependencies {
  readonly environment: RemoteDeploymentCredentials;
  readonly store: Pick<
    ControllerSettingsStore,
    | "getRemoteDeploymentCredentials"
    | "getRemoteDeploymentCredentialsEffect"
    | "saveRemoteDeploymentCredentialsEffect"
  >;
}

export class RemoteDeploymentCredentialManager {
  private stored: StoredRemoteDeploymentCredentials;
  private effective: RemoteDeploymentCredentials;
  private providers: ReadonlyMap<RemoteComputeProviderId, RemoteComputeProvider>;
  private readonly lock = Semaphore.makeUnsafe(1);

  public constructor(private readonly dependencies: RemoteDeploymentCredentialManagerDependencies) {
    this.stored = dependencies.store.getRemoteDeploymentCredentials();
    this.effective = mergeRemoteDeploymentCredentials(dependencies.environment, this.stored);
    this.providers = this.makeProviders();
  }

  private makeProviders(): ReadonlyMap<RemoteComputeProviderId, RemoteComputeProvider> {
    const providers = new Map<RemoteComputeProviderId, RemoteComputeProvider>();
    if (this.effective.vastApiKey) {
      providers.set("vast", makeVastProvider(this.effective.vastApiKey));
    }
    if (this.effective.runpodApiKey) {
      providers.set("runpod", makeRunPodProvider(this.effective.runpodApiKey));
    }
    return providers;
  }

  private reload(stored: StoredRemoteDeploymentCredentials): void {
    this.stored = stored;
    this.effective = mergeRemoteDeploymentCredentials(this.dependencies.environment, stored);
    this.providers = this.makeProviders();
  }

  public providerStatuses(): RemoteProviderStatus[] {
    return PROVIDER_IDS.map((id) => ({
      id,
      configured: providerConfigured(this.effective, id),
      supported_backends: ["vllm"],
      supports_single_gpu: true,
    }));
  }

  public credentialStatuses(): RemoteDeploymentCredentialStatus[] {
    return remoteDeploymentCredentialStatuses(this.dependencies.environment, this.stored);
  }

  public huggingFaceToken(): string | null {
    return this.effective.huggingFaceToken;
  }

  public provider(
    id: RemoteComputeProviderId,
  ): Effect.Effect<RemoteComputeProvider, RemoteDeploymentFailure> {
    const provider = this.providers.get(id);
    return provider
      ? Effect.succeed(provider)
      : Effect.fail(
          failure("remote-provider.credentials", `${id} credential is not configured`, false, id),
        );
  }

  public update(
    update: RemoteDeploymentCredentialUpdate,
  ): Effect.Effect<RemoteDeploymentCredentialStatus[], RemoteDeploymentFailure> {
    const manager = this;
    return this.lock.withPermit(
      Effect.gen(function* () {
        const changes = [
          ["vast_api_key", "vastApiKey"],
          ["runpod_api_key", "runpodApiKey"],
          ["huggingface_token", "huggingFaceToken"],
        ] as const;
        if (!changes.some(([wireKey]) => update[wireKey] !== undefined)) {
          return yield* Effect.fail(
            failure("remote-credentials.update", "No credential changes were provided"),
          );
        }
        const current = yield* manager.dependencies.store
          .getRemoteDeploymentCredentialsEffect()
          .pipe(
            Effect.mapError(() =>
              failure("remote-credentials.read", "Could not read remote credentials"),
            ),
          );
        const next: {
          vastApiKey?: string | undefined;
          runpodApiKey?: string | undefined;
          huggingFaceToken?: string | undefined;
        } = { ...current };
        for (const [wireKey, storedKey] of changes) {
          const value = update[wireKey];
          if (value === undefined) continue;
          if (value === null) {
            delete next[storedKey];
            continue;
          }
          const trimmed = value.trim();
          if (!trimmed || trimmed.length > 16_384) {
            return yield* Effect.fail(
              failure("remote-credentials.update", "Credential value is invalid"),
            );
          }
          next[storedKey] = trimmed;
        }
        const saved = yield* manager.dependencies.store
          .saveRemoteDeploymentCredentialsEffect(next)
          .pipe(
            Effect.mapError(() =>
              failure("remote-credentials.save", "Could not save remote credentials"),
            ),
          );
        manager.reload(saved);
        return manager.credentialStatuses();
      }),
    );
  }
}
