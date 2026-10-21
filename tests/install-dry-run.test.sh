#!/usr/bin/env bash
# Repo test: install-local.sh / uninstall-local.sh dry runs change nothing.
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)

GLOBAL_TARGET="$(npm root -g 2>/dev/null || true)/agnes-ai-cli"
SKILL_TARGET="$HOME/.agents/skills/agnes-ai-skill"
GEN_TARGET="$HOME/.agents/skills/agnes-ai-generation"
STATE_DIR="$HOME/.agnes-toolkit"

state_of() {
  local path
  path=$1
  if [ -L "$path" ]; then printf 'link:%s' "$(readlink "$path")"; elif [ -e "$path" ]; then printf 'exists'; else printf 'absent'; fi
}

before_global=$(state_of "$GLOBAL_TARGET")
before_skill=$(state_of "$SKILL_TARGET")
before_gen=$(state_of "$GEN_TARGET")
before_backups=$(ls -1 "$STATE_DIR/backups" 2>/dev/null | wc -l | tr -d ' ')

t_begin "install-local.sh --dry-run exits 0 and prints the plan"
out=$(bash "$ROOT/scripts/install-local.sh" --dry-run 2>&1)
rc=$?
assert_eq "0" "$rc" "exit code" || true
assert_contains "$out" "DRY-RUN" "dry-run output" || true
assert_contains "$out" "no files, links, or packages were changed" "dry-run disclaimer" || true

t_begin "install-local dry run changed nothing"
assert_eq "$before_global" "$(state_of "$GLOBAL_TARGET")" "global package" || true
assert_eq "$before_skill" "$(state_of "$SKILL_TARGET")" "installed skill" || true
assert_eq "$before_gen" "$(state_of "$GEN_TARGET")" "generation alias" || true
after_backups=$(ls -1 "$STATE_DIR/backups" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$before_backups" "$after_backups" "backup directory count" || true

t_begin "uninstall-local.sh --dry-run exits 0"
out=$(bash "$ROOT/scripts/uninstall-local.sh" --dry-run 2>&1)
rc=$?
assert_eq "0" "$rc" "exit code" || true
assert_contains "$out" "DRY-RUN" "dry-run output" || true

t_begin "install-local.sh --help and uninstall-local.sh --help exit 0"
if bash "$ROOT/scripts/install-local.sh" --help >/dev/null 2>&1 && bash "$ROOT/scripts/uninstall-local.sh" --help >/dev/null 2>&1; then
  t_ok
else
  t_fail "help exit non-zero"
fi

t_begin "install/uninstall --help print usage text, not code (L2)"
help_install=$(bash "$ROOT/scripts/install-local.sh" --help 2>&1)
help_uninstall=$(bash "$ROOT/scripts/uninstall-local.sh" --help 2>&1)
assert_contains "$help_install" "Usage:" "install usage heading" || true
assert_contains "$help_uninstall" "Usage:" "uninstall usage heading" || true
assert_not_contains "$help_install" "set -u" "install help leaked code" || true
assert_not_contains "$help_uninstall" "set -u" "uninstall help leaked code" || true
assert_not_contains "$help_install" "#!/usr/bin/env bash" "install help leaked shebang" || true
assert_not_contains "$help_uninstall" "#!/usr/bin/env bash" "uninstall help leaked shebang" || true

t_end
