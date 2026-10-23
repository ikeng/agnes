import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEffectiveJobs,
  canonicalJson,
  jobInputHash,
  parseBatchInputFile,
} from "../../dist/batch/input.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-batch-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function invalidInput(path, options) {
  return parseAndThrow(path, options);
}

function parseAndThrow(path, options) {
  try {
    parseBatchInputFile(path, options);
  } catch (error) {
    return error;
  }
  throw new Error("expected parseBatchInputFile to throw");
}

test("JSON object input parses with defaults and batch metadata", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "jobs.json", JSON.stringify({
    version: 1,
    batchId: "icons-v1",
    consistency: "strict",
    defaults: { model: "agnes-image-2.5-flash", size: "1K" },
    jobs: [
      { id: "icon-001", kind: "image", mode: "text2img", prompt: "a" },
      { id: "copy-001", kind: "text", prompt: "b" },
    ],
  }));
  const parsed = parseBatchInputFile(path);
  assert.equal(parsed.format, "json");
  assert.equal(parsed.batchId, "icons-v1");
  assert.equal(parsed.consistency, "strict");
  assert.deepEqual(parsed.defaults, { model: "agnes-image-2.5-flash", size: "1K" });
  assert.equal(parsed.jobs.length, 2);
  assert.equal(parsed.jobs[1].mode, "chat", "text mode defaults to chat");
  assert.match(parsed.rawSha256, /^[a-f0-9]{64}$/);

  const jobs = buildEffectiveJobs(parsed, { batchId: "icons-v1" });
  assert.equal(jobs[0].model, "agnes-image-2.5-flash");
  assert.equal(jobs[0].size, "1K");
  assert.equal(jobs[0].affinity, "batch:icons-v1:icon-001");
  assert.equal(jobs[1].model, "agnes-2.5-flash");
  assert.equal(jobs[1].modelSource, "kind-default");
});

test("JSONL input supports comments and blank lines and CLI defaults", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "jobs.jsonl", `
# a comment line
// another comment
{"id":"a","kind":"image","mode":"text2img","prompt":"a"}

{"id":"b","kind":"image","mode":"text2img","prompt":"b"}
`);
  const parsed = parseBatchInputFile(path, { cliDefaults: { model: "agnes-image-2.5-flash", seconds: 5 } });
  assert.equal(parsed.format, "jsonl");
  assert.equal(parsed.jobs.length, 2);
  assert.deepEqual(parsed.defaults, { model: "agnes-image-2.5-flash", seconds: 5 });
  const jobs = buildEffectiveJobs(parsed, { batchId: "jsonl-batch" });
  assert.equal(jobs[0].model, "agnes-image-2.5-flash");
  assert.equal(jobs[0].affinity, "batch:jsonl-batch:a");
});

test("JSONL input reports invalid lines with line numbers", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "broken.jsonl", '{"id":"a","kind":"image","mode":"text2img","prompt":"a"}\n{"nope":true}\n');
  const error = parseAndThrow(path);
  assert.equal(error.code, "INVALID_BATCH_INPUT");
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /jobs\[1\].*kind is required/);
});

test("duplicate job ids are rejected", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "dup.json", JSON.stringify({
    jobs: [
      { id: "same", kind: "image", mode: "text2img", prompt: "a" },
      { id: "same", kind: "image", mode: "text2img", prompt: "b" },
    ],
  }));
  const error = parseAndThrow(path);
  assert.equal(error.code, "INVALID_BATCH_INPUT");
  assert.match(error.message, /duplicates/);
});

test("unknown top-level and job keys are rejected (strict schema)", (t) => {
  const dir = tempDir(t);
  const wrapper = writeFile(dir, "wrapper.json", JSON.stringify({
    jobs: [],
    surprise: true,
  }));
  assert.match(parseAndThrow(wrapper).message, /unknown top-level key "surprise"/);

  const job = writeFile(dir, "job.json", JSON.stringify({
    jobs: [{ id: "a", kind: "image", mode: "text2img", prompt: "a", surprise: 1 }],
  }));
  assert.match(parseAndThrow(job).message, /unknown key "surprise"/);
});

test("defaults cannot contain structural job keys", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "defaults.json", JSON.stringify({
    defaults: { id: "sneaky" },
    jobs: [],
  }));
  const error = parseAndThrow(path);
  assert.match(error.message, /defaults.id is not allowed/);
});

test("prompt may come from defaults but must be present after merge", (t) => {
  const dir = tempDir(t);
  const withDefault = writeFile(dir, "ok.json", JSON.stringify({
    defaults: { prompt: "from defaults" },
    jobs: [{ id: "a", kind: "image", mode: "text2img" }],
  }));
  const parsed = parseBatchInputFile(withDefault);
  const jobs = buildEffectiveJobs(parsed, { batchId: "b" });
  assert.equal(jobs[0].prompt, "from defaults");

  const missing = writeFile(dir, "missing.json", JSON.stringify({
    jobs: [{ id: "a", kind: "image", mode: "text2img" }],
  }));
  const parsedMissing = parseBatchInputFile(missing);
  assert.throws(
    () => buildEffectiveJobs(parsedMissing, { batchId: "b" }),
    (error) => error.code === "INVALID_BATCH_INPUT" && /prompt is required/.test(error.message),
  );
});

test("kind/mode mismatches and mode-specific image rules are rejected", (t) => {
  const dir = tempDir(t);
  const cases = [
    [{ id: "a", kind: "image", mode: "text2video", prompt: "x" }, /mode must be one of/],
    [{ id: "a", kind: "text", mode: "text2img", prompt: "x" }, /mode must be "chat"/],
    [{ id: "a", kind: "image", mode: "img2img", prompt: "x" }, /"image" is required/],
    [{ id: "a", kind: "image", mode: "text2img", prompt: "x", image: "./a.png" }, /"image" is not accepted/],
    [{ id: "a", kind: "image", mode: "compose", prompt: "x", images: ["./a.png"] }, /at least 2 entries/],
    [{ id: "a", kind: "video", mode: "keyframes", prompt: "x", images: ["./a.png", "./b.png", "./c.png"] }, /exactly 2 images/],
  ];
  cases.forEach(([job, pattern], index) => {
    const path = writeFile(dir, `case-${index}.json`, JSON.stringify({ jobs: [job] }));
    const error = parseAndThrow(path);
    assert.match(error.message, pattern, `case ${index}: ${error.message}`);
  });
});

test("metadata is limited to 4 KB", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "meta.json", JSON.stringify({
    jobs: [{
      id: "a",
      kind: "image",
      mode: "text2img",
      prompt: "x",
      metadata: { blob: "x".repeat(5000) },
    }],
  }));
  assert.match(parseAndThrow(path).message, /metadata must be at most 4096 bytes/);
});

test("local media paths resolve relative to the input file; URLs pass through", (t) => {
  const dir = tempDir(t);
  const sub = join(dir, "src");
  const path = writeFile(sub, "jobs.json", JSON.stringify({
    jobs: [
      { id: "a", kind: "image", mode: "img2img", prompt: "x", image: "./a.png" },
      { id: "b", kind: "image", mode: "img2img", prompt: "x", image: "https://example.com/b.png" },
    ],
  }));
  const parsed = parseBatchInputFile(path);
  const jobs = buildEffectiveJobs(parsed, { batchId: "media" });
  assert.equal(jobs[0].image, join(sub, "a.png"));
  assert.equal(jobs[1].image, "https://example.com/b.png");
});

test("job input hashes are deterministic and change with the effective definition", () => {
  const base = {
    index: 0,
    id: "a",
    kind: "image",
    mode: "text2img",
    prompt: "hello",
    affinity: "batch:b:a",
  };
  assert.equal(jobInputHash(base), jobInputHash({ ...base, index: 7 }));
  assert.notEqual(jobInputHash(base), jobInputHash({ ...base, prompt: "hello!" }));
  assert.notEqual(jobInputHash(base), jobInputHash({ ...base, metadata: { x: 1 } }));
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("invalid batch ids, empty JSONL and JSON arrays are rejected", (t) => {
  const dir = tempDir(t);
  assert.match(
    parseAndThrow(writeFile(dir, "id.json", JSON.stringify({ batchId: "bad batch id!", jobs: [] }))).message,
    /batchId must match/,
  );
  assert.match(parseAndThrow(writeFile(dir, "empty.jsonl", "\n# only comments\n")).message, /no jobs/);
  assert.match(parseAndThrow(writeFile(dir, "array.json", "[]")).message, /top-level JSON array/);
  assert.match(parseAndThrow(writeFile(dir, "missing.json", "{}")).message, /missing required "jobs"/);
  assert.match(
    parseAndThrow(writeFile(dir, "version.json", JSON.stringify({ version: 2, jobs: [] }))).message,
    /unsupported version/,
  );
});

test("flat defaults are kind-aware: an image model default never leaks into video/text", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "mixed.json", JSON.stringify({
    batchId: "mixed",
    defaults: { model: "agnes-image-2.5-flash", size: "1K", ratio: "1:1", ttl: "1h" },
    jobs: [
      { id: "img", kind: "image", mode: "text2img", prompt: "one" },
      { id: "vid", kind: "video", mode: "text2video", prompt: "clip", seconds: 5 },
      { id: "txt", kind: "text", mode: "chat", prompt: "pong" },
    ],
  }));
  const jobs = buildEffectiveJobs(parseBatchInputFile(path), { batchId: "mixed" });
  assert.equal(jobs[0].model, "agnes-image-2.5-flash");
  assert.equal(jobs[0].modelSource, "defaults");
  assert.equal(jobs[0].size, "1K");
  assert.equal(jobs[0].ratio, "1:1");
  assert.equal(jobs[0].ttl, "1h");

  assert.equal(jobs[1].model, "agnes-video-2.5", "video job must use the video kind default model");
  assert.equal(jobs[1].modelSource, "kind-default");
  assert.equal(jobs[1].size, "1K", "1K is a valid video size tier");
  assert.equal(jobs[1].seconds, 5);
  assert.equal(jobs[1].ratio, undefined, "ratio is not a video parameter");
  assert.equal(jobs[1].ttl, "1h");

  assert.equal(jobs[2].model, "agnes-2.5-flash", "text job must use the text kind default model");
  assert.equal(jobs[2].modelSource, "kind-default");
  assert.equal(jobs[2].size, undefined);
  assert.equal(jobs[2].ratio, undefined);
  assert.equal(jobs[2].ttl, undefined);
});

test("flat defaults with kind-incompatible values are dropped per kind", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "incompatible.json", JSON.stringify({
    defaults: { size: "1024x1024", ratio: "1:1", seed: 7, aspectRatio: "16:9" },
    jobs: [
      { id: "img", kind: "image", mode: "text2img", prompt: "one" },
      { id: "vid", kind: "video", mode: "text2video", prompt: "clip" },
    ],
  }));
  const jobs = buildEffectiveJobs(parseBatchInputFile(path), { batchId: "incompat" });
  assert.equal(jobs[0].size, "1024x1024");
  assert.equal(jobs[0].ratio, "1:1");
  assert.equal(jobs[0].seed, 7);
  assert.equal(jobs[0].aspectRatio, undefined, "aspectRatio is not an image parameter");
  assert.equal(jobs[1].size, undefined, "exact image size is not a valid video size tier");
  assert.equal(jobs[1].ratio, undefined);
  assert.equal(jobs[1].seed, 7);
  assert.equal(jobs[1].aspectRatio, "16:9");
});

test("defaultsByKind overrides flat defaults per kind and job values win", (t) => {
  const dir = tempDir(t);
  const path = writeFile(dir, "by-kind.json", JSON.stringify({
    batchId: "by-kind",
    defaults: { model: "agnes-image-2.5-flash", size: "1K", ratio: "1:1" },
    defaultsByKind: {
      image: { model: "agnes-image-2.1-flash", size: "2K", ratio: "16:9" },
      video: { model: "agnes-video-2.5-flash", seconds: 6, size: "720P", aspectRatio: "9:16" },
      text: { model: "agnes-3.0-flash" },
    },
    jobs: [
      { id: "img", kind: "image", mode: "text2img", prompt: "one" },
      { id: "vid", kind: "video", mode: "text2video", prompt: "clip" },
      { id: "txt", kind: "text", mode: "chat", prompt: "pong" },
      { id: "vid-job", kind: "video", mode: "text2video", prompt: "clip", model: "agnes-video-2.5" },
    ],
  }));
  const jobs = buildEffectiveJobs(parseBatchInputFile(path), { batchId: "by-kind" });
  assert.equal(jobs[0].model, "agnes-image-2.1-flash");
  assert.equal(jobs[0].modelSource, "defaults");
  assert.equal(jobs[0].size, "2K");
  assert.equal(jobs[0].ratio, "16:9");
  assert.equal(jobs[1].model, "agnes-video-2.5-flash");
  assert.equal(jobs[1].modelSource, "defaults");
  assert.equal(jobs[1].seconds, 6);
  assert.equal(jobs[1].size, "720P");
  assert.equal(jobs[1].aspectRatio, "9:16");
  assert.equal(jobs[2].model, "agnes-3.0-flash");
  assert.equal(jobs[3].model, "agnes-video-2.5");
  assert.equal(jobs[3].modelSource, "job");
});

test("defaultsByKind rejects unknown kinds, unknown keys and kind-incompatible params", (t) => {
  const dir = tempDir(t);
  const cases = [
    [{ defaultsByKind: { audio: { model: "x" } }, jobs: [] }, /defaultsByKind\.audio is not a job kind/],
    [{ defaultsByKind: { video: { bogus: 1 } }, jobs: [] }, /defaultsByKind\.video\.bogus is not allowed/],
    [{ defaultsByKind: { text: { size: "1K" } }, jobs: [] }, /defaultsByKind\.text\.size is not supported for kind text/],
    [{ defaultsByKind: "nope", jobs: [] }, /defaultsByKind must be an object/],
  ];
  cases.forEach(([body, pattern], index) => {
    const path = writeFile(dir, `by-kind-bad-${index}.json`, JSON.stringify(body));
    assert.match(parseAndThrow(path).message, pattern, `case ${index}`);
  });
});
