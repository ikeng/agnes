# Upstream

- Repository: https://github.com/jomeswang/agnes-ai-cli
- Vendored commit: 9e629302cf30898d09f60fb2ba3e52e795b7ccf4 (v0.1.6 tag)
- npm release: agnes-ai-cli@0.1.6 (published 2026-08-10)
- Vendored on: 2026-10-21
- Local patches are documented in this repo's README / docs/upstream-research.md.

## Local patches (v0.2.0-local.1)

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
- `test/`: 74 offline tests covering the patched contracts.

The complete diff against upstream v0.1.6 is stored at
[`../patches/cli-local.patch`](../patches/cli-local.patch). It includes new files
(`src/models.ts`, `src/env.ts`), the package.json/package-lock version bump, all
test changes, and the removed upstream npm-release workflow. Verified by applying
it to a pristine v0.1.6 checkout (`git apply`), then `npm run build && npm test`
-> 74/74 passing.
- `src/config.ts`: `AGNES_BASE_URL` override and `AGNES_MEDIA_PROVIDER_ORDER`.
- `src/env.ts` (new) + CLI entry: automatic `.env.local` loading (existing env wins,
  `AGNES_NO_DOTENV`/`AGNES_ENV_FILE` escape hatches).
- `src/http/requestJson.ts`: per-request timeouts; retries only idempotent GETs
  (POSTs are never retried automatically to avoid duplicate billable requests).
- `src/video/pollVideo.ts`: retries transient 429/5xx/network polling errors until
  the overall timeout instead of failing immediately.
- `agnes auth check` exits 1 when no key is configured.

Note: upstream `.github/workflows/npm-release.yml` was removed from the vendored
copy because this repo builds `cli/` as a subdirectory, not as the upstream
package repository.
