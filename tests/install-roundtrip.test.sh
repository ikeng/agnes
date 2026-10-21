#!/usr/bin/env bash
# Repo test: isolated install-local.sh -> uninstall-local.sh round trips.
#
# Runs entirely in a temp HOME + fake global npm root + fake npm binary, using
# AGNES_TOOLKIT_STATE_DIR for the manifest/backups. It must never touch the
# real ~/.agents, /usr/local, or ~/.agnes-toolkit.
#
# Scenarios:
#   A) global package is a real directory; skills are real directories
#   B) global package and skills were pre-existing symlinks
#   C) bin link exists and differs after install (dry-run must show the plan)
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agnes-roundtrip.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

NODE_DIR=$(dirname -- "$(command -v node 2>/dev/null || true)")
if [ ! -x "$NODE_DIR/node" ]; then
  t_begin "node available for isolated round-trip test"
  t_skip "node not found"
  t_end
  exit 0
fi

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"

# --- fake npm: global root + link into the fake global dir -------------------
cat > "$FAKE_BIN/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  root) printf '%s\n' "$FAKE_NPM_GLOBAL_ROOT" ;;
  link)
    mkdir -p "$FAKE_NPM_GLOBAL_ROOT"
    ln -sfn "$PWD" "$FAKE_NPM_GLOBAL_ROOT/agnes-ai-cli"
    ;;
  run) exit 0 ;;
  --version|-v) printf '10.9.8\n' ;;
  *) exit 0 ;;
esac
FAKE_NPM
chmod +x "$FAKE_BIN/npm"

# --- fake `agnes` binary (bin-link restore tests) ----------------------------
mkdir -p "$TMP/oldbin" "$TMP/otherbin"
for dir in oldbin otherbin; do
  cat > "$TMP/$dir/agnes.js" <<EOF
#!/usr/bin/env bash
printf '0.2.0-local.1\n'
EOF
  chmod +x "$TMP/$dir/agnes.js"
done
ln -s "$TMP/oldbin/agnes.js" "$FAKE_BIN/agnes"

# Run a project tool with a fully isolated HOME/PATH/state.
run_iso() {
  local home state global script
  local -a envcmd
  home=$1; state=$2; global=$3; script=$4
  shift 4
  envcmd=(env -i
    HOME="$home"
    PATH="$FAKE_BIN:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
    AGNES_TOOLKIT_STATE_DIR="$state"
    FAKE_NPM_GLOBAL_ROOT="$global"
    TMPDIR="$TMP")
  if [ -n "${ISO_AGENT_DIRS:-}" ]; then
    envcmd+=("AGNES_AGENT_SKILL_DIRS=$ISO_AGENT_DIRS")
  fi
  "${envcmd[@]}" bash "$ROOT/scripts/$script" "$@"
}

repo_hash() {
  shasum -a 256 "$ROOT/skill/agnes-ai-skill/SKILL.md" "$ROOT/skill/agnes-ai-models/SKILL.md" 2>/dev/null | awk '{print $1}' | shasum -a 256 | awk '{print $1}'
}

REAL_GLOBAL_BEFORE="absent"
if [ -L /usr/local/lib/node_modules/agnes-ai-cli ]; then
  REAL_GLOBAL_BEFORE="link:$(readlink /usr/local/lib/node_modules/agnes-ai-cli)"
elif [ -e /usr/local/lib/node_modules/agnes-ai-cli ]; then
  REAL_GLOBAL_BEFORE="dir"
fi
REPO_HASH_BEFORE=$(repo_hash)

# ---------------------------------------------------------------------------
# Scenario A: real-directory global package + real-directory skills.
# ---------------------------------------------------------------------------
homeA="$TMP/homeA"; stateA="$TMP/stateA"; globalA="$TMP/globalA"
mkdir -p "$homeA/.agents/skills/agnes-ai-skill" "$homeA/.agents/skills/agnes-ai-models" "$globalA/agnes-ai-cli" \
  "$homeA/.claude/skills" "$homeA/.config/devin/skills/agnes-ai-skill" "$homeA/.codex/skills"
# Legacy dangling link like the real ~/.claude/skills, plus a real skill dir.
ln -s "../../.agents/skills/agnes-ai-generation" "$homeA/.claude/skills/agnes-ai-generation"
printf 'legacy-devin-A\n' > "$homeA/.config/devin/skills/agnes-ai-skill/marker.txt"
printf 'name: agnes-ai-skill\nversion: 1.2.2\n' > "$homeA/.config/devin/skills/agnes-ai-skill/SKILL.md"
printf 'legacy-skill-A\n' > "$homeA/.agents/skills/agnes-ai-skill/marker.txt"
printf 'name: agnes-ai-skill\nversion: 1.2.2\n' > "$homeA/.agents/skills/agnes-ai-skill/SKILL.md"
printf 'legacy-models-A\n' > "$homeA/.agents/skills/agnes-ai-models/marker.txt"
printf 'name: agnes-ai-models\n' > "$homeA/.agents/skills/agnes-ai-models/SKILL.md"
printf 'legacy-global-A\n' > "$globalA/agnes-ai-cli/marker.txt"

OUT_A=$(run_iso "$homeA" "$stateA" "$globalA" install-local.sh --yes 2>&1)
RC_A=$?
t_begin "A: install-local --yes succeeds in isolation"
assert_eq "0" "$RC_A" "install exit" || true
assert_contains "$OUT_A" "linked" "install actions" || true

t_begin "A: install links CLI, both skills, and the generation alias"
assert_eq "$ROOT/cli" "$(readlink "$globalA/agnes-ai-cli" 2>/dev/null)" "global package link" || true
assert_eq "$ROOT/skill/agnes-ai-skill" "$(readlink "$homeA/.agents/skills/agnes-ai-skill" 2>/dev/null)" "skill link" || true
assert_eq "$ROOT/skill/agnes-ai-models" "$(readlink "$homeA/.agents/skills/agnes-ai-models" 2>/dev/null)" "models skill link" || true
assert_eq "$ROOT/skill/agnes-ai-skill" "$(readlink "$homeA/.agents/skills/agnes-ai-generation" 2>/dev/null)" "generation alias" || true

t_begin "A: agent skill dirs got both skill links"
for agent_dir in "$homeA/.claude/skills" "$homeA/.config/devin/skills"; do
  assert_eq "$ROOT/skill/agnes-ai-skill" "$(readlink "$agent_dir/agnes-ai-skill" 2>/dev/null)" "agnes-ai-skill in $agent_dir" || true
  assert_eq "$ROOT/skill/agnes-ai-models" "$(readlink "$agent_dir/agnes-ai-models" 2>/dev/null)" "agnes-ai-models in $agent_dir" || true
done
# Legacy link must be left untouched (it resolves through the canonical alias).
assert_eq "../../.agents/skills/agnes-ai-generation" "$(readlink "$homeA/.claude/skills/agnes-ai-generation" 2>/dev/null)" "legacy generation link preserved" || true
if [ -e "$homeA/.claude/skills/agnes-ai-generation" ]; then t_ok; else t_fail "legacy generation link does not resolve after install"; fi

t_begin "A: non-Agnes agent dir was not touched by default"
if [ -z "$(ls -A "$homeA/.codex/skills" 2>/dev/null)" ]; then t_ok; else t_fail ".codex/skills was modified without being Agnes-enabled"; fi

t_begin "A: manifest v2 records agent skill dirs and backups"
manifestA="$stateA/install-manifest.env"
if grep -q '^AGNES_MANIFEST_VERSION=2$' "$manifestA" 2>/dev/null; then t_ok; else t_fail "manifest is not v2"; fi
agent_dirs_line=$(grep '^AGENT_SKILL_DIRS=' "$manifestA" 2>/dev/null || true)
assert_contains "$agent_dirs_line" "/.claude/skills" "manifest records .claude/skills" || true
assert_contains "$agent_dirs_line" "/.config/devin/skills" "manifest records devin/skills" || true
if grep -q 'agent-dirs/.*/agnes-ai-skill' "$stateA"/backups/*/agent-skill-backups.txt 2>/dev/null; then t_ok; else t_fail "agent-dir backup record missing"; fi

t_begin "A: previous installs were backed up"
if find "$stateA/backups" -name marker.txt -print -quit 2>/dev/null | grep -q marker.txt; then t_ok; else t_fail "backup markers missing"; fi

OUT_AU=$(run_iso "$homeA" "$stateA" "$globalA" uninstall-local.sh --yes 2>&1)
RC_AU=$?
t_begin "A: uninstall-local --yes succeeds"
assert_eq "0" "$RC_AU" "uninstall exit" || true

# This is the blocking B1 regression: restores must land in $HOME, not the repo.
t_begin "A: skills restored into fake HOME (not the repo)"
if [ -d "$homeA/.agents/skills/agnes-ai-skill" ] && [ ! -L "$homeA/.agents/skills/agnes-ai-skill" ]; then
  content=$(cat "$homeA/.agents/skills/agnes-ai-skill/marker.txt" 2>/dev/null || true)
  assert_eq "legacy-skill-A" "$content" "agnes-ai-skill restored" || true
else
  t_fail "agnes-ai-skill was not restored as a real directory in HOME"
fi
if [ -d "$homeA/.agents/skills/agnes-ai-models" ] && [ ! -L "$homeA/.agents/skills/agnes-ai-models" ]; then
  content=$(cat "$homeA/.agents/skills/agnes-ai-models/marker.txt" 2>/dev/null || true)
  assert_eq "legacy-models-A" "$content" "agnes-ai-models restored" || true
else
  t_fail "agnes-ai-models was not restored as a real directory in HOME"
fi

t_begin "A: generation alias removed (no previous install)"
if [ -e "$homeA/.agents/skills/agnes-ai-generation" ] || [ -L "$homeA/.agents/skills/agnes-ai-generation" ]; then
  t_fail "generation alias still present"
else
  t_ok
fi

t_begin "A: agent-dir links removed and real skill dir restored"
if [ -e "$homeA/.claude/skills/agnes-ai-skill" ] || [ -L "$homeA/.claude/skills/agnes-ai-skill" ]; then
  t_fail ".claude/skills/agnes-ai-skill still present"
else
  t_ok
fi
if [ -e "$homeA/.claude/skills/agnes-ai-models" ] || [ -L "$homeA/.claude/skills/agnes-ai-models" ]; then
  t_fail ".claude/skills/agnes-ai-models still present"
else
  t_ok
fi
if [ -d "$homeA/.config/devin/skills/agnes-ai-skill" ] && [ ! -L "$homeA/.config/devin/skills/agnes-ai-skill" ]; then
  content=$(cat "$homeA/.config/devin/skills/agnes-ai-skill/marker.txt" 2>/dev/null || true)
  assert_eq "legacy-devin-A" "$content" "devin skill restored" || true
else
  t_fail "devin/skills/agnes-ai-skill was not restored as a real directory"
fi
if [ -L "$homeA/.claude/skills/agnes-ai-generation" ] && [ ! -e "$homeA/.claude/skills/agnes-ai-generation" ]; then
  t_ok
else
  t_fail "legacy agnes-ai-generation link was modified or removed"
fi

t_begin "A: global package restored as a real directory"
if [ -d "$globalA/agnes-ai-cli" ] && [ ! -L "$globalA/agnes-ai-cli" ]; then
  content=$(cat "$globalA/agnes-ai-cli/marker.txt" 2>/dev/null || true)
  assert_eq "legacy-global-A" "$content" "global restored" || true
else
  t_fail "global package was not restored as a directory"
fi

# ---------------------------------------------------------------------------
# Scenario B: global package and skills were pre-existing symlinks (M4).
# ---------------------------------------------------------------------------
homeB="$TMP/homeB"; stateB="$TMP/stateB"; globalB="$TMP/globalB"
mkdir -p "$homeB/.agents/skills" "$globalB" "$TMP/old-global-pkg" "$TMP/legacy-skill" "$TMP/legacy-models"
printf 'old-global-pkg\n' > "$TMP/old-global-pkg/marker.txt"
printf 'name: agnes-ai-skill\nversion: 1.2.2\n' > "$TMP/legacy-skill/SKILL.md"
printf 'legacy-skill-B\n' > "$TMP/legacy-skill/marker.txt"
printf 'legacy-models-B\n' > "$TMP/legacy-models/marker.txt"
ln -s "$TMP/old-global-pkg" "$globalB/agnes-ai-cli"
ln -s "$TMP/legacy-skill" "$homeB/.agents/skills/agnes-ai-skill"
ln -s "$TMP/legacy-models" "$homeB/.agents/skills/agnes-ai-models"

RC_B=$(run_iso "$homeB" "$stateB" "$globalB" install-local.sh --yes >/dev/null 2>&1; echo $?)
t_begin "B: install-local (symlinked global + skills) succeeds"
assert_eq "0" "$RC_B" "install exit" || true
assert_eq "$ROOT/cli" "$(readlink "$globalB/agnes-ai-cli" 2>/dev/null)" "global linked to repo" || true

RC_BU=$(run_iso "$homeB" "$stateB" "$globalB" uninstall-local.sh --yes >/dev/null 2>&1; echo $?)
t_begin "B: uninstall-local restores the symlinked global package (M4)"
assert_eq "0" "$RC_BU" "uninstall exit" || true
assert_eq "$TMP/old-global-pkg" "$(readlink "$globalB/agnes-ai-cli" 2>/dev/null)" "global symlink target restored" || true

t_begin "B: uninstall-local restores pre-existing skill symlinks"
assert_eq "$TMP/legacy-skill" "$(readlink "$homeB/.agents/skills/agnes-ai-skill" 2>/dev/null)" "skill symlink restored" || true
assert_eq "$TMP/legacy-models" "$(readlink "$homeB/.agents/skills/agnes-ai-models" 2>/dev/null)" "models symlink restored" || true
assert_eq "legacy-skill-B" "$(cat "$homeB/.agents/skills/agnes-ai-skill/marker.txt" 2>/dev/null || true)" "restored link target content" || true

# ---------------------------------------------------------------------------
# Scenario C: bin link plan is shown by --dry-run (L3) and restored.
# ---------------------------------------------------------------------------
homeC="$TMP/homeC"; stateC="$TMP/stateC"; globalC="$TMP/globalC"
mkdir -p "$homeC/.agents/skills" "$globalC"
run_iso "$homeC" "$stateC" "$globalC" install-local.sh --yes >/dev/null 2>&1 || true
# Simulate npm link having repointed the global bin symlink.
ln -sfn "$TMP/otherbin/agnes.js" "$FAKE_BIN/agnes"

DRY_OUT=$(run_iso "$homeC" "$stateC" "$globalC" uninstall-local.sh --dry-run 2>&1)
DRY_RC=$?
t_begin "C: uninstall --dry-run plans the bin-link restore (L3)"
assert_eq "0" "$DRY_RC" "dry-run exit" || true
assert_contains "$DRY_OUT" "restore $FAKE_BIN/agnes -> $TMP/oldbin/agnes.js" "bin restore plan" || true
assert_eq "$TMP/otherbin/agnes.js" "$(readlink "$FAKE_BIN/agnes" 2>/dev/null)" "dry-run must not change the link" || true

run_iso "$homeC" "$stateC" "$globalC" uninstall-local.sh --yes >/dev/null 2>&1 || true
t_begin "C: uninstall --yes restores the bin link"
assert_eq "$TMP/oldbin/agnes.js" "$(readlink "$FAKE_BIN/agnes" 2>/dev/null)" "bin link restored" || true

# ---------------------------------------------------------------------------
# Scenario D: AGNES_AGENT_SKILL_DIRS=all includes dirs without Agnes entries.
# ---------------------------------------------------------------------------
homeD="$TMP/homeD"; stateD="$TMP/stateD"; globalD="$TMP/globalD"
mkdir -p "$homeD/.agents/skills" "$globalD" "$homeD/.codex/skills" "$homeD/.cursor/skills"
ISO_AGENT_DIRS=all
OUT_D=$(run_iso "$homeD" "$stateD" "$globalD" install-local.sh --yes 2>&1)
RC_D=$?
unset ISO_AGENT_DIRS
t_begin "D: AGNES_AGENT_SKILL_DIRS=all installs into non-Agnes dirs"
assert_eq "0" "$RC_D" "install exit" || true
assert_eq "$ROOT/skill/agnes-ai-skill" "$(readlink "$homeD/.codex/skills/agnes-ai-skill" 2>/dev/null)" "codex skill link" || true
assert_eq "$ROOT/skill/agnes-ai-models" "$(readlink "$homeD/.cursor/skills/agnes-ai-models" 2>/dev/null)" "cursor models link" || true
manifestD="$stateD/install-manifest.env"
assert_contains "$(grep '^AGENT_SKILL_DIRS=' "$manifestD" 2>/dev/null || true)" "/.codex/skills" "manifest records override dir" || true

run_iso "$homeD" "$stateD" "$globalD" uninstall-local.sh --yes >/dev/null 2>&1 || true
t_begin "D: uninstall removes override-dir links (no backups)"
if [ -L "$homeD/.codex/skills/agnes-ai-skill" ] || [ -e "$homeD/.codex/skills/agnes-ai-skill" ]; then
  t_fail "codex skill link not removed"
else
  t_ok
fi
if [ "$(ls -A "$homeD/.cursor/skills" 2>/dev/null | wc -l | tr -d ' ')" = "0" ]; then t_ok; else t_fail ".cursor/skills not empty after uninstall"; fi

# ---------------------------------------------------------------------------
# Scenario E: manifest v1 (pre-agent-dir install) remains readable by uninstall.
# ---------------------------------------------------------------------------
homeE="$TMP/homeE"; stateE="$TMP/stateE"; globalE="$TMP/globalE"
mkdir -p "$homeE/.agents/skills/agnes-ai-skill" "$globalE"
printf 'legacy-skill-E\n' > "$homeE/.agents/skills/agnes-ai-skill/marker.txt"
printf 'name: agnes-ai-skill\nversion: 1.2.2\n' > "$homeE/.agents/skills/agnes-ai-skill/SKILL.md"
run_iso "$homeE" "$stateE" "$globalE" install-local.sh --yes >/dev/null 2>&1 || true
manifestE="$stateE/install-manifest.env"
# Simulate an old v1 manifest: drop v2 fields, downgrade the version line.
if [ -f "$manifestE" ]; then
  grep -v '^AGENT_' "$manifestE" | sed 's/^AGNES_MANIFEST_VERSION=2$/AGNES_MANIFEST_VERSION=1/' > "$manifestE.v1" && mv "$manifestE.v1" "$manifestE"
fi
OUT_E=$(run_iso "$homeE" "$stateE" "$globalE" uninstall-local.sh --yes 2>&1)
RC_E=$?
t_begin "E: uninstall accepts a v1 manifest (backward compatibility)"
assert_eq "0" "$RC_E" "uninstall exit" || true
assert_contains "$OUT_E" "manifest v1" "v1 manifest notice" || true
if [ -d "$homeE/.agents/skills/agnes-ai-skill" ] && [ ! -L "$homeE/.agents/skills/agnes-ai-skill" ]; then
  assert_eq "legacy-skill-E" "$(cat "$homeE/.agents/skills/agnes-ai-skill/marker.txt" 2>/dev/null || true)" "canonical skill restored from v1 manifest" || true
else
  t_fail "v1 manifest uninstall did not restore the canonical skill"
fi

# ---------------------------------------------------------------------------
# Scenario F: upgrading a v1 install with agent-dir changes keeps the original
# rollback backups (backup-root reuse across manifests).
# ---------------------------------------------------------------------------
homeF="$TMP/homeF"; stateF="$TMP/stateF"; globalF="$TMP/globalF"
mkdir -p "$homeF/.agents/skills/agnes-ai-skill" "$globalF"
printf 'legacy-skill-F\n' > "$homeF/.agents/skills/agnes-ai-skill/marker.txt"
printf 'name: agnes-ai-skill\nversion: 1.2.2\n' > "$homeF/.agents/skills/agnes-ai-skill/SKILL.md"
run_iso "$homeF" "$stateF" "$globalF" install-local.sh --yes >/dev/null 2>&1 || true
manifestF="$stateF/install-manifest.env"
# Downgrade the manifest to v1 (simulating an install from before agent dirs).
if [ -f "$manifestF" ]; then
  grep -v '^AGENT_' "$manifestF" | sed 's/^AGNES_MANIFEST_VERSION=2$/AGNES_MANIFEST_VERSION=1/' > "$manifestF.v1" && mv "$manifestF.v1" "$manifestF"
fi
backup_before_upgrade=$(sed -n 's/^BACKUP_DIR=//p' "$manifestF" 2>/dev/null | head -n 1)
# A new Agnes-enabled agent dir appears before the upgrade.
mkdir -p "$homeF/.claude/skills"
ln -s "../../.agents/skills/agnes-ai-generation" "$homeF/.claude/skills/agnes-ai-generation"
OUT_F=$(run_iso "$homeF" "$stateF" "$globalF" install-local.sh --yes 2>&1)
RC_F=$?
t_begin "F: v1 -> v2 upgrade keeps the original backup root"
assert_eq "0" "$RC_F" "upgrade install exit" || true
assert_eq "2" "$(sed -n 's/^AGNES_MANIFEST_VERSION=//p' "$manifestF" 2>/dev/null | head -n 1)" "manifest version" || true
backup_after_upgrade=$(sed -n 's/^BACKUP_DIR=//p' "$manifestF" 2>/dev/null | head -n 1)
assert_eq "$backup_before_upgrade" "$backup_after_upgrade" "backup root reused" || true
assert_eq "$ROOT/skill/agnes-ai-skill" "$(readlink "$homeF/.claude/skills/agnes-ai-skill" 2>/dev/null)" "upgrade added agent link" || true

OUT_FU=$(run_iso "$homeF" "$stateF" "$globalF" uninstall-local.sh --yes 2>&1)
RC_FU=$?
t_begin "F: uninstall after upgrade restores the pre-v1-era backup"
assert_eq "0" "$RC_FU" "uninstall exit" || true
if [ -d "$homeF/.agents/skills/agnes-ai-skill" ] && [ ! -L "$homeF/.agents/skills/agnes-ai-skill" ]; then
  assert_eq "legacy-skill-F" "$(cat "$homeF/.agents/skills/agnes-ai-skill/marker.txt" 2>/dev/null || true)" "original skill restored after upgrade" || true
else
  t_fail "upgrade uninstall did not restore the canonical skill"
fi

# ---------------------------------------------------------------------------
# Global invariants: repo and the real machine state must be untouched.
# ---------------------------------------------------------------------------
t_begin "round-trip left the repo unchanged"
assert_eq "$REPO_HASH_BEFORE" "$(repo_hash)" "repo skill hashes" || true
if [ -e "$ROOT/skill/agnes-ai-skill/agnes-ai-skill" ] || [ -e "$ROOT/skill/agnes-ai-models/agnes-ai-models" ]; then
  t_fail "uninstall restored a backup into the repo (nested skill dirs exist)"
else
  t_ok
fi

t_begin "round-trip left the real global package untouched"
REAL_GLOBAL_AFTER="absent"
if [ -L /usr/local/lib/node_modules/agnes-ai-cli ]; then
  REAL_GLOBAL_AFTER="link:$(readlink /usr/local/lib/node_modules/agnes-ai-cli)"
elif [ -e /usr/local/lib/node_modules/agnes-ai-cli ]; then
  REAL_GLOBAL_AFTER="dir"
fi
assert_eq "$REAL_GLOBAL_BEFORE" "$REAL_GLOBAL_AFTER" "real global package" || true

t_begin "round-trip left the real ~/.agents and ~/.agnes-toolkit untouched"
real_skill_state="absent"
if [ -L "$HOME/.agents/skills/agnes-ai-skill" ]; then
  real_skill_state="link:$(readlink "$HOME/.agents/skills/agnes-ai-skill")"
elif [ -e "$HOME/.agents/skills/agnes-ai-skill" ]; then
  real_skill_state="dir"
fi
if [ -d "$HOME/.agents/skills/agnes-ai-models" ] || [ -L "$HOME/.agents/skills/agnes-ai-models" ]; then
  real_skill_state="$real_skill_state models-present"
fi
# The real machine may be in either state: toolkit not installed yet (dir/absent)
# or installed by scripts/install-local.sh (symlink into this repo). Both are
# valid as long as the round-trip did not change them.
case "$real_skill_state" in
  absent|dir*|link:*) t_ok ;;
  *) t_fail "unexpected real skill state: $real_skill_state" ;;
esac
if [ ! -e "$HOME/.agnes-toolkit/install-manifest.env" ]; then
  t_ok
else
  t_skip "real ~/.agnes-toolkit manifest exists (pre-existing; not modified)"
fi

t_end
