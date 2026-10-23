import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runBatch, retryBatch, batchStatus } from "../../dist/batch/runner.js";
import { AgnesCliError } from "../../dist/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-batch-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeInput(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readEvents(outDir) {
  const path = join(outDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function imageJob(id, prompt = id) {
  return { id, kind: "image", mode: "text2img", prompt };
}

/**
 * Offline fake client: behaves like the routed client without any HTTP.
 * Account selection mimics the router: forced route.accountId wins, otherwise
 * requests are distributed round-robin across `accounts`.
 */
function makeClient(config = {}) {
  const calls = [];
  const accounts = config.accounts ?? ["main", "backup"];
  let cursor = 0;
  let videoSeq = 0;
  const pickAccount = (options) =>
    options?.route?.accountId ?? accounts[cursor++ % accounts.length];
  const client = {
    text: {
      complete: async (options) => {
        calls.push({ method: "text", options });
        if (config.onText) return config.onText(options, calls);
        const accountId = pickAccount(options);
        return { ok: true, text: `text:${options.prompt}`, model: options.model, accountId, poolId: `pool-${accountId}` };
      },
    },
    image: {
      generate: async (options) => {
        calls.push({ method: "image", options });
        if (config.onImage) return config.onImage(options, calls);
        const accountId = pickAccount(options);
        return {
          ok: true,
          url: `https://cdn.example/${options.prompt.replace(/[^a-z0-9]/gi, "-")}.png`,
          model: options.model,
          accountId,
          poolId: `pool-${accountId}`,
        };
      },
    },
    video: {
      generate: async (options) => {
        calls.push({ method: "video.create", options });
        if (config.onVideoCreate) return config.onVideoCreate(options, calls);
        videoSeq += 1;
        const accountId = pickAccount(options);
        return {
          ok: true,
          taskId: `task_${videoSeq}`,
          videoId: `video_${videoSeq}`,
          status: "queued",
          model: options.model,
          accountId,
          poolId: `pool-${accountId}`,
        };
      },
      poll: async (id, options) => {
        calls.push({ method: "video.poll", id, options });
        if (config.onVideoPoll) return config.onVideoPoll(id, options, calls);
        const accountId = options?.route?.accountId ?? pickAccount(options);
        return {
          ok: true,
          taskId: `task_${id}`,
          videoId: id,
          status: "completed",
          videoUrl: `https://cdn.example/${id}.mp4`,
          model: options?.modelName,
          accountId,
          poolId: `pool-${accountId}`,
        };
      },
    },
  };
  if (config.router !== null) {
    client.router = config.router ?? {
      select: () => ({ id: accounts[0], poolId: `pool-${accounts[0]}` }),
      summary: () => ({
        strategy: "adaptive",
        accounts: accounts.map((id) => ({ id, poolId: `pool-${id}` })),
      }),
    };
  }
  return { client, calls };
}

function callsOf(calls, method) {
  return calls.filter((call) => call.method === method);
}

// ---------------------------------------------------------------------------
// Record mode / distribution / deterministic order
// ---------------------------------------------------------------------------

test("record mode distributes creates across two fake accounts and records provenance", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    version: 1,
    batchId: "dist-1",
    consistency: "record",
    jobs: [imageJob("a"), imageJob("b"), imageJob("c"), imageJob("d")],
  });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  const outcome = await runBatch({ inputPath: input, outDir: out, concurrency: 2, retryBackoffMs: 1 }, { client });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.ok, true);
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.batchId, "dist-1");
  assert.deepEqual(manifest.jobs.map((job) => job.id), ["a", "b", "c", "d"]);
  assert.deepEqual(manifest.jobs.map((job) => job.index), [0, 1, 2, 3]);
  assert.ok(manifest.jobs.every((job) => job.status === "succeeded"));
  assert.equal(callsOf(calls, "image").length, 4);
  assert.deepEqual(manifest.summary.accountsUsed, ["backup", "main"]);
  assert.equal(manifest.summary.mixedAccounts, true);
  assert.equal(manifest.summary.succeeded, 4);
  assert.deepEqual([...new Set(manifest.jobs.map((job) => job.accountId))].sort(), ["backup", "main"]);
  for (const job of manifest.jobs) {
    assert.equal(job.result.accountId, job.accountId);
    assert.equal(job.result.poolId, job.poolId);
    assert.ok(existsSync(join(out, "results", `${job.id}.json`)));
  }
});

test("video jobs poll on the create account in record mode (create->poll affinity)", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "video-affinity",
    jobs: [{ id: "clip", kind: "video", mode: "text2video", prompt: "clip", model: "agnes-video-2.5", seconds: 5 }],
  });
  const { client, calls } = makeClient({
    accounts: ["main", "backup"],
    onVideoCreate: () => ({
      ok: true,
      taskId: "task_v1",
      videoId: "video_v1",
      status: "queued",
      model: "agnes-video-2.5",
      accountId: "backup",
      poolId: "pool-backup",
    }),
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, pollIntervalMs: 1, retryBackoffMs: 1 },
    { client },
  );

  assert.equal(outcome.exitCode, 0);
  const creates = callsOf(calls, "video.create");
  const polls = callsOf(calls, "video.poll");
  assert.equal(creates.length, 1);
  assert.equal(polls.length, 1);
  assert.equal(polls[0].id, "video_v1");
  assert.equal(polls[0].options.route.accountId, "backup");
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].accountId, "backup");
  assert.equal(manifest.jobs[0].result.videoId, "video_v1");
  assert.match(manifest.jobs[0].result.videoUrl, /\.mp4$/);
});

test("bounded concurrency never exceeds --concurrency", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "bounded",
    jobs: Array.from({ length: 6 }, (_, index) => imageJob(`job-${index}`)),
  });
  let active = 0;
  let maxActive = 0;
  const { client } = makeClient({
    onImage: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
      active -= 1;
      return { ok: true, url: "https://cdn.example/x.png", accountId: "main", poolId: "pool-main" };
    },
  });
  const outcome = await runBatch(
    { inputPath: input, outDir: join(dir, "out"), concurrency: 2, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(outcome.exitCode, 0);
  assert.equal(maxActive, 2);
});

// ---------------------------------------------------------------------------
// Retry / ambiguity policy
// ---------------------------------------------------------------------------

test("RATE_LIMITED creates are retried and succeed on the next attempt", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "rate-limited",
    jobs: [imageJob("a")],
  });
  let attempt = 0;
  const { client, calls } = makeClient({
    onImage: () => {
      attempt += 1;
      if (attempt === 1) throw new AgnesCliError("RATE_LIMITED", "pool is cooling", undefined);
      return { ok: true, url: "https://cdn.example/a.png", accountId: "backup", poolId: "pool-backup" };
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, maxAttempts: 2, retryBackoffMs: 1 },
    { client },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(callsOf(calls, "image").length, 2);
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].status, "succeeded");
  assert.equal(manifest.jobs[0].attempts, 2);
  const events = readEvents(out);
  assert.ok(events.some((event) => event.type === "job_retry" && event.code === "RATE_LIMITED"));
  assert.ok(events.some((event) => event.type === "job_succeeded" && event.attempts === 2));
});

test("AMBIGUOUS_CREATE is never retried and fails the batch with exit code 1", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "ambiguous",
    jobs: [imageJob("a")],
  });
  const { client, calls } = makeClient({
    onImage: () => {
      throw new AgnesCliError("AMBIGUOUS_CREATE", "network timeout after create", undefined);
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, maxAttempts: 5, retryBackoffMs: 1 },
    { client },
  );

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.ok, false);
  assert.equal(callsOf(calls, "image").length, 1, "ambiguous create must not be re-sent");
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].status, "failed");
  assert.equal(manifest.jobs[0].attempts, 1);
  assert.equal(manifest.jobs[0].error.code, "AMBIGUOUS_CREATE");
  assert.equal(manifest.jobs[0].error.ambiguous, true);
  const events = readEvents(out);
  assert.equal(events.filter((event) => event.type === "job_retry").length, 0);
  assert.ok(events.some((event) => event.type === "job_failed" && event.ambiguous === true));
});

test("POST network errors are treated as ambiguous creates (no duplicate sends)", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "net", jobs: [imageJob("a")] });
  const { client, calls } = makeClient({
    onImage: () => {
      throw new AgnesCliError("NETWORK_ERROR", "socket hang up", { cause: "ECONNRESET" });
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, maxAttempts: 3, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(outcome.exitCode, 1);
  assert.equal(callsOf(calls, "image").length, 1);
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].error.code, "AMBIGUOUS_CREATE");
  assert.equal(manifest.jobs[0].error.ambiguous, true);
});

test("POLL failures retry the same video task without creating a duplicate", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "poll-retry",
    jobs: [{ id: "clip", kind: "video", mode: "text2video", prompt: "v", model: "agnes-video-2.5" }],
  });
  let polls = 0;
  const { client, calls } = makeClient({
    onVideoPoll: (id, options) => {
      polls += 1;
      if (polls < 3) {
        throw new AgnesCliError("SERVICE_BUSY", "video service busy", undefined);
      }
      return {
        ok: true,
        taskId: "task_1",
        videoId: id,
        status: "completed",
        videoUrl: "https://cdn.example/v.mp4",
        model: options?.modelName,
        accountId: options?.route?.accountId,
      };
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, maxAttempts: 3, pollIntervalMs: 1, retryBackoffMs: 1 },
    { client },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(callsOf(calls, "video.create").length, 1, "must not create a second video task");
  assert.equal(callsOf(calls, "video.poll").length, 3);
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].status, "succeeded");
  assert.equal(manifest.jobs[0].attempts, 3);
});

test("fail-fast stops scheduling after the first failure", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "fail-fast",
    jobs: [imageJob("a"), imageJob("b"), imageJob("c")],
  });
  const { client, calls } = makeClient({
    onImage: () => {
      throw new AgnesCliError("AMBIGUOUS_CREATE", "boom", undefined);
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, concurrency: 1, failFast: true, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(outcome.exitCode, 1);
  assert.equal(callsOf(calls, "image").length, 1);
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.summary.failed, 1);
  assert.equal(manifest.summary.pending, 2);
});

// ---------------------------------------------------------------------------
// Strict consistency
// ---------------------------------------------------------------------------

test("strict consistency pins every create and poll to one account with no failover", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    version: 1,
    batchId: "strict-1",
    consistency: "strict",
    jobs: [
      imageJob("img-1"),
      imageJob("img-2"),
      { id: "clip", kind: "video", mode: "text2video", prompt: "v", model: "agnes-video-2.5" },
    ],
  });
  const router = {
    select: (options) => {
      callsToRouter.push(options);
      return { id: "main", poolId: "pool-main" };
    },
    summary: () => ({
      strategy: "adaptive",
      accounts: [
        { id: "main", poolId: "pool-main" },
        { id: "backup", poolId: "pool-backup" },
      ],
    }),
  };
  const callsToRouter = [];
  let imageAttempt = 0;
  const { client, calls } = makeClient({
    router,
    onImage: (options) => {
      const accountId = options.route?.accountId;
      assert.equal(accountId, "main", "strict image create must be pinned to main");
      imageAttempt += 1;
      // A forced account may be rate limited once: it must wait/retry the SAME
      // account, never fail over to "backup".
      if (imageAttempt === 1) throw new AgnesCliError("RATE_LIMITED", "cooling", undefined);
      return { ok: true, url: "https://cdn.example/img.png", accountId, poolId: "pool-main" };
    },
    onVideoCreate: (options) => {
      assert.equal(options.route?.accountId, "main");
      return {
        ok: true,
        taskId: "task_9",
        videoId: "video_9",
        status: "queued",
        model: "agnes-video-2.5",
        accountId: "main",
        poolId: "pool-main",
      };
    },
    onVideoPoll: (id, options) => {
      assert.equal(options.route?.accountId, "main");
      return {
        ok: true,
        taskId: "task_9",
        videoId: id,
        status: "completed",
        videoUrl: "https://cdn.example/v.mp4",
        accountId: "main",
        poolId: "pool-main",
      };
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, maxAttempts: 2, pollIntervalMs: 1, retryBackoffMs: 1 },
    { client },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.ok, true);
  assert.equal(callsToRouter.length, 1, "strict mode selects exactly one account at batch start");
  for (const call of calls) {
    assert.equal(call.options.route?.accountId, "main");
  }
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.config.consistency, "strict");
  assert.equal(manifest.pinnedAccountId, "main");
  assert.deepEqual(manifest.summary.accountsUsed, ["main"]);
  assert.equal(manifest.summary.mixedAccounts, false);
  assert.ok(manifest.jobs.every((job) => job.status === "succeeded"));
});

test("strict consistency with --account validates the account against the router", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { jobs: [imageJob("a")] });
  const { client } = makeClient();
  await assert.rejects(
    () => runBatch({ inputPath: input, outDir: join(dir, "out"), account: "ghost" }, { client }),
    (error) => error.code === "INVALID_ARGUMENTS" && error.exitCode === 2,
  );
  const valid = await runBatch(
    { inputPath: input, outDir: join(dir, "out2"), account: "backup", retryBackoffMs: 1 },
    { client },
  );
  assert.equal(valid.exitCode, 0);
  const manifest = readJson(join(dir, "out2", "manifest.json"));
  assert.equal(manifest.config.consistency, "strict");
  assert.equal(manifest.pinnedAccountId, "backup");
  assert.deepEqual(manifest.summary.accountsUsed, ["backup"]);
});

// ---------------------------------------------------------------------------
// Artifacts / dry-run / status
// ---------------------------------------------------------------------------

test("dry-run validates the plan, sends no requests and writes nothing", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "dry",
    consistency: "strict",
    defaults: { model: "agnes-image-2.5-flash" },
    jobs: [imageJob("a"), imageJob("b")],
  });
  const { client, calls } = makeClient({
    onImage: () => {
      throw new Error("dry-run must not call the client");
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch({ inputPath: input, outDir: out, dryRun: true }, { client });
  assert.equal(outcome.exitCode, 0);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(out), false, "dry-run must not create the output directory");
  assert.equal(outcome.plan.batchId, "dry");
  assert.deepEqual(outcome.plan.jobs.map((job) => job.id), ["a", "b"]);
  assert.equal(outcome.plan.jobs[0].model, "agnes-image-2.5-flash");
  assert.match(outcome.plan.jobs[0].inputHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(outcome.plan.routePlan.consistency, "strict");
  assert.equal(outcome.plan.routePlan.pinnedAccountId, "main");
});

test("artifacts are secret-free and result raw transport bodies are stripped", async (t) => {
  const dir = tempDir(t);
  const fakeKey = "sk-test-SUPERSECRETKEY";
  const input = writeInput(dir, "jobs.json", { batchId: "secrets", jobs: [imageJob("a")] });
  const { client } = makeClient({
    onImage: () => ({
      ok: true,
      url: "https://cdn.example/a.png",
      accountId: "main",
      poolId: "pool-main",
      raw: { authorization: `Bearer ${fakeKey}`, apiKey: fakeKey },
      error: { message: `leaked ${fakeKey}` },
      routing: { strategy: "adaptive", attempts: 1 },
    }),
  });
  const out = join(dir, "out");
  const outcome = await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(outcome.exitCode, 0);

  const artifacts = [
    join(out, "manifest.json"),
    join(out, "input.json"),
    join(out, "events.jsonl"),
    join(out, "results", "a.json"),
  ];
  for (const path of artifacts) {
    const content = readFileSync(path, "utf8");
    assert.ok(!content.includes(fakeKey), `${path} must not contain the API key`);
    assert.ok(!/sk-[A-Za-z0-9_-]{4,}/.test(content), `${path} must not contain sk- key material`);
    assert.ok(!/Bearer\s+(?!\[REDACTED\])/i.test(content), `${path} must not contain bearer tokens`);
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} must be 0600`);
  }
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].result.raw, undefined);
  assert.ok(!("raw" in manifest.jobs[0].result));
});

test("batch status reports summary, per-job accounts and result URLs", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "status-1", jobs: [imageJob("ok")] });
  const { client } = makeClient({
    onImage: () => ({ ok: true, url: "https://cdn.example/ok.png", accountId: "main", poolId: "pool-main" }),
  });
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  const report = await batchStatus({ outDir: out });
  assert.equal(report.ok, true);
  assert.equal(report.batchId, "status-1");
  assert.equal(report.summary.succeeded, 1);
  assert.equal(report.jobs[0].accountId, "main");
  assert.equal(report.jobs[0].resultUrl, "https://cdn.example/ok.png");

  await assert.rejects(
    () => batchStatus({ outDir: join(dir, "missing") }),
    (error) => error.code === "BATCH_MANIFEST_MISSING" && error.exitCode === 2,
  );
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test("batch retry --only failed reruns failed jobs only and leaves succeeded jobs untouched", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "retry-1",
    jobs: [imageJob("ok"), imageJob("broken")],
  });
  let failBroken = true;
  const { client, calls } = makeClient({
    onImage: (options) => {
      if (options.prompt === "broken" && failBroken) {
        throw new AgnesCliError("AMBIGUOUS_CREATE", "network timeout", undefined);
      }
      return { ok: true, url: `https://cdn.example/${options.prompt}.png`, accountId: "main", poolId: "pool-main" };
    },
  });
  const out = join(dir, "out");
  const first = await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(first.exitCode, 1);
  assert.equal(callsOf(calls, "image").length, 2);

  failBroken = false;
  const second = await retryBatch({ outDir: out, only: "failed", retryBackoffMs: 1 }, { client });
  assert.equal(second.exitCode, 0);
  assert.equal(second.ok, true);
  assert.equal(callsOf(calls, "image").length, 3, "only the failed job is re-sent");
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.jobs[0].status, "succeeded");
  assert.equal(manifest.jobs[0].attempts, 1);
  assert.equal(manifest.jobs[1].status, "succeeded");
  assert.equal(manifest.jobs[1].attempts, 2);

  await assert.rejects(
    () => retryBatch({ outDir: out, only: "bogus" }, { client }),
    (error) => error.code === "INVALID_ARGUMENTS" && error.exitCode === 2,
  );
});

test("batch retry refuses to run when the stored input was tampered with", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "retry-tamper", jobs: [imageJob("a")] });
  const { client } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });

  const normalized = readJson(join(out, "input.json"));
  normalized.jobs[0].prompt = "changed!";
  writeFileSync(join(out, "input.json"), JSON.stringify(normalized, null, 2));
  await assert.rejects(
    () => retryBatch({ outDir: out, only: "all" }, { client }),
    (error) => error.code === "BATCH_INPUT_CHANGED" && error.exitCode === 2,
  );
});

test("batch retry --only pending|all respects the selection", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "retry-only", jobs: [imageJob("ok"), imageJob("bad")] });
  let failBad = true;
  const { client, calls } = makeClient({
    onImage: (options) => {
      if (options.prompt === "bad" && failBad) {
        throw new AgnesCliError("AMBIGUOUS_CREATE", "timeout", undefined);
      }
      return { ok: true, url: `https://cdn.example/${options.prompt}.png`, accountId: "main", poolId: "pool-main" };
    },
  });
  const out = join(dir, "out");
  assert.equal((await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client })).exitCode, 1);
  assert.equal(callsOf(calls, "image").length, 2);

  // --only pending: nothing is pending, so no request is made and the batch still has a failure.
  const pendingOnly = await retryBatch({ outDir: out, only: "pending" }, { client });
  assert.equal(callsOf(calls, "image").length, 2);
  assert.equal(pendingOnly.exitCode, 1);

  // --only all: reruns the failed job (succeeded jobs are never re-run).
  failBad = false;
  const all = await retryBatch({ outDir: out, only: "all", retryBackoffMs: 1 }, { client });
  assert.equal(all.exitCode, 0);
  assert.equal(callsOf(calls, "image").length, 3);
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.summary.succeeded, 2);
});

test("batch status rejects an invalid manifest with exit code 2", async (t) => {
  const dir = tempDir(t);
  const out = join(dir, "out");
  writeFileSync(join(dir, "placeholder"), "");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ schema: "not-agnes", jobs: [] }));
  await assert.rejects(
    () => batchStatus({ outDir: out }),
    (error) => error.code === "BATCH_MANIFEST_INVALID" && error.exitCode === 2,
  );
});

test("batch retry keeps strict consistency pins from the manifest", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "strict-retry",
    consistency: "strict",
    jobs: [imageJob("ok"), imageJob("bad")],
  });
  let failBad = true;
  const seenRoutes = [];
  const { client } = makeClient({
    router: {
      select: () => ({ id: "main", poolId: "pool-main" }),
      summary: () => ({ strategy: "adaptive", accounts: [{ id: "main", poolId: "pool-main" }, { id: "backup", poolId: "pool-backup" }] }),
    },
    onImage: (options) => {
      seenRoutes.push(options.route?.accountId);
      if (options.prompt === "bad" && failBad) {
        throw new AgnesCliError("AMBIGUOUS_CREATE", "timeout", undefined);
      }
      return { ok: true, url: "https://cdn.example/x.png", accountId: options.route?.accountId, poolId: "pool-main" };
    },
  });
  const out = join(dir, "out");
  assert.equal((await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client })).exitCode, 1);
  assert.deepEqual(seenRoutes, ["main", "main"]);
  failBad = false;
  const retried = await retryBatch({ outDir: out, only: "failed", retryBackoffMs: 1 }, { client });
  assert.equal(retried.exitCode, 0);
  assert.equal(seenRoutes[2], "main", "retry must stay on the pinned account");
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.pinnedAccountId, "main");
  assert.deepEqual(manifest.summary.accountsUsed, ["main"]);
});

test("mixed-kind batch uses per-kind models and records model/modelSource provenance", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "mixed-models",
    defaults: { model: "agnes-image-2.5-flash", size: "1K", ratio: "1:1" },
    jobs: [
      imageJob("img-1"),
      imageJob("img-2"),
      { id: "vid-1", kind: "video", mode: "text2video", prompt: "clip", seconds: 5 },
      { id: "txt-1", kind: "text", mode: "chat", prompt: "pong" },
    ],
  });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, concurrency: 2, pollIntervalMs: 1, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(outcome.exitCode, 0, "mixed-kind batch with a flat image model default must succeed");
  const manifest = readJson(join(out, "manifest.json"));
  const byId = Object.fromEntries(manifest.jobs.map((job) => [job.id, job]));
  assert.equal(byId["img-1"].model, "agnes-image-2.5-flash");
  assert.equal(byId["img-1"].modelSource, "defaults");
  assert.equal(byId["img-2"].modelSource, "defaults");
  assert.equal(byId["vid-1"].model, "agnes-video-2.5");
  assert.equal(byId["vid-1"].modelSource, "kind-default");
  assert.equal(byId["txt-1"].model, "agnes-2.5-flash");
  assert.equal(byId["txt-1"].modelSource, "kind-default");

  assert.deepEqual(
    callsOf(calls, "image").map((call) => call.options.model),
    ["agnes-image-2.5-flash", "agnes-image-2.5-flash"],
  );
  assert.equal(callsOf(calls, "video.create")[0].options.model, "agnes-video-2.5");
  assert.equal(callsOf(calls, "text")[0].options.model, "agnes-2.5-flash");
  assert.equal(callsOf(calls, "video.poll")[0].options.modelName, "agnes-video-2.5");
});

test("per-job zod validation errors map to non-retryable INVALID_JOB with the job id", async (t) => {
  const dir = tempDir(t);
  const modelSchema = z.enum(["agnes-image-2.5-flash"]);
  const input = writeInput(dir, "jobs.json", { batchId: "invalid-job", jobs: [imageJob("bad"), imageJob("ok")] });
  const { client, calls } = makeClient({
    onImage: (options) => {
      if (options.prompt === "bad") {
        modelSchema.parse({ model: "agnes-video-2.5" }); // throws a ZodError like the real client
      }
      return { ok: true, url: "https://cdn.example/x.png", accountId: "main", poolId: "pool-main" };
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, maxAttempts: 3, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(outcome.exitCode, 1);
  assert.equal(callsOf(calls, "image").length, 2, "validation failures must not be retried");
  const manifest = readJson(join(out, "manifest.json"));
  const failed = manifest.jobs.find((job) => job.id === "bad");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "INVALID_JOB");
  assert.equal(failed.error.retryable, false);
  assert.equal(failed.attempts, 1);
  assert.match(failed.error.message, /job "bad"/);
  assert.match(failed.error.message, /invalid request options/);
  assert.equal(manifest.jobs.find((job) => job.id === "ok").status, "succeeded");
  assert.equal(readEvents(out).filter((event) => event.type === "job_retry").length, 0);
});

test("per-job INVALID_* client errors map to INVALID_JOB and unexpected errors stay UNEXPECTED_ERROR", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "invalid-taxonomy",
    jobs: [imageJob("bad-size"), imageJob("boom")],
  });
  const { client } = makeClient({
    onImage: (options) => {
      if (options.prompt === "bad-size") {
        throw new AgnesCliError("INVALID_IMAGE_SIZE", 'Unsupported image size "banana".', undefined);
      }
      throw new Error("kaboom");
    },
  });
  const out = join(dir, "out");
  const outcome = await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(outcome.exitCode, 1);
  const manifest = readJson(join(out, "manifest.json"));
  const badSize = manifest.jobs.find((job) => job.id === "bad-size");
  assert.equal(badSize.error.code, "INVALID_JOB");
  assert.equal(badSize.error.retryable, false);
  assert.equal(badSize.error.details.originalCode, "INVALID_IMAGE_SIZE");
  assert.match(badSize.error.message, /job "bad-size"/);
  const boom = manifest.jobs.find((job) => job.id === "boom");
  assert.equal(boom.error.code, "UNEXPECTED_ERROR", "non-validation errors keep the existing taxonomy");
  assert.equal(boom.error.retryable, false);
});

test("normalized input.json keeps the validated defaultsByKind section (provenance)", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "normalized-bykind",
    defaults: { model: "agnes-image-2.5-flash", size: "1K" },
    defaultsByKind: {
      video: { model: "agnes-video-2.5-flash", seconds: 6, size: "720P" },
      text: { model: "agnes-3.0-flash" },
    },
    jobs: [
      imageJob("img"),
      { id: "vid", kind: "video", mode: "text2video", prompt: "clip" },
      { id: "txt", kind: "text", mode: "chat", prompt: "pong" },
    ],
  });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  const outcome = await runBatch(
    { inputPath: input, outDir: out, pollIntervalMs: 1, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(outcome.exitCode, 0);
  const stored = readJson(join(out, "input.json"));
  assert.equal(stored.schema, "agnes-batch-input/1");
  assert.deepEqual(stored.defaultsByKind, {
    video: { model: "agnes-video-2.5-flash", seconds: 6, size: "720P" },
    text: { model: "agnes-3.0-flash" },
  });
  const manifest = readJson(join(out, "manifest.json"));
  assert.deepEqual(manifest.config.defaultsByKind, stored.defaultsByKind);
  assert.deepEqual(
    stored.jobs.map((job) => [job.id, job.model, job.modelSource]),
    [
      ["img", "agnes-image-2.5-flash", "defaults"],
      ["vid", "agnes-video-2.5-flash", "defaults"],
      ["txt", "agnes-3.0-flash", "defaults"],
    ],
  );

  // Persisting the provenance section must not alter resume digests/hashes.
  const callsBeforeResume = calls.length;
  const resumed = await runBatch(
    { inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(resumed.exitCode, 0);
  assert.equal(calls.length, callsBeforeResume, "resume after persisting defaultsByKind must not re-create jobs");

  // A batch without a defaultsByKind section omits the field (backward compatible).
  const plainInput = writeInput(dir, "plain.json", { batchId: "normalized-plain", jobs: [imageJob("only")] });
  const plainOut = join(dir, "out-plain");
  assert.equal((await runBatch({ inputPath: plainInput, outDir: plainOut, retryBackoffMs: 1 }, { client })).exitCode, 0);
  assert.equal("defaultsByKind" in readJson(join(plainOut, "input.json")), false);
});

test("batch retry still works with an old-shaped input.json without defaultsByKind", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "old-shaped-input",
    defaultsByKind: { image: { model: "agnes-image-2.1-flash" } },
    jobs: [imageJob("ok"), imageJob("bad")],
  });
  let failBad = true;
  const { client } = makeClient({
    onImage: (options) => {
      if (options.prompt === "bad" && failBad) {
        throw new AgnesCliError("AMBIGUOUS_CREATE", "timeout", undefined);
      }
      return { ok: true, url: "https://cdn.example/x.png", accountId: "main", poolId: "pool-main" };
    },
  });
  const out = join(dir, "out");
  assert.equal((await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client })).exitCode, 1);

  // Simulate an input.json produced before defaultsByKind persistence existed.
  const stored = readJson(join(out, "input.json"));
  delete stored.defaultsByKind;
  writeFileSync(join(out, "input.json"), JSON.stringify(stored, null, 2));

  failBad = false;
  const retried = await retryBatch({ outDir: out, only: "failed", retryBackoffMs: 1 }, { client });
  assert.equal(retried.exitCode, 0);
  const manifest = readJson(join(out, "manifest.json"));
  const bad = manifest.jobs.find((job) => job.id === "bad");
  assert.equal(bad.status, "succeeded");
  assert.equal(bad.model, "agnes-image-2.1-flash", "effective model still comes from the stored job copy");
  assert.equal("defaultsByKind" in readJson(join(out, "input.json")), false);
});
