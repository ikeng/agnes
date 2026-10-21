# Upstream research — Agnes AI docs, GitHub, npm, and the current source of truth

- **Research date:** 2026-10-21 (Asia/Shanghai)
- **Scope:** official Agnes AI documentation, official GitHub org, npm registry, and the two community repos the local tooling is built from (`jomeswang/agnes-ai-cli`, `jomeswang/agnes-ai-skill`).
- **Raw inputs saved in:** [`docs/upstream/`](./upstream/SOURCES.md) for URLs, commit SHAs and archive notes.
- **Live verification (performed by the Lead, 2026-10-21):** `agnes-2.5-flash` OK, `agnes-3.0-flash` OK, `agnes-2.0-flash` → HTTP 500 `"Model agnes-2.0-flash is temporarily unavailable"`.
- **Implemented follow-up:** the vendored CLI in [`cli/`](../cli/README.md) is now `0.2.0-local.1` (74/74 offline tests pass via `node --test`, verified 2026-10-21). It implements the patch plan in [§5](#5-concrete-patch-plan-implemented--residual) plus `.env.local` autoload, HTTP timeouts, safe retry policy, media-provider override and auth-check exit codes. [§4.3](#43-remaining-gaps-and-caveats-final-build) lists the few genuine remaining gaps/caveats.

---

## 1. Executive answer — newest official tool / release status

**Short answer:** for *Agnes generation tooling*, there is nothing newer than the local baseline `agnes-ai-cli@0.1.6`. That package is a **community** tool, not an official one. Official Agnes publishes **documentation, a model-catalog repo and an agent skill** — no official text/image/video generation CLI. The official docs are newer than every tool artifact and remain the operational source of truth.

| Artifact | Latest | Date | Verdict |
| --- | --- | --- | --- |
| Official docs (`wiki.agnes-ai.com` / `agnes-ai.com/en/docs`) | live site, pages updated through 2026-10-13 | 2026-10 (pricing/token plan 10-13) | **Current source of truth.** Documents 2.5/3.0 text, Image 2.5, Video 2.5/2.5 Flash, Video v2.0 retirement. |
| Official GitHub org [`AgnesAI-Labs`](https://github.com/AgnesAI-Labs) | `skills` repo (official skill), `AgnesAI-Models` repo | skill: 2026-09-24; models repo: 2026-08-18 | Official, but **not generation CLI tools**. `skills` is current (2.5 defaults); `AgnesAI-Models` still shows the July 2026 catalog (2.0/v2.0). |
| Official `AgnesAI-Labs/AgnesCode` | release `1.0.26` | 2026-07-24 | Official coding-agent CLI — unrelated to text/image/video generation APIs. |
| Official `AgnesAI-Labs/agnes-harness` | tag `agh-stable-rc1` | active 2026-10-21 | Agent runtime/harness — unrelated to generation. |
| `jomeswang/agnes-ai-cli` (community, vendored locally) | `v0.1.6` = HEAD | 2026-08-10 | **Latest available generation CLI**, but written against the retired Video v2.0 API and deprecated text/image models. |
| npm `agnes-ai-cli` | `0.1.6` | published 2026-08-10T07:01:45Z | Same artifact as the GitHub tag; no newer prerelease or dist-tag. |
| `jomeswang/agnes-ai-skill` (community) | `1.2.2` = HEAD | 2026-06-13 | Stale content (2.0/2.1/v2.0 era); local copy equals upstream HEAD. |
| npm `@agnes-ai/agnes-cli` | `0.0.4` | 2026-06-12 | Third-party community package (`Constantine1916/agnes-cli`), older and less capable — not official. |

**Release / branch checks**

- npm `agnes-ai-cli`: dist-tag `latest = 0.1.6`; published versions 0.1.0 (2026-06-02) → 0.1.6 (2026-08-10); registry metadata last modified 2026-08-10. No `next`/`beta` tags.
- GitHub `jomeswang/agnes-ai-cli`: HEAD `9e629302cf30898d09f60fb2ba3e52e795b7ccf4` == tag `v0.1.6`; tags v0.1.4–v0.1.6; **no commits on `main` after v0.1.6**; no open PRs. Branches `chore/npm-release-workflow`, `feat/video-get`, `fix/image-request-contract` are fully merged. `fix/http-error-details` is one commit ahead of main on the API but `git cherry` shows the **same patch already landed on main** as `23bbfc1` — nothing unreleased.
- GitHub `jomeswang/agnes-ai-skill`: HEAD `7e263a4` (2026-06-13, v1.2.2); no open PRs. One unmerged branch: `codex/local-media-upload` (`26f6541`, +1 commit, 21 behind main) — a local-file→temp-URL bridge that never landed; **worth knowing** if upstream is ever revived, but it is not in the published skill.
- Official `AgnesAI-Labs/skills`: single `main` branch, HEAD `9949023` (2026-09-24, "docs: align model reference defaults"); no tags/releases; no open PRs. This is the newest official *content* and should be mined when writing the project skill.
- Official `AgnesAI-Labs/AgnesAI-Models`: HEAD `8cce32e` (2026-08-18); catalog version `2026.07.30`, still lists `agnes-2.0-flash` / `agnes-image-2.0-flash` / `agnes-image-2.1-flash` / `agnes-video-v2.0` — **stale relative to the wiki docs**; not authoritative for model status.

**Important naming fact:** the official docs' "Agnes 3.0 Flash Max" page has been retired (`agnes-30-flash-max.md` → "documentation has been retired"), and the old text model `agnes-2.0-flash` is deprecated (hidden `agnes-20-flash.md` page says "Deprecated; migrate to `agnes-2.5-flash`"). Neither should be treated as current.

**Conclusion for the consolidation project:** patch the community CLI (no newer replacement exists), but write the project skill against the **official docs + official `AgnesAI-Labs/skills` defaults**, not against the stale `jomeswang` skill text.

---

## 2. Current model catalog

### 2.0 Service basics

| Item | Value |
| --- | --- |
| Base URL | `https://apihub.agnes-ai.com/v1` (international primary) |
| Alternate routes (official skill) | `https://apihub.agnes-ai.cn/v1` (international alternate, **only** for network/DNS/TLS failures), `https://api.agnes-ai.cn/v1` (China service) |
| Auth | `Authorization: Bearer YOUR_API_KEY` + `Content-Type: application/json` |
| Key creation | `https://platform.agnes-ai.com/` → API Key section; full key shown once |
| Text endpoints | `POST /v1/chat/completions`, `POST /v1/responses` (Input: `input`, `max_output_tokens`), `POST /v1/messages` (Anthropic-compatible; thinking via `thinking`) |
| Image endpoint | `POST /v1/images/generations` |
| Video create | `POST /v1/videos`; retrieve `GET /agnesapi?video_id=…&model_name=…` (no `/v1`) |
| Common errors | 400 bad request, 401 auth, 402 balance/quota, 403 model access, 404 path/model/`video_id`, 408 timeout, 429 RPM/quota, 500/502/503/520/522/524 retry + backoff |

### 2.1 Text models

| Model ID | Type / status | Docs | Endpoint(s) | Context / max output | Current price | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `agnes-2.5-flash` | Text+image input · **GA** ("Generally available to users with Agnes API access") | https://wiki.agnes-ai.com/en/docs/agnes-25-flash | `/v1/chat/completions`, `/v1/responses`, `/v1/messages` | 512K / 65.5K | $0 (list $0.005/$0.05/$0.15 per M cache/in/out) | **Default text model.** OpenAI-compatible upgrade of `agnes-2.0-flash`; tool calling, streaming, image URL input, thinking via `chat_template_kwargs.enable_thinking`; verified live 2026-10-21. |
| `agnes-3.0-flash` | Text+image URL input · available (no "coming soon" notice; billed/free tier listed) | https://wiki.agnes-ai.com/en/docs/agnes-30-flash | same three endpoints | 512K / 65,536 | $0 (list $0.005/$0.05/$0.15) | New-generation model focused on agentic coding, tool orchestration, instruction/context adherence; verified live 2026-10-21. Optional upgrade, not yet the official-skill default. |
| `agnes-2.5-pro` | Paid reasoning · **commercial stable** (release 2026-08-01) | https://wiki.agnes-ai.com/en/docs/agnes-25-pro | same three endpoints | 1M / 65,536 | $0.045 cache / $0.45 in / $0.90 out per M | Proprietary weights; reasoning + tools + image input. Use when correctness beats latency/cost. |
| `agnes-2.5-pro-beta` | Paid reasoning · **available beta** | https://wiki.agnes-ai.com/en/docs/agnes-25-pro-beta | same three endpoints | 1M / 65,536 | $0.01 cache / $0.10 in / $0.30 out per M | Same contract/limits as 2.5 Pro; confirm model entitlement for the account. |
| `agnes-3.0-pro` | **Coming soon** — docs are integration prep only ("format examples, not evidence of current availability") | https://wiki.agnes-ai.com/en/docs/agnes-30-pro | same three endpoints (announced) | not published | $0.045 / $0.45 / $0.90 per M (announced) | **Do not ship as selectable until GA.** |
| `agnes-2.0-flash` | **Deprecated** | https://wiki.agnes-ai.com/en/docs/agnes-20-flash (hidden from llms.txt; also `/doc/agnes-20-flash` redirects) | `/v1/chat/completions` etc. | 512K historical | $0 | "Do not continue using the deprecated `agnes-2.0-flash` model as a compatibility fallback." Live probe 2026-10-21: HTTP 500 temporarily unavailable. Keep only as an explicit legacy escape hatch. |
| `agnes-3.0-flash-max` | **Documentation retired** (no model status published) | https://wiki.agnes-ai.com/en/docs/agnes-30-flash-max | — | — | — | Retired page points to 3.0 Flash / 2.5 Pro / 2.5 Pro Beta. Do not include. |
| `agnes-1.5-flash` | Legacy, only in the stale official `AgnesAI-Models` catalog (256K/64K) | (not in current wiki index) | `/v1/chat/completions` | 256K / 64K (stale source) | — | Not documented by the current docs; do not use for new work. |

**Text response highlights (Chat Completions):** `id`, `object: "chat.completion"`, `created`, `model`, `choices[0].message.{role,content}`, `choices[0].finish_reason`, `usage.{prompt_tokens,completion_tokens,total_tokens}`. Responses API returns `object: "response"`, `status: "completed"`, `output[]` with `message` / `output_text`. Messages API returns Anthropic-style content blocks; read text from `content[].type == "text"`, and if `stop_reason == max_tokens` retry with a larger budget.

**Request parameters shared by text models:** `model`, `messages`; optional `temperature`, `top_p`, `max_tokens`, `stream`, `tools`, `tool_choice`, `chat_template_kwargs` (OpenAI path) or `thinking` (Anthropic path). Image input is `messages[].content[].image_url.url` with publicly reachable HTTPS URLs.

### 2.2 Image models

All image models: `POST https://apihub.agnes-ai.com/v1/images/generations`; required `model`, `prompt`, `size`; output is `{created, data:[{url, b64_json, revised_prompt}]}`; URL at `data[0].url`, Base64 at `data[0].b64_json`. Recommended client timeout 60–360 s. All tiers are currently **free**; list price $10/$18/$21/$24 per 1,000 images for 1K/2K/3K/4K.

| Model ID | Status | Docs | `size` contract | `ratio` | Notes |
| --- | --- | --- | --- | --- | --- |
| `agnes-image-2.5-flash` | **Current / latest generation** (GA wording absent, but shipped & billed; official-skill default) | https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash | Tiers `1K`,`2K`,`3K`,`4K`; legacy exact `WIDTHxHEIGHT` also accepted but may be normalized | `1:1`,`3:4`,`4:3`,`16:9`,`9:16`,`2:3`,`3:2`,`21:9` (default `1:1`) | Same contract as 2.1; better high-density detail and prompt alignment. 1K 16:9 = `1312x736` (not 1920×1080); 1920×1080/2560×1440 are **not** native — request `2K` + `16:9` then crop. |
| `agnes-image-2.1-flash` | Current, previous generation | https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash | same tier + ratio contract | same | Same price/contract as 2.5; keep as explicit fallback. |
| `agnes-image-2.0-flash` | Legacy / compatibility | https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash | Exact sizes only, e.g. `1024x768`, `1024x1024`, `768x1024` | **not documented** | Same endpoint/response fields; no `ratio` parameter in its docs. Use only when 2.5/2.1 is rejected. |

**Image request rules that matter**

- Image-to-image / multi-image composition: pass the **array** in `extra_body.image` (public URL or Data-URI Base64). Do not pass a top-level `image`.
- `response_format` (`url` / `b64_json`) must be inside `extra_body`; top-level `response_format` errors.
- Text-to-image Base64 uses top-level `return_base64: true`.
- **Do not send `tags: ["img2img"]`** — the docs explicitly say image-to-image does not require tags.
- Output dimension table (all ratios × 1K–4K) is in the model page; 2.1 and 2.5 share it. Use tier+ratio for predictable sizes.
- RPM by tier (free/default): 1K 20→10, 2K 10→5, 3K 2→1, 4K 1→1; enterprise/Token Plan higher (see Token Plan doc).

### 2.3 Video models

| Model ID | Status | Docs | Retrieval | Notes |
| --- | --- | --- | --- | --- |
| `agnes-video-2.5` | **Current / GA** ("now available on the international site") | https://wiki.agnes-ai.com/en/docs/agnes-video-25 | `GET /agnesapi?video_id=<id>&model_name=agnes-video-2.5` | `POST /v1/videos`; modes `text`/`keyframe`/`reference`; `seconds` `"4"`–`"12"` (default `"5"`); `size` `720P`/`1080P`/`1K`/`2K`; `aspect_ratio` default `16:9`; `seed`; `n` only `1`. Up to 8 images, 1 video, 3 audios, ≤12 media files. Paid: $0.025/s 720P, $0.040/s 1080P/1K, $0.055/s 2K; first 5 images free. |
| `agnes-video-2.5-flash` | Current, **limited-time free** promo | https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash | `GET /agnesapi?video_id=<id>&model_name=agnes-video-2.5-flash` | Same API as 2.5 with stricter validation: `size` must be exactly `720P`; `images` ≤ 5; `audios` ≤ 3; non-empty `videos` → HTTP 400 `videos is not supported`. Current price `$0 / second`; same list-price formula otherwise. |
| `agnes-video-v2.0` | **RETIRED 2026-09-25 23:59:59 UTC+8** | https://wiki.agnes-ai.com/en/docs/agnes-video-v20 | legacy `GET /v1/videos/{task_id}` (historical) | Old synchronous-fields API (`width`/`height`/`num_frames`/`frame_rate`). Only kept for explicit legacy calls/tests; not usable for new work. |

**Status summary:** GA = `agnes-2.5-flash`, `agnes-2.5-pro`, `agnes-image-2.5-flash` (current), `agnes-image-2.1-flash`, `agnes-video-2.5`, `agnes-video-2.5-flash`; beta = `agnes-2.5-pro-beta`; coming soon = `agnes-3.0-pro`; retired = `agnes-video-v2.0`, `agnes-3.0-flash-max` docs; deprecated = `agnes-2.0-flash` (text), `agnes-image-2.0-flash` (legacy compatibility).

**Rate limits** (docs `tokenplan.md`, updated 2026-09-23 for text):

- Text RPM actual: free/default **10**, enterprise **20**, Token Plan **1000**.
- Image RPM actual by tier: default 1K 10 / 2K 5 / 3K 1 / 4K 1; enterprise 40/20/1/1; Token Plan 100/80/1/1.
- Video RPM actual: default **1**, enterprise **2**, Token Plan **5**; Token Plan video quota 500 seconds/day.
- Token Plan quotas: Starter/Plus/Pro text 1,500/7,500/30,000 requests per 5 h; images 4,000/day; video 500 s/day.

---

## 3. Video contract deep-dive (Agnes Video 2.5)

### 3.1 Create task

```
POST https://apihub.agnes-ai.com/v1/videos
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `model` | string | yes | `agnes-video-2.5` or `agnes-video-2.5-flash` |
| `prompt` | string | yes | In `reference` mode use placeholders `<Picture N>`, `<Audio N>`, `<Video N>` (numbered from 1 per array) |
| `mode` | string | yes | `text`, `keyframe`, `reference` |
| `seconds` | **string** | no | `"4"`–`"12"`, default `"5"` (docs error hints say string type matters) |
| `size` | string | no | `720P`, `1080P`, `1K`, `2K`; Flash: only `720P`; `1K` = fixed `1024x1024` |
| `aspect_ratio` | string | no | `21:9`, `16:9` (default), `4:3`, `1:1`, `3:4`, `9:16`; `auto` and unknown values → 400 |
| `seed` | integer | no | reproducibility hint |
| `n` | integer | no | only `1` is supported; other values → 400 |
| `first_frame` | string URL | keyframe only | First-frame image; provide this, `last_frame`, or both |
| `last_frame` | string URL | keyframe only | Last-frame image; provide at least one of the two |
| `images` | string[] | reference only | ≤8 (base model) / ≤5 (Flash); public URLs |
| `audios` | string[] | reference only | ≤3; total media files in request ≤12 |
| `videos` | object[] | reference only | ≤1 object `{url, start_seconds? (default 0), require_audio? (default false)}`; **Flash: non-empty → 400** |

Mode rules (violations → 400): `text` forbids all media fields; `keyframe` requires `first_frame`/`last_frame` and forbids `images`/`audios`/`videos`; `reference` requires at least one non-empty `images`/`audios`/`videos` and forbids `first_frame`/`last_frame`. All media URLs must be publicly reachable until the task completes.

Reference media limits (base model): images <15 MB each, total request <50 MB, each dimension 256–5760 px; videos 1 file, 2–12 s total, <50 MB, 24–60 FPS; audio 3 files, 2–12 s total, <15 MB each, request <64 MB; total media files ≤12.

**Forbidden legacy fields (400):** `width`, `height`, `fps`, `num_frames`, `quality`, `num_inference_steps`; `video_url`, `video_path`, `video_reference`; `input_reference`, `reference_url`; pixel dimensions (e.g. `1280x720`) in `size`; `aspect_ratio: "auto"`; `n != 1`; media fields that conflict with `mode`.

> **Historical v2.0 payload (retired):** `model: "agnes-video-v2.0"`, `prompt`, `width` 1152, `height` 768, `num_frames` 121 (must be `8n+1`, ≤441), `frame_rate` 24 (1–60), `seed`, `negative_prompt`, `image` (img2video) / `extra_body.image` (multivideo/keyframes). None of these fields apply to 2.5; `negative_prompt` is not documented for 2.5 at all.

**Create response**

```json
{
  "id": "task_…", "task_id": "task_…", "video_id": "video_…",
  "object": "video", "model": "agnes-video-2.5", "status": "queued",
  "progress": 0, "created_at": 1786900000, "seconds": "5", "size": "720P"
}
```

`id` == `task_id` identifies the async task; **`video_id` is what you poll with**. Keep `model` alongside the id: the completed retrieve payload does not reliably echo `model`.

### 3.2 Retrieve / poll

**Recommended (all modes):**

```
GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>&model_name=<MODEL_ID>
Authorization: Bearer YOUR_API_KEY
```

- `video_id`-only form is valid **only for `mode: "text"`**; `keyframe` and `reference` tasks require `model_name`.
- Poll every **1–2 seconds**; stop when `status` is `completed` or `failed`. Use backoff on 429 and a max polling duration in production.
- Completed payload fields: `status`, `progress` (0–100), top-level **`url`** (play/download), `seconds`, `size`, `quality`, `created_at`/`started_at`/`completed_at`/`expires_at`, `error` (null on success), `id`, `object`; `internal_status`/`internal_progress` are internal — ignore them (they may stay `pending`/`0`).
- Failed payload: same shape with `status: "failed"`, `progress: 100`, `error: {message}` (e.g. `"Invalid reference media"`).
- Legacy fallback for old task ids: `GET /v1/videos/{task_id}` (v2.0-era; not the documented 2.5 path).

**Size / aspect mapping (base Video 2.5):**

| aspect_ratio | 720P | 1080P | 2K (2×720P) |
| --- | --- | --- | --- |
| 21:9 | 1470×630 | 2206×946 | 2940×1260 |
| 16:9 | 1280×720 | 1920×1080 | 2560×1440 |
| 4:3 | 1112×834 | 1664×1248 | 2224×1668 |
| 1:1 | 960×960 | 1440×1440 | 1920×1920 |
| 3:4 | 834×1112 | 1248×1664 | 1668×2224 |
| 9:16 | 720×1280 | 1080×1920 | 1440×2560 |

`1K` = fixed `1024×1024` (no aspect mapping). Video 2.5 Flash (720P only): 21:9 `1680×720`, 16:9 **`1280×704`** (tested Sep 2026 — treat the file as source of truth), 4:3 `960×720`, 1:1 `720×720`, 3:4 `720×960`, 9:16 `720×1280`.

**Billing (Video 2.5):** `total = output_seconds × rate + input_video_seconds × rate + max(0, image_count − 5) × $0.005`; rates 720P $0.025/s, 1080P/1K $0.040/s, 2K $0.055/s. Flash currently $0/s under a limited-time promo.

**Errors:** 400 validation/mode/media; 401/403 key or model access; 404 unknown `video_id`; 429 RPM/quota; 500 retry later.

---

## 4. Local tool gap analysis vs docs

### 4.1 Pristine upstream `agnes-ai-cli` v0.1.6 (before local patch)

Line numbers refer to the upstream tag source; the vendored copy in this repo has since been patched.

| File:line | Problem | Docs requirement |
| --- | --- | --- |
| `src/cli.ts:14` | `.version("0.1.0")` while package is 0.1.6 | Version should be read from `package.json`. |
| `src/cli.ts:101,108` | `text chat --model` default `agnes-2.0-flash`; help repeats it | Default must be `agnes-2.5-flash` (2.0 is deprecated; live 500). |
| `src/text/complete.ts:8` | Schema default `agnes-2.0-flash` | Same. `agnes-3.0-flash`, `2.5-pro`, `2.5-pro-beta` should be selectable/validated. |
| `src/cli.ts:135-136,144` | Image command has no CLI model default; help text says `agnes-image-2.1-flash`; model list only 2.0/2.1 in schema | `agnes-image-2.5-flash` is current; default 2.5. |
| `src/image/normalizeImageRequest.ts:8,16,26` | `z.enum(["agnes-image-2.1-flash","agnes-image-2.0-flash"])` — **rejects `agnes-image-2.5-flash` client-side** | Docs serve Image 2.5 at the same endpoint/contract. |
| `src/image/normalizeImageRequest.ts:42` | Default model `agnes-image-2.1-flash` | 2.5 is latest; official skill default is 2.5. |
| `src/image/normalizeImageRequest.ts:48` | `size` optional and omitted when not given | Docs list `size` as required for all image models → supply a default (`1024x1024` is accepted by 2.0/2.1/2.5). |
| `src/image/normalizeImageRequest.ts` | No `ratio`; `seed` is passed though undocumented in image docs | Add `ratio` for 2.1/2.5; treat `seed` as an undocumented pass-through (don't rely on it). |
| `src/cli.ts:238-294` | Video commands pass legacy `width`/`height`/`numFrames`/`frameRate`/`negativePrompt`; no `--model`, `--seconds`, `--size`, `--aspect-ratio`, `--n` | 2.5 payload is `mode` + `seconds` + `size` + `aspect_ratio` + media fields; the legacy numeric fields are 400 errors. |
| `src/video/normalizeVideoRequest.ts:49` | Hardcoded `model: "agnes-video-v2.0"` | v2.0 retired 2026-09-25; default must be `agnes-video-2.5`. |
| `src/video/normalizeVideoRequest.ts:42-46,51-54` | Default `width:1152`, `height:768`, `num_frames:121`, `frame_rate:24` sent on every request | All explicitly "not configurable" for 2.5. |
| `src/video/normalizeVideoRequest.ts:59-72` | Mode mapping `text2video`/`img2video`/`multivideo`/`keyframes` → `image` top-level or `extra_body.image` (v2.0 shapes) | 2.5 needs `mode: text|keyframe|reference` plus `first_frame`/`last_frame`/`images`/`audios`/`videos`. |
| `src/video/normalizeVideoRequest.ts:78-104` | Legacy validation `num_frames ≤441`, `8n+1`, `frame_rate 1–60` | Irrelevant for 2.5; replace with `seconds 4–12`, `n=1`, size/ratio enums, flash limits. |
| `src/video/getVideo.ts:76-83` | Polls `/agnesapi?video_id=<id>` with **no `model_name`** | Recommended/correct form is `video_id + model_name`; required for keyframe/reference. |
| `src/video/getVideo.ts:67`, `generateVideo.ts:61` | Fallback model string `agnes-video-v2.0` | Should be `agnes-video-2.5`. |
| `src/config.ts:34-41` | `DEFAULT_VIDEO_DIMENSIONS` / `DEFAULT_VIDEO_TEMPORAL` | Legacy-only; 2.5 defaults are seconds=5, size tier, aspect ratio. |
| `README.md:31-33,53-56` | Documents v2.0 payload/poll behaviour and stale model defaults | Must describe Video 2.5 create/poll and 2.5 defaults. |

**Local global install (`/usr/local/lib/node_modules/agnes-ai-cli@0.1.6`) is not pristine.** Diffing it against the npm 0.1.6 tarball shows three modified files: `dist/cli.js`, `dist/image/normalizeImageRequest.js`, `dist/image/normalizeImageRequest.d.ts`. The patched dist adds `agnes-image-2.5-flash` (default 2.5) and a comment explaining that the upstream enum rejected it client-side, while **text still defaults to `agnes-2.0-flash` and video still emits v2.0**. Consequence: a fresh `npm i -g agnes-ai-cli` would *regress* image 2.5 support and leave text/video stale — so the repo must own a properly patched build (as it now does) instead of relying on the global install.

### 4.2 Community skill `jomeswang/agnes-ai-skill` 1.2.2 (stale)

| `SKILL.md` lines | Problem | Docs requirement |
| --- | --- | --- |
| 52-55 | Models block: `agnes-2.0-flash`, `agnes-image-2.1-flash`/`2.0`, `agnes-video-v2.0` | Use 2.5 Flash / Image 2.5 / Video 2.5 (+ Flash); 2.0 text deprecated, v2.0 retired. |
| 85-90, 111-112 | Doc links `/doc/agnes-20-flash`, `/doc/agnes-image-20/21-flash`, `/doc/agnes-video-v20` | Current docs: `/en/docs/agnes-25-flash`, `agnes-25-pro`, `agnes-image-25-flash`, `agnes-video-25`, `agnes-video-25-flash` (old `/doc/*` links redirect for text/image, but `agnes-video-v20` is now a *retired* page). |
| 244-256 | Model selection section repeats the 2.0/2.1/v2.0 defaults | Replace with 2.5 defaults and paid/coming-soon warnings. |
| 288, 310, 342 | States CLI defaults are `agnes-2.0-flash`, `agnes-image-2.1-flash`, `agnes-video-v2.0` | After patch: `2.5-flash` / `image-2.5-flash` / `video-2.5` (upstream truth was 2.0/2.1/v2.0). |
| 413-420 | Video guidance: `num_frames <= 441`, `8n+1`, `frame_rate 1-60`, width 1152/height 768/num_frames 121/frame_rate 24 | v2.0-only; Video 2.5 uses `seconds` 4–12, `size` tiers, `aspect_ratio`; legacy numeric fields are 400. |
| 489-492 | Compact reference lists only old models | Must list 2.5/3.0 text, image 2.5, video 2.5/2.5-flash and mark deprecated/retired. |
| 191-238, 265-454 | `npx -y agnes-ai-cli@^0.1.0` as the execution path | Fine as a bootstrap, but it installs the stale npm 0.1.6; the project should point at the vendored patched CLI (`npm link`) and keep npx as fallback. |
| `README.md:47-50,132-144,246-249` | Model guide/quick reference with old models; line 248 recommends `tags: ["img2img"]` | Docs explicitly say **do not** send `tags`; image-to-image only needs `extra_body.image`. |
| `README.md:300-310` | Primary sources are old `/doc/*` pages | Point at `wiki.agnes-ai.com` current pages. |

### 4.3 Remaining gaps and caveats (final build)

Verified against the built CLI on 2026-10-21 (`node --test`: **74/74 pass**). The
original draft's two stale items are now fixed in code and are no longer gaps:

- ✅ `AGNES_BASE_URL` is implemented in `src/config.ts` (`baseUrl: config.baseUrl ?? env.AGNES_BASE_URL ?? DEFAULT_BASE_URL`) with coverage in `test/unit/config.test.mjs` / `test/unit/env.test.mjs`.
- ✅ `--ratio` with `agnes-image-2.0-flash` is now **rejected** with `INVALID_IMAGE_OPTION` in `src/image/normalizeImageRequest.ts` (Image 2.0 has no documented `ratio`).

Genuine remaining gaps / caveats (skill must document these):

1. **Polling default model.** `video get` / `video poll` default to `agnes-video-2.5`; an `agnes-video-2.5-flash` task polled without `--model` sends a mismatched `model_name`. Create output prints `model` as the hint; the skill must always pass the matching `--model`. (No CLI change: a task id does not carry the create-time model.)
2. **Image `seed` is an undocumented pass-through.** Docs list `seed` for video only; the CLI forwards `--seed` on image requests as a compatibility knob. Do not document it as a supported guarantee.
3. **No Base64 image output through the CLI.** `responseFormat` is limited to `url` (`z.literal("url")`); `generateImage` returns `data[0].url` and errors with `IMAGE_URL_MISSING` when no URL is present. Docs support `extra_body.response_format: "b64_json"` / `return_base64: true` → raw HTTP/SDK.
4. **Reference mode is images-only in the CLI.** `video multivideo` sends `mode: "reference"` + top-level `images` (requires ≥2); there are no `--audio`/`--video` flags, no single-reference-image mode, and no last-frame-only keyframe (`img2video` = first frame only; `keyframes` = first+last, exactly 2). Docs also support `audios`, `videos[].{url,start_seconds,require_audio}`, one reference image, and `last_frame` alone → raw HTTP/SDK.
5. **Commander argument errors bypass `--json`.** Unknown flags / missing required arguments are handled by Commander before `handleCliError`, so the process exits 1 with plain text on stderr and **empty stdout** (verified: `agnes text chat --prompt x --bogus --json`, `agnes video poll --json`). Scripts must not rely on JSON for invocation errors.
6. **Video queue capacity is service-side.** The CLI only polls; it surfaces `queued`/`in_progress` and treats HTTP 503 (`SERVICE_BUSY`), 429 and 5xx/network errors as transient during polling until `--timeout`. It has no client-side queue control.
7. **Minor parity notes (not defects).** `image text2img` returns before `extra_body` and therefore does not send `extra_body.response_format` (URL is the default); the normalized create-task JSON omits `seconds`/`size`/`progress` (preserved in `.raw`); `agnes models` lists closed model sets and must be updated when `agnes-3.0-pro` ships.

---

## 5. Concrete patch plan (implemented + residual)

The implemented build lives in [`cli/`](../cli/README.md) (version `0.2.0-local.1`, **74/74 offline tests passing** — `cd cli && node --test`, re-verified 2026-10-21) with the full diff in [`patches/cli-local.patch`](../patches/cli-local.patch). The plan below is what was applied; file paths are repo-relative, and §5.3 records the hardening added after the first draft. Only the gaps in §4.3 remain.

### 5.1 `src/models.ts` — single source of truth (new file)

```ts
TEXT_MODELS = ["agnes-3.0-flash", "agnes-2.5-flash", "agnes-2.5-pro",
               "agnes-2.5-pro-beta", "agnes-2.0-flash"]        // 2.0 marked deprecated
DEFAULT_TEXT_MODEL = "agnes-2.5-flash"
IMAGE_MODELS = ["agnes-image-2.5-flash", "agnes-image-2.1-flash",
                "agnes-image-2.0-flash"]
DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash"
IMAGE_SIZE_TIERS = ["1K","2K","3K","4K"]; IMAGE_RATIOS = [1:1,3:4,4:3,16:9,9:16,2:3,3:2,21:9]
DEFAULT_IMAGE_SIZE = "1024x1024"
VIDEO_MODELS = ["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]
DEFAULT_VIDEO_MODEL = "agnes-video-2.5"
VIDEO_SIZE_TIERS = ["720P","1080P","1K","2K"]
VIDEO_ASPECT_RATIOS = ["21:9","16:9","4:3","1:1","3:4","9:16"]
VIDEO_SECONDS = { min: 4, max: 12 }; DEFAULT_VIDEO_SECONDS = 5
VIDEO_25_FLASH_SIZE = "720P"; FLASH_MAX_IMAGES = 5; BASE_MAX_IMAGES = 8
// isLegacyVideoModel / isVideo25Model / isVideo25FlashModel / isDeprecatedTextModel helpers
```

`agnes-3.0-pro` is intentionally absent (coming soon). `agnes-3.0-flash-max` absent (docs retired).

### 5.2 File-by-file

| File | Change |
| --- | --- |
| `src/cli.ts` | Read `.version(pkg.version)`; call `loadLocalEnv()` at entry; add `agnes models [--json]`; text `--model` default `agnes-2.5-flash`; image commands gain `--ratio`, model help lists 2.5; video commands gain `--model`, `--seconds`, `--size`, `--aspect-ratio`, `--n` and keep legacy flags as `--model agnes-video-v2.0`-only; `video get`/`poll` gain `--model` (default `agnes-video-2.5`) and pass it through; `auth check` sets exit code 1 when unconfigured (JSON still printed); output create task `model`; help text rewritten for Video 2.5. Commander parse errors still bypass `--json` (see §4.3). |
| `src/text/complete.ts` | Schema default `DEFAULT_TEXT_MODEL` (`agnes-2.5-flash`). The model field stays `z.string()` **intentionally** for forward compatibility: the default is cataloged but unknown/non-catalog text model IDs pass through to the API (no client-side enum rejection). |
| `src/image/normalizeImageRequest.ts` | Model enum from `IMAGE_MODELS`; default `DEFAULT_IMAGE_MODEL`; `size` defaults to `1024x1024` and is validated (tier or `WIDTHxHEIGHT`); add `ratio` for 2.1/2.5 and **reject it for Image 2.0** (`INVALID_IMAGE_OPTION`); keep `extra_body.image` array; keep `extra_body.response_format` (url only). |
| `src/video/normalizeVideoRequest.ts` | Two payload builders: Video 2.5 (`model`, `prompt`, `mode`, `seconds` as string, optional `size`/`aspect_ratio`/`seed`/`n`, `first_frame`/`last_frame`/`images`) and explicit legacy v2.0 (old fields). Mode map: `text2video→text`, `img2video→keyframe(first_frame)`, `multivideo→reference(images)`, `keyframes→keyframe(first+last)`. Reject legacy numeric/`negative_prompt` flags for 2.5; reject 2.5 flags for v2.0. Validate flash: `size==720P`, images ≤5, keyframes exactly 2, `n==1`, `seconds 4–12`, reference uses ≥1 media field. |
| `src/video/generateVideo.ts` | Default/fallback model `agnes-video-2.5`; keep dual task/video id extraction. |
| `src/video/getVideo.ts` | `GetVideoOptions.modelName`; poll URL `/agnesapi?video_id=…&model_name=…`; keep `task_…` → `/v1/videos/{task_id}` legacy route; model fallback `agnes-video-2.5`; keep top-level `url` + legacy `metadata.url` extraction. |
| `src/video/pollVideo.ts` | Pass `modelName` through; 1–2 s recommended polling interval in help/examples (default stays 5 s for cost safety); stop on `completed`/`failed`; retry transient status errors (`SERVICE_BUSY`, `NETWORK_ERROR`, HTTP 429/5xx) until the overall poll timeout. |
| `src/config.ts` | ✅ `AGNES_BASE_URL` env support: `baseUrl: config.baseUrl ?? env.AGNES_BASE_URL ?? DEFAULT_BASE_URL`; parse/validate `AGNES_MEDIA_PROVIDER_ORDER` (unknown provider → `INVALID_ENV`); keep `AGNES_API_KEY` support and legacy v2.0 dimension/temporal constants. |
| `src/env.ts` (new) | CLI-only `.env.local` autoload: nearest file searching up to 4 parent directories from cwd; existing environment variables win; `AGNES_NO_DOTENV=1` disables; `AGNES_ENV_FILE=/path` forces a file; unreadable/invalid files never break `--help`/auth checks. |
| `src/http/requestJson.ts` | Default 120 s request timeout (`AGNES_HTTP_TIMEOUT_MS`); GET/HEAD retried up to 2× by default, **POST not retried** (a timed-out POST may already be accepted/billed); error bodies sanitized (`Bearer`/`sk-…`/token query params redacted); error details include `httpStatus`. |
| `src/auth/check.ts` + `auth check` action | Prints JSON/text status; sets `process.exitCode = 1` when `AGNES_API_KEY` is missing (CI-friendly). |
| `test/unit/text.test.mjs` | Default model 2.5 + `agnes-3.0-flash` accepted. |
| `test/unit/image-normalization.test.mjs` / `image-generate.test.mjs` | Default 2.5, default size, ratio passthrough for 2.1/2.5 **and rejection for 2.0** (`INVALID_IMAGE_OPTION`), size validation, `extra_body.image` array, no `tags`. |
| `test/unit/video-normalization.test.mjs` | 2.5 default payload (`mode: "text"`, `seconds: "5"`, no `width`/`num_frames`), controls passthrough, mode mappings, flash limits, legacy-flag rejection, explicit v2.0 path. |
| `test/unit/video-poll.test.mjs` | URLs include `model_name`; `task_` legacy route; status/url normalization; missing-URL error. |
| `test/unit/config.test.mjs` | `AGNES_BASE_URL` precedence/default, explicit `baseUrl` wins, provider-order parsing + invalid-provider error. |
| `test/unit/env.test.mjs` | `.env.local` upward search, explicit env wins, `AGNES_NO_DOTENV` disable. |
| `test/cli/env-auth.test.mjs` | `auth check` exits 1 when unconfigured (JSON valid) and loads a local `.env.local` for a configured key. |
| `test/cli/help.test.mjs` | Help strings mention `agnes-2.5-flash`, `/agnesapi?video_id={video_id}&model_name={model}`, new video flags. |
| `cli/README.md` | 2.5 defaults, Video 2.5 create/poll contract, `--model` polling warning, legacy v2.0 note. |

**Build/test:** `cd cli && npm install && npm run build && node --test` (offline; no API calls). The repo root wraps this in `npm test`.

**Compatibility policy:** keep `agnes-video-v2.0` as an *explicit* legacy model (tests + escape hatch), never as a default; keep `agnes-2.0-flash` selectable but marked deprecated; do not add `agnes-3.0-pro` until GA.

### 5.3 Hardening implemented after the first patch draft

Final build `0.2.0-local.1`; `cd cli && node --test` → **74 tests, 74 pass, 0 fail** (2026-10-21).

| Area | Implemented behavior |
| --- | --- |
| Env autoload | `src/env.ts` `loadLocalEnv()` called from `runCli`: nearest `.env.local` (≤4 parents), explicit env wins, `AGNES_NO_DOTENV=1` off-switch, `AGNES_ENV_FILE` explicit path, never overrides exported values. `.env.local` is gitignored; key never printed. |
| Base URL / gateways | `AGNES_BASE_URL` honored by `resolveConfig` (`config.baseUrl` wins over env); covers international alternate (`apihub.agnes-ai.cn`) and China (`api.agnes-ai.cn`) routes. |
| HTTP timeouts | 120 s default via `AbortSignal.timeout`; override with `AGNES_HTTP_TIMEOUT_MS` (positive int); caller-supplied signals win. |
| Retry policy | GET/HEAD: up to 2 retries by default; POST: no retry by default (avoids duplicate billed generations); `requestJson` also sanitizes error bodies and includes `httpStatus` in error details. |
| Video polling | `pollVideo` retries transient status failures (`SERVICE_BUSY` 503, `NETWORK_ERROR`, 429/5xx) until `--timeout`; 404 stays terminal; `--interval`/`--timeout` still user-controlled. |
| Media bridge | Provider order overridable via `AGNES_MEDIA_PROVIDER_ORDER=uguu,x0,litterbox,tmpfiles`; unknown names fail fast with `INVALID_ENV`; default chain Litterbox → tmpfiles → Uguu → x0. |
| Auth UX | `agnes auth check` exits 1 when unconfigured (JSON printed first), so scripts/CI can gate on it; `--json` remains parseable for the check itself. |
| Tests | 74 total across unit + CLI tests, incl. config/env/auth/env-file/retry/poll-focused suites; all offline (no network/key needed). |

### 5.4 `SKILL.md` update outline (project skill, v1.3.0)

Frontmatter: `name: agnes-ai-skill`, `version: 1.3.0`, same description/tags, add `agnes-3.0-flash`, `agnes-video-2.5` keywords.

1. **CLI-first execution** — prefer the repo-linked patched `agnes` (`npm run install-local`), fallback `npx -y agnes-ai-cli@^0.1.0` only when unavailable; never hand-write HTTP unless the CLI lacks the feature (audio/video references, Base64 image output, last-frame-only keyframes).
2. **Model table** — text `agnes-2.5-flash` default, `agnes-3.0-flash` optional, `2.5-pro`/`2.5-pro-beta` paid reasoning, `2.0-flash` deprecated/never default, `3.0-pro` coming soon (do not call); image `agnes-image-2.5-flash` default, 2.1 fallback, 2.0 legacy (no `ratio`, no `tags`); video `agnes-video-2.5` default, `2.5-flash` free/720P option, `v2.0` retired.
3. **Command map** — `agnes models`, `auth check`, `media url`, `text chat`, `image text2img/img2img/compose` (+ `--size/--ratio`), `video text2video/img2video/multivideo/keyframes` (+ `--model/--seconds/--size/--aspect-ratio`), `video get/poll --model`.
4. **Video 2.5 gotchas** — async: create → `video_id` → poll `video_id + model_name`; `seconds` 4–12 default 5; `size` tiers (1K square; flash 720P only, 16:9 may be 1280×704); statuses `queued|in_progress|completed|failed`; top-level `url` when completed; poll 1–2 s; v2.0 numeric fields rejected; placeholder syntax `<Picture N>`/`<Audio N>`/`<Video N>`; reference mode media limits; CLI lacks audio/video-reference and last-frame-only support.
5. **Image gotchas** — required `size` (default 1024×1024), tier+ratio recommended, `extra_body.image` array for img2img/compose, `response_format` inside `extra_body`, no `tags`, URLs vs Base64, 1920×1080/2560×1440 are normalized (use 2K 16:9 and crop), 60–360 s timeouts.
6. **Text gotchas** — chat/completions one-shot; thinking via `chat_template_kwargs.enable_thinking` or `thinking.budget_tokens`; Responses (`/v1/responses`, `input`) and Messages (`/v1/messages`) are raw-HTTP-only in the CLI; paid-model warnings.
7. **Docs/source links** — `https://wiki.agnes-ai.com/llms.txt`, model pages (`agnes-25-flash`, `agnes-30-flash`, `agnes-25-pro`, `agnes-25-pro-beta`, `agnes-image-25-flash`, `agnes-video-25`, `agnes-video-25-flash`, `pricing`, `tokenplan`), official skill `https://github.com/AgnesAI-Labs/skills`, npm/GitHub of the upstream CLI.
8. **Safety** — never print/commit the key; `.env.local` only; verify live billing before promising "free"; limits/RPM may change.
9. **Troubleshooting** — 400 field placement/media/mode, 401 key, 402 balance, 403 model access, 404 `video_id`, 429 backoff, 500/502/503 retry; `agnes auth check` first.

---

## 6. Citation list

Official docs (all fetched 2026-10-21; `.md` variants used):

- Index: https://wiki.agnes-ai.com/llms.txt
- Overview: https://wiki.agnes-ai.com/en/docs/overview
- Quickstart: https://wiki.agnes-ai.com/en/docs/quickstart
- Agnes 2.5 Flash: https://wiki.agnes-ai.com/en/docs/agnes-25-flash
- Agnes 2.5 Pro: https://wiki.agnes-ai.com/en/docs/agnes-25-pro
- Agnes 2.5 Pro Beta: https://wiki.agnes-ai.com/en/docs/agnes-25-pro-beta
- Agnes 3.0 Flash: https://wiki.agnes-ai.com/en/docs/agnes-30-flash
- Agnes 3.0 Pro (coming soon): https://wiki.agnes-ai.com/en/docs/agnes-30-pro
- Agnes 2.0 Flash (deprecated, hidden page): https://wiki.agnes-ai.com/en/docs/agnes-20-flash
- Agnes 3.0 Flash Max (retired docs, hidden page): https://wiki.agnes-ai.com/en/docs/agnes-30-flash-max
- Agnes Image 2.0 Flash: https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash
- Agnes Image 2.1 Flash: https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash
- Agnes Image 2.5 Flash: https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash
- Agnes Video 2.5: https://wiki.agnes-ai.com/en/docs/agnes-video-25
- Agnes Video 2.5 Flash: https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash
- Agnes Video V2.0 (retired): https://wiki.agnes-ai.com/en/docs/agnes-video-v20
- Pricing: https://wiki.agnes-ai.com/en/docs/pricing
- FAQs: https://wiki.agnes-ai.com/en/docs/faqs
- Token Plan / RPM: https://wiki.agnes-ai.com/en/docs/tokenplan
- Error codes: https://wiki.agnes-ai.com/en/docs/code
- Claude CLI integration (2.5 Flash defaults): https://wiki.agnes-ai.com/en/docs/cid3
- Opencode integration: https://wiki.agnes-ai.com/en/docs/cid7

Official GitHub (AgnesAI-Labs):

- Skills repo: https://github.com/AgnesAI-Labs/skills
- Official skill `agnes-ai-models`: https://github.com/AgnesAI-Labs/skills/tree/main/agnes-ai-models
- Model catalog repo: https://github.com/AgnesAI-Labs/AgnesAI-Models
- AgnesCode: https://github.com/AgnesAI-Labs/AgnesCode
- Agnes Harness: https://github.com/AgnesAI-Labs/agnes-harness

Community baseline:

- CLI repo: https://github.com/jomeswang/agnes-ai-cli (HEAD `9e62930` = v0.1.6, 2026-08-10)
- CLI release: https://github.com/jomeswang/agnes-ai-cli/releases/tag/v0.1.6
- npm: https://www.npmjs.com/package/agnes-ai-cli (0.1.6, published 2026-08-10)
- Skill repo: https://github.com/jomeswang/agnes-ai-skill (HEAD `7e263a4`, 2026-06-13, v1.2.2)
