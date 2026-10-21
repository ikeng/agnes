import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVideoTask } from "../../dist/video/generateVideo.js";
import { normalizeVideoRequest, validateVideoSettings } from "../../dist/video/normalizeVideoRequest.js";

test("normalizeVideoRequest defaults to Video 2.5 text mode", () => {
  const payload = normalizeVideoRequest(
    { mode: "text2video", prompt: "waves at dusk" },
    [],
  );
  assert.equal(payload.model, "agnes-video-2.5");
  assert.equal(payload.mode, "text");
  assert.equal(payload.seconds, "5");
  assert.equal(payload.prompt, "waves at dusk");
  assert.equal("width" in payload, false);
  assert.equal("num_frames" in payload, false);
});

test("normalizeVideoRequest forwards Video 2.5 controls", () => {
  const payload = normalizeVideoRequest(
    {
      mode: "text2video",
      model: "agnes-video-2.5",
      prompt: "waves",
      seconds: 8,
      size: "1080P",
      aspectRatio: "9:16",
      seed: 42,
      n: 1,
    },
    [],
  );
  assert.equal(payload.seconds, "8");
  assert.equal(payload.size, "1080P");
  assert.equal(payload.aspect_ratio, "9:16");
  assert.equal(payload.seed, 42);
  assert.equal(payload.n, 1);
});

test("img2video maps to keyframe mode with first_frame", () => {
  const payload = normalizeVideoRequest(
    {
      mode: "img2video",
      image: "https://example.com/frame.png",
      prompt: "animate",
    },
    ["https://example.com/frame.png"],
  );
  assert.equal(payload.mode, "keyframe");
  assert.equal(payload.first_frame, "https://example.com/frame.png");
  assert.equal("last_frame" in payload, false);
});

test("multivideo maps to reference mode with images", () => {
  const images = ["https://example.com/a.png", "https://example.com/b.png"];
  const payload = normalizeVideoRequest(
    { mode: "multivideo", images, prompt: "reference" },
    images,
  );
  assert.equal(payload.mode, "reference");
  assert.deepEqual(payload.images, images);
});

test("keyframes maps first and last frame in order", () => {
  const images = ["https://example.com/a.png", "https://example.com/b.png"];
  const payload = normalizeVideoRequest(
    { mode: "keyframes", images, prompt: "transition" },
    images,
  );
  assert.equal(payload.mode, "keyframe");
  assert.equal(payload.first_frame, images[0]);
  assert.equal(payload.last_frame, images[1]);
});

test("Video 2.5 rejects legacy v2.0 frame options", () => {
  assert.throws(
    () => normalizeVideoRequest(
      { mode: "text2video", prompt: "x", numFrames: 121, frameRate: 24 },
      [],
    ),
    (error) => error.code === "INVALID_VIDEO_SETTINGS" && /retired/.test(error.message),
  );
});

test("Video 2.5 keyframe mode accepts exactly two images", () => {
  const images = ["https://example.com/a.png", "https://example.com/b.png", "https://example.com/c.png"];
  assert.throws(
    () => normalizeVideoRequest(
      { mode: "keyframes", images, prompt: "transition" },
      images,
    ),
    (error) => error.code === "INVALID_VIDEO_SETTINGS" && /exactly two images/.test(error.message),
  );
});

test("Video 2.5 Flash enforces 720P and reference-image limits", () => {
  assert.throws(
    () => normalizeVideoRequest(
      { mode: "text2video", model: "agnes-video-2.5-flash", prompt: "x", size: "1080P" },
      [],
    ),
    (error) => error.code === "INVALID_VIDEO_SETTINGS",
  );

  const images = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.png`);
  assert.throws(
    () => normalizeVideoRequest(
      { mode: "multivideo", model: "agnes-video-2.5-flash", images, prompt: "x" },
      images,
    ),
    (error) => error.code === "INVALID_VIDEO_SETTINGS",
  );
});

test("legacy v2.0 payload still works when explicitly selected", () => {
  const payload = normalizeVideoRequest(
    {
      mode: "keyframes",
      model: "agnes-video-v2.0",
      images: ["https://example.com/a.png", "https://example.com/b.png"],
      prompt: "transition",
      numFrames: 121,
      frameRate: 24,
    },
    ["https://example.com/a.png", "https://example.com/b.png"],
  );
  assert.equal(payload.model, "agnes-video-v2.0");
  assert.equal(payload.num_frames, 121);
  assert.equal(payload.frame_rate, 24);
  assert.equal(payload.extra_body.mode, "keyframes");
});

test("legacy v2.0 validation enforces 8n + 1", () => {
  assert.throws(
    () => validateVideoSettings({
      model: "agnes-video-v2.0",
      numFrames: 120,
      frameRate: 24,
      mode: "text2video",
      imageCount: 0,
    }),
    /8n \+ 1/,
  );
});

test("Video 2.5 validation enforces seconds range", () => {
  assert.throws(
    () => validateVideoSettings({
      model: "agnes-video-2.5",
      mode: "text2video",
      imageCount: 0,
      seconds: 3,
    }),
    /seconds must be between/,
  );
});

test("normalizeVideoTask preserves the video_id returned by Agnes", () => {
  const result = normalizeVideoTask({
    id: "task_123",
    task_id: "task_123",
    video_id: "video_123",
    model: "agnes-video-2.5",
    status: "queued",
  });

  assert.equal(result.taskId, "task_123");
  assert.equal(result.videoId, "video_123");
  assert.equal(result.model, "agnes-video-2.5");
});

test("Video 2.5 rejects 1K with a non-square aspect ratio", () => {
  assert.throws(
    () => normalizeVideoRequest(
      { mode: "text2video", prompt: "x", size: "1K", aspectRatio: "16:9" },
      [],
    ),
    (error) => error.code === "INVALID_VIDEO_SETTINGS" && /1K is a fixed 1024x1024/.test(error.message),
  );
});
