#!/usr/bin/env bash
# Repo test: vendored provenance records and required docs are present and
# consistent (offline).
set -u
# shellcheck source=/dev/null
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.sh"
ROOT=$(test_repo_root)

t_begin "cli/UPSTREAM.md records commit 9e62930 and npm 0.1.6"
upstream=$(cat "$ROOT/cli/UPSTREAM.md" 2>/dev/null || true)
assert_contains "$upstream" "9e629302cf30898d09f60fb2ba3e52e795b7ccf4" "vendored commit" || true
assert_contains "$upstream" "0.1.6" "vendored npm version" || true

t_begin "project CLI version is 0.3.0-local.1"
version=$(node -p "require('$ROOT/cli/package.json').version" 2>/dev/null || true)
assert_eq "0.3.0-local.1" "$version" "cli/package.json version" || true

t_begin "local patch is documented"
if [ -s "$ROOT/patches/cli-local.patch" ]; then t_ok; else t_fail "patches/cli-local.patch missing/empty"; fi

t_begin "docs/upstream-research.md and docs/local-audit.md exist"
if [ -s "$ROOT/docs/upstream-research.md" ] && [ -s "$ROOT/docs/local-audit.md" ]; then t_ok; else t_fail "missing research/audit docs"; fi

t_begin "project skills are vendored"
skills_ok=1
for skill in agnes-ai-skill agnes-ai-models; do
  if [ -s "$ROOT/skill/$skill/SKILL.md" ]; then
    :
  else
    skills_ok=0
  fi
done
if [ "$skills_ok" = "1" ]; then t_ok; else t_fail "missing skill directory (agnes-ai-skill / agnes-ai-models)"; fi

t_begin "CLI-first skill is version 1.4.0"
skill_version=$(sed -n 's/^version:[[:space:]]*//p' "$ROOT/skill/agnes-ai-skill/SKILL.md" 2>/dev/null | head -n 1)
assert_eq "1.4.0" "$skill_version" "skill version" || true

t_begin "official skill has an upstream provenance note"
if [ -s "$ROOT/skill/agnes-ai-models/UPSTREAM.md" ]; then t_ok; else t_fail "missing skill/agnes-ai-models/UPSTREAM.md"; fi

t_end
