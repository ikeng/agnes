#!/usr/bin/env bash
# Shared helpers for the agnes-toolkit scripts. Sourced by the other scripts;
# do not execute directly.
#
# macOS bash 3.2 compatible: no associative arrays, no ${var,,}, no mapfile.

# Resolve the repository root from the location of a script under scripts/.
agnes_repo_root() {
  local agnes_script_dir
  agnes_script_dir="$1"
  (CDPATH= cd -- "$agnes_script_dir/.." && pwd)
}

agnes_have() {
  command -v "$1" >/dev/null 2>&1
}

agnes_say() {
  printf '%s\n' "$*"
}

agnes_warn() {
  printf 'WARN: %s\n' "$*" >&2
}

agnes_err() {
  printf 'ERROR: %s\n' "$*" >&2
}

agnes_die() {
  agnes_err "$*"
  exit 1
}

# Print the major node version (or nothing when node is unavailable).
agnes_node_major() {
  if ! agnes_have node; then
    return 1
  fi
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

# Read JSON from stdin and print a dot-path value (empty path = whole document).
# Exits 2 on invalid JSON, 3 when the path is missing.
agnes_json_get() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(input); } catch (error) { process.exit(2); }
      const path = (process.argv[1] || "").split(".").filter(Boolean);
      for (const key of path) {
        if (value == null || typeof value !== "object" || !(key in value)) process.exit(3);
        value = value[key];
      }
      process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
    });
  ' "$1"
}

# Skill symlink locations that agent tools scan on this machine. These are the
# spots where the deleted "agnes-ai-generation" skill left dangling links.
agnes_skill_link_paths() {
  printf '%s\n' \
    "$HOME/.claude/skills/agnes-ai-generation" \
    "$HOME/.config/devin/skills/agnes-ai-generation" \
    "$HOME/.config/crush/skills/agnes-ai-generation" \
    "$HOME/.config/goose/skills/agnes-ai-generation" \
    "$HOME/.junie/skills/agnes-ai-generation" \
    "$HOME/.mux/skills/agnes-ai-generation" \
    "$HOME/.qwen/skills/agnes-ai-generation" \
    "$HOME/.openhands/skills/agnes-ai-generation" \
    "$HOME/.pochi/skills/agnes-ai-generation" \
    "$HOME/.trae-cn/skills/agnes-ai-generation" \
    "$HOME/.codemaker/skills/agnes-ai-generation"
}

# Agent skill directories that this toolkit knows about. Default discovery
# only syncs into existing dirs that already contain an `agnes-*` entry; set
# AGNES_AGENT_SKILL_DIRS to a colon-separated list (or "all") to override.
agnes_known_agent_skill_dirs() {
  printf '%s\n' \
    "$HOME/.claude/skills" \
    "$HOME/.config/devin/skills" \
    "$HOME/.config/crush/skills" \
    "$HOME/.config/goose/skills" \
    "$HOME/.junie/skills" \
    "$HOME/.mux/skills" \
    "$HOME/.qwen/skills" \
    "$HOME/.openhands/skills" \
    "$HOME/.pochi/skills" \
    "$HOME/.trae-cn/skills" \
    "$HOME/.codemaker/skills" \
    "$HOME/.codex/skills" \
    "$HOME/.cursor/skills" \
    "$HOME/.gemini/skills"
}

# True when <dir> exists and contains at least one `agnes-*` entry.
agnes_dir_has_agnes_entry() {
  local dir entry name
  dir=$1
  [ -d "$dir" ] || return 1
  for entry in "$dir"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=$(basename -- "$entry")
    case "$name" in
      agnes-*) return 0 ;;
    esac
  done
  return 1
}

# Print the agent skill dirs to sync (one normalized absolute path per line).
# Default: known existing dirs that already contain an agnes-* entry.
# AGNES_AGENT_SKILL_DIRS overrides: colon-separated paths, or "all" for every
# existing known dir. Missing dirs and duplicates are skipped.
agnes_agent_skill_dirs() {
  local override discovered dir candidate norm result
  override=${AGNES_AGENT_SKILL_DIRS:-}
  result=$'\n'

  if [ -n "$override" ]; then
    case "$override" in
      all) discovered=$(agnes_known_agent_skill_dirs) ;;
      *) discovered=$(printf '%s' "$override" | tr ':' '\n') ;;
    esac
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      candidate=$dir
      case "$candidate" in
        "~/"*) candidate="$HOME/${candidate#\~/}" ;;
      esac
      [ -d "$candidate" ] || continue
      norm=$(CDPATH= cd -- "$candidate" && pwd -P) || continue
      case "$result" in
        *$'\n'"$norm"$'\n'*) continue ;;
      esac
      result="${result}${norm}"$'\n'
    done <<< "$discovered"
  else
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      [ -d "$dir" ] || continue
      agnes_dir_has_agnes_entry "$dir" || continue
      norm=$(CDPATH= cd -- "$dir" && pwd -P) || continue
      case "$result" in
        *$'\n'"$norm"$'\n'*) continue ;;
      esac
      result="${result}${norm}"$'\n'
    done <<< "$(agnes_known_agent_skill_dirs)"
  fi

  printf '%s' "${result#$'\n'}"
}

# Guard: never modify the unrelated ~/.agnes product tree.
agnes_is_forbidden_path() {
  case "$1" in
    "$HOME/.agnes"|"$HOME/.agnes/"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Print a file's permission bits (macOS stat -f, GNU stat -c fallback).
agnes_file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

# Read one non-secret value from a dotenv-style file (AGNES_BASE_URL etc.).
# Usage: agnes_env_file_value <file> <KEY>
agnes_env_file_value() {
  local env_file env_key
  env_file=$1
  env_key=$2
  [ -f "$env_file" ] || return 0
  awk -v wanted="$env_key" '
    /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      eq = index(line, "=")
      key = substr(line, 1, eq - 1)
      gsub(/[[:space:]]/, "", key)
      if (key != wanted) next
      value = substr(line, eq + 1)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      sub(/^["\047]/, "", value)
      sub(/["\047]$/, "", value)
      print value
      found = 1
      exit
    }
  ' "$env_file"
}

# Print the "version: X" value from a SKILL.md frontmatter block.
agnes_skill_version() {
  if [ ! -f "$1" ]; then
    return 1
  fi
  sed -n 's/^version:[[:space:]]*//p' "$1" | head -n 1
}

# Print a masked description of an API-key line, never the value itself.
# Usage: agnes_masked_key_info <file>
agnes_masked_key_info() {
  local agnes_file
  agnes_file="$1"
  if [ ! -f "$agnes_file" ]; then
    printf 'missing'
    return 0
  fi
  awk '
    /^[[:space:]]*(export[[:space:]]+)?AGNES_API_KEY=/ {
      line = $0
      sub(/^[^=]*=/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      gsub(/^["\047]|["\047]$/, "", line)
      count++
      last = length(line)
    }
    END {
      if (count == 0) {
        printf "absent"
      } else {
        printf "present (len=%d)", last
      }
    }
  ' "$agnes_file"
}
