import test from "node:test";
import assert from "node:assert/strict";
import { getVideo, normalizeVideoStatus } from "../../dist/video/getVideo.js";
import { normalizeVideoResult, pollVideo } from "../../dist/video/pollVideo.js";

test("pollVideo includes video details for not-found errors", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "missing" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(
    () => pollVideo("video_123", {}, {
      apiKey: "test-key",
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, "TASK_NOT_FOUND");
      assert.deepEqual(error.details, {
        id: "video_123",
        status: "failed",
        raw: { error: "missing" },
      });
      return true;
    },
  );
});

test("pollVideo retrieves video results with the recommended video_id endpoint", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({
      id: "task_123",
      video_id: "video_123",
      model: "agnes-video-v2.0",
      status: "completed",
      metadata: {
        url: "https://example.com/result.mp4",
      },
      seconds: "5.0",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await pollVideo("video_123", {}, {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl,
  });

  assert.equal(requestedUrls[0], "https://apihub.agnes-ai.com/agnesapi?video_id=video_123");
  assert.equal(result.taskId, "task_123");
  assert.equal(result.videoId, "video_123");
  assert.equal(result.videoUrl, "https://example.com/result.mp4");
  assert.equal(result.seconds, 5);
});

test("getVideo performs one normalized status request", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url, init) => {
    requestedUrls.push(url);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({
      id: "task_123",
      video_id: "video_123",
      model: "agnes-video-v2.0",
      status: "in_progress",
      progress: 50,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await getVideo("video_123", {
    timeoutMs: 30_000,
  }, {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl,
  });

  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls[0], "https://apihub.agnes-ai.com/agnesapi?video_id=video_123");
  assert.equal(result.status, "in_progress");
  assert.equal(result.videoUrl, undefined);
});

test("getVideo normalizes legacy terminal statuses", async () => {
  const responseFor = (status, extra = {}) => async () => new Response(JSON.stringify({
    id: "task_123",
    status,
    ...extra,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const succeeded = await getVideo("task_123", {}, {
    apiKey: "test-key",
    fetchImpl: responseFor("succeeded", {
      metadata: { url: "https://example.com/result.mp4" },
    }),
  });
  const canceled = await getVideo("task_123", {}, {
    apiKey: "test-key",
    fetchImpl: responseFor("cancelled"),
  });

  assert.equal(succeeded.status, "completed");
  assert.equal(canceled.status, "canceled");
});

test("getVideo infers completion for legacy responses with completed_at and a URL", async () => {
  const result = await getVideo("task_123", {}, {
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      id: "task_123",
      completed_at: 123,
      metadata: { url: "https://example.com/result.mp4" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.videoUrl, "https://example.com/result.mp4");
});

test("pollVideo keeps task_id inputs on the legacy endpoint for compatibility", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({
      id: "task_123",
      task_id: "task_123",
      video_id: "video_123",
      model: "agnes-video-v2.0",
      status: "completed",
      remixed_from_video_id: "https://example.com/result.mp4",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await pollVideo("task_123", {}, {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl,
  });

  assert.equal(requestedUrls[0], "https://apihub.agnes-ai.com/v1/videos/task_123");
  assert.equal(result.taskId, "task_123");
  assert.equal(result.videoId, "video_123");
  assert.equal(result.videoUrl, "https://example.com/result.mp4");
});

test("normalizeVideoResult preserves video ids returned as id by the recommended endpoint", () => {
  const result = normalizeVideoResult({
    id: "video_123",
    model: "agnes-video-v2.0",
    status: "completed",
    remixed_from_video_id: "https://example.com/result.mp4",
  });

  assert.equal(result.taskId, "video_123");
  assert.equal(result.videoId, "video_123");
});

test("normalizeVideoStatus rejects completed responses without a video URL", () => {
  assert.throws(
    () => normalizeVideoStatus({
      id: "task_123",
      status: "completed",
    }),
    (error) => error.code === "VIDEO_URL_MISSING",
  );
});

test("normalizeVideoResult keeps incomplete legacy results compatible", () => {
  const result = normalizeVideoResult({
    id: "task_123",
    status: "queued",
  });

  assert.equal(result.status, "queued");
  assert.equal(result.videoUrl, "");
});

test("pollVideo forwards model_name for Video 2.5", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({
      id: "task_123",
      video_id: "video_123",
      model: "agnes-video-2.5",
      status: "completed",
      url: "https://example.com/result.mp4",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await pollVideo("video_123", { modelName: "agnes-video-2.5" }, {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl,
  });

  assert.equal(
    requestedUrls[0],
    "https://apihub.agnes-ai.com/agnesapi?video_id=video_123&model_name=agnes-video-2.5",
  );
  assert.equal(result.videoUrl, "https://example.com/result.mp4");
});

test("getVideo forwards model_name for Video 2.5 keyframe tasks", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({
      id: "task_123",
      video_id: "video_123",
      model: "agnes-video-2.5",
      status: "in_progress",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await getVideo("video_123", { modelName: "agnes-video-2.5" }, {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl,
  });

  assert.equal(
    requestedUrls[0],
    "https://apihub.agnes-ai.com/agnesapi?video_id=video_123&model_name=agnes-video-2.5",
  );
});

test("pollVideo retries transient 503 responses until completion", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "busy" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: "task_123",
      video_id: "video_123",
      model: "agnes-video-2.5",
      status: "completed",
      url: "https://example.com/result.mp4",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await pollVideo("video_123", { intervalSeconds: 0, modelName: "agnes-video-2.5" }, {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl,
  });

  assert.equal(calls, 2);
  assert.equal(result.videoUrl, "https://example.com/result.mp4");
});
