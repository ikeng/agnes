import type { AgnesClientConfig, AgnesStatus, NormalizedVideoStatus } from "../config.js";
import { resolveConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { requestJson } from "../http/requestJson.js";
import { extractTaskId, extractVideoId, normalizeStatus } from "./generateVideo.js";
import { DEFAULT_VIDEO_MODEL } from "../models.js";

export interface GetVideoOptions {
  timeoutMs?: number;
  /** Pass the model name to use the recommended `model_name` polling form (Video 2.5). */
  modelName?: string;
}

export async function getVideo(
  id: string,
  options: GetVideoOptions = {},
  config: AgnesClientConfig = {},
): Promise<NormalizedVideoStatus> {
  const resolved = resolveConfig(config);
  if (!resolved.apiKey) {
    throw new AgnesCliError("AUTH_MISSING", "AGNES_API_KEY is required for Agnes requests.");
  }

  const { response, raw } = await requestJson(resolved.fetchImpl, buildVideoGetUrl(resolved.baseUrl, id, options.modelName), {
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
    },
    ...(options.timeoutMs
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  }, {
    networkMessage: "Agnes video status request failed before a response was received.",
  });
  if (response.status === 404) {
    throw new AgnesCliError("TASK_NOT_FOUND", "Agnes video task was not found.", { id, status: "failed", raw });
  }
  if (response.status === 503) {
    throw new AgnesCliError("SERVICE_BUSY", "Agnes video service is busy.", { id, status: "queued", raw });
  }
  if (!response.ok) {
    throw new AgnesCliError("AGNES_REQUEST_FAILED", `Agnes video status request failed with HTTP ${response.status}.`, {
      id,
      status: "failed",
      httpStatus: response.status,
      raw,
    });
  }

  return normalizeVideoStatus(raw, options.modelName ?? DEFAULT_VIDEO_MODEL);
}

export function normalizeVideoStatus(raw: unknown, fallbackModel = DEFAULT_VIDEO_MODEL): NormalizedVideoStatus {
  if (!raw || typeof raw !== "object") {
    throw new AgnesCliError("INVALID_RESPONSE", "Agnes video status response was not an object.", raw);
  }
  const record = raw as Record<string, unknown>;
  const taskId = extractTaskId(record);
  const videoId = extractVideoId(record);
  const videoUrl = extractVideoUrl(record);
  const rawStatus = typeof record.status === "string" ? record.status : undefined;
  const status = rawStatus
    ? normalizeStatus(rawStatus)
    : record.completed_at != null && videoUrl
      ? "completed"
      : "queued";
  if (status === "completed" && !videoUrl) {
    throw new AgnesCliError("VIDEO_URL_MISSING", "Completed Agnes video task did not include a video URL.", raw);
  }
  return {
    ok: true,
    taskId,
    videoId,
    status: status as AgnesStatus,
    ...(rawStatus ? { rawStatus } : {}),
    model: typeof record.model === "string" ? record.model : fallbackModel,
    videoUrl,
    seconds: coerceNumber(record.seconds),
    size: typeof record.size === "string" ? record.size : undefined,
    error: record.error,
    raw,
  };
}

function buildVideoGetUrl(baseUrl: string, id: string, modelName?: string): string {
  if (id.startsWith("task_")) {
    return `${baseUrl.replace(/\/$/, "")}/videos/${encodeURIComponent(id)}`;
  }
  const url = new URL("/agnesapi", new URL(baseUrl));
  url.searchParams.set("video_id", id);
  // Video 2.5 recommends video_id + model_name for every mode; keyframe and
  // reference tasks require it. Legacy task ids keep the /videos/{task_id} path.
  if (modelName) url.searchParams.set("model_name", modelName);
  return url.toString();
}

function extractVideoUrl(record: Record<string, unknown>): string | undefined {
  const metadata = asRecord(record.metadata);
  const result = asRecord(record.result);
  const candidates: unknown[] = [
    metadata?.url,
    record.video_url,
    record.url,
    record.output_url,
    record.remixed_from_video_id,
    result?.video_url,
  ];
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && /^https?:\/\//.test(candidate),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function coerceNumber(value: unknown): number | undefined {
  const result = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(result) ? result : undefined;
}
