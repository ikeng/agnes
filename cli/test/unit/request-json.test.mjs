import assert from "node:assert/strict";
import test from "node:test";

import { requestJson } from "../../dist/http/requestJson.js";

test("preserves and sanitizes a JSON HTTP error body", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        error: { message: "unsupported resolution and frame count" },
        api_key: "sk-secret-value",
        authorization: "Bearer secret-token",
        client_secret: "client-secret-value",
        refresh_token: "refresh-token-value",
        callback: "https://example.test/callback?token=secret-query-value",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  const { response, raw } = await requestJson(fetchImpl, "https://example.test", {});

  assert.equal(response.status, 400);
  assert.deepEqual(raw, {
    error: { message: "unsupported resolution and frame count" },
    api_key: "[REDACTED]",
    authorization: "[REDACTED]",
    client_secret: "[REDACTED]",
    refresh_token: "[REDACTED]",
    callback: "https://example.test/callback?token=[REDACTED]",
  });
});

test("preserves a plain-text HTTP error body without retrying", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("invalid request for sk-secret-value", { status: 400 });
  };

  const { response, raw } = await requestJson(fetchImpl, "https://example.test", {});

  assert.equal(response.status, 400);
  assert.equal(raw, "invalid request for [REDACTED]");
  assert.equal(calls, 1);
});

test("represents an empty HTTP error body as null", async () => {
  const fetchImpl = async () => new Response(null, { status: 502 });

  const { response, raw } = await requestJson(fetchImpl, "https://example.test", {});

  assert.equal(response.status, 502);
  assert.equal(raw, null);
});

test("does not retry POST network failures by default (billing safety)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("socket hang up");
  };

  await assert.rejects(
    () => requestJson(fetchImpl, "https://example.test/videos", { method: "POST" }, { retryDelayMs: 0 }),
    (error) => error.code === "NETWORK_ERROR",
  );
  assert.equal(calls, 1);
});

test("retries idempotent GET network failures", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error("temporary dns failure");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { response } = await requestJson(fetchImpl, "https://example.test/agnesapi", {}, { retryDelayMs: 0 });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});
