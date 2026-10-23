import test from "node:test";
import assert from "node:assert/strict";

import { createFakeAgnesServer } from "../helpers/fake-agnes-server.mjs";
import { createAgnesClient } from "../../dist/index.js";

/**
 * AC3/AC4 routing tests against the shared fake server. Rate limiting is
 * disabled here (classification/failover stays active with >1 account) so
 * these tests exercise routing decisions without token-bucket waits.
 */
async function withServer(t, accounts) {
  const server = await createFakeAgnesServer({ accounts });
  t.after(() => server.close());
  return server;
}

function makeClient(server, accounts, extra = {}) {
  return createAgnesClient({
    accounts: accounts.map((account) => ({
      keySource: "options",
      type: "free",
      weight: 1,
      priority: 0,
      poolId: account.id,
      ...account,
    })),
    baseUrl: server.baseUrl,
    rateLimit: false,
    ...extra,
  });
}

const AZ = (id, extra = {}) => ({ key: `sk-test-${id}`, id, ...extra });

function accountIds(requests, predicate = () => true) {
  return requests.filter(predicate).map((request) => request.accountId);
}

/* ---------------------------------- AC3 ---------------------------------- */

test("round-robin distributes text requests across accounts", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b"), AZ("c")]);
  const client = makeClient(server, [AZ("a"), AZ("b"), AZ("c")], { strategy: "round-robin" });
  for (let index = 0; index < 6; index += 1) {
    const result = await client.text.complete({ prompt: `ping ${index}` });
    assert.equal(result.routing.strategy, "round-robin");
    assert.equal(result.routing.attempts, 1);
    assert.equal(result.routing.fallback, false);
    assert.ok(["a", "b", "c"].includes(result.accountId));
  }
  const counts = Object.fromEntries(
    ["a", "b", "c"].map((id) => [id, server.countRequests({ accountId: id, pathIncludes: "chat/completions" })]),
  );
  assert.deepEqual(counts, { a: 2, b: 2, c: 2 });
});

test("weighted strategy honors account weights", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  const client = makeClient(
    server,
    [
      { ...AZ("a"), weight: 1 },
      { ...AZ("b"), weight: 3 },
    ],
    { strategy: "weighted" },
  );
  for (let index = 0; index < 8; index += 1) await client.text.complete({ prompt: `w${index}` });
  const counts = {
    a: server.countRequests({ accountId: "a", pathIncludes: "chat/completions" }),
    b: server.countRequests({ accountId: "b", pathIncludes: "chat/completions" }),
  };
  assert.deepEqual(counts, { a: 2, b: 6 });
});

test("primary strategy prefers the lowest priority value", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  const client = makeClient(
    server,
    [
      { ...AZ("a"), priority: 1 },
      { ...AZ("b"), priority: 0 },
    ],
    { strategy: "primary" },
  );
  for (let index = 0; index < 3; index += 1) await client.text.complete({ prompt: `p${index}` });
  assert.equal(server.countRequests({ accountId: "a" }), 0);
  assert.equal(server.countRequests({ accountId: "b", pathIncludes: "chat/completions" }), 3);
});

test("least-inflight and adaptive spread concurrent requests over idle accounts", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  server.setDelay(null, 40);
  const client = makeClient(server, [AZ("a"), AZ("b")], { strategy: "least-inflight" });
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) => client.text.complete({ prompt: `c${index}` })),
  );
  assert.deepEqual(results.map((result) => result.accountId).sort(), ["a", "a", "b", "b"]);
  assert.equal(server.countRequests({ pathIncludes: "chat/completions" }), 4);
});

test("adaptive strategy alternates idle accounts", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  const client = makeClient(server, [AZ("a"), AZ("b")], { strategy: "adaptive" });
  for (let index = 0; index < 6; index += 1) await client.text.complete({ prompt: `a${index}` });
  assert.equal(server.countRequests({ accountId: "a", pathIncludes: "chat/completions" }), 3);
  assert.equal(server.countRequests({ accountId: "b", pathIncludes: "chat/completions" }), 3);
});

test("forced account pins every request and skips model-less accounts", async (t) => {
  const server = await withServer(t, [
    AZ("a", { models: ["agnes-image-2.5-flash"] }),
    AZ("b", { models: ["agnes-2.5-flash"] }),
  ]);
  const client = makeClient(server, [
    { ...AZ("a"), models: ["agnes-image-2.5-flash"] },
    { ...AZ("b"), models: ["agnes-2.5-flash"] },
  ], { strategy: "round-robin" });

  await client.text.complete({ prompt: "text", route: { accountId: "b" } });
  await client.image.generate({ mode: "text2img", prompt: "img", route: { accountId: "a" } });
  assert.equal(server.countRequests({ accountId: "b", pathIncludes: "chat/completions" }), 1);
  assert.equal(server.countRequests({ accountId: "a", pathIncludes: "image" }), 1);

  // Model capability filter: image model only exists in account a's allowlist.
  for (let index = 0; index < 2; index += 1) {
    const result = await client.image.generate({ mode: "text2img", prompt: `i${index}` });
    assert.equal(result.accountId, "a");
  }
  // Forced account lacking the model fails loudly instead of substituting.
  await assert.rejects(
    () => client.text.complete({ prompt: "nope", model: "agnes-2.5-flash", route: { accountId: "a" } }),
    (error) => error.code === "MODEL_NOT_ALLOWED",
  );
});

test("401 on a bad credential fails over to a healthy account (mixed pool)", async (t) => {
  const server = await withServer(t, [AZ("good")]);
  const config = {
    accounts: [
      { id: "bad", key: "sk-test-invalid", keySource: "options", type: "free", poolId: "pool-bad", weight: 1, priority: 0 },
      { id: "good", key: "sk-test-good", keySource: "options", type: "free", poolId: "pool-good", weight: 1, priority: 0 },
    ],
    baseUrl: server.baseUrl,
    rateLimit: false,
    strategy: "round-robin",
  };
  const client = createAgnesClient(config);
  const result = await client.text.complete({ prompt: "ping" });
  assert.equal(result.accountId, "good");
  assert.equal(result.routing.attempts, 2);
  assert.equal(result.routing.fallback, true);
  assert.equal(server.requests[0].key, "sk-test-invalid");
  assert.equal(server.requests[1].accountId, "good");
  assert.equal(client.router.summary().accounts.find((account) => account.id === "bad").healthy, false);
});

test("forced account disables failover and names the account on auth failure", async (t) => {
  const server = await withServer(t, [AZ("good")]);
  const client = createAgnesClient({
    accounts: [
      { id: "bad", key: "sk-test-invalid", keySource: "options", type: "free", poolId: "p1", weight: 1, priority: 0 },
      { id: "good", key: "sk-test-good", keySource: "options", type: "free", poolId: "p2", weight: 1, priority: 0 },
    ],
    baseUrl: server.baseUrl,
    rateLimit: false,
  });
  await assert.rejects(
    () => client.text.complete({ prompt: "x", route: { accountId: "bad" } }),
    (error) => {
      assert.equal(error.code, "ACCOUNT_AUTH_FAILED");
      assert.match(error.message, /"bad"/);
      assert.equal(error.details.accountsTried.length, 1);
      return true;
    },
  );
  assert.equal(server.countRequests({ accountId: "good" }), 0);
});

test("429 on a create cools the whole pool and fails over to another pool", async (t) => {
  const server = await withServer(t, [AZ("a1"), AZ("a2"), AZ("b")]);
  const client = createAgnesClient({
    accounts: [
      { id: "a1", key: "sk-test-a1", keySource: "options", type: "free", poolId: "pool-a", weight: 1, priority: 0 },
      { id: "a2", key: "sk-test-a2", keySource: "options", type: "free", poolId: "pool-a", weight: 1, priority: 0 },
      { id: "b", key: "sk-test-b", keySource: "options", type: "free", poolId: "pool-b", weight: 1, priority: 0 },
    ],
    baseUrl: server.baseUrl,
    rateLimit: false,
    strategy: "round-robin",
  });
  server.setRateLimit("sk-test-a1", { times: 1, retryAfter: 1, appliesTo: "create" });

  const first = await client.text.complete({ prompt: "one" });
  assert.equal(first.routing.attempts, 2);
  assert.equal(first.routing.fallback, true);
  assert.equal(first.accountId, "b");

  // pool-a is cooling: the shared-cooldown rule must keep both a1 and a2 out.
  const second = await client.text.complete({ prompt: "two" });
  assert.equal(second.accountId, "b");
  assert.equal(server.countRequests({ accountId: "a1" }), 1);
  assert.equal(server.countRequests({ accountId: "a2" }), 0);
  assert.equal(server.countRequests({ accountId: "b", pathIncludes: "chat/completions" }), 2);
});

test("402 marks the pool depleted and fails over", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  server.setForcedStatus("sk-test-a", 402);
  const client = createAgnesClient({
    accounts: [
      { id: "a", key: "sk-test-a", keySource: "options", type: "free", poolId: "pa", weight: 1, priority: 0 },
      { id: "b", key: "sk-test-b", keySource: "options", type: "free", poolId: "pb", weight: 1, priority: 0 },
    ],
    baseUrl: server.baseUrl,
    rateLimit: false,
    strategy: "round-robin",
  });
  const result = await client.text.complete({ prompt: "quota" });
  assert.equal(result.accountId, "b");
  assert.equal(result.routing.attempts, 2);
  assert.equal(server.countRequests({ accountId: "a" }), 1);
  // Depleted pool stays out of rotation for subsequent creates.
  const second = await client.text.complete({ prompt: "again" });
  assert.equal(second.accountId, "b");
  assert.equal(server.countRequests({ accountId: "a" }), 1);
});

test("5xx after a create never retries: AMBIGUOUS_CREATE with one send", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  server.setForcedStatus(null, 500);
  const client = makeClient(server, [AZ("a"), AZ("b")]);
  await assert.rejects(
    () => client.text.complete({ prompt: "ambiguous" }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CREATE");
      assert.equal(error.details.accountId, "a");
      assert.equal(error.details.httpStatus, 500);
      return true;
    },
  );
  assert.equal(server.countRequests({ method: "POST" }), 1, "ambiguous create must not be retried");
});

test("network failure after a create is AMBIGUOUS_CREATE (billing safety)", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  const client = createAgnesClient({
    accounts: [
      { id: "a", key: "sk-test-a", keySource: "options", type: "free", poolId: "pa", weight: 1, priority: 0 },
      { id: "b", key: "sk-test-b", keySource: "options", type: "free", poolId: "pb", weight: 1, priority: 0 },
    ],
    baseUrl: server.baseUrl,
    rateLimit: false,
    fetchImpl: async (url, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") throw new Error("socket hang up");
      return fetch(url, init);
    },
  });
  await assert.rejects(
    () => client.text.complete({ prompt: "network" }),
    (error) => error.code === "AMBIGUOUS_CREATE" && /socket hang up/.test(error.details.cause),
  );
});

test("400 responses stay with the caller and are not failed over", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  server.setForcedStatus(null, 400);
  const client = makeClient(server, [AZ("a"), AZ("b")]);
  await assert.rejects(
    () => client.text.complete({ prompt: "bad request" }),
    (error) => error.code === "AGNES_REQUEST_FAILED" && /HTTP 400/.test(error.message),
  );
  assert.equal(server.countRequests(), 1);
});

test("maxAttempts bounds failover across all accounts", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  server.setForcedStatus(null, 401);
  const client = makeClient(server, [AZ("a"), AZ("b")]);
  await assert.rejects(
    () => client.text.complete({ prompt: "auth" }),
    (error) => {
      assert.equal(error.code, "ACCOUNT_AUTH_FAILED");
      assert.equal(error.details.accountsTried.length, 2);
      return true;
    },
  );
  assert.equal(server.countRequests(), 2);
});

test("router.select honors strategy, model filter and exclusions from the real client", async (t) => {
  const server = await withServer(t, [AZ("a"), AZ("b")]);
  const client = makeClient(
    server,
    [
      { ...AZ("a"), models: ["agnes-image-2.5-flash"], priority: 1, poolId: "pa" },
      { ...AZ("b"), models: ["agnes-2.5-flash"], priority: 0, poolId: "pb" },
    ],
    { strategy: "primary" },
  );
  const imageAccount = client.router.select({ workload: "image", model: "agnes-image-2.5-flash" });
  assert.equal(imageAccount.id, "a");
  const textAccount = client.router.select({ workload: "text", model: "agnes-2.5-flash" });
  assert.equal(textAccount.id, "b");
  const excluded = client.router.select({ workload: "text", model: "agnes-2.5-flash", excludeAccountIds: ["b"] });
  assert.equal(excluded, undefined);

  const summary = client.router.summary();
  assert.equal(summary.strategy, "primary");
  assert.equal(summary.rateLimitEnabled, false);
  assert.deepEqual(summary.accounts.map((account) => account.id), ["a", "b"]);
  assert.deepEqual(summary.pools.map((pool) => pool.id), ["pa", "pb"]);
  assert.ok(!JSON.stringify(summary).includes("sk-test-"));
});

test("no account serving the requested model fails loudly with MODEL_NOT_ALLOWED", async (t) => {
  const server = await withServer(t, [AZ("a")]);
  const client = makeClient(server, [{ ...AZ("a"), models: ["agnes-2.5-flash"] }]);
  await assert.rejects(
    () => client.text.complete({ prompt: "x", model: "agnes-3.0-flash" }),
    (error) => {
      assert.equal(error.code, "MODEL_NOT_ALLOWED");
      assert.match(error.message, /agnes-3\.0-flash/);
      return true;
    },
  );
  assert.equal(server.countRequests(), 0, "must fail before sending anything");
});

test("relevant request bodies/headers stay intact for routed calls", async (t) => {
  const server = await withServer(t, [AZ("a")]);
  const client = makeClient(server, [AZ("a")]);
  await client.text.complete({ prompt: "preserve me", model: "agnes-3.0-flash" });
  const request = server.lastRequest({ pathIncludes: "chat/completions" });
  assert.equal(request.headers.authorization, "Bearer sk-test-a");
  assert.deepEqual(request.body, {
    model: "agnes-3.0-flash",
    messages: [{ role: "user", content: "preserve me" }],
  });
});
