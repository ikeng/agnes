import type { AgnesClientConfig, AuthCheckResult, ResolvedConfig } from "./config.js";
import { resolveClientConfig } from "./config.js";
import { authCheckFromResolved, checkAuth } from "./auth/check.js";
export * from "./models.js";
import type { AccountRouter } from "./accounts/router.js";
import { toPublicUrl } from "./media/toPublicUrl.js";
import { generateImage } from "./image/generateImage.js";
import { completeText } from "./text/complete.js";
import { generateVideo } from "./video/generateVideo.js";
import { getVideo } from "./video/getVideo.js";
import { pollVideo } from "./video/pollVideo.js";

export { checkAuth, authCheckFromResolved } from "./auth/check.js";
export { toPublicUrl } from "./media/toPublicUrl.js";
export { LitterboxMediaUrlProvider } from "./media/litterbox.js";
export { TemporaryMediaUrlProvider, TmpfilesMediaUrlProvider, UguuMediaUrlProvider, X0MediaUrlProvider } from "./media/temporary-upload.js";
export { AccountRouter } from "./accounts/router.js";
export { AffinityJournal } from "./accounts/affinity.js";
export { accountsSummary, loadAccountsConfig, findAccount } from "./accounts/config.js";
export { RPM_PRESETS, CONCURRENCY_PRESETS, imageTierForSize } from "./accounts/limits.js";
export type {
  AccountConfig,
  AccountsConfig,
  AffinityEntry,
  RedactedAccountSummary,
  AccountsSummary,
  RouteOptions,
  RouteResult,
  RouterSummary,
  RoutingInfo,
  RoutingStrategy,
  AccountType,
  WorkloadClass,
} from "./accounts/types.js";
export type { AccountRouterOptions, RouterRuntime, ExecuteOptions, ProbeAffinityOptions } from "./accounts/router.js";
export type { AffinityJournalOptions } from "./accounts/affinity.js";
export type { LoadAccountsConfigOverrides } from "./accounts/config.js";
export type {
  AgnesClientConfig,
  AuthCheckResult,
  PublicUrlResult,
  ImageGenerationResult,
  NormalizedVideoTask,
  NormalizedVideoResult,
  NormalizedVideoStatus,
  ResolvedConfig,
  TemporaryMediaProviderName,
  Ttl,
} from "./config.js";
export type { ImageGenerateOptions } from "./image/normalizeImageRequest.js";
export type { TextCompleteOptions, TextCompletionResult } from "./text/complete.js";
export type { VideoGenerateOptions } from "./video/normalizeVideoRequest.js";
export type { GetVideoOptions } from "./video/getVideo.js";
export type { PollVideoOptions } from "./video/pollVideo.js";

/**
 * Client returned by `createAgnesClient`.
 *
 * The enumerable namespaces stay exactly `{auth, image, media, text, video}`
 * for backward compatibility; `router` / `resolvedConfig` are non-enumerable
 * surfaces used by the CLI and the batch runner (they share one router so
 * cooldowns, token buckets and affinity stay stateful for the whole client).
 */
export interface AgnesClient {
  auth: { check(): AuthCheckResult };
  media: {
    toPublicUrl(input: string, options?: { ttl?: import("./config.js").Ttl }): Promise<import("./config.js").PublicUrlResult>;
  };
  text: {
    complete(options: import("./text/complete.js").TextCompleteOptions): Promise<import("./text/complete.js").TextCompletionResult>;
  };
  image: {
    generate(options: import("./image/normalizeImageRequest.js").ImageGenerateOptions): Promise<import("./config.js").ImageGenerationResult>;
  };
  video: {
    generate(options: import("./video/normalizeVideoRequest.js").VideoGenerateOptions): Promise<import("./config.js").NormalizedVideoTask>;
    get(id: string, options?: import("./video/getVideo.js").GetVideoOptions): Promise<import("./config.js").NormalizedVideoStatus>;
    poll(id: string, options?: import("./video/pollVideo.js").PollVideoOptions): Promise<import("./config.js").NormalizedVideoResult>;
  };
  /** Shared routing engine (non-enumerable). */
  readonly router: AccountRouter;
  /** Alias of `router` tolerated by the batch wiring (non-enumerable). */
  readonly routing: AccountRouter;
  /** Resolved client configuration, including the shared router (non-enumerable). */
  readonly resolvedConfig: ResolvedConfig;
}

export function createAgnesClient(config: AgnesClientConfig = {}): AgnesClient {
  const resolved = resolveClientConfig(config);
  const client = {
    auth: {
      check: () => authCheckFromResolved(resolved),
    },
    media: {
      toPublicUrl: (input: string, options?: { ttl?: import("./config.js").Ttl }) => toPublicUrl(input, options, resolved),
    },
    text: {
      complete: (options: import("./text/complete.js").TextCompleteOptions) => completeText(options, resolved),
    },
    image: {
      generate: (options: import("./image/normalizeImageRequest.js").ImageGenerateOptions) => generateImage(options, resolved),
    },
    video: {
      generate: (options: import("./video/normalizeVideoRequest.js").VideoGenerateOptions) => generateVideo(options, resolved),
      get: (id: string, options?: import("./video/getVideo.js").GetVideoOptions) => getVideo(id, options, resolved),
      poll: (id: string, options?: import("./video/pollVideo.js").PollVideoOptions) => pollVideo(id, options, resolved),
    },
  } as AgnesClient;
  Object.defineProperties(client, {
    router: { value: resolved.router, enumerable: false, configurable: false },
    routing: { value: resolved.router, enumerable: false, configurable: false },
    resolvedConfig: { value: resolved, enumerable: false, configurable: false },
  });
  return client;
}
