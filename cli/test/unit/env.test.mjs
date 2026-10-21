import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalEnv } from "../../dist/env.js";

const MANAGED_KEYS = ["AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_NO_DOTENV", "AGNES_ENV_FILE", "TEST_DOTENV_VALUE"];

function withCleanEnv(fn) {
  const saved = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const key of MANAGED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function makeTempTree() {
  const root = mkdtempSync(join(tmpdir(), "agnes-env-test-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  return { root, nested, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("loadLocalEnv walks up to the nearest .env.local", () => {
  withCleanEnv(() => {
    const tree = makeTempTree();
    try {
      writeFileSync(join(tree.root, ".env.local"), "AGNES_API_KEY=fake-from-file\nTEST_DOTENV_VALUE=hello\n");
      const loaded = loadLocalEnv({ startDir: tree.nested });
      assert.equal(loaded, join(tree.root, ".env.local"));
      assert.equal(process.env.AGNES_API_KEY, "fake-from-file");
      assert.equal(process.env.TEST_DOTENV_VALUE, "hello");
    } finally {
      tree.cleanup();
    }
  });
});

test("loadLocalEnv never overrides explicit environment variables", () => {
  withCleanEnv(() => {
    const tree = makeTempTree();
    try {
      writeFileSync(join(tree.root, ".env.local"), "AGNES_API_KEY=fake-from-file\n");
      process.env.AGNES_API_KEY = "explicit-key";
      loadLocalEnv({ startDir: tree.nested });
      assert.equal(process.env.AGNES_API_KEY, "explicit-key");
    } finally {
      tree.cleanup();
    }
  });
});

test("AGNES_NO_DOTENV disables loading", () => {
  withCleanEnv(() => {
    const tree = makeTempTree();
    try {
      writeFileSync(join(tree.root, ".env.local"), "AGNES_API_KEY=fake-from-file\n");
      process.env.AGNES_NO_DOTENV = "1";
      const loaded = loadLocalEnv({ startDir: tree.nested });
      assert.equal(loaded, undefined);
      assert.equal(process.env.AGNES_API_KEY, undefined);
    } finally {
      tree.cleanup();
    }
  });
});
