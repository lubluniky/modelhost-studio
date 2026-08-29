import { Schema } from "effect";

export const REMOTE_COMPUTE_PROVIDER_IDS = ["vast", "runpod"] as const;
export const REMOTE_DEPLOYMENT_STATUSES = [
  "provisioning",
  "ready",
  "failed",
  "destroying",
  "destroyed",
  "destroy_failed",
  "missing",
] as const;
export const REMOTE_DEPLOYMENT_STAGES = [
  "resolving",
  "provisioning",
  "bootstrapping",
  "starting",
  "checking_health",
  "ready",
  "destroying",
  "destroyed",
  "error",
  "missing",
] as const;
export const REMOTE_HEALTH_STATUSES = ["healthy", "unhealthy", "unknown"] as const;

export const RemoteComputeProviderIdSchema = Schema.Literals(REMOTE_COMPUTE_PROVIDER_IDS);
export const RemoteDeploymentStatusSchema = Schema.Literals(REMOTE_DEPLOYMENT_STATUSES);
export const RemoteDeploymentStageSchema = Schema.Literals(REMOTE_DEPLOYMENT_STAGES);
export const RemoteHealthStatusSchema = Schema.Literals(REMOTE_HEALTH_STATUSES);

export const RemoteComputeRequirementsSchema = Schema.Struct({
  recipe_id: Schema.String,
  model_id: Schema.String,
  backend: Schema.Literal("vllm"),
  min_vram_gb: Schema.Number,
  weight_size_gb: Schema.Number,
  gpu_count: Schema.Literal(1),
  context_length: Schema.Number,
  quantization: Schema.NullOr(Schema.String),
});

export const RemoteComputeOfferSchema = Schema.Struct({
  id: Schema.String,
  provider: RemoteComputeProviderIdSchema,
  gpu_name: Schema.String,
  gpu_memory_gb: Schema.Number,
  gpu_count: Schema.Number,
  system_memory_gb: Schema.NullOr(Schema.Number),
  cpu_cores: Schema.NullOr(Schema.Number),
  region: Schema.NullOr(Schema.String),
  hourly_price: Schema.Number,
  interruptible: Schema.Boolean,
  reliability: Schema.NullOr(Schema.Number),
  availability: Schema.NullOr(Schema.String),
  compatible: Schema.Boolean,
});

export const RemoteDeploymentViewSchema = Schema.Struct({
  id: Schema.String,
  provider: RemoteComputeProviderIdSchema,
  provider_instance_id: Schema.NullOr(Schema.String),
  recipe_id: Schema.String,
  model_id: Schema.String,
  backend: Schema.Literal("vllm"),
  status: RemoteDeploymentStatusSchema,
  stage: RemoteDeploymentStageSchema,
  message: Schema.String,
  offer: RemoteComputeOfferSchema,
  requirements: RemoteComputeRequirementsSchema,
  remote_base_url: Schema.NullOr(Schema.String),
  route_model_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  last_health_at: Schema.NullOr(Schema.String),
  last_health_status: RemoteHealthStatusSchema,
  error: Schema.NullOr(Schema.String),
});

export const RemoteOfferRequestSchema = Schema.Struct({
  recipe_id: Schema.String,
  providers: Schema.optional(Schema.Array(RemoteComputeProviderIdSchema)),
});

export const RemoteDeploymentCreateRequestSchema = Schema.Struct({
  recipe_id: Schema.String,
  provider: RemoteComputeProviderIdSchema,
  offer_id: Schema.String,
});

export const RemoteProviderStatusSchema = Schema.Struct({
  id: RemoteComputeProviderIdSchema,
  configured: Schema.Boolean,
  supported_backends: Schema.Array(Schema.Literal("vllm")),
  supports_single_gpu: Schema.Literal(true),
});

export const RemoteProviderOfferErrorSchema = Schema.Struct({
  provider: RemoteComputeProviderIdSchema,
  message: Schema.String,
  retryable: Schema.Boolean,
});

export const RemoteOfferResponseSchema = Schema.Struct({
  requirements: RemoteComputeRequirementsSchema,
  offers: Schema.Array(RemoteComputeOfferSchema),
  provider_errors: Schema.Array(RemoteProviderOfferErrorSchema),
});

export type RemoteComputeProviderId = Schema.Schema.Type<typeof RemoteComputeProviderIdSchema>;
export type RemoteDeploymentStatus = Schema.Schema.Type<typeof RemoteDeploymentStatusSchema>;
export type RemoteDeploymentStage = Schema.Schema.Type<typeof RemoteDeploymentStageSchema>;
export type RemoteHealthStatus = Schema.Schema.Type<typeof RemoteHealthStatusSchema>;
export type RemoteComputeRequirements = Schema.Schema.Type<typeof RemoteComputeRequirementsSchema>;
export type RemoteComputeOffer = Schema.Schema.Type<typeof RemoteComputeOfferSchema>;
export type RemoteDeploymentView = Schema.Schema.Type<typeof RemoteDeploymentViewSchema>;
export type RemoteOfferRequest = Schema.Schema.Type<typeof RemoteOfferRequestSchema>;
export type RemoteDeploymentCreateRequest = Schema.Schema.Type<
  typeof RemoteDeploymentCreateRequestSchema
>;
export type RemoteProviderStatus = Schema.Schema.Type<typeof RemoteProviderStatusSchema>;
export type RemoteProviderOfferError = Schema.Schema.Type<typeof RemoteProviderOfferErrorSchema>;
export type RemoteOfferResponse = Schema.Schema.Type<typeof RemoteOfferResponseSchema>;
