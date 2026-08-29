import { resolve } from "node:path";
import { Effect } from "effect";
import type { ModelDownload } from "@local-studio/contracts/recipes";
import type { RemoteComputeRequirements } from "@local-studio/contracts/remote-deployments";
import type { DownloadStore } from "../engines/downloads/download-store";
import { fetchHuggingFaceModelInfo } from "../engines/downloads/huggingface-api";
import type { Recipe } from "../models/types";
import { RemoteDeploymentFailure } from "./contracts";

const GIB = 1024 ** 3;
const RUNTIME_HEADROOM = 1.25;
const HUGGING_FACE_MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFETENSORS_FILE = /\.safetensors$/i;
const PYTORCH_WEIGHT_FILE = /\.(?:bin|pt|pth|ckpt)$/i;

const failure = (operation: string, message: string): RemoteDeploymentFailure =>
  new RemoteDeploymentFailure({ operation, message, retryable: false });

const fileBytes = (
  files: ReadonlyArray<{ path: string; size_bytes: number | null }>,
  pattern: RegExp,
): number | null => {
  const matches = files.filter((file) => pattern.test(file.path));
  if (matches.length === 0 || matches.some((file) => file.size_bytes === null)) return null;
  return matches.reduce((total, file) => total + (file.size_bytes ?? 0), 0);
};

const downloadWeightBytes = (download: ModelDownload): number | null =>
  fileBytes(download.files, SAFETENSORS_FILE) ??
  fileBytes(download.files, PYTORCH_WEIGHT_FILE) ??
  download.total_bytes;

const remoteModelSource = (
  recipe: Recipe,
  downloads: readonly ModelDownload[],
): { readonly modelId: string; readonly weightBytes: number | null } | null => {
  const modelPath = recipe.model_path.trim();
  const resolvedModelPath = resolve(modelPath);
  const download = downloads.find(
    (candidate) =>
      candidate.status === "completed" && resolve(candidate.target_dir) === resolvedModelPath,
  );
  if (download) {
    return { modelId: download.model_id, weightBytes: downloadWeightBytes(download) };
  }
  return HUGGING_FACE_MODEL_ID.test(modelPath) ? { modelId: modelPath, weightBytes: null } : null;
};

const remoteWeightBytes = (
  modelId: string,
  huggingFaceToken: string | null,
): Effect.Effect<number, RemoteDeploymentFailure> =>
  fetchHuggingFaceModelInfo(modelId, null, huggingFaceToken).pipe(
    Effect.map((model) => {
      const siblings = (model.siblings ?? []).map((file) => ({
        path: file.rfilename,
        size_bytes: file.size ?? null,
      }));
      return fileBytes(siblings, SAFETENSORS_FILE) ?? fileBytes(siblings, PYTORCH_WEIGHT_FILE);
    }),
    Effect.mapError(() =>
      failure("remote-requirements.metadata", "Could not read Hugging Face model metadata"),
    ),
    Effect.flatMap((bytes) =>
      bytes && bytes > 0
        ? Effect.succeed(bytes)
        : Effect.fail(failure("remote-requirements.weights", "Model weight size is unavailable")),
    ),
  );

export const resolveRemoteComputeRequirements = (input: {
  readonly recipe: Recipe;
  readonly downloadStore: DownloadStore;
  readonly huggingFaceToken: string | null;
}): Effect.Effect<RemoteComputeRequirements, RemoteDeploymentFailure> =>
  Effect.gen(function* () {
    if (input.recipe.backend !== "vllm") {
      return yield* Effect.fail(
        failure("remote-requirements.backend", "Remote MVP supports only vLLM recipes"),
      );
    }
    if (input.recipe.tensor_parallel_size !== 1 || input.recipe.pipeline_parallel_size !== 1) {
      return yield* Effect.fail(
        failure("remote-requirements.parallelism", "Remote MVP supports exactly one GPU"),
      );
    }
    const downloads = yield* input.downloadStore
      .list()
      .pipe(
        Effect.mapError(() =>
          failure("remote-requirements.downloads", "Could not read model download metadata"),
        ),
      );
    const source = remoteModelSource(input.recipe, downloads);
    if (!source) {
      return yield* Effect.fail(
        failure(
          "remote-requirements.model",
          "Recipe model must be a completed Hugging Face download or an org/model id",
        ),
      );
    }
    const weightBytes =
      source.weightBytes && source.weightBytes > 0
        ? source.weightBytes
        : yield* remoteWeightBytes(source.modelId, input.huggingFaceToken);
    const weightSizeGb = weightBytes / GIB;
    return {
      recipe_id: input.recipe.id,
      model_id: source.modelId,
      backend: "vllm",
      min_vram_gb: Math.max(1, Math.ceil(weightSizeGb * RUNTIME_HEADROOM)),
      weight_size_gb: weightSizeGb,
      gpu_count: 1,
      context_length: input.recipe.max_model_len,
      quantization: input.recipe.quantization,
    };
  });
