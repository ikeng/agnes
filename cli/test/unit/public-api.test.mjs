import test from "node:test";
import assert from "node:assert/strict";
import * as agnesCli from "../../dist/index.js";

test("public root export does not expose shell-mutation helpers", () => {
  assert.equal("saveKeyToShell" in agnesCli, false);
  assert.equal("resolveRcFile" in agnesCli, false);
});

test("createAgnesClient exposes the approved namespaces", () => {
  const client = agnesCli.createAgnesClient({ apiKey: "test-key" });
  assert.deepEqual(Object.keys(client).sort(), ["auth", "image", "media", "text", "video"]);
  assert.deepEqual(Object.keys(client.video).sort(), ["generate", "get", "poll"]);
});
