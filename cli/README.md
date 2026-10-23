# agnes-ai-cli (patched local build)

CLI and JS API for Agnes text, image, and video workflows, including
multi-account routing and reproducible batch production.

This directory vendors [jomeswang/agnes-ai-cli](https://github.com/jomeswang/agnes-ai-cli)
v0.1.6 and applies the local model/API patches documented in
[`../README.md`](../README.md) and [`UPSTREAM.md`](./UPSTREAM.md). It is the
source of truth for the `agnes` binary installed by this repo.
**Current patched version: `0.3.0-local.1`** (2026-10 multi-account routing +
`agnes batch`; design contract: [`../docs/multi-account-design.md`](../docs/multi-account-design.md),
evidence: [`../docs/multi-account-research.md`](../docs/multi-account-research.md)).

## Model defaults

| Workflow | Default model | Notes |
| --- | --- | --- |
| Text | `agnes-2.5-flash` | `agnes-2.0-flash` is deprecated upstream; `agnes-3.0-flash`, `agnes-2.5-pro`, `agnes-2.5-pro-beta` are selectable. |
| Image | `agnes-image-2.5-flash` | `agnes-image-2.1-flash` and `agnes-image-2.0-flash` remain available. |
| Video | `agnes-video-2.5` | `agnes-video-2.5-flash` available; `agnes-video-v2.0` was retired upstream on 2026-09-25. |

Run `agnes models` to print the live catalog.

## Configuration

The CLI reads the nearest `.env.local` (walking up from the current directory,
up to four parents) before running; variables already set in the shell win.
This repo keeps API keys in `.env.local` (gitignored, mode 600).

### Single account (legacy, fully supported)

`AGNES_API_KEY=sk-...` behaves exactly as in 0.2.x: one implicit account
`id=default`, `type=free`, `pool=default`, `weight=1`, `priority=0`, strategy
`primary`. Human output is unchanged and JSON results gain `accountId` /
`poolId` / `routing` fields.

### Multi-account pools

Agnes rate limits and quotas are shared **per key type**, not per key: creating
several keys of the same type on one account does not add capacity. Only
distinct accounts or distinct key types (`free` / `enterprise` / `tokenplan`)
are independent limit pools. A 429 is account/pool-level, so the router cools
down the whole pool instead of rotating one credential.

The CLI groups credentials with an explicit pool id (`pool=` / `_POOL=`). Keys
of the same account **must** share one pool, otherwise the client will pace them
as if they were independent pools. `agnes accounts list` warns when same-type
accounts have no explicit pool.

Indexed environment variables (ids match `[A-Z0-9]{1,32}` and are lowercased):

```ini
AGNES_ACCOUNTS=main,backup                 # optional order; default sorted ids
AGNES_ACCOUNT_MAIN_KEY=sk-your-key
AGNES_ACCOUNT_MAIN_TYPE=free               # free | enterprise | tokenplan (default free)
AGNES_ACCOUNT_MAIN_POOL=acct-main          # default: account id
AGNES_ACCOUNT_MAIN_WEIGHT=1                # positive integer, weighted strategy
AGNES_ACCOUNT_MAIN_PRIORITY=0              # integer, lower wins under primary
AGNES_ACCOUNT_MAIN_CONCURRENCY=2           # optional per-account in-flight cap
AGNES_ACCOUNT_MAIN_MODELS=agnes-image-2.5-flash,agnes-video-2.5
AGNES_ACCOUNT_MAIN_BASE_URL=https://apihub.agnes-ai.com/v1
AGNES_ACCOUNT_MAIN_LABEL=main-free
```

If any `AGNES_ACCOUNT_<ID>_*` variable is present (or `AGNES_ACCOUNTS_FILE` is
set), the single `AGNES_API_KEY` is ignored for routing and a warning is
printed. Unknown suffixes are a hard error (`INVALID_ACCOUNTS_CONFIG`, exit 2).

Accounts file (explicit path only, never auto-discovered):

```ini
AGNES_ACCOUNTS_FILE=/absolute/path/accounts.json
AGNES_ACCOUNTS_ALLOW_INSECURE=1            # optional: silence the mode warning
```

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
      "keyEnv": "AGNES_ACCOUNT_MAIN_KEY",
      "type": "free",
      "pool": "acct-main",
      "weight": 1,
      "priority": 0,
      "concurrency": 2,
      "models": ["agnes-image-2.5-flash", "agnes-video-2.5"],
      "baseUrl": "https://apihub.agnes-ai.com/v1",
      "label": "Main free account"
    },
    { "id": "backup", "key": "sk-your-key", "type": "tokenplan", "pool": "acct-backup", "weight": 2 }
  ]
}
```

- Each account needs `key` or `keyEnv`; `key` wins. Unknown fields are hard
  errors. `id` matches `[a-z0-9_-]{1,32}` and must be unique.
- Precedence: explicit JS API options > accounts file > indexed env >
  legacy `AGNES_API_KEY`.
- The file may contain keys, so `chmod 600` it. If it is readable by
  group/other the CLI prints a warning to stderr (not fatal);
  `AGNES_ACCOUNTS_ALLOW_INSECURE=1` silences it.
- `strategy`/`rateLimit`/`maxAttempts`/`maxWaitMs` in the file are defaults;
  environment variables and CLI flags can override them.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AGNES_API_KEY` | Single-account API key. Ignored when indexed accounts or an accounts file are configured. |
| `AGNES_ACCOUNTS` | Optional comma-separated account id order for indexed env accounts. |
| `AGNES_ACCOUNT_<ID>_KEY` | Required key for indexed account `<ID>`. |
| `AGNES_ACCOUNT_<ID>_TYPE` | `free` (default), `enterprise`, `tokenplan`. |
| `AGNES_ACCOUNT_<ID>_POOL` | Pool id; default account id. Same account + type keys must share a pool. |
| `AGNES_ACCOUNT_<ID>_WEIGHT` / `_PRIORITY` / `_CONCURRENCY` | Routing weight / priority / in-flight cap. |
| `AGNES_ACCOUNT_<ID>_MODELS` | Optional comma-separated model allowlist (capability filter). |
| `AGNES_ACCOUNT_<ID>_BASE_URL` / `_LABEL` | Optional per-account gateway / display label. |
| `AGNES_ACCOUNTS_FILE` | Explicit path to the accounts JSON file. |
| `AGNES_ACCOUNTS_ALLOW_INSECURE` | Set `1` to silence the insecure-file-mode warning. |
| `AGNES_ROUTING_STRATEGY` | `adaptive` (default for multi-account), `round-robin`, `weighted`, `least-inflight`, `primary`. |
| `AGNES_ROUTING_MAX_ATTEMPTS` | Sends per logical request (default `3`). |
| `AGNES_ROUTING_MAX_WAIT_MS` | Max wait for capacity/cooldown inside one request (default `60000`). |
| `AGNES_RATE_LIMIT` | `on` (default) or `off`; client-side token buckets and pacing. |
| `AGNES_STATE_DIR` | Affinity journal directory (default `~/.agnes/state`; dir 0700, files 0600). |
| `AGNES_POLL_INTERVAL_MS` | Status-poll pacing floor, default `2000`. |
| `AGNES_POLL_TIMEOUT_MS` | Default video poll budget for the JS API and `agnes batch` (default `600000`; `agnes video poll` keeps its own `--timeout` default of 600 s). |
| `AGNES_BASE_URL` | Gateway override, e.g. `https://api.agnes-ai.cn/v1` (China) or `https://apihub.agnes-ai.cn/v1` (alternate). |
| `AGNES_MEDIA_PROVIDER_ORDER` | Comma-separated temporary-upload order; this repo defaults to `uguu,x0,litterbox,tmpfiles` because Litterbox is blocked from this host. Allowed: `litterbox`, `tmpfiles`, `uguu`, `x0`. |
| `AGNES_HTTP_TIMEOUT_MS` | Per-request timeout in milliseconds (default `120000`). |
| `AGNES_ENV_FILE` | Load an explicit env file instead of searching for `.env.local`. |
| `AGNES_NO_DOTENV` | Set to `1` to disable `.env.local` autoloading (library use is always file-free). |

`agnes auth check` exits with status `1` when no key/account is configured,
which makes it usable in `if` statements and smoke scripts.
`agnes auth check --json` reports `{ok, configured, source, accounts, pools, strategy}`.

## Install (from this repo)

```bash
cd cli
npm install
npm run build
npm link   # exposes the patched `agnes` binary on PATH
```

From the repo root, `npm run setup` and `npm run install-local` wrap these steps
and also install the skill.

## CLI

### Global options

```bash
agnes [--account <id>] [--strategy <strategy>] <command>
```

- `--account <id>` forces one configured account for this invocation and
  disables failover (pacing/cooldowns still apply). Errors name the account;
  an unknown id fails with `ACCOUNT_NOT_FOUND` (exit 2).
- `--strategy <strategy>` overrides the configured strategy for this
  invocation: `adaptive`, `round-robin`, `weighted`, `least-inflight`,
  `primary` (invalid values fail with `INVALID_STRATEGY`, exit 2).

### Commands

```bash
agnes models
agnes auth check
agnes accounts list [--json]
agnes accounts check [--live] [--probe models|text] [--json]
agnes media url ./input.png

agnes text chat --prompt "say pong"
agnes text chat --model agnes-3.0-flash --prompt "write a TypeScript function"

agnes image text2img --prompt "a polished product photo of a perfume bottle" --size 2K --ratio 16:9
agnes image img2img --image ./input.png --prompt "turn this into a clean editorial poster"
agnes image compose --image ./a.png --image ./b.png --prompt "blend these references"

agnes video text2video --prompt "a cinematic drone shot of waves at dusk" --seconds 5 --size 720P
agnes video img2video --image ./frame.png --prompt "animate subtle rain and drifting fog"
agnes video multivideo --image ./frame-a.png --image ./frame-b.png --prompt "use both as references"
agnes video keyframes --image ./frame-a.png --image ./frame-b.png --prompt "morph between the two scenes"
agnes video get video_123 --model agnes-video-2.5
agnes video poll video_123 --model agnes-video-2.5

agnes batch run jobs.json --out ./out
agnes batch status ./out
agnes batch retry ./out --only failed
```

Local media inputs are uploaded to a temporary public URL automatically. The
default bridge tries Litterbox first, then falls back to tmpfiles, Uguu, and
x0.at.

Video creation is asynchronous. Create commands print `taskId`, `videoId`, the
model, and a ready-to-run `next: agnes video poll ... --model ...` hint; use
`videoId` with `agnes video poll`. Video 2.5 recommends
`video_id + model_name` for every mode and requires `model_name` for keyframe and
reference tasks, so pass `--model` when polling. Passing an older `taskId` still
uses the legacy `/videos/{task_id}` endpoint.

### Sticky sessions: `--affinity`

`text chat` and every image/video create command accept
`--affinity <name>` (repeat the same value to keep using one account):

```bash
agnes text chat --prompt "continue the outline" --affinity blog-session-42
agnes image text2img --prompt "same character, now smiling" --affinity char-001
```

This binds the journal key `session:<name>` to the chosen account; later calls
with the same name resolve to the same account even in a new process. An
explicit `--account` wins, and the session re-binds only after a successful
request. `video get` / `video poll` do not take `--affinity`; they use the
automatic `video:` / `task:` journal entries.

### Multi-account output

- Human-readable output is unchanged, except that when **more than one
  account** is configured a provenance notice `account: <id>` is printed to
  **stderr**. Stdout stays machine-readable/pipeline-safe. Single-account runs
  print no notice.
- Every generation/status JSON result gains `accountId`, `poolId`, and
  `routing: {strategy, attempts, waitedMs, fallback}`.
- `agnes accounts list --json` reports redacted accounts (key only as
  `present (len=N)` / `missing`), pools, strategy, rateLimit, stateDir,
  per-account `healthy` / `inflight` / `coolingUntil`, and warnings.

## `agnes accounts`

### `agnes accounts list [--json]`

Prints the redacted configuration. Keys are never printed: only
`present (len=N)` / `missing`, with the key source. Human example:

```text
strategy: adaptive   rateLimit: on
main     type=free       pool=acct-main     weight=1 priority=0 concurrency=2 key=present (len=51) source=AGNES_ACCOUNT_MAIN_KEY
backup   type=tokenplan  pool=acct-backup   weight=2 priority=0 concurrency=8 key=present (len=51) source=AGNES_ACCOUNT_BACKUP_KEY
warnings: 1
  - AGNES_API_KEY is ignored because AGNES_ACCOUNT_* accounts are configured.
```

JSON adds `ok`, `source`, `stateDir`, `maxAttempts`, `maxWaitMs`, and live
router state.

### `agnes accounts check [--live] [--probe models|text] [--json]`

Bare `check` validates the account configuration only (no network). `--live`
probes each account; an explicit `--probe <mode>` implies `--live`. Unknown
probe values exit `2` with `INVALID_PROBE` (JSON when `--json`). Neither probe
ever sends image/video generation requests.

| Invocation | What it does | Cost | Credential proof? |
| --- | --- | --- | --- |
| `accounts check` | Validate env/file config, redaction, pool grouping. | free | n/a |
| `accounts check --live` | Same as `--probe models` (default). `GET {baseUrl}/models` per account. | free | **No** |
| `accounts check --live --probe models` | Reachability of the gateway/models endpoint. | free | **No** |
| `accounts check --live --probe text` | One minimal chat completion per account. | one tiny text request per account | **Yes** |

`--probe models` (default for `--live`): at most two in flight, 15 s timeout.
Per-account output is
`{accountId, probe:"models", ok, reachable, credentialValidated:false, httpStatus?, modelCount?, missingConfiguredModels, error?}`;
top-level output has `probe:"models"` and a warning (in `warnings[]` and on
stderr):

```text
GET /v1/models is reachable without a valid credential on the real gateway; use --probe text to prove account access.
```

Human output says "models reachability only — NOT a credential proof". Exit `1`
only if an account/models endpoint is unreachable. **Do not treat this as key
validation:** the current gateway returns HTTP 200 for `/v1/models` even with a
fabricated token (verified 2026-10-23), so `--live` alone cannot prove a key is
valid.

`--probe text` (the only credential proof path): sends exactly one minimal chat
completion per account with `{model: <account's first configured model or the
default text model>, messages:[{role:"user",content:"ping"}], max_tokens:1}`,
30 s timeout, concurrency 2, no retries. A 2xx means `ok:true` /
`credentialValidated:true`; any non-2xx or network error means `ok:false` /
`credentialValidated:false` with `httpStatus`/`error`. Exit `1` if any account is
invalid. This costs one tiny text request per account.

```bash
agnes accounts check --live --probe text --json
```

```json
{
  "ok": true,
  "configured": true,
  "source": "env",
  "strategy": "adaptive",
  "pools": ["acct-main"],
  "live": true,
  "probe": "text",
  "accounts": [
    { "accountId": "main", "probe": "text", "ok": true, "credentialValidated": true, "httpStatus": 200, "model": "agnes-2.5-flash", "missingConfiguredModels": [] }
  ],
  "warnings": []
}
```

`missingConfiguredModels` (models probe) flags configured `MODELS` entries the
endpoint does not advertise. Probes validate credentials/reachability, not pool
membership (the public API does not expose which account a key belongs to).

## Routing, limits, and 429 behavior

Strategies (default `adaptive`; legacy single account defaults to `primary`):

| Strategy | Selection |
| --- | --- |
| `adaptive` | Least utilized account (`in-flight / concurrency`), ties round-robin. Default for multi-account. |
| `round-robin` | Rotate in configured order. |
| `weighted` | Smooth weighted round-robin by `WEIGHT`. |
| `least-inflight` | Lowest absolute in-flight count. |
| `primary` | Lowest `PRIORITY`, then configured order. |

Only eligible accounts are considered: model allowlist (`MODELS`/`models`),
unhealthy (401/403) accounts, and depleted (402) pools are skipped. Routing
never changes the model or request parameters.

Client-side RPM presets (from the official Token Plan docs; these are the only
defence because the text API exposes no rate-limit headers):

| Workload | free | enterprise | tokenplan |
| --- | ---: | ---: | ---: |
| text | 10 | 20 | 1000 |
| image 1K | 10 | 40 | 100 |
| image 2K | 5 | 20 | 80 |
| image 3K | 1 | 1 | 1 |
| image 4K | 1 | 1 | 1 |
| video (create) | 1 | 2 | 5 |

- Create workloads use one token bucket per pool (capacity `max(1, rpm)`,
  refill `rpm/60000` per ms).
- Status polls use at most one in-flight status request per pool with an
  adaptive gap: starts at 2000 ms, doubles on 429, recovers ×0.9 every 20
  successes, floor 1000 ms, cap 30 s.
- Per-account in-flight defaults: free text/image/video 2/1/1; enterprise
  4/2/2; tokenplan 8/4/4. `CONCURRENCY`/`concurrency` overrides the account cap.
- `AGNES_RATE_LIMIT=off` skips token buckets and status pacing but still
  enforces concurrency limits and cooldown waits (not recommended).
- `AGNES_ROUTING_MAX_ATTEMPTS` (default 3) bounds sends per logical request;
  `AGNES_ROUTING_MAX_WAIT_MS` (default 60000) bounds pacing/cooldown waits.

Failure handling:

| Condition | Create (POST) | Status (GET, affinity-bound) |
| --- | --- | --- |
| 2xx | success, bind affinity | success |
| 429 | cool the whole pool (`Retry-After`, else exponential 1s→2s→4s… + jitter, cap 30 s) and immediately try another eligible pool if attempts remain; if none, wait the earliest cooldown within `maxWaitMs`; else `RATE_LIMITED` | never rotate account; wait `max(Retry-After, adaptive gap)` and retry the same account until the deadline; else `RATE_LIMITED` |
| 401 / 403 | mark account unhealthy (or model-blocked for 403 model access), fail over | fail `ACCOUNT_AUTH_FAILED` |
| 402 | mark pool depleted, fail over | fail `QUOTA_EXHAUSTED` |
| 5xx / network error | **no auto-retry**, `AMBIGUOUS_CREATE` (may already be billed) | retry same account with backoff until deadline |
| 400 / 404 / 422 | returned to the caller, no failover | returned to the caller |

- `Retry-After` is honored when present (numeric seconds or HTTP date).
- A 429 is a pre-execution rejection, so re-routing a create to another pool is
  safe; an ambiguous POST response is not, hence `AMBIGUOUS_CREATE`.
- With a forced `--account`, failover is disabled; 429 waits on that pool's
  cooldown and errors name the account.

### Affinity journal (create → poll)

Async video resources are account-scoped: a `video_id` created with one
credential must be polled with the **same** account. The CLI persists this
context automatically:

- After a successful video create, `video:<videoId>` and `task:<taskId>` are
  bound to the creating account.
- `agnes video get/poll` resolve the owner in this order: explicit `--account` →
  journal (`video:` then `task:`) → the only configured account → bounded probe
  in configured order (max `min(3, accounts)` probes, stop at the first
  non-404, honor Retry-After). If everything is 404, it fails with
  `AFFINITY_NOT_FOUND` and suggests `--account`.
- `--affinity <name>` on create commands binds `session:<name>`; batch jobs use
  `batch:<batchId>:<jobId>`.
- Journal file: `$AGNES_STATE_DIR/affinity.json` (default
  `~/.agnes/state/affinity.json`), directory `0700`, file `0600`, atomic
  tmp+rename writes with merge-on-write (safe across concurrent CLI processes),
  TTL 7 days, max 5000 entries. It never contains key material.
- Cross-process/machine: the journal survives CLI invocations but not a wiped
  state dir; use `--account <id>` to recover a lost task deliberately.

## Batch production

`agnes batch` runs a job file through the same router, with bounded
concurrency, per-job isolation, deterministic output order, and resumable
artifacts.

### Input

`agnes batch run <file.json|file.jsonl> --out <dir>`

JSON object form:

```json
{
  "version": 1,
  "batchId": "ui-icons-v1",
  "consistency": "record",
  "defaults": { "ttl": "1h" },
  "defaultsByKind": {
    "image": { "model": "agnes-image-2.5-flash", "size": "1K", "ratio": "1:1" },
    "video": { "model": "agnes-video-2.5", "size": "720P", "seconds": 5 },
    "text": { "model": "agnes-2.5-flash" }
  },
  "jobs": [
    { "id": "icon-001", "kind": "image", "mode": "text2img", "prompt": "a shield icon" },
    { "id": "icon-002", "kind": "image", "mode": "img2img", "image": "./src/a.png", "prompt": "line-art variant", "size": "2K" },
    { "id": "clip-001", "kind": "video", "mode": "text2video", "prompt": "a wave at dusk" },
    { "id": "copy-001", "kind": "text", "prompt": "say pong" }
  ]
}
```

JSONL form: one job object per line (no wrapper); blank lines and `#` / `//`
comment lines are ignored. Defaults for JSONL come from the CLI flags
`--model/--size/--ratio/--seconds/--ttl`.

Job schema (strict; unknown keys are rejected with `INVALID_BATCH_INPUT`):

- `id`: required, unique, `[A-Za-z0-9._-]{1,64}`.
- `kind`: `image` | `video` | `text`; `mode`: image `text2img|img2img|compose`,
  video `text2video|img2video|multivideo|keyframes`, text `chat` (may be omitted
  for `kind=text`).
- Generation params: `prompt` (required), `model`, `size`, `ratio`, `seconds`,
  `aspectRatio`, `seed`, `n`, `ttl`, `image`/`images` (local paths use the media
  bridge).
- `affinity` (optional; default `batch:<batchId>:<jobId>`) and `metadata`
  (optional JSON object ≤4 KB, copied to the result).
- `defaults` may contain generation params only (never `id/kind/mode/image(s)/
  affinity/metadata`); defaults are kind-aware (see below).
- `defaultsByKind: {image?: {...}, video?: {...}, text?: {...}}` — optional
  per-kind default sections that override the flat `defaults` for that kind.
- `consistency`: `record` (default) or `strict`.

Defaults and model resolution (kind-aware):

- Merge order per parameter: **job value > `defaultsByKind[kind]` > flat
  `defaults` (only when the kind accepts it) > built-in kind default**.
- A flat `defaults` block is shared by every job, so values only apply to kinds
  that accept them: `prompt`/`model` are shared; `ttl`/`seed`/`size`/`ratio`
  apply to image jobs; `ttl`/`seed`/`size`/`aspectRatio`/`seconds`/`n` apply to
  video jobs; text jobs take only `prompt`/`model`. Incompatible values are dropped instead of being sent to
  the wrong client (an image `ratio` never reaches video; an exact image size
  like `1024x1024` never reaches video, while `1K` is valid for both image tiers
  and video `1K`).
- A flat `defaults.model` is only used for a job kind when it belongs to that
  kind's model catalog; otherwise the kind's built-in default is used. Built-ins:
  image `agnes-image-2.5-flash`, video `agnes-video-2.5`, text `agnes-2.5-flash`.
- Every job records its effective `model` plus `modelSource`
  (`job` | `defaults` | `kind-default`) in `manifest.json`, `input.json`,
  `results/<id>.json`, and `batch status --json`.
- `defaultsByKind` may only contain params its kind accepts; unknown kinds,
  unknown keys, or kind-incompatible params fail with `INVALID_BATCH_INPUT`
  (exit 2).

### Flags

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | Required output directory for artifacts. |
| `--concurrency <n>` | Max concurrent jobs (default `4`; also bounded by router capacity). |
| `--consistency <mode>` | `record` \| `strict` (overrides input). |
| `--strategy <name>` | Routing strategy override. |
| `--account <id>` | Force one account for the whole batch (implies `strict`). |
| `--max-attempts <n>` | Job-level attempts for retryable failures (default `2`). |
| `--poll-interval <ms>` | Video poll interval floor. |
| `--poll-timeout <ms>` | Video poll budget (default `AGNES_POLL_TIMEOUT_MS`/600000). |
| `--model/--size/--ratio/--seconds/--ttl` | Defaults for JSONL input. |
| `--resume` | Resume an existing output directory (manifest required). |
| `--force` | Allow a non-empty output directory without `--resume`. |
| `--fail-fast` | Stop scheduling new jobs after the first failure. |
| `--dry-run` | Validate input and print the plan; sends nothing, writes nothing. |
| `--json` | Final summary as JSON on stdout (progress stays on stderr). |

### Artifacts

All under `--out`, written atomically with mode `0600`:

- `manifest.json` — input path + sha256, config (consistency/strategy/
  concurrency/defaults/maxAttempts/poll settings), pinned account for strict
  mode, per-job model/modelSource/status/account/pool/attempts/timings/result/
  error, summary.
- `input.json` — normalized effective jobs saved on first run (model +
  modelSource included; the validated `defaultsByKind` section is retained when
  the input had one; enables `retry` even if the original file moved).
- `events.jsonl` — `batch_started`, `job_started`, `job_succeeded`,
  `job_failed`, `job_retry`, `batch_finished`, `job_recovered`, ...
- `results/<id>.json` — per-job result envelope (job record incl. model and
  modelSource) for downstream pipelines.

`manifest.jobs` is always in input order; `summary.accountsUsed` is sorted and
`mixedAccounts=true` when a `record` batch used more than one account. No key
material is ever written.

### Consistency: `record` vs `strict`

- `record` (default): the router picks per create; each job records its
  `accountId`/`poolId`/`routing`; video jobs poll on the account that created
  them. Maximizes throughput but outputs may come from different accounts
  (`mixedAccounts=true`).
- `strict`: one account is selected at batch start (priority then strategy;
  `--account` forces it and implies strict). All creates and polls use that
  account; on 429 the job waits for that pool's cooldown; on 401/402/403 the
  batch fails because strict consistency cannot be satisfied. Use it when
  output comparability matters.

### Resume / retry / status

```bash
agnes batch run jobs.json --out ./out --resume
agnes batch status ./out [--json]
agnes batch retry ./out [--only failed|pending|all] [--json]
```

- `--resume` requires the same `batchId`, per-job input hashes, flat defaults
  digest, consistency, strategy and pinned account. `succeeded`/`skipped` jobs are
  skipped without new creates; changed succeeded-job input aborts with
  `BATCH_INPUT_CHANGED`. A job left `running` by an interrupted process is
  recovered as pending with a warning (its create may have been accepted).
  Jobs removed from the input are kept as `skipped` with
  `reason: removed_from_input`; new ids are appended in input order.
- `batch retry` reruns stored jobs from `input.json`; default `--only failed`;
  it never re-runs succeeded jobs.
- `batch status` exits `0` always unless the manifest is missing/invalid
  (exit `2`); it prints summary plus per-job status/account/result URL when available.
- `--dry-run` prints the plan JSON (`{ok, batchId, jobs, routePlan}`), selects
  the strict account if requested, and writes nothing.
- Exit codes: `0` all succeeded/skipped, `1` one or more jobs failed, `2`
  invalid input/config.

Job retries: `RATE_LIMITED`, `NETWORK_ERROR` (GET), `SERVICE_BUSY`, and
`POLL_TIMEOUT` are retried up to `--max-attempts` with exponential backoff +
jitter. `AMBIGUOUS_CREATE` is **never** auto-retried (marked failed with
`ambiguous: true` and guidance); `INVALID_*`, `AUTH_*`, `QUOTA_*`, `MODEL_*`
are not retried. A failed job records the error and continues unless
`--fail-fast`.

## JS API

```js
import { createAgnesClient } from "agnes-ai-cli";

const agnes = createAgnesClient({ apiKey: process.env.AGNES_API_KEY });

const image = await agnes.image.generate({
  mode: "text2img",
  prompt: "A cinematic product shot of a silver watch on black stone.",
  size: "2K",
  ratio: "16:9",
});
console.log(image.url, image.accountId);
```

The plain `{ apiKey }` client is file-free and behaves as before. Multi-account
routing is opt-in:

```js
const agnes = createAgnesClient({
  accounts: [
    { id: "main", key: process.env.MAIN_KEY, type: "free", poolId: "acct-main" },
    { id: "backup", key: process.env.BACKUP_KEY, type: "tokenplan", poolId: "acct-backup" },
  ],
  strategy: "adaptive",
  rateLimit: true,          // default false for a raw { apiKey } client
  maxAttempts: 3,
  maxWaitMs: 60000,
  stateDir: "/path/to/state", // optional journal dir; omit to stay file-free
});
```

You can override the temporary upload provider order when a specific host works
better for your Agnes workflow:

```js
const agnes = createAgnesClient({
  apiKey: process.env.AGNES_API_KEY,
  temporaryMediaProviderOrder: ["tmpfiles", "litterbox", "uguu", "x0"],
});
```

The JS API exposes `video.get(id, { modelName })` for a single status request
and `video.poll(id, { modelName, intervalSeconds, timeoutSeconds })` for polling.
Completed video URLs are read from the official top-level `url` field, with
legacy `metadata.url` / `remixed_from_video_id` fallbacks.

Multi-account helpers are exported: `AccountRouter`, `AffinityJournal`,
`loadAccountsConfig`, `accountsSummary`, `findAccount`, `RPM_PRESETS`,
`CONCURRENCY_PRESETS`, `imageTierForSize`, and the routing types. A client
created from resolved env/file config keeps one stateful router across calls
(cooldowns, token buckets, affinity).

## Network behavior

- Status GETs are retried on transient network errors (idempotent only).
- POSTs are **not** retried on ambiguous failures (5xx/network), so a timeout
  never silently creates a second billable request; multi-account routing may
  retry a POST only after a definitive rejection (429/401/402/403).
- 429 cools down the whole pool and honors `Retry-After` when present.
- Polling retries transient `429`/`5xx`/network errors until the overall
  `--timeout` budget expires, always on the same account.
- Every request has an `AbortSignal` timeout (`AGNES_HTTP_TIMEOUT_MS`).

## Error codes

| Code | Exit | Meaning |
| --- | ---: | --- |
| `INVALID_ACCOUNTS_CONFIG` | 2 | Invalid accounts env/file (unknown fields, missing key, bad type/pool, mode too open). |
| `ACCOUNT_NOT_FOUND` | 2 | `--account <id>` is not configured. |
| `INVALID_STRATEGY` | 2 | Unknown `--strategy` value. |
| `INVALID_PROBE` | 2 | Unknown `agnes accounts check --probe` value (allowed: `models`, `text`). |
| `RATE_LIMITED` | 1 | Pool(s) rate-limited; no eligible account within attempts/max wait. Details include `poolId`, `retryAfterMs`, `accountsTried`. |
| `ACCOUNT_AUTH_FAILED` | 1 | A credential was rejected (401/403); account marked unhealthy. |
| `QUOTA_EXHAUSTED` | 1 | 402 quota exhaustion; pool marked depleted. |
| `MODEL_NOT_ALLOWED` | 1 | Model not permitted for the account (403 model access / allowlist). |
| `AMBIGUOUS_CREATE` | 1 | POST may have been accepted but the response failed; not retried. Check the dashboard first. |
| `AFFINITY_NOT_FOUND` | 1 | No account affinity for a video id and probing found nothing; pass `--account`. |
| `TASK_NOT_FOUND` | 1 | The status lookup returned 404 (wrong account or unknown id). |
| `POLL_TIMEOUT` | 1 | Video poll budget expired. |
| `INVALID_JOB` | 1 | A job's effective request options failed client-side validation (zod / per-kind `INVALID_*` mapped to this code). Non-retryable; the message includes the job id and the other jobs continue. |
| `BATCH_INPUT_INVALID` / `INVALID_BATCH_INPUT` | 2 | Unknown top-level/job/defaults keys, duplicate ids, bad modes/params. |
| `BATCH_INPUT_NOT_FOUND` / `BATCH_INPUT_UNREADABLE` | 2 | Input file missing/unreadable. |
| `BATCH_MANIFEST_MISSING` / `BATCH_MANIFEST_INVALID` | 2 | `status`/`retry`/`--resume` without a valid manifest. |
| `BATCH_INPUT_CHANGED` | 2 | Resume/retry input hash differs from the manifest (restore input or use `--force`). |
| `BATCH_BATCH_ID_MISMATCH`, `BATCH_CONFIG_CHANGED`, `BATCH_DEFAULTS_CHANGED`, `BATCH_ACCOUNT_MISMATCH` | 2 | Resume options no longer match the original batch. |
| `BATCH_STRICT_UNAVAILABLE` | 2 | `strict` requested but no account can be pinned. |
| `BATCH_OUT_DIR_NOT_EMPTY` / `BATCH_OUT_DIR_INVALID` | 2 | Output dir non-empty without `--resume`/`--force`, or not a directory. |

## Troubleshooting

- **429 / `RATE_LIMITED`** — this is pool-level. Check `agnes accounts list`
  for `pool=` grouping (same-account keys must share a pool), reduce
  `--concurrency`, or add an independent pool. Status polls deliberately wait
  instead of switching accounts.
- **`AMBIGUOUS_CREATE`** — the create request may have been accepted/billed
  (5xx or timeout after POST). Do not blindly retry: check the Agnes console or
  the batch manifest, then retry explicitly or with a new job id.
- **`AFFINITY_NOT_FOUND`** on `video get/poll` — the state journal has no entry
  (different machine, wiped `AGNES_STATE_DIR`, or old task). Pass the owning
  `--account <id>`; do not let it rotate to a random account.
- **`strict` batch fails on 401/402/403** — strict mode cannot fail over by
  design. Restore the pinned account's credentials/quota, or rerun with
  `--consistency record` (and `--force`/new out dir) if mixed accounts are
  acceptable.
- **`INVALID_ACCOUNTS_CONFIG`** — check for unknown `AGNES_ACCOUNT_*` suffixes,
  a missing `_KEY`, an id not matching `[A-Z0-9]{1,32}`, or a non-`600`
  accounts file warning when `AGNES_ACCOUNTS_ALLOW_INSECURE` is not set.
- **`INVALID_JOB` in a batch** — a job passed input validation but its effective
  options are wrong for that kind/model (e.g. `n: 2` on a video job, or an image
  job pointed at a video model). It is not retried (no duplicate create) and
  exits `1`; fix the job parameters, then `batch retry <out> --only failed`.
- **`--resume` refuses to continue** — `batchId`, defaults digest, consistency,
  strategy or pinned account changed, or a succeeded job's input changed. Restore
  the original input or start a new out dir with `--force`.
- **`accounts check --live` says reachable but a request still fails with 401?** —
  expected: the models probe cannot validate credentials (`/v1/models` answers
  200 even for fabricated tokens). Run `accounts check --live --probe text` for a
  real credential proof (one tiny text request per account).
- **Wrong account used?** — `--account <id>` always wins and disables failover;
  `--affinity <name>` keeps a session sticky; the `account: <id>` stderr notice
  tells you which account served a human-readable command.

## Tests

```bash
npm test
```

209 offline tests use injected `fetchImpl` implementations and a fake Agnes
server; no API key is required. They cover model catalogs/defaults, image/video
payloads, Video 2.5 polling with `model_name`, retry/timeout behavior, env
loading, CLI help, account config/precedence/redaction, `accounts check`
models-vs-text probes, routing strategies, rate limits/429/Retry-After/failover,
affinity journal create→poll behavior, and batch input/manifest/consistency/
resume, including kind-aware defaults (`defaultsByKind` / `modelSource`) and
non-retryable `INVALID_JOB`.
