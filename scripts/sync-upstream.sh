#!/usr/bin/env bash
# sync-upstream.sh — compare the vendored CLI/skills with upstream, and
# optionally stage fresh upstream copies for manual review.
#
# It never edits the repository and never commits: --update only clones the
# upstream sources into a staging directory and prints diff instructions.
#
# Upstream sources:
#   CLI:            jomeswang/agnes-ai-cli      (vendored in cli/, see cli/UPSTREAM.md)
#   community skill: jomeswang/agnes-ai-skill   (base of skill/agnes-ai-skill)
#   official skill:  AgnesAI-Labs/skills         (vendored in skill/agnes-ai-models)
#
# Usage:
#   bash scripts/sync-upstream.sh              # network compare, read-only
#   bash scripts/sync-upstream.sh --offline    # print recorded versions only
#   bash scripts/sync-upstream.sh --update     # clone upstream into a staging dir
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

OFFLINE=0
UPDATE=0
STAGING_DIR=""

usage() {
  cat <<'EOF'
sync-upstream.sh — compare the vendored CLI/skills with upstream, read-only.

It never edits the repository and never commits: --update only clones the
upstream sources into a staging directory and prints diff instructions.

Usage:
  bash scripts/sync-upstream.sh                 # network compare, read-only
  bash scripts/sync-upstream.sh --offline       # print recorded versions only
  bash scripts/sync-upstream.sh --update        # clone upstream into staging
  bash scripts/sync-upstream.sh --staging-dir=/path
EOF
}

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    --offline) OFFLINE=1 ;;
    --staging-dir=*) STAGING_DIR=${arg#*=} ;;
    -h|--help) usage; exit 0 ;;
    *) agnes_err "unknown option: $arg"; usage; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
NETWORK_OK=1

recorded_cli_commit=$(sed -n 's/^- Vendored commit: \([a-f0-9]\{7,40\}\).*/\1/p' "$REPO_ROOT/cli/UPSTREAM.md" 2>/dev/null | head -n 1)
recorded_cli_npm=$(sed -n 's/.*agnes-ai-cli@\([0-9][0-9.]*\).*/\1/p' "$REPO_ROOT/cli/UPSTREAM.md" 2>/dev/null | head -n 1)
project_cli_version=$(node -p "require('$REPO_ROOT/cli/package.json').version" 2>/dev/null || true)
project_skill_version=$(agnes_skill_version "$REPO_ROOT/skill/agnes-ai-skill/SKILL.md" 2>/dev/null || true)
official_skill_version=$(agnes_skill_version "$REPO_ROOT/skill/agnes-ai-models/SKILL.md" 2>/dev/null || true)
[ -n "$official_skill_version" ] || official_skill_version="official"
recorded_official_commit=$(sed -n 's/^- Repo HEAD: *`\{0,1\}\([a-f0-9]\{7,40\}\).*/\1/p' "$REPO_ROOT/skill/agnes-ai-models/UPSTREAM.md" 2>/dev/null | head -n 1)
if [ -z "$recorded_official_commit" ]; then
  recorded_official_commit=$(sed -n 's/^- Commit: *`\{0,1\}\([a-f0-9]\{7,40\}\).*/\1/p' "$REPO_ROOT/skill/agnes-ai-models/UPSTREAM.md" 2>/dev/null | head -n 1)
fi

say "== agnes-toolkit sync-upstream =="
say "repo: $REPO_ROOT"
say ""
say "recorded:"
say "  CLI commit:        ${recorded_cli_commit:-unknown}"
say "  CLI npm release:   ${recorded_cli_npm:-unknown}"
say "  project CLI:       ${project_cli_version:-unknown} (local patches on top)"
say "  project skill:     ${project_skill_version:-unknown}"
say "  official skill:    ${official_skill_version:-unknown}${recorded_official_commit:+ (HEAD $recorded_official_commit)}"

if [ "$OFFLINE" = "1" ]; then
  say ""
  say "offline mode: upstream comparison skipped."
  exit 0
fi

say ""
say "checking upstream (bounded network)..."
npm_latest=$(npm view agnes-ai-cli version --fetch-timeout=15000 --fetch-retries=1 2>/dev/null || true)
if [ -n "$npm_latest" ]; then
  say "  npm agnes-ai-cli latest: $npm_latest"
else
  warn "could not query npm registry"
  NETWORK_OK=0
fi

cli_remote=$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 ls-remote https://github.com/jomeswang/agnes-ai-cli.git refs/heads/main refs/tags/v0.1.6 2>/dev/null || true)
cli_remote_main=$(printf '%s\n' "$cli_remote" | awk '$2 == "refs/heads/main" { print $1; exit }')
cli_remote_tag=$(printf '%s\n' "$cli_remote" | awk '$2 ~ /refs\/tags\/v0\.1\.6$/ { print $1; exit }')
if [ -n "$cli_remote_main" ]; then
  say "  GitHub CLI main:         $cli_remote_main"
  say "  GitHub CLI v0.1.6 tag:   ${cli_remote_tag:-unknown}"
else
  warn "could not query GitHub CLI repo"
  NETWORK_OK=0
fi

skill_remote=$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 ls-remote https://github.com/jomeswang/agnes-ai-skill.git refs/heads/main 2>/dev/null || true)
skill_remote_main=$(printf '%s\n' "$skill_remote" | awk '$2 == "refs/heads/main" { print $1; exit }')
if [ -n "$skill_remote_main" ]; then
  say "  GitHub skill main:       $skill_remote_main"
else
  warn "could not query GitHub skill repo"
  NETWORK_OK=0
fi

official_remote=$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 ls-remote https://github.com/AgnesAI-Labs/skills.git refs/heads/main 2>/dev/null || true)
official_remote_main=$(printf '%s\n' "$official_remote" | awk '$2 == "refs/heads/main" { print $1; exit }')
if [ -n "$official_remote_main" ]; then
  say "  GitHub official skills:  $official_remote_main"
else
  warn "could not query official skills repo"
  NETWORK_OK=0
fi

say ""
say "assessment:"
drift=0
if [ -n "$npm_latest" ] && [ -n "$recorded_cli_npm" ] && [ "$npm_latest" != "$recorded_cli_npm" ]; then
  say "  DRIFT: npm $npm_latest differs from vendored $recorded_cli_npm"
  drift=1
else
  say "  npm release: up to date"
fi
if [ -n "$cli_remote_main" ] && [ -n "$recorded_cli_commit" ] && [ "$cli_remote_main" != "$recorded_cli_commit" ]; then
  say "  DRIFT: upstream CLI main moved ($cli_remote_main != $recorded_cli_commit)"
  drift=1
else
  say "  CLI main: up to date"
fi
if [ -n "$official_remote_main" ] && [ -n "$recorded_official_commit" ] && [ "$official_remote_main" != "$recorded_official_commit" ]; then
  say "  DRIFT: official skills main moved ($official_remote_main != $recorded_official_commit)"
  drift=1
else
  say "  official skill: up to date"
fi
if [ -n "$skill_remote_main" ]; then
  say "  community skill main: $skill_remote_main (project skill has intentional 1.4.0 rewrites)"
fi

if [ "$UPDATE" = "1" ]; then
  say ""
  if [ -n "$STAGING_DIR" ]; then
    staging="$STAGING_DIR"
  else
    staging="${TMPDIR:-/tmp}/agnes-upstream-staging/$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$staging" || fail "cannot create staging dir: $staging"
  say "staging upstream into: $staging"
  failed=0
  if (cd "$staging" && GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/jomeswang/agnes-ai-cli.git cli >/dev/null 2>&1); then
    say "  cloned CLI -> $staging/cli"
  else
    warn "could not clone upstream CLI"
    failed=1
  fi
  if (cd "$staging" && GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/jomeswang/agnes-ai-skill.git skill >/dev/null 2>&1); then
    say "  cloned skill -> $staging/skill"
  else
    warn "could not clone upstream skill"
    failed=1
  fi
  if (cd "$staging" && GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/AgnesAI-Labs/skills.git official-skills >/dev/null 2>&1); then
    say "  cloned official skills -> $staging/official-skills"
  else
    warn "could not clone official skills"
    failed=1
  fi
  say ""
  say "review (nothing in the repo was modified):"
  say "  diff -ru $staging/cli/src $REPO_ROOT/cli/src"
  say "  diff -ru $staging/skill $REPO_ROOT/skill/agnes-ai-skill"
  say "  diff -ru $staging/official-skills/agnes-ai-models $REPO_ROOT/skill/agnes-ai-models"
  say "Apply changes manually, then: bash tests/run-all.sh"
  [ "$failed" = "0" ] || exit 1
else
  say ""
  say "read-only compare complete; nothing was modified."
  say "run with --update to clone upstream into a staging dir for manual review."
fi
