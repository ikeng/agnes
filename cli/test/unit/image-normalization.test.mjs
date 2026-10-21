import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImageRequest, validateImageSize } from "../../dist/image/normalizeImageRequest.js";

test("normalizeImageRequest defaults to Image 2.5 and a valid size", () => {
  const payload = normalizeImageRequest(
    { mode: "text2img", prompt: "hello world" },
    [],
  );
  assert.equal(payload.model, "agnes-image-2.5-flash");
  assert.equal(payload.prompt, "hello world");
  assert.equal(payload.size, "1024x1024");
  assert.equal("extra_body" in payload, false);
});

test("normalizeImageRequest forwards tier size and ratio", () => {
  const payload = normalizeImageRequest(
    { mode: "text2img", prompt: "hello", size: "2K", ratio: "16:9" },
    [],
  );
  assert.equal(payload.size, "2K");
  assert.equal(payload.ratio, "16:9");
});

test("normalizeImageRequest keeps a single 2.1 input image in an array", () => {
  const payload = normalizeImageRequest(
    {
      mode: "img2img",
      model: "agnes-image-2.1-flash",
      image: "https://example.com/a.png",
      prompt: "restyle",
      responseFormat: "url",
    },
    ["https://example.com/a.png"],
  );
  assert.deepEqual(payload.extra_body, {
    image: ["https://example.com/a.png"],
    response_format: "url",
  });
  assert.equal("tags" in payload, false);
});

test("normalizeImageRequest supports image 2.5 explicitly", () => {
  const payload = normalizeImageRequest(
    {
      mode: "img2img",
      model: "agnes-image-2.5-flash",
      image: "https://example.com/a.png",
      prompt: "restyle",
    },
    ["https://example.com/a.png"],
  );
  assert.equal(payload.model, "agnes-image-2.5-flash");
  assert.deepEqual(payload.extra_body.image, ["https://example.com/a.png"]);
});

test("normalizeImageRequest uses the documented array shape for image 2.0", () => {
  const payload = normalizeImageRequest(
    {
      mode: "img2img",
      model: "agnes-image-2.0-flash",
      image: "https://example.com/a.png",
      prompt: "restyle",
    },
    ["https://example.com/a.png"],
  );
  assert.deepEqual(payload.extra_body.image, ["https://example.com/a.png"]);
  assert.equal("tags" in payload, false);
});

test("normalizeImageRequest keeps compose as an array", () => {
  const payload = normalizeImageRequest(
    {
      mode: "compose",
      prompt: "merge",
      images: ["https://example.com/a.png", "https://example.com/b.png"],
    },
    ["https://example.com/a.png", "https://example.com/b.png"],
  );
  assert.deepEqual(payload.extra_body.image, ["https://example.com/a.png", "https://example.com/b.png"]);
});

test("validateImageSize accepts tiers and exact sizes, rejects typos", () => {
  for (const size of ["1K", "2K", "3K", "4K", "1024x1024", "1312x736"]) {
    assert.doesNotThrow(() => validateImageSize(size));
  }
  assert.throws(() => validateImageSize("big"), (error) => error.code === "INVALID_IMAGE_SIZE");
});

test("image 2.0 rejects the undocumented ratio parameter", () => {
  assert.throws(
    () => normalizeImageRequest(
      { mode: "text2img", model: "agnes-image-2.0-flash", prompt: "x", size: "1024x1024", ratio: "16:9" },
      [],
    ),
    (error) => error.code === "INVALID_IMAGE_OPTION",
  );
});
