#!/usr/bin/env bash
# run-all.sh — repository test runner (`npm test` at the repo root).
#
# Runs, in order:
#   1. the vendored CLI test suite (`npm --prefix cli test`, includes its build)
#   2. the shell repo tests in tests/*.test.sh
#   3. the Node repo tests in tests/*.test.mjs
#
# Offline by default (no live Agnes calls, no network assertions). Works with
# macOS bash 3.2. Exit status is non-zero when any suite fails.
set -u

TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$TEST_DIR/.." && pwd) || exit 1
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/agnes-tests.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

SUITES=0
FAILED=0

run_suite() {
  local name out
  name=$1
  shift
  SUITES=$((SUITES + 1))
  out="$TMP_ROOT/suite-$SUITES.log"
  printf '\n== %s ==\n' "$name"
  if "$@" >"$out" 2>&1; then
    printf 'PASS  %s\n' "$name"
    # keep a little context for the console
    tail -n 3 "$out" | sed 's/^/      /'
  else
    printf 'FAIL  %s\n' "$name"
    tail -n 60 "$out" | sed 's/^/      /'
    FAILED=$((FAILED + 1))
  fi
}

printf 'agnes-toolkit test run (%s)\n' "$(date '+%Y-%m-%d %H:%M:%S%z')"
printf 'repo: %s\n' "$REPO_ROOT"

# 1) vendored CLI suite (build + node --test). Skip with AGNES_SKIP_CLI_TESTS=1.
if [ "${AGNES_SKIP_CLI_TESTS:-0}" = "1" ]; then
  printf '\n== cli: npm --prefix cli test ==\nSKIP (AGNES_SKIP_CLI_TESTS=1)\n'
else
  run_suite "cli: npm --prefix cli test" bash -c "cd '$REPO_ROOT' && npm --prefix cli test"
fi

# 2) shell repo tests (sorted by name)
for test_file in "$TEST_DIR"/*.test.sh; do
  [ -f "$test_file" ] || continue
  run_suite "sh: $(basename "$test_file")" bash "$test_file"
done

# 3) Node repo tests (sorted by name)
for test_file in "$TEST_DIR"/*.test.mjs; do
  [ -f "$test_file" ] || continue
  run_suite "node: $(basename "$test_file")" node "$test_file"
done

printf '\nsummary: %d suite(s), %d failure(s)\n' "$SUITES" "$FAILED"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
