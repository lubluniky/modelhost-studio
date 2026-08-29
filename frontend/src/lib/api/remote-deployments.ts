import type {
  RemoteComputeProviderId,
  RemoteDeploymentCreateRequest,
  RemoteDeploymentView,
  RemoteOfferResponse,
  RemoteProviderStatus,
} from "@local-studio/contracts/remote-deployments";
import type { ApiCore } from "./core";

export function createRemoteDeploymentsApi(core: ApiCore) {
  return {
    getRemoteProviderStatuses: (): Promise<{ providers: RemoteProviderStatus[] }> =>
      core.request("/remote-deployments/providers"),

    getRemoteOffers: (payload: {
      recipe_id: string;
      providers?: RemoteComputeProviderId[];
    }): Promise<RemoteOfferResponse> =>
      core.request("/remote-deployments/offers", {
        method: "POST",
        body: JSON.stringify(payload),
        timeout: 45_000,
        retries: 0,
      }),

    getRemoteDeployments: (recipeId?: string): Promise<{ deployments: RemoteDeploymentView[] }> =>
      core.request(
        `/remote-deployments${recipeId ? `?recipe_id=${encodeURIComponent(recipeId)}` : ""}`,
      ),

    createRemoteDeployment: (
      payload: RemoteDeploymentCreateRequest,
    ): Promise<{ deployment: RemoteDeploymentView }> =>
      core.request("/remote-deployments", {
        method: "POST",
        body: JSON.stringify(payload),
        timeout: 60_000,
        retries: 0,
      }),

    destroyRemoteDeployment: (
      deploymentId: string,
    ): Promise<{ deployment: RemoteDeploymentView }> =>
      core.request(`/remote-deployments/${encodeURIComponent(deploymentId)}`, {
        method: "DELETE",
        timeout: 45_000,
        retries: 0,
      }),
  };
}
