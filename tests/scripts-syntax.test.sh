#!/usr/bin/env bash
# Repo test: every shell script must parse with bash -n, be executable where
# appropriate, and keep the documented file layout.
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)

t_begin "_lib.sh exists"
if [ -f "$ROOT/scripts/_lib.sh" ]; then t_ok; else t_fail "missing scripts/_lib.sh"; fi

for script in "$ROOT"/scripts/*.sh "$ROOT/scripts/agnes"; do
  [ -f "$script" ] || continue
  name=$(basename "$script")
  t_begin "bash -n scripts/$name"
  if bash -n "$script" 2>/dev/null; then t_ok; else t_fail "syntax error in $script"; fi
done

for script in agnes setup.sh install-local.sh uninstall-local.sh doctor.sh sync-upstream.sh smoke.sh; do
  path="$ROOT/scripts/$script"
  t_begin "scripts/$script is executable"
  if [ -x "$path" ]; then t_ok; else t_fail "scripts/$script is not executable"; fi
done

t_begin "_lib.sh is sourced, not executable-by-need"
mode=$(stat -f '%Lp' "$ROOT/scripts/_lib.sh" 2>/dev/null || stat -c '%a' "$ROOT/scripts/_lib.sh" 2>/dev/null)
if [ "${mode:-644}" = "644" ]; then t_ok; else t_skip "mode $mode (not required to be 644)"; fi

t_begin "run-all.sh exists and parses"
if [ -f "$ROOT/tests/run-all.sh" ] && bash -n "$ROOT/tests/run-all.sh" 2>/dev/null; then t_ok; else t_fail "tests/run-all.sh missing or invalid"; fi

t_end
