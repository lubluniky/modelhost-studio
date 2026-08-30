import { randomBytes } from "node:crypto";
import type { RemoteComputeRequirements } from "@local-studio/contracts/remote-deployments";
import type { Config } from "../../config/env";
import { recipeToLaunchInput } from "../compute/bridge";
import type { HostProfile } from "../compute/contracts";
import { engineSpec } from "../compute/engines/registry";
import type { Recipe } from "../models/types";
import type { RemoteContainerSpec } from "./contracts";

const REMOTE_PORT = 8000;
const BLOCKED_ARGUMENTS = new Set([
  "api-key",
  "disable-cuda-graphs",
  "enforce-eager",
  "host",
  "max-tokens",
  "port",
]);

const REMOTE_HOST: HostProfile = {
  nodeId: "remote",
  platform: "linux",
  arch: "x64",
  accelerator: "cuda",
  unifiedMemory: false,
  wsl: false,
  docker: true,
  dockerGpu: true,
  deviceCount: 1,
};

export interface RemoteBootstrapSpec {
  readonly container: RemoteContainerSpec;
  readonly apiKey: string;
  readonly routeModelId: string;
  readonly readyDeadlineMs: number;
  readonly healthPath: string;
  readonly healthIntervalMs: number;
}

const argumentKey = (argument: string): string | null =>
  argument.startsWith("--") ? (argument.split("=")[0] ?? argument).slice(2) : null;

const safeRemoteArguments = (arguments_: readonly string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const key = argumentKey(argument);
    if (!key || !BLOCKED_ARGUMENTS.has(key)) {
      result.push(argument);
      continue;
    }
    const next = arguments_[index + 1];
    if (next !== undefined && argumentKey(next) === null && !argument.includes("=")) index += 1;
  }
  return result;
};

export const makeRemoteBootstrap = (input: {
  readonly recipe: Recipe;
  readonly requirements: RemoteComputeRequirements;
  readonly config: Config;
  readonly huggingFaceToken: string | null;
}): RemoteBootstrapSpec => {
  const launch = recipeToLaunchInput(input.recipe, input.config, ["remote:0"]);
  const apiKey = randomBytes(32).toString("base64url");
  const spec = engineSpec("vllm");
  const environment = { ...launch.env };
  delete environment["VLLM_API_KEY"];
  delete environment["HF_TOKEN"];
  if (input.huggingFaceToken) environment["HF_TOKEN"] = input.huggingFaceToken;
  const plan = spec.plan({
    engine: "vllm",
    host: REMOTE_HOST,
    runtime: "docker",
    devices: [],
    port: REMOTE_PORT,
    modelPath: launch.modelPath,
    containerModelReference: input.requirements.model_id,
    servedModelName: launch.servedModelName,
    options: launch.options,
    extraArgs: [...safeRemoteArguments(launch.extraArgs), "--api-key", apiKey],
    env: environment,
    dockerImage: launch.dockerImage,
    binary: launch.binary ?? spec.defaultBinary,
  });
  if (!plan.image) throw new Error("Remote vLLM image is unavailable");
  return {
    container: {
      image: plan.image,
      argv: plan.argv,
      env: plan.env,
      port: REMOTE_PORT,
    },
    apiKey,
    routeModelId: launch.servedModelName,
    readyDeadlineMs: plan.health.readyDeadlineMs,
    healthPath: plan.health.path,
    healthIntervalMs: plan.health.intervalMs,
  };
};
