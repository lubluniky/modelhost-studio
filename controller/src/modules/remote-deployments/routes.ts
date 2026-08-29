import { Effect } from "effect";
import {
  RemoteDeploymentCredentialUpdateSchema,
  RemoteDeploymentCreateRequestSchema,
  RemoteOfferRequestSchema,
} from "@local-studio/contracts/remote-deployments";
import { badRequest, notFound, serviceUnavailable, type HttpStatus } from "../../core/errors";
import { decodeJsonBody } from "../../core/validation";
import { defineRoutes, effectRoute, mergeRoutes } from "../../http/route-registrar";
import type { RemoteDeploymentFailure } from "./contracts";

const routeFailure = (error: RemoteDeploymentFailure): HttpStatus => {
  if (
    error.operation === "remote-deployment.get" &&
    error.message === "Remote deployment was not found"
  ) {
    return notFound(error.message);
  }
  if (
    error.operation.startsWith("remote-requirements") ||
    error.operation === "remote-credentials.update" ||
    error.operation === "remote-deployment.recipe" ||
    error.operation === "remote-deployment.offer" ||
    error.operation === "remote-deployment.bootstrap"
  ) {
    return badRequest(error.message);
  }
  return serviceUnavailable(error.message);
};

export const registerRemoteDeploymentRoutes = defineRoutes((app, context) =>
  mergeRoutes(
    effectRoute(app.get, "/remote-deployments/providers", (ctx) =>
      Effect.succeed(
        ctx.json({ providers: context.remoteDeploymentCredentials.providerStatuses() }),
      ),
    ),
    effectRoute(app.get, "/remote-deployments/credentials", (ctx) =>
      Effect.succeed(
        ctx.json({ credentials: context.remoteDeploymentCredentials.credentialStatuses() }),
      ),
    ),
    effectRoute(app.put, "/remote-deployments/credentials", (ctx) =>
      Effect.gen(function* () {
        const body = yield* decodeJsonBody(ctx, RemoteDeploymentCredentialUpdateSchema);
        const credentials = yield* context.remoteDeploymentCredentials
          .update(body)
          .pipe(Effect.mapError(routeFailure));
        return ctx.json({ credentials });
      }),
    ),
    effectRoute(app.post, "/remote-deployments/offers", (ctx) =>
      Effect.gen(function* () {
        const body = yield* decodeJsonBody(ctx, RemoteOfferRequestSchema);
        const result = yield* context.remoteDeployments
          .offers(body.recipe_id, body.providers)
          .pipe(Effect.mapError(routeFailure));
        return ctx.json(result);
      }),
    ),
    effectRoute(app.get, "/remote-deployments", (ctx) =>
      context.remoteDeployments.list(ctx.req.query("recipe_id")).pipe(
        Effect.map((deployments) => ctx.json({ deployments })),
        Effect.mapError(routeFailure),
      ),
    ),
    effectRoute(app.get, "/remote-deployments/:deploymentId", (ctx) =>
      context.remoteDeployments.get(ctx.req.param("deploymentId") ?? "").pipe(
        Effect.map((deployment) => ctx.json({ deployment })),
        Effect.mapError(routeFailure),
      ),
    ),
    effectRoute(app.post, "/remote-deployments", (ctx) =>
      Effect.gen(function* () {
        const body = yield* decodeJsonBody(ctx, RemoteDeploymentCreateRequestSchema);
        const deployment = yield* context.remoteDeployments
          .create(body)
          .pipe(Effect.mapError(routeFailure));
        return ctx.json({ deployment }, 202);
      }),
    ),
    effectRoute(app.delete, "/remote-deployments/:deploymentId", (ctx) =>
      context.remoteDeployments.destroy(ctx.req.param("deploymentId") ?? "").pipe(
        Effect.map((deployment) => ctx.json({ deployment })),
        Effect.mapError(routeFailure),
      ),
    ),
  ),
);
