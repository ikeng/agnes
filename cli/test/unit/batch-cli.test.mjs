import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAgnesServer } from "../helpers/fake-agnes-server.mjs";

// End-to-end tests: real built CLI + fake Agnes API server. Offline.
const CLI_BIN = fileURLToPath(new URL("../../bin/agnes.js", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-batch-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function accountEnv(server, accounts, extra = {}) {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    AGNES_NO_DOTENV: "1",
    AGNES_RATE_LIMIT: "off",
    AGNES_ACCOUNTS: accounts.map((account) => account.id).join(","),
    ...extra,
  };
  for (const account of accounts) {
    const prefix = `AGNES_ACCOUNT_${account.id.toUpperCase()}`;
    env[`${prefix}_KEY`] = account.key;
    env[`${prefix}_BASE_URL`] = server.baseUrl;
    env[`${prefix}_TYPE`] = "free";
    env[`${prefix}_POOL`] = `pool-${account.id}`;
  }
  return env;
}

/**
 * Run the built CLI asynchronously. The fake server lives in this process, so
 * spawnSync would deadlock (no event loop ticks to answer the child's HTTP).
 */
function runCli(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Print JSON is the last stdout block; tolerate any human warnings before it. */
function lastJsonOutput(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    assert.ok(start >= 0, `no JSON object found in stdout:\n${text}`);
    return JSON.parse(trimmed.slice(start + 1));
  }
}

function imageJobs(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `img-${String(index + 1).padStart(3, "0")}`,
    kind: "image",
    mode: "text2img",
    prompt: `prompt ${index}`,
    ...extra,
  }));
}

function assertNoSecrets(paths, secrets) {
  for (const path of paths) {
    const content = readFileSync(path, "utf8");
    for (const secret of secrets) {
      assert.ok(!content.includes(secret), `${path} must not contain a real/fake API key`);
    }
    assert.ok(!/sk-[A-Za-z0-9_-]{4,}/.test(content), `${path} must not contain sk- key material`);
  }
}

test("real CLI: record batch distributes across two accounts with deterministic manifest order", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [
      { key: "sk-test-a", id: "a", models: ["agnes-image-2.5-flash"] },
      { key: "sk-test-b", id: "b", models: ["agnes-image-2.5-flash"] },
    ],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({
    version: 1,
    batchId: "cli-dist",
    consistency: "record",
    defaults: { model: "agnes-image-2.5-flash", size: "1K" },
    jobs: imageJobs(4),
  }));
  const out = join(dir, "out");
  const result = await runCli(["batch", "run", input, "--out", out, "--concurrency", "2", "--json"], {
    cwd: dir,
    env: accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
      AGNES_ROUTING_STRATEGY: "round-robin",
      AGNES_STATE_DIR: join(dir, "state"),
    }),
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.succeeded, 4);
  assert.deepEqual(payload.summary.accountsUsed, ["a", "b"]);
  assert.equal(payload.summary.mixedAccounts, true);

  const creates = server.requests.filter(
    (request) => request.method === "POST" && request.pathname.endsWith("/images/generations"),
  );
  assert.equal(creates.length, 4);
  assert.deepEqual([...new Set(creates.map((request) => request.accountId))].sort(), ["a", "b"]);

  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.jobs.map((job) => job.id), ["img-001", "img-002", "img-003", "img-004"]);
  assert.deepEqual(manifest.jobs.map((job) => job.index), [0, 1, 2, 3]);
  assert.ok(manifest.jobs.every((job) => job.status === "succeeded"));
  assert.ok(manifest.jobs.every((job) => ["a", "b"].includes(job.accountId)));
  for (const path of [join(out, "manifest.json"), join(out, "input.json"), join(out, "events.jsonl")]) {
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} must be 0600`);
  }
  assertNoSecrets(
    [
      join(out, "manifest.json"),
      join(out, "input.json"),
      join(out, "events.jsonl"),
      join(out, "results", "img-001.json"),
    ],
    ["sk-test-a", "sk-test-b"],
  );
});

test("real CLI: strict consistency pins creates and video polls to one account", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [
      { key: "sk-test-a", id: "a" },
      { key: "sk-test-b", id: "b" },
    ],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({
    batchId: "cli-strict",
    consistency: "strict",
    jobs: [
      ...imageJobs(2, { model: "agnes-image-2.5-flash" }),
      { id: "clip-001", kind: "video", mode: "text2video", prompt: "clip", model: "agnes-video-2.5", seconds: 5 },
    ],
  }));
  const out = join(dir, "out");
  const result = await runCli(["batch", "run", input, "--out", out, "--concurrency", "1", "--json"], {
    cwd: dir,
    env: accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
      AGNES_ROUTING_STRATEGY: "round-robin",
      AGNES_STATE_DIR: join(dir, "state"),
    }),
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.succeeded, 3);
  assert.equal(payload.summary.accountsUsed.length, 1);

  const imageCreates = server.requests.filter(
    (request) => request.method === "POST" && request.pathname.endsWith("/images/generations"),
  );
  const videoCreates = server.requests.filter(
    (request) => request.method === "POST" && request.pathname.endsWith("/videos"),
  );
  const videoPolls = server.requests.filter(
    (request) => request.method === "GET" && request.pathname.endsWith("/agnesapi"),
  );
  assert.equal(imageCreates.length, 2);
  assert.equal(videoCreates.length, 1);
  assert.ok(videoPolls.length >= 1);
  const usedAccounts = [...new Set([
    ...imageCreates.map((request) => request.accountId),
    ...videoCreates.map((request) => request.accountId),
    ...videoPolls.map((request) => request.accountId),
  ])];
  assert.equal(usedAccounts.length, 1, `strict batch used ${usedAccounts.join(", ")}`);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.pinnedAccountId, usedAccounts[0]);
  assert.deepEqual(manifest.summary.accountsUsed, [usedAccounts[0]]);
  assert.equal(manifest.jobs[2].accountId, usedAccounts[0]);
  assert.match(manifest.jobs[2].result.videoUrl, /mp4/);
});

test("real CLI: 429 on one account fails over and the batch still succeeds", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [
      { key: "sk-test-a", id: "a" },
      { key: "sk-test-b", id: "b" },
    ],
  });
  t.after(() => server.close());
  server.setRateLimit("sk-test-a", { times: 1, appliesTo: "create", retryAfter: 0.01 });
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({ batchId: "cli-429", jobs: imageJobs(2) }));
  const out = join(dir, "out");
  const result = await runCli(["batch", "run", input, "--out", out, "--concurrency", "1", "--json"], {
    cwd: dir,
    env: accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
      AGNES_ROUTING_STRATEGY: "round-robin",
      AGNES_STATE_DIR: join(dir, "state"),
      AGNES_ROUTING_MAX_ATTEMPTS: "3",
    }),
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.summary.succeeded, 2);
  const creates = server.requests.filter(
    (request) => request.method === "POST" && request.pathname.endsWith("/images/generations"),
  );
  assert.equal(creates.length, 3, "one rejected 429 + two successful creates");
  assert.ok(creates.some((request) => request.accountId === "a"));
  assert.ok(creates.some((request) => request.accountId === "b"));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.summary.failed, 0);
});

test("real CLI: resume skips succeeded jobs without duplicate creates", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({ batchId: "cli-resume", jobs: imageJobs(2) }));
  const out = join(dir, "out");
  const env = accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
    AGNES_STATE_DIR: join(dir, "state"),
  });
  const first = await runCli(["batch", "run", input, "--out", out, "--json"], { cwd: dir, env });
  assert.equal(first.code, 0, first.stderr);
  const countCreates = () =>
    server.requests.filter(
      (request) => request.method === "POST" && request.pathname.endsWith("/images/generations"),
    ).length;
  assert.equal(countCreates(), 2);

  const resumed = await runCli(["batch", "run", input, "--out", out, "--resume", "--json"], { cwd: dir, env });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(countCreates(), 2, "resume must not create new tasks for succeeded jobs");
  assert.equal(lastJsonOutput(resumed.stdout).summary.succeeded, 2);

  writeFileSync(input, JSON.stringify({ batchId: "cli-resume", jobs: imageJobs(3) }));
  const resumedAppend = await runCli(["batch", "run", input, "--out", out, "--resume", "--json"], { cwd: dir, env });
  assert.equal(resumedAppend.code, 0, resumedAppend.stderr);
  assert.equal(countCreates(), 3, "only the appended job is created");
  assert.equal(lastJsonOutput(resumedAppend.stdout).summary.succeeded, 3);
});

test("real CLI: resume aborts with exit code 2 when a succeeded job's input changed", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({ batchId: "cli-changed", jobs: imageJobs(2) }));
  const out = join(dir, "out");
  const env = accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
    AGNES_STATE_DIR: join(dir, "state"),
  });
  assert.equal((await runCli(["batch", "run", input, "--out", out, "--json"], { cwd: dir, env })).code, 0);
  const createsBefore = server.requests.filter((request) => request.method === "POST").length;

  const changed = { batchId: "cli-changed", jobs: imageJobs(2) };
  changed.jobs[0].prompt = "a different prompt";
  writeFileSync(input, JSON.stringify(changed));
  const failedResume = await runCli(
    ["batch", "run", input, "--out", out, "--resume", "--json"],
    { cwd: dir, env },
  );
  assert.equal(failedResume.code, 2);
  const payload = lastJsonOutput(failedResume.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "BATCH_INPUT_CHANGED");
  assert.equal(server.requests.filter((request) => request.method === "POST").length, createsBefore);
});

test("real CLI: --dry-run writes nothing and sends no requests", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({ batchId: "cli-dry", jobs: imageJobs(2) }));
  const out = join(dir, "out");
  const result = await runCli(["batch", "run", input, "--out", out, "--dry-run", "--json"], {
    cwd: dir,
    env: accountEnv(server, [{ key: "sk-test-a", id: "a" }], {
      AGNES_STATE_DIR: join(dir, "state"),
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  const plan = lastJsonOutput(result.stdout);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.jobs.map((job) => job.id), ["img-001", "img-002"]);
  assert.equal(existsSync(out), false, "--dry-run must not create artifacts");
  assert.equal(server.requests.length, 0, "--dry-run must not send requests");
});

test("real CLI: exit codes 1 (failed job) and 2 (invalid input)", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [{ key: "sk-test-a", id: "a" }], {
    AGNES_STATE_DIR: join(dir, "state"),
  });

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ this is not json");
  const invalid = await runCli(["batch", "run", broken, "--out", join(dir, "out-invalid"), "--json"], {
    cwd: dir,
    env,
  });
  assert.equal(invalid.code, 2);
  assert.equal(lastJsonOutput(invalid.stdout).code, "INVALID_BATCH_INPUT");

  server.setForcedStatus("sk-test-a", 500);
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({ batchId: "cli-fail", jobs: imageJobs(1) }));
  const failed = await runCli(["batch", "run", input, "--out", join(dir, "out-fail"), "--json"], {
    cwd: dir,
    env,
  });
  assert.equal(failed.code, 1, `expected exit 1, stderr:\n${failed.stderr}`);
  const payload = lastJsonOutput(failed.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.summary.failed, 1);
  assert.equal(payload.failedJobs[0].code, "AMBIGUOUS_CREATE");
  assert.equal(payload.failedJobs[0].ambiguous, true);
  const manifest = JSON.parse(readFileSync(join(dir, "out-fail", "manifest.json"), "utf8"));
  assert.equal(manifest.jobs[0].status, "failed");
});

test("real CLI: batch status and batch retry --only failed", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [
      { key: "sk-test-a", id: "a" },
      { key: "sk-test-b", id: "b" },
    ],
  });
  t.after(() => server.close());
  // Both accounts reject creates with 500 => every job fails deterministically
  // (ambiguous create, no automatic retry), which keeps this test offline and stable.
  server.setForcedStatus("sk-test-a", 500);
  server.setForcedStatus("sk-test-b", 500);
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({ batchId: "cli-status-retry", jobs: imageJobs(2) }));
  const out = join(dir, "out");
  const env = accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
    AGNES_ROUTING_STRATEGY: "round-robin",
    AGNES_STATE_DIR: join(dir, "state"),
  });
  const first = await runCli(["batch", "run", input, "--out", out, "--concurrency", "2", "--json"], { cwd: dir, env });
  assert.equal(first.code, 1, first.stderr);
  const firstPayload = lastJsonOutput(first.stdout);
  assert.equal(firstPayload.summary.failed, 2);
  assert.equal(firstPayload.summary.succeeded, 0);

  const status = await runCli(["batch", "status", out, "--json"], { cwd: dir, env });
  assert.equal(status.code, 0, status.stderr);
  const report = lastJsonOutput(status.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary.failed, 2);
  assert.equal(report.jobs.length, 2);

  server.setForcedStatus("sk-test-a", null);
  server.setForcedStatus("sk-test-b", null);
  const createsBeforeRetry = server.requests.filter((request) => request.method === "POST").length;
  const retry = await runCli(["batch", "retry", out, "--only", "failed", "--json"], { cwd: dir, env });
  assert.equal(retry.code, 0, retry.stderr);
  const retryPayload = lastJsonOutput(retry.stdout);
  assert.equal(retryPayload.summary.succeeded, 2);
  assert.equal(retryPayload.summary.failed, 0);
  const newCreates = server.requests
    .filter((request) => request.method === "POST")
    .slice(createsBeforeRetry);
  assert.equal(newCreates.length, 2, "retry must re-create exactly the two failed jobs");
});

test("real CLI: record mode polls a video only on its create account", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [
      { key: "sk-test-a", id: "a" },
      { key: "sk-test-b", id: "b" },
    ],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  writeFileSync(input, JSON.stringify({
    batchId: "cli-video-affinity",
    consistency: "record",
    jobs: [{ id: "clip", kind: "video", mode: "text2video", prompt: "clip", model: "agnes-video-2.5", seconds: 5 }],
  }));
  const out = join(dir, "out");
  const result = await runCli(["batch", "run", input, "--out", out, "--json"], {
    cwd: dir,
    env: accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], {
      AGNES_ROUTING_STRATEGY: "round-robin",
      AGNES_STATE_DIR: join(dir, "state"),
      AGNES_POLL_INTERVAL_MS: "10",
    }),
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  const creates = server.requests.filter(
    (request) => request.method === "POST" && request.pathname.endsWith("/videos"),
  );
  const polls = server.requests.filter(
    (request) => request.method === "GET" && request.pathname.endsWith("/agnesapi"),
  );
  assert.equal(creates.length, 1);
  assert.ok(polls.length >= 1);
  const createAccount = creates[0].accountId;
  assert.ok(createAccount === "a" || createAccount === "b");
  for (const poll of polls) {
    assert.equal(poll.accountId, createAccount, "video poll must use the create account");
  }
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.jobs[0].accountId, createAccount);
  assert.match(manifest.jobs[0].result.videoUrl, /mp4/);
});

test("real CLI: JSONL input uses CLI flags as generation defaults", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.jsonl");
  writeFileSync(input, [
    "# JSONL jobs; defaults come from CLI flags",
    '{"id":"one","kind":"image","mode":"text2img","prompt":"first"}',
    "",
    '{"id":"two","kind":"image","mode":"text2img","prompt":"second"}',
  ].join("\n"));
  const out = join(dir, "out");
  const result = await runCli(
    [
      "batch", "run", input, "--out", out, "--json",
      "--model", "agnes-image-2.5-flash", "--size", "2K", "--ratio", "1:1",
    ],
    { cwd: dir, env: accountEnv(server, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }], { AGNES_STATE_DIR: join(dir, "state") }) },
  );
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  const creates = server.requests.filter(
    (request) => request.method === "POST" && request.pathname.endsWith("/images/generations"),
  );
  assert.equal(creates.length, 2);
  for (const create of creates) {
    assert.equal(create.body.model, "agnes-image-2.5-flash");
    assert.equal(create.body.size, "2K");
    assert.equal(create.body.ratio ?? create.body.aspect_ratio, "1:1");
  }
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.jobs.map((job) => job.id), ["one", "two"]);
});

test("real CLI regression: mixed-kind batch with flat image model defaults all succeed", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "main" }, { key: "sk-test-b", id: "backup" }],
  });
  t.after(() => server.close());
  const input = join(dir, "jobs.json");
  // Exact acceptance repro: a flat image model default used to leak into the
  // video job (zod enum error) and the text job.
  writeFileSync(input, JSON.stringify({
    version: 1,
    batchId: "flake",
    defaults: { model: "agnes-image-2.5-flash", size: "1K", ratio: "1:1" },
    jobs: [
      { id: "img-1", kind: "image", mode: "text2img", prompt: "one" },
      { id: "img-2", kind: "image", mode: "text2img", prompt: "two" },
      { id: "vid-1", kind: "video", mode: "text2video", prompt: "clip", seconds: 5 },
      { id: "txt-1", kind: "text", mode: "chat", prompt: "pong" },
    ],
  }));
  const out = join(dir, "out");
  const result = await runCli(["batch", "run", input, "--out", out, "--concurrency", "3", "--json"], {
    cwd: dir,
    env: accountEnv(server, [{ key: "sk-test-a", id: "main" }, { key: "sk-test-b", id: "backup" }], {
      AGNES_ROUTING_STRATEGY: "round-robin",
      AGNES_STATE_DIR: join(dir, "state"),
      AGNES_POLL_INTERVAL_MS: "10",
    }),
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.succeeded, 4);
  assert.deepEqual(payload.failedJobs, []);

  const posts = server.requests.filter((request) => request.method === "POST");
  const images = posts.filter((request) => request.pathname.endsWith("/images/generations"));
  const videos = posts.filter((request) => request.pathname.endsWith("/videos"));
  const chats = posts.filter((request) => request.pathname.endsWith("/chat/completions"));
  assert.equal(images.length, 2);
  assert.equal(videos.length, 1);
  assert.equal(chats.length, 1);
  assert.ok(images.every((request) => request.body.model === "agnes-image-2.5-flash"));
  assert.equal(videos[0].body.model, "agnes-video-2.5");
  assert.equal(chats[0].body.model, "agnes-2.5-flash");

  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  const byId = Object.fromEntries(manifest.jobs.map((job) => [job.id, job]));
  assert.equal(byId["img-1"].model, "agnes-image-2.5-flash");
  assert.equal(byId["img-1"].modelSource, "defaults");
  assert.equal(byId["vid-1"].model, "agnes-video-2.5");
  assert.equal(byId["vid-1"].modelSource, "kind-default");
  assert.equal(byId["txt-1"].model, "agnes-2.5-flash");
  assert.equal(byId["txt-1"].modelSource, "kind-default");
  assert.ok(manifest.jobs.every((job) => job.status === "succeeded"));
});
