#!/usr/bin/env bash
# smoke.sh — quick health check for the agnes-toolkit project CLI.
#
# Default mode is offline-safe: build/version, help, model catalog, auth status
# (missing key is a warning, not a failure), and a passthrough media URL test.
# With --live it also sends ONE cheap text-chat ping using agnes-2.5-flash
# (never image/video generation). The API key is never printed.
#
# Usage:
#   bash scripts/smoke.sh            # offline checks
#   bash scripts/smoke.sh --live     # offline checks + one live text ping
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

LIVE=0
FAIL=0
WARN=0
PASS=0
# Initialized up-front: preflight failures skip the block that normally fills
# these, and --live must not hit an unbound variable under `set -u`.
auth_configured=""
auth_rc=0

usage() {
  cat <<'EOF'
smoke.sh — quick health check for the agnes-toolkit project CLI.

Default mode is offline-safe: build/version, help, model catalog, auth status
(missing key is a warning, not a failure), and a passthrough media URL test.
With --live it also sends ONE cheap text-chat ping using agnes-2.5-flash
(never image/video generation).

Usage:
  bash scripts/smoke.sh            # offline checks
  bash scripts/smoke.sh --live     # offline checks + one live text ping
EOF
}

for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) agnes_err "unknown option: $arg"; usage; exit 2 ;;
  esac
done

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agnes-smoke.XXXXXX") || exit 1
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'WARN  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }

CLI_WRAPPER="$SCRIPT_DIR/agnes"
run_cli() {
  bash "$CLI_WRAPPER" "$@"
}

printf 'agnes-toolkit smoke (%s)\n' "$(date '+%Y-%m-%d %H:%M:%S%z')"
printf 'repo: %s\n\n' "$REPO_ROOT"

if ! agnes_have node; then
  bad "node not found"
else
  NODE_MAJOR=$(agnes_node_major || printf '0')
  if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then
    pass "node $(node -p 'process.versions.node' 2>/dev/null)"
  else
    bad "node < 20"
  fi
fi

if [ ! -f "$REPO_ROOT/cli/dist/cli.js" ]; then
  bad "project CLI build missing (run: bash scripts/setup.sh)"
else
  pass "project CLI build present"
fi

PACKAGE_VERSION=""
if [ -f "$REPO_ROOT/cli/package.json" ]; then
  PACKAGE_VERSION=$(node -p "require('$REPO_ROOT/cli/package.json').version" 2>/dev/null || true)
fi

if [ "$FAIL" -eq 0 ]; then
  VERSION_OUT=$(run_cli --version 2>/dev/null || true)
  if [ -n "$VERSION_OUT" ] && [ "$VERSION_OUT" = "$PACKAGE_VERSION" ]; then
    pass "agnes --version => $VERSION_OUT"
  elif [ -n "$VERSION_OUT" ]; then
    bad "agnes --version => $VERSION_OUT (package.json says ${PACKAGE_VERSION:-unknown})"
  else
    bad "agnes --version produced no output"
  fi

  if run_cli --help >/dev/null 2>&1; then
    pass "agnes --help works"
  else
    bad "agnes --help failed"
  fi

  models_json=$(run_cli models --json 2>/dev/null || true)
  text_default=$(printf '%s' "$models_json" | agnes_json_get text.default 2>/dev/null || true)
  image_default=$(printf '%s' "$models_json" | agnes_json_get image.default 2>/dev/null || true)
  video_default=$(printf '%s' "$models_json" | agnes_json_get video.default 2>/dev/null || true)
  if [ "$text_default" = "agnes-2.5-flash" ] && [ "$image_default" = "agnes-image-2.5-flash" ] && [ "$video_default" = "agnes-video-2.5" ]; then
    pass "models: text=$text_default image=$image_default video=$video_default"
  else
    bad "unexpected model defaults (text=${text_default:-?} image=${image_default:-?} video=${video_default:-?})"
  fi

  media_json=$(run_cli media url https://example.com/probe.png --json 2>/dev/null || true)
  media_url=$(printf '%s' "$media_json" | agnes_json_get url 2>/dev/null || true)
  media_source=$(printf '%s' "$media_json" | agnes_json_get source 2>/dev/null || true)
  if [ "$media_url" = "https://example.com/probe.png" ] && [ "$media_source" = "passthrough" ]; then
    pass "media url passthrough (no upload)"
  else
    bad "media url passthrough failed"
  fi

  auth_json=$(run_cli auth check --json 2>/dev/null)
  auth_rc=$?
  auth_configured=$(printf '%s' "$auth_json" | agnes_json_get configured 2>/dev/null || true)
  if [ "$auth_configured" = "true" ]; then
    pass "auth configured (exit=$auth_rc)"
  else
    warn "auth not configured (exit=$auth_rc); live checks skipped"
  fi
fi

if [ "$LIVE" = "1" ]; then
  printf '\n-- live text ping (agnes-2.5-flash) --\n'
  if [ "$auth_configured" != "true" ]; then
    bad "cannot run live smoke: AGNES_API_KEY not configured"
  else
    start_ms=$(node -p 'Date.now()')
    live_json=$(run_cli text chat --model agnes-2.5-flash --prompt "Reply with exactly: pong" --json 2>/dev/null)
    live_rc=$?
    end_ms=$(node -p 'Date.now()')
    latency=$((end_ms - start_ms))
    live_ok=$(printf '%s' "$live_json" | agnes_json_get ok 2>/dev/null || true)
    live_model=$(printf '%s' "$live_json" | agnes_json_get model 2>/dev/null || true)
    live_text=$(printf '%s' "$live_json" | agnes_json_get text 2>/dev/null || true)
    if [ "$live_rc" -eq 0 ] && [ "$live_ok" = "true" ]; then
      pass "live text ping OK in ${latency}ms (model=$live_model)"
      info "text: $(printf '%s' "$live_text" | tr '\n' ' ')"
    else
      bad "live text ping failed (exit=$live_rc, latency=${latency}ms)"
      info "response: $(printf '%s' "$live_json" | head -c 400)"
    fi
  fi
else
  printf '\n(offline mode; use --live for one cheap agnes-2.5-flash ping)\n'
fi

printf '\nsummary: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
