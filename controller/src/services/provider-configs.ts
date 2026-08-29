import { Effect, Schema, Semaphore } from "effect";
import { savePersistedConfig, type ProviderConfig } from "../config/persisted-config";

export class ProviderConfigPersistenceError extends Schema.TaggedErrorClass<ProviderConfigPersistenceError>()(
  "ProviderConfigPersistenceError",
  { message: Schema.String, source: Schema.optional(Schema.Unknown) },
) {}

export interface ProviderConfigContext {
  readonly config: {
    readonly data_dir: string;
    providers: ProviderConfig[];
  };
}

const providerConfigLock = Semaphore.makeUnsafe(1);

const saveProviderConfigs = (
  context: ProviderConfigContext,
  providers: ProviderConfig[],
): Effect.Effect<void, ProviderConfigPersistenceError> =>
  Effect.try({
    try: () => {
      savePersistedConfig(context.config.data_dir, { providers });
      context.config.providers = providers;
    },
    catch: (source) =>
      new ProviderConfigPersistenceError({ message: "Could not save providers", source }),
  });

export const upsertProviderConfig = (
  context: ProviderConfigContext,
  provider: ProviderConfig,
): Effect.Effect<void, ProviderConfigPersistenceError> =>
  providerConfigLock.withPermit(
    Effect.suspend(() => {
      const providers = context.config.providers.filter(
        (candidate) => candidate.id !== provider.id,
      );
      return saveProviderConfigs(context, [...providers, provider]);
    }),
  );

export const removeProviderConfig = (
  context: ProviderConfigContext,
  providerId: string,
): Effect.Effect<void, ProviderConfigPersistenceError> =>
  providerConfigLock.withPermit(
    Effect.suspend(() =>
      saveProviderConfigs(
        context,
        context.config.providers.filter((provider) => provider.id !== providerId),
      ),
    ),
  );
