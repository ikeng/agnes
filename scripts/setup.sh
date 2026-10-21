#!/usr/bin/env bash
# setup.sh — idempotent one-time setup for the agnes-toolkit repo.
#
# Checks Node >= 20, installs/builds the patched CLI under cli/, and creates
# .env.local from .env.example when it does not exist yet (never overwrites).
# Does not install anything globally; use scripts/install-local.sh for that.
#
# Usage:
#   bash scripts/setup.sh                 # check + install/build + env file
#   bash scripts/setup.sh --check         # check only, no changes
#   bash scripts/setup.sh --rebuild       # force npm install + build
#   bash scripts/setup.sh --with-live-check  # run smoke.sh --live afterwards
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

CHECK_ONLY=0
REBUILD=0
WITH_LIVE=0

usage() {
  cat <<'EOF'
setup.sh — idempotent setup for the agnes-toolkit repo.

Checks Node >= 20, installs/builds cli/, and creates .env.local from
.env.example when absent (never overwrites). Does not change global state.

Usage:
  bash scripts/setup.sh                    # check + install/build + env file
  bash scripts/setup.sh --check            # check only, no changes
  bash scripts/setup.sh --rebuild          # force npm install + build
  bash scripts/setup.sh --with-live-check  # run smoke.sh --live afterwards
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check|--dry-run) CHECK_ONLY=1 ;;
    --rebuild) REBUILD=1 ;;
    --with-live-check) WITH_LIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) agnes_err "unknown option: $arg"; usage; exit 2 ;;
  esac
done

FAIL=0
note() { printf '%s\n' "$*"; }
ok() { printf 'PASS: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }

note "== agnes-toolkit setup =="
note "repo: $REPO_ROOT"

if ! agnes_have node; then
  bad "node not found on PATH (need Node >= 20)"
else
  NODE_MAJOR=$(agnes_node_major || printf '0')
  NODE_VERSION=$(node -p 'process.versions.node' 2>/dev/null)
  if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then
    ok "node $NODE_VERSION"
  else
    bad "node $NODE_VERSION is too old; need >= 20"
  fi
fi

if agnes_have npm; then
  ok "npm $(npm --version 2>/dev/null)"
else
  bad "npm not found on PATH"
fi

if [ -f "$REPO_ROOT/cli/package.json" ]; then
  ok "cli/package.json present"
else
  bad "cli/package.json missing"
fi

if [ ! -f "$REPO_ROOT/cli/bin/agnes.js" ]; then
  bad "cli/bin/agnes.js missing"
fi

if [ -f "$REPO_ROOT/cli/dist/cli.js" ]; then
  ok "project CLI build present (cli/dist/cli.js)"
else
  warn "project CLI build missing (will be built by setup)"
fi

if [ -f "$REPO_ROOT/.env.local" ]; then
  ok ".env.local present ($(agnes_masked_key_info "$REPO_ROOT/.env.local"))"
else
  warn ".env.local missing (will be created from .env.example)"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  note ""
  if [ "$FAIL" -gt 0 ]; then
    note "check: FAIL ($FAIL problem(s))"
    exit 1
  fi
  note "check: prerequisites look OK (no changes made)"
  exit 0
fi

# --- .env.local ---------------------------------------------------------------
ENV_FILE="$REPO_ROOT/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$REPO_ROOT/.env.example" ]; then
    cp "$REPO_ROOT/.env.example" "$ENV_FILE"
    note "created .env.local from .env.example"
  else
    printf '# Copy from .env.example and fill in.\nAGNES_API_KEY=\n' > "$ENV_FILE"
    note "created empty .env.local"
  fi
fi
chmod 600 "$ENV_FILE" 2>/dev/null || warn "could not chmod 600 .env.local"
if grep -q '^[[:space:]]*AGNES_API_KEY=sk-xxxxxxxx' "$ENV_FILE" 2>/dev/null || ! grep -q '^[[:space:]]*AGNES_API_KEY=.' "$ENV_FILE" 2>/dev/null; then
  warn ".env.local has no API key yet; edit it before live commands"
fi

# --- dependencies + build -----------------------------------------------------
if [ ! -d "$REPO_ROOT/cli/node_modules" ] || [ "$REBUILD" = "1" ]; then
  note "installing cli dependencies..."
  if ! (cd "$REPO_ROOT/cli" && npm install --no-audit --no-fund); then
    bad "npm install in cli/ failed"
    exit 1
  fi
  REBUILD=1
fi

NEED_BUILD=0
if [ "$REBUILD" = "1" ] || [ ! -f "$REPO_ROOT/cli/dist/cli.js" ]; then
  NEED_BUILD=1
elif [ -d "$REPO_ROOT/cli/src" ] && [ -n "$(find "$REPO_ROOT/cli/src" -type f -newer "$REPO_ROOT/cli/dist/cli.js" -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  note "building project CLI..."
  if ! (cd "$REPO_ROOT/cli" && npm run build); then
    bad "project CLI build failed"
    exit 1
  fi
  ok "project CLI built"
else
  ok "project CLI build is up to date"
fi

if [ "$FAIL" -gt 0 ]; then
  note ""
  note "setup: FAIL ($FAIL problem(s))"
  exit 1
fi

note ""
note "setup complete. Next:"
note "  1. put your key in .env.local (mode 600) if it is not there yet"
note "  2. bash tests/run-all.sh          # offline checks"
note "  3. bash scripts/install-local.sh  # optional: replace the old global CLI + skill"
note "  4. bash scripts/smoke.sh --live   # optional: one cheap text ping"

if [ "$WITH_LIVE" = "1" ]; then
  note ""
  note "running live smoke test..."
  if ! bash "$SCRIPT_DIR/smoke.sh" --live; then
    bad "live smoke test failed"
    exit 1
  fi
fi
