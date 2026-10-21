#!/usr/bin/env bash
# Repo test: .env.example / .gitignore hygiene and root package.json wiring.
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)

t_begin ".env.example exists"
if [ -f "$ROOT/.env.example" ]; then t_ok; else t_fail "missing .env.example"; fi

env_example=$(cat "$ROOT/.env.example" 2>/dev/null || true)
t_begin ".env.example documents the key variable"
assert_contains "$env_example" "AGNES_API_KEY=" "AGNES_API_KEY present" || true

t_begin ".env.example documents AGNES_MEDIA_PROVIDER_ORDER"
assert_contains "$env_example" "AGNES_MEDIA_PROVIDER_ORDER=" "media provider order present" || true

t_begin ".env.example documents AGNES_BASE_URL override"
assert_contains "$env_example" "AGNES_BASE_URL=" "base url override present" || true

t_begin ".env.example has no real-looking secret"
if printf '%s' "$env_example" | grep -Eq 'sk-[A-Za-z0-9_-]{32,}'; then t_fail "long sk- token in .env.example"; else t_ok; fi

t_begin ".gitignore excludes .env.local and .env"
gitignore=$(cat "$ROOT/.gitignore" 2>/dev/null || true)
assert_contains "$gitignore" ".env.local" ".env.local ignored" || true
assert_contains "$gitignore" ".env" ".env ignored" || true

t_begin ".env.local (if present) is mode 600"
if [ -f "$ROOT/.env.local" ]; then
  mode=$(stat -f '%Lp' "$ROOT/.env.local" 2>/dev/null || stat -c '%a' "$ROOT/.env.local" 2>/dev/null)
  assert_eq "600" "${mode:-unknown}" ".env.local mode" || true
else
  t_skip ".env.local absent"
fi

t_begin "root package.json wires the documented scripts"
wiring=$(node -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expected = ["setup", "build", "test", "doctor", "install-local", "uninstall-local", "sync-upstream", "smoke", "smoke:live"];
const problems = [];
for (const name of expected) {
  const value = pkg.scripts && pkg.scripts[name];
  if (!value) { problems.push(`missing script ${name}`); continue; }
  const match = value.match(/bash\s+(tests\/[^\s]+|scripts\/[^\s]+)/);
  if (match && !fs.existsSync(path.join(root, match[1]))) problems.push(`${name} -> missing ${match[1]}`);
  const prefix = value.match(/npm --prefix (\w+)/);
  if (prefix && !fs.existsSync(path.join(root, prefix[1], "package.json"))) problems.push(`${name} -> missing ${prefix[1]}/package.json`);
}
process.stdout.write(problems.length ? problems.join("; ") : "OK");
' "$ROOT" 2>&1)
assert_eq "OK" "$wiring" "package.json script wiring" || true

t_begin "root package.json test script runs tests/run-all.sh"
pkg_test=$(node -e 'const p=require(process.argv[1]+"/package.json"); process.stdout.write(p.scripts.test||"")' "$ROOT" 2>/dev/null)
assert_contains "$pkg_test" "tests/run-all.sh" "npm test -> run-all.sh" || true

t_end
