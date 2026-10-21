import type { AgnesClientConfig, ImageGenerationResult } from "../config.js";
import { resolveConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { requestJson } from "../http/requestJson.js";
import { toPublicUrl } from "../media/toPublicUrl.js";
import { collectImageInputs, imageGenerateSchema, normalizeImageRequest, type ImageGenerateOptions } from "./normalizeImageRequest.js";

export async function generateImage(
  options: ImageGenerateOptions,
  config: AgnesClientConfig = {},
): Promise<ImageGenerationResult> {
  const parsed = imageGenerateSchema.parse(options);
  const resolved = resolveConfig(config);
  if (!resolved.apiKey) {
    throw new AgnesCliError("AUTH_MISSING", "AGNES_API_KEY is required for Agnes requests.");
  }

  const { inputs, ttl } = collectImageInputs(parsed);
  const resolvedImages = await resolveMediaInputs(inputs, ttl, config);
  const payload = normalizeImageRequest(parsed, resolvedImages);

  const { response, raw } = await requestJson(resolved.fetchImpl, `${resolved.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, {
    networkMessage: "Agnes image request failed before a response was received.",
  });
  if (!response.ok) {
    throw new AgnesCliError("AGNES_REQUEST_FAILED", `Agnes image request failed with HTTP ${response.status}.`, raw);
  }
  const url = extractImageUrl(raw);
  if (!url) {
    throw new AgnesCliError("IMAGE_URL_MISSING", "Agnes image response did not include a URL.", raw);
  }
  return {
    ok: true,
    model: String(payload.model),
    url,
    raw,
  };
}

async function resolveMediaInputs(inputs: string[], ttl: string | undefined, config: AgnesClientConfig): Promise<string[]> {
  const cache = new Map<string, string>();
  const resolved: string[] = [];
  for (const input of inputs) {
    if (!cache.has(input)) {
      const value = await toPublicUrl(input, ttl ? { ttl: ttl as never } : {}, config);
      cache.set(input, value.url);
    }
    resolved.push(cache.get(input)!);
  }
  return resolved;
}

function extractImageUrl(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data[0] : undefined;
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).url === "string") {
    return (data as Record<string, unknown>).url as string;
  }
  if (typeof record.url === "string") return record.url;
  return undefined;
}
