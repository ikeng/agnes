import type { AgnesClientConfig, AgnesStatus, NormalizedVideoStatus } from "../config.js";
import { resolveClientConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { requestJson } from "../http/requestJson.js";
import { routingInfo } from "../accounts/route.js";
import type { AccountConfig, RouteOptions } from "../accounts/types.js";
import { extractTaskId, extractVideoId, normalizeStatus } from "./generateVideo.js";
import { DEFAULT_VIDEO_MODEL } from "../models.js";

export interface GetVideoOptions {
  timeoutMs?: number;
  /** Pass the model name to use the recommended `model_name` polling form (Video 2.5). */
  modelName?: string;
  /** Routing options (forced account / affinity / strategy), design §3. */
  route?: RouteOptions;
}

export async function getVideo(
  id: string,
  options: GetVideoOptions = {},
  config: AgnesClientConfig = {},
): Promise<NormalizedVideoStatus> {
  const resolved = resolveClientConfig(config);
  if (!resolved.apiKey) {
    throw new AgnesCliError("AUTH_MISSING", "AGNES_API_KEY is required for Agnes requests.");
  }
  const router = resolved.router;
  const route = options.route;
  const model = route?.model ?? options.modelName;

  // Create→poll affinity: resolve the owning account from the journal, or fall
  // back to a bounded probe when the journal has no entry (multi-account mode).
  const affinityAccount = await resolveStatusAccount(router, resolved, id, model, route);
  const accountId = route?.accountId ?? affinityAccount?.id;
  const deadlineMs = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;

  const routed = await router.execute(
    {
      ...(route ?? {}),
      workload: "status",
      method: "GET",
      ...(model ? { model } : {}),
      ...(accountId ? { accountId } : {}),
      ...(deadlineMs ? { deadlineMs } : {}),
    },
    (account) =>
      requestJson(
        resolved.fetchImpl,
        buildVideoGetUrl(account.baseUrl ?? resolved.baseUrl, id, model),
        {
          headers: {
            Authorization: `Bearer ${account.key}`,
          },
          ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
        },
        {
          networkMessage: "Agnes video status request failed before a response was received.",
          retries: router.isPassthrough ? undefined : 0,
        },
      ),
  );

  const { response, raw } = routed.value;
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

  const result = normalizeVideoStatus(raw, model ?? DEFAULT_VIDEO_MODEL);
  const routing = routingInfo(routed, route?.strategy ?? router.config.strategy);
  return {
    ...result,
    accountId: routed.accountId,
    poolId: routed.poolId,
    routing,
  };
}

/**
 * Status lookups must never silently rotate accounts (resource ids are
 * account-scoped). Resolution order: explicit route/account → journal entry
 * (`video:`/`task:`) → single account → bounded probe.
 */
async function resolveStatusAccount(
  router: ReturnType<typeof resolveClientConfig>["router"],
  resolved: ReturnType<typeof resolveClientConfig>,
  id: string,
  model: string | undefined,
  route: RouteOptions | undefined,
): Promise<AccountConfig | undefined> {
  if (route?.accountId || route?.affinityKey) return undefined;
  const keys = journalKeysFor(id);
  for (const key of keys) {
    const entry = router.getAffinity(key);
    if (!entry) continue;
    const account = router.config.accounts.find((candidate) => candidate.id === entry.accountId);
    if (account) return account;
  }
  if (router.config.accounts.length <= 1) return undefined;

  let probedRaw: unknown;
  const probed = await router.probeAffinity([id], {
    ...(model ? { model } : {}),
    workload: "status",
    probe: (account) =>
      requestJson(
        resolved.fetchImpl,
        buildVideoGetUrl(account.baseUrl ?? resolved.baseUrl, id, model),
        { headers: { Authorization: `Bearer ${account.key}` } },
        { networkMessage: "Agnes video status probe failed before a response was received.", retries: 0 },
      ).then((result) => {
        probedRaw = result.raw;
        return result;
      }),
  });
  if (probed) {
    bindProbedAffinity(router, id, probed.account, model, probedRaw);
    return probed.account;
  }
  throw new AgnesCliError(
    "AFFINITY_NOT_FOUND",
    `No account affinity was found for "${id}". Pass --account <id> to select the owning account explicitly.`,
    {
      id,
      accountsProbed: router.config.accounts.slice(0, Math.min(3, router.config.accounts.length)).map((account) => account.id),
    },
  );
}

function bindProbedAffinity(
  router: ReturnType<typeof resolveClientConfig>["router"],
  requestedId: string,
  account: AccountConfig,
  model: string | undefined,
  raw: unknown,
): void {
  const meta = { ...(model ? { model } : {}), kind: "video" };
  for (const key of journalKeysFor(requestedId)) {
    router.bindAffinity(key, account.id, meta);
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const videoId = typeof record.video_id === "string" ? record.video_id : undefined;
    const taskId = typeof record.task_id === "string" ? record.task_id : undefined;
    if (videoId) router.bindAffinity(`video:${videoId}`, account.id, meta);
    if (taskId) router.bindAffinity(`task:${taskId}`, account.id, meta);
  }
}

function journalKeysFor(id: string): string[] {
  const keys = id.startsWith("task_") ? [`task:${id}`, `video:${id}`] : [`video:${id}`, `task:${id}`];
  return keys;
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
