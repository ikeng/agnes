#!/usr/bin/env bash
# install-local.sh — install the patched project CLI and project skills into the
# current user environment, with backups and rollback instructions.
#
# What it does:
#   1. builds cli/ (npm install/build when needed)
#   2. backs up the existing global agnes-ai-cli package, then `npm link`s the
#      project build so `agnes` points at this repo
#   3. backs up and links project skills under ~/.agents/skills/:
#        agnes-ai-skill   (CLI-first skill for this repo)
#        agnes-ai-models  (vendored official AgnesAI-Labs skill, when present)
#        agnes-ai-generation -> project agnes-ai-skill, so the existing dangling
#        ~/.claude and ~/.config/*/skills/agnes-ai-generation links resolve
#      The dangling links themselves are NOT modified.
#   4. syncs agnes-ai-skill/agnes-ai-models directly into detected Agnes-enabled
#      agent skill dirs (~/.claude/skills, ~/.config/{devin,crush,goose}/skills,
#      ~/.junie, ~/.mux, ~/.qwen, ~/.openhands, ~/.pochi, ~/.trae-cn,
#      ~/.codemaker, ...). Override with AGNES_AGENT_SKILL_DIRS=/path/a:/path/b
#      or AGNES_AGENT_SKILL_DIRS=all.
#
# It never touches ~/.agnes (a different product) and never deletes user data
# without keeping a backup. State lives in ~/.agnes-toolkit/ by default.
#
# Usage:
#   bash scripts/install-local.sh --dry-run   # print the plan, change nothing
#   bash scripts/install-local.sh --yes       # non-interactive install
#   bash scripts/install-local.sh             # interactive confirmation
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

STATE_DIR=${AGNES_TOOLKIT_STATE_DIR:-"$HOME/.agnes-toolkit"}
BACKUP_BASE="$STATE_DIR/backups"
STAMP=$(date +%Y%m%d-%H%M%S)
MANIFEST="$STATE_DIR/install-manifest.env"

# Reuse the previous backup root when it still exists, so a later install
# (e.g. v1 manifest -> v2 with agent dirs) never loses the original rollback
# backups. New backups then go under a reinstall-<stamp>/ namespace and never
# overwrite the old ones.
BACKUP_DIR="$BACKUP_BASE/$STAMP"
BACKUP_NAMESPACE="reinstall-$STAMP"
if [ -f "$MANIFEST" ] && head -n 1 "$MANIFEST" | grep -Eq '^AGNES_MANIFEST_VERSION=[12]$'; then
  previous_backup_dir=$(sed -n 's/^BACKUP_DIR=//p' "$MANIFEST" 2>/dev/null | head -n 1)
  case "$previous_backup_dir" in
    \'*\') previous_backup_dir=${previous_backup_dir#?}; previous_backup_dir=${previous_backup_dir%?} ;;
    \"*\") previous_backup_dir=${previous_backup_dir#?}; previous_backup_dir=${previous_backup_dir%?} ;;
  esac
  if [ -n "$previous_backup_dir" ] && [ -d "$previous_backup_dir" ]; then
    BACKUP_DIR="$previous_backup_dir"
    BACKUP_DIR_CREATED=1
  fi
fi

HOME_SKILLS="$HOME/.agents/skills"
SKILL_NAMES="agnes-ai-skill agnes-ai-models"
GENERATION_TARGET="$HOME_SKILLS/agnes-ai-generation"
GENERATION_SOURCE="$REPO_ROOT/skill/agnes-ai-skill"

DRY_RUN=0
ASSUME_YES=0
CHANGES=0
BACKUP_DIR_CREATED=0
GLOBAL_BACKUP=0
BACKED_SKILLS=""
GENERATION_BACKUP=0
GENERATION_WAS_LINK="none"
BACKUP_LAST_NAME=""
AGENT_SKILL_DIRS_LIST=""
AGENT_SKILL_DIRS_JOINED=""
AGENT_BACKUP_RECORDS=""
AGENT_BACKUP_FILE=""
AGENT_BACKUP_COUNT=0
AGENT_COUNT=0
BIN_PATH=""
BIN_TARGET_BEFORE=""
GLOBAL_TARGET=""
GLOBAL_ROOT=""
GLOBAL_WAS_LINK="none"
SKILL_TARGET=""
SKILL_WAS_LINK="none"

usage() {
  cat <<'EOF'
install-local.sh — install the patched project CLI and skills (with backups).

What it does:
  1. builds cli/ (npm install/build when needed)
  2. backs up the existing global agnes-ai-cli package, then npm links the
     project build so `agnes` points at this repo
  3. backs up and links project skills under ~/.agents/skills/:
       agnes-ai-skill, agnes-ai-models, and an agnes-ai-generation alias
  4. links both skills into detected Agnes-enabled agent skill dirs
       (override: AGNES_AGENT_SKILL_DIRS=/a/skills:/b/skills or "all")
  5. verifies the result and prints rollback instructions

~/.agnes (a different product) is never touched.

Usage:
  bash scripts/install-local.sh --dry-run   # print the plan, change nothing
  bash scripts/install-local.sh --yes       # non-interactive install
  bash scripts/install-local.sh             # interactive confirmation
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) agnes_err "unknown option: $arg"; usage; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
act() {
  CHANGES=$((CHANGES + 1))
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY-RUN: %s\n' "$*"
  else
    printf '%s\n' "$*"
  fi
}
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

ensure_backup_dir() {
  if [ "$DRY_RUN" = "1" ] || [ "$BACKUP_DIR_CREATED" = "1" ]; then
    return 0
  fi
  mkdir -p "$BACKUP_DIR" || fail "cannot create backup dir: $BACKUP_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  chmod 700 "$BACKUP_BASE" 2>/dev/null || true
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  BACKUP_DIR_CREATED=1
}

# backup_entry <dir|link> <path> <backup-name>
# Sets BACKUP_LAST_NAME to the name actually used (a reinstall-<stamp>/ prefix
# is added when the standard name already exists, preserving older backups).
backup_entry() {
  local kind src name
  kind=$1; src=$2; name=$3
  BACKUP_LAST_NAME=""
  [ -e "$src" ] || [ -L "$src" ] || return 0
  if agnes_is_forbidden_path "$src"; then
    fail "refusing to touch forbidden path: $src"
  fi
  if [ -e "$BACKUP_DIR/$name" ] || [ -e "$BACKUP_DIR/$name.link-target" ]; then
    name="$BACKUP_NAMESPACE/$name"
  fi
  BACKUP_LAST_NAME="$name"
  if [ "$DRY_RUN" = "1" ]; then
    act "back up $src -> $BACKUP_DIR/$name"
    return 0
  fi
  ensure_backup_dir
  mkdir -p "$BACKUP_DIR/$(dirname -- "$name")" 2>/dev/null || true
  case "$kind" in
    link) readlink "$src" > "$BACKUP_DIR/$name.link-target" || fail "cannot read link: $src" ;;
    dir) cp -R "$src" "$BACKUP_DIR/$name" || fail "backup failed: $src" ;;
  esac
}

say "== agnes-toolkit install-local =="
say "repo:            $REPO_ROOT"
say "state dir:       $STATE_DIR"
if [ "$DRY_RUN" = "1" ]; then
  say "mode:            DRY RUN (no changes will be made)"
fi

# --- preflight ----------------------------------------------------------------
if ! agnes_have node || ! agnes_have npm; then
  fail "node and npm are required"
fi
NODE_MAJOR=$(agnes_node_major || printf '0')
[ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null || fail "Node >= 20 required (found $(node -p 'process.versions.node' 2>/dev/null))"
[ -f "$REPO_ROOT/cli/package.json" ] || fail "cli/package.json missing"
[ -f "$REPO_ROOT/cli/bin/agnes.js" ] || fail "cli/bin/agnes.js missing"

GLOBAL_ROOT=$(npm root -g 2>/dev/null) || fail "cannot determine global npm root"
GLOBAL_TARGET="$GLOBAL_ROOT/agnes-ai-cli"
BIN_PATH=$(command -v agnes 2>/dev/null || true)
BIN_TARGET_BEFORE=""
if [ -n "$BIN_PATH" ] && [ -L "$BIN_PATH" ]; then
  BIN_TARGET_BEFORE=$(readlink "$BIN_PATH")
fi
if [ -L "$GLOBAL_TARGET" ]; then
  GLOBAL_WAS_LINK=$(readlink "$GLOBAL_TARGET")
fi

say "global package:  $GLOBAL_TARGET"
say "global binary:   ${BIN_PATH:-<not on PATH>}"
say "skill home:      $HOME_SKILLS"
for skill_name in $SKILL_NAMES; do
  if [ -d "$REPO_ROOT/skill/$skill_name" ]; then
    say "project skill:   skill/$skill_name"
  else
    warn "project skill missing: skill/$skill_name (will be skipped)"
  fi
done

# --- confirmation -------------------------------------------------------------
if [ "$DRY_RUN" = "0" ] && [ "$ASSUME_YES" = "0" ]; then
  if [ -t 0 ]; then
    printf 'This replaces the global agnes-ai-cli package and project skill links (backups kept). Continue? [y/N] '
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) say "aborted."; exit 1 ;;
    esac
  else
    fail "non-interactive session; re-run with --yes (or --dry-run to preview)"
  fi
fi

if [ ! -w "$GLOBAL_ROOT" ] && [ "$DRY_RUN" = "0" ]; then
  fail "global npm root is not writable: $GLOBAL_ROOT (fix permissions or use a user npm prefix, then re-run)"
fi

# --- build --------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  act "npm install/build in cli/ if needed"
else
  if [ ! -d "$REPO_ROOT/cli/node_modules" ]; then
    say "installing cli dependencies..."
    (cd "$REPO_ROOT/cli" && npm install --no-audit --no-fund) || fail "npm install failed"
  fi
  if [ ! -f "$REPO_ROOT/cli/dist/cli.js" ] || [ -n "$(find "$REPO_ROOT/cli/src" -type f -newer "$REPO_ROOT/cli/dist/cli.js" -print -quit 2>/dev/null)" ]; then
    say "building project CLI..."
    (cd "$REPO_ROOT/cli" && npm run build) || fail "build failed"
  fi
fi

# --- global CLI ---------------------------------------------------------------
if [ -e "$GLOBAL_TARGET" ] || [ -L "$GLOBAL_TARGET" ]; then
  case "$GLOBAL_WAS_LINK" in
    "$REPO_ROOT"|"$REPO_ROOT"/*)
      say "global package already links to this repo; no CLI backup needed"
      ;;
    *)
      if [ -L "$GLOBAL_TARGET" ]; then
        backup_entry link "$GLOBAL_TARGET" "global/agnes-ai-cli"
      else
        backup_entry dir "$GLOBAL_TARGET" "global/agnes-ai-cli"
        GLOBAL_BACKUP=1
      fi
      act "remove existing global package after backup"
      if [ "$DRY_RUN" = "0" ]; then rm -rf "$GLOBAL_TARGET" || fail "cannot remove $GLOBAL_TARGET"; fi
      ;;
  esac
fi

if [ "$DRY_RUN" = "0" ]; then
  if ! (cd "$REPO_ROOT/cli" && npm link --no-audit --no-fund); then
    if [ "$GLOBAL_BACKUP" = "1" ] && [ -d "$BACKUP_DIR/global/agnes-ai-cli" ]; then
      warn "npm link failed; restoring previous global package"
      rm -rf "$GLOBAL_TARGET"
      cp -R "$BACKUP_DIR/global/agnes-ai-cli" "$GLOBAL_TARGET" || warn "manual restore needed: $BACKUP_DIR/global/agnes-ai-cli"
    fi
    fail "npm link failed"
  fi
  CHANGES=$((CHANGES + 1))
  say "linked $GLOBAL_TARGET -> $REPO_ROOT/cli"
else
  act "npm link in cli/ (global package $GLOBAL_TARGET -> $REPO_ROOT/cli)"
fi

# --- project skills -----------------------------------------------------------
if [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$HOME_SKILLS" || fail "cannot create $HOME_SKILLS"
fi

for skill_name in $SKILL_NAMES; do
  source_dir="$REPO_ROOT/skill/$skill_name"
  target_dir="$HOME_SKILLS/$skill_name"
  [ -d "$source_dir" ] || continue
  if agnes_is_forbidden_path "$target_dir"; then
    warn "skipping forbidden path: $target_dir"
    continue
  fi
  target_was_link="none"
  if [ -L "$target_dir" ]; then
    target_was_link=$(readlink "$target_dir")
  fi
  if [ -e "$target_dir" ] || [ -L "$target_dir" ]; then
    case "$target_was_link" in
      "$source_dir")
        say "skill $skill_name already links to this repo"
        continue
        ;;
    esac
    if [ -L "$target_dir" ]; then
      backup_entry link "$target_dir" "skills/$skill_name"
    else
      backup_entry dir "$target_dir" "skills/$skill_name"
      case " $BACKED_SKILLS " in
        *" $skill_name "*) ;;
        *) BACKED_SKILLS="$BACKED_SKILLS $skill_name" ;;
      esac
    fi
    act "replace existing skill $skill_name with project link"
    if [ "$DRY_RUN" = "0" ]; then rm -rf "$target_dir" || fail "cannot remove $target_dir"; fi
  fi
  if [ "$DRY_RUN" = "0" ]; then
    ln -s "$source_dir" "$target_dir" || fail "cannot link skill: $target_dir"
    CHANGES=$((CHANGES + 1))
    say "linked skill: $target_dir -> $source_dir"
  else
    act "link skill: $target_dir -> $source_dir"
  fi
done
BACKED_SKILLS=${BACKED_SKILLS# }

# Backwards-compatible alias: the old dangling agent links point at
# ~/.agents/skills/agnes-ai-generation. Point that name at the project skill so
# the existing links resolve without editing them.
if [ -d "$GENERATION_SOURCE" ]; then
  if [ -L "$GENERATION_TARGET" ]; then
    GENERATION_WAS_LINK=$(readlink "$GENERATION_TARGET")
  fi
  if [ -e "$GENERATION_TARGET" ] || [ -L "$GENERATION_TARGET" ]; then
    case "$GENERATION_WAS_LINK" in
      "$GENERATION_SOURCE"|"$HOME_SKILLS/agnes-ai-skill")
        say "agnes-ai-generation alias already resolves to the project skill"
        ;;
      *)
        if [ -L "$GENERATION_TARGET" ]; then
          backup_entry link "$GENERATION_TARGET" "skills/agnes-ai-generation"
        else
          backup_entry dir "$GENERATION_TARGET" "skills/agnes-ai-generation"
          GENERATION_BACKUP=1
        fi
        act "replace existing agnes-ai-generation entry with alias"
        if [ "$DRY_RUN" = "0" ]; then rm -rf "$GENERATION_TARGET" || fail "cannot remove $GENERATION_TARGET"; fi
        ;;
    esac
  fi
  if [ "$DRY_RUN" = "0" ]; then
    if [ ! -e "$GENERATION_TARGET" ] && [ ! -L "$GENERATION_TARGET" ]; then
      ln -s "$GENERATION_SOURCE" "$GENERATION_TARGET" || fail "cannot create generation alias"
      CHANGES=$((CHANGES + 1))
      say "linked alias: $GENERATION_TARGET -> $GENERATION_SOURCE"
    fi
  else
    act "link alias: $GENERATION_TARGET -> $GENERATION_SOURCE"
  fi
else
  warn "project skill missing ($GENERATION_SOURCE); skipping agnes-ai-generation alias"
fi

# --- agent skill dirs ---------------------------------------------------------
# Sync the two project skills directly into agent tool skill dirs that already
# have Agnes content (or are explicitly listed in AGNES_AGENT_SKILL_DIRS).
AGENT_SKILL_DIRS_LIST=$(agnes_agent_skill_dirs 2>/dev/null || true)
AGENT_BACKUP_FILE="$BACKUP_DIR/agent-skill-backups.txt"
if [ -n "$AGENT_SKILL_DIRS_LIST" ]; then
  say "agent skill dirs: syncing project skills into detected dirs"
  while IFS= read -r agent_dir; do
    [ -n "$agent_dir" ] || continue
    [ -d "$agent_dir" ] || continue
    if [ "$agent_dir" = "$HOME_SKILLS" ]; then
      continue
    fi
    if agnes_is_forbidden_path "$agent_dir"; then
      warn "skipping forbidden agent dir: $agent_dir"
      continue
    fi
    AGENT_COUNT=$((AGENT_COUNT + 1))
    AGENT_SKILL_DIRS_JOINED="${AGENT_SKILL_DIRS_JOINED:+$AGENT_SKILL_DIRS_JOINED:}$agent_dir"
    for skill_name in $SKILL_NAMES; do
      source_dir="$REPO_ROOT/skill/$skill_name"
      [ -d "$source_dir" ] || continue
      target_dir="$agent_dir/$skill_name"
      if [ -L "$target_dir" ] && [ "$(readlink "$target_dir" 2>/dev/null || true)" = "$source_dir" ]; then
        continue
      fi
      existing_kind="none"
      if [ -L "$target_dir" ]; then
        existing_kind="link"
      elif [ -e "$target_dir" ]; then
        existing_kind="dir"
      fi
      if [ "$DRY_RUN" = "1" ]; then
        if [ "$existing_kind" = "none" ]; then
          act "link agent skill: $target_dir -> $source_dir"
        else
          act "back up existing $existing_kind $target_dir, then link -> $source_dir"
        fi
        continue
      fi
      if [ "$existing_kind" != "none" ]; then
        ensure_backup_dir
        backup_name="agent-dirs/$AGENT_COUNT/$skill_name"
        backup_entry "$existing_kind" "$target_dir" "$backup_name"
        backup_name="$BACKUP_LAST_NAME"
        mkdir -p "$(dirname -- "$AGENT_BACKUP_FILE")" 2>/dev/null || true
        printf '%s|%s|%s|%s\n' "$agent_dir" "$skill_name" "$existing_kind" "$backup_name" >> "$AGENT_BACKUP_FILE" || fail "cannot record agent-dir backup"
        AGENT_BACKUP_COUNT=$((AGENT_BACKUP_COUNT + 1))
        rm -rf "$target_dir" || fail "cannot remove $target_dir"
      fi
      ln -s "$source_dir" "$target_dir" || fail "cannot link agent skill: $target_dir"
      CHANGES=$((CHANGES + 1))
      say "linked agent skill: $target_dir -> $source_dir"
    done
  done <<< "$AGENT_SKILL_DIRS_LIST"
  if [ "$DRY_RUN" = "1" ]; then
    say "agent skill dirs: $AGENT_COUNT detected (dry run)"
  fi
else
  say "agent skill dirs: none detected (set AGNES_AGENT_SKILL_DIRS=all to include all known dirs)"
fi
if [ "$AGENT_BACKUP_COUNT" -gt 0 ]; then
  AGENT_BACKUP_RECORDS="$AGENT_BACKUP_FILE"
fi

# --- manifest + verification --------------------------------------------------
if [ "$DRY_RUN" = "0" ]; then
  manifest_needs_write=0
  if [ "$CHANGES" -gt 0 ]; then
    manifest_needs_write=1
  fi
  existing_manifest_version=$(sed -n 's/^AGNES_MANIFEST_VERSION=//p' "$MANIFEST" 2>/dev/null | head -n 1)
  if [ -n "$AGENT_SKILL_DIRS_JOINED" ] && [ "$existing_manifest_version" != "2" ]; then
    # Agent links may already be correct, but an old manifest would not know
    # how to remove them on uninstall - upgrade it in place.
    manifest_needs_write=1
  fi
  if [ "$manifest_needs_write" = "1" ]; then
    mkdir -p "$STATE_DIR" || fail "cannot create $STATE_DIR"
    {
      printf 'AGNES_MANIFEST_VERSION=2\n'
      printf 'REPO_ROOT=%q\n' "$REPO_ROOT"
      printf 'BACKUP_DIR=%q\n' "$BACKUP_DIR"
      printf 'GLOBAL_ROOT=%q\n' "$GLOBAL_ROOT"
      printf 'GLOBAL_TARGET=%q\n' "$GLOBAL_TARGET"
      printf 'GLOBAL_WAS_LINK=%q\n' "$GLOBAL_WAS_LINK"
      printf 'GLOBAL_BACKUP=%q\n' "$GLOBAL_BACKUP"
      printf 'BIN_PATH=%q\n' "$BIN_PATH"
      printf 'BIN_TARGET_BEFORE=%q\n' "$BIN_TARGET_BEFORE"
      printf 'HOME_SKILLS=%q\n' "$HOME_SKILLS"
      printf 'SKILL_NAMES=%q\n' "$SKILL_NAMES"
      printf 'BACKED_SKILLS=%q\n' "$BACKED_SKILLS"
      printf 'GENERATION_TARGET=%q\n' "$GENERATION_TARGET"
      printf 'GENERATION_WAS_LINK=%q\n' "$GENERATION_WAS_LINK"
      printf 'GENERATION_BACKUP=%q\n' "$GENERATION_BACKUP"
      printf 'AGENT_SKILL_DIRS=%q\n' "$AGENT_SKILL_DIRS_JOINED"
      printf 'AGENT_BACKUP_RECORDS=%q\n' "$AGENT_BACKUP_RECORDS"
      printf 'INSTALLED_AT=%q\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    } > "$MANIFEST"
    chmod 600 "$MANIFEST" 2>/dev/null || true
    say "manifest: $MANIFEST"
  else
    say "nothing changed; existing installation already matches this repo"
  fi

  printf '\n== verification ==\n'
  if [ -n "$BIN_PATH" ] && [ -x "$BIN_PATH" ]; then
    printf 'agnes: %s (v' "$BIN_PATH"
    "$BIN_PATH" --version 2>/dev/null || printf 'unknown'
    printf ')\n'
  else
    warn "agnes not found on PATH after install"
  fi
  for skill_name in $SKILL_NAMES; do
    target_dir="$HOME_SKILLS/$skill_name"
    if [ -f "$target_dir/SKILL.md" ]; then
      printf 'skill: %s (v%s)\n' "$target_dir" "$(agnes_skill_version "$target_dir/SKILL.md")"
    else
      warn "skill not resolvable: $target_dir"
    fi
  done
  if [ -e "$GENERATION_TARGET" ]; then
    printf 'alias: %s -> %s\n' "$GENERATION_TARGET" "$(readlink "$GENERATION_TARGET")"
  fi
  if [ "$AGENT_COUNT" -gt 0 ] && [ -n "$AGENT_SKILL_DIRS_LIST" ]; then
    agent_total=0
    agent_ok=0
    while IFS= read -r agent_dir; do
      [ -n "$agent_dir" ] || continue
      for skill_name in $SKILL_NAMES; do
        source_dir="$REPO_ROOT/skill/$skill_name"
        [ -d "$source_dir" ] || continue
        agent_total=$((agent_total + 1))
        if [ -L "$agent_dir/$skill_name" ] && [ "$(readlink "$agent_dir/$skill_name" 2>/dev/null || true)" = "$source_dir" ]; then
          agent_ok=$((agent_ok + 1))
        fi
      done
    done <<< "$AGENT_SKILL_DIRS_LIST"
    if [ "$agent_ok" -eq "$agent_total" ]; then
      printf 'agent dirs: %d dir(s), %d/%d skill links OK\n' "$AGENT_COUNT" "$agent_ok" "$agent_total"
    else
      warn "agent dirs: only $agent_ok/$agent_total skill links point at this repo"
    fi
  fi
  say ""
  say "rollback: bash scripts/uninstall-local.sh"
  say "backups:  $BACKUP_DIR"
  if [ -n "$AGENT_BACKUP_RECORDS" ]; then
    say "records:  $AGENT_BACKUP_RECORDS"
  fi
else
  say ""
  say "DRY-RUN complete; no files, links, or packages were changed."
fi
