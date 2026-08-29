import { Schema, type Effect } from "effect";
import {
  RemoteComputeOfferSchema,
  RemoteComputeProviderIdSchema,
  RemoteComputeRequirementsSchema,
  RemoteDeploymentStageSchema,
  RemoteDeploymentStatusSchema,
  RemoteHealthStatusSchema,
  type RemoteComputeOffer,
  type RemoteComputeProviderId,
  type RemoteComputeRequirements,
} from "@local-studio/contracts/remote-deployments";

export const REMOTE_PROVIDER_INSTANCE_STATES = [
  "provisioning",
  "running",
  "stopped",
  "exited",
  "missing",
  "unknown",
] as const;

export const RemoteProviderInstanceStateSchema = Schema.Literals(REMOTE_PROVIDER_INSTANCE_STATES);

export const RemoteDeploymentRecordSchema = Schema.Struct({
  id: Schema.String,
  provider: RemoteComputeProviderIdSchema,
  providerInstanceId: Schema.NullOr(Schema.String),
  providerRouteId: Schema.String,
  recipeId: Schema.String,
  modelId: Schema.String,
  backend: Schema.Literal("vllm"),
  status: RemoteDeploymentStatusSchema,
  stage: RemoteDeploymentStageSchema,
  message: Schema.String,
  offer: RemoteComputeOfferSchema,
  requirements: RemoteComputeRequirementsSchema,
  remoteBaseUrl: Schema.NullOr(Schema.String),
  routeModelId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  readinessDeadlineAt: Schema.String,
  lastHealthAt: Schema.NullOr(Schema.String),
  lastHealthStatus: RemoteHealthStatusSchema,
  error: Schema.NullOr(Schema.String),
});

export class RemoteDeploymentFailure extends Schema.TaggedErrorClass<RemoteDeploymentFailure>()(
  "RemoteDeploymentFailure",
  {
    operation: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    provider: Schema.optional(RemoteComputeProviderIdSchema),
    providerInstanceId: Schema.optional(Schema.String),
  },
) {}

export interface RemoteContainerSpec {
  readonly image: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly port: number;
}

export interface RemoteInstanceSpec {
  readonly deploymentId: string;
  readonly offer: RemoteComputeOffer;
  readonly requirements: RemoteComputeRequirements;
  readonly container: RemoteContainerSpec;
}

export interface RemoteProviderInstance {
  readonly id: string;
  readonly state: RemoteProviderInstanceState;
  readonly message: string | null;
}

export interface RemoteConnectionInfo {
  readonly baseUrl: string;
}

export interface RemoteComputeProvider {
  readonly id: RemoteComputeProviderId;
  readonly listOffers: (
    requirements: RemoteComputeRequirements,
  ) => Effect.Effect<readonly RemoteComputeOffer[], RemoteDeploymentFailure>;
  readonly createInstance: (
    spec: RemoteInstanceSpec,
  ) => Effect.Effect<RemoteProviderInstance, RemoteDeploymentFailure>;
  readonly getInstance: (
    id: string,
  ) => Effect.Effect<RemoteProviderInstance | null, RemoteDeploymentFailure>;
  readonly getConnectionInfo: (
    instance: RemoteProviderInstance,
  ) => Effect.Effect<RemoteConnectionInfo | null, RemoteDeploymentFailure>;
  readonly destroyInstance: (id: string) => Effect.Effect<void, RemoteDeploymentFailure>;
}

export type RemoteProviderInstanceState = Schema.Schema.Type<
  typeof RemoteProviderInstanceStateSchema
>;
export type RemoteDeploymentRecord = Schema.Schema.Type<typeof RemoteDeploymentRecordSchema>;
