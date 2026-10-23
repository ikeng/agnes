import test from "node:test";
import assert from "node:assert/strict";

import { loadAccountsConfig } from "../../dist/accounts/config.js";
import { AccountRouter } from "../../dist/accounts/router.js";
import { isRetryableStatus, parseRetryAfterMs } from "../../dist/http/requestJson.js";

/**
 * AC4: documented rate-limit presets, token buckets, Retry-After handling,
 * adaptive status pacing, bounded waits and concurrency caps.
 *
 * The router clock/sleep are injectable so pacing assertions are instant and
 * deterministic (no real 60 s video-bucket waits in the test suite).
 */

function account(id, extra = {}) {
  return {
    id,
    key: `sk-test-${id}`,
    keySource: "options",
    type: "free",
    poolId: id,
    weight: 1,
    priority: 0,
    ...extra,
  };
}

function makeRouter(accounts, options = {}) {
  const config = loadAccountsConfig({}, {
    accounts,
    rateLimit: options.rateLimit ?? true,
    ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
  let now = 1_000_000;
  const sleeps = [];
  const clock = options.realClock
    ? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
    : {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      };
  const router = new AccountRouter(
    config,
    { fetchImpl: async () => new Response("{}"), env: {} },
    {
      ...clock,
      random: () => 0,
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    },
  );
  return {
    router,
    config,
    sleeps,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

const jsonResponse = (status, body = {}, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const okSend = (body = { ok: true }) => async () => ({ response: jsonResponse(200, body), raw: body });

/* --------------------------- Retry-After parsing --------------------------- */

test("parseRetryAfterMs supports delay-seconds and HTTP-date forms", () => {
  assert.equal(parseRetryAfterMs(jsonResponse(429, {}, { "retry-after": "2" })), 2000);
  assert.equal(parseRetryAfterMs(jsonResponse(429, {}, { "retry-after": "0" })), 0);
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsedDate = parseRetryAfterMs(jsonResponse(429, {}, { "retry-after": future }));
  assert.ok(parsedDate !== undefined && parsedDate > 3000 && parsedDate <= 5000);
  assert.equal(parseRetryAfterMs(jsonResponse(429)), undefined);
  assert.equal(parseRetryAfterMs(jsonResponse(429, {}, { "retry-after": "not-a-date" })), undefined);
});

test("isRetryableStatus classifies transient statuses", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true);
  for (const status of [400, 401, 402, 403, 404, 422]) assert.equal(isRetryableStatus(status), false);
});

/* ------------------------------ token buckets ------------------------------ */

test("free text bucket allows 10 immediate sends and rejects the 11th within budget", async () => {
  const { router } = makeRouter([account("a")]);
  const send = okSend();
  for (let index = 0; index < 10; index += 1) {
    const result = await router.execute({ workload: "text", method: "POST", accountId: "a", maxWaitMs: 1000 }, send);
    assert.equal(result.attempts, 1);
  }
  await assert.rejects(
    () => router.execute({ workload: "text", method: "POST", accountId: "a", maxWaitMs: 50 }, send),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.ok(error.details.retryAfterMs >= 5000, `retryAfterMs=${error.details.retryAfterMs}`);
      return true;
    },
  );
});

test("image RPM bucket follows the size tier (2K free = 5, 1K free = 10)", async () => {
  const { router } = makeRouter([account("a")]);
  const send = okSend();
  for (let index = 0; index < 5; index += 1) {
    await router.execute({ workload: "image", method: "POST", accountId: "a", model: "agnes-image-2.5-flash", size: "2K" }, send);
  }
  await assert.rejects(
    () => router.execute({ workload: "image", method: "POST", accountId: "a", size: "2K", maxWaitMs: 50 }, send),
    (error) => error.code === "RATE_LIMITED" && error.details.retryAfterMs >= 10_000,
  );
  // 1K has its own bucket and is still available.
  await router.execute({ workload: "image", method: "POST", accountId: "a", size: "1024x1024" }, send);
  await router.execute({ workload: "image", method: "POST", accountId: "a", size: "1K" }, send);
});

test("free video create bucket is 1 RPM", async () => {
  const { router } = makeRouter([account("a")]);
  const send = okSend();
  await router.execute({ workload: "video", method: "POST", accountId: "a", model: "agnes-video-2.5" }, send);
  await assert.rejects(
    () => router.execute({ workload: "video", method: "POST", accountId: "a", maxWaitMs: 50 }, send),
    (error) => error.code === "RATE_LIMITED" && error.details.retryAfterMs >= 59_000,
  );
});

test("AGNES_RATE_LIMIT=off bypasses token buckets", async () => {
  const { router } = makeRouter([account("a")], { rateLimit: false });
  const send = okSend();
  for (let index = 0; index < 15; index += 1) {
    await router.execute({ workload: "text", method: "POST", accountId: "a", maxWaitMs: 10 }, send);
  }
});

/* --------------------------- 429 + Retry-After ----------------------------- */

test("create 429 honors Retry-After on the forced account and retries it", async () => {
  const { router, sleeps } = makeRouter([account("a")]);
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1
      ? { response: jsonResponse(429, { error: "rate limited" }, { "retry-after": "2" }), raw: { error: "rate limited" } }
      : { response: jsonResponse(200, { ok: true }), raw: { ok: true } };
  };
  const result = await router.execute(
    { workload: "text", method: "POST", accountId: "a", maxAttempts: 2, maxWaitMs: 60_000 },
    send,
  );
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.waitedMs, 2000, "Retry-After: 2 must become a 2000 ms cooldown wait");
  assert.ok(sleeps.includes(2000));
});

test("maxWaitMs bounds the cooldown wait and fails with the underlying code", async () => {
  const { router, sleeps } = makeRouter([account("a")]);
  const send = async () => ({
    response: jsonResponse(429, { error: "rate limited" }, { "retry-after": "5" }),
    raw: { error: "rate limited" },
  });
  await assert.rejects(
    () => router.execute({ workload: "text", method: "POST", accountId: "a", maxAttempts: 2, maxWaitMs: 100 }, send),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.details.retryAfterMs, 5000);
      assert.ok(error.details.accountsTried.includes("a"));
      return true;
    },
  );
  assert.deepEqual(sleeps, [], "must not sleep beyond the wait budget");
});

test("exponential 429 cooldown is used when Retry-After is absent", async () => {
  const { router } = makeRouter([account("a")]);
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1
      ? { response: jsonResponse(429, { error: "rate limited" }), raw: { error: "rate limited" } }
      : { response: jsonResponse(200, {}), raw: {} };
  };
  const result = await router.execute(
    { workload: "text", method: "POST", accountId: "a", maxAttempts: 2, maxWaitMs: 60_000 },
    send,
  );
  assert.equal(result.attempts, 2);
  // First streak cooldown = 1000 ms + jitter(0 in tests).
  assert.equal(result.waitedMs, 1000);
});

/* ------------------------------ status pacing ------------------------------ */

test("status requests are paced with the adaptive 2 s gap", async () => {
  const { router } = makeRouter([account("a")], { pollIntervalMs: 2000 });
  const send = okSend({ status: "in_progress" });
  const first = await router.execute({ workload: "status", method: "GET", accountId: "a" }, send);
  assert.equal(first.waitedMs, 0);
  const second = await router.execute({ workload: "status", method: "GET", accountId: "a" }, send);
  assert.equal(second.waitedMs, 2000);
});

test("status pacer doubles the gap on 429 and recovers after 20 successes", async () => {
  const { router } = makeRouter([account("a")], { pollIntervalMs: 2000 });
  let calls = 0;
  const send = async () => {
    calls += 1;
    if (calls === 1) {
      return { response: jsonResponse(429, { error: "poll limited" }), raw: { error: "poll limited" } };
    }
    return { response: jsonResponse(200, { status: "in_progress" }), raw: { status: "in_progress" } };
  };
  // First status 429s (no Retry-After); forced account waits the 1 s cooldown,
  // then retries. The pacer gap doubles to 4 s for the following request.
  const first = await router.execute(
    { workload: "status", method: "GET", accountId: "a", maxAttempts: 2, maxWaitMs: 60_000 },
    send,
  );
  assert.equal(first.attempts, 2);
  assert.ok(first.waitedMs >= 1000);

  const nextSend = okSend({ status: "in_progress" });
  const second = await router.execute({ workload: "status", method: "GET", accountId: "a" }, nextSend);
  assert.ok(second.waitedMs >= 4000, `expected post-429 gap >= 4000, got ${second.waitedMs}`);
});

test("status pacer keeps at most one in-flight status request per pool", async () => {
  const { router } = makeRouter([account("a")], { pollIntervalMs: 1000, realClock: true });
  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const send = async () => {
    started += 1;
    await gate;
    return { response: jsonResponse(200, { status: "in_progress" }), raw: { status: "in_progress" } };
  };
  const executions = [1, 2, 3].map(() => router.execute({ workload: "status", method: "GET", accountId: "a" }, send));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(started, 1, "only one status request per pool may be in flight");
  release();
  const results = await Promise.all(executions);
  assert.equal(started, 3);
  assert.ok(results.every((result) => result.accountId === "a"));
});

test("status 429 never rotates accounts", async () => {
  const { router } = makeRouter([account("a"), account("b")]);
  const sends = [];
  let calls = 0;
  const send = async () => {
    calls += 1;
    sends.push("a");
    return calls === 1
      ? { response: jsonResponse(429, { error: "limited" }, { "retry-after": "0" }), raw: { error: "limited" } }
      : { response: jsonResponse(200, { status: "in_progress" }), raw: { status: "in_progress" } };
  };
  const result = await router.execute(
    { workload: "status", method: "GET", accountId: "a", maxAttempts: 2, maxWaitMs: 60_000 },
    send,
  );
  assert.equal(result.accountId, "a");
  assert.deepEqual(sends, ["a", "a"]);
});

/* ------------------------ concurrency + account caps ----------------------- */

test("account concurrency caps concurrent sends (free text = 2)", async () => {
  const { router } = makeRouter([account("a")], { realClock: true });
  let inflight = 0;
  let peak = 0;
  let completed = 0;
  const send = async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inflight -= 1;
    completed += 1;
    return { response: jsonResponse(200, {}), raw: {} };
  };
  const results = await Promise.all(
    [0, 1, 2, 3].map((index) =>
      router.execute({ workload: "text", method: "POST", accountId: "a" }, send).then(() => index),
    ),
  );
  assert.equal(results.length, 4);
  assert.equal(completed, 4);
  assert.ok(peak <= 2, `peak concurrency ${peak} must respect the free text cap of 2`);
});

test("account concurrency override is honored", async () => {
  const { router } = makeRouter([account("a", { concurrency: 1 })], { realClock: true });
  let inflight = 0;
  let peak = 0;
  const send = async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inflight -= 1;
    return { response: jsonResponse(200, {}), raw: {} };
  };
  await Promise.all(
    [0, 1, 2].map(() => router.execute({ workload: "text", method: "POST", accountId: "a" }, send)),
  );
  assert.equal(peak, 1);
});

test("enterprise presets allow higher text concurrency than free", () => {
  const config = loadAccountsConfig({}, {
    accounts: [
      { id: "free", key: "sk-free", keySource: "options", type: "free", poolId: "f", weight: 1, priority: 0 },
      { id: "ent", key: "sk-ent", keySource: "options", type: "enterprise", poolId: "e", weight: 1, priority: 0 },
      { id: "tp", key: "sk-tp", keySource: "options", type: "tokenplan", poolId: "t", weight: 1, priority: 0 },
    ],
    rateLimit: true,
  });
  const router = new AccountRouter(config, { fetchImpl: async () => new Response("{}"), env: {} }, {});
  const summary = router.summary();
  const byId = Object.fromEntries(summary.accounts.map((entry) => [entry.id, entry.concurrency]));
  assert.equal(byId.free, 2);
  assert.equal(byId.ent, 4);
  assert.equal(byId.tp, 8);
});
