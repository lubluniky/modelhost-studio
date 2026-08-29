import type {
  RemoteComputeProviderId,
  RemoteDeploymentView,
} from "@local-studio/contracts/remote-deployments";
import type { ProviderConfig } from "../../config/persisted-config";
import {
  RemoteDeploymentFailure,
  type RemoteDeploymentRecord,
} from "./contracts";

export const remoteDeploymentFailure = (
  operation: string,
  message: string,
  retryable = false,
  provider?: RemoteComputeProviderId,
): RemoteDeploymentFailure =>
  new RemoteDeploymentFailure({
    operation,
    message,
    retryable,
    ...(provider ? { provider } : {}),
  });

export const remoteDeploymentNow = (): string => new Date().toISOString();

export const pendingRemoteProviderConfig = (input: {
  readonly record: RemoteDeploymentRecord;
  readonly recipeName: string;
  readonly apiKey: string;
}): ProviderConfig => ({
  id: input.record.providerRouteId,
  name: `${input.recipeName} on ${input.record.provider}`,
  base_url: "http://127.0.0.1:1",
  api_key: input.apiKey,
  enabled: false,
  managed_by_remote_deployment_id: input.record.id,
});

export const remoteDeploymentView = (
  record: RemoteDeploymentRecord,
): RemoteDeploymentView => ({
  id: record.id,
  provider: record.provider,
  provider_instance_id: record.providerInstanceId,
  recipe_id: record.recipeId,
  model_id: record.modelId,
  backend: record.backend,
  status: record.status,
  stage: record.stage,
  message: record.message,
  offer: record.offer,
  requirements: record.requirements,
  remote_base_url: record.remoteBaseUrl,
  route_model_id: record.routeModelId,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  last_health_at: record.lastHealthAt,
  last_health_status: record.lastHealthStatus,
  error: record.error,
});
