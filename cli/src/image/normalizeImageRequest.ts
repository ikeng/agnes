import { z } from "zod";
import type { Ttl } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { routeOptionsSchema } from "../accounts/route.js";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  IMAGE_MODELS,
  IMAGE_RATIOS,
  IMAGE_SIZE_TIERS,
} from "../models.js";

const imageModelSchema = z.enum(IMAGE_MODELS);

const shared = {
  model: imageModelSchema.optional(),
  prompt: z.string().min(1),
  size: z.string().min(1).optional(),
  ratio: z.enum(IMAGE_RATIOS).optional(),
  responseFormat: z.literal("url").optional(),
  seed: z.number().int().optional(),
  route: routeOptionsSchema,
};

export const imageGenerateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text2img"), ...shared }),
  z.object({
    mode: z.literal("img2img"),
    image: z.string().min(1),
    ttl: z.enum(["1h", "12h", "24h", "72h"]).optional(),
    ...shared,
  }),
  z.object({
    mode: z.literal("compose"),
    images: z.array(z.string().min(1)).min(2),
    ttl: z.enum(["1h", "12h", "24h", "72h"]).optional(),
    ...shared,
  }),
]);

export type ImageGenerateOptions = z.infer<typeof imageGenerateSchema>;

/** Accepts documented size tiers and legacy `WIDTHxHEIGHT` values. */
export function validateImageSize(size: string): void {
  const isTier = (IMAGE_SIZE_TIERS as readonly string[]).includes(size);
  const isExact = /^\d{2,5}x\d{2,5}$/.test(size);
  if (!isTier && !isExact) {
    throw new AgnesCliError(
      "INVALID_IMAGE_SIZE",
      `Unsupported image size "${size}". Use a tier (${IMAGE_SIZE_TIERS.join(", ")}) or an exact WIDTHxHEIGHT value such as 1024x1024.`,
    );
  }
}

export function normalizeImageRequest(
  options: ImageGenerateOptions,
  resolvedImages: string[],
): Record<string, unknown> {
  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const size = options.size ?? DEFAULT_IMAGE_SIZE;
  validateImageSize(size);

  if (options.ratio && model === "agnes-image-2.0-flash") {
    throw new AgnesCliError(
      "INVALID_IMAGE_OPTION",
      "ratio is only documented for agnes-image-2.1-flash and agnes-image-2.5-flash. Agnes Image 2.0 uses exact sizes such as 1024x1024.",
    );
  }

  const payload: Record<string, unknown> = {
    model,
    prompt: options.prompt,
    size,
  };

  if (options.ratio) payload.ratio = options.ratio;
  if (options.seed !== undefined) payload.seed = options.seed;

  if (options.mode === "text2img") {
    return payload;
  }

  payload.extra_body = {
    image: resolvedImages,
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
  };
  return payload;
}

export function collectImageInputs(options: ImageGenerateOptions): { inputs: string[]; ttl?: Ttl } {
  switch (options.mode) {
    case "text2img":
      return { inputs: [] };
    case "img2img":
      return { inputs: [options.image], ttl: options.ttl };
    case "compose":
      return { inputs: options.images, ttl: options.ttl };
    default:
      throw new AgnesCliError("INVALID_IMAGE_MODE", "Unsupported image generation mode.");
  }
}
