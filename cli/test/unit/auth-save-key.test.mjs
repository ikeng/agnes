import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRcFile, saveKeyToShell } from "../../dist/auth/saveKey.js";

test("resolveRcFile selects zshrc for zsh", () => {
  assert.equal(resolveRcFile("zsh", "/tmp/home"), "/tmp/home/.zshrc");
});

test("saveKeyToShell writes export line", async () => {
  const home = await mkdtemp(join(tmpdir(), "agnes-cli-"));
  const result = await saveKeyToShell("sk-test", {
    homeDir: home,
    shell: "zsh",
    env: { HOME: home, SHELL: "/bin/zsh" },
  });
  const contents = await readFile(result.rcFile, "utf8");
  assert.match(contents, /export AGNES_API_KEY='sk-test'/);
});
