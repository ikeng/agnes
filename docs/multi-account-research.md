# Multi-account routing research — Agnes API limits, 429 behavior, affinity

- **Date:** 2026-10-23 (Asia/Shanghai)
- **Owner:** Lead (research + live probes); independent review by verifier teammate.
- **Goal:** decide whether multi-account + automatic routing can solve concurrency/rate-limit
  problems for batch production without breaking task context or output consistency.
- **Basis:** official docs snapshots in `docs/upstream/` plus the current live docs
  (`https://wiki.agnes-ai.com/llms.txt`, fetched 2026-10-23), plus bounded live probes against
  `https://apihub.agnes-ai.com` using the single key in `.env.local`. **No key value is recorded
  here; no image/video generation was performed for this research** (all probes were text
  chat-completions with `max_tokens: 1`, free `GET /v1/models`, and free `404` video status GETs).

## 0. TL;DR — what this means for the design

1. **Multiple keys of the same type on one account do NOT stack RPM/quota.** Only distinct
   *limit pools* stack: different accounts, or different key types (free / enterprise / token
   plan) on the same account. The tool must therefore model **pools**, not just keys, and must
   let the operator group keys that share a pool.
2. **429 is account-level**, not key-level ("You've reached the API rate limit for free users").
   A 429 should cool down the whole pool, never just one credential.
3. **No rate-limit headers and (on text) no `Retry-After`.** The client cannot learn the budget
   from response headers on the text path. It must ship its own pacing table and backoff.
   Some endpoints *do* send `Retry-After` (video status GET returned `Retry-After: 2`); always
   honor it when present.
4. **Video status polling consumes the same rate budget as other video API calls.** Four
   ~1s-spaced status GETs triggered a 429. Batch polling needs a paced scheduler, not a
   `setInterval(2s)` per task.
5. **Async task IDs are account-scoped context.** `video_id`/`task_id` created with one
   credential must be polled with the same account/pool (different account → 404/401; a fake key
   on the same URL returns 401). The router must carry **affinity** from create to poll, persist
   it, and never blindly rotate accounts for a status lookup.
6. **No public usage/quota endpoint was found.** Remaining Token Plan quota is console-only;
   the local tool can only track its own request pacing and record 402/quota errors.
7. **`GET /v1/models` is cheap but is NOT a credential oracle.** Fabricated bearer tokens also
   returned HTTP 200 (and sometimes 401) against the real gateway, so a 200 there proves only
   gateway reachability and shows the public catalog. Credential validity must be proven with an
   actual (small) model call: `agnes accounts check --live --probe text` sends one minimal chat
   completion per account. Use `GET /v1/models` for reachability/capability display only.

## 1. Official limits (current docs, 2026-10-23)

### 1.1 Limit pools (the decisive rule)

From the current online `tokenplan.md` (the vendored `docs/upstream/tokenplan.md` predates
sections 7–11; the conclusion is also in `faqs.md:83`):

- Limits are shared by **API key type**, not by each individual key.
- Creating multiple keys of the same type does **not** increase total RPM or total quota.
- Free/default, enterprise-verified, and Token Plan keys use **separate** pools.
- A single account can hold several key types; each type has its own pool.
- Implication: N free keys on one account ≈ one free pool. N *accounts* (or free + Token Plan
  keys within one account) ≈ N independent pools.

### 1.2 RPM tables (effective values used as client defaults)

| Workload | free/default | enterprise | Token Plan |
| --- | ---: | ---: | ---: |
| Text (`agnes-*` chat) | 10 | 20 | 1000 |
| Image 1K | 10 | 40 | 100 |
| Image 2K | 5 | 20 | 80 |
| Image 3K | 1 | 1 | 1 |
| Image 4K | 1 | 1 | 1 |
| Video (create + status) | 1 | 2 | 5 |

Source: `docs/upstream/tokenplan.md` (online version, §3–§5), `docs/upstream/official/AgnesAI-Models-MODEL_CATALOG.md`.
Note `docs/upstream/code.md`-equivalent error page still says "Free users are limited to RPM 20";
that page is stale. The tokenplan page (text update 2026-09-23, video update 2026-06-28) wins;
all presets are configurable per account because upstream values change.

### 1.3 Subscription quotas (Token Plan)

Text requests per 5h/week, image generations per day, video seconds per day (Starter/Plus/Pro:
1,500/7,500/30,000 per 5h; 4,000 images/day; 500 video seconds/day). Quotas are account-level
and **not queryable** through the public API; 402 is the only runtime signal.

## 2. Live probe evidence (2026-10-23)

All probes used the existing single free-tier key. Key material was read inside the shell only
and never echoed; responses below are redacted/truncated.

### P1 — Text burst → 429 shape

14 concurrent `POST /v1/chat/completions` (`max_tokens: 1`, model `agnes-2.5-flash`):

```text
requests 1..12 : HTTP 200
requests 13,14 : HTTP 429
HTTP/2 429
x-request-id: <id>
x-trace-id: <id>
(no retry-after, no x-ratelimit-* headers)
body: {"error":{"code":"","message":"You've reached the API rate limit for free users.
       Upgrade to a Token Plan ... (request id: ...)","type":"AgnesAI_error"}}
```

200 responses also expose no `x-ratelimit-*` headers; they do expose `x-request-id`,
`x-trace-id`, and LiteLLM cost headers (all `0.0` for this free call).

Conclusion: text pacing must be client-side; classify 429 by body/status; do not expect
`Retry-After` on the text path.

### P2 — Video status GET pacing and `Retry-After`

Serial `GET /agnesapi?video_id=video_nonexistent&model_name=agnes-video-2.5`, one request per
second (nonexistent id ⇒ 404, no generation cost):

```text
t1 404, t2 404, t3 404
t4 429  retry-after: 2
t5 404, t6 404, t7 404, t8 404
single probe 10s later: 404
```

Conclusion: status polling is rate-limited and can return `Retry-After`; the observed budget
tolerates a small burst but not an unthrottled poll loop. Batch polling needs per-pool pacing,
jitter, and `Retry-After` handling.

### P3 — Error taxonomy for a video status lookup

| Request | Result |
| --- | --- |
| fake key + `GET /agnesapi?video_id=video_nonexistent` | `401 {"error":{"message":"Invalid token ..."}}` |
| real key + same URL | `404 {"error":{"code":404,"message":"task not found ..."}}` |
| real key + legacy `GET /v1/videos/task_nonexistent` | `400 {"code":"task_not_exist","message":"task not found ..."}` |

Conclusion: auth is checked before resource lookup. A wrong **account** is expected to produce
401 (if invalid) or 404 (if valid but not the owner); the exact cross-account status cannot be
confirmed with one key, so the client treats "404 while affinity is missing" as ambiguous and
never auto-rotates accounts for a status lookup without an explicit affinity/account override.

### P4 — `GET /v1/models` is reachable, but it does not validate credentials

```text
real key           -> HTTP 200, 9 models
fabricated sk-...  -> HTTP 200 (repeated probes; independent verifier also saw intermittent 401)
```

```text
agnes-2.5-flash, agnes-2.5-pro-alpha, agnes-2.5-pro-beta, agnes-3.0-flash,
agnes-image-2.0-flash, agnes-image-2.1-flash, agnes-image-2.5-flash,
agnes-video-2.5, agnes-video-2.5-flash
```

No account identity or quota data is exposed. `GET /v1/models` is useful for gateway reachability
and catalog display, but **a 200 does not prove the key is valid**; the genuine 401 evidence is a
generation/chat call (e.g. the mixed-pool failover probe in P2/§2 or `accounts check --live
--probe text`). It also does not reveal which pool a key belongs to.

### P5 — Idempotency and unsafe retries

- No idempotency-key support is documented, and POST create calls are billable side effects.
- A 429 means the request was rejected before execution (safe to route elsewhere).
- A network timeout or 5xx after a POST is **ambiguous**: the task may already exist/bill.
  The existing CLI deliberately never retries POSTs; keep that rule. Only 429/401/402/403
  (definitive rejections) may fail over to another pool.
- Status GETs are idempotent and may be retried on backoff, but only against the same account
  (affinity).

### P6 — Media bridge is account-independent

Temporary public URLs (`agnes media url`) are public objects; they can be passed to any account.
Only the task/resource IDs are account-scoped.

## 3. Consistency / batch-context requirements derived from the above

1. **Create→poll affinity.** Persist `resourceId → accountId/pool` when a video task is created;
   poll with that account. Batch manifests must record it. An explicit `--account` override is
   allowed for recovery, but the default never rotates.
2. **Model/parameter lock.** Routing must never silently switch model or request parameters.
   An account that lacks a model (per `/v1/models` or configured allowlist) is ineligible; the
   tool fails loudly instead of silently substituting.
3. **Stable batch identity.** Every batch job needs a stable `id`, an input hash, and a
   deterministic position in the manifest. Resume must skip succeeded jobs without re-POSTing
   them, and must refuse to resume when a succeeded job's input changed.
4. **Provenance.** Each result records `accountId`/`poolId`/model/attempts, so mixed-account
   batches are explainable. A `strict` consistency mode pins one pool for the whole batch when
   output comparability matters.
5. **Ordering.** Output ordering follows input order, independent of completion order.
6. **No secret in artifacts.** Account IDs only; keys never appear in manifests, JSON output,
   logs, or docs. State files are `0600`.

## 4. Open questions / limits of this research

- Cross-account `video_id` behavior is inferred (401/404 semantics), not directly tested; the
  design is conservative (affinity required, bounded probing only).
- Whether the video status GET budget is a separate lightweight limiter or the same video RPM
  pool cannot be separated with one key. Both are paced conservatively and adapt on 429.
- Token Plan quota consumption cannot be read from the API; only local accounting/402 handling.
- Pool membership (same account vs different accounts) is not discoverable from a key. The
  operator must group credentials explicitly; docs and `accounts check` warn about this.
