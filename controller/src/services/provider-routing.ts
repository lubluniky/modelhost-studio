import { Effect, Schema } from "effect";
import type { ProviderConfig } from "../config/persisted-config";

export const DEFAULT_CHAT_PROVIDER = "openai";

export interface ParsedProviderModel {
  provider: string;
  modelId: string;
}

export interface ProviderRouteConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ControllerProviderRoutingConfig {
  providers?: ProviderConfig[];
}

export interface ProviderModelCatalog {
  provider: string;
  models: Array<{ id: string; max_model_len?: number }>;
}

const ProviderModelsSchema = Schema.Struct({
  data: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        max_model_len: Schema.optional(Schema.Number),
      }),
    ),
  ),
});

const stripTrailingV1 = (baseUrl: string): string =>
  baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");

export const parseProviderModel = (rawModel: string): ParsedProviderModel => {
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return { provider: DEFAULT_CHAT_PROVIDER, modelId: "" };
  }

  const delimiter = trimmed.indexOf("/");
  if (delimiter > 0 && delimiter < trimmed.length - 1) {
    const provider = trimmed.slice(0, delimiter).trim();
    const modelId = trimmed.slice(delimiter + 1).trim();
    if (modelId.length > 0) {
      return { provider: provider || DEFAULT_CHAT_PROVIDER, modelId };
    }
  }

  return { provider: DEFAULT_CHAT_PROVIDER, modelId: trimmed };
};

export const resolveConfiguredProviderConfig = (
  providerId: string,
  providers: ProviderConfig[] = [],
): ProviderRouteConfig | null => {
  const match = providers.find((p) => p.id.toLowerCase() === providerId.toLowerCase() && p.enabled);
  if (!match || !match.api_key) return null;
  return { baseUrl: stripTrailingV1(match.base_url), apiKey: match.api_key };
};

export const resolveProviderConfig = (
  provider: string,
  config: ControllerProviderRoutingConfig = {},
): ProviderRouteConfig | null => {
  return resolveConfiguredProviderConfig(provider, config.providers);
};

export const enabledProvidersWithApiKey = (providers: ProviderConfig[] = []): ProviderConfig[] =>
  providers.filter((provider) => provider.enabled && provider.api_key);

export const discoverProviderModels = (
  provider: ProviderConfig,
  timeoutMs = 10_000,
): Effect.Effect<ProviderModelCatalog, unknown> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${stripTrailingV1(provider.base_url)}/v1/models`, {
          headers: { Authorization: `Bearer ${provider.api_key}` },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      catch: (source) => source,
    });
    if (!response.ok) return yield* Effect.fail(response.status);
    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (source) => source,
    });
    const decoded = yield* Schema.decodeUnknownEffect(ProviderModelsSchema)(payload);
    const models = (decoded.data ?? []).flatMap((model) => {
      const id = model.id?.trim();
      return id
        ? [{ id, ...(model.max_model_len ? { max_model_len: model.max_model_len } : {}) }]
        : [];
    });
    return { provider: provider.id, models };
  });

const DISCOVERY_TIMEOUT_MS = 3_000;
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;

const catalogCache = new Map<string, { expiresAt: number; catalog: ProviderModelCatalog }>();

export const listProviderModelsCached = (
  providers: ProviderConfig[] = [],
): Effect.Effect<ProviderModelCatalog[]> =>
  Effect.forEach(
    enabledProvidersWithApiKey(providers),
    (provider) => {
      const key = `${provider.id}\n${provider.base_url}\n${provider.api_key}`;
      const cached = catalogCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return Effect.succeed(cached.catalog);
      return discoverProviderModels(provider, DISCOVERY_TIMEOUT_MS).pipe(
        Effect.tap((catalog) =>
          Effect.sync(() =>
            catalogCache.set(key, { expiresAt: Date.now() + SUCCESS_TTL_MS, catalog }),
          ),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            const catalog: ProviderModelCatalog = { provider: provider.id, models: [] };
            catalogCache.set(key, { expiresAt: Date.now() + FAILURE_TTL_MS, catalog });
            return catalog;
          }),
        ),
      );
    },
    { concurrency: "unbounded" },
  );
