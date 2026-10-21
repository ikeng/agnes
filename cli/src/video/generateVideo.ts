import type { AgnesClientConfig, NormalizedVideoTask } from "../config.js";
import { resolveConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { requestJson } from "../http/requestJson.js";
import { toPublicUrl } from "../media/toPublicUrl.js";
import { collectVideoInputs, normalizeVideoRequest, type VideoGenerateOptions, videoGenerateSchema } from "./normalizeVideoRequest.js";
import { DEFAULT_VIDEO_MODEL } from "../models.js";

export async function generateVideo(
  options: VideoGenerateOptions,
  config: AgnesClientConfig = {},
): Promise<NormalizedVideoTask> {
  const parsed = videoGenerateSchema.parse(options);
  const resolved = resolveConfig(config);
  if (!resolved.apiKey) {
    throw new AgnesCliError("AUTH_MISSING", "AGNES_API_KEY is required for Agnes requests.");
  }

  const { inputs, ttl } = collectVideoInputs(parsed);
  const resolvedImages = await resolveMediaInputs(inputs, ttl, config);
  const payload = normalizeVideoRequest(parsed, resolvedImages);
  const { response, raw } = await requestJson(resolved.fetchImpl, `${resolved.baseUrl}/videos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, {
    networkMessage: "Agnes video request failed before a response was received.",
  });
  if (!response.ok) {
    throw new AgnesCliError("AGNES_REQUEST_FAILED", `Agnes video request failed with HTTP ${response.status}.`, raw);
  }
  return normalizeVideoTask(raw, parsed.model);
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

export function normalizeVideoTask(raw: unknown, fallbackModel = DEFAULT_VIDEO_MODEL): NormalizedVideoTask {
  const record = ensureRecord(raw);
  const taskId = extractTaskId(record);
  const videoId = extractVideoId(record);
  const rawStatus = typeof record.status === "string" ? record.status : "queued";
  return {
    ok: true,
    taskId,
    videoId,
    status: normalizeStatus(rawStatus),
    rawStatus,
    model: typeof record.model === "string" ? record.model : fallbackModel,
    raw,
  };
}

function ensureRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    throw new AgnesCliError("INVALID_RESPONSE", "Agnes video response was not an object.", raw);
  }
  return raw as Record<string, unknown>;
}

export function extractTaskId(record: Record<string, unknown>): string {
  const taskId = typeof record.task_id === "string"
    ? record.task_id
    : typeof record.id === "string"
      ? record.id
      : undefined;
  if (!taskId) {
    throw new AgnesCliError("TASK_ID_MISSING", "Agnes video response did not include task_id or id.", record);
  }
  return taskId;
}

export function extractVideoId(record: Record<string, unknown>): string | undefined {
  if (typeof record.video_id === "string") return record.video_id;
  if (typeof record.id === "string" && record.id.startsWith("video_")) return record.id;
  return undefined;
}

export function normalizeStatus(rawStatus: string): "queued" | "in_progress" | "completed" | "failed" | "canceled" {
  if (rawStatus === "succeeded") return "completed";
  if (rawStatus === "cancelled" || rawStatus === "canceled") return "canceled";
  if (rawStatus === "queued" || rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "failed") {
    return rawStatus;
  }
  return "queued";
}
