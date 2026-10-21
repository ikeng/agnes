import assert from "node:assert/strict";
import test from "node:test";

import { createAgnesClient } from "../../dist/index.js";

for (const model of ["agnes-image-2.5-flash", "agnes-image-2.1-flash", "agnes-image-2.0-flash"]) {
  test(`image.generate sends the documented img2img payload for ${model}`, async () => {
    const requests = [];
    const client = createAgnesClient({
      apiKey: "test-key",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ data: [{ url: "https://cdn.example.com/output.png" }] });
      },
    });

    const result = await client.image.generate({
      mode: "img2img",
      model,
      image: "https://cdn.example.com/input.png",
      prompt: "Preserve the composition and change the lighting.",
      size: "1024x1024",
      responseFormat: "url",
    });

    assert.equal(result.url, "https://cdn.example.com/output.png");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://apihub.agnes-ai.com/v1/images/generations");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      model,
      prompt: "Preserve the composition and change the lighting.",
      size: "1024x1024",
      extra_body: {
        image: ["https://cdn.example.com/input.png"],
        response_format: "url",
      },
    });
  });
}

test("image.generate defaults to Image 2.5 with a valid size", async () => {
  const requests = [];
  const client = createAgnesClient({
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ data: [{ url: "https://cdn.example.com/output.png" }] });
    },
  });

  await client.image.generate({
    mode: "text2img",
    prompt: "A silver watch on black stone.",
  });

  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: "agnes-image-2.5-flash",
    prompt: "A silver watch on black stone.",
    size: "1024x1024",
  });
});
