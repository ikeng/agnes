#!/usr/bin/env bash
# Repo test: smoke.sh works offline and never makes live calls by default.
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)

t_begin "smoke.sh --help exits 0"
if bash "$ROOT/scripts/smoke.sh" --help >/dev/null 2>&1; then t_ok; else t_fail "smoke --help failed"; fi

t_begin "smoke.sh offline run 1 exits 0"
out1=$(bash "$ROOT/scripts/smoke.sh" 2>&1)
rc1=$?
assert_eq "0" "$rc1" "exit code" || true
assert_contains "$out1" "offline mode" "offline notice" || true
assert_contains "$out1" "models: text=agnes-2.5-flash" "model defaults" || true
assert_not_contains "$out1" "live text ping" "no live ping by default" || true

t_begin "smoke.sh offline run is idempotent"
out2=$(bash "$ROOT/scripts/smoke.sh" 2>&1)
rc2=$?
assert_eq "0" "$rc2" "exit code" || true
assert_contains "$out2" "0 fail" "no failures" || true

t_begin "smoke.sh does not leak the API key"
leak=$(printf '%s\n%s' "$out1" "$out2" | grep -Eo 'sk-[A-Za-z0-9_-]{20,}' || true)
assert_eq "" "$leak" "key leak" || true

t_begin "smoke.sh --live handles a failed preflight without unbound variable (L1)"
if env -i PATH="/usr/bin:/bin" /bin/sh -c 'command -v node' >/dev/null 2>&1; then
  t_skip "node still visible in restricted PATH"
else
  isol_home=$(mktemp -d "${TMPDIR:-/tmp}/agnes-smoke-home.XXXXXX")
  live_out=$(env -i HOME="$isol_home" PATH="/usr/bin:/bin" AGNES_API_KEY= AGNES_BASE_URL=     bash "$ROOT/scripts/smoke.sh" --live 2>&1)
  live_rc=$?
  rm -rf "$isol_home"
  assert_not_contains "$live_out" "unbound variable" "unbound variable crash" || true
  assert_contains "$live_out" "cannot run live smoke" "live guard message" || true
  if [ "$live_rc" -ne 0 ]; then t_ok; else t_fail "expected non-zero exit for failed preflight"; fi
fi

t_end
