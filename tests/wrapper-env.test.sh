#!/usr/bin/env bash
# Repo test: scripts/agnes wrapper and CLI .env.local autoload behavior.
# All checks are offline (auth check only) and use fake keys in temp dirs.
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agnes-wrapper.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

FAKE_KEY="sk-fake-wrapper-test-key-0000000000"

# 1) Project path: CLI autoloads .env.local from the current directory.
mkdir -p "$TMP/project"
cat > "$TMP/project/.env.local" <<EOF
# test env file
AGNES_API_KEY=$FAKE_KEY
AGNES_BASE_URL=http://127.0.0.1:9/v1
EOF
t_begin "CLI autoloads .env.local from cwd (project path)"
out=$(cd "$TMP/project" && env -u AGNES_API_KEY -u AGNES_BASE_URL -u AGNES_NO_DOTENV bash "$ROOT/scripts/agnes" auth check --json 2>/dev/null)
rc=$?
configured=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).configured))}catch(e){process.stdout.write("parse-error")}})' 2>/dev/null)
assert_eq "0" "$rc" "exit code" || true
assert_eq "true" "$configured" "configured" || true
t_begin "wrapper never prints the key"
assert_not_contains "$out" "$FAKE_KEY" "key leakage" || true

# 2) AGNES_NO_DOTENV=1 disables autoload.
t_begin "AGNES_NO_DOTENV=1 disables autoload"
out=$(cd "$TMP/project" && env -u AGNES_API_KEY -u AGNES_BASE_URL AGNES_NO_DOTENV=1 bash "$ROOT/scripts/agnes" auth check --json 2>/dev/null)
rc=$?
configured=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).configured))}catch(e){process.stdout.write("parse-error")}})' 2>/dev/null)
assert_eq "1" "$rc" "missing-key exit code" || true
assert_eq "false" "$configured" "configured" || true

# 3) Fallback path: project build override points nowhere, wrapper parses the
#    env file for the old global CLI and warns on stderr.
t_begin "fallback to global CLI parses AGNES_ENV_FILE"
cat > "$TMP/fallback.env" <<EOF
# malformed lines below should be ignored
this is not an assignment
export AGNES_API_KEY='$FAKE_KEY'
AGNES_BASE_URL="http://127.0.0.1:9/v1"
EOF
out=$(cd "$TMP" && env -u AGNES_API_KEY -u AGNES_BASE_URL -u AGNES_NO_DOTENV \
  AGNES_PROJECT_CLI="$TMP/does-not-exist.js" AGNES_ENV_FILE="$TMP/fallback.env" \
  bash "$ROOT/scripts/agnes" auth check --json 2>"$TMP/fallback.err")
rc=$?
configured=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).configured))}catch(e){process.stdout.write("parse-error")}})' 2>/dev/null)
err=$(cat "$TMP/fallback.err" 2>/dev/null || true)
assert_eq "true" "$configured" "configured via fallback parser" || true
assert_contains "$err" "falling back to global agnes" "fallback warning" || true
assert_not_contains "$out$err" "$FAKE_KEY" "key leakage in fallback" || true

# 4) Fallback disabled => clear error.
t_begin "AGNES_CLI_FALLBACK=0 fails clearly without project build"
err=$(cd "$TMP" && env -u AGNES_API_KEY AGNES_CLI_FALLBACK=0 AGNES_PROJECT_CLI="$TMP/does-not-exist.js" bash "$ROOT/scripts/agnes" --version 2>&1)
rc=$?
assert_eq "127" "$rc" "exit code" || true
assert_contains "$err" "project CLI build missing" "error message" || true

t_end
