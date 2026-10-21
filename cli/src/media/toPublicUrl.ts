import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { TemporaryMediaUrlProvider } from "./temporary-upload.js";
import type { AgnesClientConfig, FetchLike, PublicUrlResult, Ttl } from "../config.js";
import { resolveConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export async function toPublicUrl(
  input: string,
  options: { ttl?: Ttl } = {},
  config: AgnesClientConfig = {},
): Promise<PublicUrlResult> {
  if (isPublicHttpUrl(input)) {
    return { ok: true, url: input, source: "passthrough" };
  }

  const resolved = resolveConfig(config);
  const provider =
    resolved.mediaProvider ??
    new TemporaryMediaUrlProvider(resolved.fetchImpl, {
      providerOrder: resolved.temporaryMediaProviderOrder,
    });
  const materialized = await materializeUploadInput(input, resolved.fetchImpl);

  try {
    const url = await provider.upload(materialized.path, { ttl: options.ttl ?? resolved.defaultMediaTtl });
    return { ok: true, url, source: resolved.mediaProvider ? "provider" : "temporary" };
  } finally {
    if (materialized.cleanupDir) {
      await rm(materialized.cleanupDir, { recursive: true, force: true });
    }
  }
}

function isPublicHttpUrl(input: string): boolean {
  if (!/^https?:\/\//.test(input)) return false;
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return !isPrivateHost(host);
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match) {
    const secondOctet = Number(match[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }
  return host === "0.0.0.0" || (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")));
}

async function materializeUploadInput(
  input: string,
  fetchImpl: FetchLike,
): Promise<{ path: string; cleanupDir?: string }> {
  if (input.startsWith("data:")) {
    return writeTempMedia(await decodeDataUrl(input));
  }

  if (/^https?:\/\//.test(input)) {
    return writeTempMedia(await fetchPrivateUrl(input, fetchImpl));
  }

  try {
    await access(input, constants.R_OK);
  } catch {
    throw new AgnesCliError("INPUT_NOT_FOUND", `Input must be an existing file path, a data URL, or an http(s) URL: ${input}`);
  }
  return { path: input };
}

async function fetchPrivateUrl(input: string, fetchImpl: FetchLike): Promise<{ bytes: Buffer; mimeType?: string; extension?: string }> {
  const response = await fetchImpl(input);
  if (!response.ok) {
    throw new AgnesCliError("INPUT_FETCH_FAILED", `Input URL fetch failed with HTTP ${response.status}: ${input}`, {
      status: response.status,
      url: input,
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = normalizeMimeType(response.headers.get("content-type") ?? undefined);
  const extension = extname(new URL(input).pathname);
  return { bytes, mimeType, extension };
}

function decodeDataUrl(input: string): { bytes: Buffer; mimeType?: string; extension?: string } {
  const match = input.match(/^data:([^;,]+)?((?:;[^,]+)*?),(.*)$/s);
  if (!match) {
    throw new AgnesCliError("INPUT_INVALID", "Data URL input is malformed.");
  }
  const mimeType = normalizeMimeType(match[1]);
  const metadata = match[2] ?? "";
  const body = match[3] ?? "";
  const bytes = metadata.includes(";base64")
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body));
  return { bytes, mimeType };
}

async function writeTempMedia(input: { bytes: Buffer; mimeType?: string; extension?: string }): Promise<{ path: string; cleanupDir: string }> {
  const cleanupDir = await mkdtemp(join(tmpdir(), "agnes-media-"));
  const extension = normalizeExtension(input.extension) ?? (input.mimeType ? MIME_EXTENSIONS[input.mimeType] : undefined) ?? ".bin";
  const path = join(cleanupDir, `input${extension}`);
  await writeFile(path, input.bytes);
  return { path, cleanupDir };
}

function normalizeMimeType(value: string | undefined): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function normalizeExtension(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return /^\.[a-z0-9]+$/.test(normalized) ? normalized : undefined;
}
