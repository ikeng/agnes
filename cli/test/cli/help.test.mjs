import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "../../bin/agnes.js");
const pkg = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8"));

const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });

test("root help renders", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Agnes AI text, image, and video workflows/);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /agnes models/);
});

test("--version reports the patched package version", () => {
  const result = run("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("models command lists current defaults", () => {
  const result = run("models", "--json");
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.text.default, "agnes-2.5-flash");
  assert.equal(parsed.image.default, "agnes-image-2.5-flash");
  assert.equal(parsed.video.default, "agnes-video-2.5");
  assert.ok(parsed.video.models.some((model) => model.id === "agnes-video-v2.0" && model.status === "retired"));
  assert.ok(parsed.image.models.some((model) => model.id === "agnes-image-2.0-flash" && model.status === "legacy"));
});

test("text help renders", () => {
  const result = run("text", "chat", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /one-shot Agnes chat completion/);
  assert.match(result.stdout, /\/chat\/completions/);
  assert.match(result.stdout, /agnes-2\.5-flash/);
});

test("image help shows size and ratio flags", () => {
  const result = run("image", "text2img", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--size/);
  assert.match(result.stdout, /--ratio/);
  assert.match(result.stdout, /agnes-image-2\.5-flash/);
});

test("video text2video help shows Video 2.5 controls", () => {
  const result = run("video", "text2video", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--seconds/);
  assert.match(result.stdout, /--size/);
  assert.match(result.stdout, /--aspect-ratio/);
  assert.match(result.stdout, /agnes-video-2\.5/);
  assert.match(result.stdout, /retired/);
});

test("keyframes help renders", () => {
  const result = run("video", "keyframes", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Generate a keyframe video/);
  assert.match(result.stdout, /--image/);
  assert.match(result.stdout, /Example:/);
  assert.match(result.stdout, /first_frame/);
  assert.match(result.stdout, /last_frame/);
});

test("video poll help includes model_name guidance", () => {
  const result = run("video", "poll", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Example:/);
  assert.match(result.stdout, /\/agnesapi\?video_id=\{video_id\}&model_name=\{model\}/);
  assert.match(result.stdout, /keyframe and reference/);
});

test("json errors are machine-readable", () => {
  const result = spawnSync(process.execPath, [cliPath, "image", "text2img", "--prompt", "test", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGNES_API_KEY: "",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    ok: false,
    code: "AUTH_MISSING",
    message: "AGNES_API_KEY is required for Agnes requests.",
  });
});
