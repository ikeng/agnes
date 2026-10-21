# Independent verification — agnes-toolkit pre-commit gate (round 2, FINAL)

- **Verifier:** independent verifier teammate (`verifier`, shared task `task-6`). Wrote no
  code/script/skill/test/root file and never read/printed the API key; this report is the only
  workspace change made by the verifier.
- **Date / host:** 2026-10-21 12:40–13:04 (Asia/Shanghai) — round-2 re-verification after the
  round-1 fixes, plus the final `R-1` patch re-check at 13:00–13:04. macOS, Node `v22.22.3`,
  npm `10.9.8`, bash `5.3.9` (`/opt/homebrew/bin/bash`) and macOS bash `3.2.57` (`/bin/bash`).
- **Repo:** `/Users/mac/Documents/research/agnes` (git repo initialized on `main`; 122
  candidates staged with `git add`, **no commit yet** — correct: the Lead commits only after this
  PASS; this report's final edit is the only unstaged change, so re-stage `docs/verification.md`
  before committing). Git identity configured (`ikeng <xiuquan.chan@gmail.com>`).
- **Commit candidate:** 121 non-report files / 1,143,471 bytes (1.09 MB) + this report = 122
  candidates. Non-report shasum manifest:
  `95369f28b7fa5150dc1796d910d634d3bc216f3b2162a773750de5c884ec3970` (sha256 of the 121-file
  `shasum -a 256` manifest, with the final regenerated patch).
- **Method:** every fix was reproduced by the verifier from the current tree; no other agent's
  report was trusted. The CLI was driven by a 107-check harness against a local fake Agnes API
  server; the install/uninstall flow was re-tested with an **independently written** 34-check
  round-trip (not the repo's own test) in a throw-away copy with fake npm/global/HOME/state.
  No live image/video generation was performed; one cheap live text ping was used.
- **Verified state fingerprint** (sha256, first 16 hex):
  `scripts/uninstall-local.sh 903a0c00277ca41a`, `scripts/install-local.sh 69a623b4e7e0664c`,
  `scripts/smoke.sh f02accb90aa34d56`, `scripts/_lib.sh bad3d66bf2223e63`,
  `cli/src/cli.ts 51e8c3d181d35fb7`, `cli/src/models.ts dd5ed7442e6f8e08`,
  `patches/cli-local.patch a9df524c0ff1b3ac`, `tests/install-roundtrip.test.sh 7f7ce003dfad3fc3`,
  `tests/run-all.sh 7fd799f064d07b5e`, `cli/UPSTREAM.md 57d4387558fd788d`,
  `docs/upstream-research.md adf3c8ef536fa1f0`, `docs/local-audit.md 15f96996181d42fc`,
  `README.md 98bf67c205403374`, `skill/agnes-ai-skill/SKILL.md 5b8073fc850992aa`.
  Any edit after this verification invalidates the evidence below.

> This file replaces the round-1 report (which returned FAIL with one blocking defect). The
> round-1 blocking/major/minor findings are all re-tested below; the current tree is the
> subject of this verdict.

---

## 1. Verdict

**PASS — ready to commit.**

No blocking or major defect remains. The blocking round-1 defect `B1` (uninstall restoring the
old skill into the repo instead of `~/.agents/skills`) is fixed and independently reproduced as
fixed; `M1`–`M4` and `L1`–`L4` are verified fixed as well. Build/tests are green (CLI **74/74**,
root **12 suites / 0 failures**), the independent CLI contract harness passes **107/107**, secret
hygiene is clean, `.env.local` remains gitignored/mode 600, and the real machine state is
untouched (global `agnes` still `0.1.6`, no `~/.agnes-toolkit`, `~/.agents` skills untouched,
`~/.agnes` tree not modified by any repo script).

There is **no open residual defect**: the round-2 Low cosmetic item `R-1` (patch drift) is
**resolved via final regeneration** — `patches/cli-local.patch` sha256
`a9df524c0ff1b3ac6cda0dc0a4b816e4d6f1c19c78992bf6f0448397582844de` (2,512 lines) applies cleanly
to a pristine v0.1.6 clone, the patched tree is **tree-identical** to `cli/` (excluding
`node_modules`/`dist`/`.git`), and the patched tree builds and passes **74/74** (independently
re-verified 13:04). The readiness statement below is unaffected.

---

## 2. Round-1 findings — independent re-test

| ID | Claimed fix | Independent evidence (this round) | Result |
|---|---|---|---|
| **B1** | `uninstall-local.sh` helpers use `local`; new `restore_symlink`/`restore_directory`; new `tests/install-roundtrip.test.sh` | Repo test: **15 checks / 0 failures**. Independent verifier round-trip (34 checks, separate script, repo **copy**, fake npm/global/HOME/state): scenario A (real-dir global + real-dir skills) → after uninstall the old skill markers are restored **in the fake HOME**, global dir restored, alias removed, **no nested `skill/<name>/<name>/` in the repo copy**, repo file tree hash unchanged. `remove_path`/`remove_link_if_project`/`restore_*` all declare `local` (`scripts/uninstall-local.sh`); `grep` confirms no unguarded global writes in the helpers. | **FIXED (PASS)** |
| **M4** | Symlinked global package restored from `global/agnes-ai-cli.link-target`; symlinked skills likewise | Independent scenario B: pre-existing symlinked global + both skills → install → uninstall restores every symlink to its original target (`readlink` asserted) and the restored target content is readable. | **FIXED (PASS)** |
| **L1** | `auth_configured` initialized before preflight | `env PATH=/usr/bin:/bin bash scripts/smoke.sh --live` → exit 1 with clean lines `FAIL node not found` and `FAIL cannot run live smoke: AGNES_API_KEY not configured`; **no `unbound variable`**. | **FIXED (PASS)** |
| **L2** | All script `--help` print usage only | `--help` for `setup`, `install-local`, `uninstall-local`, `doctor`, `sync-upstream`, `smoke`: exit 0, heredoc usage only, no `set -u` / `SCRIPT_DIR=` / other code lines. | **FIXED (PASS)** |
| **L3** | `uninstall --dry-run` plans bin-link restore; actual restore covered | Independent scenario C: after install, the fake bin link is repointed; `uninstall --dry-run` prints `restore <bin> -> <old target>` **and does not change** the link; `uninstall --yes` restores it. Repo round-trip test covers the same. | **FIXED (PASS)** |
| **L4** | `agnes models --json` reports image 2.0 as `legacy` | `models --json` → `agnes-image-2.0-flash` status `"legacy"`; human output shows `agnes-image-2.0-flash (legacy)`; `cli/test/cli/help.test.mjs` asserts it; contract harness check added and passes. | **FIXED (PASS)** |
| **M1** | Patch regenerated as complete diff (new files, package/lock bump, tests, removed workflow) | Final regeneration verified 13:04: `git apply --check` + `git apply` on pristine `9e629302…` clone OK; `diff -rq` (excluding `node_modules`/`dist`/`.git`) between patched tree and repo `cli/` → **identical** (incl. `test/cli/help.test.mjs` legacy assertion and the final `UPSTREAM.md` paragraph); `.github/workflows/npm-release.yml` removed; patched tree `npm run build` OK and `node --test` **74/74**. | **FIXED (PASS)** |
| **M2** | `cli/UPSTREAM.md` says 74 tests | `cli/UPSTREAM.md:25` → `74 offline tests`; no `59` test-count claims remain outside this report's history. | **FIXED (PASS)** |
| **M3** | Research residual claims corrected; local-audit counts corrected | `docs/upstream-research.md` now states `AGNES_BASE_URL` implemented (§4.3 ✅, §5.2 ✅), `--ratio` rejected for Image 2.0 (✅), image `seed` as pass-through, hardening section; no `never reads it` / `ratio is forwarded` / `validate selectable` / `residual item` strings remain. `docs/local-audit.md:382-383` now says **12 suites / 8 shell suites incl. the round-trip**. | **FIXED (PASS)** |

Additional fix confirmed: **install CHANGES counting** — a fresh sandbox `install-local.sh --yes`
now writes `install-manifest.env` (asserted in independent scenario A), so uninstall has the
manifest/backup data it needs.

---

## 3. Requirement-by-requirement result

| # | Requirement (user request / Lead decisions) | Result | Evidence |
|---|---|---|---|
| R1 | Consolidation: patched CLI source, both skills, scripts, offline tests, docs, `.env.example`, `.gitignore` in the project dir | **PASS** | 122 commit candidates (121 + this report); tree inspected; no nested `.git`; `skill/` 468K |
| R2 | Upstream research: no newer official generation CLI; npm/GitHub `0.1.6`; official `AgnesAI-Labs/skills` newer | **PASS** | Live `sync-upstream.sh`: npm latest `0.1.6`; CLI main `9e629302…` = `v0.1.6` tag; community skill main `7e263a4…`; official skills `99490234…`; docs URLs HTTP 200 (round-1 curl checks) |
| R3 | Build + tests: root `npm test` and `cd cli && npm run build && npm test` 0 failures; test counts correct | **PASS** | CLI `74/74`; root **12 suites / 0 failures** (CLI + 8 shell incl. round-trip + 3 node); all docs/README claims now say 74; local-audit says 12/8 correctly |
| R4 | CLI contract: version, model defaults/statuses, help, auth exit code, `.env.local` autoload/opt-outs, `AGNES_BASE_URL`, provider-order validation, image/video payloads, polling `model_name`, legacy only with explicit model | **PASS** | **107/107** independent checks (see §4.2); includes new image-2.0 `legacy` assertion |
| R5 | Secret hygiene: `.env.local` ignored + mode 600; no key in candidates/docs/skill/tests; scripts never echo key | **PASS** | `git check-ignore` OK; mode `600`; exact real-key scan over all candidates = **0 files**; only allowlisted fake fixtures + placeholder; all script/CLI output scanned clean |
| R6 | Scripts safety: `bash -n`, read-only/dry-run, no `~/.agnes`/global changes, backup+rollback logic | **PASS** | Syntax under bash 3.2/5.3 OK; read-only and dry-runs exit 0; tight `~/.agnes` before/after snapshot identical; independent 34-check install/uninstall round-trip; global unchanged |
| R7 | Consistency/accuracy: models source == dist == skills == README == docs; test counts; patch applies; `.gitignore`; repo size | **PASS** | Model cross-checks unchanged + image-2.0 legacy; docs corrected; final patch applies and is **tree-identical** to the vendored `cli/`; `.gitignore` complete; size ~1.1 MB candidates |
| R8 | Installability: backup/rollback review, symlink targets, `~/.agnes` untouched | **PASS** | Independent round-trip A/B/C: 34/34; repo test 15/15; fresh install writes manifest; real global/`~/.agents` untouched |
| R9 | `patches/cli-local.patch` applies cleanly to upstream v0.1.6 | **PASS** | `git apply --check` + apply OK on pristine clone; patched tree build + 74/74 tests |
| R10 | User core requirement: key only in `.env.local`, never committed; code/scripts/skills in project dir; repo ready to commit | **PASS** | Key ignored/mode-600/valid (live ping); no key in candidates; repo initialized, identity configured, no commit yet (by design) |

---

## 4. Evidence

### 4.1 Build and test suites

```console
$ cd cli && npm install --no-audit --no-fund --prefer-offline   # exit 0, lock md5 unchanged
$ npm run build                                                  # tsc, exit 0
$ npm test                                                       # exit 0
1..74
# tests 74   # pass 74   # fail 0
```

```console
$ cd /Users/mac/Documents/research/agnes && npm test
== cli: npm --prefix cli test ==      PASS
== sh: env-example.test.sh ==         PASS   (9 checks, 0 failures)
== sh: install-dry-run.test.sh ==     PASS   (5 checks, 0 failures)
== sh: install-roundtrip.test.sh ==   PASS   (15 checks, 0 failures)
== sh: scripts-syntax.test.sh ==      PASS   (18 checks, 0 failures)
== sh: setup-doctor.test.sh ==        PASS   (7 checks, 0 failures)
== sh: smoke-offline.test.sh ==       PASS   (5 checks, 0 failures)
== sh: upstream-record.test.sh ==     PASS   (7 checks, 0 failures)
== sh: wrapper-env.test.sh ==         PASS   (5 checks, 0 failures)
== node: cli-contract.test.mjs ==     PASS   (13 checks)
== node: models-consistency.test.mjs == PASS (7 checks)
== node: secrets.test.mjs ==          PASS   (6 checks)
summary: 12 suite(s), 0 failure(s)
```

### 4.2 CLI contract — 107/107 independent checks

The verifier's own harness (`/tmp/agnes-verify2/contract.mjs`, outside the repo) starts a local
fake Agnes API and runs the real `node cli/bin/agnes.js`; it captures request method/URL/body/
headers. Result: **107 checks, 0 failures, no `sk-` pattern in any output**. Highlights:

- `--version` → `0.2.0-local.1`; `models --json` → defaults text `agnes-2.5-flash`, image
  `agnes-image-2.5-flash`, video `agnes-video-2.5`; text 2.0 `deprecated`, image 2.0 `legacy`,
  video v2.0 `retired`; human `models` shows all three markers; docs URL correct.
- Help surfaces: root group list, image `--size/--ratio/--model`, video 2.5 flags, legacy-only
  flags, `video poll --help` names **`model_name`**.
- Auth: missing key + `AGNES_NO_DOTENV=1` → exit **1** `{"configured":false,"source":"missing"}`;
  repo `.env.local` autoload → configured/exit 0 and key never printed; nested-cwd discovery,
  `AGNES_NO_DOTENV`, `AGNES_ENV_FILE`, pre-set-env precedence all verified.
- `AGNES_BASE_URL` honored end-to-end (requests hit the fake server's `/v1/...`); default text
  payload `agnes-2.5-flash`.
- Invalid `AGNES_MEDIA_PROVIDER_ORDER` → exit 1 `{"code":"INVALID_ENV", "...Allowed: litterbox,
  tmpfiles, uguu, x0."}` before any request.
- Image: default payload `{model:"agnes-image-2.5-flash", size:"1024x1024"}`, no `extra_body`;
  `--size 2K --ratio 16:9` forwarded; img2img `extra_body.image:[…]`; invalid size rejected;
  `--ratio` with Image 2.0 rejected (`INVALID_IMAGE_OPTION`).
- Video 2.5: `POST /v1/videos` with `{model, mode:"text", seconds:"5"}` (string); controls
  `seconds/size/aspect_ratio` forwarded; flash forces `720P`; img2video → `keyframe`+`first_frame`;
  multivideo → `reference`+`images`; keyframes → first+last; legacy flags rejected on 2.5 before
  network; explicit `--model agnes-video-v2.0` emits the legacy payload (no `mode`/`seconds`) and
  rejects 2.5-only flags.
- Polling: `GET /agnesapi?video_id=…&model_name=agnes-video-2.5`; completed result URL/model
  preserved; legacy `task_…` id uses `/v1/videos/task_…` without `model_name`; human create
  output includes the ready-to-run `next: agnes video poll … --model …` hint.
- Known accepted limitation: commander-level argument errors still bypass `--json` (encoded in
  `tests/cli-contract.test.mjs`; see residual risks).

### 4.3 Secret hygiene

```console
$ git check-ignore -v .env.local
.gitignore:3:.env.local	.env.local          # ignored
$ stat -f '%Lp' .env.local
600
$ . scripts/_lib.sh && agnes_masked_key_info .env.local
present (len=51)                             # value never printed
```

- Exact real-key scan over all non-ignored candidates excluding `.env.local` (key read only
  inside the shell, `grep -F`, filenames only): **0 files**.
- `sk-[A-Za-z0-9_-]{20,}` scan over the tree: only allowlisted fixtures
  (`tests/wrapper-env.test.sh`, `tests/cli-contract.test.mjs` fake keys) and the `.env.example`
  placeholder `sk-replace-me-with-your-key`.
- No key content in docs/skill/tests/README; scripts mask the key (`present (len=51)`) and never
  echo it; all CLI/script logs from this round were scanned clean.

### 4.4 Scripts: fixes, read-only behavior, macOS bash 3.2, global safety

```console
$ bash scripts/setup.sh --check            # exit 0: "check: prerequisites look OK (no changes made)"
$ bash scripts/doctor.sh --offline         # exit 0: 11 pass, 6 warn, 0 fail
$ bash scripts/smoke.sh                    # exit 0: 7 pass, 0 warn, 0 fail
$ bash scripts/sync-upstream.sh --offline  # exit 0 (recorded versions only)
$ bash scripts/sync-upstream.sh            # exit 0: npm/CLI/official skill all "up to date"
$ bash scripts/install-local.sh --dry-run  # exit 0: plan only, "no files, links, or packages changed"
$ bash scripts/uninstall-local.sh --dry-run# exit 0: "0 planned action(s)"
$ bash scripts/smoke.sh --live             # exit 0: 8 pass / 0 warn / 0 fail; ping 5,552 ms, text "pong"
```

- `--help` clean for all six scripts (L2 fix); `smoke.sh --live` under a node-less PATH exits 1
  cleanly without `unbound variable` (L1 fix).
- All scripts parse and run under macOS **bash 3.2** (syntax check + runtime smoke/doctor/
  install-dry/uninstall-dry), and under bash 5.3.
- **Global state:** global `/usr/local/bin/agnes` still `0.1.6` (real directory), real
  `~/.agents/skills/agnes-ai-skill` mtime still `2026-06-13 19:26:21`, `~/.agents-toolkit`
  absent, and a tight before/after snapshot of the whole `~/.agnes` tree around every
  non-destructive script is **byte-identical** (hash `701a3ddd…`).
  A broader session snapshot shows only `~/.agnes/memories` mtime changed during the session —
  that is the DeepSeek Harness memory subsystem writing, not a repo script (proved by the tight
  snapshot; scripts contain no `~/.agnes` writes, only the forbidden-path guard).

### 4.5 Install → uninstall round-trip (B1/M4/L3)

All runs isolated in a temporary repo **copy** with fake `npm` (global root + link), fake global
package dir, fake `HOME`, `AGNES_TOOLKIT_STATE_DIR` in temp, and `env -i` so the real
machine cannot be touched.

- **Independent verifier script: 34 checks / 0 failures**
  - A (global package = real dir; skills = real dirs): install succeeds, writes manifest, links
    CLI + both skills + alias, backs up old global/skills; uninstall restores **old skill dirs in
    the fake HOME** with expected markers, restores the global dir, removes the alias, leaves **no
    nested `skill/<name>/<name>/`** in the repo copy; repo file-tree hash unchanged.
  - B (global + skills pre-existing symlinks): install/uninstall restores every symlink to its
    original target (M4).
  - C (bin link repointed): `--dry-run` prints the restore plan without changing the link and
    `--yes` restores it (L3).
- Repo's own `tests/install-roundtrip.test.sh`: **15 checks / 0 failures**, and also asserts the
  real global package/`~/.agents`/`~/.agnes-toolkit` were untouched.
- Fresh sandbox install writes `install-manifest.env` (CHANGES-counting fix).

### 4.6 Patch application and buildability (final patch, re-checked 13:04)

```console
$ shasum -a 256 patches/cli-local.patch
a9df524c0ff1b3ac6cda0dc0a4b816e4d6f1c19c78992bf6f0448397582844de  patches/cli-local.patch
$ wc -l patches/cli-local.patch                             # 2512
$ git -C /tmp/agnes-research/cli rev-parse HEAD              # 9e629302… (pristine, 0 dirty files)
$ cp -R /tmp/agnes-research/cli /tmp/agnes-verify3/patchcheck
$ cd /tmp/agnes-verify3/patchcheck && git apply --check <repo>/patches/cli-local.patch   # OK
$ git apply <repo>/patches/cli-local.patch                                               # OK
$ diff -rq --exclude=node_modules --exclude=dist --exclude=.git . <repo>/cli
# (no output) → TREE IDENTICAL
$ npm run build && node --test                               # build OK, 74/74 tests pass
```

The final patch includes the new files (`src/models.ts`, `src/env.ts`), package/lock version bump,
all test files (incl. the image-2.0 `legacy` assertion) and the removed upstream npm-release
workflow; the patched tree is byte-identical to the repo's `cli/` (excluding
`node_modules`/`dist`/`.git`). `R-1` is therefore resolved (§5).

### 4.7 Upstream research corroboration

`scripts/sync-upstream.sh` (network, read-only) and round-1 `curl` checks re-confirm the research
doc: npm `agnes-ai-cli` latest `0.1.6`; GitHub CLI `main == v0.1.6 == 9e629302…`; community
skill `7e263a4…`; official `AgnesAI-Labs/skills` `99490234…` (2026-09-24); wiki docs URLs return
HTTP 200. Conclusion (no newer generation CLI; official skills newer; patch the community CLI)
is coherent and reproduced live. `docs/upstream/SOURCES.md` records the same ids.

### 4.8 Repo inventory / commit readiness

- 122 candidates are staged on `main` (`git status` shows `A <path>`; no commit yet); this
  report's final edit is the only unstaged change — re-stage it before committing. Non-report
  inventory: 121 files / 1,143,471 bytes; largest files: skill banner 263 KB, research doc
  38 KB, patch 97 KB (final regenerated), local-audit 51 KB. No
  generated/`node_modules`/`dist`/secret files are candidates.
- `.gitignore` correctly ignores `.env`, `.env.local`, `.env.*.local` (`!.env.example`),
  `node_modules/`, `dist/`, `*.tsbuildinfo`, OS/editor and runtime artifacts. `git status
  --ignored` shows only `!! .env.local`, `!! cli/dist/`, `!! cli/node_modules/`.
- No nested `.git`; no nested restore dirs (`skill/` contains exactly the two real skill dirs);
  `cli/package-lock.json` is a candidate; git repo initialized on `main` with identity
  configured and no commit yet (expected).

---

## 5. Residual defects / notes

**No open defect remains. `R-1` is RESOLVED via final regeneration** (sha256
`a9df524c0ff1b3ac6cda0dc0a4b816e4d6f1c19c78992bf6f0448397582844de`, 2,512 lines): the patch
applies cleanly to a pristine v0.1.6 clone, the patched tree is tree-identical to `cli/`
(excluding `node_modules`/`dist`/`.git`), and build + tests pass **74/74** (re-verified
2026-10-21 13:04).

Informational notes:

- `~/.agnes/memories` mtime changed during the session (DeepSeek Harness memory subsystem). The
  repo scripts do not write to `~/.agnes` (forbidden-path guard; tight snapshot proof in §4.4).
- The previously reported defects `B1`, `M1`–`M4`, `L1`–`L4` are all confirmed fixed; no new
  blocking defect was introduced by the fixes (2 suites/tests were added: `install-roundtrip`
  and its assertions — 12 suites total now).
- `docs/verification.md` itself is the 122nd candidate and is intentionally not in the non-report
  hash manifest.

---

## 6. Residual risks / limitations (not repo defects)

1. **Live generation not exercised:** image/video generation was not run (cost/instruction). The
   Video 2.5 contract is verified offline via payload/URL assertions and a fake server; the
   current API also reports a service-side "video queue full" state, not a repo defect. A live
   keyframe/reference poll should be validated when the service recovers.
2. **CLI feature gaps (documented in the skill):** no Base64 image output, no audio/video
   reference media, no last-frame-only keyframes, no convenience commands for `/v1/responses` or
   `/v1/messages`; raw HTTP fallbacks are documented. Image `--seed` is an undocumented
   pass-through.
3. **JSON error envelope:** commander-level argument errors (missing required option/command)
   bypass `--json` (accepted known gap encoded in `tests/cli-contract.test.mjs`).
4. **Media bridge:** local files go to public third-party hosts (uguu/x0 first in `.env.local`);
   Litterbox (403/412) and tmpfiles (TLS) are currently unusable from this host; per-provider
   timeout is not implemented and uploads occur without confirmation (privacy trade-off).
5. **Global install intentionally not applied:** `/usr/local/bin/agnes` is still `0.1.6`;
   `install-local.sh` was only dry-run. Applying it (after commit) will replace the global
   package and update `~/.agents/skills`; backups/rollback are now verified.
6. **Free-tier rate limits / provider variance:** the live `agnes-2.5-flash` ping succeeded
   (5.6 s in this round); quota/rate limits may affect repeated smoke runs.
7. **Uninstall restores only manifest-recorded state:** without a manifest it falls back to the
   newest backup dir heuristics and cannot know the previous bin-link target (documented in the
   script); real installs always write the manifest.
8. **Env validation scope:** invalid `AGNES_MEDIA_PROVIDER_ORDER` is rejected only when a command
   resolves config (passthrough `media url` does not); this matches the implementation and docs.
9. Any edit after the fingerprint in the header invalidates this report.

---

## 7. Ready-to-commit statement

**YES — the current tree is ready to commit.** All user requirements are met and independently
verified: the canonical patched CLI, both skills, scripts and offline tests live in the project
directory; the CLI builds and its 74 offline tests plus the 12-suite repo gate are green; the
documented model/API contract (including Video 2.5 payloads and `model_name` polling) matches the
implementation; the key exists only in the gitignored, mode-600 `.env.local` (live ping proves it
is valid) and appears in no commit candidate; install/uninstall are backed up and the rollback
path is now verified to restore the previous state without touching the repo or `~/.agnes`; and
the upstream research claim (no newer generation CLI) was re-confirmed against npm/GitHub.

There is no open residual defect. The final patch
(`a9df524c0ff1b3ac6cda0dc0a4b816e4d6f1c19c78992bf6f0448397582844de`, 2,512 lines) applies
cleanly to a pristine v0.1.6 clone, is tree-identical to the vendored `cli/`, and builds/passes
**74/74** — the previously recorded cosmetic `R-1` is resolved by this regeneration.

---

## 8. Evidence artifacts (session-local, not committed)

`/tmp/agnes-verify2/`: `contract.mjs` + `contract.log` (107 checks), `cli-test.log` (74/74),
`root-test.log` (12 suites), `my-roundtrip.sh` (independent 34-check round-trip),
`patchcheck/` (applied-patch tree + `patch-build.log`/`patch-test.log`), `global-before/after
.forhash`, `smoke-live.log`, `doctor-offline.log`, `sync-online.log`,
`candidates-nonreport.sha256` (hash `c95e48b3…`, round-2 patch). `/tmp/agnes-verify3/`: final
`R-1` re-check — pristine clone + final patch `patchcheck/` (`patch-build.log`/`patch-test.log`,
tree-identical diff), `nonreport.sha256` (hash `95369f28…`). Round-1 artifacts remain under
`/tmp/agnes-verify/`.
