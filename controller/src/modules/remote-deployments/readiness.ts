import { Effect, Schema } from "effect";

const RemoteModelsSchema = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});

export type RemoteReadinessProbe = (
  baseUrl: string,
  apiKey: string,
  modelId: string,
) => Effect.Effect<boolean>;

export const probeRemoteVllm: RemoteReadinessProbe = (baseUrl, apiKey, modelId) => {
  const fetchRemote = (path: string): Effect.Effect<Response, unknown> =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        }),
      catch: (error) => error,
    });
  return Effect.gen(function* () {
    const health = yield* fetchRemote("/health");
    if (!health.ok) return false;
    const models = yield* fetchRemote("/v1/models");
    if (!models.ok) return false;
    const payload = yield* Effect.tryPromise({
      try: () => models.json(),
      catch: (error) => error,
    });
    const decoded = yield* Schema.decodeUnknownEffect(RemoteModelsSchema)(payload);
    return decoded.data.some((model) => model.id === modelId);
  }).pipe(Effect.catch(() => Effect.succeed(false)));
};
