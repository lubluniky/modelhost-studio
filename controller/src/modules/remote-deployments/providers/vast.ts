import { Effect, Schema } from "effect";
import type {
  RemoteComputeOffer,
  RemoteComputeRequirements,
} from "@local-studio/contracts/remote-deployments";
import type {
  RemoteComputeProvider,
  RemoteConnectionInfo,
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

const VAST_API = "https://console.vast.ai/api/v0";
const VAST_PORT = "8000/tcp";

const VastOfferSchema = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  gpu_name: Schema.optional(Schema.String),
  gpu_ram: Schema.optional(Schema.Number),
  gpu_total_ram: Schema.optional(Schema.Number),
  num_gpus: Schema.optional(Schema.Number),
  cpu_ram: Schema.optional(Schema.Number),
  cpu_cores_effective: Schema.optional(Schema.Number),
  cpu_cores: Schema.optional(Schema.Number),
  geolocation: Schema.optional(Schema.NullOr(Schema.String)),
  dph_total_adj: Schema.optional(Schema.Number),
  dph_total: Schema.optional(Schema.Number),
  reliability2: Schema.optional(Schema.Number),
  reliability: Schema.optional(Schema.Number),
  rentable: Schema.optional(Schema.Boolean),
  rented: Schema.optional(Schema.Boolean),
  is_bid: Schema.optional(Schema.Boolean),
});

const VastOffersResponseSchema = Schema.Struct({
  offers: Schema.Union([Schema.Array(VastOfferSchema), VastOfferSchema]),
});

const VastCreateResponseSchema = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  new_contract: Schema.Union([Schema.Number, Schema.String]),
});

const VastPortBindingSchema = Schema.Struct({
  HostPort: Schema.String,
});

const VastInstanceSchema = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  actual_status: Schema.optional(Schema.NullOr(Schema.String)),
  status_msg: Schema.optional(Schema.NullOr(Schema.String)),
  public_ipaddr: Schema.optional(Schema.NullOr(Schema.String)),
  ports: Schema.optional(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Array(VastPortBindingSchema)),
      Schema.Array(Schema.Number),
    ]),
  ),
});

const VastInstanceResponseSchema = Schema.Struct({ instances: VastInstanceSchema });

type VastOffer = Schema.Schema.Type<typeof VastOfferSchema>;
type VastInstance = Schema.Schema.Type<typeof VastInstanceSchema>;

const decode = <S extends Schema.Constraint>(
  schema: S,
  operation: string,
  value: unknown,
): Effect.Effect<S["Type"], RemoteDeploymentFailure, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => providerDecodeFailure("vast", operation)),
  );

const memoryGb = (megabytes: number | undefined): number =>
  megabytes === undefined ? 0 : megabytes / 1024;

const quoteArgument = (argument: string): string => `'${argument.replace(/'/g, `'"'"'`)}'`;

export const normalizeVastOffer = (
  offer: VastOffer,
  requirements: RemoteComputeRequirements,
): RemoteComputeOffer => {
  const gpuMemoryGb = memoryGb(offer.gpu_ram ?? offer.gpu_total_ram);
  const gpuCount = offer.num_gpus ?? 0;
  const hourlyPrice = offer.dph_total_adj ?? offer.dph_total ?? 0;
  const available = offer.rentable !== false && offer.rented !== true && hourlyPrice > 0;
  return {
    id: String(offer.id),
    provider: "vast",
    gpu_name: offer.gpu_name ?? "Unknown NVIDIA GPU",
    gpu_memory_gb: gpuMemoryGb,
    gpu_count: gpuCount,
    system_memory_gb: offer.cpu_ram === undefined ? null : memoryGb(offer.cpu_ram),
    cpu_cores: offer.cpu_cores_effective ?? offer.cpu_cores ?? null,
    region: offer.geolocation ?? null,
    hourly_price: hourlyPrice,
    interruptible: offer.is_bid ?? false,
    reliability: offer.reliability2 ?? offer.reliability ?? null,
    availability: available ? "available" : "unavailable",
    compatible:
      available && gpuCount === requirements.gpu_count && gpuMemoryGb >= requirements.min_vram_gb,
  };
};

export const normalizeVastOffers = (
  offers: readonly VastOffer[],
  requirements: RemoteComputeRequirements,
): RemoteComputeOffer[] =>
  offers
    .map((offer) => normalizeVastOffer(offer, requirements))
    .sort((left, right) => left.hourly_price - right.hourly_price);

const instanceState = (status: string | null | undefined): RemoteProviderInstanceState => {
  if (status === null || status === undefined || status === "loading" || status === "rebooting") {
    return "provisioning";
  }
  if (status === "running" || status === "frozen") return "running";
  if (status === "stopped") return "stopped";
  if (status === "exited") return "exited";
  if (status === "offline") return "unknown";
  return "unknown";
};

const normalizeInstance = (instance: VastInstance): RemoteProviderInstance => ({
  id: String(instance.id),
  state: instanceState(instance.actual_status),
  message: instance.status_msg ?? null,
});

const mappedPort = (ports: VastInstance["ports"]): string | null => {
  if (!ports || Array.isArray(ports)) return null;
  const bindings = ports as Readonly<Record<string, readonly { readonly HostPort: string }[]>>;
  return bindings[VAST_PORT]?.[0]?.HostPort ?? null;
};

export const makeVastProvider = (
  apiKey: string,
  fetchImpl: RemoteProviderFetch = remoteProviderFetch,
): RemoteComputeProvider => {
  const listOffers = (
    requirements: RemoteComputeRequirements,
  ): Effect.Effect<readonly RemoteComputeOffer[], RemoteDeploymentFailure> =>
    Effect.gen(function* () {
      const response = yield* providerRequest({
        provider: "vast",
        operation: "vast.list-offers",
        url: `${VAST_API}/bundles/`,
        apiKey,
        fetchImpl,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            limit: 50,
            type: "ondemand",
            verified: { eq: true },
            rentable: { eq: true },
            rented: { eq: false },
            num_gpus: { eq: requirements.gpu_count },
            order: [["dph_total", "asc"]],
          }),
        },
      });
      if (!response) return [];
      const payload = yield* providerJson("vast", "vast.list-offers", response);
      const decoded = yield* decode(VastOffersResponseSchema, "vast.list-offers", payload);
      const offers = Array.isArray(decoded.offers) ? decoded.offers : [decoded.offers];
      return normalizeVastOffers(offers, requirements);
    });

  const createInstance = (
    spec: RemoteInstanceSpec,
  ): Effect.Effect<RemoteProviderInstance, RemoteDeploymentFailure> =>
    Effect.gen(function* () {
      if (!/^\d+$/.test(spec.offer.id)) {
        return yield* Effect.fail(
          new RemoteDeploymentFailure({
            provider: "vast",
            operation: "vast.create-instance",
            message: "Vast offer id is invalid",
            retryable: false,
          }),
        );
      }
      const response = yield* providerRequest({
        provider: "vast",
        operation: "vast.create-instance",
        url: `${VAST_API}/asks/${spec.offer.id}/`,
        apiKey,
        fetchImpl,
        init: {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: spec.container.image,
            label: `local-studio-${spec.deploymentId}`,
            disk: Math.max(40, Math.ceil(spec.requirements.weight_size_gb * 1.5 + 10)),
            runtype: "args",
            args_str: spec.container.argv.map(quoteArgument).join(" "),
            cancel_unavail: true,
            env: {
              ...spec.container.env,
              [`-p ${spec.container.port}:${spec.container.port}`]: "1",
            },
          }),
        },
      });
      if (!response) {
        return yield* Effect.fail(
          new RemoteDeploymentFailure({
            provider: "vast",
            operation: "vast.create-instance",
            message: "Vast did not return an instance",
            retryable: false,
          }),
        );
      }
      const payload = yield* providerJson("vast", "vast.create-instance", response);
      const created = yield* decode(VastCreateResponseSchema, "vast.create-instance", payload);
      return { id: String(created.new_contract), state: "provisioning", message: null };
    });

  const getRawInstance = (
    id: string,
  ): Effect.Effect<VastInstance | null, RemoteDeploymentFailure> =>
    Effect.gen(function* () {
      const response = yield* providerRequest({
        provider: "vast",
        operation: "vast.get-instance",
        url: `${VAST_API}/instances/${encodeURIComponent(id)}/`,
        apiKey,
        fetchImpl,
        allowNotFound: true,
      });
      if (!response) return null;
      const payload = yield* providerJson("vast", "vast.get-instance", response);
      const decoded = yield* decode(VastInstanceResponseSchema, "vast.get-instance", payload);
      return decoded.instances;
    });

  return {
    id: "vast",
    listOffers,
    createInstance,
    getInstance: (id) =>
      getRawInstance(id).pipe(Effect.map((value) => value && normalizeInstance(value))),
    getConnectionInfo: (
      instance,
    ): Effect.Effect<RemoteConnectionInfo | null, RemoteDeploymentFailure> =>
      getRawInstance(instance.id).pipe(
        Effect.map((value) => {
          if (!value || instanceState(value.actual_status) !== "running") return null;
          const port = mappedPort(value.ports);
          return value.public_ipaddr && port
            ? { baseUrl: `http://${value.public_ipaddr}:${port}` }
            : null;
        }),
      ),
    destroyInstance: (id) =>
      providerRequest({
        provider: "vast",
        operation: "vast.destroy-instance",
        url: `${VAST_API}/instances/${encodeURIComponent(id)}/`,
        apiKey,
        fetchImpl,
        allowNotFound: true,
        init: { method: "DELETE" },
      }).pipe(Effect.asVoid),
  };
};
