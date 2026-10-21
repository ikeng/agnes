// Repo test: no secrets committed in the working tree.
//
// - the real key from .env.local (if present) must not appear anywhere else
// - no long `sk-...` token outside .env* files (fake test keys allowlisted)
// - .env.local is git-ignored / not tracked
//
// Prints its own PASS/FAIL lines and exits non-zero on failures.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TEST_DIR);
const SKIP_DIRS = new Set([".git", "node_modules", "tmp", "out", "coverage", ".agnes-toolkit", ".upstream-staging"]);
const SKIP_FILES = new Set([".env.local", ".env", ".env.local.bak"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|mp4|mov|webm|tgz|zip|pdf|ico|woff2?)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

let checks = 0;
let failures = 0;
function check(name, fn) {
  checks += 1;
  process.stdout.write(`  - ${name} ... `);
  try {
    const detail = fn();
    process.stdout.write("ok\n");
    if (detail) process.stdout.write(`      ${detail}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write("FAIL\n");
    process.stdout.write(`      ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (BINARY_EXT.test(entry.name)) continue;
    try {
      if (statSync(abs).size > MAX_BYTES) continue;
    } catch {
      continue;
    }
    files.push(abs);
  }
  return files;
}

const files = walk(ROOT);
check("repository contains source files to scan", () => {
  if (files.length < 20) throw new Error(`only ${files.length} files found under ${ROOT}`);
  return `${files.length} files scanned`;
});

const envPath = path.join(ROOT, ".env.local");
let realKey;
try {
  const match = readFileSync(envPath, "utf8").match(/^\s*(?:export\s+)?AGNES_API_KEY\s*=\s*(.+)$/m);
  if (match) realKey = match[1].trim().replace(/^['"]|['"]$/g, "");
} catch {
  // .env.local is optional in CI
}

check("real API key from .env.local is not present in any tracked file", () => {
  if (!realKey) return "skipped (no .env.local)";
  if (realKey.length < 8) throw new Error("suspiciously short key in .env.local");
  const hits = files.filter((file) => {
    try {
      return readFileSync(file, "utf8").includes(realKey);
    } catch {
      return false;
    }
  });
  if (hits.length > 0) throw new Error(`key found in: ${hits.map((f) => path.relative(ROOT, f)).join(", ")}`);
  return "no hits";
});

check("no long sk- token in files (fake test keys allowlisted)", () => {
  const allowed = /^(sk-fake|sk-test|sk-replace|sk-xxxxxxxx|sk-\.\.\.)/;
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const matches = text.match(/sk-[A-Za-z0-9_-]{20,}/g) || [];
    for (const token of matches) {
      if (allowed.test(token)) continue;
      hits.push(`${path.relative(ROOT, file)}: ${token.slice(0, 6)}…(${token.length})`);
    }
  }
  if (hits.length > 0) throw new Error(hits.slice(0, 5).join("; "));
  return "no suspicious tokens";
});

check(".env.example contains only a placeholder key", () => {
  const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  if (!/AGNES_API_KEY=/.test(example)) throw new Error("AGNES_API_KEY missing from .env.example");
  if (/sk-[A-Za-z0-9_-]{32,}/.test(example)) throw new Error("looks like a real key in .env.example");
  return ".env.example OK";
});

check(".env.local is git-ignored / untracked", () => {
  let ignored = false;
  try {
    execFileSync("git", ["check-ignore", "-q", ".env.local"], { cwd: ROOT, stdio: "ignore" });
    ignored = true;
  } catch {
    ignored = false;
  }
  if (!ignored) throw new Error(".env.local is not matched by .gitignore");
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "--", ".env.local"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    tracked = "";
  }
  if (tracked) throw new Error(`.env.local is tracked: ${tracked}`);
  return "ignored and untracked";
});

check("repo test suite itself does not embed the real key", () => {
  if (!realKey) return "skipped (no .env.local)";
  const testFiles = files.filter((file) => file.startsWith(path.join(ROOT, "tests")));
  for (const file of testFiles) {
    if (readFileSync(file, "utf8").includes(realKey)) throw new Error(path.relative(ROOT, file));
  }
  return `checked ${testFiles.length} test files`;
});

console.log(`  => ${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
