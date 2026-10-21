#!/usr/bin/env bash
# Repo test: setup.sh --check, doctor.sh --offline and sync-upstream.sh
# --offline are read-only, exit cleanly, and never leak the key.
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)

hash_file() {
  local file
  file=$1
  if [ -f "$file" ]; then shasum -a 256 "$file" 2>/dev/null | awk '{print $1}'; else printf 'missing'; fi
}

before_env=$(hash_file "$ROOT/.env.local")
before_manifest=$(hash_file "$HOME/.agnes-toolkit/install-manifest.env")

t_begin "setup.sh --check exits 0"
out=$(bash "$ROOT/scripts/setup.sh" --check 2>&1)
rc=$?
assert_eq "0" "$rc" "exit code" || true
assert_contains "$out" "PASS: node" "node check" || true

t_begin "doctor.sh --offline exits 0 and reports sections"
out=$(bash "$ROOT/scripts/doctor.sh" --offline 2>&1)
rc=$?
assert_eq "0" "$rc" "exit code" || true
assert_contains "$out" "== environment ==" "environment section" || true
assert_contains "$out" "== project build ==" "build section" || true
assert_contains "$out" "== CLI ==" "cli section" || true
assert_contains "$out" "== .env settings (key masked) ==" "env section" || true
assert_contains "$out" "== auth ==" "auth section" || true
assert_contains "$out" "== skills and symlinks ==" "skills section" || true
assert_contains "$out" "== upstream drift ==" "drift section" || true
assert_not_contains "$(printf '%s' "$out" | grep -Eo 'sk-[A-Za-z0-9_-]{20,}' || true)" "sk-" "key value leak" || true

t_begin "doctor.sh --help exits 0"
if bash "$ROOT/scripts/doctor.sh" --help >/dev/null 2>&1; then t_ok; else t_fail "doctor --help failed"; fi

t_begin "sync-upstream.sh --offline exits 0"
out=$(bash "$ROOT/scripts/sync-upstream.sh" --offline 2>&1)
rc=$?
assert_eq "0" "$rc" "exit code" || true
assert_contains "$out" "recorded:" "recorded versions" || true

t_begin "sync-upstream.sh --help exits 0"
if bash "$ROOT/scripts/sync-upstream.sh" --help >/dev/null 2>&1; then t_ok; else t_fail "sync --help failed"; fi

t_begin ".env.local unchanged by read-only commands"
after_env=$(hash_file "$ROOT/.env.local")
assert_eq "$before_env" "$after_env" ".env.local hash" || true

t_begin "read-only commands did not write an install manifest"
after_manifest=$(hash_file "$HOME/.agnes-toolkit/install-manifest.env")
assert_eq "$before_manifest" "$after_manifest" "manifest hash" || true

t_end
