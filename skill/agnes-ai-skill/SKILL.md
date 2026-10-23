---
name: agnes-ai-skill
version: 1.3.0
description: "Use when the user wants Agnes AI text, image, or video generation and should execute it through the agnes-ai-cli command line instead of hand-writing raw HTTP requests."
tags:
  - agnes
  - agnes-ai
  - agnes-skill
  - multimodal-ai
  - free-ai-api
  - free-ai-model
  - text-generation
  - image-generation
  - ai-image-generation
  - text-to-image
  - image-editing
  - image-to-image
  - video-generation
  - ai-video-generation
  - text-to-video
  - image-to-video
  - video-25
  - api-integration
  - agent-skill
  - codex
  - claude-code
  - openclaw
metadata:
  openclaw:
    emoji: "sparkles"
    homepage: "https://github.com/AgnesAI-Labs/skills"
    requires:
      bins:
        - npm
        - npx
        - node
    primaryEnv: AGNES_API_KEY
    envVars:
      - name: AGNES_API_KEY
        required: false
        description: Agnes API key used for live authenticated text, image, and video requests. The skill can still load without it and guide setup.
      - name: AGNES_BASE_URL
        required: false
        description: Optional base URL override supported by this CLI build, e.g. https://apihub.agnes-ai.cn/v1 for the international alternate route or https://api.agnes-ai.cn/v1 for the China service.
---

# Agnes AI Skill

Use this skill when the user wants Agnes AI **text, image, or video generation**.
This skill is **CLI-first**: prefer the `agnes` CLI for live execution and use
hand-written HTTP only for the few cases the CLI does not cover (listed in
[Raw HTTP fallbacks](#raw-http-fallbacks)).

> This copy is maintained in the **agnes-toolkit** repo (`skill/agnes-ai-skill/`)
> and is the source of truth for the project. It targets the patched CLI
> (`cli/`, `0.3.0-local.1`) installed with `npm run install-local`; `npx
> agnes-ai-cli@^0.1.0` is an older fallback and does **not** understand Video
> 2.5 or multi-account/batch features.

Agnes is one OpenAI-compatible platform for:

- text and vision input with `agnes-2.5-flash` (default) or `agnes-3.0-flash`
- image generation/editing with `agnes-image-2.5-flash`
- asynchronous video generation with `agnes-video-2.5` / `agnes-video-2.5-flash`

## When To Use

Use this skill when:

- the user mentions Agnes AI, `agnes-ai.com`, or the Agnes platform
- the user wants one provider for text, image, and video generation
- the user wants Agnes text/image/video work executed from a terminal
- the user wants image-to-image, multi-image composition, image-to-video, or
  keyframe video generation
- the user wants a low-friction multimodal API for prototyping, agent loops,
  creative iteration, ecommerce content, or storyboard work
- the user has multiple Agnes keys/accounts, hits 429s under concurrency, or
  needs reproducible/resumable **batch production** across an account pool
- the user is generating **game UI assets** (nine-slice panels/buttons/bars,
  icons, badges): use `ui-ninepatch-asset-pipeline` for the prompt structure,
  chroma-key conventions, and acceptance criteria; this skill only covers the
  API/CLI call itself

Do not use this skill when:

- the user is asking for a different provider only
- the task does not need Agnes-specific models, auth, or request behavior
- you would have to guess current Agnes behavior without running the CLI or
  checking the live docs

## Source Of Truth

Official docs (checked **2026-10-21**; the local snapshot lives in
`docs/upstream/` in the agnes-toolkit repo):

| Topic | URL |
| --- | --- |
| Docs index | https://wiki.agnes-ai.com/llms.txt |
| Quickstart | https://wiki.agnes-ai.com/en/docs/quickstart |
| Text — 2.5 Flash (default) | https://wiki.agnes-ai.com/en/docs/agnes-25-flash |
| Text — 3.0 Flash | https://wiki.agnes-ai.com/en/docs/agnes-30-flash |
| Text — 2.5 Pro | https://wiki.agnes-ai.com/en/docs/agnes-25-pro |
| Text — 2.5 Pro Beta | https://wiki.agnes-ai.com/en/docs/agnes-25-pro-beta |
| Text — 3.0 Pro (coming soon) | https://wiki.agnes-ai.com/en/docs/agnes-30-pro |
| Image — 2.5 Flash (default) | https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash |
| Image — 2.1 Flash | https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash |
| Image — 2.0 Flash (legacy) | https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash |
| Video — 2.5 | https://wiki.agnes-ai.com/en/docs/agnes-video-25 |
| Video — 2.5 Flash | https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash |
| Video — v2.0 (retired) | https://wiki.agnes-ai.com/en/docs/agnes-video-v20 |
| Pricing | https://wiki.agnes-ai.com/en/docs/pricing |
| Token Plan / RPM | https://wiki.agnes-ai.com/en/docs/tokenplan |
| FAQs / error codes | https://wiki.agnes-ai.com/en/docs/faqs · https://wiki.agnes-ai.com/en/docs/code |
| Platform / API keys | https://platform.agnes-ai.com/settings/apiKeys |
| Official skill (AgnesAI-Labs) | https://github.com/AgnesAI-Labs/skills |

Use public articles only as supporting context for use cases and positioning,
not as the operational source of truth.

## Base URL And Auth

- Base URL: `https://apihub.agnes-ai.com/v1` (international primary)
- Alternate routes: `https://apihub.agnes-ai.cn/v1` (international alternate —
  only for network/DNS/TLS failures) and `https://api.agnes-ai.cn/v1` (China)
- Key env var: `AGNES_API_KEY`; optional base override: `AGNES_BASE_URL`
  (supported by this CLI build via `resolveConfig`; the repo wrapper also loads
  it from `.env.local`)
- Multi-account: indexed `AGNES_ACCOUNT_<ID>_KEY` (+ `_TYPE/_POOL/_WEIGHT/
  _PRIORITY/_CONCURRENCY/_MODELS/_BASE_URL/_LABEL`) or an explicit
  `AGNES_ACCOUNTS_FILE`; indexed accounts override `AGNES_API_KEY` for routing
- Header: `Authorization: Bearer <account key>`
- Preferred execution package: the patched project CLI (`agnes` via
  `npm run install-local`); fallback `npx -y agnes-ai-cli@^0.1.0`

Check auth before live requests:

```bash
agnes auth check --json                    # {ok, configured, source, accounts, pools, strategy}
agnes accounts list                        # redacted account/pool view (never prints keys)
agnes accounts check --live                # GET /models reachability per account (free; NOT a credential proof)
agnes accounts check --live --probe text   # credential proof: one max_tokens:1 chat per account (tiny cost)
```

## Missing Key Behavior

If no Agnes credential is configured (`AGNES_API_KEY`, `AGNES_ACCOUNT_<ID>_KEY`,
or an accounts file) and the task requires live Agnes access:

1. Tell the user Agnes access is not configured yet.
2. Point them to:
   - https://wiki.agnes-ai.com/en/docs/quickstart
   - https://platform.agnes-ai.com/settings/apiKeys
3. Explain the path briefly:
   `Settings -> API Keys -> Create new secret key`
4. Ask them to provide the key if they want it saved for future use.
5. In this repo, the key belongs in `.env.local` (gitignored, mode 600), or in
   the shell rc file via `agnes auth save-key --key '…'`.

Do not continue with live Agnes calls until a valid key exists.

## Model Selection

Choose the smallest suitable model path. Defaults are enforced by the patched
CLI; override with `--model`.

### Text

| Model | Status | Use for | Notes |
| --- | --- | --- | --- |
| `agnes-2.5-flash` | **GA — default** | chat, coding, tools, streaming, image understanding, agent loops | 512K context / 65.5K output; currently free |
| `agnes-3.0-flash` | GA (newer generation) | harder agentic coding/tool-orchestration tasks | 512K context / 65,536 output; currently free |
| `agnes-2.5-pro` | Paid | reasoning-heavy coding/science/long-context production work | 1M context / 65,536 output; $0.045 cache / $0.45 in / $0.90 out per 1M |
| `agnes-2.5-pro-beta` | Paid beta | same profile as 2.5 Pro at a lower price | 1M context / 65,536 output; $0.01 / $0.10 / $0.30 per 1M |
| `agnes-3.0-pro` | **Coming soon** | do **not** call yet | integration-prep docs only |
| `agnes-2.0-flash` | **Deprecated** | never default; explicit migration only | live probe 2026-10-21 returned HTTP 500 "temporarily unavailable" |

The Agnes 3.0 Flash Max documentation is retired — do not present it as a
callable model.

### Image

| Model | Status | Use for | Notes |
| --- | --- | --- | --- |
| `agnes-image-2.5-flash` | **Current — default** | text-to-image, image-to-image, multi-image composition, high-density visuals | size tiers `1K/2K/3K/4K` + `ratio`; currently free |
| `agnes-image-2.1-flash` | Current (previous gen) | explicit fallback when 2.5 produces worse results | same contract/price as 2.5 |
| `agnes-image-2.0-flash` | Legacy compatibility | only when 2.5/2.1 is unavailable | exact sizes only; **no `ratio`** |

### Video

| Model | Status | Use for | Notes |
| --- | --- | --- | --- |
| `agnes-video-2.5` | **Current — default** | text-to-video, keyframes, image/audio/video references, 720P–2K | paid; see [Video 2.5 contract](#video-25-contract) |
| `agnes-video-2.5-flash` | Current, limited-time free promo | fast 720P text-to-video, keyframes, image/audio references | `size` must be `720P`; images ≤5; no reference videos |
| `agnes-video-v2.0` | **RETIRED 2026-09-25** | never for new work | legacy fields `width`/`height`/`num_frames`/`frame_rate`; only reachable via `--model agnes-video-v2.0` |

Print the live local catalog with:

```bash
agnes models
agnes models --json
```

## CLI Command Map

Run `agnes --help` and `agnes <group> <command> --help` when unsure — the help
text is generated from the same patched build this skill targets.

### Auth and diagnostics

```bash
agnes auth check
agnes auth check --json
agnes auth save-key --key 'USER_PROVIDED_KEY'
agnes models
```

### Media URL bridge (local file -> public URL)

```bash
agnes media url ./local-image.png
agnes media url ./frame.png --ttl 12h
agnes media url https://example.com/already-remote.png
```

Use this whenever Agnes needs a public media URL and the source is local. The
bridge tries Litterbox, then tmpfiles, Uguu and x0.at. The legacy
`scripts/agnes-media-url.sh` is a Litterbox-only fallback — prefer the CLI.

### Text

```bash
agnes text chat --prompt "Reply with exactly pong."
agnes text chat --model agnes-3.0-flash --prompt "Write a TypeScript helper."
agnes text chat --prompt "..." --json
```

Default model is `agnes-2.5-flash`. The CLI sends one user message to
`/chat/completions`. For `/v1/responses` (`input`) or `/v1/messages`
(Anthropic-style thinking) use the raw HTTP fallback.

### Image

```bash
agnes image text2img --prompt "premium perfume product photo" --size 2K --ratio 16:9
agnes image img2img --image ./input.png --prompt "turn this into an editorial poster"
agnes image compose --image ./subject.png --image ./reference.png --prompt "blend these references"
agnes image text2img --prompt "..." --json
```

Defaults: model `agnes-image-2.5-flash`, size `1024x1024`. `--size` accepts the
tiers `1K/2K/3K/4K` or an exact `WIDTHxHEIGHT`; use `--ratio` only with 2.1/2.5.
`--seed` is accepted but is undocumented in the image docs — do not rely on it.
The CLI returns a URL; Base64 output requires raw HTTP.

### Video

```bash
# Text-to-video (mode=text)
agnes video text2video --prompt "cinematic drone shot of waves at dusk" --seconds 5 --size 720P

# First-frame image-to-video (mode=keyframe + first_frame)
agnes video img2video --image ./frame.png --prompt "gentle wind, slow push-in"

# Image references (mode=reference + images; repeat --image, at least 2)
agnes video multivideo --image ./a.png --image ./b.png --prompt "use <Picture 1> and <Picture 2> as references"

# First+last keyframes (mode=keyframe + first_frame/last_frame, exactly 2 images)
agnes video keyframes --image ./first.png --image ./last.png --prompt "smooth transition between the frames"

# One status request / poll until terminal state
agnes video get  video_123 --model agnes-video-2.5
agnes video poll video_123 --model agnes-video-2.5 --interval 2 --timeout 600 --json
```

Create commands print `taskId`, `videoId` and **`model`**; the printed model is
the hint for polling. Pass the **`videoId`** and the same **`--model`** to
`video get`/`video poll`. Always pass `--model` when polling — the default is
`agnes-video-2.5`, so an `agnes-video-2.5-flash` task polled without `--model`
would send the wrong `model_name`. Older `task_…` ids still route to the legacy
`/v1/videos/{task_id}` endpoint.

### Legacy Video v2.0 (retired — explicit only)

```bash
agnes video text2video --model agnes-video-v2.0 --prompt "..." \
  --width 1152 --height 768 --num-frames 121 --frame-rate 24
```

Use only to reproduce an old integration; new work must use Video 2.5.

## Multi-account Pools And Batch Production (2026-10)

Use this workflow when the user has more than one Agnes key/account, is hitting
429s under concurrency, or needs many similar generations that must be
reproducible and resumable. Keep it CLI-first; the patched CLI handles pools,
pacing, create→poll affinity, manifests and resume. Full reference:
`cli/README.md`; evidence/design: `docs/multi-account-research.md`,
`docs/multi-account-design.md`.

### Pool rules you must respect

- Agnes limits are shared per **key type**, not per key: multiple keys of the
  same type on one account do **not** stack RPM/quota. Only distinct accounts or
  distinct key types (`free` / `enterprise` / `tokenplan`) are independent pools.
- A 429 is account/pool level. Group same-account keys with the same
  `POOL`; never present "add more same-type keys" as a capacity increase.

### Commands

```bash
agnes accounts list                     # redacted: key shown only as present (len=N)
agnes accounts check --live             # models reachability only — free, but NOT a credential proof
agnes accounts check --live --probe text  # real credential proof (one tiny chat request per account)
agnes --account main text chat --prompt "..."          # force one account (no failover)
agnes --strategy round-robin image text2img --prompt "..." --json
agnes image text2img --prompt "..." --affinity campaign-42   # sticky session account
agnes batch run jobs.json --out ./out
agnes batch status ./out --json
agnes batch retry ./out --only failed
```

- Multi-account config is env-only or an explicit accounts file, e.g.
  `AGNES_ACCOUNT_MAIN_KEY`, `_TYPE=free`, `_POOL=acct-main`,
  `AGNES_ROUTING_STRATEGY=adaptive`, `AGNES_STATE_DIR=~/.agnes/state`.
- Single `AGNES_API_KEY` keeps working unchanged. Never print, echo, or write a
  key; `accounts list/check` is safe to show the user.

### Batch input and artifacts

`jobs.json` (also accepted: JSONL, one job per line):

```json
{
  "version": 1,
  "batchId": "ui-icons-v1",
  "consistency": "record",
  "defaults": { "ttl": "1h" },
  "defaultsByKind": {
    "image": { "model": "agnes-image-2.5-flash", "size": "1K", "ratio": "1:1" },
    "video": { "model": "agnes-video-2.5", "size": "720P", "seconds": 5 }
  },
  "jobs": [
    { "id": "icon-001", "kind": "image", "mode": "text2img", "prompt": "a shield icon" },
    { "id": "clip-001", "kind": "video", "mode": "text2video", "prompt": "a wave at dusk" }
  ]
}
```

`batch run` writes `manifest.json`, `input.json`, `events.jsonl`, and
`results/<id>.json` under `--out`; results are in input order and record
`model`/`modelSource`, `accountId`/`poolId`/`routing`. `--dry-run` sends nothing
and writes nothing.

Defaults are **kind-aware**: precedence is job value > `defaultsByKind[kind]` >
flat `defaults` (kind-compatible params only) > built-in kind default. A flat
`defaults.model` is only used when it belongs to that kind's model catalog;
otherwise the kind's built-in model is used (`image` `agnes-image-2.5-flash`,
`video` `agnes-video-2.5`, `text` `agnes-2.5-flash`). Incompatible values are
dropped (image `ratio`/exact sizes never reach video; `1K` works for both image
and video). Each manifest job records `model` + `modelSource`
(`job` | `defaults` | `kind-default`).

### `record` vs `strict`

- `record` (default): per-create routing; mixed accounts possible
  (`mixedAccounts=true`). Best throughput.
- `strict`: one pinned account for every create and poll; on 429 it waits for
  that pool instead of failing over, and on 401/402/403 the batch fails (strict
  consistency cannot be satisfied). Use strict when the user needs comparable
  output from one account, or when they say "same account/consistent style".
  `--account` implies strict.

### 429, retries, resume

- 429 cools the whole pool; the CLI honors `Retry-After` and fails over creates
  only on definitive rejections. Status polls never rotate accounts.
- `AMBIGUOUS_CREATE` (5xx/timeout after a create POST) is **never** retried
  automatically — the task may already exist/bill. Check the Agnes console or
  manifest first.
- Per-job invalid params fail as non-retryable `INVALID_JOB` (message names the
  job id, exit 1, no duplicate create); fix the job and retry explicitly.
- `batch run --resume` skips succeeded jobs without new creates, aborts on
  changed input (`BATCH_INPUT_CHANGED`), and recovers interrupted `running` jobs
  with ambiguity warnings. `batch retry --only failed` re-runs stored jobs.
- Exit codes: 0 all succeeded/skipped, 1 any failed, 2 invalid input/config.

### Provenance and safety

- Every JSON result adds `accountId`, `poolId`, `routing`; human output prints
  `account: <id>` on stderr only when more than one account is configured.
- Never write keys into batch inputs, manifests, logs, or user-visible output.
  State dir (`AGNES_STATE_DIR`, default `~/.agnes/state`) is 0700/0600 and stores
  only account ids/pools/resource ids.
- Do not manually "try another account" for a video status lookup; pass
  `--account <id>` only when you know the owner (default is the affinity
  journal).

## Video 2.5 Contract

Agnes Video 2.5 is **asynchronous** and OpenAI-Videos-compatible:

1. `POST /v1/videos` creates a task. The CLI does this for you.
2. The create response contains `id`/`task_id` (the async task) and
   `video_id` (what you poll with), plus `status: "queued"`, `progress: 0`,
   `seconds` and `size`.
3. Poll `GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>&model_name=<MODEL_ID>`
   every 1–2 seconds until `status` is `completed` or `failed`.
   `model_name` is **required** for `keyframe` and `reference` tasks; a
   `video_id`-only query is valid only for `text` mode.
4. When completed, read the **top-level `url`** field. Ignore
   `internal_status`/`internal_progress`; use `status` and `progress`.
5. Follow redirects to download the MP4 after completion; keep a maximum
   polling duration and back off on `429`.

Create parameters (direct HTTP; the CLI maps its flags to these):

| Parameter | Required | Values / defaults |
| --- | --- | --- |
| `model` | yes | `agnes-video-2.5` or `agnes-video-2.5-flash` |
| `prompt` | yes | text; in reference mode use `<Picture N>`, `<Audio N>`, `<Video N>` (numbered from 1) |
| `mode` | yes | `text`, `keyframe`, `reference` |
| `seconds` | no | string `"4"`–`"12"`, default `"5"` |
| `size` | no | `720P`, `1080P`, `1K` (fixed 1024×1024), `2K`; Flash only `720P` |
| `aspect_ratio` | no | `21:9`, `16:9` (default), `4:3`, `1:1`, `3:4`, `9:16` |
| `seed` | no | integer |
| `n` | no | only `1` supported |
| `first_frame` / `last_frame` | keyframe only | image URLs; provide at least one |
| `images` | reference only | image URLs; ≤8 (base) / ≤5 (Flash) |
| `audios` | reference only | audio URLs; ≤3 |
| `videos` | reference only | `[{url, start_seconds?, require_audio?}]`; ≤1; **Flash: not supported** |

Limits and gotchas:

- Media URLs must be publicly reachable until the task completes.
- Reference media (base): each image <15 MB, request <50 MB, dimensions
  256–5760 px; video 2–12 s, <50 MB, 24–60 FPS; audio 2–12 s, <15 MB; total
  media files ≤12.
- `width`, `height`, `fps`, `num_frames`, `quality`, `num_inference_steps`,
  `negative_prompt`, `video_url`, `video_path`, `video_reference`,
  `input_reference`, `reference_url` are **not accepted** by Video 2.5 (400).
- Pixel dimensions (`1280x720`) are not valid `size` values; use a tier +
  `aspect_ratio`.
- `1K` is a fixed 1024×1024 square — do not combine it with a non-square
  `aspect_ratio`.
- Video 2.5 Flash: `size` must be `720P`, ≤5 images, ≤3 audios, no `videos`;
  720P 16:9 output has been observed at `1280x704` (treat the file as truth).
- Pricing (base): 720P $0.025/s, 1080P/1K $0.040/s, 2K $0.055/s; input video
  seconds add to billable duration; first 5 images free, then $0.005/image.
  Flash is currently `$0/s` in a limited-time promotion.
- Billing, free promotions, RPM and quotas can change — verify against
  https://wiki.agnes-ai.com/en/docs/pricing before promising cost.

## Image Contract Notes

- Required payload fields for every image request: `model`, `prompt`, `size`.
- Prefer tier + ratio (`--size 2K --ratio 16:9`) for predictable dimensions;
  16:9 1K is `1312x736`, not 1920×1080. For a 1920×1080/2560×1440 canvas,
  request 2K 16:9 and crop/resize downstream.
- Image-to-image / composition: input images go in `extra_body.image` as an
  array (public URLs or Data-URI Base64). The CLI handles this for
  `img2img`/`compose`.
- `response_format` (`url` or `b64_json`) must be inside `extra_body`; never at
  the top level. Text-to-image Base64 uses top-level `return_base64: true`.
- **Do not send `tags: ["img2img"]`** — the docs explicitly say it is not
  required.
- Image generation can take up to tens of seconds; client timeouts of 60–360 s
  are recommended.
- The CLI returns image URLs (`data[0].url`). For Base64 output, use raw HTTP.

## Text Contract Notes

- Chat Completions: `POST /v1/chat/completions` with `model` + `messages`
  (OpenAI-compatible), optional `temperature`, `top_p`, `max_tokens`, `stream`,
  `tools`, `tool_choice`.
- Thinking on the OpenAI path:
  `"chat_template_kwargs": {"enable_thinking": true}`; on the Anthropic path:
  `"thinking": {"type": "enabled", "budget_tokens": 2048}`.
- Responses API: `POST /v1/responses` with `input` / `max_output_tokens`.
- Messages API: `POST /v1/messages` with Anthropic-style content blocks; read
  text from `content[].type == "text"`; retry with a larger budget if
  `stop_reason` is `max_tokens`.
- Image input: `messages[].content[].image_url.url` must be a public HTTPS URL.
- `agnes-2.5-pro` / `agnes-2.5-pro-beta` are paid; `agnes-3.0-pro` is not
  callable yet.

## Raw HTTP Fallbacks

The patched CLI covers the common generation paths. Use curl/SDK (with the same
base URL and key) only for:

1. **Video references beyond images** — audio (`audios`), video
   (`videos[].url`, `start_seconds`, `require_audio`), or a single reference
   image (the CLI's `multivideo` requires ≥2 images).
2. **Last-frame-only keyframes** — the CLI supports first-frame only
   (`img2video`) or first+last (`keyframes`); docs also allow `last_frame` alone.
3. **Image Base64 output** — `extra_body.response_format: "b64_json"` or
   `return_base64: true`.
4. **Responses / Messages APIs** — `/v1/responses`, `/v1/messages`.
5. **OpenAI Python/Node SDK** — pass `mode`, `aspect_ratio`, `images`,
   `audios`, `videos` through `extra_body`; the SDK merges them to the top
   level of the JSON.

### Known CLI limitations (honest scope)

- No Base64 image output (URL only) and no `return_base64` flag → raw HTTP/SDK.
- No `--audio` / `--video` reference flags and no single-reference-image mode
  (`multivideo` requires ≥2 images) → raw HTTP/SDK.
- No last-frame-only keyframes (`img2video` = first frame only, `keyframes` =
  first+last) → raw HTTP/SDK.
- Image `--seed` is accepted as an undocumented pass-through; do not rely on it.
- Video `1K` is square-only (1024×1024); never combine it with a non-1:1
  `--aspect-ratio`.
- `video poll`/`video get` do not remember the create-time model; always pass the
  matching `--model` (the create output prints it as a hint).
- Only `/chat/completions` is exposed for text; `/responses` and `/messages`
  need raw HTTP.

Example (video with audio reference, direct HTTP):

```bash
curl -sS -X POST "${AGNES_BASE_URL:-https://apihub.agnes-ai.com/v1}/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-2.5",
    "prompt": "Use <Picture 1> as the subject and <Audio 1> for rhythm.",
    "mode": "reference",
    "seconds": "5",
    "size": "720P",
    "aspect_ratio": "16:9",
    "images": ["https://example.com/subject.png"],
    "audios": ["https://example.com/music.mp3"]
  }'
```

## Practical Workflows

### Text verification

1. `agnes text chat --help`
2. `agnes text chat --prompt "Reply with exactly pong." --json`
3. Read `.text` / `.model` from the JSON output.

### Text-to-image

1. `agnes image text2img --help`
2. `agnes image text2img --prompt "..." --size 2K --ratio 16:9 --json`
3. Read `.url` (or `.raw.data[0].url`).

### Image-to-image

1. `agnes image img2img --help`
2. Let the CLI bridge a local path, or pass a public URL.
3. `agnes image img2img --image ./input.png --prompt "..." --json`

### Multi-image composition

1. `agnes image compose --help`
2. Pass `--image` multiple times.
3. `agnes image compose --image ./a.png --image ./b.png --prompt "..." --json`

### Text-to-video

1. `agnes video text2video --help`
2. `agnes video text2video --prompt "..." --seconds 5 --size 720P --json`
3. Capture `videoId` (and the model).
4. `agnes video poll <videoId> --model agnes-video-2.5 --interval 2 --timeout 600 --json`
5. Read `.videoUrl` when `status == "completed"`.

### Image-to-video / keyframes

1. `agnes video img2video --help` or `agnes video keyframes --help`
2. Run the create command with `--json`.
3. Capture `videoId`; poll with `--model` as above.

## JSON Output

Prefer `--json` whenever the command result will be consumed by an agent:

```bash
agnes image text2img --prompt "..." --json
agnes video text2video --prompt "..." --json
agnes video poll video_123 --model agnes-video-2.5 --json
```

This makes it easy to read `taskId`, `videoId`, `model`, image URLs, video URLs
and terminal status, and to detect failures cleanly (`ok: false`, `code`,
`message`).

## Operational Guidance

- Prefer live CLI calls over guessing when the user asks whether a model path
  or parameter works.
- Prefer tier + ratio for images and explicit `--size/--seconds` for video so
  cost is predictable.
- For video results, expect task creation first, then polling; never assume
  synchronous completion.
- Prefer `videoId` + matching `--model` for polling; `taskId` remains
  legacy-compatible.
- For more than one key/account, configure pools first (`agnes accounts
  check --live`), then use `agnes batch` for volume instead of ad-hoc loops.
- Check `agnes accounts list` before blaming a model: a 429/RATE_LIMITED is a
  pool pacing/capacity signal, not an invalid request.
- If the batch has failed jobs, use `agnes batch status <out> --json` then
  `agnes batch retry <out> --only failed`; use `--resume` only with the original
  input file.
- Use the CLI's local-file bridge instead of uploading files manually.
- If the user asks for SDK code, translate the confirmed CLI/HTTP behavior into
  the target language after validating the path.
- If the user asks about pricing, limits, or free access, verify the live docs —
  the current `$0` prices are promotional and time-sensitive.

## Compact Reference

- Base URL: `https://apihub.agnes-ai.com/v1`
- Text endpoint: `/chat/completions` (also `/responses`, `/messages`)
- Image endpoint: `/images/generations`
- Video create: `/videos`
- Video poll (recommended): `/agnesapi?video_id={video_id}&model_name={model}`
- Video legacy poll: `/v1/videos/{task_id}`
- Text model (default): `agnes-2.5-flash` (also `agnes-3.0-flash`, `agnes-2.5-pro`, `agnes-2.5-pro-beta`)
- Image model (default): `agnes-image-2.5-flash` (also `agnes-image-2.1-flash`, `agnes-image-2.0-flash`)
- Video model (default): `agnes-video-2.5` (also `agnes-video-2.5-flash`; `agnes-video-v2.0` retired)
- Multi-account: `agnes accounts list|check [--live]`, `agnes batch run|status|retry`, global `--account`/`--strategy`

## Do Not

- Do not proceed with live Agnes calls when the key is missing
- Do not default to raw `curl` for Agnes execution when the CLI covers the flow
- Do not poll a video task without the matching `--model`
- Do not poll a video task on a different account than the one that created it
  (use the affinity journal or an explicit `--account` you know is correct)
- Do not retry a create request after `AMBIGUOUS_CREATE` without checking the
  account dashboard/manifest first
- Do not assume a flat `defaults.model` applies to every batch job kind; it is
  catalog-filtered per kind. Use `defaultsByKind` or per-job `model` overrides
  when a mixed batch needs specific models.
- Do not present "more keys of the same type" as more capacity; only separate
  pools stack
- Do not print, echo, log, or commit API keys or accounts-file contents; only
  `present (len=N)` / `missing` is safe to show
- Do not claim `accounts check --live` proved a key is valid: `/v1/models`
  answers 200 even for fabricated tokens. Use `--probe text` for a real
  credential proof (one tiny text call per account)
- Do not use `agnes-video-v2.0` or `agnes-2.0-flash` for new work
- Do not send Video 2.5 legacy fields (`width`, `height`, `num_frames`, `frame_rate`, `negative_prompt`)
- Do not send pixel dimensions such as `1280x720` in `size`; use tiers
- Do not put `response_format` at the image request top level
- Do not pass `tags: ["img2img"]`
- Do not trust stale marketing claims over the current API docs
- Do not present `agnes-3.0-pro` as available or the retired 3.0 Flash Max docs as a model

## Safety

- Never echo a full Agnes API key back to the user after it has been supplied
- Never continue with live Agnes requests when auth is missing or clearly invalid
- Never print, log, or commit `AGNES_API_KEY`; in this repo `.env.local` is
  gitignored and must stay mode 600
- Never print an accounts file: it can contain keys. `agnes accounts list/check`
  redacts them; prefer those commands in logs/transcripts
- Multi-account state (`~/.agnes/state`) and batch artifacts contain account
  ids/pools and prompts, not keys; keep them outside the repo and do not share
  them without checking
- Never write the key to a project file unless the user explicitly asks
- Never promise pricing, limits, or "forever free" terms without noting they can
  change over time

## Installation

From the agnes-toolkit repo (recommended):

```bash
npm run install-local   # links the patched CLI and installs this skill
```

With a repository-aware skill installer (upstream-compatible layout):

```bash
npx skills add jomeswang/agnes-ai-skill -g
```

After installation, invoke this skill whenever Agnes setup or Agnes model usage
comes up.

## Version History

- `1.3.0` - Updated for Agnes docs of 2026-10-21 and the patched
  agnes-toolkit CLI: Video 2.5/2.5 Flash contract (create modes, `seconds`,
  `size`, `aspect_ratio`, `model_name` polling, retired v2.0), text defaults
  `agnes-2.5-flash` with `agnes-3.0-flash`/`2.5-pro`/`2.5-pro-beta`, image
  default `agnes-image-2.5-flash`, new `agnes models` command and flags,
  current `wiki.agnes-ai.com` doc links, and raw-HTTP fallbacks for
  references/Base64/Responses/Messages. Maintained copy additionally documents
  the toolkit CLI `0.3.0-local.1` multi-account pools and `agnes batch`
  production workflow (2026-10-23).
- `1.2.2` - Added a linked Chinese README and Chinese quick-start onboarding
  guidance for agent responses.
- `1.2.1` - Made `npx -y agnes-ai-cli@^0.1.0` the default copy-paste execution
  path in fresh environments and kept global `agnes` as an optional fast path.
- `1.2.0` - Switched the skill to CLI-first Agnes execution, removed raw curl
  execution guidance, and made `--help` discovery part of the expected flow.
- `1.1.2` - Added dual-track CLI guidance so agents prefer the separate Agnes
  execution layer when available and keep raw `curl` as the fallback.
- `1.1.0` - Expanded official doc coverage for Image 2.0, Image 2.1, and Video
  2.0 parameters, scenarios, prompt structures, response fields, and task
  states.
- `1.0.0` - Initial public release with Agnes platform setup, persistent auth,
  text, image, and video workflow guidance.
