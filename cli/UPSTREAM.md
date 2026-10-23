# Upstream

- Repository: https://github.com/jomeswang/agnes-ai-cli
- Vendored commit: 9e629302cf30898d09f60fb2ba3e52e795b7ccf4 (v0.1.6 tag)
- npm release: agnes-ai-cli@0.1.6 (published 2026-08-10)
- Vendored on: 2026-10-21
- Local patches are documented in this repo's README / docs/upstream-research.md
  and in the 0.3.0 section below.

## Local patches (v0.2.0-local.1 baseline)

The vendored source is upstream v0.1.6 plus these documented fixes:

- `src/models.ts` (new): single model catalog/defaults for text, image, video.
- `src/text/complete.ts`: default text model `agnes-2.0-flash` -> `agnes-2.5-flash`.
- `src/image/normalizeImageRequest.ts`: adds `agnes-image-2.5-flash`, default 2.5,
  always sends a valid `size` (default `1024x1024`), adds `--ratio`, size validation.
- `src/video/normalizeVideoRequest.ts`: new Video 2.5 request contract
  (`mode`/`seconds`/`size`/`aspect_ratio`; `first_frame`/`last_frame`/`images`),
  legacy v2.0 payload only when explicitly selected, per-model validation.
- `src/video/getVideo.ts`, `pollVideo.ts`: `model_name` support on
  `/agnesapi?video_id=...` (required by Video 2.5 keyframe/reference tasks).
- `src/cli.ts`: `agnes models`, Video 2.5 flags, `video get`, model-aware poll,
  `--version` read from package.json, updated help text.
- `src/index.ts`: export model catalog.
- `src/config.ts`: `AGNES_BASE_URL` override and `AGNES_MEDIA_PROVIDER_ORDER`.
- `src/env.ts` (new) + CLI entry: automatic `.env.local` loading (existing env wins,
  `AGNES_NO_DOTENV`/`AGNES_ENV_FILE` escape hatches).
- `src/http/requestJson.ts`: per-request timeouts; retries only idempotent GETs
  (POSTs are never retried automatically to avoid duplicate billable requests).
- `src/video/pollVideo.ts`: retries transient 429/5xx/network polling errors until
  the overall timeout instead of failing immediately.
- `agnes auth check` exits 1 when no key is configured.
- `test/`: 74 offline tests covering the v0.2.0 patched contracts (baseline; the
  current total is 209 after the multi-account/batch suite below).

## 0.3.0-local.1 — multi-account routing + batch production (2026-10-23)

- `src/accounts/` (new): limit-pool configuration (legacy env, indexed env, accounts
  file), documented RPM/concurrency presets, pool-level token buckets and adaptive
  video-status pacing, safe failover matrix, persistent create→poll/session affinity
  journal (0600/0700, inter-process lock), `accounts list` and
  `accounts check --live [--probe models|text]` (models = reachability only;
  `--probe text` = one minimal chat completion per account, the only credential
  proof; never image/video generation), and redacted router summaries.
- `src/cli.ts`: global `--account` / `--strategy`, `--affinity` on create commands,
  `accounts` command group, shared stateful router across commands.
- `src/text`, `src/image`, `src/video`: requests routed through the account pool;
  results carry `accountId`/`poolId`/`routing`; video create binds `video:`/`task:`
  affinity and `video get/poll` resolve it (journal → single account → bounded probe)
  so a task is never polled with another account.
- `src/batch/` (new): `agnes batch run|status|retry` with JSON/JSONL jobs, kind-aware
  defaults, bounded concurrency, per-job isolation, atomic manifest/results/events,
  resume without duplicate creates, `record` vs `strict` consistency modes, and a
  video poll-only retry path (never a second create).
- `src/http/requestJson.ts`: `Retry-After`/`isRetryableStatus` helpers; POST retry
  policy is unchanged (no automatic retry of ambiguous creates).
- `test/`: 209 offline tests using the shared fake Agnes API server at
  `test/helpers/fake-agnes-server.mjs`.

Research/design/verification for this round live in the repo root `docs/`
(`multi-account-research.md`, `multi-account-design.md`,
`multi-account-verification.md`). Live probes found that limit pools are per API key
type (same-type keys do not stack; accounts/types do), 429s carry no rate-limit
headers on text (video status may send `Retry-After`), `GET /v1/models` is reachable
without a valid credential (so it is not a credential oracle), and video status/poll
requests consume the same video rate budget — hence client-side pacing, pool
cooldowns, create→poll affinity and batch-level consistency modes.

The complete diff against upstream v0.1.6 is stored at
[`../patches/cli-local.patch`](../patches/cli-local.patch). It includes the new
files (`src/models.ts`, `src/env.ts`, `src/accounts/`, `src/batch/`, shared test
helpers), the package.json/package-lock version bump, all test changes, and the
removed upstream npm-release workflow. Verified by applying it to a pristine v0.1.6
checkout (`git apply`), then `npm run build && npm test` -> 209/209 passing
(v0.3.0-local.1).

Note: upstream `.github/workflows/npm-release.yml` was removed from the vendored
copy because this repo builds `cli/` as a subdirectory, not as the upstream
package repository.
