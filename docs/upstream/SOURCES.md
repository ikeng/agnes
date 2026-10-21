# Upstream sources snapshot

Research date: **2026-10-21** (Asia/Shanghai). All files in this directory are
raw snapshots kept for traceability; the analysis lives in
[`../upstream-research.md`](../upstream-research.md).

## Official documentation (source of truth)

- Docs index: <https://wiki.agnes-ai.com/llms.txt> (also mirrored at `www.agnes-ai.com`)
- Markdown variants: `https://wiki.agnes-ai.com/en/docs/<slug>.md`
  (HTML: `https://agnes-ai.com/en/docs/<slug>`; the old `/doc/<slug>` paths
  redirect to `/en/docs/<slug>`)
- Sitemap: <https://wiki.agnes-ai.com/sitemap.xml>
- Full-text dump: <https://wiki.agnes-ai.com/llms-full.txt> (not archived here)

Fetched pages (copied verbatim into this directory):

| File | Source URL |
| --- | --- |
| `llms.txt` | https://wiki.agnes-ai.com/llms.txt |
| `overview.md` | https://wiki.agnes-ai.com/en/docs/overview.md |
| `quickstart.md` | https://wiki.agnes-ai.com/en/docs/quickstart.md |
| `agnes-25-flash.md` | https://wiki.agnes-ai.com/en/docs/agnes-25-flash.md |
| `agnes-25-pro.md` | https://wiki.agnes-ai.com/en/docs/agnes-25-pro.md |
| `agnes-25-pro-beta.md` | https://wiki.agnes-ai.com/en/docs/agnes-25-pro-beta.md |
| `agnes-30-flash.md` | https://wiki.agnes-ai.com/en/docs/agnes-30-flash.md |
| `agnes-30-pro.md` | https://wiki.agnes-ai.com/en/docs/agnes-30-pro.md |
| `agnes-image-20-flash.md` | https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash.md |
| `agnes-image-21-flash.md` | https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash.md |
| `agnes-image-25-flash.md` | https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash.md |
| `agnes-video-25.md` | https://wiki.agnes-ai.com/en/docs/agnes-video-25.md |
| `agnes-video-25-flash.md` | https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash.md |
| `pricing.md` | https://wiki.agnes-ai.com/en/docs/pricing.md |
| `faqs.md` | https://wiki.agnes-ai.com/en/docs/faqs.md |
| `tokenplan.md` | https://wiki.agnes-ai.com/en/docs/tokenplan.md |

Hidden legacy pages that are **not** listed in `llms.txt` or the sitemap but
still resolve (kept because they document the current deprecation state):

| File | Source URL |
| --- | --- |
| `agnes-20-flash-deprecated.md` | https://wiki.agnes-ai.com/en/docs/agnes-20-flash.md |
| `agnes-30-flash-max-retired.md` | https://wiki.agnes-ai.com/en/docs/agnes-30-flash-max.md |
| `agnes-video-v20-retired.md` | https://wiki.agnes-ai.com/en/docs/agnes-video-v20.md |

## Official GitHub (AgnesAI-Labs)

| Repository | HEAD (2026-10-21) | Last push | Notes |
| --- | --- | --- | --- |
| [AgnesAI-Labs/skills](https://github.com/AgnesAI-Labs/skills) | `99490234b5c5772987714df9b812479027e90cb7` | 2026-09-24 | Official Codex skill `agnes-ai-models`; newest official agent-facing content. |
| [AgnesAI-Labs/AgnesAI-Models](https://github.com/AgnesAI-Labs/AgnesAI-Models) | `8cce32ecb961f4c022ca9db7f9c52b77b3dfe104` | 2026-08-18 | Official gateway/model-catalog repo; still documents the July 2026 catalog (2.0 / v2.0). |
| [AgnesAI-Labs/AgnesCode](https://github.com/AgnesAI-Labs/AgnesCode) | release `1.0.26` (`7e6bc45`) | 2026-07-24 | Official coding-agent CLI, not an image/video generation tool. |
| [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness) | tag `agh-stable-rc1` (`f5efedd`) | 2026-10-21 | Agent runtime/harness, not a generation tool. |
| [AgnesAI-Labs/agnet-skills-cn](https://github.com/AgnesAI-Labs/agnet-skills-cn) | `63e9f7b328bbf6fcb4d6b0cf8abf7b60841f31bc` | 2026-10-16 | Chinese Agent Skills collection; not Agnes-API-specific. |

Raw snapshots of the files this research relies on:

- `official/agnes-ai-models-SKILL.md` — https://github.com/AgnesAI-Labs/skills/blob/main/agnes-ai-models/SKILL.md
- `official/agnes-ai-models-model_catalog.md` — https://github.com/AgnesAI-Labs/skills/blob/main/agnes-ai-models/references/model_catalog.md
- `official/agnes-ai-models-troubleshooting.md` — https://github.com/AgnesAI-Labs/skills/blob/main/agnes-ai-models/references/troubleshooting.md
- `official/agnes-ai-models-agent_compatibility.md` — https://github.com/AgnesAI-Labs/skills/blob/main/agnes-ai-models/references/agent_compatibility.md
- `official/AgnesAI-Labs-skills-README.md` — https://github.com/AgnesAI-Labs/skills/blob/main/README.md
- `official/AgnesAI-Models-MODEL_CATALOG.md` — https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/MODEL_CATALOG.md

## Community CLI / skill used as the local baseline

| Repository | HEAD | Tag / version | npm |
| --- | --- | --- | --- |
| [jomeswang/agnes-ai-cli](https://github.com/jomeswang/agnes-ai-cli) | `9e629302cf30898d09f60fb2ba3e52e795b7ccf4` | `v0.1.6` (2026-08-10) | `agnes-ai-cli@0.1.6`, published 2026-08-10T07:01:45Z |
| [jomeswang/agnes-ai-skill](https://github.com/jomeswang/agnes-ai-skill) | `7e263a435a9177da7a4f5d81ff55d85c18e44acc` | `1.2.2` (2026-06-13) | — |

- `jomeswang-agnes-ai-skill-v1.2.2-SKILL.md` is the raw SKILL.md used for the gap analysis.
- npm registry metadata: <https://registry.npmjs.org/agnes-ai-cli>
- npm tarball inspected: `https://registry.npmjs.org/agnes-ai-cli/-/agnes-ai-cli-0.1.6.tgz`

## Other npm packages checked (none is an official generation tool)

- `@agnes-ai/agnes-cli@0.0.4` (2026-06-12) — community package by `constantine1916`,
  repository `Constantine1916/agnes-cli`; not published by Agnes.
- `agnes-ai-skill@1.0.0` (2026-06-30) — third-party npm bundle (`Selenium39/agnes-ai-skill`).
- Numerous third-party DSH/pi/MCP plugins exist; none is referenced by the
  official docs as a supported tool.
