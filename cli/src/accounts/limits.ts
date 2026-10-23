/**
 * Documented Agnes rate-limit presets, token buckets and status pacing
 * (docs/multi-account-research.md §1.2 / docs/multi-account-design.md §3).
 *
 * The API does not expose rate-limit headers on the text path (live probe P1),
 * so these client-side presets are the only defence. Values are configurable
 * per account only through concurrency; the RPM table follows upstream docs and
 * may change there.
 */
import { AgnesCliError } from "../errors.js";
import type { AccountConfig, AccountType, WorkloadClass } from "./types.js";

export type LimitBucket = "text" | "image1K" | "image2K" | "image3K" | "image4K" | "video";

export interface RpmPreset {
  text: number;
  image1K: number;
  image2K: number;
  image3K: number;
  image4K: number;
  video: number;
}

/** Effective RPM presets from the upstream token-plan docs (2026-10-23). */
export const RPM_PRESETS: Record<AccountType, RpmPreset> = {
  free: { text: 10, image1K: 10, image2K: 5, image3K: 1, image4K: 1, video: 1 },
  enterprise: { text: 20, image1K: 40, image2K: 20, image3K: 1, image4K: 1, video: 2 },
  tokenplan: { text: 1000, image1K: 100, image2K: 80, image3K: 1, image4K: 1, video: 5 },
};

export interface ConcurrencyPreset {
  text: number;
  image: number;
  video: number;
  status: number;
}

/** Per-account in-flight defaults per workload class. */
export const CONCURRENCY_PRESETS: Record<AccountType, ConcurrencyPreset> = {
  free: { text: 2, image: 1, video: 1, status: 1 },
  enterprise: { text: 4, image: 2, video: 2, status: 1 },
  tokenplan: { text: 8, image: 4, video: 4, status: 1 },
};

/** Status pacer adaptive constants (design §3). */
export const STATUS_PACER = {
  initialGapMs: 2000,
  minGapMs: 1000,
  maxGapMs: 30_000,
  backoffFactor: 2,
  recoveryEverySuccesses: 20,
  recoveryFactor: 0.9,
} as const;

/** 429 create cooldown backoff when the server sends no Retry-After. */
export const COOLDOWN = {
  baseMs: 1000,
  maxMs: 30_000,
  jitterMs: 250,
} as const;

export function rpmFor(type: AccountType, bucket: LimitBucket): number {
  return RPM_PRESETS[type][bucket];
}

/** Maps an effective image size to its RPM tier (nearest tier by longest edge). */
export function imageTierForSize(size: string | undefined): Exclude<LimitBucket, "text" | "video"> {
  if (!size || !size.trim()) return "image1K";
  const tier = size.trim().toUpperCase();
  if (tier === "1K" || tier === "2K" || tier === "3K" || tier === "4K") {
    return `image${tier}` as "image1K" | "image2K" | "image3K" | "image4K";
  }
  const match = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(size.trim());
  if (!match) return "image1K";
  const longestEdge = Math.max(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
  if (longestEdge <= 1024) return "image1K";
  if (longestEdge <= 2048) return "image2K";
  if (longestEdge <= 3072) return "image3K";
  return "image4K";
}

export function bucketForWorkload(workload: WorkloadClass, size?: string): LimitBucket | undefined {
  switch (workload) {
    case "text":
      return "text";
    case "video":
      return "video";
    case "image":
      return imageTierForSize(size);
    case "status":
      return undefined;
    default:
      return "text";
  }
}

export function concurrencyFor(account: AccountConfig, workload: WorkloadClass): number {
  const preset = CONCURRENCY_PRESETS[account.type] ?? CONCURRENCY_PRESETS.free;
  const value = account.concurrency ?? preset[workload];
  return Math.max(1, Math.floor(value));
}

/** Display-only aggregate concurrency for router summaries. */
export function displayConcurrency(account: AccountConfig): number {
  if (account.concurrency) return account.concurrency;
  const preset = CONCURRENCY_PRESETS[account.type] ?? CONCURRENCY_PRESETS.free;
  return Math.max(preset.text, preset.image, preset.video);
}

/**
 * Per-pool token bucket for create workloads.
 *
 * Capacity = max(1, rpm), refill = rpm / 60000 tokens per ms (design §3).
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(rpm: number, now = Date.now()) {
    this.capacity = Math.max(1, rpm);
    this.refillPerMs = Math.max(0, rpm) / 60_000;
    this.tokens = this.capacity;
    this.lastRefillAt = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefillAt);
    if (elapsed > 0 && this.refillPerMs > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefillAt = now;
    }
  }

  tryTake(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until one token is available (0 when available now). */
  msUntilAvailable(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    if (this.refillPerMs <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  get availableTokens(): number {
    return this.tokens;
  }
}

/**
 * Adaptive per-pool status pacer: at most one in-flight status request per
 * pool, starting at a 2 s gap, doubling on 429 (honouring Retry-After) and
 * recovering 10% every 20 successes down to a 1 s floor / 30 s cap.
 */
export class StatusPacer {
  gapMs: number;
  private readonly initialGapMs: number;
  inflight = 0;
  nextAllowedAt = 0;
  successes = 0;

  constructor(initialGapMs: number = STATUS_PACER.initialGapMs) {
    this.initialGapMs = Math.max(0, initialGapMs);
    this.gapMs = this.initialGapMs;
  }

  allowRequestNow(now: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, now + this.gapMs);
  }

  onSuccess(): void {
    this.successes += 1;
    if (this.successes % STATUS_PACER.recoveryEverySuccesses === 0) {
      this.gapMs = Math.max(STATUS_PACER.minGapMs, Math.floor(this.gapMs * STATUS_PACER.recoveryFactor));
    }
  }

  onRateLimited(retryAfterMs: number | undefined): void {
    const backoff = this.gapMs * STATUS_PACER.backoffFactor;
    const retry = retryAfterMs !== undefined ? retryAfterMs : 0;
    this.gapMs = Math.min(STATUS_PACER.maxGapMs, Math.max(backoff, retry, STATUS_PACER.minGapMs));
  }

  /** Reset back to the configured initial gap (tests / new pools). */
  reset(): void {
    this.gapMs = this.initialGapMs;
    this.successes = 0;
    this.inflight = 0;
    this.nextAllowedAt = 0;
  }
}

/** Exponential 429 cooldown for creates when Retry-After is absent. */
export function cooldownForAttempt(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(COOLDOWN.maxMs, COOLDOWN.baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(random() * COOLDOWN.jitterMs);
  return Math.min(COOLDOWN.maxMs, exponential + jitter);
}

export function assertKnownBucket(value: string): asserts value is LimitBucket {
  if (!["text", "image1K", "image2K", "image3K", "image4K", "video"].includes(value)) {
    throw new AgnesCliError("INTERNAL_ERROR", `Unknown rate-limit bucket ${value}.`);
  }
}
