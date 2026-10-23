import { AgnesCliError } from "../errors.js";

export interface RequestJsonOptions {
  retries?: number;
  retryDelayMs?: number;
  networkMessage?: string;
  timeoutMs?: number;
}

export async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: RequestJsonOptions = {},
): Promise<{ response: Response; raw: unknown }> {
  const method = (init.method ?? "GET").toUpperCase();
  // Never retry non-idempotent POSTs by default: a timeout can mean Agnes
  // already accepted (and billed) the request.
  const isIdempotent = method === "GET" || method === "HEAD";
  const retries = options.retries ?? (isIdempotent ? 2 : 0);
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? resolveHttpTimeoutMs();
  const requestInit: RequestInit = init.signal
    ? init
    : { ...init, signal: AbortSignal.timeout(timeoutMs) };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, requestInit);
      const raw = await readResponseBody(response);
      return { response, raw };
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw new AgnesCliError(
          "NETWORK_ERROR",
          options.networkMessage ?? "Network request failed.",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      await sleep(retryDelayMs);
    }
  }

  throw new AgnesCliError("NETWORK_ERROR", options.networkMessage ?? "Network request failed.", {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

/**
 * Parse a `Retry-After` response header into milliseconds.
 *
 * Supports both documented forms: delay-seconds and an HTTP-date. Returns
 * `undefined` when the header is missing or unparseable; `0` is a valid value
 * (some endpoints answer `Retry-After: 0`).
 */
export function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers?.get("retry-after");
  if (raw === null || raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number.parseFloat(value);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

/** Statuses that are usually transient for idempotent (GET) requests. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;

  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Agnes occasionally returns plain-text or HTML error bodies.
  }
  return response.ok ? body : sanitizeResponseBody(body);
}

function sanitizeResponseBody(value: unknown, depth = 0): unknown {
  if (depth >= 20) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[^\s<]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi,
        "$1[REDACTED]",
      );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeResponseBody(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(?:(?:client|refresh|access|x)[_-])?(?:authorization|api[_-]?key|token|secret|password)$/i.test(key)
          ? "[REDACTED]"
          : sanitizeResponseBody(entry, depth + 1),
      ]),
    );
  }
  return value;
}

function resolveHttpTimeoutMs(): number {
  const raw = process.env.AGNES_HTTP_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
