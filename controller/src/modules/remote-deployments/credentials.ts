import type { RemoteComputeProviderId } from "@local-studio/contracts/remote-deployments";

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

export const providerApiKey = (
  credentials: RemoteDeploymentCredentials,
  provider: RemoteComputeProviderId,
): string | null => (provider === "vast" ? credentials.vastApiKey : credentials.runpodApiKey);

export const providerConfigured = (
  credentials: RemoteDeploymentCredentials,
  provider: RemoteComputeProviderId,
): boolean => Boolean(providerApiKey(credentials, provider));
