# Agnes AI Text, Image & Video Generation Skill

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skill-SKILL.md-blue)](./SKILL.md)
[![Models](https://img.shields.io/badge/models-text%20%7C%20image%20%7C%20video-black)](https://wiki.agnes-ai.com/llms.txt)
[![Agnes AI](https://img.shields.io/badge/platform-Agnes%20AI-ff6b3d)](https://platform.agnes-ai.com/)
[![Chinese README](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-blue)](./README.zh-CN.md)

> **Maintained copy.** This skill lives in the **agnes-toolkit** repo
> (`skill/agnes-ai-skill/`) and is the project's source of truth. It is installed
> by `npm run install-local` (see `scripts/install-local.sh`) together with the
> patched CLI in `cli/`. If you are reading the upstream
> `jomeswang/agnes-ai-skill` repository, use this copy's `SKILL.md` for current
> model IDs and Video 2.5 behaviour.
>
> Docs snapshot used for this version: **2026-10-21**, https://wiki.agnes-ai.com/llms.txt

Agnes AI Skill is a multimodal Agent Skill for Codex, Claude Code, OpenClaw,
Claude Desktop, Hermes, WorkBuddy, Cherry Studio, Opencode and other
SKILL.md-compatible tools. It teaches agents to use the patched `agnes` CLI for
text generation, image generation/editing, text-to-video, image-to-video and
keyframe video generation through a single root `SKILL.md`.

中文：Agnes AI 文本 / 生图 / 图片编辑 / 生视频 Agent Skill，模型与命令已按
2026-10-21 官方文档更新；本副本由 agnes-toolkit 仓库维护。

## Quick Start

From the agnes-toolkit repo:

```bash
npm run install-local   # builds + links the patched CLI and installs this skill
agnes models            # show the current model catalog
agnes auth check        # verify the configured credential(s) (never prints keys)
agnes accounts list     # redacted multi-account pool view
```

For a standalone (non-agnes-toolkit) setup, a repository-aware installer can
still install the **upstream** copy with `npx skills add jomeswang/agnes-ai-skill -g`
— but that copy's `SKILL.md` is the older 1.2.2 version. To install *this*
maintained copy, use the agnes-toolkit `npm run install-local` path above, or
copy/symlink this directory into your agent's skill directory manually (see
[Manual Install](#manual-install)).

Create an Agnes API key at
[platform.agnes-ai.com/settings/apiKeys](https://platform.agnes-ai.com/settings/apiKeys)
and configure it as `AGNES_API_KEY` (or put it in `.env.local` in the
agnes-toolkit repo). Then ask the agent to `generate an image`,
`generate a video`, `edit this image`, or `integrate Agnes API`.

This skill helps agents:

- set up Agnes AI and persist an `AGNES_API_KEY` safely
- use `agnes-2.5-flash` (default) or `agnes-3.0-flash` for chat, coding,
  streaming, tool calling, and agent workflows
- use `agnes-image-2.5-flash` for image generation, editing, and multi-image
  composition
- use `agnes-video-2.5` / `agnes-video-2.5-flash` for text-to-video, keyframes,
  image references, and asynchronous polling
- prefer the patched `agnes-ai-cli` for live requests
- fall back to raw HTTP only for audio/video references, Base64 image output,
  last-frame-only keyframes, and the Responses/Messages APIs

Compatible tools: Codex, Claude Code, Claude Desktop, OpenClaw, Hermes,
WorkBuddy, Cherry Studio, Opencode, Kimi Work, and other Agent Skills /
SKILL.md-compatible environments.

![Agnes AI frontier models hero](./assets/images/agnes-frontier-models-banner.jpg)

## Current Models (docs checked 2026-10-21)

| Workflow | Default | Also available | Notes |
| --- | --- | --- | --- |
| Text | `agnes-2.5-flash` | `agnes-3.0-flash`, `agnes-2.5-pro`, `agnes-2.5-pro-beta` | `agnes-2.0-flash` deprecated; `agnes-3.0-pro` coming soon |
| Image | `agnes-image-2.5-flash` | `agnes-image-2.1-flash`, `agnes-image-2.0-flash` | size tiers `1K/2K/3K/4K` + `ratio`; currently free |
| Video | `agnes-video-2.5` | `agnes-video-2.5-flash` | `agnes-video-v2.0` retired 2026-09-25; Flash is 720P-only and currently free |

Full details, parameters, limits, and gotchas:
[`SKILL.md`](./SKILL.md).

## Companion CLI

The skill targets the **patched** CLI vendored in the agnes-toolkit repo:

- repo: `cli/` (upstream `jomeswang/agnes-ai-cli` v0.1.6 + local patches,
  `0.3.0-local.1`)
- install: `npm run install-local` (or `cd cli && npm install && npm run build && npm link`)
- catalog: `agnes models [--json]`
- fallback only: `npx -y agnes-ai-cli@^0.1.0` — this is the stale upstream
  0.1.6 build; it does **not** support Video 2.5, image 2.5 defaults,
  multi-account routing, or `agnes batch`

The patched CLI adds:

- current model catalog and defaults (`src/models.ts`)
- `agnes models` command
- image 2.5 support, default size, and `--ratio`
- Video 2.5 create flags: `--model`, `--seconds`, `--size`, `--aspect-ratio`,
  `--n`
- Video 2.5 polling via `video_id + model_name` (`video get` / `video poll` now
  accept `--model`)
- explicit legacy Video v2.0 path only when `--model agnes-video-v2.0` is used
- **multi-account routing** (`0.3.0-local.1`): indexed `AGNES_ACCOUNT_<ID>_*`
  env or an accounts file, pools, adaptive/round-robin/weighted/
  least-inflight/primary strategies, client-side RPM presets, 429 cooldowns,
  safe failover, create→poll affinity journal, and `agnes accounts
  list/check [--live]`
- **batch production** (`0.3.0-local.1`): `agnes batch run/status/retry` with
  JSON/JSONL jobs, bounded concurrency, `record`/`strict` consistency,
  manifest/events/results artifacts, and resume without duplicate creates

## Multi-account And Batch Production

The patched CLI `0.3.0-local.1` can route across several Agnes accounts and run
reproducible batch jobs. Skills/agents should use the CLI rather than re-implement
rate-limit or affinity logic:

```bash
agnes accounts list               # redacted: key shown only as present (len=N)
agnes accounts check --live       # GET /models reachability (free, NOT a credential proof)
agnes accounts check --live --probe text  # real credential proof (one tiny chat per account)
agnes --account main image text2img --prompt "..."        # force one account
agnes --strategy round-robin image text2img --prompt "..." --json
agnes image text2img --prompt "..." --affinity campaign-42 # sticky session
agnes batch run jobs.json --out ./out
agnes batch status ./out --json
agnes batch retry ./out --only failed
```

Key rules this skill teaches agents:

- Same-type keys on one account do **not** add rate limit; only distinct
  accounts or key types are separate pools. Group keys that share a pool with
  `POOL`.
- `record` consistency (default) may mix accounts and records provenance per
  job; `strict` pins one account for the whole batch (use when comparable output
  matters).
- A video task must be polled on the account that created it; the affinity
  journal does this automatically (`video get/poll` never rotate accounts).
- 429 is pool-level and handled by the CLI (`Retry-After`, cooldown, safe
  failover for creates). `AMBIGUOUS_CREATE` is never auto-retried; check the
  dashboard first.
- Batch defaults are kind-aware (`defaultsByKind`; flat `defaults.model` is
  catalog-filtered per kind) and each job records `model`/`modelSource`. Invalid
  job params fail as non-retryable `INVALID_JOB`.
- `--resume` skips succeeded jobs without duplicate creates and refuses changed
  input.
- Never print/echo keys or accounts-file contents; only
  `present (len=N)` / `missing` is safe to show.

Full CLI reference: `cli/README.md`. Detailed workflow and commands:
[`SKILL.md`](./SKILL.md#multi-account-pools-and-batch-production-2026-10).



## Install

### From the agnes-toolkit repo (recommended)

```bash
npm run install-local
```

This links the patched CLI as `agnes` and installs this skill into the local
agent skill directories (the installer keeps backups and prints rollback steps).

### Standalone

With a repository-aware skills installer:

```bash
npx skills add jomeswang/agnes-ai-skill -g
```

Because this repository uses a single root `SKILL.md`, installers that support
repository-root skills can discover it directly. The agnes-toolkit installer
installs `skill/agnes-ai-skill/` instead, which contains the updated content.

## Showcase

The upstream skill bundles showcase images/videos generated with earlier model
generations (Image 2.1, Video v2.0). **Those media files are omitted from this
toolkit repo to keep it lean** (only the small README hero image is kept); the
original assets live in the upstream repository:
<https://github.com/jomeswang/agnes-ai-skill>.

- Single-file HTML app examples are still included: `examples/apps/`
- To regenerate current-quality samples use `agnes-image-2.5-flash` /
  `agnes-video-2.5` with the prompt recipes from the upstream README.

## Why Agnes

Agnes is most interesting when one workflow needs all three layers together:

- text for planning, coding, prompting, and agent loops
- image for marketing, e-commerce, and creative visual generation
- video for storyboards, product demos, motion tests, and short-form content

The platform is OpenAI-compatible, so existing OpenAI-style clients usually need
only a base URL, API key, and model name change.

## What It Does

- Platform and auth flow from the Agnes quickstart docs
- API key creation via the Agnes platform settings page
- Persistent `AGNES_API_KEY` setup for future sessions
- OpenAI-style request patterns for text and image endpoints
- Asynchronous Video 2.5 create → poll workflow
- Practical use cases reinforced by the supplied public writeups

## Pricing / Operational Caveats

- `agnes-2.5-flash`, `agnes-3.0-flash`, all image models, and
  `agnes-video-2.5-flash` are currently **$0** in published promotions.
- `agnes-2.5-pro` and `agnes-2.5-pro-beta` are paid per token.
- `agnes-video-2.5` is billed per output second (720P $0.025/s, 1080P/1K
  $0.040/s, 2K $0.055/s; input video seconds add to billable duration).
- Promotions, quotas, RPM limits and prices can change independently of the API
  — verify at https://wiki.agnes-ai.com/en/docs/pricing and
  https://wiki.agnes-ai.com/en/docs/tokenplan before promising cost.

## Safety Model

- The skill checks for `AGNES_API_KEY` before live requests
- If the key is missing, it points the user to the official Agnes quickstart and
  API key page instead of guessing
- If the user provides a key and wants it remembered, the skill persists
  `AGNES_API_KEY` in the correct shell rc file for future sessions
- In the agnes-toolkit repo the key belongs in `.env.local` (gitignored,
  mode 600) and is never printed, logged, or committed
- Live payloads and response handling stay grounded in the official Agnes docs
  and real API behaviour, not only in marketing copy
- Multi-account keys are treated as secrets too: agents may inspect redacted
  `agnes accounts list/check` output but never print key material or accounts
  files

## Manual Install

Copy this directory into any standard skills location supported by your agent,
for example:

- Codex: `~/.codex/skills/agnes-ai-skill`
- Claude Code: `~/.claude/skills/agnes-ai-skill`
- Cursor: `~/.cursor/skills/agnes-ai-skill`

## What Agents Learn

- How to detect missing Agnes auth before making live calls
- How to guide the user to create an API key
- How to persist `AGNES_API_KEY` in shell startup files for future sessions
- How to choose between current Agnes text, image, and video models
- How to make the smallest reliable live request first
- How to create a Video 2.5 task, then poll with `video_id + model_name` until
  completion
- How to configure and inspect multi-account pools, route/pin accounts, and run
  resumable batch production jobs with the patched CLI
- Why create→poll affinity and `strict` consistency matter for mixed-account
  batches
- Which paths need raw HTTP (audio/video references, Base64 image output,
  last-frame-only keyframes, Responses/Messages APIs)

## Discovery Notes

- Upstream repository: [jomeswang/agnes-ai-skill](https://github.com/jomeswang/agnes-ai-skill)
- Official skill repository: [AgnesAI-Labs/skills](https://github.com/AgnesAI-Labs/skills)
- This maintained copy: agnes-toolkit repo, `skill/agnes-ai-skill/`

## Primary Sources

- Docs index: https://wiki.agnes-ai.com/llms.txt
- Quickstart: https://wiki.agnes-ai.com/en/docs/quickstart
- API key settings: https://platform.agnes-ai.com/settings/apiKeys
- Text — 2.5 Flash: https://wiki.agnes-ai.com/en/docs/agnes-25-flash
- Text — 3.0 Flash: https://wiki.agnes-ai.com/en/docs/agnes-30-flash
- Text — 2.5 Pro: https://wiki.agnes-ai.com/en/docs/agnes-25-pro
- Text — 2.5 Pro Beta: https://wiki.agnes-ai.com/en/docs/agnes-25-pro-beta
- Image — 2.5 Flash: https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash
- Image — 2.1 Flash: https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash
- Image — 2.0 Flash (legacy): https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash
- Video — 2.5: https://wiki.agnes-ai.com/en/docs/agnes-video-25
- Video — 2.5 Flash: https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash
- Video — v2.0 (retired): https://wiki.agnes-ai.com/en/docs/agnes-video-v20
- Pricing: https://wiki.agnes-ai.com/en/docs/pricing
- Token Plan / RPM: https://wiki.agnes-ai.com/en/docs/tokenplan

## Notes

- The upstream README's June 2026 "2.0 full-modal APIs free" announcement is
  historical. Model IDs and free-access details have changed; use the current
  docs listed above.
- ClawHub publishing requires a separate ClawHub login or publish token plus a
  GitHub OAuth grant.
- This repository is released under the MIT License.

## Version History

The skill version (`1.3.0`) and detailed change log are in
[`SKILL.md`](./SKILL.md#version-history).
