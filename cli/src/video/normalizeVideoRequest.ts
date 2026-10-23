import { z } from "zod";
import { DEFAULT_VIDEO_DIMENSIONS, DEFAULT_VIDEO_TEMPORAL, type Ttl } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { routeOptionsSchema } from "../accounts/route.js";
import {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_SECONDS,
  isLegacyVideoModel,
  isVideo25FlashModel,
  isVideo25Model,
  VIDEO_25_FLASH_MAX_REFERENCE_IMAGES,
  VIDEO_25_FLASH_SIZE,
  VIDEO_25_MAX_REFERENCE_IMAGES,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODELS,
  VIDEO_SECONDS,
  VIDEO_SIZE_TIERS,
} from "../models.js";

const videoModelSchema = z.enum(VIDEO_MODELS);

const shared = {
  model: videoModelSchema.optional(),
  prompt: z.string().min(1),
  seed: z.number().int().optional(),
  // Agnes Video 2.5 controls
  seconds: z.number().int().min(VIDEO_SECONDS.min).max(VIDEO_SECONDS.max).optional(),
  size: z.enum(VIDEO_SIZE_TIERS).optional(),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
  n: z.number().int().min(1).max(1).optional(),
  // Legacy Agnes Video v2.0 controls (retired upstream on 2026-09-25)
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  numFrames: z.number().int().positive().optional(),
  frameRate: z.number().int().positive().optional(),
  negativePrompt: z.string().min(1).optional(),
  route: routeOptionsSchema,
};

export const videoGenerateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text2video"), ...shared }),
  z.object({
    mode: z.literal("img2video"),
    image: z.string().min(1),
    ttl: z.enum(["1h", "12h", "24h", "72h"]).optional(),
    ...shared,
  }),
  z.object({
    mode: z.literal("multivideo"),
    images: z.array(z.string().min(1)).min(2),
    ttl: z.enum(["1h", "12h", "24h", "72h"]).optional(),
    ...shared,
  }),
  z.object({
    mode: z.literal("keyframes"),
    images: z.array(z.string().min(1)).min(2),
    ttl: z.enum(["1h", "12h", "24h", "72h"]).optional(),
    ...shared,
  }),
]);

export type VideoGenerateOptions = z.infer<typeof videoGenerateSchema>;

export function collectVideoInputs(options: VideoGenerateOptions): { inputs: string[]; ttl?: Ttl } {
  switch (options.mode) {
    case "text2video":
      return { inputs: [] };
    case "img2video":
      return { inputs: [options.image], ttl: options.ttl };
    case "multivideo":
    case "keyframes":
      return { inputs: options.images, ttl: options.ttl };
    default:
      throw new AgnesCliError("INVALID_VIDEO_MODE", "Unsupported video generation mode.");
  }
}

export function normalizeVideoRequest(
  options: VideoGenerateOptions,
  resolvedImages: string[],
): Record<string, unknown> {
  const model = options.model ?? DEFAULT_VIDEO_MODEL;

  if (isLegacyVideoModel(model)) {
    rejectVideo25OnlyOptions(options);
    return normalizeLegacyVideoRequest(model, options, resolvedImages);
  }
  if (!isVideo25Model(model)) {
    throw new AgnesCliError(
      "INVALID_VIDEO_MODEL",
      `Unsupported video model "${model}". Use one of: ${VIDEO_MODELS.join(", ")}.`,
    );
  }

  rejectLegacyVideoOptions(options);
  validateVideoSettings({
    model,
    mode: options.mode,
    imageCount: resolvedImages.length,
    seconds: options.seconds,
    size: options.size,
    aspectRatio: options.aspectRatio,
  });
  return normalizeVideo25Request(model, options, resolvedImages);
}

/** Video 2.5 payload (current API: POST /v1/videos with mode/seconds/size). */
function normalizeVideo25Request(
  model: string,
  options: VideoGenerateOptions,
  resolvedImages: string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    prompt: options.prompt,
    mode: videoModeFor25(options.mode),
    seconds: String(options.seconds ?? DEFAULT_VIDEO_SECONDS),
  };

  // Flash only supports 720P; send it explicitly so the request is self-describing.
  if (options.size) payload.size = options.size;
  else if (isVideo25FlashModel(model)) payload.size = VIDEO_25_FLASH_SIZE;

  if (options.aspectRatio) payload.aspect_ratio = options.aspectRatio;
  if (options.seed !== undefined) payload.seed = options.seed;
  if (options.n !== undefined) payload.n = options.n;

  switch (options.mode) {
    case "text2video":
      break;
    case "img2video":
      payload.first_frame = resolvedImages[0];
      break;
    case "multivideo":
      payload.images = resolvedImages;
      break;
    case "keyframes":
      payload.first_frame = resolvedImages[0];
      payload.last_frame = resolvedImages[1];
      break;
    default:
      throw new AgnesCliError("INVALID_VIDEO_MODE", "Unsupported video generation mode.");
  }

  return payload;
}

/** Legacy Video v2.0 payload kept for explicit backwards-compatible calls/tests. */
function normalizeLegacyVideoRequest(
  model: string,
  options: VideoGenerateOptions,
  resolvedImages: string[],
): Record<string, unknown> {
  const width = options.width ?? DEFAULT_VIDEO_DIMENSIONS.width;
  const height = options.height ?? DEFAULT_VIDEO_DIMENSIONS.height;
  const numFrames = options.numFrames ?? DEFAULT_VIDEO_TEMPORAL.numFrames;
  const frameRate = options.frameRate ?? DEFAULT_VIDEO_TEMPORAL.frameRate;

  validateVideoSettings({
    model,
    numFrames,
    frameRate,
    mode: options.mode,
    imageCount: resolvedImages.length,
  });

  const payload: Record<string, unknown> = {
    model,
    prompt: options.prompt,
    width,
    height,
    num_frames: numFrames,
    frame_rate: frameRate,
  };
  if (options.seed !== undefined) payload.seed = options.seed;
  if (options.negativePrompt) payload.negative_prompt = options.negativePrompt;

  switch (options.mode) {
    case "text2video":
      break;
    case "img2video":
      payload.image = resolvedImages[0];
      break;
    case "multivideo":
      payload.extra_body = { image: resolvedImages };
      break;
    case "keyframes":
      payload.extra_body = { image: resolvedImages, mode: "keyframes" };
      break;
    default:
      throw new AgnesCliError("INVALID_VIDEO_MODE", "Unsupported video generation mode.");
  }

  return payload;
}

function videoModeFor25(mode: VideoGenerateOptions["mode"]): "text" | "keyframe" | "reference" {
  switch (mode) {
    case "text2video":
      return "text";
    case "img2video":
    case "keyframes":
      return "keyframe";
    case "multivideo":
      return "reference";
    default:
      throw new AgnesCliError("INVALID_VIDEO_MODE", "Unsupported video generation mode.");
  }
}

function rejectVideo25OnlyOptions(options: VideoGenerateOptions): void {
  const used = [
    options.seconds !== undefined ? "--seconds" : undefined,
    options.size !== undefined ? "--size" : undefined,
    options.aspectRatio !== undefined ? "--aspect-ratio" : undefined,
    options.n !== undefined ? "--n" : undefined,
  ].filter(Boolean);
  if (used.length > 0) {
    throw new AgnesCliError(
      "INVALID_VIDEO_SETTINGS",
      `${used.join(", ")} require an Agnes Video 2.5 model. Select --model agnes-video-2.5 (or agnes-video-2.5-flash); ${options.model} is retired.`,
    );
  }
}

function rejectLegacyVideoOptions(options: VideoGenerateOptions): void {
  const used = [
    options.width !== undefined ? "--width" : undefined,
    options.height !== undefined ? "--height" : undefined,
    options.numFrames !== undefined ? "--num-frames" : undefined,
    options.frameRate !== undefined ? "--frame-rate" : undefined,
    options.negativePrompt !== undefined ? "--negative-prompt" : undefined,
  ].filter(Boolean);
  if (used.length > 0) {
    throw new AgnesCliError(
      "INVALID_VIDEO_SETTINGS",
      `${used.join(", ")} belong to the retired Agnes Video v2.0 API and are not supported by ${options.model ?? DEFAULT_VIDEO_MODEL}. Use --seconds, --size and --aspect-ratio instead.`,
    );
  }
}

export interface VideoSettingsValidation {
  model?: string;
  mode: VideoGenerateOptions["mode"];
  imageCount: number;
  /** Legacy v2.0 frame count. */
  numFrames?: number;
  /** Legacy v2.0 frame rate. */
  frameRate?: number;
  /** Video 2.5 duration in seconds. */
  seconds?: number;
  /** Video 2.5 resolution tier. */
  size?: string;
  /** Video 2.5 aspect ratio. */
  aspectRatio?: string;
}

/** Validates model-specific video settings without touching the network. */
export function validateVideoSettings(input: VideoSettingsValidation): void {
  const model = input.model ?? DEFAULT_VIDEO_MODEL;

  if (isLegacyVideoModel(model)) {
    validateLegacyVideoSettings(input);
    return;
  }

  if (!isVideo25Model(model)) {
    throw new AgnesCliError("INVALID_VIDEO_MODEL", `Unsupported video model "${model}".`);
  }

  if (input.size === "1K" && input.aspectRatio && input.aspectRatio !== "1:1") {
    throw new AgnesCliError(
      "INVALID_VIDEO_SETTINGS",
      "size 1K is a fixed 1024x1024 square output; use --aspect-ratio 1:1 or pick another size tier.",
    );
  }

  const seconds = input.seconds ?? DEFAULT_VIDEO_SECONDS;
  if (seconds < VIDEO_SECONDS.min || seconds > VIDEO_SECONDS.max) {
    throw new AgnesCliError(
      "INVALID_VIDEO_SETTINGS",
      `seconds must be between ${VIDEO_SECONDS.min} and ${VIDEO_SECONDS.max}.`,
    );
  }

  if (isVideo25FlashModel(model)) {
    if (input.size && input.size !== VIDEO_25_FLASH_SIZE) {
      throw new AgnesCliError(
        "INVALID_VIDEO_SETTINGS",
        `${model} only supports size ${VIDEO_25_FLASH_SIZE}.`,
      );
    }
    if (input.imageCount > VIDEO_25_FLASH_MAX_REFERENCE_IMAGES) {
      throw new AgnesCliError(
        "INVALID_VIDEO_SETTINGS",
        `${model} supports at most ${VIDEO_25_FLASH_MAX_REFERENCE_IMAGES} reference images.`,
      );
    }
  } else if (input.imageCount > VIDEO_25_MAX_REFERENCE_IMAGES) {
    throw new AgnesCliError(
      "INVALID_VIDEO_SETTINGS",
      `${model} supports at most ${VIDEO_25_MAX_REFERENCE_IMAGES} reference images.`,
    );
  }

  if (input.mode === "img2video" && input.imageCount !== 1) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "img2video requires exactly one image.");
  }
  if (input.mode === "multivideo" && input.imageCount < 2) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "multivideo requires at least two images.");
  }
  if (input.mode === "keyframes") {
    if (input.imageCount < 2) {
      throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "keyframes requires at least two images.");
    }
    if (input.imageCount > 2) {
      throw new AgnesCliError(
        "INVALID_VIDEO_SETTINGS",
        "Agnes Video 2.5 keyframe mode supports exactly two images (first frame and last frame). Use `video multivideo` for image references.",
      );
    }
  }
}

/** Legacy v2.0 validation: num_frames must be 8n + 1, <= 441 and frame_rate 1-60. */
function validateLegacyVideoSettings(input: VideoSettingsValidation): void {
  const numFrames = input.numFrames ?? DEFAULT_VIDEO_TEMPORAL.numFrames;
  const frameRate = input.frameRate ?? DEFAULT_VIDEO_TEMPORAL.frameRate;

  if (numFrames > 441) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "numFrames must be <= 441.");
  }
  if ((numFrames - 1) % 8 !== 0) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "numFrames must satisfy 8n + 1.");
  }
  if (frameRate < 1 || frameRate > 60) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "frameRate must be between 1 and 60.");
  }
  if (input.mode === "img2video" && input.imageCount !== 1) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", "img2video requires exactly one image.");
  }
  if ((input.mode === "multivideo" || input.mode === "keyframes") && input.imageCount < 2) {
    throw new AgnesCliError("INVALID_VIDEO_SETTINGS", `${input.mode} requires at least two images.`);
  }
}
