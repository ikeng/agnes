# Multi-account routing & batch production — design contract (v1)

- **Status:** approved design for implementation (Lead), 2026-10-23.
- **Depends on:** `docs/multi-account-research.md` (limits, 429 behavior, affinity evidence).
- **Scope:** patched CLI in `cli/`, repo scripts/docs/tests. No changes to the remote API contract.
- **Non-negotiable safety rules:** never print/store API keys outside the existing 600-mode env
  file; never retry ambiguous POSTs; never rotate the account for a video status lookup; never
  silently change model or request parameters.

## 1. Goals / non-goals

Goals:

1. **Multi-account pools.** Configure several Agnes API keys, grouped into limit pools
   (`free` / `enterprise` / `tokenplan` key types; keys of the same account+type share one pool).
2. **Automatic routing / load balancing.** Per-request account selection with adaptive pacing,
   429 cooldowns, safe failover, and per-pool/per-account concurrency limits, so a batch no longer
   dies on concurrent 429s.
3. **Context & consistency.** Create→poll affinity, sticky session affinity, batch-level
   provenance, deterministic output order, resumable manifests, and a strict single-account
   consistency mode.
4. **Batch production.** `agnes batch run/status/retry` with JSON/JSONL jobs, bounded
   concurrency, per-job isolation, resume without duplicate creates, and rate-limit-aware
   scheduling.
5. **Backward compatibility.** A single `AGNES_API_KEY` keeps working exactly as before; the JS
   API stays file-free.

Non-goals:

- No server-side queue, no changing upstream billing/idempotency semantics.
- No automatic discovery of which account a key belongs to (impossible with the public API);
  operators group keys with `pool`.
- No image/video download pipeline; batch results record URLs.
- No cross-process millisecond-accurate rate coordination; the batch runner is the supported
  high-concurrency path (documented limitation).

## 2. Configuration contract

### 2.1 Legacy mode (unchanged)

`AGNES_API_KEY=sk-...` (or `createAgnesClient({ apiKey })`) becomes one implicit account:
`id=default`, `type=free`, `poolId=default`, `weight=1`, `priority=0`, strategy `primary`.
Output and behavior stay as in 0.2.x, except JSON results gain `accountId`/`routing` fields.

### 2.2 Environment multi-account mode

If any `AGNES_ACCOUNT_<ID>_KEY` exists (or `AGNES_ACCOUNTS` is set), legacy `AGNES_API_KEY` is
ignored for routing (a warning is emitted if both are present). `<ID>` matches
`[A-Z0-9]{1,32}`; the public id is lowercased.

```ini
AGNES_ACCOUNTS=main,backup                 # optional order; default sorted ids
AGNES_ACCOUNT_MAIN_KEY=sk-...
AGNES_ACCOUNT_MAIN_TYPE=free               # free | enterprise | tokenplan (default free)
AGNES_ACCOUNT_MAIN_POOL=acct-main          # default: account id; keys sharing one account+type MUST share a pool
AGNES_ACCOUNT_MAIN_WEIGHT=1                # default 1, positive integer
AGNES_ACCOUNT_MAIN_PRIORITY=0              # default 0, lower is preferred by `primary`
AGNES_ACCOUNT_MAIN_CONCURRENCY=           # optional override, else type preset
AGNES_ACCOUNT_MAIN_MODELS=agnes-image-2.5-flash,agnes-video-2.5   # optional allowlist
AGNES_ACCOUNT_MAIN_BASE_URL=              # optional per-account gateway
AGNES_ACCOUNT_MAIN_LABEL=                 # optional display label
```

Global routing env:

```ini
AGNES_ROUTING_STRATEGY=adaptive            # adaptive | round-robin | weighted | least-inflight | primary
AGNES_ROUTING_MAX_ATTEMPTS=3               # per request, across eligible pools
AGNES_ROUTING_MAX_WAIT_MS=60000            # max time a single request may wait for capacity/cooldown
AGNES_RATE_LIMIT=on                        # on|off (client-side pacing; default on for CLI)
AGNES_STATE_DIR=~/.agnes/state             # affinity journal + router state (dir 0700, files 0600)
AGNES_POLL_INTERVAL_MS=2000                # initial status poll pacing floor
AGNES_POLL_TIMEOUT_MS=600000               # default poll budget
```

### 2.3 Accounts file mode (optional, for many accounts / no secret in env)

`AGNES_ACCOUNTS_FILE=/path/accounts.json` (explicit path only; not searched automatically).
Precedence: explicit file > indexed env > legacy `AGNES_API_KEY`. The file is JSON:

```json
{
  "version": 1,
  "strategy": "adaptive",
  "rateLimit": true,
  "maxAttempts": 3,
  "maxWaitMs": 60000,
  "accounts": [
    {
      "id": "main",
      "key": "sk-...",
      "keyEnv": "AGNES_ACCOUNT_MAIN_KEY",
      "type": "free",
      "pool": "acct-main",
      "weight": 1,
      "priority": 0,
      "concurrency": 1,
      "models": ["agnes-image-2.5-flash"],
      "baseUrl": "https://apihub.agnes-ai.com/v1",
      "label": "Main free account"
    }
  ]
}
```

- `key` or `keyEnv` is required per account; `key` wins.
- `id` is `[a-z0-9_-]{1,32}`, unique. Unknown fields are a hard error.
- If the file is readable by group/other, print a warning to stderr (not a fatal error) unless
  `AGNES_ACCOUNTS_ALLOW_INSECURE=1`.
- Validation errors: `INVALID_ACCOUNTS_CONFIG`, exit 2.

### 2.4 CLI flags (all commands)

```
agnes [--account <id>] [--strategy <strategy>] <command>
```

- `--account` forces one account (still subject to pacing/cooldown; no failover unless the
  request is rejected with 429/401/402/403 and another account is eligible — for forced account
  we do **not** fail over; fail with a clear error instead).
- `--strategy` overrides the configured strategy for this invocation.
- Existing flags are unchanged.

New command groups:

```
agnes accounts list [--json]
agnes accounts check [--live] [--json]
agnes batch run <file> --out <dir> [options]
agnes batch status <dir> [--json]
agnes batch retry <dir> [--only failed|pending|all] [options]
```

## 3. Core data model / interfaces (implementation contract)

New directory `cli/src/accounts/`:

```ts
export type AccountType = "free" | "enterprise" | "tokenplan";
export type RoutingStrategy = "adaptive" | "round-robin" | "weighted" | "least-inflight" | "primary";
export type WorkloadClass = "text" | "image" | "video" | "status";

export interface AccountConfig {
  id: string;
  key: string;                 // never exported/logged
  keySource: string;           // "AGNES_API_KEY" | "AGNES_ACCOUNT_MAIN_KEY" | "accounts-file" | "options"
  type: AccountType;
  poolId: string;
  weight: number;
  priority: number;
  concurrency?: number;
  models?: readonly string[];
  baseUrl?: string;
  label?: string;
}

export interface AccountsConfig {
  accounts: AccountConfig[];
  pools: string[];
  strategy: RoutingStrategy;
  maxAttempts: number;
  maxWaitMs: number;
  rateLimitEnabled: boolean;
  stateDir: string;
  source: "legacy" | "env" | "file" | "options";
  warnings: string[];
}

export interface RouteOptions {
  accountId?: string;     // force account
  poolId?: string;        // force pool (batch strict)
  affinityKey?: string;   // sticky account/session/resource key
  strategy?: RoutingStrategy;
  workload?: WorkloadClass;
  model?: string;
}

export interface RouteResult<T> {
  value: T;
  accountId: string;
  poolId: string;
  attempts: number;
  waitedMs: number;
  fallback: boolean;
}

export interface AffinityEntry {
  accountId: string;
  poolId: string;
  model?: string;
  kind?: string;
  createdAt: number;
  updatedAt: number;
}
```

`loadAccountsConfig(env, overrides?)` (config.ts) resolves/validates the configuration.
`accountsSummary(config)` returns a redacted JSON-safe description (key shown only as
`present (len=N)` / `missing`, never the value).

Router (router.ts):

```ts
export interface RouterRuntime {
  fetchImpl: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export class AccountRouter {
  readonly config: AccountsConfig;
  constructor(config: AccountsConfig, runtime: RouterRuntime);

  /** Pick an account without acquiring capacity (batch strict pin). */
  select(options: { workload: WorkloadClass; model?: string; excludeAccountIds?: string[] }): AccountConfig | undefined;

  /**
   * Execute one logical request with pacing/failover.
   * `send` performs the transport call for the given account and returns { response, raw }.
   * The router classifies statuses; it returns non-handled failures (400/404/422/…) to the
   * caller so domain code keeps its current error messages.
   */
  execute<T extends { response: Response; raw: unknown }>(
    options: RouteOptions & {
      method: "GET" | "POST";
      maxAttempts?: number;
      maxWaitMs?: number;
      deadlineMs?: number;      // for status polling loops
    },
    send: (account: AccountConfig) => Promise<T>,
  ): Promise<RouteResult<T>>;

  bindAffinity(key: string, accountId: string, meta?: { model?: string; kind?: string }): void;
  getAffinity(key: string): AffinityEntry | undefined;
  /** Probe accounts in configured order for a resource id when no affinity exists. */
  probeAffinity(idCandidates: string[], options: { model?: string; workload: "status" }):
    Promise<{ account: AccountConfig; entry: AffinityEntry } | undefined>;
  summary(): RouterSummary; // redacted state for accounts list/JSON
}

export interface RouterSummary {
  strategy: RoutingStrategy;
  rateLimitEnabled: boolean;
  accounts: Array<{
    id: string; type: AccountType; poolId: string; weight: number; priority: number;
    concurrency: number;
    models?: string[];
    healthy: boolean;
    coolingUntil?: number;
    inflight: number;
  }>;
  pools: Array<{ id: string; coolingUntil?: number; inflight: number }>;
  warnings: string[];
}
```

Transport helpers (http/requestJson.ts): keep current retry semantics; add
`parseRetryAfterMs(response: Response): number | undefined` (numeric seconds or HTTP date) and
`isRetryableStatus(status)`.

Limit presets / pacing (limits.ts):

| workload | free | enterprise | tokenplan |
| --- | ---: | ---: | ---: |
| text | 10 | 20 | 1000 |
| image 1K | 10 | 40 | 100 |
| image 2K | 5 | 20 | 80 |
| image 3K | 1 | 1 | 1 |
| image 4K | 1 | 1 | 1 |
| video (create) | 1 | 2 | 5 |
| status (per pool, serialized) | adaptive: start 2000 ms gap, ×2 after 429, ×0.9 every 20 successes, floor 1000 ms, cap 30 s |

- Create workloads: token bucket per **pool**, capacity `max(1, rpm)`, refill `rpm/60000` per ms.
- `status`: at most 1 in-flight status request per pool; paced by the adaptive gap above; on 429
  `gap = max(gap * 2, retryAfterMs)`, cap 30 s. No token bucket (observed status GET is a
  lightweight endpoint with its own `Retry-After`).
- Per-account concurrency defaults: free text 2 / image 1 / video 1; enterprise 4/2/2;
  tokenplan 8/4/4. Account config `concurrency` overrides the class maximum for that account.
- `image` workload class maps to the tier bucket from the effective `size` (`1K/2K/3K/4K`;
  exact sizes map to the nearest tier by longest edge: ≤1024→1K, ≤2048→2K, ≤3072→3K, else 4K).
- `rateLimitEnabled=false` bypasses buckets/pacers (still records cooldowns).

Router behavior matrix:

| Condition | POST create | GET status (affinity-bound) |
| --- | --- | --- |
| 2xx | success, bind affinity, release | success |
| 429 | cool **pool** (Retry-After or exponential 1s→2s→4s…+jitter, cap 30s); immediately retry another eligible account if attempts left (a 429 is a pre-execution rejection, so rerouting is safe — do **not** wait for the pool cooldown when another pool is available); if no other pool is eligible, wait the earliest cooldown within `maxWaitMs` then retry; else `RATE_LIMITED` | never rotate account; wait `max(retryAfter, adaptive gap)` and retry the same account until `deadlineMs`/attempts; else `RATE_LIMITED` |
| 401 / 403 auth | mark account unhealthy; failover (request rejected) | fail `ACCOUNT_AUTH_FAILED` |
| 402 quota | mark pool depleted; failover | fail `QUOTA_EXHAUSTED` |
| 403 model access | mark account model-blocked; failover | fail `MODEL_NOT_ALLOWED` |
| 5xx / network timeout | **no auto-retry**; `AMBIGUOUS_CREATE` (may have been accepted/billed) | retry same account with backoff until deadline |
| 400 / 404 / 422 | return to caller (no failover) | return to caller |

Additional rules:

- Forced `--account` disables failover; the error names the account and code.
- `maxAttempts` counts total sends (default 3). `maxWaitMs` bounds any pacing/cooldown wait inside
  one request; exceeding it fails with the underlying code plus `retryAfterMs`/`accountsTried`.
- Never include keys in errors/details; include account ids only.
- A pool is cooling until its max cooldown; `select`/routing skip cooling pools for create
  workloads and serialize status requests with the pacer.
- 429 cooldowns are shared by the pool (account-level limit evidence).

Affinity journal (affinity.ts):

- `$AGNES_STATE_DIR/affinity.json` (default `~/.agnes/state/affinity.json`), directory `0700`,
  file `0600`, atomic write (tmp + rename), merge-on-write to survive concurrent CLI processes.
- Entry TTL 7 days; max 5000 entries (evict oldest). Never contains keys.
- Keys used by the CLI:
  - `video:<videoId>` and `task:<taskId>` bound automatically after a successful video create.
  - `session:<name>` bound by `--affinity <name>` on text/image/video create; subsequent calls with
    the same key resolve to the same account. `--affinity` never overrides an explicit `--account`
    error; explicit account wins and re-binds only after success.
  - `batch:<batchId>:<jobId>` bound by the batch runner; reused on resume.
- `video get/poll` resolution order: explicit `--account` → journal (`video:` then `task:`) →
  single account → bounded probe in configured account order (max `min(3, accounts)` probes,
  stopping at the first non-404; 429 respects Retry-After). All-404 ⇒ `AFFINITY_NOT_FOUND` with
  `--account` guidance.

## 4. Command/module integration

- `cli/src/config.ts`: `ResolvedConfig` gains `accountsConfig: AccountsConfig` and
  `router: AccountRouter`. `resolveConfig` builds a router (reuses `config.router` when given so
  one `createAgnesClient()` keeps one stateful router). `apiKey` remains populated (first/legacy
  account) for compatibility; `env` remains.
- `createAgnesClient(config)` resolves once and closes over the router; all client methods use it.
  A plain `createAgnesClient({ apiKey, fetchImpl })` keeps raw behavior
  (`rateLimitEnabled=false`) unless `rateLimit: true`/accounts are configured.
- `text/complete.ts`, `image/generateImage.ts`, `video/generateVideo.ts`: replace direct
  `apiKey` fetch with `router.execute(..., send)`; add `route?: RouteOptions` to the zod option
  schemas; add `accountId`, `poolId`, `routing` to results. Build URLs from
  `account.baseUrl ?? resolved.baseUrl`; body construction stays account-independent.
- `video/getVideo.ts`, `video/pollVideo.ts`: resolve affinity first; use `router.execute` with
  `workload: "status"`, `method: "GET"`; never fail over. `pollVideo` respects the pacer (no
  tight loop on 429), default interval 5 s unchanged but floor `AGNES_POLL_INTERVAL_MS` applies to
  status; add `accountId`/`routing` to results.
- `auth/check.ts`: keep `{ok, configured, source}`; add `accounts: number`, `pools: string[]`,
  `strategy`. `source` becomes `env|file|options|missing`.
- `cli.ts`: add global `--account`/`--strategy`; register `accounts` and `batch` groups; pass
  `route` (from `command.optsWithGlobals()`) into client calls; add `--affinity <key>` to
  text/image/video create commands; human output adds an `account: <id>` line only when more than
  one account is configured; JSON outputs always include routing fields.
- `index.ts`: export new types/classes and keep existing exports.
- Add `parseRetryAfterMs`; no changes to the existing POST no-retry rule.
- Version: `cli/package.json` → `0.3.0-local.1` (single source; `--version` reads it).
- Patch file `patches/cli-local.patch` is regenerated by the Lead after implementation.

## 5. `accounts` command contract

`agnes accounts list [--json]`: redacted config; human lines:

```text
strategy: adaptive   rateLimit: on
main    type=free         pool=acct-main     weight=1 priority=0 concurrency=2 key=present (len=51) source=env
backup  type=tokenplan    pool=acct-backup   weight=2 priority=0 concurrency=8 key=present (len=51) source=env
warnings: 1
  - main and backup have no explicit pool; if they are keys of the same account, set pool= to group them
```

JSON: `{ok:true, strategy, rateLimit, source, stateDir, pools, accounts:[...redacted...], warnings}`.
No key material, ever.

`agnes accounts check [--live] [--probe models|text] [--json]`:

- Always validates config and prints per-account presence/type/pool.
- Bare `accounts check` validates config only; explicit `--probe <mode>` implies `--live`
  (unknown mode -> exit 2 `INVALID_PROBE`).
- `--live --probe models` (default) calls `GET {baseUrl}/models` per account (bounded
  concurrency 2; no additional pacer — the endpoint is cheap) and reports `{accountId, probe:"models", ok, reachable, credentialValidated:false,
  httpStatus, modelCount, missingConfiguredModels[], error?}`. It emits the warning
  "GET /v1/models is reachable without a valid credential on the real gateway; use
  `--probe text` to prove account access" (human stderr + `warnings[]`). Exit 1 only on
  unreachable/error.
- `--live --probe text` sends exactly ONE minimal chat completion per account
  (`max_tokens:1`, prompt "ping", model from the account's `models` allowlist or
  `DEFAULT_TEXT_MODEL`) directly to that account's gateway, reports
  `{accountId, probe:"text", ok, credentialValidated:true|false, httpStatus, error?}` and exits 1
  if any account is rejected. This is the only reliable credential check; it consumes a tiny
  amount of text quota (documented).
- Neither probe sends image/video generation requests. Keys are always redacted.

## 6. Batch production contract

### 6.1 Input

`agnes batch run <file.json|file.jsonl> --out <dir> [flags]`

JSON object form:

```json
{
  "version": 1,
  "batchId": "ui-icons-v1",
  "consistency": "record",
  "defaults": {
    "model": "agnes-image-2.5-flash",
    "size": "1K",
    "ratio": "1:1",
    "ttl": "1h"
  },
  "jobs": [
    {"id": "icon-001", "kind": "image", "mode": "text2img", "prompt": "..."},
    {"id": "icon-002", "kind": "image", "mode": "img2img", "image": "./src/a.png", "prompt": "..."},
    {"id": "clip-001", "kind": "video", "mode": "text2video", "prompt": "...", "seconds": 5, "size": "720P"},
    {"id": "copy-001", "kind": "text", "mode": "chat", "prompt": "..."}
  ]
}
```

JSONL form: one job object per line (no wrapper); defaults come from CLI flags
`--model/--size/--ratio/--seconds/--ttl`.

Job schema (strict, unknown keys rejected):

- `id`: `[A-Za-z0-9._-]{1,64}`, required, unique.
- `kind`: `image|video|text`; `mode`: image `text2img|img2img|compose`; video
  `text2video|img2video|multivideo|keyframes`; text `chat`. `mode` may be omitted for
  `kind=text` (defaults to chat) and must match `kind` otherwise.
- Pass-through generation params exactly as the corresponding CLI command accepts:
  `prompt` (required), `model`, `size`, `ratio`, `seconds`, `aspectRatio`, `seed`, `n`, `ttl`,
  `image`/`images` (paths or URLs; local paths use the existing media bridge).
- `affinity`: optional string; default `batch:<batchId>:<jobId>`.
- `metadata`: optional JSON object ≤4 KB, copied to the result (context/provenance for pipelines).
- `defaults` may contain the same generation params (never `id`, `kind`, `mode`, `image(s)`,
  `affinity`, `metadata`). Flat defaults are **kind-aware**: a flat `model` applies only when it
  belongs to the job kind's catalog (image/video/text), otherwise the kind's built-in default is
  used; other params are filtered to kinds that support them (e.g. an exact image `size` never
  reaches a video job, while `1K` is valid for video).
- Optional `defaultsByKind: {image?, video?, text?}` overrides flat defaults per kind.
  Merge order: **job > defaultsByKind[kind] > flat defaults (kind-compatible) > built-in kind
  default**. Every manifest/input.json job records its effective `model` and
  `modelSource: "job" | "defaults" | "kind-default"` for provenance.
- Per-job validation failures (zod `INVALID_*` errors) are non-retryable `INVALID_JOB` errors whose
  message is prefixed with the job id; they never trigger a retry (no duplicate creates).
- `consistency`: `record` (default) or `strict`.
- `batchId`: default `batch-<YYYYMMDD>-<HHmmss>-<rand4>`.

Flags:

```
--out <dir>                 required
--concurrency <n>           default 4 (bounded by router capacity)
--consistency <mode>        override input
--strategy <name>           override
--account <id>              force one account for the whole batch (implies strict)
--max-attempts <n>          job-level retries for retryable failures (default 2)
--poll-interval <ms>        video poll interval floor (default AGNES_POLL_INTERVAL_MS/5000)
--poll-timeout <ms>         video poll budget (default 600000)
--resume                    resume an existing out dir (manifest required)
--force                     allow using a non-empty out dir without --resume
--fail-fast                 stop scheduling new jobs after the first failure
--dry-run                   validate + print the plan, no requests
--json                      final summary only on stdout; progress on stderr
```

### 6.2 Manifest / artifacts

`<out>/manifest.json` (`0600` when it can contain prompts; no keys ever):

```json
{
  "schema": "agnes-batch/1",
  "version": 1,
  "batchId": "...",
  "createdAt": "...", "updatedAt": "...",
  "input": {"path": "...", "sha256": "..."},
  "config": {
    "consistency": "record", "strategy": "adaptive", "concurrency": 4,
    "defaults": {...}, "defaultsDigest": "sha256:...",
    "maxAttempts": 2, "pollIntervalMs": 5000, "pollTimeoutMs": 600000
  },
  "pinnedAccountId": "main",           // strict only
  "jobs": [
    {
      "index": 0, "id": "icon-001", "kind": "image", "mode": "text2img",
      "inputHash": "sha256:...", "status": "succeeded",
      "accountId": "main", "poolId": "acct-main", "attempts": 1,
      "startedAt": "...", "finishedAt": "...",
      "result": {"url": "...", "model": "...", "accountId": "main", "routing": {...}},
      "error": null
    }
  ],
  "summary": {"total": 4, "succeeded": 4, "failed": 0, "pending": 0, "skipped": 0,
              "mixedAccounts": false, "accountsUsed": ["main"], "elapsedMs": 1234}
}
```

- Written atomically after every job state change (`tmp` + rename). Per-job result also written
  to `<out>/results/<id>.json` for pipelines.
- Progress events appended to `<out>/events.jsonl` (`job_started`, `job_succeeded`, `job_failed`,
  `job_retry`, `batch_started`, `batch_finished`) — no prompts/keys unless the prompt is part of
  the job? Prompts are allowed (they are user content) but keys/labels never.
- `<out>/input.json` is the authoritative normalized input (it includes the
  `defaultsByKind` sections, effective per-job values, `model`/`modelSource`); `manifest.config`
  records the flat defaults + digest used for the compatibility check. A change to
  `defaultsByKind` that would alter a job is caught by that job's `inputHash`
  (`BATCH_INPUT_CHANGED`), so resume/retry never silently changes effective parameters.
- Output order in `manifest.jobs` is always input order; `summary.accountsUsed` sorted.
- `mixedAccounts=true` when a `record` batch used more than one pool/account (warning line).

### 6.3 Scheduling / consistency semantics

- `record`: router picks per create; each job's account/pool recorded; video jobs poll on the
  same account; batch-level model/params are locked by `defaults` (job overrides are recorded).
- `strict`: at batch start, select one account via `router.select` (priority, then strategy;
  `--account` forces it); all jobs are pinned to that account; video polls stay there; on 429 the
  job waits for that pool's cooldown (bounded by job timeout/attempts); on 401/402/403 the batch
  fails with a clear "strict consistency cannot be satisfied" error; no failover.
- `--account` on any batch implies strict.
- Concurrency is bounded by `--concurrency`, and additionally by router per-account/pool limits.
- Retryable job failures: `RATE_LIMITED`, `NETWORK_ERROR` (GET), `SERVICE_BUSY`, `POLL_TIMEOUT`
  → job retry up to `--max-attempts` with exponential backoff + jitter.
  Non-retryable: `AMBIGUOUS_CREATE` (never auto-retry a create; mark failed with
  `ambiguous: true` and guidance), `INVALID_*`, `AUTH_*`, `QUOTA_*`, `MODEL_*`.
- Job failure (after retries) records error and continues unless `--fail-fast`.
- Exit code: 0 all succeeded/skipped; 1 any failed; 2 invalid input/config.
- `--dry-run`: validates jobs/defaults/hash, selects strict account if requested, prints plan JSON
  (`{ok:true, batchId, jobs, routePlan}`), writes nothing.

### 6.4 Resume / retry

- `--resume`: load existing manifest, require identical `batchId`, input path hash, defaults
  digest, consistency and strategy; each job:
  - `succeeded`/`skipped` → skip; if the recomputed `inputHash` differs → abort with
    `BATCH_INPUT_CHANGED`.
  - `failed`/`pending`/`running` → rerun (running means an interrupted process; record
    `recoveredFrom: "running"`; creates may be ambiguous — print a warning).
  - `unknown job id` in the new input → treat as new job appended in input order; jobs removed
    from input are kept as `skipped` with `reason: "removed_from_input"`.
- `batch retry <dir> [--only failed|pending|all]`: rerun stored jobs from the manifest/input copy
  (`<out>/input.json` is saved on first run); default `failed`; same consistency/account pins
  from the manifest; never re-runs succeeded jobs.
- `batch status <dir> [--json]`: print summary + per-job status/account/result URL; exit 0 always
  unless the manifest is missing/invalid (exit 2).
- The batch runner saves the normalized input to `<out>/input.json` on first run (600) so retry
  works if the original file moves.

## 7. Backward compatibility & security

- Existing CLI commands/flags/output keep working; single-account JSON gains fields, human output
  unchanged unless >1 account.
- JS API `createAgnesClient` remains file-free (no env/state reads unless `stateDir` given?
  affinity state dir defaults to `AGNES_STATE_DIR`/`~/.agnes/state` only when routing needs it;
  plain `apiKey` clients disable affinity persistence unless `affinityStateDir` is set).
- Keys only in `.env.local` (existing 600) or an explicitly configured accounts file; `.gitignore`
  gains the accounts file pattern; state dir is outside the repo by default.
- Manifests/events/JSON/errors contain no keys; account `key` never serialized — enforced by
  `accountsSummary` and tests scanning outputs for `sk-`.
- File permissions: state dir `0700`, files `0600`; warn on insecure accounts file mode.

## 8. Acceptance criteria

**AC1 Compatibility** — all pre-existing suites pass (CLI 74/74 baseline; repo 12 suites; the
pre-existing `install-roundtrip` real-state assertion is repaired to accept the machine's current
`absent models-present` state without weakening the round-trip checks).

**AC2 Config** — legacy env, indexed env, and accounts-file modes parse; precedence and pool
validation correct; secrets redacted; invalid config exits 2 with `INVALID_ACCOUNTS_CONFIG`.

**AC3 Routing** — round-robin/weighted/least-inflight/adaptive/primary distribution verified
against a fake server; forced `--account`; model capability filter; pool cooldown shared.

**AC4 Rate limits** — documented presets applied; text/image/video create pacing avoids bursting
past the bucket; 429 honors `Retry-After`, cools the pool, failover works for create and never
for status; ambiguous POST returns `AMBIGUOUS_CREATE` without duplicate sends; max-wait/attempts
honored.

**AC5 Affinity** — video create binds `video:`/`task:` entries; `video poll` uses the same
account even when another account is round-robin-first; journal survives across CLI processes;
missing journal with multiple accounts probes accounts and succeeds without cross-account
polling after resolution; `--account` override works.

**AC6 Batch** — JSON/JSONL input; defaults merge; deterministic input order; bounded
concurrency; manifest/results/events; resume skips succeeded jobs with zero new creates (server
request counts); input-change abort; strict mode uses one account for all creates and polls;
record mode distributes and sets `mixedAccounts`; `--dry-run` sends nothing; exit codes correct.

**AC7 Security** — `sk-` scan over all generated artifacts/output is clean; state files 0600;
`.gitignore` updated; no key in new docs/tests except allowlisted fake fixtures.

**AC8 Live** — `agnes accounts check --live --probe text` proves the real credential with one
minimal chat completion per account (the models-only probe is documented as reachability-only
because `/v1/models` answers 200 for fabricated tokens); one routed text ping succeeds; a mixed
fake-key/real-key pool routes around the fake key (401) and completes on the real account; no live
image/video generation.

**AC9 Packaging** — `npm test` green; CLI build green; `patches/cli-local.patch` regenerated and
applies cleanly to upstream `v0.1.6` with a tree-identical `cli/`; version `0.3.0-local.1`;
README/CLI README/.env.example/skill/docs consistent.

**AC10 Independent verification** — verifier's own harness (outside the repo) passes the CLI
contract and the AC2–AC6 behaviors; verifier writes `docs/multi-account-verification.md` with
evidence and a PASS/FAIL verdict.
