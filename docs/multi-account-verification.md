# Independent verification — multi-account routing + batch production (FINAL)

- **Verifier:** independent verifier teammate (`verifier`, shared task `task-4`). Wrote no
  production code and no repo test; this report is the only repo file written by the verifier.
- **Date / host:** 2026-10-23, 15:25–16:50 (Asia/Shanghai); final evidence pass 16:45:42–16:48.
  macOS 14.5 ARM64 (`MACdeMacBook-Pro.local`), Node `v22.22.3`, npm `10.9.8`.
- **Repo:** `/Users/mac/Documents/research/agnes`, git `bb3f148` plus the uncommitted
  multi-account/batch feature work under review. The verifier made no commit, changed no
  production file, and did not touch the real credential outside the live shell script.
- **Method:** independent harness **outside** the repo (`/tmp/agnes-multi-verify/`) that drives the
  real built CLI (`node cli/bin/agnes.js`, clean env with `AGNES_NO_DOTENV=1`, temp
  `HOME`/`AGNES_STATE_DIR`) against a verifier-written fake Agnes API server (`node:http`).
  Expectations were derived only from `docs/multi-account-design.md` (§2–§6, §8) and
  `docs/multi-account-research.md`; no repo unit-test name or fixture was trusted. Live AC8
  checks read the real key **inside a shell only** (value never printed) and touched no
  image/video endpoints. AC9 was checked by applying `patches/cli-local.patch` to a pristine
  upstream `v0.1.6` clone and comparing the resulting tree to `cli/`, then building and testing
  the patched tree.
- **Final independent harness result:** **167/167 checks pass** in 8 sections — baseline 11,
  AC2 config 33, AC3 routing 19, AC4 limits 22, AC5 affinity 17, AC6 batch 49, AC7 security 7,
  adversarial 9. Final live AC8/AC7/AC9 shell script: **62/62 pass**.
- **Verified state fingerprint** (sha256, first 16 hex; captured 2026-10-23 16:45:42 CST; any
  later edit to these files invalidates the evidence below; this report itself is excluded):
  `cli/src/accounts/affinity.ts b26bf1e40e2a5cb3`, `cli.ts 5f85dffe08daa744`,
  `config.ts c2918a63e4ba8902`, `limits.ts bf14e78fa889b23e`, `route.ts 91673c698edad2e2`,
  `router.ts 3fa273bd697f7c98`, `types.ts b202334917206204`;
  `cli/src/batch/cli.ts b84acea0ec452eb8`, `input.ts 8691aafb3b1b3d35`,
  `manifest.ts a10787ff6d987ebc`, `runner.ts ed56ca478dcddfbc`, `types.ts 9a1de679bf236015`;
  `cli/src/config.ts aadaf6870e4bbc08`, `cli/src/cli.ts f5283dac3a9f3fca`,
  `cli/src/index.ts c054a5098aaf5277`, `cli/src/http/requestJson.ts 041c0191e15c3232`,
  `cli/src/text/complete.ts c43a4e3d10a3d053`, `cli/src/image/generateImage.ts e68cf2edca0872f0`,
  `cli/src/video/generateVideo.ts 88b60c9a22fe442a`, `getVideo.ts 85b7f2d12dba0095`,
  `pollVideo.ts be19b11f3fbf8018`, `cli/src/auth/check.ts 4806dc81f8411274`,
  `cli/package.json 9cfbb40aa40144bb`, `cli/package-lock.json 785475f4f0cc5732`,
  `cli/UPSTREAM.md e74739f584a3fe4d`, `README.md 9394b08474a0ae03`,
  `cli/README.md 755a5e67dac0693d`, `.env.example 9cc760cfef310be8`,
  `.gitignore 4b09a193b6a9932a`, `patches/cli-local.patch 514de94076964366`,
  `docs/multi-account-design.md 491669885f4bbb99`,
  `docs/multi-account-research.md b2d9849722a8fb4c`.

---

## 1. Verdict

**PASS — the multi-account routing and batch production feature is ready to commit.**

All acceptance criteria AC1–AC10 pass under independently produced evidence:

- repo suites and CLI build are green — CLI **209/209** tests, repo **12 suites / 0 failures**,
  `scripts/smoke.sh` **7 pass / 0 warn / 0 fail**;
- the independent 167-check harness passes every AC2–AC7 behaviour and the adversarial cases
  against a fake API (config precedence/validation/redaction, all five routing strategies,
  documented rate-limit presets, 429/`Retry-After`/cooldown handling, safe create failover vs.
  status no-rotation, `AMBIGUOUS_CREATE`, affinity journal/probe/persistence and the fixed
  inter-process lock, batch run/status/retry/resume/consistency including kind-aware defaults,
  `defaultsByKind`, `modelSource`, `INVALID_JOB`, and secret hygiene);
- live AC8 passes with `accounts check --live --probe text` as the credential proof, one routed
  text ping, and mixed fake-key/real-key pool failover; no live image/video generation;
- the FINAL patch `514de940…` (`14,616` lines) applies cleanly to pristine upstream `v0.1.6`
  (`9e629302…`, clean), the patched tree is `diff -rq`-identical to `cli/` (excluding
  `node_modules`/`dist`/`.git`), and the patched tree builds and passes **209/209** tests;
  version and user-facing docs consistently say `0.3.0-local.1` and 209 tests.

Three defects found during verification were fixed and re-verified: (V-1) affinity-journal
merge-on-write lost entries under concurrent CLI processes (now inter-process-locked; repros
0/12 and 0/10), (V-2) the insecure accounts-file warning was not on stderr as design §2.3
requires (now on stderr as well), and (V-3) `<out>/input.json` omitted the normalized
`defaultsByKind` section that design §6.2 requires (now persisted when provided, optional when
absent, old-shaped `input.json` resumes remain zero-new-create). No blocking or major defect
remains open.

---

## 2. Acceptance criteria

| AC | Requirement | Result | Key independent evidence |
|---|---|---|---|
| **AC1** Compatibility | Pre-existing suites + build pass | **PASS** | `npm --prefix cli test`: **209/209**, 0 fail; repo `npm test`: **12 suites / 0 failures** (includes secrets 6/6); `npm --prefix cli run build` exit 0; `bash scripts/smoke.sh`: 7 pass / 0 warn / 0 fail; legacy single-key CLI behaviour unchanged (11/11 baseline checks, human output unchanged) |
| **AC2** Config | legacy/indexed/file modes, precedence, pool validation, redaction, invalid → exit 2, insecure warning | **PASS** | 33/33 checks: legacy `default/free/primary`; indexed types/pools/weights/priorities/order; `AGNES_ACCOUNTS` order + sorted default; file > env > legacy precedence; `key` wins over `keyEnv`; file router settings + label; invalid type/weight/strategy/attempts/wait/rate-limit/unknown field/duplicate ids/missing key/malformed JSON/bad id/unsupported version → exit 2 `INVALID_ACCOUNTS_CONFIG`; keys never printed (`present (len=N)` only); insecure file mode warns on **stderr** and in `warnings[]`, silenced by `AGNES_ACCOUNTS_ALLOW_INSECURE=1`; JS API with explicit `apiKey` stays file-free and does not persist affinity state |
| **AC3** Routing | round-robin/weighted/least-inflight/adaptive/primary, forced `--account`, model filter, shared pool cooldown, accounts check | **PASS** | 19/19 checks: RR alternates 2/2 over 4 creates and honours `AGNES_ACCOUNTS` order; weighted 2:1 over 9 creates favours the heavy account; least-inflight sends more to the faster account; primary uses priority-0 account and fails over on 429; forced `--account` touches only that account; model allowlist routes text vs image to the capable account and refuses a forced incapable account without sending; a 429 on one account skips its same-pool sibling while another pool serves; `accounts check` bare = config only (no network); `--live` default models probe reports `reachable=true`/`credentialValidated=false` + warning; `--probe text` implies live, sends exactly one minimal `max_tokens:1` `ping` completion per account, `credentialValidated=true`, uses each account's allowlist model (default `agnes-2.5-flash`); rejected credential → exit 1 only for that account; unknown probe → exit 2 `INVALID_PROBE` with no network |
| **AC4** Rate limits | presets, 429/Retry-After, pool cooldown, create failover vs status no-rotation, AMBIGUOUS_CREATE, max-wait/attempts | **PASS** | 22/22 checks: free text RPM10 (10 sent, 11th/12th paced `RATE_LIMITED`), image 3K/4K RPM1, free video RPM1, enterprise video RPM2, tokenplan video RPM5; `AGNES_RATE_LIMIT=off` bypass; create 429 fails over to another pool with exactly one rejected send (`waitedMs=0`, safe pre-execution reroute); status 429 honours numeric `Retry-After` (~1 s) and never rotates account; HTTP-date `Retry-After` parsed; persistent status 429 → `RATE_LIMITED` bounded; max-wait 300 ms beats a 5 s `Retry-After`; max-attempts bounds total sends; POST 5xx/timeout → `AMBIGUOUS_CREATE` with exactly one send and no failover; 401/402/403 fail over; 400/404/422 returned without failover; forced account + 429 fails without failover; status 5xx retries the same account; `parseRetryAfterMs` unit contract |
| **AC5** Affinity | create binds `video:`/`task:`, poll uses same account, journal across processes, probe, `--account` override | **PASS** | 17/17 checks: journal entries for `video:`/`task:` with state dir 0700/file 0600; poll resolves affinity despite round-robin order/backup-first; journal survives separate CLI processes; missing journal probes backup 404 → owner and stops (bounded `min(3, accounts)`), rebuilds journal, later calls do not re-probe; 429 during probe honours `Retry-After`; forged id all-404 → `AFFINITY_NOT_FOUND` with `--account` guidance; explicit `--account` overrides journal; legacy `task_` id resolves; `session:` affinity sticks for text/image/video creates; explicit account re-binds after success; default `~/.agnes/state` 0700/0600; **3 rounds × 4 concurrent processes preserve every binding** (V-1 fix re-verified); single-account works with no probe |
| **AC6** Batch | JSON/JSONL, defaults, order, concurrency, manifest/results/events, resume, consistency, dry-run, exit codes, kind-aware defaults | **PASS** | 49/49 checks: dry-run prints plan JSON and writes/sends nothing; success manifest `agnes-batch/1` with input sha256, config, input-order jobs, results/events/input copy (manifest+input 0600); deterministic order under out-of-order completion; bounded concurrency; record mode distributes + `mixedAccounts=true`; strict pins one account for creates and polls; `--account` implies strict; strict 401 fails without failover; record video jobs poll the same account; JSONL + CLI defaults; blank lines ignored, comment lines cleanly rejected (or tolerated — recorded); duplicate ids/unknown keys/kind-mode mismatch/missing prompt/version 2/forbidden defaults/invalid id/oversized metadata/unknown text mode → exit 2 with no requests; **kind-aware flat defaults** (image model/size never leak to video/text; `modelSource` `defaults`/`kind-default`/`job`); **`defaultsByKind`** overrides + validation (unknown kind/incompatible/unknown param → exit 2 `INVALID_BATCH_INPUT`); mixed 7-job image+video+text batch with no cross-kind model leak; INVALID per-job option → failed `INVALID_JOB` (`retryable:false`, one attempt, message prefixed with job id, no create sent, neighbours continue); normalized `input.json` retains `defaultsByKind` when provided and omits it when absent; resume/retry semantics: zero new creates on resume, `BATCH_INPUT_CHANGED` on changed succeeded input, abort on consistency/batchId/defaults change, recover interrupted `running` job (`recoveredFrom:"running"`, ambiguity warning) on the pinned account, append new jobs, mark removed jobs `skipped/removed_from_input`, legacy-shaped `input.json` (no `defaultsByKind`) resumes with zero new creates; retry `failed`/`pending` re-runs only those, `all` never re-runs succeeded; status exits 0 (missing manifest → 2); fail-fast stops scheduling; non-empty out dir requires `--resume`/`--force`; polling honours `--poll-interval` floor |
| **AC7** Security | `sk-` scan of artifacts/output, state modes, `.gitignore`, no real key in repo | **PASS** | 7/7 security checks + live scans: no fixture credential in any captured CLI stdout/stderr; no credential material in section/batch/state/HOME artifacts; state dir 0700 + journal 0600 (fresh multi-account run); manifest + `input.json` 0600, manifest/events carry no keys; `.gitignore` covers `.agnes-accounts.json`, `agnes-accounts.json`, `agnes-batch/` and `git check-ignore` confirms; docs have no long `sk-` literals except allowlisted placeholders; real-key exact scan over the repo (excluding `.env.local`/node_modules/dist/.git) = **0 files**; test fixtures only clearly-fake `sk-` shapes |
| **AC8** Live | `accounts check --live --probe text` proves credential; models probe reachability-only; routed text ping; mixed fake+real failover; no live generation | **PASS** | 62/62 live shell checks: models probe exit 0, `probe=models`, `reachable=true`, `credentialValidated=false`, modelCount 9, warning tells the operator to use `--probe text`; `--live --probe text` exit 0, `probe=text`, `credentialValidated=true`, httpStatus 200, model `agnes-2.5-flash` (one minimal `max_tokens:1` completion for the single configured account); routed text ping exit 0 (`accountId=default`, answer contains `pong`); mixed fake-first pool create exits 0 on `real` with `routing.attempts=2`, `routing.fallback=true` (fake 401 routed around); real-key repo scan 0 files; no image/video generation requested. Key read only in-shell (`len=51` printed) |
| **AC9** Packaging | suites/build green, patch applies to pristine v0.1.6 tree-identical, version + docs consistent | **PASS** | CLI 209/209 + repo 12/0 + build + smoke 7/0; FINAL patch sha256 `514de9407696436691e4f0e0b9737e6988670aa6eb69873cc8486a307111da7a` (14,616 lines) — `git apply --check`/`git apply` OK on pristine `v0.1.6` (`9e629302…`, tag == HEAD, 0 dirty files), `diff -rq --exclude=node_modules --exclude=dist --exclude=.git` → **tree-identical to `cli/`**, patched tree `npm run build` OK and `node --test` **209/209**; `agnes --version` = `cli/package.json` = `0.3.0-local.1`; README (root + CLI), `.env.example`, skills and `cli/UPSTREAM.md` all say `0.3.0-local.1`/209 and document `--account`/`--strategy`/`--affinity`/probe/`defaultsByKind`/`modelSource`/`INVALID_JOB`/`RATE_LIMITED`; `cli/UPSTREAM.md` keeps the v0.2.0 baseline bullets before the 0.3.0 section; no stale `196` counts or `NO_ELIGIBLE_ACCOUNT` strings |
| **AC10** Independent verification | Verifier harness outside repo + report | **PASS** | This report + `/tmp/agnes-multi-verify/` harness (167 checks, 8 sections) and live script (62 checks); verifier wrote no production code/test and only this file in the repo |

---

## 3. Method and harness

### 3.1 Independent fake Agnes API server (`/tmp/agnes-multi-verify/lib/fake-server.mjs`)

Written by the verifier from the design contract and the upstream response shapes the CLI parses:
per-credential accounts, `POST /v1/chat/completions`, `POST /v1/images/generations`,
`POST /v1/videos`, `GET /agnesapi?video_id=…`, legacy `GET /v1/videos/<task_id>`,
`GET /v1/models`; scripted responses (429 + `Retry-After`, 401/402/403/404/422/500, delays,
socket destroys), per-account request/counter/concurrency recording, cross-account task isolation
(404 when a task is polled by a different credential), and per-create video status sequences for
poll-pacing tests.

### 3.2 CLI driver and checks (`/tmp/agnes-multi-verify/`)

Each check spawns `node cli/bin/agnes.js …` in a fresh temp cwd with a minimal env
(`AGNES_NO_DOTENV=1`, temp `HOME`/`TMPDIR`/`AGNES_STATE_DIR`, `AGNES_BASE_URL` pointing at the
fake server); JSON is parsed from stdout/stderr, exit codes and elapsed times are asserted, and
every transcript/file is scanned for fixture credentials. Sections and counts:
baseline/back-compat 11, AC2 config 33, AC3 routing 19, AC4 limits 22, AC5 affinity 17,
AC6 batch 49, AC7 security 7, adversarial 9 = **167 checks** (final run
`results-2026-10-23T08-48-14-315Z.json`, 0 failed, 49 s). Adversarial cases include: mixed
invalid+valid key pool; unknown account id; missing accounts file; status 404 without rotation;
poll-loop 429 pacing; ambiguous batch create; invalid `--concurrency`; forced-account strict 429;
stale journal binding.

Run: `node /tmp/agnes-multi-verify/harness.mjs` (sections selectable, e.g. `… ac2 ac6`).

### 3.3 Live checks (`/tmp/agnes-multi-verify/scripts/live-checks.sh`)

Reads `AGNES_API_KEY` from the mode-600, gitignored `.env.local` **inside the shell** (prints only
`len=51`), runs the live CLI invocations, sanitises JSON before printing, scans every produced
file and the repo tree for the exact key, and verifies state modes and docs/version/count
consistency. Live calls are `GET /v1/models`, **one** `--probe text` minimal completion, **one**
routed text ping and **one** mixed-pool failover text create; no live image/video generation.
Transient `fetch failed` responses are retried (max 3 attempts); the final run needed one attempt
for every call.

---

## 4. Evidence highlights

### 4.1 Suites, build and smoke (AC1/AC9)

```console
$ npm --prefix cli test
# tests 209   # pass 209   # fail 0

$ npm test
summary: 12 suite(s), 0 failure(s)
# includes: cli suite, 8 shell suites (env-example, install-dry-run, install-roundtrip,
# scripts-syntax, setup-doctor, smoke-offline, upstream-record, wrapper-env),
# cli-contract, models-consistency, secrets (6/6)

$ npm --prefix cli run build     # exit 0
$ bash scripts/smoke.sh          # 7 pass, 0 warn, 0 fail
```

### 4.2 Independent harness (AC2–AC7 + adversarial)

```console
$ node /tmp/agnes-multi-verify/harness.mjs
# summary: 167/167 checks passed, 0 failed
#   baseline             pass=11 fail=0
#   AC2-config           pass=33 fail=0
#   AC3-routing          pass=19 fail=0
#   AC4-limits           pass=22 fail=0
#   AC5-affinity         pass=17 fail=0
#   AC6-batch            pass=49 fail=0
#   AC7-security         pass=7  fail=0
#   adversarial          pass=9  fail=0
```

Representative assertions (full list in the harness/logs):

- **Config:** legacy/`AGNES_ACCOUNT_*`/accounts-file modes, precedence, pool validation, all
  invalid configs exit 2 `INVALID_ACCOUNTS_CONFIG`, redaction (`present (len=N)` only), insecure
  file warning on stderr and in `warnings[]`, JS API file-free behaviour.
- **Routing:** RR order/counts, weighted 2:1, least-inflight faster-account preference, primary
  priority + 429 failover, forced `--account`, model-capability allowlist routing/refusal,
  shared-pool cooldown skips the sibling account; `accounts check` bare/models/text probe
  semantics and unknown-probe error.
- **Limits:** the whole documented preset table exercised at its edges (text RPM10, image
  3K/4K RPM1, video free RPM1 / enterprise RPM2 / tokenplan RPM5); numeric + HTTP-date
  `Retry-After`; pool cooldown and create failover with exactly one rejected send; status
  no-rotation under persistent 429; `maxWaitMs`/`maxAttempts`; `AMBIGUOUS_CREATE` exactly-once
  for 5xx and client timeouts.
- **Affinity:** journal contents/modes; poll uses the create account despite RR order;
  cross-process persistence; bounded probe with 429 handling and journal rebuild; forged id →
  `AFFINITY_NOT_FOUND`; explicit `--account` override; session affinity for text/image/video;
  3×4 concurrent-process journal writes preserve all bindings; default `~/.agnes/state` modes.
- **Batch:** manifest/results/events/input copy; deterministic order; bounded concurrency;
  record/strict; JSONL and defaults; kind-aware flat defaults, `defaultsByKind`, `modelSource`,
  `INVALID_JOB`; validation matrices; dry-run writes nothing; resume zero-new-creates and
  `BATCH_INPUT_CHANGED`/`BATCH_DEFAULTS_CHANGED` aborts; interrupted-running recovery;
  append/removed jobs; legacy-shaped `input.json` resume; retry modes; status/fail-fast/out-dir
  guards; exit codes 0/1/2.
- **Adversarial:** see §3.2.

### 4.3 Live acceptance (AC8)

```console
ok - AC8a-models/accounts-check-live-exit-0
  {"ok":true,"probe":"models","warnings":["GET /v1/models is reachable without a valid credential on the real gateway; use --probe text to prove account access."],
   "accounts":[{"id":"default","probe":"models","ok":true,"reachable":true,"credentialValidated":false,"httpStatus":200,"modelCount":9}]}
ok - AC8a-models/models-probe-is-reachability-only (credentialValidated=false, warning names --probe text)
ok - AC8a-text/probe-text-proves-real-credential (credentialValidated=true, httpStatus=200)
  {"ok":true,"probe":"text","accounts":[{"id":"default","probe":"text","ok":true,"credentialValidated":true,"httpStatus":200,"model":"agnes-2.5-flash"}]}
ok - AC8b/routed-text-ping-succeeded
  {"ok":true,"accountId":"default","poolId":"default","text":"…pong","routing":{"attempts":1,"fallback":false,"waitedMs":0}}
ok - AC8c/mixed-pool-routed-around-401-fake-key (accountId=real, fallback=true)
  {"ok":true,"accountId":"real","fallback":true,"attempts":2,"text":"…pong."}
ok - AC7/real-key-exact-scan-repo (0 files)
# live checks: 62 passed, 0 failed
```

The fabricated key used for the mixed pool is a fake `sk-…` fixture; the real account completed
the routed create after the fake key's 401 (`routing.attempts=2`, `routing.fallback=true`). No
image/video generation was requested.

### 4.4 Patch application and tree identity (AC9)

```console
$ shasum -a 256 patches/cli-local.patch
514de9407696436691e4f0e0b9737e6988670aa6eb69873cc8486a307111da7a  patches/cli-local.patch
$ wc -l patches/cli-local.patch
14616
$ git -C <pristine-upstream-clone> rev-parse HEAD
9e629302cf30898d09f60fb2ba3e52e795b7ccf4   # == v0.1.6 tag, 0 dirty files
$ git apply --check patches/cli-local.patch   # OK
$ git apply patches/cli-local.patch           # OK
$ diff -rq --exclude=node_modules --exclude=dist --exclude=.git <patched-tree> <repo>/cli
# (no output) -> TREE IDENTICAL
$ (cd <patched-tree> && npm run build && node --test)
# tests 209   # pass 209
```

`agnes --version` = `0.3.0-local.1` = `cli/package.json`; docs counts/version/flags verified above.

### 4.5 Regression repros for fixed findings

```console
$ node /tmp/agnes-multi-verify/repro-journal-race.mjs 12
# lost updates: 0/12
$ node /tmp/repro-session-race.mjs
# lost session bindings: 0/10
```

(V-1 pre-fix measured 9/12 and 2/10 lost updates; V-2/V-3 re-verified via the harness checks
and AC6/AC2 assertions above.)

---

## 5. Findings fixed during verification

| ID | Finding | Independent re-test after fix |
|---|---|---|
| **V-1** (medium) | Affinity journal merge-on-write lost entries when two CLI processes bound resources concurrently (read-merge-rename without an inter-process lock). Pre-fix repro: 9/12 lost video-entry updates; 2/10 lost `session:` bindings. | Core added an inter-process lock (`.lock` dir, bounded retries/staleness). Re-run: **0/12** lost video updates, **0/10** lost session bindings; harness 3 rounds × 4 concurrent CLI creates preserve every `video:`/`task:` binding. |
| **V-2** (minor) | Insecure accounts-file warning appeared only in command output (`warnings[]`/human block), not on stderr; design §2.3 requires stderr. | `process.stderr.write("warning: …")` now emitted; re-test: warning on stderr and still in `warnings[]`; `AGNES_ACCOUNTS_ALLOW_INSECURE=1` suppresses it. |
| **V-3** (minor, final pass) | Updated design §6.2 says `<out>/input.json` includes the normalized `defaultsByKind` section; it was omitted. | Fixed via Lead ruling (a): `input.json` now retains `defaultsByKind` when provided, omits it when absent, and an emulated old-shaped `input.json` (key removed) resumes with **zero new creates**; harness checks added and passing. |

## 6. Interpretations settled with the Lead

1. **Create-path 429 → immediate failover is PASS.** A 429 from the create endpoint is a
   pre-execution rejection (research P5), so the router may reroute immediately without waiting
   for the pool cooldown; waiting is only required when no other eligible account exists. Design
   §3 wording was updated accordingly; the independent checks accept `waitedMs=0` failover while
   still verifying `Retry-After` on status GETs and cooldown behaviour for later requests.
2. **`/v1/models` is not a credential oracle.** Live probing on 2026-10-23 showed fabricated
   `sk-…` tokens returning HTTP 200 on some identical requests and 401 on others (real key stable
   200; no-token mostly 401). Design/research/docs now document the models probe as
   reachability-only and `accounts check --live --probe text` as the credential proof; AC8 was
   verified through `--probe text`.
3. **`batch --json` prints the summary object** on stdout (`ok/command/batchId/outDir/summary/
   config/failedJobs`) while progress goes to stderr; the harness asserts the documented summary
   fields and that stdout parses as one JSON object.

## 7. Residual risks / limitations (not open defects)

1. **No live image/video generation** was performed (cost/instruction). Image/video payloads,
   429/affinity/poll and batch video paths are verified against the fake server; live calls were
   limited to `GET /v1/models`, one `--probe text` minimal completion, one routed text ping and
   one mixed-pool text create — no live image/video.
2. **Upstream `GET /v1/models` token-validation inconsistency** (fabricated tokens 200/401 at
   random; real key stable 200) is an upstream behaviour, not a feature defect. The tool
   mitigates it by documenting reachability-only semantics and offering `--probe text`; a
   models-only `accounts check --live` cannot prove credential validity.
3. **Cross-account video-id semantics are inferred** (401/404), not directly tested live; the
   implementation is conservative (affinity first, bounded probe, never rotate a bound status).
4. **Token-plan quota is not queryable** via the public API; the tool tracks local pacing and
   records 402/quota failures only.
5. **Cross-process rate coordination** is not shared between unrelated CLI invocations; the
   batch runner is the supported high-concurrency path (documented design limitation).
6. **Affinity TTL (7 days) / 5000-entry eviction** and read-only-state degradation were not
   time/OS-permission exhausted beyond the mode and concurrency checks.
7. **Batch process-kill resume** was emulated by setting a manifest job to `running`; a real
   SIGKILL mid-create cannot prove whether upstream accepted the request (the runner warns about
   ambiguity, as designed).
8. **Transient upstream failures:** one interim live run hit a transient `fetch failed` on
   `GET /v1/models`; the final live script retries transient failures and all final live calls
   succeeded on the first attempt.
9. **Pre-existing known gap (unchanged):** commander-level argument errors bypass `--json`.
10. Any edit after the fingerprint above (2026-10-23 16:45:42 CST) invalidates this report.

## 8. Evidence artifacts (session-local, not committed)

`/tmp/agnes-multi-verify/`: `harness.mjs` + section modules and `lib/` (independent fake server,
CLI driver, checks), `results-2026-10-23T08-48-14-315Z.json` (final harness run, sha256
`1186cf8ffcc003be5c5aac5c8ef639ca…`), `logs/` (`suites-final.log`, `harness-final2.log`,
`live-final.log` (62/62), `patch-final.log`, `repro-journal-final.log`, `repro-session-final.log`),
`repro-journal-race.mjs`, `repro-session-race.mjs`, `live/` (sanitized live JSON/console
evidence), `scripts/{run-suites,live-checks,patch-check,final-evidence}.sh`,
`final/fingerprint.txt`, `patchcheck/` (applied-patch tree + build/test logs; patched tree
209/209). The verifier observed the real key only inside the shell; it was never printed,
stored, or written by the harness.

## 9. Ready statement

**READY.** The multi-account routing + batch production feature passes the complete design
acceptance contract under independent, design-derived evidence: **AC1–AC10 PASS**; CLI
**209/209** and repo **12/12 suites** green (plus smoke 7/0); the verifier's own **167-check
harness** and **62-check live script** pass; the three defects found during verification
(journal concurrency, stderr warning, `input.json` `defaultsByKind`) are fixed and re-verified;
live AC8 proves the real credential via `--probe text`, a routed text ping and mixed
fake+real-key failover with no live image/video generation; no credential material appears in
generated artifacts or the repo; and the final patch `514de940…` (14,616 lines) reproduces
`cli/` byte-for-byte on pristine upstream `v0.1.6` and builds/passes **209/209** tests. No
blocking or major defect remains open.
