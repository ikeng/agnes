/**
 * Account router: account selection, pool-level pacing, 429 cooldowns, safe
 * failover, affinity binding and status-request serialization
 * (docs/multi-account-design.md §3, evidence in docs/multi-account-research.md).
 *
 * Safety rules enforced here:
 *  - POST create calls are never retried on ambiguous failures; a 5xx or
 *    network error after a POST becomes `AMBIGUOUS_CREATE` (the task may have
 *    been accepted and billed).
 *  - Status GETs never rotate accounts; affinity is the only cross-process
 *    context that identifies the owning credential.
 *  - Forced `--account` disables failover and names the account in errors.
 *  - Errors and summaries carry account ids only, never keys.
 */
import { AgnesCliError } from "../errors.js";
import { parseRetryAfterMs } from "../http/requestJson.js";
import type { AffinityEntry, AccountConfig, AccountsConfig, RouteOptions, RouteResult, RouterSummary, RoutingStrategy, WorkloadClass } from "./types.js";
import { ROUTING_STRATEGIES } from "./types.js";
import type { AffinityJournal } from "./affinity.js";
import {
  TokenBucket,
  StatusPacer,
  bucketForWorkload,
  cooldownForAttempt,
  concurrencyFor,
  displayConcurrency,
  rpmFor,
  type LimitBucket,
} from "./limits.js";

export interface RouterRuntime {
  fetchImpl: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export interface AccountRouterOptions {
  journal?: AffinityJournal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Base URL used by the built-in affinity probe when an account has no per-account gateway. */
  fallbackBaseUrl?: string;
  /** Initial adaptive status gap (AGNES_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
}

export interface ProbeAffinityOptions {
  model?: string;
  workload: "status";
  /** Optional transport supplied by the caller (reuses the domain URL builder). */
  probe?: (account: AccountConfig) => Promise<{ response: Response; raw: unknown }>;
}

export type SelectOptions = {
  workload: WorkloadClass;
  model?: string;
  excludeAccountIds?: string[];
  poolId?: string;
  strategy?: RoutingStrategy;
  accountId?: string;
  /** Effective image size for RPM bucket selection. */
  size?: string;
};

export interface ExecuteOptions extends RouteOptions {
  method: "GET" | "POST";
  maxAttempts?: number;
  maxWaitMs?: number;
  /** Absolute epoch-ms deadline for status polling loops. */
  deadlineMs?: number;
}

interface AttemptState {
  attempts: number;
  waitedMs: number;
  triedAccountIds: string[];
}

export class AccountRouter {
  readonly config: AccountsConfig;
  readonly fetchImpl: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  private readonly journal?: AffinityJournal;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly fallbackBaseUrl: string;
  private readonly pollIntervalMsValue: number;

  private readonly accountsById = new Map<string, AccountConfig>();
  private readonly accountOrder = new Map<string, number>();
  private readonly coolingUntil = new Map<string, number>();
  private readonly pool429Streak = new Map<string, number>();
  private readonly depletedPools = new Set<string>();
  private readonly unhealthyAccounts = new Set<string>();
  private readonly modelBlocked = new Map<string, Set<string>>();
  private readonly inflightByAccount = new Map<string, number>();
  private readonly inflightByPool = new Map<string, number>();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly pacers = new Map<string, StatusPacer>();
  private readonly wrrState = new Map<string, number>();
  private readonly memoryAffinity = new Map<string, AffinityEntry>();
  private roundRobinIndex = 0;

  constructor(config: AccountsConfig, runtime: RouterRuntime, options: AccountRouterOptions = {}) {
    this.config = config;
    this.fetchImpl = runtime.fetchImpl;
    this.env = runtime.env;
    this.journal = options.journal;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.fallbackBaseUrl = options.fallbackBaseUrl ?? "https://apihub.agnes-ai.com/v1";
    this.pollIntervalMsValue = options.pollIntervalMs ?? 2000;
    config.accounts.forEach((account, index) => {
      this.accountsById.set(account.id, account);
      this.accountOrder.set(account.id, index);
    });
  }

  /** Initial adaptive status gap (ms) used by video polling floors. */
  get pollIntervalMs(): number {
    return this.pollIntervalMsValue;
  }

  /**
   * Raw JS-API mode (`createAgnesClient({ apiKey })`): one implicit account,
   * no pacing, no status classification/failover. Keeps 0.2.x behavior.
   */
  get isPassthrough(): boolean {
    return (
      this.config.implicitLegacy === true &&
      !this.config.rateLimitEnabled &&
      this.config.accounts.length <= 1 &&
      this.config.source === "options"
    );
  }

  /* ------------------------------ selection ------------------------------ */

  /** Pick an account without acquiring capacity (batch strict pin). */
  select(options: SelectOptions): AccountConfig | undefined {
    if (options.accountId) {
      const account = this.accountsById.get(options.accountId);
      if (!account) return undefined;
      return this.modelAllowed(account, options.model) ? account : undefined;
    }
    const candidates = this.eligibleAccounts(options);
    if (candidates.length === 0) return undefined;
    const ordered = this.orderCandidates(candidates, options.strategy, options.workload);
    return ordered[0];
  }

  /** Redacted live router state for `accounts list` / diagnostics. */
  summary(): RouterSummary {
    const now = this.now();
    return {
      strategy: this.config.strategy,
      rateLimitEnabled: this.config.rateLimitEnabled,
      accounts: this.config.accounts.map((account) => ({
        id: account.id,
        type: account.type,
        poolId: account.poolId,
        weight: account.weight,
        priority: account.priority,
        concurrency: displayConcurrency(account),
        ...(account.models ? { models: [...account.models] } : {}),
        healthy: !this.unhealthyAccounts.has(account.id) && !this.isModelBlockedAll(account),
        ...(this.poolCoolingUntil(account.poolId) !== undefined
          ? { coolingUntil: this.poolCoolingUntil(account.poolId) }
          : {}),
        inflight: this.inflightByAccount.get(account.id) ?? 0,
      })),
      pools: this.config.pools.map((poolId) => ({
        id: poolId,
        ...(this.poolCoolingUntil(poolId) !== undefined ? { coolingUntil: this.poolCoolingUntil(poolId) } : {}),
        inflight: this.inflightByPool.get(poolId) ?? 0,
      })),
      warnings: [...this.config.warnings],
    };
  }

  /* ------------------------------- affinity ------------------------------ */

  bindAffinity(key: string, accountId: string, meta?: { model?: string; kind?: string }): void {
    const account = this.accountsById.get(accountId);
    if (!account) return;
    const journalEntry = this.journal?.bind(key, {
      accountId,
      poolId: account.poolId,
      ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.kind ? { kind: meta.kind } : {}),
    });
    const now = this.now();
    const existing = this.memoryAffinity.get(key);
    this.memoryAffinity.set(key, journalEntry ?? {
      accountId,
      poolId: account.poolId,
      ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.kind ? { kind: meta.kind } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  getAffinity(key: string): AffinityEntry | undefined {
    const memory = this.memoryAffinity.get(key);
    if (memory) return { ...memory };
    const entry = this.journal?.get(key);
    if (entry) this.memoryAffinity.set(key, entry);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Bounded probe when the affinity journal has no entry: accounts are visited
   * in configured order (max min(3, accounts)), stopping at the first response
   * that proves the resource is visible; 404s fall through, 401/403 mark the
   * account unhealthy and continue, 429 honors Retry-After.
   */
  async probeAffinity(
    idCandidates: string[],
    options: ProbeAffinityOptions,
  ): Promise<{ account: AccountConfig; entry: AffinityEntry } | undefined> {
    const pool = this.config.accounts.filter((account) => this.modelAllowed(account, options.model));
    const maxProbes = Math.min(3, pool.length);
    const candidates = pool.slice(0, maxProbes);
    for (const account of candidates) {
      const result = await this.probeAccount(account, idCandidates, options);
      if (result === "retry-exhausted") continue;
      if (result) {
        const now = this.now();
        return {
          account,
          entry: {
            accountId: account.id,
            poolId: account.poolId,
            ...(options.model ? { model: options.model } : {}),
            kind: "video",
            createdAt: now,
            updatedAt: now,
          },
        };
      }
    }
    return undefined;
  }

  private async probeAccount(
    account: AccountConfig,
    idCandidates: string[],
    options: ProbeAffinityOptions,
  ): Promise<"retry-exhausted" | { response: Response; raw: unknown } | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: { response: Response; raw: unknown };
      try {
        result = await (options.probe
          ? options.probe(account)
          : this.defaultProbe(account, idCandidates, options.model));
      } catch {
        return undefined;
      }
      const status = result.response.status;
      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(result.response) ?? this.pacerFor(account.poolId).gapMs;
        this.recordPool429(account.poolId, retryAfterMs, options.workload);
        if (attempt === 0) {
          await this.sleep(Math.min(Math.max(retryAfterMs, 100), 5000));
          continue;
        }
        return undefined;
      }
      if (status === 404) return undefined;
      if (status === 401) {
        this.unhealthyAccounts.add(account.id);
        return undefined;
      }
      if (status === 403) {
        if (looksLikeModelAccess(result.raw)) return undefined;
        this.unhealthyAccounts.add(account.id);
        return undefined;
      }
      if (status === 400 && looksLikeTaskMissing(result.raw)) return undefined;
      if (status >= 500) return undefined;
      // 2xx or a non-404 domain error (e.g. legacy 400 validation): the
      // resource belongs to this account.
      return result;
    }
    return "retry-exhausted";
  }

  private defaultProbe(account: AccountConfig, idCandidates: string[], model?: string) {
    const id = idCandidates[0];
    const baseUrl = (account.baseUrl ?? this.fallbackBaseUrl).replace(/\/$/, "");
    let url: string;
    if (id.startsWith("task_")) {
      url = `${baseUrl}/videos/${encodeURIComponent(id)}`;
    } else {
      const parsed = new URL("/agnesapi", new URL(baseUrl));
      parsed.searchParams.set("video_id", id);
      if (model) parsed.searchParams.set("model_name", model);
      url = parsed.toString();
    }
    return this.request(account, url, { method: "GET" });
  }

  /* -------------------------------- execute ------------------------------ */

  async execute<T extends { response: Response; raw: unknown }>(
    options: ExecuteOptions,
    send: (account: AccountConfig) => Promise<T>,
  ): Promise<RouteResult<T>> {
    const workload = options.workload ?? "text";
    const strategy = this.resolveStrategy(options.strategy);
    const method = options.method;
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? this.config.maxAttempts));
    const maxWaitMs = Math.max(1, Math.floor(options.maxWaitMs ?? this.config.maxWaitMs));
    const startedAt = this.now();
    const absoluteDeadline = Math.min(startedAt + maxWaitMs, options.deadlineMs ?? Number.POSITIVE_INFINITY);
    const state: AttemptState = { attempts: 0, waitedMs: 0, triedAccountIds: [] };
    const effectiveOptions: ExecuteOptions = { ...options, strategy };

    if (this.isPassthrough) {
      return this.passthrough(effectiveOptions, send);
    }
    if (this.config.accounts.length === 0) {
      throw new AgnesCliError("AUTH_MISSING", "No Agnes accounts are configured.", undefined, 1);
    }

    const forced = this.resolveForcedAccount(effectiveOptions);
    if (forced) this.assertModelAllowed(forced, effectiveOptions.model);
    if (effectiveOptions.model && !this.someAccountServesModel(effectiveOptions)) {
      throw new AgnesCliError(
        "MODEL_NOT_ALLOWED",
        `No configured account can serve model "${effectiveOptions.model}".`,
        {
          model: effectiveOptions.model,
          ...(options.poolId ? { poolId: options.poolId } : {}),
          accounts: this.config.accounts.map((account) => account.id),
        },
        1,
      );
    }

    if (workload === "status") {
      return this.executeStatus(effectiveOptions, send, { startedAt, absoluteDeadline, maxAttempts, state, forced });
    }
    if (method !== "POST") {
      // Non-status GETs (accounts check, future read-only calls) use a single
      // paced send with the standard failover matrix but no token bucket.
      return this.executeRead(effectiveOptions, send, { startedAt, absoluteDeadline, maxAttempts, state, forced });
    }
    return this.executeCreate(effectiveOptions, send, { startedAt, absoluteDeadline, maxAttempts, state, forced });
  }

  private async passthrough<T extends { response: Response; raw: unknown }>(
    options: ExecuteOptions,
    send: (account: AccountConfig) => Promise<T>,
  ): Promise<RouteResult<T>> {
    const account = this.resolveForcedAccount(options) ?? this.config.accounts[0];
    if (!account) {
      throw new AgnesCliError("AUTH_MISSING", "No Agnes accounts are configured.", undefined, 1);
    }
    const value = await send(account);
    if (value.response.ok && options.affinityKey) {
      this.bindAffinity(options.affinityKey, account.id, {
        ...(options.model ? { model: options.model } : {}),
        kind: options.workload,
      });
    }
    return { value, accountId: account.id, poolId: account.poolId, attempts: 1, waitedMs: 0, fallback: false };
  }

  private async executeCreate<T extends { response: Response; raw: unknown }>(
    options: ExecuteOptions,
    send: (account: AccountConfig) => Promise<T>,
    context: { startedAt: number; absoluteDeadline: number; maxAttempts: number; state: AttemptState; forced?: AccountConfig },
  ): Promise<RouteResult<T>> {
    const { absoluteDeadline, maxAttempts, state, forced } = context;
    const workload = options.workload ?? "text";
    const excludedAccounts = new Set<string>();
    const excludedPools = new Set<string>();
    let lastError: AgnesCliError | undefined;

    while (state.attempts < maxAttempts) {
      const candidate = forced
        ? this.usableForcedAccount(forced, options, excludedAccounts)
        : this.nextCreateCandidate(options, excludedAccounts, excludedPools);
      if (!candidate) {
        if (lastError) throw lastError;
        const waitMs = forced
          ? this.poolCooldownWait(forced.poolId)
          : this.earliestCandidateWait(options, excludedAccounts, excludedPools);
        if (waitMs !== undefined) {
          this.ensureBudget(waitMs, absoluteDeadline, state, options, forced, lastError);
          await this.wait(waitMs, state);
          continue;
        }
        throw new AgnesCliError(
          "RATE_LIMITED",
          "No eligible Agnes account can serve this request right now.",
          { accountsTried: [...state.triedAccountIds], ...(options.poolId ? { poolId: options.poolId } : {}) },
        );
      }

      state.attempts += 1;
      state.triedAccountIds.push(candidate.id);
      await this.acquireCreateCapacity(candidate, options, absoluteDeadline, state);
      let value: T;
      try {
        value = await send(candidate);
      } catch (error) {
        this.releaseAccount(candidate);
        throw this.ambiguousCreate(candidate, options, error);
      }
      this.releaseAccount(candidate);
      const status = value.response.status;
      if (value.response.ok) {
        this.onPoolSuccess(candidate.poolId);
        this.bindSuccessAffinity(options, candidate);
        return this.routeResult(value, candidate, state);
      }
      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(value.response);
        const cooldown = this.recordPool429(candidate.poolId, retryAfterMs, workload);
        excludedPools.add(candidate.poolId);
        lastError = new AgnesCliError(
          "RATE_LIMITED",
          `Agnes rate limit reached for pool "${candidate.poolId}" (HTTP 429).`,
          {
            httpStatus: 429,
            poolId: candidate.poolId,
            accountId: candidate.id,
            retryAfterMs: cooldown,
            accountsTried: [...state.triedAccountIds],
            raw: value.raw,
          },
        );
        if (forced) {
          const waitMs = this.poolCooldownWait(candidate.poolId);
          if (waitMs !== undefined && state.attempts < maxAttempts) {
            this.ensureBudget(waitMs, absoluteDeadline, state, options, forced, lastError);
            await this.wait(waitMs, state);
            continue;
          }
          throw lastError;
        }
        if (state.attempts >= maxAttempts) throw lastError;
        continue;
      }
      if (status === 401 || status === 403) {
        const modelAccess = status === 403 && looksLikeModelAccess(value.raw);
        if (modelAccess) {
          this.markModelBlocked(candidate, options.model);
          lastError = this.modelNotAllowedError(candidate, options.model, value.response.status, value.raw);
        } else {
          this.unhealthyAccounts.add(candidate.id);
          lastError = new AgnesCliError(
            "ACCOUNT_AUTH_FAILED",
            `Agnes rejected the credential for account "${candidate.id}" (HTTP ${status}).`,
            {
              httpStatus: status,
              accountId: candidate.id,
              poolId: candidate.poolId,
              accountsTried: [...state.triedAccountIds],
              raw: value.raw,
            },
          );
        }
        excludedAccounts.add(candidate.id);
        if (forced) throw lastError;
        if (state.attempts >= maxAttempts) throw lastError;
        continue;
      }
      if (status === 402) {
        this.depletedPools.add(candidate.poolId);
        excludedPools.add(candidate.poolId);
        lastError = new AgnesCliError(
          "QUOTA_EXHAUSTED",
          `Agnes quota is exhausted for pool "${candidate.poolId}" (HTTP 402).`,
          {
            httpStatus: 402,
            accountId: candidate.id,
            poolId: candidate.poolId,
            accountsTried: [...state.triedAccountIds],
            raw: value.raw,
          },
        );
        if (forced) throw lastError;
        if (state.attempts >= maxAttempts) throw lastError;
        continue;
      }
      if (status >= 500) {
        throw this.ambiguousCreate(candidate, options, undefined, value.response.status, value.raw);
      }
      // 400 / 404 / 422 / unexpected statuses stay with the caller so domain
      // modules keep their existing error messages.
      return this.routeResult(value, candidate, state);
    }
    throw lastError ?? new AgnesCliError("RATE_LIMITED", "Agnes request could not be routed.", {
      accountsTried: [...state.triedAccountIds],
    });
  }

  private async executeRead<T extends { response: Response; raw: unknown }>(
    options: ExecuteOptions,
    send: (account: AccountConfig) => Promise<T>,
    context: { startedAt: number; absoluteDeadline: number; maxAttempts: number; state: AttemptState; forced?: AccountConfig },
  ): Promise<RouteResult<T>> {
    const { absoluteDeadline, maxAttempts, state, forced } = context;
    const excludedAccounts = new Set<string>();
    let account = forced;
    let lastError: AgnesCliError | undefined;
    while (state.attempts < maxAttempts) {
      account ??= this.select({ workload: options.workload ?? "text", model: options.model, excludeAccountIds: [...excludedAccounts] });
      if (!account) throw lastError ?? new AgnesCliError("RATE_LIMITED", "No eligible Agnes account can serve this request.", {
        accountsTried: [...state.triedAccountIds],
      });
      state.attempts += 1;
      state.triedAccountIds.push(account.id);
      await this.acquireCreateCapacity(account, { ...options, workload: "status" }, absoluteDeadline, state);
      let value: T;
      try {
        value = await send(account);
      } catch (error) {
        this.releaseAccount(account);
        if (this.isNetworkError(error) && state.attempts < maxAttempts && this.now() < absoluteDeadline) {
          await this.wait(Math.min(1000, this.remainingBudget(absoluteDeadline)), state);
          if (!forced) account = undefined;
          continue;
        }
        throw error;
      }
      this.releaseAccount(account);
      const status = value.response.status;
      if (value.response.ok) return this.routeResult(value, account, state);
      if (status === 429) {
        this.recordPool429(account.poolId, parseRetryAfterMs(value.response), options.workload ?? "text");
        lastError = new AgnesCliError("RATE_LIMITED", `Agnes rate limit reached for pool "${account.poolId}" (HTTP 429).`, {
          httpStatus: 429,
          accountId: account.id,
          poolId: account.poolId,
          accountsTried: [...state.triedAccountIds],
        });
        if (forced) {
          const waitMs = this.poolCooldownWait(account.poolId) ?? 0;
          if (state.attempts < maxAttempts) {
            this.ensureBudget(waitMs, absoluteDeadline, state, options, forced, lastError);
            await this.wait(waitMs, state);
            continue;
          }
        }
        excludedAccounts.add(account.id);
        if (!forced) account = undefined;
        continue;
      }
      if (status === 401 || status === 403) {
        this.unhealthyAccounts.add(account.id);
        lastError = new AgnesCliError("ACCOUNT_AUTH_FAILED", `Agnes rejected the credential for account "${account.id}" (HTTP ${status}).`, {
          httpStatus: status,
          accountId: account.id,
          accountsTried: [...state.triedAccountIds],
          raw: value.raw,
        });
        excludedAccounts.add(account.id);
        if (forced) throw lastError;
        account = undefined;
        continue;
      }
      return this.routeResult(value, account, state);
    }
    throw lastError ?? new AgnesCliError("RATE_LIMITED", "Agnes request could not be routed.", {
      accountsTried: [...state.triedAccountIds],
    });
  }

  /** Status GETs: one account, no rotation, paced by the pool status pacer. */
  private async executeStatus<T extends { response: Response; raw: unknown }>(
    options: ExecuteOptions,
    send: (account: AccountConfig) => Promise<T>,
    context: { startedAt: number; absoluteDeadline: number; maxAttempts: number; state: AttemptState; forced?: AccountConfig },
  ): Promise<RouteResult<T>> {
    const { absoluteDeadline, maxAttempts, state, forced } = context;
    const workload = "status" as const;
    const account = forced ?? this.select({ workload, model: options.model });
    if (!account) {
      throw new AgnesCliError("AFFINITY_NOT_FOUND", "No account is available for this status lookup.", undefined, 1);
    }
    this.assertModelAllowed(account, options.model);
    let lastError: AgnesCliError | undefined;
    while (state.attempts < maxAttempts) {
      state.attempts += 1;
      state.triedAccountIds.push(account.id);
      await this.acquireStatusCapacity(account, absoluteDeadline, state);
      let value: T;
      try {
        value = await send(account);
      } catch (error) {
        this.releaseStatus(account, { networkError: true, retryAfterMs: undefined });
        if (this.isNetworkError(error) && state.attempts < maxAttempts && this.now() < absoluteDeadline) {
          await this.wait(
            Math.min(cooldownForAttempt(state.attempts, this.random), this.remainingBudget(absoluteDeadline)),
            state,
          );
          continue;
        }
        throw error;
      }
      const status = value.response.status;
      const retryAfterMs = parseRetryAfterMs(value.response);
      this.releaseStatus(account, { status, retryAfterMs });
      if (value.response.ok) return this.routeResult(value, account, state);
      if (status === 429) {
        const cooldown = this.recordPool429(account.poolId, retryAfterMs, workload);
        lastError = new AgnesCliError(
          "RATE_LIMITED",
          `Agnes rate limit reached while polling (HTTP 429 on pool "${account.poolId}"); not rotating accounts.`,
          {
            httpStatus: 429,
            accountId: account.id,
            poolId: account.poolId,
            retryAfterMs: cooldown,
            accountsTried: [...state.triedAccountIds],
            raw: value.raw,
          },
        );
        if (state.attempts < maxAttempts && this.now() < absoluteDeadline) continue;
        throw lastError;
      }
      if (status === 401) {
        this.unhealthyAccounts.add(account.id);
        throw new AgnesCliError("ACCOUNT_AUTH_FAILED", `Agnes rejected the credential for account "${account.id}" (HTTP 401).`, {
          httpStatus: 401,
          accountId: account.id,
          poolId: account.poolId,
          raw: value.raw,
        });
      }
      if (status === 403) {
        if (looksLikeModelAccess(value.raw)) throw this.modelNotAllowedError(account, options.model, 403, value.raw);
        this.unhealthyAccounts.add(account.id);
        throw new AgnesCliError("ACCOUNT_AUTH_FAILED", `Agnes rejected the credential for account "${account.id}" (HTTP 403).`, {
          httpStatus: 403,
          accountId: account.id,
          poolId: account.poolId,
          raw: value.raw,
        });
      }
      if (status === 402) {
        this.depletedPools.add(account.poolId);
        throw new AgnesCliError("QUOTA_EXHAUSTED", `Agnes quota is exhausted for pool "${account.poolId}" (HTTP 402).`, {
          httpStatus: 402,
          accountId: account.id,
          poolId: account.poolId,
          raw: value.raw,
        });
      }
      if (status >= 500) {
        lastError = new AgnesCliError(
          status === 503 ? "SERVICE_BUSY" : "AGNES_REQUEST_FAILED",
          `Agnes video status request failed with HTTP ${status}.`,
          { httpStatus: status, accountId: account.id, status: "failed", raw: value.raw },
        );
        if (state.attempts < maxAttempts && this.now() < absoluteDeadline) {
          await this.wait(
            Math.min(cooldownForAttempt(state.attempts, this.random), this.remainingBudget(absoluteDeadline)),
            state,
          );
          continue;
        }
        throw lastError;
      }
      // 400 / 404 / 422: caller decides (TASK_NOT_FOUND, AGNES_REQUEST_FAILED, ...).
      return this.routeResult(value, account, state);
    }
    throw lastError ?? new AgnesCliError("RATE_LIMITED", "Agnes status request could not be completed.", {
      accountsTried: [...state.triedAccountIds],
    });
  }

  /* ---------------------------- internal helpers -------------------------- */

  private resolveStrategy(value: RoutingStrategy | undefined): RoutingStrategy {
    const strategy = value ?? this.config.strategy;
    if (!(ROUTING_STRATEGIES as readonly string[]).includes(strategy)) {
      throw new AgnesCliError(
        "INVALID_STRATEGY",
        `Unknown routing strategy "${String(strategy)}". Allowed: ${ROUTING_STRATEGIES.join(", ")}.`,
        undefined,
        2,
      );
    }
    return strategy;
  }

  private resolveForcedAccount(options: ExecuteOptions): AccountConfig | undefined {
    if (options.accountId) {
      const account = this.accountsById.get(options.accountId) ?? this.config.accounts.find((entry) => entry.id === options.accountId!.toLowerCase());
      if (!account) {
        throw new AgnesCliError(
          "ACCOUNT_NOT_FOUND",
          `Unknown account "${options.accountId}". Available: ${this.config.accounts.map((entry) => entry.id).join(", ") || "(none)"}.`,
          { accountId: options.accountId, available: this.config.accounts.map((entry) => entry.id) },
          2,
        );
      }
      return account;
    }
    if (options.affinityKey) {
      const entry = this.getAffinity(options.affinityKey);
      if (entry) {
        const account = this.accountsById.get(entry.accountId);
        if (account) return account;
      }
    }
    return undefined;
  }

  private usableForcedAccount(
    forced: AccountConfig,
    options: ExecuteOptions,
    excluded: Set<string>,
  ): AccountConfig | undefined {
    if (excluded.has(forced.id)) return undefined;
    if (this.depletedPools.has(forced.poolId)) return undefined;
    if (this.unhealthyAccounts.has(forced.id)) return undefined;
    if (!this.modelAllowed(forced, options.model)) return undefined;
    return forced;
  }

  private eligibleAccounts(options: SelectOptions): AccountConfig[] {
    const exclude = new Set(options.excludeAccountIds ?? []);
    return this.config.accounts.filter((account) => {
      if (exclude.has(account.id)) return false;
      if (options.poolId && account.poolId !== options.poolId) return false;
      if (this.unhealthyAccounts.has(account.id)) return false;
      if (this.depletedPools.has(account.poolId)) return false;
      if (!this.modelAllowed(account, options.model)) return false;
      return true;
    });
  }

  private orderCandidates(candidates: AccountConfig[], strategyValue: RoutingStrategy | undefined, workload: WorkloadClass): AccountConfig[] {
    const strategy = strategyValue ?? this.config.strategy;
    const byOrder = [...candidates].sort(
      (a, b) => (this.accountOrder.get(a.id) ?? 0) - (this.accountOrder.get(b.id) ?? 0),
    );
    switch (strategy) {
      case "primary":
        return byOrder.sort((a, b) => (a.priority - b.priority) || ((this.accountOrder.get(a.id) ?? 0) - (this.accountOrder.get(b.id) ?? 0)));
      case "round-robin": {
        const index = this.roundRobinIndex++ % byOrder.length;
        return [...byOrder.slice(index), ...byOrder.slice(0, index)];
      }
      case "weighted": {
        const scored = byOrder.map((account) => {
          const current = (this.wrrState.get(account.id) ?? 0) + account.weight;
          this.wrrState.set(account.id, current);
          return { account, current };
        });
        scored.sort((a, b) => (b.current - a.current) || ((this.accountOrder.get(a.account.id) ?? 0) - (this.accountOrder.get(b.account.id) ?? 0)));
        const total = candidates.reduce((sum, account) => sum + account.weight, 0);
        this.wrrState.set(scored[0].account.id, scored[0].current - total);
        return [scored[0].account, ...scored.slice(1).map((entry) => entry.account)];
      }
      case "least-inflight": {
        return byOrder.sort((a, b) => {
          const ratioA = this.utilization(a, workload);
          const ratioB = this.utilization(b, workload);
          return ratioA - ratioB || (a.priority - b.priority) || ((this.accountOrder.get(a.id) ?? 0) - (this.accountOrder.get(b.id) ?? 0));
        });
      }
      case "adaptive":
      default: {
        const sorted = byOrder.sort((a, b) => {
          const ratioA = this.utilization(a, workload);
          const ratioB = this.utilization(b, workload);
          return ratioA - ratioB || (a.priority - b.priority) || ((this.accountOrder.get(a.id) ?? 0) - (this.accountOrder.get(b.id) ?? 0));
        });
        const best = this.utilization(sorted[0], workload);
        const ties = sorted.filter((account) => this.utilization(account, workload) === best);
        const offset = this.roundRobinIndex++ % ties.length;
        const chosen = ties[offset];
        return [chosen, ...sorted.filter((account) => account !== chosen)];
      }
    }
  }

  private utilization(account: AccountConfig, workload: WorkloadClass): number {
    const limit = concurrencyFor(account, workload);
    return (this.inflightByAccount.get(account.id) ?? 0) / limit;
  }

  private nextCreateCandidate(
    options: ExecuteOptions,
    excludedAccounts: Set<string>,
    excludedPools: Set<string>,
  ): AccountConfig | undefined {
    const now = this.now();
    const workload = options.workload ?? "text";
    const candidates = this.eligibleAccounts({
      workload,
      model: options.model,
      poolId: options.poolId,
      excludeAccountIds: [...excludedAccounts],
    }).filter((account) => !excludedPools.has(account.poolId));
    if (candidates.length === 0) return undefined;
    const ready = candidates.filter((account) => (this.poolCoolingUntil(account.poolId) ?? 0) <= now);
    if (ready.length === 0) return undefined;
    const ordered = this.orderCandidates(ready, options.strategy, workload);
    if (!this.config.rateLimitEnabled) return ordered[0];
    const withCapacity = ordered.find((account) => this.bucketWait(account, options) === 0);
    return withCapacity ?? ordered[0];
  }

  private earliestCandidateWait(
    options: ExecuteOptions,
    excludedAccounts: Set<string>,
    excludedPools: Set<string>,
  ): number | undefined {
    const now = this.now();
    const candidates = this.eligibleAccounts({
      workload: options.workload ?? "text",
      model: options.model,
      poolId: options.poolId,
      excludeAccountIds: [...excludedAccounts],
    }).filter((account) => !excludedPools.has(account.poolId));
    if (candidates.length === 0) return undefined;
    let earliest: number | undefined;
    for (const account of candidates) {
      const wait = this.poolCooldownWait(account.poolId) ?? 0;
      if (wait <= 0) return 0;
      earliest = earliest === undefined ? wait : Math.min(earliest, wait);
    }
    return earliest;
  }

  private bucketKey(poolId: string, bucket: LimitBucket): string {
    return `${poolId}:${bucket}`;
  }

  private bucketFor(account: AccountConfig, bucket: LimitBucket): TokenBucket {
    const key = this.bucketKey(account.poolId, bucket);
    let tokenBucket = this.buckets.get(key);
    if (!tokenBucket) {
      tokenBucket = new TokenBucket(rpmFor(account.type, bucket), this.now());
      this.buckets.set(key, tokenBucket);
    }
    return tokenBucket;
  }

  private bucketWait(account: AccountConfig, options: ExecuteOptions): number {
    if (!this.config.rateLimitEnabled) return 0;
    const bucket = bucketForWorkload(options.workload ?? "text", options.size);
    if (!bucket) return 0;
    return this.bucketFor(account, bucket).msUntilAvailable(this.now());
  }

  private async acquireCreateCapacity(
    account: AccountConfig,
    options: ExecuteOptions,
    deadline: number,
    state: AttemptState,
  ): Promise<void> {
    const workload = options.workload ?? "text";
    // Forced accounts may still be cooling: wait it out instead of rotating.
    const coolingWait = this.poolCooldownWait(account.poolId);
    if (coolingWait !== undefined && coolingWait > 0) {
      this.ensureBudget(coolingWait, deadline, state, options, account, undefined);
      await this.wait(coolingWait, state);
    }
    if (this.config.rateLimitEnabled) {
      const bucketName = bucketForWorkload(workload, options.size);
      if (bucketName) {
        const bucket = this.bucketFor(account, bucketName);
        for (;;) {
          const waitMs = bucket.msUntilAvailable(this.now());
          if (waitMs <= 0 && bucket.tryTake(this.now())) break;
          this.ensureBudget(waitMs, deadline, state, options, account, undefined);
          await this.wait(waitMs, state);
        }
      }
    }
    const limit = concurrencyFor(account, workload);
    for (;;) {
      const inflight = this.inflightByAccount.get(account.id) ?? 0;
      if (inflight < limit) break;
      const remaining = deadline - this.now();
      this.ensureBudget(20, deadline, state, options, account, undefined);
      await this.wait(Math.max(1, Math.min(20, remaining)), state);
    }
    this.inflightByAccount.set(account.id, (this.inflightByAccount.get(account.id) ?? 0) + 1);
    this.inflightByPool.set(account.poolId, (this.inflightByPool.get(account.poolId) ?? 0) + 1);
  }

  private async acquireStatusCapacity(account: AccountConfig, deadline: number, state: AttemptState): Promise<void> {
    const pacer = this.pacerFor(account.poolId);
    for (;;) {
      const cooling = this.poolCooldownWait(account.poolId) ?? 0;
      if (cooling > 0) {
        this.ensureBudget(cooling, deadline, state);
        await this.wait(cooling, state);
        continue;
      }
      if (pacer.inflight > 0) {
        this.ensureBudget(20, deadline, state);
        await this.wait(Math.min(20, Math.max(1, deadline - this.now())), state);
        continue;
      }
      const gapWait = pacer.nextAllowedAt - this.now();
      if (gapWait > 0) {
        this.ensureBudget(gapWait, deadline, state);
        await this.wait(gapWait, state);
        continue;
      }
      pacer.inflight += 1;
      pacer.nextAllowedAt = this.now() + pacer.gapMs;
      this.inflightByAccount.set(account.id, (this.inflightByAccount.get(account.id) ?? 0) + 1);
      this.inflightByPool.set(account.poolId, (this.inflightByPool.get(account.poolId) ?? 0) + 1);
      return;
    }
  }

  private releaseAccount(account: AccountConfig): void {
    this.inflightByAccount.set(account.id, Math.max(0, (this.inflightByAccount.get(account.id) ?? 0) - 1));
    this.inflightByPool.set(account.poolId, Math.max(0, (this.inflightByPool.get(account.poolId) ?? 0) - 1));
  }

  private releaseStatus(account: AccountConfig, outcome: { status?: number; retryAfterMs?: number; networkError?: boolean }): void {
    const pacer = this.pacerFor(account.poolId);
    pacer.inflight = Math.max(0, pacer.inflight - 1);
    this.releaseAccount(account);
    if (outcome.status === 429) {
      pacer.onRateLimited(outcome.retryAfterMs);
    } else if (outcome.status !== undefined && outcome.status >= 200 && outcome.status < 300) {
      pacer.onSuccess();
    }
  }

  private pacerFor(poolId: string): StatusPacer {
    let pacer = this.pacers.get(poolId);
    if (!pacer) {
      pacer = new StatusPacer(Math.max(2000, this.pollIntervalMsValue));
      this.pacers.set(poolId, pacer);
    }
    return pacer;
  }

  private recordPool429(poolId: string, retryAfterMs: number | undefined, workload: WorkloadClass | "status"): number {
    const now = this.now();
    const streak = (this.pool429Streak.get(poolId) ?? 0) + 1;
    this.pool429Streak.set(poolId, streak);
    const cooldown =
      retryAfterMs !== undefined ? Math.max(0, retryAfterMs) : cooldownForAttempt(streak, this.random);
    const until = now + cooldown;
    this.coolingUntil.set(poolId, Math.max(this.coolingUntil.get(poolId) ?? 0, until));
    if (workload === "status" || workload === "video") {
      const pacer = this.pacerFor(poolId);
      pacer.onRateLimited(retryAfterMs);
      pacer.nextAllowedAt = Math.max(pacer.nextAllowedAt, now + Math.max(pacer.gapMs, cooldown));
    }
    return cooldown;
  }

  private onPoolSuccess(poolId: string): void {
    this.pool429Streak.delete(poolId);
  }

  private poolCoolingUntil(poolId: string): number | undefined {
    const until = this.coolingUntil.get(poolId);
    if (until === undefined) return undefined;
    if (until <= this.now()) {
      this.coolingUntil.delete(poolId);
      return undefined;
    }
    return until;
  }

  private poolCooldownWait(poolId: string): number | undefined {
    const until = this.poolCoolingUntil(poolId);
    if (until === undefined) return undefined;
    return Math.max(0, until - this.now());
  }

  private modelAllowed(account: AccountConfig, model: string | undefined): boolean {
    if (!model) return true;
    if (this.isModelBlocked(account, model)) return false;
    if (account.models && account.models.length > 0 && !account.models.includes(model)) return false;
    return true;
  }

  private someAccountServesModel(options: ExecuteOptions): boolean {
    return this.config.accounts.some((account) => {
      if (options.poolId && account.poolId !== options.poolId) return false;
      return this.modelAllowed(account, options.model);
    });
  }

  private assertModelAllowed(account: AccountConfig, model: string | undefined): void {
    if (!this.modelAllowed(account, model)) {
      throw this.modelNotAllowedError(account, model, undefined, undefined);
    }
  }

  private modelNotAllowedError(
    account: AccountConfig,
    model: string | undefined,
    httpStatus: number | undefined,
    raw: unknown,
  ): AgnesCliError {
    return new AgnesCliError(
      "MODEL_NOT_ALLOWED",
      `Account "${account.id}" cannot serve model "${model ?? "(unspecified)"}"${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`,
      { accountId: account.id, poolId: account.poolId, model, httpStatus, raw },
    );
  }

  private isModelBlocked(account: AccountConfig, model: string): boolean {
    return this.modelBlocked.get(account.id)?.has(model) ?? false;
  }

  private isModelBlockedAll(account: AccountConfig): boolean {
    const blocked = this.modelBlocked.get(account.id);
    return blocked !== undefined && account.models !== undefined && account.models.length > 0 && blocked.size >= account.models.length;
  }

  private markModelBlocked(account: AccountConfig, model: string | undefined): void {
    if (!model) return;
    const blocked = this.modelBlocked.get(account.id) ?? new Set<string>();
    blocked.add(model);
    this.modelBlocked.set(account.id, blocked);
  }

  private bindSuccessAffinity(options: ExecuteOptions, account: AccountConfig): void {
    if (!options.affinityKey) return;
    this.bindAffinity(options.affinityKey, account.id, {
      ...(options.model ? { model: options.model } : {}),
      kind: options.workload,
    });
  }

  private routeResult<T>(value: T, account: AccountConfig, state: AttemptState): RouteResult<T> {
    return {
      value,
      accountId: account.id,
      poolId: account.poolId,
      attempts: state.attempts,
      waitedMs: state.waitedMs,
      fallback: state.attempts > 1,
    };
  }

  private ambiguousCreate(
    account: AccountConfig,
    options: ExecuteOptions,
    error: unknown,
    httpStatus?: number,
    raw?: unknown,
  ): AgnesCliError {
    return new AgnesCliError(
      "AMBIGUOUS_CREATE",
      `Agnes create request on account "${account.id}" may have been accepted but the response failed. ` +
        "Not retrying to avoid a duplicate billable task; check the account dashboard before retrying.",
      {
        accountId: account.id,
        poolId: account.poolId,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(error !== undefined ? { cause: underlyingCause(error) } : {}),
        ...(raw !== undefined ? { raw } : {}),
      },
    );
  }

  private isNetworkError(error: unknown): boolean {
    return error instanceof AgnesCliError && error.code === "NETWORK_ERROR";
  }

  private ensureBudget(
    waitMs: number,
    deadline: number,
    state: AttemptState,
    options?: ExecuteOptions,
    account?: AccountConfig,
    lastError?: AgnesCliError,
  ): void {
    const remaining = deadline - this.now();
    if (waitMs > remaining || remaining <= 0) {
      throw new AgnesCliError(
        "RATE_LIMITED",
        lastError instanceof AgnesCliError
          ? lastError.message
          : `Agnes request would have to wait ${Math.max(0, Math.ceil(waitMs))} ms for capacity, beyond the configured wait budget.`,
        {
          retryAfterMs: Math.max(0, Math.ceil(waitMs)),
          ...(options?.accountId ? { accountId: options.accountId } : {}),
          ...(account ? { accountId: account.id, poolId: account.poolId } : {}),
          ...(options?.workload ? { workload: options.workload } : {}),
          accountsTried: [...state.triedAccountIds],
        },
      );
    }
  }

  private remainingBudget(deadline: number): number {
    return Math.max(0, deadline - this.now());
  }

  private async wait(ms: number, state: AttemptState): Promise<void> {
    if (ms <= 0) return;
    await this.sleep(ms);
    state.waitedMs += ms;
  }

  /** Raw transport used by the built-in probe. */
  private async request(account: AccountConfig, url: string, init: RequestInit): Promise<{ response: Response; raw: unknown }> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${account.key}`, ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let raw: unknown = null;
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
    }
    return { response, raw };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeModelAccess(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  let text: string;
  try {
    text = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return false;
  }
  if (!/model/i.test(text)) return false;
  return /access|allowed|permission|not\s*supported|forbidden|model_not/i.test(text);
}

function looksLikeTaskMissing(raw: unknown): boolean {
  const text = typeof raw === "string" ? raw : raw === undefined ? "" : safeStringify(raw);
  return /task[_\s-]?not[_\s-]?exist|task\s+not\s+found|not\s+found/i.test(text);
}

function underlyingCause(error: unknown): string {
  if (error instanceof AgnesCliError) {
    const details = error.details;
    if (details && typeof details === "object" && "cause" in details) {
      const cause = (details as Record<string, unknown>).cause;
      if (typeof cause === "string" && cause) return cause;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
