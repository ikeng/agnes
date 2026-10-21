/**
 * Agnes AI model catalog and defaults.
 *
 * Source of truth (checked 2026-10-21):
 *   https://wiki.agnes-ai.com/llms.txt
 *   https://www.agnes-ai.com/en/docs/<model-slug>.md
 *
 * Keep this list in sync with the docs when Agnes ships new models.
 */

/* ------------------------------- text models ------------------------------ */

export const TEXT_MODELS = [
  "agnes-3.0-flash",
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-beta",
  "agnes-2.0-flash",
] as const;

export type TextModel = (typeof TEXT_MODELS)[number];

/** `agnes-2.0-flash` is deprecated upstream; it stays callable for migration. */
export const DEPRECATED_TEXT_MODELS: readonly string[] = ["agnes-2.0-flash"];

/** `agnes-3.0-pro` is announced as "coming soon" and is intentionally absent. */
export const DEFAULT_TEXT_MODEL = "agnes-2.5-flash";

/* ------------------------------ image models ------------------------------ */

export const IMAGE_MODELS = [
  "agnes-image-2.5-flash",
  "agnes-image-2.1-flash",
  "agnes-image-2.0-flash",
] as const;

export type ImageModel = (typeof IMAGE_MODELS)[number];

export const DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash";

/** Preferred tier-based size values. Exact sizes such as `1024x768` are also accepted. */
export const IMAGE_SIZE_TIERS = ["1K", "2K", "3K", "4K"] as const;

export const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;

/**
 * Default output size. `1024x1024` is accepted by every image model, while
 * tier sizes are the recommended form for 2.1/2.5.
 */
export const DEFAULT_IMAGE_SIZE = "1024x1024";

/* ------------------------------ video models ------------------------------ */

export const VIDEO_MODELS = ["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"] as const;

export type VideoModel = (typeof VIDEO_MODELS)[number];

/** Video v2.0 was retired upstream on 2026-09-25; kept for explicit legacy calls. */
export const RETIRED_VIDEO_MODELS: readonly string[] = ["agnes-video-v2.0"];

export const DEFAULT_VIDEO_MODEL = "agnes-video-2.5";

export const VIDEO_SIZE_TIERS = ["720P", "1080P", "1K", "2K"] as const;

export const VIDEO_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

/** Agnes Video 2.5 generation modes. */
export const VIDEO_25_MODES = ["text", "keyframe", "reference"] as const;

export const DEFAULT_VIDEO_SECONDS = 5;

export const VIDEO_SECONDS = { min: 4, max: 12 } as const;

export const DEFAULT_VIDEO_ASPECT_RATIO = "16:9";

/** Flash is fixed to 720P and accepts at most 5 reference images. */
export const VIDEO_25_FLASH_SIZE = "720P";
export const VIDEO_25_FLASH_MAX_REFERENCE_IMAGES = 5;

/** Full Video 2.5 accepts at most 8 reference images. */
export const VIDEO_25_MAX_REFERENCE_IMAGES = 8;

export function isLegacyVideoModel(model: string): boolean {
  return model === "agnes-video-v2.0";
}

export function isVideo25Model(model: string): boolean {
  return model === "agnes-video-2.5" || model === "agnes-video-2.5-flash";
}

export function isVideo25FlashModel(model: string): boolean {
  return model === "agnes-video-2.5-flash";
}

export function isDeprecatedTextModel(model: string): boolean {
  return DEPRECATED_TEXT_MODELS.includes(model);
}
