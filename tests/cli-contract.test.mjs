// Repo test: offline CLI contract for the patched agnes-ai-cli build.
//
// Covers help/version/models/auth, JSON error envelopes, media passthrough,
// image/video payload normalization, poll URL construction, request retry
// policy, and CLI .env.local autoload. No network calls, no API costs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TEST_DIR);
const CLI = path.join(ROOT, "cli", "bin", "agnes.js");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "cli", "package.json"), "utf8"));

let checks = 0;
let failures = 0;
async function check(name, fn) {
  checks += 1;
  process.stdout.write(`  - ${name} ... `);
  try {
    const detail = await fn();
    process.stdout.write("ok\n");
    if (detail) process.stdout.write(`      ${detail}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write("FAIL\n");
    process.stdout.write(`      ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "agnes-cli-contract-"));
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const key of ["AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_MEDIA_PROVIDER_ORDER", "AGNES_ENV_FILE", "AGNES_HTTP_TIMEOUT_MS"]) {
    if (!(key in extra)) delete env[key];
  }
  if (!("AGNES_NO_DOTENV" in extra)) env.AGNES_NO_DOTENV = "1";
  return env;
};
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: TMP,
    encoding: "utf8",
    env: cleanEnv(extraEnv),
  });
}
function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`not JSON (exit=${result.status}): ${result.stdout.slice(0, 200)} stderr=${result.stderr.slice(0, 200)}`);
  }
}

const imageMod = await import(pathToFileURL(path.join(ROOT, "cli", "dist", "image", "normalizeImageRequest.js")));
const videoMod = await import(pathToFileURL(path.join(ROOT, "cli", "dist", "video", "normalizeVideoRequest.js")));
const getVideoMod = await import(pathToFileURL(path.join(ROOT, "cli", "dist", "video", "getVideo.js")));
const requestJsonMod = await import(pathToFileURL(path.join(ROOT, "cli", "dist", "http", "requestJson.js")));

try {
  await check("agnes --version matches cli/package.json", () => {
    const result = run(["--version"]);
    assert(result.status === 0, `exit ${result.status}`);
    assert(result.stdout.trim() === PKG.version, `got ${result.stdout.trim()}, want ${PKG.version}`);
    return PKG.version;
  });

  await check("agnes --help lists the agent-facing command groups", () => {
    const result = run(["--help"]);
    assert(result.status === 0, `exit ${result.status}`);
    for (const word of ["auth", "media", "models", "text", "image", "video"]) {
      assert(result.stdout.includes(word), `missing command group ${word}`);
    }
    return "auth/media/models/text/image/video";
  });

  await check("models --json exposes defaults and deprecated/retired markers", () => {
    const result = run(["models", "--json"]);
    assert(result.status === 0, `exit ${result.status}`);
    const catalog = parseJson(result);
    assert(catalog.text.default === "agnes-2.5-flash", `text default ${catalog.text.default}`);
    assert(catalog.image.default === "agnes-image-2.5-flash", `image default ${catalog.image.default}`);
    assert(catalog.video.default === "agnes-video-2.5", `video default ${catalog.video.default}`);
    const text20 = catalog.text.models.find((entry) => entry.id === "agnes-2.0-flash");
    const video20 = catalog.video.models.find((entry) => entry.id === "agnes-video-v2.0");
    assert(text20 && text20.status === "deprecated", "2.0-flash not deprecated");
    assert(video20 && video20.status === "retired", "video v2.0 not retired");
    return "defaults + statuses OK";
  });

  await check("help text matches the patched defaults/flags", () => {
    const textHelp = run(["text", "chat", "--help"]).stdout;
    assert(textHelp.includes("agnes-2.5-flash"), "text help lacks 2.5-flash default");
    assert(!/default when[^\n]*agnes-2\.0-flash/i.test(textHelp), "text help claims 2.0 default");
    const imageHelp = run(["image", "text2img", "--help"]).stdout;
    for (const word of ["agnes-image-2.5-flash", "--size", "--ratio"]) assert(imageHelp.includes(word), `image help lacks ${word}`);
    const videoHelp = run(["video", "text2video", "--help"]).stdout;
    for (const word of ["--model", "--seconds", "--size", "--aspect-ratio", "agnes-video-2.5"]) {
      assert(videoHelp.includes(word), `video help lacks ${word}`);
    }
    const pollHelp = run(["video", "poll", "--help"]).stdout;
    assert(pollHelp.includes("--model"), "poll help lacks --model");
    assert(pollHelp.includes("model_name"), "poll help should mention model_name");
    return "text/image/video/poll help OK";
  });

  await check("auth check missing key exits 1 with JSON", () => {
    const result = run(["auth", "check", "--json"]);
    assert(result.status === 1, `exit ${result.status}`);
    const body = parseJson(result);
    assert(body.configured === false, "configured should be false");
    assert(body.ok === false, "ok should be false");
    return "exit 1 + JSON";
  });

  await check("commander validation errors exit 1 (JSON envelope where implemented)", () => {
    const missing = run(["image", "text2img", "--json"]);
    assert(missing.status === 1, `missing prompt exit ${missing.status}`);
    // Known gap: commander-level errors may bypass the JSON envelope. Accept
    // either the JSON envelope (preferred) or a clear stderr message, but the
    // command must fail with exit 1.
    let missingJson = null;
    try {
      missingJson = JSON.parse(missing.stdout);
    } catch {
      missingJson = null;
    }
    if (missingJson) {
      assert(missingJson.ok === false && typeof missingJson.code === "string", "JSON error envelope malformed");
    } else {
      assert(/required option/i.test(missing.stderr), `unexpected stderr: ${missing.stderr.slice(0, 120)}`);
    }
    const badTtl = run(["media", "url", "https://example.com/a.png", "--ttl", "5m", "--json"]);
    assert(badTtl.status === 1, `bad ttl exit ${badTtl.status}`);
    const ttlBody = parseJson(badTtl);
    assert(ttlBody.ok === false && ttlBody.code === "INVALID_ARGUMENTS", "bad-ttl error not JSON envelope");
    return missingJson ? "required-option JSON envelope present" : "required-option plain stderr (known gap); ttl JSON OK";
  });

  await check("media url passthrough requires no network", () => {
    const result = run(["media", "url", "https://example.com/probe.png", "--json"]);
    assert(result.status === 0, `exit ${result.status}`);
    const body = parseJson(result);
    assert(body.ok === true && body.url === "https://example.com/probe.png" && body.source === "passthrough", "passthrough failed");
    return "passthrough OK";
  });

  await check("image normalization: 2.5 default, default size, ratio", () => {
    const parsed = imageMod.imageGenerateSchema.parse({ mode: "text2img", prompt: "x" });
    const payload = imageMod.normalizeImageRequest(parsed, []);
    assert(payload.model === "agnes-image-2.5-flash", `model ${payload.model}`);
    assert(payload.size === "1024x1024", `size ${payload.size}`);
    assert(payload.prompt === "x", "prompt missing");
    const withRatio = imageMod.normalizeImageRequest(
      imageMod.imageGenerateSchema.parse({ mode: "text2img", prompt: "x", size: "2K", ratio: "16:9" }),
      [],
    );
    assert(withRatio.ratio === "16:9" && withRatio.size === "2K", "ratio/size not forwarded");
    const img2img = imageMod.normalizeImageRequest(
      imageMod.imageGenerateSchema.parse({ mode: "img2img", prompt: "x", image: "https://example.com/a.png" }),
      ["https://example.com/a.png"],
    );
    assert(Array.isArray(img2img.extra_body?.image), "img2img extra_body.image missing");
    let ratio20Rejected = false;
    try {
      imageMod.normalizeImageRequest(
        imageMod.imageGenerateSchema.parse({ mode: "text2img", prompt: "x", model: "agnes-image-2.0-flash", ratio: "16:9" }),
        [],
      );
    } catch {
      ratio20Rejected = true;
    }
    assert(ratio20Rejected, "ratio should be rejected for image 2.0");
    return "text2img/img2img/2.0 ratio guard OK";
  });

  await check("video normalization: Video 2.5 payload shapes", () => {
    const text = videoMod.normalizeVideoRequest(videoMod.videoGenerateSchema.parse({ mode: "text2video", prompt: "x" }), []);
    assert(text.model === "agnes-video-2.5" && text.mode === "text" && text.seconds === "5", "text2video payload");
    const img = videoMod.normalizeVideoRequest(
      videoMod.videoGenerateSchema.parse({ mode: "img2video", prompt: "x", image: "https://example.com/f.png" }),
      ["https://example.com/f.png"],
    );
    assert(img.mode === "keyframe" && img.first_frame === "https://example.com/f.png", "img2video should map to keyframe/first_frame");
    const multi = videoMod.normalizeVideoRequest(
      videoMod.videoGenerateSchema.parse({ mode: "multivideo", prompt: "x", images: ["a", "b"] }),
      ["https://example.com/a.png", "https://example.com/b.png"],
    );
    assert(multi.mode === "reference" && Array.isArray(multi.images) && multi.images.length === 2, "multivideo should map to reference/images");
    const keyframes = videoMod.normalizeVideoRequest(
      videoMod.videoGenerateSchema.parse({ mode: "keyframes", prompt: "x", images: ["a", "b"] }),
      ["https://example.com/a.png", "https://example.com/b.png"],
    );
    assert(keyframes.mode === "keyframe" && keyframes.first_frame && keyframes.last_frame, "keyframes first/last missing");
    const flash = videoMod.normalizeVideoRequest(
      videoMod.videoGenerateSchema.parse({ mode: "text2video", prompt: "x", model: "agnes-video-2.5-flash" }),
      [],
    );
    assert(flash.size === "720P", `flash size ${flash.size}`);
    return "text/keyframe/reference/first-last/flash OK";
  });

  await check("video legacy v2.0 remains explicit-only and mutually exclusive", () => {
    const legacy = videoMod.normalizeVideoRequest(
      videoMod.videoGenerateSchema.parse({ mode: "text2video", prompt: "x", model: "agnes-video-v2.0", width: 640, numFrames: 121 }),
      [],
    );
    assert(legacy.model === "agnes-video-v2.0" && legacy.num_frames === 121, "legacy v2.0 payload broken");
    let rejected = false;
    try {
      videoMod.normalizeVideoRequest(
        videoMod.videoGenerateSchema.parse({ mode: "text2video", prompt: "x", model: "agnes-video-2.5", numFrames: 121 }),
        [],
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "Video 2.5 accepted legacy --num-frames");
    return "legacy escape hatch OK";
  });

  await check("video get builds model_name poll URL and keeps legacy task path", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "task_1", video_id: "video_1", status: "completed", url: "https://example.com/v.mp4" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await getVideoMod.getVideo("video_1", { modelName: "agnes-video-2.5" }, { apiKey: "sk-test-key", fetchImpl });
    assert(result.status === "completed" && result.videoUrl === "https://example.com/v.mp4", "completed response normalization");
    assert(calls[0].includes("video_id=video_1") && calls[0].includes("model_name=agnes-video-2.5"), `poll URL lacks model_name: ${calls[0]}`);
    await getVideoMod.getVideo("task_abc", {}, { apiKey: "sk-test-key", fetchImpl });
    assert(calls[1].includes("/videos/task_abc"), `legacy task URL wrong: ${calls[1]}`);
    return "model_name + legacy endpoint OK";
  });

  await check("request retry policy: POST not retried, GET retried with timeout signal", async () => {
    let postAttempts = 0;
    let getAttempts = 0;
    let getSignal;
    const postFetch = async () => {
      postAttempts += 1;
      throw new Error("ECONNRESET");
    };
    const getFetch = async (url, init) => {
      getAttempts += 1;
      getSignal = init.signal;
      throw new Error("ECONNRESET");
    };
    let postFailed = false;
    try {
      await requestJsonMod.requestJson(postFetch, "https://example.com/x", { method: "POST", body: "{}" }, { retryDelayMs: 1 });
    } catch {
      postFailed = true;
    }
    assert(postFailed && postAttempts === 1, `POST attempts ${postAttempts}`);
    let getFailed = false;
    try {
      await requestJsonMod.requestJson(getFetch, "https://example.com/x", { method: "GET" }, { retryDelayMs: 1 });
    } catch {
      getFailed = true;
    }
    assert(getFailed && getAttempts === 3, `GET attempts ${getAttempts}`);
    assert(getSignal, "GET request had no timeout signal");
    return `POST=${postAttempts} GET=${getAttempts} signal present`;
  });

  await check("CLI autoloads .env.local and honors AGNES_NO_DOTENV", () => {
    writeFileSync(path.join(TMP, ".env.local"), "AGNES_API_KEY=sk-fake-autoload-test-key-0000\n");
    const autoEnv = cleanEnv();
    delete autoEnv.AGNES_NO_DOTENV;
    const autoResult = spawnSync(process.execPath, [CLI, "auth", "check", "--json"], { cwd: TMP, encoding: "utf8", env: autoEnv });
    assert(autoResult.status === 0, `autoload auth exit ${autoResult.status}: ${autoResult.stderr}`);
    const autoBody = parseJson(autoResult);
    assert(autoBody.configured === true, "autoload did not configure the key");
    const noDotenv = run(["auth", "check", "--json"]);
    assert(noDotenv.status === 1, `AGNES_NO_DOTENV exit ${noDotenv.status}`);
    assert(parseJson(noDotenv).configured === false, "AGNES_NO_DOTENV did not disable autoload");
    rmSync(path.join(TMP, ".env.local"), { force: true });
    return "autoload + opt-out OK";
  });
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`  => ${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
