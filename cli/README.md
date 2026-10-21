# agnes-ai-cli (patched local build)

CLI and JS API for Agnes text, image, and video workflows.

This directory vendors [jomeswang/agnes-ai-cli](https://github.com/jomeswang/agnes-ai-cli)
v0.1.6 and applies the local model/API patches documented in
[`../README.md`](../README.md) and [`UPSTREAM.md`](./UPSTREAM.md). It is the
source of truth for the `agnes` binary installed by this repo.

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
This repo keeps the API key in `.env.local` (gitignored, mode 600).

| Variable | Purpose |
| --- | --- |
| `AGNES_API_KEY` | Required API key. |
| `AGNES_BASE_URL` | Override the gateway, e.g. `https://api.agnes-ai.cn/v1` for the China service or `https://apihub.agnes-ai.cn/v1` as international fallback. |
| `AGNES_MEDIA_PROVIDER_ORDER` | Comma-separated temporary-upload order; this repo defaults to `uguu,x0,litterbox,tmpfiles` because Litterbox is blocked from this host. Allowed: `litterbox`, `tmpfiles`, `uguu`, `x0`. |
| `AGNES_HTTP_TIMEOUT_MS` | Per-request timeout in milliseconds (default `120000`). |
| `AGNES_ENV_FILE` | Load an explicit env file instead of searching for `.env.local`. |
| `AGNES_NO_DOTENV` | Set to `1` to disable `.env.local` autoloading (library use is always file-free). |

`agnes auth check` exits with status `1` when no key is configured, which makes
it usable in `if` statements and smoke scripts.

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

```bash
agnes models
agnes auth check
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

console.log(image.url);
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

## Network behavior

- Status GETs are retried on transient network errors (idempotent only).
- POSTs are **not** retried by default, so a timeout never silently creates a
  second billable image/video/text request.
- Polling retries transient `429`/`5xx`/network errors until the overall
  `--timeout` budget expires.
- Every request has an `AbortSignal` timeout (`AGNES_HTTP_TIMEOUT_MS`).

## Tests

```bash
npm test
```

74 offline tests use injected `fetchImpl` implementations; no API key is
required. They cover model catalogs/defaults, image/video payloads, Video 2.5
polling with `model_name`, retry/timeout behavior, env loading, and CLI help.
