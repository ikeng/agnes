#!/usr/bin/env bash
# tests/lib.sh — tiny assertion helpers for the shell-based repo tests.
# Sourced by tests/*.test.sh; uses only bash 3.2-compatible features.
set -u

TESTS_RUN=0
TESTS_FAIL=0
TESTS_SKIP=0

t_begin() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf '  - %s\n' "$1"
}

t_ok() {
  printf '      ok\n'
}

t_skip() {
  TESTS_SKIP=$((TESTS_SKIP + 1))
  printf '      skip (%s)\n' "${1:-skipped}"
}

t_fail() {
  TESTS_FAIL=$((TESTS_FAIL + 1))
  printf '      FAIL\n'
  [ $# -gt 0 ] && printf '        %s\n' "$*"
}

t_end() {
  if [ "$TESTS_FAIL" -gt 0 ]; then
    printf '  => %d checks, %d failure(s), %d skipped\n' "$TESTS_RUN" "$TESTS_FAIL" "$TESTS_SKIP"
    return 1
  fi
  printf '  => %d checks, 0 failures, %d skipped\n' "$TESTS_RUN" "$TESTS_SKIP"
  return 0
}

assert_eq() {
  local expected actual name
  expected=$1
  actual=$2
  name=$3
  if [ "$expected" = "$actual" ]; then
    t_ok
  else
    t_fail "$name: expected [$expected], got [$actual]"
  fi
}

assert_contains() {
  local haystack needle name
  haystack=$1
  needle=$2
  name=$3
  case "$haystack" in
    *"$needle"*) t_ok ;;
    *) t_fail "$name: missing [$needle]" ;;
  esac
}

assert_not_contains() {
  local haystack needle name
  haystack=$1
  needle=$2
  name=$3
  case "$haystack" in
    *"$needle"*) t_fail "$name: unexpectedly found [$needle]" ;;
    *) t_ok ;;
  esac
}

# Return the repo root for a test file located in tests/.
test_repo_root() {
  test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  (CDPATH= cd -- "$test_dir/.." && pwd)
}
