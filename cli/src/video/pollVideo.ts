import type { AgnesClientConfig, NormalizedVideoResult } from "../config.js";
import { resolveClientConfig } from "../config.js";
import { AgnesCliError, isAgnesCliError } from "../errors.js";
import { getVideo, normalizeVideoStatus } from "./getVideo.js";
import type { RouteOptions } from "../accounts/types.js";

export interface PollVideoOptions {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  /** Forwarded as `model_name` on the recommended Video 2.5 polling endpoint. */
  modelName?: string;
  /** Routing options: affinity/account pin for create→poll consistency. */
  route?: RouteOptions;
}

export async function pollVideo(
  id: string,
  options: PollVideoOptions = {},
  config: AgnesClientConfig = {},
): Promise<NormalizedVideoResult> {
  const resolved = resolveClientConfig(config);
  const baseIntervalMs = (options.intervalSeconds ?? 5) * 1000;
  // The pacer floor (AGNES_POLL_INTERVAL_MS, default 2 s) only applies when
  // client-side pacing is active; raw JS-API clients keep their exact timings.
  const floorMs = resolved.router.isPassthrough ? 0 : resolved.router.pollIntervalMs;
  const intervalMs = Math.max(baseIntervalMs, floorMs);
  // AGNES_POLL_TIMEOUT_MS is the documented default poll budget when the caller
  // does not pass an explicit timeout (the CLI --timeout default still wins).
  const envTimeout = Number.parseInt(resolved.env.AGNES_POLL_TIMEOUT_MS ?? "", 10);
  const timeoutMs = options.timeoutSeconds !== undefined
    ? options.timeoutSeconds * 1000
    : Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : 600_000;
  const started = Date.now();

  while (true) {
    if (Date.now() - started > timeoutMs) {
      throw new AgnesCliError("POLL_TIMEOUT", "Agnes video polling timed out.", { id, status: "timed_out" });
    }

    let result;
    try {
      result = await getVideo(
        id,
        {
          ...(options.modelName ? { modelName: options.modelName } : {}),
          ...(options.route ? { route: options.route } : {}),
        },
        config,
      );
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
  if (
    error.code === "SERVICE_BUSY" ||
    error.code === "NETWORK_ERROR" ||
    error.code === "RATE_LIMITED"
  ) {
    return true;
  }
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
