import { Effect } from "effect";
import type { RemoteComputeProviderId } from "@local-studio/contracts/remote-deployments";
import { RemoteDeploymentFailure } from "../contracts";

export type RemoteProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Effect.Effect<Response, unknown>;

export const remoteProviderFetch: RemoteProviderFetch = (input, init) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
    catch: (error) => error,
  });

const failure = (
  provider: RemoteComputeProviderId,
  operation: string,
  message: string,
  retryable: boolean,
): RemoteDeploymentFailure =>
  new RemoteDeploymentFailure({ provider, operation, message, retryable });

export const providerRequest = (input: {
  readonly provider: RemoteComputeProviderId;
  readonly operation: string;
  readonly url: string | URL;
  readonly apiKey: string;
  readonly init?: RequestInit;
  readonly allowNotFound?: boolean;
  readonly fetchImpl?: RemoteProviderFetch;
}): Effect.Effect<Response | null, RemoteDeploymentFailure> =>
  (input.fetchImpl ?? remoteProviderFetch)(input.url, {
    ...input.init,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      ...input.init?.headers,
    },
    signal: AbortSignal.any(
      [AbortSignal.timeout(15_000), input.init?.signal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      ),
    ),
  }).pipe(
    Effect.mapError(() =>
      failure(input.provider, input.operation, "Provider request failed", true),
    ),
    Effect.flatMap((response) => {
      if (input.allowNotFound && response.status === 404) return Effect.succeed(null);
      if (response.ok) return Effect.succeed(response);
      return Effect.fail(
        failure(
          input.provider,
          input.operation,
          `Provider returned status ${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        ),
      );
    }),
  );

export const providerJson = (
  provider: RemoteComputeProviderId,
  operation: string,
  response: Response,
): Effect.Effect<unknown, RemoteDeploymentFailure> =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: () => failure(provider, operation, "Provider response was not valid JSON", false),
  });

export const providerDecodeFailure = (
  provider: RemoteComputeProviderId,
  operation: string,
): RemoteDeploymentFailure =>
  failure(provider, operation, "Provider response did not match its contract", false);
