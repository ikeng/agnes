import type { AgnesClientConfig } from "./config.js";
import { checkAuth } from "./auth/check.js";
export * from "./models.js";
import { toPublicUrl } from "./media/toPublicUrl.js";
import { generateImage } from "./image/generateImage.js";
import { completeText } from "./text/complete.js";
import { generateVideo } from "./video/generateVideo.js";
import { getVideo } from "./video/getVideo.js";
import { pollVideo } from "./video/pollVideo.js";

export { checkAuth } from "./auth/check.js";
export { toPublicUrl } from "./media/toPublicUrl.js";
export { LitterboxMediaUrlProvider } from "./media/litterbox.js";
export { TemporaryMediaUrlProvider, TmpfilesMediaUrlProvider, UguuMediaUrlProvider, X0MediaUrlProvider } from "./media/temporary-upload.js";
export type {
  AgnesClientConfig,
  AuthCheckResult,
  PublicUrlResult,
  ImageGenerationResult,
  NormalizedVideoTask,
  NormalizedVideoResult,
  NormalizedVideoStatus,
  TemporaryMediaProviderName,
  Ttl,
} from "./config.js";
export type { ImageGenerateOptions } from "./image/normalizeImageRequest.js";
export type { TextCompleteOptions, TextCompletionResult } from "./text/complete.js";
export type { VideoGenerateOptions } from "./video/normalizeVideoRequest.js";
export type { GetVideoOptions } from "./video/getVideo.js";
export type { PollVideoOptions } from "./video/pollVideo.js";

export function createAgnesClient(config: AgnesClientConfig = {}) {
  return {
    auth: {
      check: () => checkAuth({ env: config.env }),
    },
    media: {
      toPublicUrl: (input: string, options?: { ttl?: import("./config.js").Ttl }) => toPublicUrl(input, options, config),
    },
    text: {
      complete: (options: import("./text/complete.js").TextCompleteOptions) => completeText(options, config),
    },
    image: {
      generate: (options: import("./image/normalizeImageRequest.js").ImageGenerateOptions) => generateImage(options, config),
    },
    video: {
      generate: (options: import("./video/normalizeVideoRequest.js").VideoGenerateOptions) => generateVideo(options, config),
      get: (id: string, options?: import("./video/getVideo.js").GetVideoOptions) => getVideo(id, options, config),
      poll: (id: string, options?: import("./video/pollVideo.js").PollVideoOptions) => pollVideo(id, options, config),
    },
  };
}
