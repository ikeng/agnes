# Agnes skills

This directory contains the two Agnes AI skills consolidated by the
agnes-toolkit repo. Both are installed/updated by
[`scripts/install-local.sh`](../scripts/install-local.sh) (`npm run install-local`
at the repo root).

| Skill | Source | Use when |
| --- | --- | --- |
| [`agnes-ai-skill/`](./agnes-ai-skill/) | Maintained in this repo (base: `jomeswang/agnes-ai-skill` 1.2.2 → **1.3.0**) | You want an agent to **execute** Agnes text/image/video work through the patched `agnes` CLI. This is the CLI-first skill for this project. |
| [`agnes-ai-models/`](./agnes-ai-models/) | Vendored **official** skill from [`AgnesAI-Labs/skills`](https://github.com/AgnesAI-Labs/skills) at `99490234` (2026-09-24) | You need official **API integration** guidance: OpenAI SDK/curl patterns, model catalog, regional endpoint routing, troubleshooting. |

## Which one should an agent load?

- Default for local execution in this repo: **`agnes-ai-skill`**. It knows about
  the patched CLI (`agnes models`, Video 2.5 `--seconds/--size/--aspect-ratio`,
  `video poll --model`, image `--ratio`) and the known CLI limitations
  (audio/video references and Base64 image output need raw HTTP).
- Use **`agnes-ai-models`** when writing integration code for another app, or
  when you want the official reference wording for parameters/endpoints and
  error handling. It is API-first and does not assume the CLI is installed.
- Both agree on the defaults: `agnes-2.5-flash`,
  `agnes-image-2.5-flash`, `agnes-video-2.5` / `agnes-video-2.5-flash`.
  `agnes-video-v2.0` is retired (2026-09-25); `agnes-2.0-flash` is deprecated.

## Install

```bash
# from the repo root
npm run install-local

# or install both skills directly from GitHub (project scope; add -g for user scope)
npx skills add ikeng/agnes -s '*' -y
npx skills add ikeng/agnes -g -s agnes-ai-skill -y
```

The installer (`scripts/install-local.sh`) builds/links the patched CLI, then
symlinks both skills into `~/.agents/skills/`:

- `~/.agents/skills/agnes-ai-skill` → `skill/agnes-ai-skill/`
- `~/.agents/skills/agnes-ai-models` → `skill/agnes-ai-models/`
- `~/.agents/skills/agnes-ai-generation` → `skill/agnes-ai-skill/`
  (compatibility alias that repairs the dangling
  `agnes-ai-generation` links under `~/.claude/skills/` and
  `~/.config/{devin,crush,goose}/skills/`)

It backs up anything it replaces and prints rollback instructions. Agent tools
that scan `~/.claude/skills`, `~/.config/devin/skills`, `~/.config/crush/skills`
or `~/.config/goose/skills` see the repaired links through the alias.

Manual use:

- Codex: `~/.codex/skills/<skill-name>`
- Claude Code: `~/.claude/skills/<skill-name>`
- Cursor: `~/.cursor/skills/<skill-name>`

## Maintenance

- `agnes-ai-skill/UPSTREAM.md` — upstream base commit, local changes, update
  procedure.
- `agnes-ai-models/UPSTREAM.md` — official upstream commit + no-LICENSE note.
- Model IDs must stay in sync with [`../cli/src/models.ts`](../cli/src/models.ts)
  and [`../docs/upstream-research.md`](../docs/upstream-research.md).
- Docs snapshot (2026-10-21): [`../docs/upstream/`](../docs/upstream/SOURCES.md).
