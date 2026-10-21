# Upstream provenance

This directory vendors the **official** Agnes AI model-integration skill from
the `AgnesAI-Labs` GitHub organization. It is copied verbatim and is **not**
modified by agnes-toolkit (do not rewrite its defaults).

- Repository: <https://github.com/AgnesAI-Labs/skills>
- Skill path: `agnes-ai-models/`
- Commit: `99490234b5c5772987714df9b812479027e90cb7` (2026-09-24 16:54 +0800,
  "docs: align model reference defaults")
- Vendored on: 2026-10-21
- Upstream tags/releases: none (single `main` branch)
- Upstream license: **no LICENSE file** is published in the upstream repo at
  this commit. Treat the files as reference/integration material from the
  official AgnesAI-Labs repository; if a license is published later, update
  this note and copy it in.

## Files

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Official skill: defaults `agnes-2.5-flash` / `agnes-image-2.5-flash` / `agnes-video-2.5`(+flash), regional endpoint routing, polling with `video_id + model_name`, OpenAI SDK patterns. |
| `references/model_catalog.md` | Model reference, limits, billing notes (last updated 2026-09-24). |
| `references/troubleshooting.md` | Status codes, image/video troubleshooting. |
| `references/agent_compatibility.md` | Codex / OpenClaw / Hermes / Manus / custom-agent setup. |
| `agents/openai.yaml` | Codex skill interface metadata. |
| `scripts/smoke_chat.py` | Optional live chat smoke test (reads `AGNES_API_KEY` from env; no secrets embedded). |

## Why keep both skills

- `skill/agnes-ai-models/` — official integration/reference skill (API-first,
  OpenAI SDK/curl, model catalog). Use when the task is *direct API integration*
  or you need the official reference wording.
- `skill/agnes-ai-skill/` — CLI-first skill maintained by this repo for the
  patched `agnes` CLI. Use when the task is to *execute* text/image/video work
  locally from an agent.

## Updating

```bash
git -C /tmp/agnes-research/official-skills fetch origin
git -C /tmp/agnes-research/official-skills checkout <new-commit>
rsync -a --exclude '.git' /tmp/agnes-research/official-skills/agnes-ai-models/ skill/agnes-ai-models/
```

Then update the commit/date above and re-run the project checks. Do not edit the
vendored files unless the upstream change requires a compatibility note —
prefer documenting deltas in this file.
