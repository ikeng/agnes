#!/usr/bin/env bash
# doctor.sh — read-only health report for the agnes-toolkit install.
#
# Reports environment, project build/CLI versions (project vs global), .env
# settings (key masked, never printed), auth status, skill/symlink health,
# docs reachability, and upstream drift. Without --offline it makes bounded
# network calls (curl/npm/git); with --offline everything is local.
#
# Exit status: 0 when no FAIL checks; with --strict also fails on WARN.
#
# Usage:
#   bash scripts/doctor.sh
#   bash scripts/doctor.sh --offline
#   bash scripts/doctor.sh --offline --strict
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

OFFLINE=0
STRICT=0
FAIL=0
WARN=0
PASS=0

usage() {
  cat <<'EOF'
doctor.sh — read-only health report for the agnes-toolkit install.

Reports environment, project build/CLI versions (project vs global), .env
settings (key masked, never printed), auth status, skill/symlink health, docs
reachability, and upstream drift. Without --offline it makes bounded network
calls; with --offline everything is local.

Usage:
  bash scripts/doctor.sh
  bash scripts/doctor.sh --offline
  bash scripts/doctor.sh --offline --strict
EOF
}

for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) usage; exit 0 ;;
    *) agnes_err "unknown option: $arg"; usage; exit 2 ;;
  esac
done

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'WARN  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }

say() { printf '%s\n' "$*"; }

say "agnes-toolkit doctor ($(date '+%Y-%m-%d %H:%M:%S%z'))"
say "repo: $REPO_ROOT"

section "environment"
if agnes_have node; then
  node_version=$(node -p 'process.versions.node' 2>/dev/null)
  node_major=$(agnes_node_major || printf '0')
  if [ "${node_major:-0}" -ge 20 ] 2>/dev/null; then
    pass "node $node_version (>= 20)"
  else
    bad "node $node_version (< 20 required)"
  fi
else
  bad "node not found"
fi
if agnes_have npm; then
  pass "npm $(npm --version 2>/dev/null)"
else
  bad "npm not found"
fi

section "project build"
CLI_PKG_VERSION=""
if [ -f "$REPO_ROOT/cli/package.json" ]; then
  CLI_PKG_VERSION=$(node -p "require('$REPO_ROOT/cli/package.json').version" 2>/dev/null || true)
  pass "cli/package.json (v${CLI_PKG_VERSION:-unknown})"
else
  bad "cli/package.json missing"
fi
if [ -f "$REPO_ROOT/cli/dist/cli.js" ]; then
  pass "cli/dist/cli.js present"
  if [ -d "$REPO_ROOT/cli/src" ] && [ -n "$(find "$REPO_ROOT/cli/src" -type f -newer "$REPO_ROOT/cli/dist/cli.js" -print -quit 2>/dev/null)" ]; then
    warn "cli/dist is older than cli/src (run: npm --prefix cli run build)"
  fi
else
  bad "cli/dist/cli.js missing (run: npm run setup)"
fi

section "CLI"
PROJECT_CLI_VERSION=""
if [ -f "$REPO_ROOT/cli/bin/agnes.js" ] && [ -f "$REPO_ROOT/cli/dist/cli.js" ]; then
  PROJECT_CLI_VERSION=$(node "$REPO_ROOT/cli/bin/agnes.js" --version 2>/dev/null || true)
  if [ -n "$PROJECT_CLI_VERSION" ]; then
    pass "project CLI: node cli/bin/agnes.js --version => $PROJECT_CLI_VERSION"
    if [ "$PROJECT_CLI_VERSION" != "$CLI_PKG_VERSION" ]; then
      warn "project CLI version ($PROJECT_CLI_VERSION) != package version ($CLI_PKG_VERSION)"
    fi
  else
    bad "project CLI failed to report a version"
  fi
else
  warn "project CLI build not available"
fi

GLOBAL_BIN=$(command -v agnes 2>/dev/null || true)
if [ -n "$GLOBAL_BIN" ]; then
  GLOBAL_VERSION=$("$GLOBAL_BIN" --version 2>/dev/null || true)
  pass "global CLI: $GLOBAL_BIN --version => ${GLOBAL_VERSION:-unknown}"
  GLOBAL_PKG=$(npm root -g 2>/dev/null || true)/agnes-ai-cli
  if [ -L "$GLOBAL_PKG" ]; then
    link_target=$(readlink "$GLOBAL_PKG" 2>/dev/null || true)
    case "$link_target" in
      "$REPO_ROOT"|"$REPO_ROOT"/*)
        pass "global package links to this repo: $GLOBAL_PKG -> $link_target"
        ;;
      *)
        warn "global package is a symlink elsewhere: $GLOBAL_PKG -> $link_target"
        ;;
    esac
  elif [ -d "$GLOBAL_PKG" ]; then
    warn "global package is the old standalone install ($GLOBAL_PKG); run scripts/install-local.sh to replace/back up"
  else
    info "no global agnes-ai-cli package found"
  fi
  if [ -n "$PROJECT_CLI_VERSION" ] && [ "$GLOBAL_VERSION" != "$PROJECT_CLI_VERSION" ]; then
    warn "global agnes version ($GLOBAL_VERSION) differs from project ($PROJECT_CLI_VERSION)"
  fi
else
  warn "no agnes binary on PATH"
fi

section ".env settings (key masked)"
ENV_FILE="$REPO_ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  mode=$(agnes_file_mode "$ENV_FILE")
  pass ".env.local present (mode ${mode:-unknown}, $(agnes_masked_key_info "$ENV_FILE"))"
  if [ "${mode:-600}" != "600" ]; then
    warn ".env.local mode is ${mode}; expected 600"
  fi
  base_url=$(agnes_env_file_value "$ENV_FILE" AGNES_BASE_URL)
  pass "AGNES_BASE_URL: ${base_url:-<unset -> https://apihub.agnes-ai.com/v1>}"
  provider_order=$(agnes_env_file_value "$ENV_FILE" AGNES_MEDIA_PROVIDER_ORDER)
  pass "AGNES_MEDIA_PROVIDER_ORDER: ${provider_order:-<default litterbox,tmpfiles,uguu,x0>}"
  timeout_ms=$(agnes_env_file_value "$ENV_FILE" AGNES_HTTP_TIMEOUT_MS)
  pass "AGNES_HTTP_TIMEOUT_MS: ${timeout_ms:-<default 120000>}"
else
  warn ".env.local missing (CLI commands will need AGNES_API_KEY exported)"
fi
info "HTTP retry policy: POST is never retried; GET status polling retries 429/5xx/network until timeout"

section "auth"
if [ -f "$REPO_ROOT/cli/bin/agnes.js" ] && [ -f "$REPO_ROOT/cli/dist/cli.js" ]; then
  auth_json=$(bash "$SCRIPT_DIR/agnes" auth check --json 2>/dev/null)
  auth_rc=$?
  if [ -n "$auth_json" ]; then
    configured=$(printf '%s' "$auth_json" | agnes_json_get configured 2>/dev/null || true)
    source=$(printf '%s' "$auth_json" | agnes_json_get source 2>/dev/null || true)
    if [ "$configured" = "true" ]; then
      pass "auth configured (source=${source:-env}, exit=$auth_rc)"
    else
      warn "auth not configured (source=${source:-missing}, exit=$auth_rc); fill .env.local"
    fi
  else
    bad "auth check produced no JSON (exit=$auth_rc)"
  fi
else
  warn "cannot run auth check: project CLI not built"
fi

section "skills and symlinks"
for skill_name in agnes-ai-skill agnes-ai-models agnes-ai-generation; do
  target="$HOME/.agents/skills/$skill_name"
  if [ -L "$target" ]; then
    link_target=$(readlink "$target" 2>/dev/null || true)
    if [ -e "$target" ]; then
      version=""
      [ -f "$target/SKILL.md" ] && version=$(agnes_skill_version "$target/SKILL.md")
      pass "$skill_name -> $link_target${version:+ (v$version)}"
    else
      bad "$skill_name -> $link_target (DANGLING)"
    fi
  elif [ -d "$target" ]; then
    version=""
    [ -f "$target/SKILL.md" ] && version=$(agnes_skill_version "$target/SKILL.md")
    warn "$skill_name is a real directory (not repo-linked)${version:+ (v$version)}"
  else
    warn "$skill_name not installed under ~/.agents/skills"
  fi
done

dangling=0
for link_path in $(agnes_skill_link_paths); do
  [ -L "$link_path" ] || continue
  if [ ! -e "$link_path" ]; then
    dangling=$((dangling + 1))
    info "dangling agent link: $link_path -> $(readlink "$link_path" 2>/dev/null)"
  fi
done
if [ "$dangling" -eq 0 ]; then
  pass "no dangling agnes-ai-generation links"
else
  warn "$dangling dangling agnes-ai-generation link(s); install-local creates the ~/.agents/skills/agnes-ai-generation alias"
fi

section "docs reachability"
if [ "$OFFLINE" = "1" ]; then
  info "skipped (--offline)"
else
  docs_code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://wiki.agnes-ai.com/llms.txt 2>/dev/null || true)
  case "$docs_code" in
    200|301|302) pass "docs index reachable (HTTP $docs_code)" ;;
    *) warn "docs index check returned HTTP ${docs_code:-none}" ;;
  esac
fi

section "upstream drift"
recorded_commit=$(sed -n 's/^- Vendored commit: \([a-f0-9]\{7,40\}\).*/\1/p' "$REPO_ROOT/cli/UPSTREAM.md" 2>/dev/null | head -n 1)
recorded_npm=$(sed -n 's/.*agnes-ai-cli@\([0-9][0-9.]*\).*/\1/p' "$REPO_ROOT/cli/UPSTREAM.md" 2>/dev/null | head -n 1)
recorded_skill=$(sed -n 's/^- Repo HEAD: *`\{0,1\}\([a-f0-9]\{7,40\}\).*/\1/p' "$REPO_ROOT/skill/agnes-ai-models/UPSTREAM.md" 2>/dev/null | head -n 1)
if [ -z "$recorded_skill" ]; then
  recorded_skill=$(sed -n 's/^- Commit: *`\{0,1\}\([a-f0-9]\{7,40\}\).*/\1/p' "$REPO_ROOT/skill/agnes-ai-models/UPSTREAM.md" 2>/dev/null | head -n 1)
fi
[ -n "$recorded_commit" ] || recorded_commit="unknown"
info "vendored CLI commit: $recorded_commit (npm ${recorded_npm:-unknown})"
if [ -f "$REPO_ROOT/skill/agnes-ai-models/SKILL.md" ]; then
  official_version=$(agnes_skill_version "$REPO_ROOT/skill/agnes-ai-models/SKILL.md" 2>/dev/null || true)
  info "vendored official skill: ${official_version:+v$official_version}${official_version:-official (no version field)}${recorded_skill:+ (commit $recorded_skill)}"
fi
if [ "$OFFLINE" = "1" ]; then
  info "upstream comparison skipped (--offline)"
elif ! agnes_have npm; then
  warn "npm unavailable; cannot check upstream npm version"
else
  npm_latest=$(npm view agnes-ai-cli version --fetch-timeout=15000 --fetch-retries=1 2>/dev/null || true)
  if [ -n "$npm_latest" ]; then
    info "npm latest: $npm_latest (vendored ${recorded_npm:-unknown})"
    if [ -n "$recorded_npm" ] && [ "$npm_latest" != "$recorded_npm" ]; then
      warn "upstream npm version differs from vendored release; run scripts/sync-upstream.sh"
    else
      pass "upstream npm release matches the vendored release"
    fi
  else
    warn "could not query npm registry (network?)"
  fi
  remote_cli=$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 ls-remote https://github.com/jomeswang/agnes-ai-cli.git refs/heads/main refs/tags/v0.1.6 2>/dev/null || true)
  if [ -n "$remote_cli" ]; then
    remote_main=$(printf '%s\n' "$remote_cli" | awk '$2 == "refs/heads/main" { print $1; exit }')
    info "upstream CLI main: ${remote_main:-unknown} (vendored $recorded_commit)"
    if [ -n "$remote_main" ] && [ -n "$recorded_commit" ] && [ "$remote_main" != "$recorded_commit" ] && [ "$recorded_commit" != "unknown" ]; then
      warn "upstream CLI main moved; run scripts/sync-upstream.sh"
    else
      pass "upstream CLI main matches the vendored commit"
    fi
  else
    warn "could not query GitHub (network?)"
  fi
fi

section "summary"
printf 'checks: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
if [ "$STRICT" = "1" ] && [ "$WARN" -gt 0 ]; then
  printf 'strict mode: treating warnings as failure\n'
  exit 1
fi
exit 0
