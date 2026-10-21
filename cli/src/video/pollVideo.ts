import type { AgnesClientConfig, NormalizedVideoResult } from "../config.js";
import { AgnesCliError, isAgnesCliError } from "../errors.js";
import { getVideo, normalizeVideoStatus } from "./getVideo.js";

export interface PollVideoOptions {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  /** Forwarded as `model_name` on the recommended Video 2.5 polling endpoint. */
  modelName?: string;
}

export async function pollVideo(
  id: string,
  options: PollVideoOptions = {},
  config: AgnesClientConfig = {},
): Promise<NormalizedVideoResult> {
  const intervalMs = (options.intervalSeconds ?? 5) * 1000;
  const timeoutMs = (options.timeoutSeconds ?? 600) * 1000;
  const started = Date.now();

  while (true) {
    if (Date.now() - started > timeoutMs) {
      throw new AgnesCliError("POLL_TIMEOUT", "Agnes video polling timed out.", { id, status: "timed_out" });
    }

    let result;
    try {
      result = await getVideo(id, options.modelName ? { modelName: options.modelName } : {}, config);
    } catch (error) {
      // Network blips, 429s and 5xx are transient for an idempotent status GET:
      // keep polling until the overall timeout instead of failing the task.
      if (isTransientPollError(error) && Date.now() - started < timeoutMs) {
        await sleep(intervalMs);
        continue;
      }
      throw error;
    }
    if (result.status === "completed" && result.videoUrl) {
      return {
        ...result,
        videoUrl: result.videoUrl,
      };
    }
    if (result.status === "failed" || result.status === "canceled") {
      throw new AgnesCliError("TASK_FAILED", "Agnes video task failed.", result);
    }
    await sleep(intervalMs);
  }
}

export function normalizeVideoResult(raw: unknown): NormalizedVideoResult {
  const result = normalizeVideoStatus(raw);
  return {
    ...result,
    videoUrl: result.videoUrl ?? "",
  };
}

function isTransientPollError(error: unknown): boolean {
  if (!isAgnesCliError(error)) return false;
  if (error.code === "SERVICE_BUSY" || error.code === "NETWORK_ERROR") return true;
  if (error.code !== "AGNES_REQUEST_FAILED") return false;
  const details = error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown>
    : {};
  const status = Number(details.httpStatus);
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
