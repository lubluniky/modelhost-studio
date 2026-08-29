import { Effect, Schema } from "effect";
import { badRequest, notFound } from "../../core/errors";
import { decodeJsonBody } from "../../core/validation";
import { effectRoute, defineRoutes, mergeRoutes } from "../../http/route-registrar";
import type { ProviderConfig } from "../../config/persisted-config";
import {
  removeProviderConfig,
  upsertProviderConfig,
} from "../../services/provider-configs";
import {
  discoverProviderModels,
  enabledProvidersWithApiKey,
} from "../../services/provider-routing";

type ProviderView = {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  has_api_key: boolean;
};

const ProviderCreateSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  base_url: Schema.String,
  api_key: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
});

const ProviderUpdateSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  base_url: Schema.optional(Schema.String),
  api_key: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
});

const serializeProvider = (provider: ProviderConfig): ProviderView => ({
  id: provider.id,
  name: provider.name,
  base_url: provider.base_url,
  enabled: provider.enabled,
  has_api_key: Boolean(provider.api_key),
});

const required = (
  value: string,
  label: string,
): Effect.Effect<string, ReturnType<typeof badRequest>> => {
  const trimmed = value.trim();
  return trimmed ? Effect.succeed(trimmed) : Effect.fail(badRequest(`${label} is required`));
};

export const registerStudioProviderRoutes = defineRoutes((app, context) => {
  return mergeRoutes(
    effectRoute(app.get, "/studio/providers", (ctx) =>
      Effect.sync(() => ctx.json({ providers: context.config.providers.map(serializeProvider) })),
    ),

    effectRoute(app.post, "/studio/providers", (ctx) =>
      Effect.gen(function* () {
        const body = yield* decodeJsonBody(ctx, ProviderCreateSchema);
        const id = (yield* required(body.id, "id")).toLowerCase();
        const name = yield* required(body.name, "name");
        const baseUrl = yield* required(body.base_url, "base_url");
        if (context.config.providers.some((provider) => provider.id === id)) {
          return yield* Effect.fail(badRequest(`Provider "${id}" already exists`));
        }
        const provider: ProviderConfig = {
          id,
          name,
          base_url: baseUrl,
          api_key: body.api_key?.trim() ?? "",
          enabled: body.enabled ?? true,
        };
        yield* upsertProviderConfig(context, provider);
        return ctx.json({ success: true, provider: serializeProvider(provider) });
      }),
    ),

    effectRoute(app.put, "/studio/providers/:id", (ctx) =>
      Effect.gen(function* () {
        const providerId = ctx.req.param("id") ?? "";
        const body = yield* decodeJsonBody(ctx, ProviderUpdateSchema);
        const index = context.config.providers.findIndex((provider) => provider.id === providerId);
        const current = index >= 0 ? context.config.providers[index] : undefined;
        if (!current) return yield* Effect.fail(notFound(`Provider "${providerId}" not found`));
        if (current.managed_by_remote_deployment_id) {
          return yield* Effect.fail(
            badRequest("Managed remote providers can only be changed through their deployment"),
          );
        }
        const name = body.name === undefined ? current.name : yield* required(body.name, "name");
        const baseUrl =
          body.base_url === undefined
            ? current.base_url
            : yield* required(body.base_url, "base_url");
        const updated: ProviderConfig = {
          id: providerId,
          name,
          base_url: baseUrl,
          api_key: body.api_key?.trim() ?? current.api_key,
          enabled: body.enabled ?? current.enabled,
        };
        yield* upsertProviderConfig(context, updated);
        return ctx.json({ success: true, provider: serializeProvider(updated) });
      }),
    ),

    effectRoute(app.delete, "/studio/providers/:id", (ctx) =>
      Effect.gen(function* () {
        const providerId = ctx.req.param("id") ?? "";
        const provider = context.config.providers.find((candidate) => candidate.id === providerId);
        if (!provider) {
          return yield* Effect.fail(notFound(`Provider "${providerId}" not found`));
        }
        if (provider.managed_by_remote_deployment_id) {
          return yield* Effect.fail(
            badRequest("Managed remote providers can only be removed with their deployment"),
          );
        }
        yield* removeProviderConfig(context, providerId);
        return ctx.json({ success: true });
      }),
    ),

    effectRoute(app.get, "/studio/provider-models", (ctx) =>
      Effect.forEach(
        enabledProvidersWithApiKey(context.config.providers),
        (provider) => discoverProviderModels(provider).pipe(Effect.option),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) =>
          ctx.json({
            providers: results.flatMap((result) => (result._tag === "Some" ? [result.value] : [])),
          }),
        ),
      ),
    ),
  );
});
