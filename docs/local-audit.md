# Local Agnes tooling audit — CLI, skills, provenance, defects

- **Auditor:** cli-auditor (shared task `task-2`)
- **Date / host:** 2026-10-21 ~11:31–11:52 (Asia/Shanghai), macOS, Node v22.22.3, npm 10.9.8
- **Workspace:** `/Users/mac/Documents/research/agnes` (a new `cli/` build exists as of this audit; `skill/`, `scripts/`, `tests/` were still empty while auditing)
- **Scope:** local global install, npm/GitHub provenance, local skill install and helper scripts, live/offline behavioral tests, docs requirements that determine defects. Full docs research is owned by docs-researcher (`docs/upstream-research.md`); this file cites only the doc pages needed to classify local defects.
- **Cost discipline honored:** only cheap text-chat pings. **No live image or video generation was performed.** The only remote uploads were one 64×64 test PNG (3,992 bytes) to temporary image hosts.
- **Secret handling:** the API key was read only via `grep -m1 '^AGNES_API_KEY=' .env.local | cut -d= -f2-` and exported per command. It is never printed here. Masking used below: `<KEY:len=51, sk-…>`.

> **Reading note for the current round:** the global `/usr/local/bin/agnes` is still the old **0.1.6** build; the patched project CLI (`cli/`, **0.2.0-local.1**) is built but not linked globally until `scripts/install-local.sh` runs. Defects marked *(fixed in project CLI)* refer to `cli/` as of 11:38, not to the global binary.

---

## 1. Inventory of local Agnes assets

### 1.1 Assets and versions

| Asset | Path | Version / identity | Hash / commit | Status |
|---|---|---|---|---|
| Global `agnes` launcher | `/usr/local/bin/agnes` → `../lib/node_modules/agnes-ai-cli/bin/agnes.js` | n/a (symlink) | — | ✅ resolves |
| Global npm CLI package | `/usr/local/lib/node_modules/agnes-ai-cli` | `agnes-ai-cli@0.1.6` (installed 2026-10-18 18:55), **locally hot-patched** | package.json `3a93d90a…c1029`; `dist/cli.js` `0e5eb652…dfb`; `dist/image/normalizeImageRequest.js` `d07e8fed…ef6` | ⚠️ legacy; text default 2.0 broken, video v2.0 only; image 2.5 works because of patch |
| Published npm tarball | `/tmp/agnes-ai-cli-0.1.6.tgz` (also `/tmp/agnes-research/npm/…`) | `agnes-ai-cli@0.1.6`, latest on npm (published 2026-08-10T07:01:45Z) | sha256 `05965f6a…22ebc` | ✅ public release; no 2.5 image, hardcoded `--version 0.1.0` |
| Upstream GitHub clone | `/tmp/agnes-research/cli` | `main`, HEAD = tag `v0.1.6`, commit `9e62930` (merge PR #9); `origin/main` identical, no newer commit | `9e629302cf30898d09f60fb2ba3e52e795b7ccf4` | ✅ clean; same behavior as tarball |
| Project patched CLI (new) | `<repo>/cli` | `0.2.0-local.1`, built `dist/`, 9+ test files / 74 tests passing (final build) | `node cli/bin/agnes.js --version` → `0.2.0-local.1` | ✅ built, **not yet installed** |
| Installed skill | `~/.agents/skills/agnes-ai-skill` | `SKILL.md` frontmatter `version: 1.2.2`; content byte-identical to upstream HEAD (no `.git`) | upstream HEAD `7e263a4` (2026-06-13) | ⚠️ stale model/CLI guidance |
| Upstream skill clone | `/tmp/agnes-research/skill` | HEAD `7e263a4` "Document video_id polling for Agnes videos"; `origin/main` identical | `7e263a435a9177da7a4f5d81ff55d85c18e44acc` | ✅ clean, stale vs current docs |
| Project skill (planned source of truth) | `<repo>/skill/agnes-ai-skill` | not present yet (task-4, blocked on docs research) | — | ⏳ pending |
| Skill helper scripts | `~/.agents/skills/agnes-ai-skill/scripts/agnes-media-url.sh`, `extract_first_frames.swift` | shipped in 1.2.2 | 41 / 75 lines | ⚠️ orphaned/undocumented; litterbox hardcoded; swift is macOS-only |
| Dangling skill links | 11 paths listed in §1.3 | target `~/.agents/skills/agnes-ai-generation` **missing** | skill-lock source `yacey/agnes-ai-generation-skill`, installed 2026-07-05 | ❌ broken |
| API key material | `.env.local` (mode 600) + `~/.zshrc`, `~/.bashrc`, `~/.profile` (mode 600) | 1 entry each, value length 51, prefix `sk-` | — | ✅ valid (live text 2.5/3.0 returned 200) |
| Temp image hosts | litterbox / tmpfiles / uguu / x0.at | external services probed 2026-10-21 | — | ⚠️ mixed (uguu/x0 work; see §4.4) |

### 1.2 Key material (masked)

- `.env.local`: `AGNES_API_KEY=<KEY:len=51, sk-…>`, file mode `600`; gitignored.
- `~/.zshrc`, `~/.bashrc`, `~/.profile`: each has exactly one `export AGNES_API_KEY='<KEY:len=51>'`, modes `600`.
- The shell used for this audit did **not** inherit the key (`$AGNES_API_KEY` empty until explicitly exported), which is exactly why the missing `.env.local` autoload matters for agent-driven commands.
- `agnes auth check --json` returned `{ok:true, configured:true, source:"env"}` when the key was exported; `{ok:false, …}` under `env -i` (see issue LOC-08). No key rotation is needed; no key was exposed.

### 1.3 Symlink health (all checked with `test -e` on resolved target)

All of these are symlinks whose resolved target `~/.agents/skills/agnes-ai-generation` does **not** exist (the real folder was removed after installation; `.skill-lock.json` still records it from GitHub `yacey/agnes-ai-generation-skill`, `installedAt: 2026-07-05T04:49:14.724Z`, hash `e41a0120…`):

| Path | Link target | Status |
|---|---|---|
| `~/.claude/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (as originally reported) |
| `~/.config/devin/skills/agnes-ai-generation` | `../../../.agents/skills/agnes-ai-generation` | ❌ dangling (as originally reported) |
| `~/.config/crush/skills/agnes-ai-generation` | `../../../.agents/skills/agnes-ai-generation` | ❌ dangling (as originally reported) |
| `~/.config/goose/skills/agnes-ai-generation` | `../../../.agents/skills/agnes-ai-generation` | ❌ dangling (as originally reported) |
| `~/.junie/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |
| `~/.mux/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |
| `~/.qwen/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |
| `~/.openhands/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |
| `~/.pochi/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |
| `~/.trae-cn/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |
| `~/.codemaker/skills/agnes-ai-generation` | `../../.agents/skills/agnes-ai-generation` | ❌ dangling (extra) |

The live skill `agnes-ai-skill` is **not** symlinked from any of those agent directories; only the stale/dangling `agnes-ai-generation` name is exposed there. This is a duplicate-skill identity problem, not just link rot: an agent scanning `~/.claude/skills` sees `agnes-ai-generation` (broken) instead of `agnes-ai-skill`.

---

## 2. Provenance finding — installed dist vs npm tarball vs GitHub tag source

### 2.1 Evidence chain

1. **npm registry:** latest `agnes-ai-cli` is **0.1.6**, published **2026-08-10T07:01:45Z**; versions 0.1.0–0.1.6 only; no 0.2.x.
2. **GitHub:** `jomeswang/agnes-ai-cli` `main` HEAD is **exactly tag `v0.1.6`**, commit `9e629302cf30898d09f60fb2ba3e52e795b7ccf4`; a `git fetch` + `git log HEAD..origin/main` shows **zero newer commits**. Tag source `src/image/normalizeImageRequest.ts` allows only `agnes-image-2.1-flash`/`agnes-image-2.0-flash` and defaults to **2.1**; `src/cli.ts:14` hardcodes `.version("0.1.0")`.
3. **npm tarball 0.1.6** (`npm pack`, extracted under `/tmp/agnes-tarball-016`) reproduces the tag source behavior: image enum `2.1/2.0`, default **2.1**, `--version` → `0.1.0`.
4. **Installed global dist** differs from that tarball in **exactly 3 compiled files** (`diff -rq`; all other dist files and `bin/agnes.js` are byte-identical):
   - `dist/cli.js` — sha256 `0e5eb652…` vs tarball `3b7502d7…`: reads version from `package.json` (`createRequire`), adds a comment that `--version` used to report `0.1.0`, and changes the image `--help` text from `agnes-image-2.1-flash` to `agnes-image-2.5-flash`.
   - `dist/image/normalizeImageRequest.js` (+ `.d.ts`) — sha256 `d07e8fed…` vs tarball `ae953e86…`: adds exported `IMAGE_MODELS = ["agnes-image-2.5-flash","agnes-image-2.1-flash","agnes-image-2.0-flash"]` and `DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash"` (used by all three image modes), with a comment that the duplicated per-mode enums previously rejected 2.5 client-side.
   - No source `.ts` files are shipped in the global install; the patched source has not been found in any public upstream branch/tag or npm release (a search of `/tmp` scratch dirs found no matching source either).

### 2.2 Why the installed image normalize supports 2.5 while the tag source doesn't

The installed global package is **`agnes-ai-cli@0.1.6` plus a local hotfix overlay** (same `package.json`, same version, same 20 untouched dist files), not a newer upstream release. The hotfix added Image 2.5 support and fixed `--version`; upstream GitHub (main == tag v0.1.6) and the npm tarball never received those changes. `npm install -g agnes-ai-cli@0.1.6` on any other machine therefore installs a build **without** 2.5 image support and with a lying `--version` — which is why the current machine's behavior cannot be reproduced from public artifacts.

### 2.3 Verdict

- **Modified:** yes — installed dist ≠ published tarball ≠ GitHub source; 3 files patched.
- **Newer:** newer *behavior* (2.5 image, correct version string), but same upstream version number and no upstream commit; upstream itself has no newer release.
- **Unpublished:** yes — the patch exists only in `/usr/local/lib/node_modules/agnes-ai-cli` (installed 2026-10-18) and is not on npm/GitHub.
- **Superseded:** the project `cli/` build (`0.2.0-local.1`, vendored from upstream `9e62930` + documented patches, 74 tests) is now the canonical artifact; `scripts/install-local.sh` is the intended way to replace the global package (with backup). Until then the misleading global 0.1.6 remains on `PATH`.
- **Skill provenance:** `~/.agents/skills/agnes-ai-skill` v1.2.2 is byte-identical to upstream `jomeswang/agnes-ai-skill` HEAD `7e263a4` (2026-06-13), i.e. locally unmodified but stale relative to current docs (2.5/3.0 text models, Image 2.5, Video 2.5 and v2.0 retirement, all after 2026-06-13).

---

## 3. Issues table

Severity: **Critical** = primary workflow broken; **High** = important workflow broken or non-reproducible; **Medium** = degraded behavior/risk; **Low** = hygiene/cosmetic.
All repro commands assume `AGNES_API_KEY="$KEY"` exported from `.env.local` (key never echoed). “Installed dist” = the globally installed 0.1.6 patched build.

| ID | Sevr | Symptom | Repro | Expected → Actual | Root cause | Target fix |
|---|---|---|---|---|---|---|
| LOC-01 | Critical | Default text chat fails; default model is a deprecated model that is currently unavailable | `agnes text chat --prompt "Reply with exactly: pong" --json` | default `agnes-2.5-flash` → CLI sends `agnes-2.0-flash`; live **HTTP 500** `get_channel_failed` ("Model agnes-2.0-flash is temporarily unavailable") | installed `dist/cli.js:101` (`"agnes-2.0-flash"`) and `dist/text/complete.js:6` (schema default); docs say 2.0 is deprecated (`agnes-25-flash.md:31,41,119`; quickstart uses 2.5) | *(fixed in project CLI)* default `agnes-2.5-flash` in `cli/src/models.ts` + `text/complete.ts`; keep 2.0 explicit-only with deprecation note |
| LOC-02 | Critical | Video generation cannot work with the current API at all: CLI only speaks retired v2.0 | `agnes video text2video --help` then offline payload inspect; live create intentionally not run | v2.0 create payload with `model:"agnes-video-v2.0"` + `width/height/num_frames/frame_rate` → docs: v2.0 **retired 2026-09-25**, 2.5 create uses `model:"agnes-video-2.5"` + `mode/seconds/size/aspect_ratio` (+ `first_frame`/`last_frame`/`images`) | installed `dist/video/normalizeVideoRequest.js:39` hardcodes model; `dist/cli.js:319-355` has no `--model` for video; old params in `buildVideoGenerateCommand` | *(fixed in project CLI)* `cli/src/video/normalizeVideoRequest.ts` emits 2.5 contract by default, v2.0 legacy only with `--model agnes-video-v2.0`; new `--seconds/--size/--aspect-ratio/--n`; map `img2video→keyframe` (`first_frame`), `multivideo→reference` (`images`), `keyframes→first/last` exactly 2 |
| LOC-03 | High | Video polling URL has no `model_name`; keyframe/reference 2.5 tasks cannot be fetched | Offline capture: `getVideo("video_abc")` with mock fetch | `…/agnesapi?video_id=video_abc&model_name=agnes-video-2.5` → actual `…/agnesapi?video_id=video_abc` (no `model_name`); no `--model` flag on `video poll`; docs require `model_name` for keyframe/reference and recommend it for every mode (`agnes-video-25.md:11,23,101,311-324,506`; flash variant `agnes-video-25-flash.md:23,89,287`) | installed `dist/video/getVideo.js:62-68` (`buildVideoGetUrl`); `dist/video/pollVideo.js:11` calls `getVideo(id, {})`; `dist/cli.js:282-311` poll has no `--model` | *(fixed in project CLI)* `video get/poll --model` default `agnes-video-2.5`, `modelName` query param; `task_` ids keep legacy `/videos/{id}`. Verify keyframe/reference live in a later smoke run |
| LOC-04 | High | Published 0.1.6 `--version` reports `0.1.0`; skill/npx path gives misleading version and stale package | `npm exec --package=agnes-ai-cli@0.1.5 -- agnes --version` → `0.1.0`; `npx -y agnes-ai-cli@^0.1.0 --version` resolved the installed patched 0.1.6 on this machine (`0.1.6`) | correct package version (`0.1.5`, `0.1.6`, `0.2.0-local.1`) → `0.1.0` for any published release | tag `src/cli.ts:14` `.version("0.1.0")`; installed dist hot-patched to read `package.json` (`dist/cli.js:9-12`) | *(fixed in project CLI)* `cli/src/cli.ts:32` reads `pkg.version`; bump to `0.2.0-local.1`; ensure `install-local.sh` reports real version |
| LOC-05 | High | Skill guidance is stale: models, defaults, docs links, version range, and npx path all predate 2.5/3.0 | `grep -n 'agnes-image-2.1-flash\|agnes-video-v2.0\|0.1.0' ~/.agents/skills/agnes-ai-skill/SKILL.md` | 2.5/3.0 catalog, project CLI commands, current docs → skill says text 2.0, image default 2.1, video only v2.0, supports CLI `>=0.1.0 <0.2.0`, prefers `npx agnes-ai-cli@^0.1.0` (published stale build) | `SKILL.md:52-55, 190-199, 244-258, 288, 310, 342, 466-468, 483-492, 527`; README gallery similarly labels 2.0/2.1/v2.0; range `<0.2.0` would also reject the fixed `0.2.0-local.1` | *(task-4, docs-researcher)* rewrite skill to project contract, bump 1.3.0, docs links `wiki.agnes-ai.com/en/docs/...`, widen/support range to `>=0.2.0 <0.3.0`; remove npx default in favor of installed/wrapper path |
| LOC-06 | High | Three-way image default mismatch + unreproducible install: installed dist 2.5, published package/tag source/skill 2.1 | `diff -rq /tmp/agnes-tarball-016/package/dist /usr/local/lib/node_modules/agnes-ai-cli/dist`; `grep DEFAULT_IMAGE_MODEL` | one canonical image default (`agnes-image-2.5-flash`, current docs) → installed 2.5 / published+tag 2.1 / skill 2.1; patch unpublished and version not bumped | installed `dist/image/normalizeImageRequest.js:11-16,48`; tarball/tag `src/image/normalizeImageRequest.ts` enum 2.0/2.1 + default 2.1 | *(fixed in project CLI)* `cli/src/models.ts`/`normalizeImageRequest.ts` single `IMAGE_MODELS` + `DEFAULT_IMAGE_MODEL=agnes-image-2.5-flash`; keep 2.1/2.0 legacy; `install-local.sh` replaces package; upstream drift notes in `cli/UPSTREAM.md` |
| LOC-07 | Medium | Image requests are incomplete vs Image 2.5 docs: no default `size` (docs mark Required), no `--ratio`, `extra_body.response_format` never user-selectable | Offline `normalizeImageRequest({mode:"text2img",prompt:"x"},{})` → `{model, prompt}` only | docs: `size` required (tiers 1K/2K/3K/4K; `1024x768` accepted), `ratio` supported, URL output via `extra_body.response_format:"url"` (`agnes-image-25-flash.md:118-123,174`) → actual payload has no `size`/`ratio`/`response_format` | installed `dist/image/normalizeImageRequest.js:47-64` only copies optional size; `dist/cli.js:130-158` lacks `--ratio`; responseFormat only if programmatic caller passes it | *(fixed in project CLI)* `cli/src/image/normalizeImageRequest.ts` defaults `1024x1024`, adds `--ratio`, sends `extra_body.response_format:"url"` when URL requested; document tiers/ratio |
| LOC-08 | Medium | `.env.local` is never auto-loaded, so repo-local commands report missing auth even though the key file is present | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME=$HOME PWD=$PWD node cli/bin/agnes.js auth check --json` from repo root → `{configured:false}` | configured:true from `.env.local` (mode 600) → actual `missing` | `dist/config.js:12-24` / `cli/src/config.ts:43-56` read `process.env` only; no dotenv; CLI has no `--env-file` | `scripts/agnes` wrapper (task-5) loads `.env.local` safely and exports `AGNES_API_KEY`/`AGNES_BASE_URL`; optionally add `--env-file` to CLI; doctor shows provenance |
| LOC-09 | Medium | Documented `AGNES_BASE_URL` override is ignored by the CLI (and there is no `--base-url`) | `node -e` on dist/config: `resolveConfig({env:{AGNES_BASE_URL:"http://127.0.0.1:9"}}).baseUrl` | `http://127.0.0.1:9` → actual `https://apihub.agnes-ai.com/v1`; `.env.example` advertises the override, docs quickstart exports it | installed `dist/config.js:17-18` (`baseUrl: config.baseUrl ?? DEFAULT_BASE_URL`); project `cli/src/config.ts:48-49` identical | Read `env.AGNES_BASE_URL` (and optional `--base-url`) in `cli/src/config.ts`; wrapper exports it; needed for staging/mocking and makes timeout/mock tests possible |
| LOC-10 | Medium | No HTTP timeouts: text/image/video create, each poll status request, and temp uploads can hang indefinitely | Offline mock inspection: all text/image/video create `fetch` calls have `signal: undefined`; `pollVideo` calls `getVideo(id, {})` (drops timeout); live `agnes-3.0-flash` took 31.1 s (fine but shows long calls are normal) | docs recommend 60–360 s client timeout for image generation (`agnes-image-25-flash.md:472`) and bounded polling with backoff (`agnes-video-25.md:367`); uploads should fail over quickly → actual no timeout anywhere | installed `dist/http/requestJson.js:8` (`fetchImpl(url, init)` no signal); `dist/video/getVideo.js:14-16` supports `timeoutMs` but `pollVideo.js:11` never passes it; `dist/media/*` upload fetches have no timeout | Project CLI: add configurable `requestTimeoutMs` default (e.g. 60–120 s) to `requestJson` for all calls, per-status timeout in poll, upload timeout; keep `--timeout` for `video get` |
| LOC-11 | Medium | Error handling: human-readable errors hide the provider message; retries duplicate non-idempotent POSTs but never retry 429/5xx; one exit code for everything; `auth check` exits 0 when unconfigured | `agnes text chat --model agnes-2.0-flash ...` (non-JSON) prints only `Agnes text request failed with HTTP 500.`; offline `requestJson` mock: 3 attempts on thrown network error, **1 attempt** on HTTP 429/500; `agnes auth check --json` missing → exit 0 | show provider `error.message` (e.g. "Model … unavailable", rate-limit text); retry only idempotent GETs or use request-id/idempotency; retry 429/5xx with `Retry-After`/backoff; exit-code taxonomy; auth check exit ≠0 when missing | installed `dist/http/requestJson.js:2-23` retries `fetch` exceptions (POST duplicated) and returns non-ok once; `dist/cli.js:357-394` non-JSON path prints `error.message` only; `dist/auth/check.js` + `cli.js:41-51` return 0; project CLI retains same retry/human-error shape | Keep error bodies in JSON (already), improve non-JSON text with sanitized provider message; never blind-retry POSTs; add 429/5xx backoff (bounded) for GET; map errors to distinct exit codes; make `auth check` nonzero when missing (or `--strict`) |
| LOC-12 | Medium | JSON contract has holes: commander-level errors bypass `--json`; requested model is echoed rather than the response model | `node cli/bin/agnes.js image text2img --json` (no prompt) → empty stdout, plain stderr, exit 1; `--json doctor` → plain error; `text chat --json` top-level `model` is the requested value while `raw.model` is the served value | parseable JSON envelope for required-option/unknown-command errors; `model` should be the served model or expose `requestedModel`/`servedModel` | installed/project `cli.ts` register commander defaults and rely on `program.parseAsync` catch; commander calls `process.exit` on missing options/unknown commands before the catch (`exitOverride` not used); `text/complete.ts` returns `model: parsed.model` | Add `program.exitOverride()` + convert `CommanderError` to `{ok:false, code:"INVALID_ARGUMENTS" or "UNKNOWN_COMMAND", …}` when `--json`; expose `requestedModel` + `model` from `raw.model`; document JSON schema |
| LOC-13 | Medium | No model discovery / environment diagnostics; `auth check` has no provenance | `agnes models --json` and `agnes doctor` → `error: unknown command`; auth only reports `source:"env"` | `agnes models [--json]` catalog with defaults/status; doctor-style diagnostics (version, install path, env source, symlink health, docs reachability) | installed `dist/cli.js:13-27` registers only auth/media/text/image/video; `dist/auth/check.js:8` always labels `env` | *(models fixed in project CLI)* `agnes models` + `--json` catalog; *(task-5)* `scripts/doctor.sh` covers environment/skill/symlink env-source checks; consider CLI `doctor` later |
| LOC-14 | Medium | Local-file → public-URL bridge is unreliable and can stall: live upload took **2.15 s** once and **38.33 s** another time before succeeding; litterbox and tmpfiles are currently unusable from this host; no provider disclosure/timeout | `agnes media url /tmp/agnes-smoke/coin64.png --json`; direct provider probe (25 s abort) results in §4.4 | fast, deterministic upload with timeout/failover and provider info; documented privacy trade-off → actual fallback through failing providers, unbounded latency, `source:"temporary"` only | installed `dist/media/temporary-upload.js:30` order `litterbox,tmpfiles,uguu,x0`; `toPublicUrl.js` no timeout/provider field; litterbox: HTTP 412 "No file!" (provider) and WAF 403 HTML (curl); tmpfiles: TLS `SSL_ERROR_SYSCALL`; uguu and x0 work | `scripts/` should prefer `--image-url`/data-URI guidance; if bridge kept: reorder to working providers (uguu, x0, tmpfiles, litterbox), per-provider timeout, report `provider` in JSON, document that uploads go to third-party hosts; project README currently still claims Litterbox first |
| LOC-15 | Medium | 11 dangling skill symlinks expose a missing `agnes-ai-generation` skill in agent skill dirs (see §1.3) | `test -e ~/.claude/skills/agnes-ai-generation` etc.; `readlink -f` logs path but target absent | valid skill or no link → dangling links in 11 agent dirs | `~/.agents/skills/agnes-ai-generation` deleted; `.skill-lock.json` still records source `yacey/agnes-ai-generation-skill` (2026-07-05); duplicate identity vs `agnes-ai-skill` | *(task-5)* `scripts/install-local.sh`: back up + repoint/remove these links to the project skill; `scripts/uninstall-local.sh` restores; print rollback instructions; do not touch `~/.agnes` |
| LOC-16 | Low | Skill helper scripts are orphaned and stale: not referenced by `SKILL.md`/`README.md` (only in old design spec); `agnes-media-url.sh` hardcodes Litterbox (currently blocked) and duplicates `agnes media url`; `extract_first_frames.swift` is macOS/AppKit-only with undocumented deps | `grep -rn 'media-url.sh' SKILL.md README.md` → none; `head scripts/agnes-media-url.sh`; `head scripts/extract_first_frames.swift` | documented fallback or removed → undocumented dead code; shell script inherits litterbox failure | `scripts/agnes-media-url.sh:38-41` (curl litterbox); `scripts/extract_first_frames.swift:1-5` (AppKit/AVFoundation), usage at line 14 | *(task-4)* document both as optional fallback with deps/limits, or delete; prefer `agnes media url` and `ffmpeg`-based frame extraction in docs |
| LOC-17 | Low | Skill doc links and gallery labels are stale | `grep -n 'agnes-ai.com/doc' SKILL.md` | `wiki.agnes-ai.com/en/docs/<slug>.md` → old `agnes-ai.com/doc/...` URLs; gallery labels 2.0/2.1/v2.0 | `SKILL.md:87-90`; `README.md` model tables/gallery | *(task-4)* update links + labels; note old pages may redirect/404 |
| LOC-18 | Low | Cosmetic/robustness gaps in the new project CLI | `node cli/bin/agnes.js text chat --help` shows `(default: agnes-2.5-flash) (default: "agnes-2.5-flash")`; `text chat --json` text can include leading `\n\n` and hidden reasoning | single clean default hint; trim/keep raw text and expose `reasoning_content` separately; `auth check` source always `env` | project `cli/src/cli.ts` option description includes default text *and* commander appends `(default: …)`; `text/complete.ts` returns raw `content` untrimmed and ignores `reasoning_content` | Polish help strings in `cli/src/cli.ts`; return `text` trimmed + `reasoning`/`raw`; add `source` provenance once env loading exists |

---

## 4. Live + offline test log

### 4.1 Environment / masking

- Global CLI under test: `/usr/local/bin/agnes` → installed 0.1.6 patched dist (§2.1). Project CLI tested separately via `node cli/bin/agnes.js` (0.2.0-local.1).
- Every live command ran as:
  `KEY=$(grep -m1 '^AGNES_API_KEY=' .env.local | cut -d= -f2-); AGNES_API_KEY="$KEY" agnes …`
  (key never printed; `<KEY:len=51>` in notes).
- `--json` used everywhere so output is machine-checkable and error bodies are preserved (sanitized by the CLI).
- Latency measured with `/usr/bin/time -p` (wall clock, includes Node startup ≈0.1 s).

### 4.2 Live text pings (prompt: `Reply with exactly: pong`)

| Requested `--model` | Exit | HTTP/result | Latency | Response `model` echo | Output / notes |
|---|---|---|---|---|---|
| `agnes-2.0-flash` | 1 | **HTTP 500** `get_channel_failed` — `Model agnes-2.0-flash is temporarily unavailable. Please try again later` (request id omitted) | 2.21 s | none | `{ok:false, code:"AGNES_REQUEST_FAILED", message:"…HTTP 500.", error:{code:"get_channel_failed",…}}`; confirms deprecated model is currently unusable |
| `agnes-2.5-flash` | 0 | HTTP 200 | **6.50 s** | top-level `model:"agnes-2.5-flash"`, `raw.model:"agnes-2.5-flash"` | `text:"\n\npong"` (leading blank lines); usage prompt 289 / completion 17 (reasoning 14, cached 256) |
| `agnes-3.0-flash` | 0 | HTTP 200 | **31.11 s** (long but succeeded) | top-level `model:"agnes-3.0-flash"`, `raw.model:"agnes-3.0-flash"` | `text:"pong"`; usage prompt 79 / completion 2 |
| **(no `--model`, default)** | 1 | HTTP **429** free-tier rate limit | 2.20 s | none | Occurred after the three pings above; body: "You've reached the API rate limit for free users…". Demonstrates the default path is the stale 2.0 path; the explicit 2.0 run above is the clean model-status evidence. No 429 retry/backoff observed. |
| `agnes-does-not-exist` | 1 | HTTP **404** `model_not_found` | 0.88 s | none | Error body preserved in JSON `error` object; message "Model agnes-does-not-exist is not available for your current group". |

Conclusion: **2.5-flash and 3.0-flash are valid live model IDs and work; 2.0-flash is broken/deprecated; the CLI default is wrong.**

### 4.3 Command surface / JSON / auth tests

| Command | Result |
|---|---|
| `agnes --version` | `0.1.6` (installed hot-patch reads package version; published 0.1.6 would print `0.1.0`) |
| `agnes --help` | Shows auth/media/text/image/video only — **no `models`, no `doctor`** |
| `agnes auth check --json` (key exported) | `{"ok":true,"configured":true,"source":"env"}` |
| `agnes auth check --json` under `env -i` from repo root | `{"ok":false,"configured":false,"source":"missing"}` — **exit 0**; proves `.env.local` is not read |
| `agnes models --json` / `agnes doctor --json` | exit 1; stdout empty; stderr `error: unknown command 'models'` / `'doctor'` (not JSON) |
| `agnes image text2img --json` (missing required `--prompt`) | exit 1; stdout empty; stderr `error: required option '--prompt <text>' not specified` (not JSON) |
| `agnes media url /tmp/does-not-exist.png --json` | exit 1, `{"ok":false,"code":"INPUT_NOT_FOUND",…}` |
| `agnes media url … --ttl 5m --json` | exit 1, `{"ok":false,"code":"INVALID_ARGUMENTS",…}` |
| `agnes image text2img --help` | Request-shape line says `agnes-image-2.5-flash by default` (matches patched dist, not published/skill) |
| `agnes video poll --help` | No `--model`; request-shape text claims `/agnesapi?video_id={video_id}` only (no `model_name`) |
| `npx -y agnes-ai-cli@^0.1.0 --version` | `0.1.6` on this machine (npx resolved the patched global/PATH install — non-reproducible) |
| `npx -y agnes-ai-cli@0.1.5 --version` | `0.1.0` (published build's hardcoded version) — proves the skill's npx path is not a reliable version/behavior pin |

Project CLI (`node cli/bin/agnes.js`): `--version` → `0.2.0-local.1`; `models --json` returns the full text/image/video catalog with defaults and statuses (2.0 deprecated, v2.0 retired); text help default 2.5; video help includes 2.5 flags; **still**: auth check exits 0 when missing, `.env.local` not read without wrapper, commander errors not JSON, help default hint duplicated (LOC-08/09/12/18).

### 4.4 Media URL bridge (local-file upload) live test

Test image: `/tmp/agnes-smoke/coin64.png` (64×64 RGBA PNG, 3,992 bytes — test image only; no user data).

| Command | Exit | Latency | Result |
|---|---|---|---|
| `agnes media url /tmp/agnes-smoke/coin64.png --json` (1st run) | 0 | **38.33 s** | `{"ok":true,"url":"https://n.uguu.se/ErxvRWzY.png","source":"temporary"}` (succeeded only after fallbacks) |
| same command (2nd run) | 0 | **2.15 s** | `{"ok":true,"url":"https://n.uguu.se/DSgJYBjJ.png","source":"temporary"}` |
| uploaded URL `HEAD` request | — | — | `HTTP/2 200`, `content-type: image/png`, `content-length: 3992` — bridge result is publicly reachable |
| `agnes media url https://example.com/frame.png --json` | 0 | 0.06 s | `{"ok":true,"url":"https://example.com/frame.png","source":"passthrough"}` |
| private/local URL path (offline, mock provider) | — | — | `http://127.0.0.1/...` is detected as private, fetched, materialized to a temp file and uploaded (offline probe) |

Direct provider probe (each with a 25 s abort, smallest test image) and curl corroboration:

| Provider | CLI/provider code result | Latency | Corroborating `curl` |
|---|---|---|---|
| litterbox | ❌ `UPLOAD_FAILED` HTTP **412 "No file!"** | 0.71 s | ❌ HTTP **403** HTML from BunkerWeb/WAF (blocked from this host) |
| tmpfiles | ❌ `UPLOAD_FAILED` "fetch failed" | 0.28 s | ❌ `LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to tmpfiles.org:443` |
| uguu | ✅ `https://n.uguu.se/QkdoEjjO.png` | 0.79 s | ✅ JSON `{success:true, files:[{url:…}]}` |
| x0.at | ✅ `https://x0.at/SrCk.png` | 1.53 s | ✅ plain-text URL |
| `TemporaryMediaUrlProvider` in CLI order | ✅ via uguu after litterbox+tmpfiles fail | 1.44 s | — |

Root cause split: **litterbox/tmpfiles are environment/service failures, not just network flakiness** (WAF and TLS), while uguu/x0 are working. Because the order is litterbox→tmpfiles→uguu→x0 and no per-provider timeout exists, the 38 s outlier is expected whenever a dead provider stalls; `source:"temporary"` hides which host received the image. Privacy: the file is uploaded to a third-party host without confirmation.

### 4.5 Offline payload / module probes (node imports of installed `dist`, mock `fetch`, no billable calls)

| Probe | Observed |
|---|---|
| `IMAGE_MODELS` / `DEFAULT_IMAGE_MODEL` | `["agnes-image-2.5-flash","agnes-image-2.1-flash","agnes-image-2.0-flash"]` / `"agnes-image-2.5-flash"` |
| text2img normalized payload | `{model:"agnes-image-2.5-flash", prompt:"x"}` — **no `size`, no `extra_body.response_format`** |
| img2img payload | `{model:"agnes-image-2.5-flash", prompt:"x", extra_body:{image:[...]}}` |
| invalid image model | client-side `ZodError`: `Invalid option: expected one of … 2.5 / 2.1 / 2.0` (no request sent) |
| video text2video payload | `{model:"agnes-video-v2.0", prompt, width:1152, height:768, num_frames:121, frame_rate:24}` |
| video keyframes payload | same v2.0 fields + `extra_body:{image:[…], mode:"keyframes"}` |
| video img2video payload | same v2.0 fields + top-level `image` |
| poll URL (video id) | `https://apihub.agnes-ai.com/agnesapi?video_id=video_abc` — **no `model_name`** |
| poll URL (legacy task id) | `https://apihub.agnes-ai.com/v1/videos/task_abc` |
| `getVideo(...,{timeoutMs:1000})` | `signal` present → `true`; **`pollVideo` calls omit it** (`hasSignal:false` on every poll request) |
| 404 / 503 status mapping | `TASK_NOT_FOUND` / `SERVICE_BUSY` with body preserved; 401 body sanitized (`sk-…` → `[REDACTED]`, `authorization` → `[REDACTED]`) |
| `requestJson` retry behavior | thrown network error → 3 attempts; done; **HTTP 429/500 → 1 attempt** (no retry) |
| text payload default | `{model:"agnes-2.0-flash", messages:[…]}`; `result.model` echoes requested (`agnes-3.0-flash`) even when `raw.model` differs |
| config with `AGNES_BASE_URL` env | `baseUrl` remains `https://apihub.agnes-ai.com/v1` (env ignored) |
| `pollVideo` timeout | throws `POLL_TIMEOUT` after `timeoutSeconds`; every status fetch had `signal:false`; 5 requests in the 0.05 s test |
| media data-URL / private-URL materialization | works offline via mock provider (temp file `input.png`, cleanup dir removed) |

### 4.6 Not tested (deliberately / limitations)

- **No live image generation** (cost + instruction) and **no live video creation/polling** (cost); those paths are verified offline via payload/URL probes only. A keyframe/reference poll must be validated live later by a `--live` smoke path.
- **No `agnes auth save-key` run** (would modify rc files); code inspected only.
- Live 401/429/timeout *runtime* behavior not re-triggered beyond the accidental 429 above; retry/timeout conclusions come from mocks + code paths.
- Temporary hosts can change at any time; provider results are a 2026-10-21 snapshot.
- The free tier rate-limited text calls after the ping set, so no further live text calls were made.

---

## 5. Docs requirements that drive the severity

| Requirement | Source |
|---|---|
| `agnes-2.0-flash` is deprecated; use `agnes-2.5-flash` (API-compatible upgrade); do not keep 2.0 as fallback | `https://wiki.agnes-ai.com/en/docs/agnes-25-flash.md:31,41,119`; quickstart request uses 2.5 | 
| Text catalog also includes `agnes-2.5-pro`, `agnes-2.5-pro-beta`, `agnes-3.0-flash`; `agnes-3.0-pro` is "coming soon" | `https://wiki.agnes-ai.com/llms.txt`; `agnes-30-flash.md:15,49` |
| Image 2.5 model ID `agnes-image-2.5-flash`; `POST /v1/images/generations`; `size` required (tiers 1K/2K/3K/4K, legacy exact sizes accepted); `ratio` optional; URL output via `extra_body.response_format:"url"` (never top-level) | `https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash.md:15,19,99-102,118-123,174` |
| Video v2.0 is **retired 2026-09-25**; migrate to Video 2.5 series | `https://wiki.agnes-ai.com/en/docs/agnes-video-v20.md:7,11` |
| Video 2.5: `POST /v1/videos`, model ID `agnes-video-2.5`; params `model,prompt,mode(text, keyframe, reference),seconds(4-12,default 5),size(720P, 1080P, 1K, 2K),aspect_ratio(16:9 default),seed,n`; keyframe uses `first_frame`/`last_frame`, reference uses `images`/`audios`/`videos` | `https://wiki.agnes-ai.com/en/docs/agnes-video-25.md:11,19,23,122-160` |
| Video 2.5 polling: `GET /agnesapi?video_id=<ID>&model_name=agnes-video-2.5`; **model_name required for keyframe/reference**, recommended for every mode; without it only `mode:"text"` is valid; poll every 1–2 s; bounded polling with backoff for network/429 | `agnes-video-25.md:11,23,97-101,311-324,367,506`; flash: `agnes-video-25-flash.md:23,89,287` |
| Video 2.5 Flash uses `agnes-video-2.5-flash` and its own `model_name` in polling; `POST /v1/videos` | `https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash.md:19,23,76,89` |
| Client timeout 60–360 s recommended for image generation | `agnes-image-25-flash.md:472` |
| Base URL `https://apihub.agnes-ai.com/v1`; docs examples export `AGNES_API_KEY` and `AGNES_BASE_URL` | `quickstart.md`; `overview.md`; `agnes-video-25.md` quickstart |

---

## 6. Recommended user-visible behavior after fixes

Target: project CLI 0.2.0-local.1 once `scripts/install-local.sh` replaces the global 0.1.6. Wrapper `scripts/agnes` auto-loads `.env.local`, so commands below need no manual export.

```bash
# Setup / install (one-time, idempotent; backs up the old global package)
bash scripts/setup.sh
bash scripts/install-local.sh
agnes --version                 # → 0.2.0-local.1
agnes models                    # text/image/video defaults + deprecated/retired labels
bash scripts/doctor.sh          # Node, build, CLI path, skill links, key presence (masked), docs reachability

# Text — working default, explicit newer model
agnes text chat --prompt "Reply with exactly: pong" --json
agnes text chat --model agnes-3.0-flash --prompt "…" --json
# agnes-2.0-flash remains explicit-only and is marked deprecated in --help/models

# Image — 2.5 default, docs-shaped parameters (no live image calls in tests)
agnes image text2img --prompt "A luminous city at sunrise" --size 2K --ratio 16:9 --json
agnes image img2img --image ./input.png --prompt "Editorial restyle" --json
agnes image compose --image ./a.png --image ./b.png --prompt "Blend these references" --json

# Video 2.5 — async create then get/poll with model_name
agnes video text2video --prompt "A cinematic beach scene at sunset" --seconds 5 --size 720P --aspect-ratio 16:9 --json
agnes video img2video --image ./frame.png --prompt "Subtle wind and slow push-in" --json   # mode=keyframe, first_frame
agnes video multivideo --image ./a.png --image ./b.png --prompt "Blend these references" --json  # mode=reference
agnes video keyframes --image ./first.png --image ./last.png --prompt "Morph between frames" --json
agnes video get <video_id> --model agnes-video-2.5 --json
agnes video poll <video_id> --model agnes-video-2.5 --interval 2 --timeout 600 --json
# legacy v2.0 only when explicitly requested: --model agnes-video-v2.0 --width … --num-frames 121 --frame-rate 24

# Media bridge — prefer public URLs/direct URLs; upload fallback reports the provider and has a timeout
agnes media url ./input.png --json          # {"url":…, "provider":"uguu"} (working hosts first)
agnes media url https://cdn.example.com/x.png --json   # passthrough, instant

# Skill: installed from the project copy, not npx
bash scripts/install-local.sh               # links skill/agnes-ai-skill into ~/.agents/skills, repairs dangling links
# agents should follow skill/agnes-ai-skill/SKILL.md (1.3.0) and the installed CLI path
```

Expected JSON contracts after fixes: errors always `{ok:false, code, message, …}` (including argument/unknown-command errors when `--json`), success results carry `ok:true`, `model`/`requestedModel`, `raw` (with secrets sanitized), and command-appropriate `url`/`taskId`/`videoId`/`status`.

---

## 7. Fix list mapped to files

### 7.1 Already implemented in project `cli/` (Lead; verify/supersede global install)

| Fix | Files |
|---|---|
| Central model catalog + defaults (text 2.5, image 2.5, video 2.5; deprecated/retired markers) | `cli/src/models.ts` |
| Text default 2.5 and model validation/help | `cli/src/cli.ts`, `cli/src/text/complete.ts` |
| Image 2.5 default, `IMAGE_MODELS`, default size `1024x1024`, `--ratio`, `extra_body.response_format` | `cli/src/image/normalizeImageRequest.ts`, `cli/src/image/generateImage.ts`, `cli/src/cli.ts` |
| Video 2.5 payload contract + v2.0 legacy flags + mode mapping | `cli/src/video/normalizeVideoRequest.ts`, `cli/src/video/generateVideo.ts`, `cli/src/cli.ts` |
| Poll `model_name` + legacy task path + per-request `--timeout` | `cli/src/video/getVideo.ts`, `cli/src/video/pollVideo.ts`, `cli/src/cli.ts` |
| `agnes models [--json]`; version from package.json | `cli/src/cli.ts`, `cli/src/models.ts` |
| Tests for the above (74 tests) | `cli/test/unit/*.mjs`, `cli/test/cli/help.test.mjs` |
| Upstream provenance record (`9e62930`, npm 0.1.6, 2026-08-10) | `cli/UPSTREAM.md`, `cli/README.md` |

### 7.2 Remaining CLI gaps to address (Lead's `cli/` scope; relevant to `scripts/` wrapper and tests)

| Fix | Files (suggested) |
|---|---|
| `AGNES_BASE_URL` env + optional `--base-url` (currently ignored) | `cli/src/config.ts`, `cli/src/cli.ts` |
| Configurable request timeout for text/image/video (docs 60–360 s) and upload timeout; poll per-request timeout | `cli/src/http/requestJson.ts`, `cli/src/video/pollVideo.ts`, `cli/src/media/*` |
| Safer retry policy (no blind POST retries; bounded 429/5xx + `Retry-After` for GET), exit-code taxonomy, non-JSON errors include sanitized provider message | `cli/src/http/requestJson.ts`, `cli/src/errors.ts`, `cli/src/cli.ts` |
| JSON envelope for commander errors via `exitOverride()`; `auth check` nonzero when missing (`--strict`); model provenance (`requestedModel` vs served `model`) | `cli/src/cli.ts`, `cli/src/auth/check.ts`, `cli/src/text/complete.ts` |
| Media provider order/timeout/`provider` field, or de-emphasize uploader bridge (prefer `--image-url`/data URI) | `cli/src/media/temporary-upload.ts`, `cli/src/media/toPublicUrl.ts`, `cli/README.md` |
| Optional `agnes doctor` (may remain a shell script) | `cli/src/cli.ts` / `scripts/doctor.sh` |
| Help-string polish (duplicate `(default: …)`) | `cli/src/cli.ts` |

### 7.3 Skill fixes (docs-researcher, task-4 → `skill/agnes-ai-skill`)

| Fix | Files |
|---|---|
| Model catalog/defaults: text 2.5 default + 3.0-flash/2.5-pro/2.5-pro-beta; image 2.5 default + 2.1/2.0; video 2.5/2.5-flash + v2.0 retired; remove deprecated-as-active/marketing claims; add pricing/free-access caveat | `skill/agnes-ai-skill/SKILL.md`, `README.md`, `README.zh-CN.md` |
| CLI-first commands matching project CLI (models, new video flags, `--model` on poll, image `--size/--ratio`) and supported range `>=0.2.0 <0.3.0`; replace npx default with installed/wrapper path | same |
| Docs links `wiki.agnes-ai.com/en/docs/<slug>.md` (or `www.agnes-ai.com/en/docs/...`); remove stale `agnes-ai.com/doc/...` links | same |
| Bump skill version to 1.3.0 + version history; add repo-maintained note + install via `scripts/install-local.sh` | `SKILL.md` frontmatter/history |
| Reconcile/remove `scripts/agnes-media-url.sh` (litterbox hardcoded) and document/remove `extract_first_frames.swift` (macOS-only) | `skill/agnes-ai-skill/scripts/*` |
| Keep assets/gallery but update model labels | `skill/agnes-ai-skill/assets`, `examples` |

### 7.4 Scripts/tests + environment fixes (cli-auditor, task-5; blocked on task-1/task-2)

| Fix | Files |
|---|---|
| Wrapper loads `.env.local` safely (no `source`, handle quotes/comments/CRLF, ignore malformed lines, never echo key), exports `AGNES_API_KEY`/`AGNES_BASE_URL`, execs `node cli/bin/agnes.js`, warns+falls back to global if build missing | `scripts/agnes` |
| Idempotent setup: Node ≥20, npm install/build in `cli/`, create `.env.local` from `.env.example` only if absent, `chmod 600`, optional `--with-live-check` | `scripts/setup.sh` |
| Install: build, back up+`npm link`/replace global package, link project skill into `~/.agents/skills/agnes-ai-skill`, repair/remove the 11 `agnes-ai-generation` dangling links with backups (do **not** touch `~/.agnes`), verify `agnes --version` + skill resolution, print rollback | `scripts/install-local.sh` |
| Uninstall: restore backups (global package + skill links), keep user data | `scripts/uninstall-local.sh` |
| Doctor: Node/npm/build/CLI path+version (project vs global), skill install/symlink health, `.env.local` presence + masked key length, `auth check --json`, docs HEAD with timeout, upstream drift summary | `scripts/doctor.sh` |
| Upstream drift: fetch `jomeswang/agnes-ai-cli` + `agnes-ai-skill`, print HEAD/tag/version vs vendored records; `--update` stages copies without overwriting patched files | `scripts/sync-upstream.sh` |
| Smoke: build/help/auth/models checks + optional `--live` cheap 2.5 text ping with `--json`; no image/video | `scripts/smoke.sh` |
| Offline tests: model/skill consistency, `bash -n` all scripts, secret scan, wrapper env-loading with fake key, no-secret tracked-file scan; macOS bash 3.2-safe runner | `tests/*.sh`, `tests/run-all.sh` |
| Remove/point the 11 dangling `agnes-ai-generation` links (install/uninstall own it); document `.skill-lock.json` stale entry | covered by `scripts/install-local.sh` / `uninstall-local.sh` |

---

## 8. Evidence / scratch artifacts

- `/tmp/agnes-tarball-016/package/` — extracted npm 0.1.6 for diffing; diff command: `diff -rq /tmp/agnes-tarball-016/package/dist /usr/local/lib/node_modules/agnes-ai-cli/dist`.
- `/tmp/agnes-research/cli/` — upstream clone at tag v0.1.6 (`9e629302cf30898d09f60fb2ba3e52e795b7ccf4`).
- `/tmp/agnes-research/skill/` — upstream skill clone at `7e263a4`.
- `/tmp/agnes_offline_probe.mjs`, `/tmp/agnes_offline_probe_out.json` — payload/URL/retry/timeout/error probes.
- `/tmp/agnes_provider_probe.mjs`, `/tmp/agnes_provider_probe.json` — per-provider upload probe.
- `/tmp/agnes_ping_*.json|.time` — live text pings; `/tmp/agnes_media_url*.json|.time` — media bridge runs.
- Live test image: `/tmp/agnes-smoke/coin64.png` (64×64 RGBA, 3,992 B; test-only).
- Doc copies used for classification: `/tmp/agnes-research/docs/*.md` (fetched 2026-10-21); canonical index https://wiki.agnes-ai.com/llms.txt.

---

## 9. Contract update addendum (post-audit, 2026-10-21 ~12:07)

The project CLI and skill changed after §1–§8 were written (Lead contract update). §1–§8 remain accurate as **reproduction evidence for the old global 0.1.6**, but the fix status is:

### 9.1 Final project build

- `cli/` = **0.2.0-local.1**; `npm --prefix cli test` → **74/74 passing**; `node cli/bin/agnes.js --version` → 0.2.0-local.1.
- New CLI behavior (verified offline by `tests/cli-contract.test.mjs` + `tests/wrapper-env.test.sh`):
  - auto-loads nearest `.env.local` (walks up ≤4 parents; explicit env wins; `AGNES_NO_DOTENV=1` disables; `AGNES_ENV_FILE` overrides);
  - `agnes auth check` exits **1** when the key is missing (JSON shape unchanged);
  - supports `AGNES_BASE_URL`, `AGNES_MEDIA_PROVIDER_ORDER` (comma order of litterbox/tmpfiles/uguu/x0), `AGNES_HTTP_TIMEOUT_MS` (default 120000);
  - POST is **not retried** by default; GET polling retries 429/5xx/network until timeout;
  - video create prints `next: agnes video poll <id> --model <model>`;
  - `agnes models [--json]`, image `--ratio`/default size, Video 2.5 flags, poll `--model`/`model_name` all present.
- Skill scope: `skill/agnes-ai-skill` (1.3.0, CLI-first) **and** `skill/agnes-ai-models` (vendored official `AgnesAI-Labs/skills` @ `99490234`, no upstream version field); `scripts/install-local.sh` links both plus a `~/.agents/skills/agnes-ai-generation` alias so the existing dangling agent links resolve without editing them.
- The global `/usr/local/bin/agnes` is **still old 0.1.6** — expected until the Lead runs `bash scripts/install-local.sh` (dry-run verified; not applied by the auditor, per instruction).

### 9.2 Status of the §3 issues after the patch

| ID | Status now |
|---|---|
| LOC-01 text default | ✅ fixed (default agnes-2.5-flash; 2.0 deprecated, explicit-only) |
| LOC-02 video v2.0 only | ✅ fixed (Video 2.5 default/payload; v2.0 explicit legacy) |
| LOC-03 poll model_name | ✅ fixed (`video get/poll --model`, `model_name` in `/agnesapi`) |
| LOC-04 `--version` hardcode | ✅ fixed (reads package.json) |
| LOC-05 stale skill | ✅ fixed in skill 1.3.0 (task-4); shipped via install-local |
| LOC-06 image default mismatch | ✅ fixed (single `cli/src/models.ts`; 2.5 default; version bumped to 0.2.0-local.1) |
| LOC-07 image size/ratio | ✅ fixed (default size 1024x1024, `--ratio`, 2.0 guard) |
| LOC-08 no .env autoload | ✅ fixed in CLI; wrapper also keeps a fallback parser for old binaries |
| LOC-09 AGNES_BASE_URL ignored | ✅ fixed (`cli/src/config.ts` reads env) |
| LOC-10 timeouts | 🟡 mostly fixed (`AGNES_HTTP_TIMEOUT_MS` 120 s + poll budgets); temp-uploader requests still lack a per-provider timeout |
| LOC-11 error/retry/exit handling | 🟡 partial: POST no-retry + GET 429/5xx retry + auth exit 1 done; non-JSON human errors still omit the sanitized provider message; one exit code for most failures |
| LOC-12 JSON contract holes | 🟡 partial: zod/AgnesCliError errors are JSON; **commander-level errors (missing required option / unknown command) still bypass `--json`** (accepted known gap, encoded in `tests/cli-contract.test.mjs`) |
| LOC-13 no models/doctor | ✅ `agnes models`; `scripts/doctor.sh` covers environment/skill/env/auth/docs/upstream |
| LOC-14 media upload providers | 🟡 provider order configurable (repo `.env.local` uses `uguu,x0,litterbox,tmpfiles`); per-provider timeout + provider field/privacy disclosure still open |
| LOC-15 dangling skill links | ⏳ pending: `install-local.sh` creates the `agnes-ai-generation` alias (dry-run verified); actual application is the Lead's step |
| LOC-16/17 skill scripts/links | ✅ addressed in skill 1.3.0 (README documents the two skills; old helper scripts documented as fallback) |
| LOC-18 cosmetic | 🟡 remaining help duplication was fixed by the CLI rewrite; text trim/reasoning exposure not confirmed |

### 9.3 task-5 automation delivered

`scripts/`: `agnes` wrapper (project CLI exec + safe fallback env parsing), `setup.sh` (idempotent install/build/env creation, `--check`, `--with-live-check`), `install-local.sh` (backup + npm link + two skills + generation alias, `--dry-run`/`--yes`), `uninstall-local.sh` (manifest-driven restore, `--dry-run`/`--yes`), `doctor.sh` (offline/strict), `sync-upstream.sh` (bounded compare, `--update` stages to /tmp only), `smoke.sh` (offline default, `--live` one cheap 2.5-flash ping), `_lib.sh`.
`tests/`: `run-all.sh` (runs `npm --prefix cli test` + 8 shell suites + 3 Node suites), `scripts-syntax`, `env-example`, `upstream-record`, `wrapper-env`, `setup-doctor`, `smoke-offline`, `install-dry-run`, `install-roundtrip`, `secrets`, `models-consistency`, `cli-contract`.
Verification: `bash tests/run-all.sh` → **12 suites, 0 failures** (CLI 74/74 + 8 shell suites incl. the isolated install→uninstall round-trip + 3 Node suites); `install-local.sh --dry-run` showed the expected plan and left the machine unchanged; no live calls were made by the test suite. `smoke.sh --live` was not executed in this round to preserve the free-tier quota (path is covered by the offline auth check + the earlier live pings in §4.2).
