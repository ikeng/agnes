import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { toPublicUrl } from "../../dist/media/toPublicUrl.js";

test("toPublicUrl uploads data URLs through the media provider", async () => {
  let uploadedPath;
  let uploadedContents;
  const result = await toPublicUrl("data:image/png;base64,aGVsbG8=", {}, {
    mediaProvider: {
      async upload(localPath) {
        uploadedPath = localPath;
        uploadedContents = await readFile(localPath, "utf8");
        return "https://example.com/uploaded.png";
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    url: "https://example.com/uploaded.png",
    source: "provider",
  });
  assert.equal(uploadedContents, "hello");
  assert.ok(uploadedPath);
  assert.equal(extname(uploadedPath), ".png");
  await assert.rejects(() => access(uploadedPath));
});

test("toPublicUrl fetches and uploads loopback http URLs instead of passing them through", async () => {
  let fetchedUrl;
  let uploadedContents;
  const result = await toPublicUrl("http://127.0.0.1:3001/local-assets/image", {}, {
    fetchImpl: async (url) => {
      fetchedUrl = String(url);
      return new Response(Buffer.from("image-bytes"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    },
    mediaProvider: {
      async upload(localPath) {
        uploadedContents = await readFile(localPath, "utf8");
        return "https://example.com/from-local.png";
      },
    },
  });

  assert.equal(fetchedUrl, "http://127.0.0.1:3001/local-assets/image");
  assert.equal(uploadedContents, "image-bytes");
  assert.deepEqual(result, {
    ok: true,
    url: "https://example.com/from-local.png",
    source: "provider",
  });
});

test("toPublicUrl still passes public http URLs through", async () => {
  const result = await toPublicUrl("https://cdn.example.com/image.png", {}, {
    mediaProvider: {
      async upload() {
        throw new Error("public URLs should not be uploaded");
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    url: "https://cdn.example.com/image.png",
    source: "passthrough",
  });
});

test("toPublicUrl tries Litterbox first for temporary uploads", async () => {
  const requestedUrls = [];

  const result = await toPublicUrl("data:image/png;base64,aGVsbG8=", { ttl: "1h" }, {
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      requestedUrls.push(requestedUrl);

      if (requestedUrl === "https://litterbox.catbox.moe/resources/internals/api.php") {
        return new Response("https://litter.catbox.moe/fast.png\n", { status: 200 });
      }

      throw new Error(`unexpected upload URL: ${requestedUrl}`);
    },
  });

  assert.deepEqual(requestedUrls, ["https://litterbox.catbox.moe/resources/internals/api.php"]);
  assert.deepEqual(result, {
    ok: true,
    url: "https://litter.catbox.moe/fast.png",
    source: "temporary",
  });
});

test("toPublicUrl falls back to tmpfiles direct links when Litterbox fails", async () => {
  const requestedUrls = [];

  const result = await toPublicUrl("data:image/png;base64,aGVsbG8=", { ttl: "1h" }, {
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      requestedUrls.push(requestedUrl);

      if (requestedUrl === "https://litterbox.catbox.moe/resources/internals/api.php") {
        throw new TypeError("fetch failed");
      }

      if (requestedUrl === "https://tmpfiles.org/api/v1/upload") {
        return new Response(JSON.stringify({
          status: "success",
          data: { url: "https://tmpfiles.org/abc123/fallback.png" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected upload URL: ${requestedUrl}`);
    },
  });

  assert.deepEqual(requestedUrls, ["https://litterbox.catbox.moe/resources/internals/api.php", "https://tmpfiles.org/api/v1/upload"]);
  assert.deepEqual(result, {
    ok: true,
    url: "https://tmpfiles.org/dl/abc123/fallback.png",
    source: "temporary",
  });
});

test("toPublicUrl can prefer tmpfiles for temporary uploads", async () => {
  const requestedUrls = [];

  const result = await toPublicUrl("data:image/png;base64,aGVsbG8=", { ttl: "1h" }, {
    temporaryMediaProviderOrder: ["tmpfiles", "litterbox", "uguu", "x0"],
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      requestedUrls.push(requestedUrl);

      if (requestedUrl === "https://tmpfiles.org/api/v1/upload") {
        return new Response(JSON.stringify({
          status: "success",
          data: { url: "https://tmpfiles.org/preferred/tmp-first.png" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected upload URL: ${requestedUrl}`);
    },
  });

  assert.deepEqual(requestedUrls, ["https://tmpfiles.org/api/v1/upload"]);
  assert.deepEqual(result, {
    ok: true,
    url: "https://tmpfiles.org/dl/preferred/tmp-first.png",
    source: "temporary",
  });
});

test("toPublicUrl falls back to Uguu when Litterbox and tmpfiles fail", async () => {
  const requestedUrls = [];

  const result = await toPublicUrl("data:image/png;base64,aGVsbG8=", { ttl: "12h" }, {
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      requestedUrls.push(requestedUrl);

      if (requestedUrl === "https://litterbox.catbox.moe/resources/internals/api.php") {
        throw new TypeError("fetch failed");
      }

      if (requestedUrl === "https://tmpfiles.org/api/v1/upload") {
        return new Response("service unavailable", { status: 503 });
      }

      if (requestedUrl === "https://uguu.se/upload") {
        return new Response(JSON.stringify({
          success: true,
          files: [{ url: "https://o.uguu.se/fallback.png" }],
          errors: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected upload URL: ${requestedUrl}`);
    },
  });

  assert.deepEqual(requestedUrls, [
    "https://litterbox.catbox.moe/resources/internals/api.php",
    "https://tmpfiles.org/api/v1/upload",
    "https://uguu.se/upload",
  ]);
  assert.deepEqual(result, {
    ok: true,
    url: "https://o.uguu.se/fallback.png",
    source: "temporary",
  });
});
