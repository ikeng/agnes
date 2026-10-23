# Upstream provenance

This directory is the project's maintained copy of the Agnes AI skill. It is
installed into local agent skill directories by `scripts/install-local.sh`.

- Upstream repository: <https://github.com/jomeswang/agnes-ai-skill>
- Vendored commit: `7e263a435a9177da7a4f5d81ff55d85c18e44acc` (2026-06-13)
- Vendored version: `1.2.2`
- Vendored on: 2026-10-21
- Maintained version: **1.4.0** (see `SKILL.md` → Version History)
- Official reference for the update: <https://github.com/AgnesAI-Labs/skills>
  (`agnes-ai-models` skill, HEAD `99490234b5c5772987714df9b812479027e90cb7`,
  2026-09-24) + the official docs snapshot in `../../docs/upstream/`.

## Local changes vs upstream 1.2.2

- `SKILL.md`: rewritten for the 2026-10-21 docs — text `agnes-2.5-flash`
  default (+`agnes-3.0-flash`/`2.5-pro`/`2.5-pro-beta`), image
  `agnes-image-2.5-flash` default, Video 2.5/2.5 Flash create + poll contract
  (`mode`/`seconds`/`size`/`aspect_ratio`/`model_name`), retired v2.0, new
  `agnes models` command and CLI flags, current `wiki.agnes-ai.com` doc links,
  raw-HTTP fallbacks, safety/pricing caveats.
- `SKILL.md`: 2026-10-23 multi-account + batch sections — `agnes accounts
  list/check` (models vs `--probe text` credential proof), account pools,
  routing limits/429 handling, create→poll/session affinity, and
  `agnes batch run|status|retry` (kind-aware defaults, `defaultsByKind`,
  `modelSource`, record vs strict, resume/retry). Version bumped to `1.4.0`.
- `README.md`: rewritten as a maintained-copy README (current models, patched
  CLI, current sources, pricing caveats). The upstream 2.0-era showcase text is
  kept only as a pointer to `assets/` and `examples/` historical samples.
- `README.zh-CN.md`: banner + current model/CLI guidance.
- `scripts/agnes-media-url.sh`: prefers `agnes media url` and keeps the
  Litterbox upload only as a legacy fallback; validates `ttl`.
- `agents/openai.yaml`, `LICENSE`, `examples/`,
  `docs/superpowers/specs/` and `scripts/extract_first_frames.swift` are
  unchanged upstream content (the design specs are historical).
- **Upstream showcase media omitted** to keep the toolkit repo lean:
  `assets/videos/`, `assets/video-previews/`, `assets/apps/` and the large
  `assets/images/*` files are not vendored (only the referenced
  `assets/images/agnes-frontier-models-banner.jpg` hero remains). See upstream
  <https://github.com/jomeswang/agnes-ai-skill> for the original assets.

## Updating

1. Fetch upstream: `git -C <clone> fetch origin && git -C <clone> log -1 --oneline`.
2. Diff `SKILL.md`, `README.md`, `scripts/` against this copy.
3. Re-apply the local documentation changes above and re-run the project checks
   (`npm test` at repo root, or `node --test` for offline CLI tests).
4. Update the version in `SKILL.md` and this file.

The patched CLI lives in `../../cli/`; keep model IDs in sync with
`../../cli/src/models.ts` and `../../docs/upstream-research.md`.
