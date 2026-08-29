import { Effect } from "effect";
import {
  RemoteDeploymentCreateRequestSchema,
  RemoteOfferRequestSchema,
} from "@local-studio/contracts/remote-deployments";
import { badRequest, notFound, serviceUnavailable, type HttpStatus } from "../../core/errors";
import { decodeJsonBody } from "../../core/validation";
import { effectHandler } from "../../http/effect-handler";
import { defineRoutes, documentRoute, mergeRoutes } from "../../http/route-registrar";
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
    app.get(
      "/remote-deployments/providers",
      documentRoute,
      effectHandler((ctx) =>
        Effect.succeed(ctx.json({ providers: context.remoteDeployments.providerStatuses() })),
      ),
    ),
    app.post(
      "/remote-deployments/offers",
      documentRoute,
      effectHandler((ctx) =>
        Effect.gen(function* () {
          const body = yield* decodeJsonBody(ctx, RemoteOfferRequestSchema);
          const result = yield* context.remoteDeployments
            .offers(body.recipe_id, body.providers)
            .pipe(Effect.mapError(routeFailure));
          return ctx.json(result);
        }),
      ),
    ),
    app.get(
      "/remote-deployments",
      documentRoute,
      effectHandler((ctx) =>
        context.remoteDeployments.list(ctx.req.query("recipe_id")).pipe(
          Effect.map((deployments) => ctx.json({ deployments })),
          Effect.mapError(routeFailure),
        ),
      ),
    ),
    app.get(
      "/remote-deployments/:deploymentId",
      documentRoute,
      effectHandler((ctx) =>
        context.remoteDeployments.get(ctx.req.param("deploymentId") ?? "").pipe(
          Effect.map((deployment) => ctx.json({ deployment })),
          Effect.mapError(routeFailure),
        ),
      ),
    ),
    app.post(
      "/remote-deployments",
      documentRoute,
      effectHandler((ctx) =>
        Effect.gen(function* () {
          const body = yield* decodeJsonBody(ctx, RemoteDeploymentCreateRequestSchema);
          const deployment = yield* context.remoteDeployments
            .create(body)
            .pipe(Effect.mapError(routeFailure));
          return ctx.json({ deployment }, 202);
        }),
      ),
    ),
    app.delete(
      "/remote-deployments/:deploymentId",
      documentRoute,
      effectHandler((ctx) =>
        context.remoteDeployments.destroy(ctx.req.param("deploymentId") ?? "").pipe(
          Effect.map((deployment) => ctx.json({ deployment })),
          Effect.mapError(routeFailure),
        ),
      ),
    ),
  ),
);
