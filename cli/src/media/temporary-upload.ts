import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import type { FetchLike, MediaUrlProvider, TemporaryMediaProviderName, Ttl } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { LitterboxMediaUrlProvider } from "./litterbox.js";

const X0_ENDPOINT = "https://x0.at/";
const UGUU_ENDPOINT = "https://uguu.se/upload";
const TMPFILES_ENDPOINT = "https://tmpfiles.org/api/v1/upload";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

const TTL_SECONDS: Record<Ttl, string> = {
  "1h": "3600",
  "12h": "43200",
  "24h": "86400",
  "72h": "259200",
};

const PROVIDER_LABELS: Record<TemporaryMediaProviderName, string> = {
  litterbox: "Litterbox",
  tmpfiles: "tmpfiles",
  uguu: "Uguu",
  x0: "x0.at",
};

const DEFAULT_PROVIDER_ORDER: readonly TemporaryMediaProviderName[] = ["litterbox", "tmpfiles", "uguu", "x0"];

type TemporaryMediaUrlProviderOptions = {
  providerOrder?: readonly TemporaryMediaProviderName[];
};

export class TemporaryMediaUrlProvider implements MediaUrlProvider {
  private readonly providers: readonly { name: string; provider: MediaUrlProvider }[];

  constructor(fetchImpl: FetchLike = fetch, options: TemporaryMediaUrlProviderOptions = {}) {
    const providerByName: Record<TemporaryMediaProviderName, MediaUrlProvider> = {
      litterbox: new LitterboxMediaUrlProvider(fetchImpl, { maxAttempts: 1 }),
      tmpfiles: new TmpfilesMediaUrlProvider(fetchImpl),
      uguu: new UguuMediaUrlProvider(fetchImpl),
      x0: new X0MediaUrlProvider(fetchImpl),
    };
    this.providers = normalizeProviderOrder(options.providerOrder).map((name) => ({
      name: PROVIDER_LABELS[name],
      provider: providerByName[name],
    }));
  }

  async upload(localPath: string, options: { ttl?: Ttl } = {}): Promise<string> {
    const failures: string[] = [];

    for (const { name, provider } of this.providers) {
      try {
        return await provider.upload(localPath, options);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const providerNames = this.providers.map((provider) => provider.name).join(", ");
    throw new AgnesCliError("UPLOAD_FAILED", `Temporary upload failed after trying ${providerNames}.`, {
      failures,
    });
  }
}

function normalizeProviderOrder(providerOrder: readonly TemporaryMediaProviderName[] | undefined): readonly TemporaryMediaProviderName[] {
  const order = providerOrder?.length ? providerOrder : DEFAULT_PROVIDER_ORDER;
  const seen = new Set<TemporaryMediaProviderName>();
  const normalized: TemporaryMediaProviderName[] = [];

  for (const provider of order) {
    if (!(provider in PROVIDER_LABELS)) {
      throw new AgnesCliError("INPUT_INVALID", `Unknown temporary media provider: ${provider}`);
    }
    if (!seen.has(provider)) {
      seen.add(provider);
      normalized.push(provider);
    }
  }

  return normalized;
}

export class X0MediaUrlProvider implements MediaUrlProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async upload(localPath: string): Promise<string> {
    const form = await createFileForm(localPath, "file");
    const { response, text } = await postForm(this.fetchImpl, X0_ENDPOINT, form);

    if (!response.ok) {
      throw new AgnesCliError("UPLOAD_FAILED", `x0.at upload failed with HTTP ${response.status}.`, {
        status: response.status,
        body: text,
      });
    }

    const url = extractPlainTextUrl(text);
    if (!url) {
      throw new AgnesCliError("UPLOAD_FAILED", `x0.at did not return a public URL: ${text}`);
    }
    return url;
  }
}

export class UguuMediaUrlProvider implements MediaUrlProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async upload(localPath: string): Promise<string> {
    const form = await createFileForm(localPath, "files[]");
    const { response, text } = await postForm(this.fetchImpl, UGUU_ENDPOINT, form);

    if (!response.ok) {
      throw new AgnesCliError("UPLOAD_FAILED", `Uguu upload failed with HTTP ${response.status}.`, {
        status: response.status,
        body: text,
      });
    }

    const raw = parseUploadJson(text, "Uguu");
    const url = extractUguuUrl(raw);
    if (!url) {
      throw new AgnesCliError("UPLOAD_FAILED", `Uguu did not return a public URL: ${text}`);
    }
    return url;
  }
}

export class TmpfilesMediaUrlProvider implements MediaUrlProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async upload(localPath: string, options: { ttl?: Ttl } = {}): Promise<string> {
    const form = await createFileForm(localPath, "file");
    form.set("expire", TTL_SECONDS[options.ttl ?? "1h"]);

    const { response, text } = await postForm(this.fetchImpl, TMPFILES_ENDPOINT, form);
    if (!response.ok) {
      throw new AgnesCliError("UPLOAD_FAILED", `tmpfiles upload failed with HTTP ${response.status}.`, {
        status: response.status,
        body: text,
      });
    }

    const raw = parseUploadJson(text, "tmpfiles");
    const url = extractTmpfilesUrl(raw);
    if (!url) {
      throw new AgnesCliError("UPLOAD_FAILED", `tmpfiles did not return a public URL: ${text}`);
    }
    return toTmpfilesDirectUrl(url);
  }
}

async function createFileForm(localPath: string, fieldName: string): Promise<FormData> {
  const file = await fs.readFile(localPath);
  const form = new FormData();
  const mimeType = MIME_TYPES[extname(localPath).toLowerCase()] ?? "application/octet-stream";
  form.set(fieldName, new Blob([file], { type: mimeType }), basename(localPath));
  return form;
}

async function postForm(
  fetchImpl: FetchLike,
  endpoint: string,
  form: FormData,
): Promise<{ response: Response; text: string }> {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      body: form,
    });
    return { response, text: (await response.text()).trim() };
  } catch (error) {
    throw new AgnesCliError("UPLOAD_FAILED", `${new URL(endpoint).hostname} upload failed before a response was received.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseUploadJson(text: string, providerName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AgnesCliError("UPLOAD_FAILED", `${providerName} did not return JSON: ${text}`);
  }
}

function extractPlainTextUrl(text: string): string | undefined {
  const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

function extractUguuUrl(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const files = (raw as { files?: unknown }).files;
  if (!Array.isArray(files)) return undefined;
  const first = files[0];
  if (!first || typeof first !== "object") return undefined;
  const url = (first as { url?: unknown }).url;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined;
}

function extractTmpfilesUrl(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = (raw as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined;
}

function toTmpfilesDirectUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "tmpfiles.org" || parsed.pathname.startsWith("/dl/")) {
    return url;
  }
  parsed.pathname = `/dl${parsed.pathname}`;
  return parsed.toString();
}
