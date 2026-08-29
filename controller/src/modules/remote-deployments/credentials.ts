import type {
  RemoteComputeProviderId,
  RemoteDeploymentCredentialStatus,
} from "@local-studio/contracts/remote-deployments";
import type { StoredRemoteDeploymentCredentials } from "../../stores/controller-settings-store";

export interface RemoteDeploymentCredentials {
  readonly vastApiKey: string | null;
  readonly runpodApiKey: string | null;
  readonly huggingFaceToken: string | null;
}

const secret = (...values: Array<string | undefined>): string | null => {
  const value = values.find((candidate) => candidate?.trim());
  return value?.trim() ?? null;
};

export const readRemoteDeploymentCredentials = (): RemoteDeploymentCredentials => ({
  vastApiKey: secret(process.env["LOCAL_STUDIO_VAST_API_KEY"]),
  runpodApiKey: secret(process.env["LOCAL_STUDIO_RUNPOD_API_KEY"]),
  huggingFaceToken: secret(
    process.env["LOCAL_STUDIO_HF_TOKEN"],
    process.env["HF_TOKEN"],
    process.env["HUGGING_FACE_HUB_TOKEN"],
    process.env["HUGGINGFACE_TOKEN"],
  ),
});

export const mergeRemoteDeploymentCredentials = (
  environment: RemoteDeploymentCredentials,
  stored: StoredRemoteDeploymentCredentials,
): RemoteDeploymentCredentials => ({
  vastApiKey: secret(stored.vastApiKey, environment.vastApiKey ?? undefined),
  runpodApiKey: secret(stored.runpodApiKey, environment.runpodApiKey ?? undefined),
  huggingFaceToken: secret(stored.huggingFaceToken, environment.huggingFaceToken ?? undefined),
});

export const remoteDeploymentCredentialStatuses = (
  environment: RemoteDeploymentCredentials,
  stored: StoredRemoteDeploymentCredentials,
): RemoteDeploymentCredentialStatus[] => [
  {
    id: "vast",
    configured: Boolean(stored.vastApiKey || environment.vastApiKey),
    source: stored.vastApiKey ? "settings" : environment.vastApiKey ? "environment" : "none",
  },
  {
    id: "runpod",
    configured: Boolean(stored.runpodApiKey || environment.runpodApiKey),
    source: stored.runpodApiKey ? "settings" : environment.runpodApiKey ? "environment" : "none",
  },
  {
    id: "huggingface",
    configured: Boolean(stored.huggingFaceToken || environment.huggingFaceToken),
    source: stored.huggingFaceToken
      ? "settings"
      : environment.huggingFaceToken
        ? "environment"
        : "none",
  },
];

export const providerApiKey = (
  credentials: RemoteDeploymentCredentials,
  provider: RemoteComputeProviderId,
): string | null => (provider === "vast" ? credentials.vastApiKey : credentials.runpodApiKey);

export const providerConfigured = (
  credentials: RemoteDeploymentCredentials,
  provider: RemoteComputeProviderId,
): boolean => Boolean(providerApiKey(credentials, provider));
