import { Effect, Schedule } from "effect";
import type { RemoteDeploymentService } from "./service";

const RECONCILE_INTERVAL_MS = 15_000;

export const startRemoteDeploymentSupervisor = (
  service: RemoteDeploymentService,
  onError: (error: unknown) => void,
): Effect.Effect<never> =>
  service.reconcileAll().pipe(
    Effect.catchCause((cause) => Effect.sync(() => onError(cause))),
    Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL_MS)),
    Effect.andThen(Effect.never),
  );
