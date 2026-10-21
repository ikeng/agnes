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
