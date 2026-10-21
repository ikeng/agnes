import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, DEFAULT_BASE_URL } from "../../dist/config.js";

test("resolveConfig uses the default international base URL", () => {
  const resolved = resolveConfig({ env: {} });
  assert.equal(resolved.baseUrl, DEFAULT_BASE_URL);
});

test("resolveConfig honors AGNES_BASE_URL for alternate gateways", () => {
  const resolved = resolveConfig({
    env: {
      AGNES_API_KEY: "test-key",
      AGNES_BASE_URL: "https://api.agnes-ai.cn/v1",
    },
  });
  assert.equal(resolved.baseUrl, "https://api.agnes-ai.cn/v1");
  assert.equal(resolved.apiKey, "test-key");
});

test("explicit config.baseUrl wins over env", () => {
  const resolved = resolveConfig({
    baseUrl: "https://example.com/v1",
    env: { AGNES_BASE_URL: "https://api.agnes-ai.cn/v1" },
  });
  assert.equal(resolved.baseUrl, "https://example.com/v1");
});

test("resolveConfig parses AGNES_MEDIA_PROVIDER_ORDER", () => {
  const resolved = resolveConfig({
    env: { AGNES_MEDIA_PROVIDER_ORDER: "uguu, x0 ,litterbox" },
  });
  assert.deepEqual(resolved.temporaryMediaProviderOrder, ["uguu", "x0", "litterbox"]);
});

test("resolveConfig rejects unknown media providers", () => {
  assert.throws(
    () => resolveConfig({ env: { AGNES_MEDIA_PROVIDER_ORDER: "uguu,dropbox" } }),
    (error) => error.code === "INVALID_ENV",
  );
});
