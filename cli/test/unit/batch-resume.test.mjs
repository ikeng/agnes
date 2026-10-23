import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../../dist/batch/runner.js";
import { AgnesCliError } from "../../dist/errors.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-batch-resume-"));
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

function imageJob(id, prompt = id) {
  return { id, kind: "image", mode: "text2img", prompt };
}

function makeClient(config = {}) {
  const calls = [];
  const client = {
    text: {
      complete: async (options) => {
        calls.push({ method: "text", options });
        return { ok: true, text: "ok", accountId: "main", poolId: "pool-main" };
      },
    },
    image: {
      generate: async (options) => {
        calls.push({ method: "image", options });
        if (config.onImage) return config.onImage(options, calls);
        return { ok: true, url: `https://cdn.example/${options.prompt}.png`, accountId: "main", poolId: "pool-main" };
      },
    },
    video: {
      generate: async () => {
        throw new Error("not used in resume tests");
      },
      poll: async () => {
        throw new Error("not used in resume tests");
      },
    },
    router: {
      select: () => ({ id: "main", poolId: "pool-main" }),
      summary: () => ({ strategy: "adaptive", accounts: [{ id: "main", poolId: "pool-main" }] }),
    },
  };
  return { client, calls };
}

test("resume skips succeeded jobs without creating any new tasks", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "resume-1",
    jobs: [imageJob("a"), imageJob("b")],
  });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  const first = await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(first.exitCode, 0);
  assert.equal(calls.length, 2);

  const resumed = await runBatch(
    { inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 },
    { client },
  );
  assert.equal(resumed.exitCode, 0);
  assert.equal(calls.length, 2, "resume must not re-create succeeded jobs");
  const manifest = readJson(join(out, "manifest.json"));
  assert.deepEqual(manifest.jobs.map((job) => job.status), ["succeeded", "succeeded"]);
  assert.equal(manifest.summary.succeeded, 2);
  const events = readFileSync(join(out, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "batch_resumed"));
});

test("resume reruns failed jobs and keeps succeeded jobs untouched", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "resume-failed", jobs: [imageJob("ok"), imageJob("bad")] });
  let fail = true;
  const { client, calls } = makeClient({
    onImage: (options) => {
      if (options.prompt === "bad" && fail) {
        throw new AgnesCliError("AMBIGUOUS_CREATE", "timeout", undefined);
      }
      return { ok: true, url: `https://cdn.example/${options.prompt}.png`, accountId: "main", poolId: "pool-main" };
    },
  });
  const out = join(dir, "out");
  const first = await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(first.exitCode, 1);
  assert.equal(calls.length, 2);
  fail = false;
  const resumed = await runBatch({ inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 }, { client });
  assert.equal(resumed.exitCode, 0);
  assert.equal(calls.length, 3, "only the failed job is re-run");
  const manifest = readJson(join(out, "manifest.json"));
  assert.deepEqual(manifest.jobs.map((job) => job.status), ["succeeded", "succeeded"]);
  assert.equal(manifest.jobs[0].attempts, 1);
  assert.equal(manifest.jobs[1].attempts, 2);
});

test("resume with an appended input job runs only the new job, in input order", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "resume-append", jobs: [imageJob("a"), imageJob("b")] });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(calls.length, 2);

  writeInput(dir, "jobs.json", {
    batchId: "resume-append",
    jobs: [imageJob("a"), imageJob("b"), imageJob("c")],
  });
  const resumed = await runBatch({ inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 }, { client });
  assert.equal(resumed.exitCode, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.prompt, "c");
  const manifest = readJson(join(out, "manifest.json"));
  assert.deepEqual(manifest.jobs.map((job) => job.id), ["a", "b", "c"]);
  assert.deepEqual(manifest.jobs.map((job) => job.index), [0, 1, 2]);
  assert.equal(manifest.summary.succeeded, 3);
});

test("resume aborts with BATCH_INPUT_CHANGED when a succeeded job's definition changed", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "resume-changed", jobs: [imageJob("a"), imageJob("b")] });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(calls.length, 2);

  writeInput(dir, "jobs.json", {
    batchId: "resume-changed",
    jobs: [imageJob("a", "a completely different prompt"), imageJob("b")],
  });
  await assert.rejects(
    () => runBatch({ inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 }, { client }),
    (error) => {
      assert.equal(error.code, "BATCH_INPUT_CHANGED");
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /job "a"/);
      return true;
    },
  );
  assert.equal(calls.length, 2, "abort must happen before any new create");
});

test("resume recovers a running job as pending with an ambiguity warning", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "resume-running", jobs: [imageJob("a"), imageJob("b")] });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(calls.length, 2);

  // Simulate a process that died while job "b" was running.
  const manifest = readJson(join(out, "manifest.json"));
  const record = manifest.jobs.find((job) => job.id === "b");
  record.status = "running";
  record.result = null;
  record.error = null;
  record.finishedAt = undefined;
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

  const warnings = [];
  const resumed = await runBatch(
    { inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 },
    { client, stderr: (line) => warnings.push(line) },
  );
  assert.equal(resumed.exitCode, 0);
  assert.equal(calls.length, 3, "the recovered running job is re-run");
  assert.ok(
    warnings.some((line) => /running/.test(line) && /billed|accepted/.test(line)),
    `expected an ambiguity warning, got: ${warnings.join("\n")}`,
  );
  const updated = readJson(join(out, "manifest.json"));
  assert.equal(updated.jobs.find((job) => job.id === "b").recoveredFrom, "running");
  assert.equal(updated.jobs.find((job) => job.id === "b").status, "succeeded");
});

test("resume keeps jobs removed from input as skipped", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "resume-removed", jobs: [imageJob("a"), imageJob("b")] });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  assert.equal(calls.length, 2);

  writeInput(dir, "jobs.json", { batchId: "resume-removed", jobs: [imageJob("a")] });
  const resumed = await runBatch({ inputPath: input, outDir: out, resume: true, retryBackoffMs: 1 }, { client });
  assert.equal(resumed.exitCode, 0);
  assert.equal(calls.length, 2);
  const manifest = readJson(join(out, "manifest.json"));
  const removed = manifest.jobs.find((job) => job.id === "b");
  assert.equal(removed.status, "skipped");
  assert.equal(removed.reason, "removed_from_input");
  assert.equal(manifest.summary.skipped, 1);
});

test("resume validates batchId, consistency and defaults before running", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", {
    batchId: "resume-validate",
    defaults: { model: "agnes-image-2.5-flash" },
    jobs: [imageJob("a")],
  });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });

  writeInput(dir, "jobs.json", {
    batchId: "different-batch",
    defaults: { model: "agnes-image-2.5-flash" },
    jobs: [imageJob("a")],
  });
  await assert.rejects(
    () => runBatch({ inputPath: input, outDir: out, resume: true }, { client }),
    (error) => error.code === "BATCH_BATCH_ID_MISMATCH" && error.exitCode === 2,
  );

  writeInput(dir, "jobs.json", {
    batchId: "resume-validate",
    defaults: { model: "agnes-image-2.5-flash" },
    jobs: [imageJob("a")],
  });
  await assert.rejects(
    () => runBatch({ inputPath: input, outDir: out, resume: true, consistency: "strict" }, { client }),
    (error) => error.code === "BATCH_CONFIG_CHANGED" && error.exitCode === 2,
  );

  writeInput(dir, "jobs.json", {
    batchId: "resume-validate",
    defaults: { model: "agnes-image-2.5-flash", size: "2K" },
    jobs: [imageJob("a")],
  });
  await assert.rejects(
    () => runBatch({ inputPath: input, outDir: out, resume: true }, { client }),
    (error) => error.code === "BATCH_DEFAULTS_CHANGED" && error.exitCode === 2,
  );
  assert.equal(calls.length, 1);
});

test("non-empty out dir requires --resume or --force", async (t) => {
  const dir = tempDir(t);
  const input = writeInput(dir, "jobs.json", { batchId: "out-dir", jobs: [imageJob("a")] });
  const { client, calls } = makeClient();
  const out = join(dir, "out");
  await runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client });
  await assert.rejects(
    () => runBatch({ inputPath: input, outDir: out, retryBackoffMs: 1 }, { client }),
    (error) => error.code === "BATCH_OUT_DIR_NOT_EMPTY" && error.exitCode === 2,
  );
  assert.equal(calls.length, 1);
  const forced = await runBatch({ inputPath: input, outDir: out, force: true, retryBackoffMs: 1 }, { client });
  assert.equal(forced.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(existsSync(join(out, "manifest.json")), true);
});
