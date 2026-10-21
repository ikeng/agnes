import { AgnesCliError } from "./errors.js";

export type Ttl = "1h" | "12h" | "24h" | "72h";
export type TemporaryMediaProviderName = "litterbox" | "tmpfiles" | "uguu" | "x0";

export type FetchLike = typeof fetch;

/** Comma-separated provider order, e.g. `uguu,x0,litterbox,tmpfiles`. */
export function parseMediaProviderOrder(value: string | undefined): TemporaryMediaProviderName[] | undefined {
  if (!value?.trim()) return undefined;
  const allowed: readonly TemporaryMediaProviderName[] = ["litterbox", "tmpfiles", "uguu", "x0"];
  const names = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(allowed as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new AgnesCliError(
      "INVALID_ENV",
      `AGNES_MEDIA_PROVIDER_ORDER contains unknown provider(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }
  return names as TemporaryMediaProviderName[];
}

export interface AgnesClientConfig {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  defaultMediaTtl?: Ttl;
  temporaryMediaProviderOrder?: readonly TemporaryMediaProviderName[];
  mediaProvider?: MediaUrlProvider;
  env?: NodeJS.ProcessEnv;
}

export interface MediaUrlProvider {
  upload(localPath: string, options?: { ttl?: Ttl }): Promise<string>;
}

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  fetchImpl: FetchLike;
  defaultMediaTtl: Ttl;
  temporaryMediaProviderOrder?: readonly TemporaryMediaProviderName[];
  mediaProvider?: MediaUrlProvider;
  env: NodeJS.ProcessEnv;
}

export const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
export const DEFAULT_MEDIA_TTL: Ttl = "1h";
export const DEFAULT_VIDEO_DIMENSIONS = {
  width: 1152,
  height: 768,
};
export const DEFAULT_VIDEO_TEMPORAL = {
  numFrames: 121,
  frameRate: 24,
};

export function resolveConfig(config: AgnesClientConfig = {}): ResolvedConfig {
  if (!config.fetchImpl && typeof fetch !== "function") {
    throw new AgnesCliError("FETCH_UNAVAILABLE", "Global fetch is unavailable in this Node runtime.");
  }
  const env = config.env ?? process.env;
  return {
    apiKey: config.apiKey ?? env.AGNES_API_KEY,
    // AGNES_BASE_URL lets callers switch to the .cn / alternate gateway without code changes.
    baseUrl: config.baseUrl ?? env.AGNES_BASE_URL ?? DEFAULT_BASE_URL,
    fetchImpl: config.fetchImpl ?? fetch,
    defaultMediaTtl: config.defaultMediaTtl ?? DEFAULT_MEDIA_TTL,
    temporaryMediaProviderOrder:
      config.temporaryMediaProviderOrder ?? parseMediaProviderOrder(env.AGNES_MEDIA_PROVIDER_ORDER),
    mediaProvider: config.mediaProvider,
    env,
  };
}

export interface AuthCheckResult {
  ok: boolean;
  configured: boolean;
  source: "env" | "missing";
}

export interface PublicUrlResult {
  ok: true;
  url: string;
  source: "passthrough" | "litterbox" | "temporary" | "provider";
}

export type AgnesStatus = "queued" | "in_progress" | "completed" | "failed" | "canceled" | "timed_out";

export interface NormalizedVideoTask {
  ok: true;
  taskId: string;
  videoId?: string;
  status: AgnesStatus;
  rawStatus?: string;
  model: string;
  raw: unknown;
}

export interface NormalizedVideoResult {
  ok: true;
  taskId: string;
  videoId?: string;
  status: AgnesStatus;
  rawStatus?: string;
  model: string;
  videoUrl: string;
  seconds?: number;
  size?: string;
  raw: unknown;
}

export interface NormalizedVideoStatus {
  ok: true;
  taskId: string;
  videoId?: string;
  status: AgnesStatus;
  rawStatus?: string;
  model: string;
  videoUrl?: string;
  seconds?: number;
  size?: string;
  error?: unknown;
  raw: unknown;
}

export interface ImageGenerationResult {
  ok: true;
  model: string;
  url: string;
  raw: unknown;
}
