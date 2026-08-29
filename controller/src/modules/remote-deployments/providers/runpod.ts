import { Effect, Schema } from "effect";
import type {
  RemoteComputeOffer,
  RemoteComputeRequirements,
} from "@local-studio/contracts/remote-deployments";
import type {
  RemoteComputeProvider,
  RemoteInstanceSpec,
  RemoteProviderInstance,
  RemoteProviderInstanceState,
} from "../contracts";
import { RemoteDeploymentFailure } from "../contracts";
import {
  providerDecodeFailure,
  providerJson,
  providerRequest,
  remoteProviderFetch,
  type RemoteProviderFetch,
} from "./request";

const RUNPOD_GRAPHQL = "https://api.runpod.io/graphql";
const RUNPOD_REST = "https://rest.runpod.io/v1/pods";

const RunPodPriceSchema = Schema.NullOr(
  Schema.Struct({
    stockStatus: Schema.optional(Schema.NullOr(Schema.String)),
    uninterruptablePrice: Schema.optional(Schema.NullOr(Schema.Number)),
    availableGpuCounts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Number))),
  }),
);

const RunPodGpuTypeSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  memoryInGb: Schema.Number,
  securePrice: Schema.optional(RunPodPriceSchema),
  communityPrice: Schema.optional(RunPodPriceSchema),
});

const RunPodGpuResponseSchema = Schema.Struct({
  data: Schema.NullOr(Schema.Struct({ gpuTypes: Schema.Array(RunPodGpuTypeSchema) })),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
});

const RunPodPodSchema = Schema.Struct({
  id: Schema.String,
  desiredStatus: Schema.optional(Schema.String),
  lastStatusChange: Schema.optional(Schema.NullOr(Schema.String)),
});

type RunPodGpuType = Schema.Schema.Type<typeof RunPodGpuTypeSchema>;

const decode = <S extends Schema.Constraint>(
  schema: S,
  operation: string,
  value: unknown,
): Effect.Effect<S["Type"], RemoteDeploymentFailure, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => providerDecodeFailure("runpod", operation)),
  );

const stockAvailable = (price: RunPodGpuType["securePrice"]): boolean =>
  Boolean(
    price &&
    price.uninterruptablePrice &&
    price.uninterruptablePrice > 0 &&
    price.stockStatus !== "None" &&
    (price.availableGpuCounts?.includes(1) ?? true),
  );

const offerFor = (
  gpu: RunPodGpuType,
  requirements: RemoteComputeRequirements,
  cloud: "SECURE" | "COMMUNITY",
  price: RunPodGpuType["securePrice"],
): RemoteComputeOffer | null => {
  if (!price?.uninterruptablePrice) return null;
  const available = stockAvailable(price);
  return {
    id: `${cloud.toLowerCase()}:${gpu.id}`,
    provider: "runpod",
    gpu_name: gpu.displayName,
    gpu_memory_gb: gpu.memoryInGb,
    gpu_count: 1,
    system_memory_gb: null,
    cpu_cores: null,
    region: null,
    hourly_price: price.uninterruptablePrice,
    interruptible: false,
    reliability: null,
    availability: `${cloud.toLowerCase()}:${price.stockStatus ?? "Unknown"}`,
    compatible: available && gpu.memoryInGb >= requirements.min_vram_gb,
  };
};

export const normalizeRunPodOffers = (
  gpuTypes: readonly RunPodGpuType[],
  requirements: RemoteComputeRequirements,
): RemoteComputeOffer[] =>
  gpuTypes
    .flatMap((gpu) => [
      offerFor(gpu, requirements, "SECURE", gpu.securePrice),
      offerFor(gpu, requirements, "COMMUNITY", gpu.communityPrice),
    ])
    .filter((offer): offer is RemoteComputeOffer => offer !== null)
    .sort((left, right) => left.hourly_price - right.hourly_price);

const podState = (status: string | undefined): RemoteProviderInstanceState => {
  if (status === "RUNNING") return "running";
  if (status === "EXITED") return "exited";
  if (status === "TERMINATED") return "missing";
  return "provisioning";
};

const normalizePod = (pod: Schema.Schema.Type<typeof RunPodPodSchema>): RemoteProviderInstance => ({
  id: pod.id,
  state: podState(pod.desiredStatus),
  message: pod.lastStatusChange ?? null,
});

const parseOfferId = (id: string): { cloud: "SECURE" | "COMMUNITY"; gpuTypeId: string } | null => {
  const separator = id.indexOf(":");
  if (separator < 1) return null;
  const cloud = id.slice(0, separator).toUpperCase();
  const gpuTypeId = id.slice(separator + 1);
  if ((cloud !== "SECURE" && cloud !== "COMMUNITY") || !gpuTypeId) return null;
  return { cloud, gpuTypeId };
};

export const makeRunPodProvider = (
  apiKey: string,
  fetchImpl: RemoteProviderFetch = remoteProviderFetch,
): RemoteComputeProvider => {
  const listOffers = (
    requirements: RemoteComputeRequirements,
  ): Effect.Effect<readonly RemoteComputeOffer[], RemoteDeploymentFailure> =>
    Effect.gen(function* () {
      const url = new URL(RUNPOD_GRAPHQL);
      url.searchParams.set("api_key", apiKey);
      const response = yield* providerRequest({
        provider: "runpod",
        operation: "runpod.list-offers",
        url,
        apiKey,
        fetchImpl,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query:
              "query { gpuTypes { id displayName memoryInGb securePrice: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus uninterruptablePrice availableGpuCounts } communityPrice: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { stockStatus uninterruptablePrice availableGpuCounts } } }",
          }),
        },
      });
      if (!response) return [];
      const payload = yield* providerJson("runpod", "runpod.list-offers", response);
      const decoded = yield* decode(RunPodGpuResponseSchema, "runpod.list-offers", payload);
      if (!decoded.data || (decoded.errors?.length ?? 0) > 0) {
        return yield* Effect.fail(
          new RemoteDeploymentFailure({
            provider: "runpod",
            operation: "runpod.list-offers",
            message: "RunPod rejected the GPU catalog query",
            retryable: false,
          }),
        );
      }
      return normalizeRunPodOffers(decoded.data.gpuTypes, requirements);
    });

  const getInstance = (
    id: string,
  ): Effect.Effect<RemoteProviderInstance | null, RemoteDeploymentFailure> =>
    Effect.gen(function* () {
      const response = yield* providerRequest({
        provider: "runpod",
        operation: "runpod.get-pod",
        url: `${RUNPOD_REST}/${encodeURIComponent(id)}`,
        apiKey,
        fetchImpl,
        allowNotFound: true,
      });
      if (!response) return null;
      const payload = yield* providerJson("runpod", "runpod.get-pod", response);
      return normalizePod(yield* decode(RunPodPodSchema, "runpod.get-pod", payload));
    });

  return {
    id: "runpod",
    listOffers,
    createInstance: (spec: RemoteInstanceSpec) =>
      Effect.gen(function* () {
        const selected = parseOfferId(spec.offer.id);
        if (!selected) {
          return yield* Effect.fail(
            new RemoteDeploymentFailure({
              provider: "runpod",
              operation: "runpod.create-pod",
              message: "RunPod offer id is invalid",
              retryable: false,
            }),
          );
        }
        const response = yield* providerRequest({
          provider: "runpod",
          operation: "runpod.create-pod",
          url: RUNPOD_REST,
          apiKey,
          fetchImpl,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `local-studio-${spec.deploymentId}`,
              imageName: spec.container.image,
              cloudType: selected.cloud,
              computeType: "GPU",
              gpuTypeIds: [selected.gpuTypeId],
              gpuTypePriority: "custom",
              gpuCount: spec.requirements.gpu_count,
              interruptible: false,
              containerDiskInGb: Math.max(
                40,
                Math.ceil(spec.requirements.weight_size_gb * 1.5 + 10),
              ),
              ports: [`${spec.container.port}/http`],
              supportPublicIp: false,
              dockerEntrypoint: ["vllm", "serve"],
              dockerStartCmd: spec.container.argv,
              env: spec.container.env,
            }),
          },
        });
        if (!response) {
          return yield* Effect.fail(
            new RemoteDeploymentFailure({
              provider: "runpod",
              operation: "runpod.create-pod",
              message: "RunPod did not return a Pod",
              retryable: false,
            }),
          );
        }
        const payload = yield* providerJson("runpod", "runpod.create-pod", response);
        return normalizePod(yield* decode(RunPodPodSchema, "runpod.create-pod", payload));
      }),
    getInstance,
    getConnectionInfo: (instance) =>
      Effect.succeed(
        instance.state === "running"
          ? { baseUrl: `https://${instance.id}-8000.proxy.runpod.net` }
          : null,
      ),
    destroyInstance: (id) =>
      providerRequest({
        provider: "runpod",
        operation: "runpod.destroy-pod",
        url: `${RUNPOD_REST}/${encodeURIComponent(id)}`,
        apiKey,
        fetchImpl,
        allowNotFound: true,
        init: { method: "DELETE" },
      }).pipe(Effect.asVoid),
  };
};
