#!/usr/bin/env bash
# uninstall-local.sh — reverse scripts/install-local.sh using the recorded
# manifest and backups. Never deletes user data blindly: only symlinks that
# point into this repo are removed, and previous installs are restored from
# ~/.agnes-toolkit/backups/<timestamp>/.
#
# It never touches ~/.agnes (a different product).
#
# Usage:
#   bash scripts/uninstall-local.sh --dry-run   # print the plan, change nothing
#   bash scripts/uninstall-local.sh --yes       # non-interactive uninstall
#   bash scripts/uninstall-local.sh             # interactive confirmation
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

STATE_DIR=${AGNES_TOOLKIT_STATE_DIR:-"$HOME/.agnes-toolkit"}
MANIFEST="$STATE_DIR/install-manifest.env"
BACKUP_BASE="$STATE_DIR/backups"

DRY_RUN=0
ASSUME_YES=0
CHANGES=0

usage() {
  cat <<'EOF'
uninstall-local.sh — reverse the local install and restore previous backups.

Restores the global agnes-ai-cli package (real directory or symlink) and the
~/.agents/skills entries (agnes-ai-skill, agnes-ai-models, agnes-ai-generation)
from the manifest-written backup directory. Symlinks that point into this repo
are removed; unrelated files/directories are left untouched. ~/.agnes is never
touched.

Usage:
  bash scripts/uninstall-local.sh --dry-run   # print the plan, change nothing
  bash scripts/uninstall-local.sh --yes       # non-interactive uninstall
  bash scripts/uninstall-local.sh             # interactive confirmation
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

# NOTE: keep every helper variable `local`. These helpers are called from loops
# whose loop variables (e.g. `target`) must not be clobbered.
remove_path() {
  local path
  path=$1
  agnes_is_forbidden_path "$path" && fail "refusing to touch forbidden path: $path"
  act "remove $path"
  if [ "$DRY_RUN" = "0" ]; then rm -rf "$path" || warn "could not remove $path"; fi
}

remove_link_if_project() {
  local path target
  path=$1
  [ -L "$path" ] || return 1
  target=$(readlink "$path" 2>/dev/null || true)
  case "$target" in
    "$REPO_ROOT"|"$REPO_ROOT"/*)
      remove_path "$path"
      return 0
      ;;
  esac
  return 1
}

restore_symlink() {
  local link_path target
  link_path=$1
  target=$2
  act "restore symlink $link_path -> $target"
  if [ "$DRY_RUN" = "0" ]; then
    mkdir -p "$(dirname -- "$link_path")" || fail "cannot create parent of $link_path"
    ln -s "$target" "$link_path" || warn "restore failed: $link_path"
  fi
}

restore_directory() {
  local destination source
  destination=$1
  source=$2
  act "restore directory $destination from $source"
  if [ "$DRY_RUN" = "0" ]; then
    mkdir -p "$(dirname -- "$destination")" || fail "cannot create parent of $destination"
    cp -R "$source" "$destination" || warn "restore failed: $destination"
  fi
}

# --- load manifest ------------------------------------------------------------
BACKUP_DIR=""
GLOBAL_TARGET=""
BIN_PATH=""
BIN_TARGET_BEFORE=""
HOME_SKILLS="$HOME/.agents/skills"
SKILL_NAMES="agnes-ai-skill agnes-ai-models"
GENERATION_TARGET="$HOME_SKILLS/agnes-ai-generation"

# Defaults used when no manifest exists (e.g. manual uninstall of an older install).
GLOBAL_TARGET="$(npm root -g 2>/dev/null || true)/agnes-ai-cli"
BIN_PATH=$(command -v agnes 2>/dev/null || true)

if [ -f "$MANIFEST" ] && head -n 1 "$MANIFEST" | grep -q '^AGNES_MANIFEST_VERSION=1$'; then
  # shellcheck disable=SC1090
  . "$MANIFEST"
  say "manifest: $MANIFEST"
  say "installed at: ${INSTALLED_AT:-unknown}"
else
  warn "no install manifest found at $MANIFEST; using the newest backup directory heuristics"
  BACKUP_DIR=$(ls -1dt "$BACKUP_BASE"/* 2>/dev/null | head -n 1)
  if [ -n "$BACKUP_DIR" ]; then
    say "backup dir: $BACKUP_DIR"
  else
    warn "no backups found under $BACKUP_BASE"
  fi
  # With no manifest we cannot know the previous bin-link target; leave it alone.
  BIN_TARGET_BEFORE=""
fi

say "repo:    $REPO_ROOT"
say "backup:  ${BACKUP_DIR:-<none>}"
if [ "$DRY_RUN" = "1" ]; then
  say "mode:    DRY RUN (no changes will be made)"
fi

if [ "$DRY_RUN" = "0" ] && [ "$ASSUME_YES" = "0" ]; then
  if [ -t 0 ]; then
    printf 'Remove the project-linked CLI/skills and restore previous installs? [y/N] '
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) say "aborted."; exit 1 ;;
    esac
  else
    fail "non-interactive session; re-run with --yes (or --dry-run to preview)"
  fi
fi

# --- global package -----------------------------------------------------------
if [ -n "$GLOBAL_TARGET" ] && { [ -e "$GLOBAL_TARGET" ] || [ -L "$GLOBAL_TARGET" ]; }; then
  if remove_link_if_project "$GLOBAL_TARGET"; then
    link_backup="$BACKUP_DIR/global/agnes-ai-cli.link-target"
    dir_backup="$BACKUP_DIR/global/agnes-ai-cli"
    if [ -n "$BACKUP_DIR" ] && [ -f "$link_backup" ]; then
      old_target=$(cat "$link_backup")
      restore_symlink "$GLOBAL_TARGET" "$old_target"
    elif [ -n "$BACKUP_DIR" ] && [ -d "$dir_backup" ]; then
      restore_directory "$GLOBAL_TARGET" "$dir_backup"
    else
      warn "no global package backup; global agnes-ai-cli was removed (reinstall with npm if needed)"
    fi
  elif [ -L "$GLOBAL_TARGET" ]; then
    warn "global package is a symlink not owned by this repo; leaving it untouched ($(readlink "$GLOBAL_TARGET" 2>/dev/null || true))"
  else
    say "global package is a real directory; not installed by this toolkit, leaving it untouched"
  fi
fi

# --- binary link (restore plan is included in --dry-run too) ------------------
if [ -n "$BIN_PATH" ] && [ -n "$BIN_TARGET_BEFORE" ]; then
  if [ -L "$BIN_PATH" ]; then
    current_bin_target=$(readlink "$BIN_PATH" 2>/dev/null || true)
    if [ "$current_bin_target" != "$BIN_TARGET_BEFORE" ]; then
      act "restore $BIN_PATH -> $BIN_TARGET_BEFORE"
      if [ "$DRY_RUN" = "0" ]; then
        mkdir -p "$(dirname -- "$BIN_PATH")" || fail "cannot create parent of $BIN_PATH"
        ln -sfn "$BIN_TARGET_BEFORE" "$BIN_PATH" || warn "could not restore bin link $BIN_PATH"
      fi
    fi
  elif [ ! -e "$BIN_PATH" ]; then
    act "recreate $BIN_PATH -> $BIN_TARGET_BEFORE"
    if [ "$DRY_RUN" = "0" ]; then
      mkdir -p "$(dirname -- "$BIN_PATH")" || fail "cannot create parent of $BIN_PATH"
      ln -s "$BIN_TARGET_BEFORE" "$BIN_PATH" || warn "could not recreate bin link $BIN_PATH"
    fi
  fi
fi

# --- skills -------------------------------------------------------------------
for skill_name in ${SKILL_NAMES:-agnes-ai-skill agnes-ai-models}; do
  target="$HOME_SKILLS/$skill_name"
  if [ -L "$target" ]; then
    if remove_link_if_project "$target"; then
      link_backup="$BACKUP_DIR/skills/$skill_name.link-target"
      dir_backup="$BACKUP_DIR/skills/$skill_name"
      if [ -n "$BACKUP_DIR" ] && [ -f "$link_backup" ]; then
        old_target=$(cat "$link_backup")
        restore_symlink "$target" "$old_target"
      elif [ -n "$BACKUP_DIR" ] && [ -d "$dir_backup" ]; then
        restore_directory "$target" "$dir_backup"
      else
        warn "no backup for skill $skill_name; link removed"
      fi
    fi
  elif [ -e "$target" ]; then
    say "skill $skill_name is a real directory; leaving it untouched"
  fi
done

# --- agnes-ai-generation alias ------------------------------------------------
if [ -L "$GENERATION_TARGET" ]; then
  if remove_link_if_project "$GENERATION_TARGET"; then
    link_backup="$BACKUP_DIR/skills/agnes-ai-generation.link-target"
    dir_backup="$BACKUP_DIR/skills/agnes-ai-generation"
    if [ -n "$BACKUP_DIR" ] && [ -f "$link_backup" ]; then
      old_target=$(cat "$link_backup")
      restore_symlink "$GENERATION_TARGET" "$old_target"
    elif [ -n "$BACKUP_DIR" ] && [ -d "$dir_backup" ]; then
      restore_directory "$GENERATION_TARGET" "$dir_backup"
    else
      warn "no backup for agnes-ai-generation; alias removed (old agent links may dangle again)"
    fi
  fi
elif [ -e "$GENERATION_TARGET" ]; then
  say "agnes-ai-generation is a real directory; leaving it untouched"
fi

# --- summary ------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  say ""
  say "DRY-RUN complete; no changes made ($CHANGES planned action(s))."
else
  say ""
  if [ "$CHANGES" -gt 0 ]; then
    say "uninstall complete ($CHANGES change(s)). Backups were preserved in: ${BACKUP_DIR:-<none>}"
  else
    say "nothing to do; no project-owned install was found."
  fi
  say "reinstall with: bash scripts/install-local.sh --yes"
fi
