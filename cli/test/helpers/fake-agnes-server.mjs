/**
 * Shared offline fake Agnes API server used by the CLI / JS-API test suites.
 *
 * It implements only the endpoints this toolkit calls:
 *
 *   GET  /v1/models                    -> { object: "list", data: [{ id }] }
 *   POST /v1/chat/completions          -> OpenAI-style chat completion
 *   POST /v1/images/generations        -> { data: [{ url }] }
 *   POST /v1/videos                    -> creates an account-scoped video task
 *   GET  /agnesapi?video_id=&model_name= -> account-scoped video status
 *   GET  /v1/videos/:taskId            -> legacy account-scoped task status
 *
 * Behaviour that tests need to drive the router:
 *   - bearer key -> account mapping; unknown keys answer 401 (invalid token),
 *     exactly like the real gateway (auth is checked before resource lookup).
 *   - `modelsWithoutAuth: true` mimics the real gateway's `GET /v1/models`
 *     quirk: fabricated tokens also get HTTP 200 there, so the endpoint is a
 *     reachability check, not a credential proof.
 *   - per-account scripted 429s, optionally with a Retry-After header, scoped
 *     to creates, status lookups, or all requests.
 *   - per-account scripted hard statuses (401/402/403/500/...).
 *   - per-account latency (global or per account).
 *   - video ids are account-scoped: polling a video id with a different key
 *     answers 404 "task not found" (matching live probe P3 in
 *     docs/multi-account-research.md).
 *   - a full request log (`server.requests`) with method/path/pathname/query/
 *     headers/body/accountId/at, plus counting helpers.
 *   - manual video-status control for polling tests.
 *
 * Usage (plain node:test, no dependencies):
 *
 *   import { createFakeAgnesServer } from "../helpers/fake-agnes-server.mjs";
 *
 *   const server = await createFakeAgnesServer({
 *     accounts: [
 *       { key: "sk-test-a", id: "a", models: ["agnes-image-2.5-flash"] },
 *       { key: "sk-test-b", id: "b" },
 *     ],
 *   });
 *   server.rootUrl;  // http://127.0.0.1:PORT
 *   server.baseUrl;  // http://127.0.0.1:PORT/v1  (AGNES_BASE_URL / AGNES_ACCOUNT_X_BASE_URL)
 *   server.requests; // request log
 *   server.countRequests({ accountId: "a", pathIncludes: "/images/generations" });
 *   server.setRateLimit("sk-test-a", { times: 1, retryAfter: 1 });
 *   server.setForcedStatus("sk-test-a", 401);
 *   server.setVideoBehavior("video_1", { pollsToComplete: 2 });
 *   await server.close();
 *
 * Nothing here contains a real key; only fake `sk-test-*` values.
 */
import { createServer } from "node:http";

const DEFAULT_MODELS = [
  "agnes-2.5-flash",
  "agnes-3.0-flash",
  "agnes-image-2.5-flash",
  "agnes-image-2.1-flash",
  "agnes-video-2.5",
  "agnes-video-2.5-flash",
];

const DEFAULT_IMAGE_URL = "https://cdn.example.com/fake/output.png";

/**
 * @typedef {object} FakeAccountBehavior
 * @property {{times: number, remaining: number, retryAfter?: number|string, appliesTo?: "all"|"create"|"status"}|null} rateLimit
 * @property {number|null} forcedStatus
 * @property {number|null} delayMs
 * @property {string} chatContent
 * @property {string} imageUrl
 * @property {string} videoStatus
 * @property {number} pollsToComplete
 */

/**
 * Start a fake Agnes API server on an ephemeral localhost port.
 *
 * @param {object} [options]
 * @param {Array<{key: string, id?: string, models?: string[], behavior?: object, delayMs?: number}>} [options.accounts]
 *   Bearer keys that are considered valid. Each becomes an account; `id`
 *   defaults to `acct-1`, `acct-2`, ...
 * @param {number} [options.delayMs] default latency for every response
 * @param {string[]} [options.defaultModels] models returned when an account
 *   does not list its own
 * @param {boolean} [options.modelsWithoutAuth] when true, GET /models answers
 *   200 even for unknown bearer keys (mirrors the real gateway; used to test
 *   `agnes accounts check --live` semantics)
 */
export async function createFakeAgnesServer(options = {}) {
  /** @type {Map<string, any>} key -> account */
  const accounts = new Map();
  /** @type {Map<string, any>} videoId -> video record */
  const videos = new Map();
  /** @type {Array<object>} request log */
  const requests = [];
  /** @type {Map<string, any>} taskId -> video record */
  const videosByTask = new Map();
  let sequence = 0;
  const defaultModels = [...(options.defaultModels ?? DEFAULT_MODELS)];
  const globalDelayMs = options.delayMs ?? 0;
  const modelsWithoutAuth = options.modelsWithoutAuth === true;

  function registerAccount(account) {
    const id = account.id ?? `acct-${accounts.size + 1}`;
    const record = {
      key: account.key,
      id,
      models: [...(account.models ?? defaultModels)],
      behavior: {
        rateLimit: null,
        forcedStatus: null,
        delayMs: account.delayMs ?? null,
        chatContent: "pong",
        imageUrl: DEFAULT_IMAGE_URL,
        videoStatus: "queued",
        pollsToComplete: 1,
        ...(account.behavior ?? {}),
      },
    };
    accounts.set(account.key, record);
    return record;
  }

  for (const account of options.accounts ?? []) registerAccount(account);

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: { message: String(error?.stack ?? error) } });
    });
  });

  async function handleRequest(req, res) {
    const bodyText = await readBody(req);
    let body;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    const url = new URL(req.url ?? "/", rootUrl);
    const key = bearerToken(req.headers.authorization);
    const account = key ? accounts.get(key) : undefined;
    const entry = {
      method: (req.method ?? "GET").toUpperCase(),
      path: url.pathname,
      url: `${rootUrl}${req.url ?? "/"}`,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...req.headers },
      body,
      rawBody: bodyText,
      key,
      accountId: account?.id ?? null,
      keyRecognized: Boolean(account),
      at: Date.now(),
    };
    requests.push(entry);

    const delayMs = account?.behavior.delayMs ?? globalDelayMs;
    if (delayMs > 0) await sleep(delayMs);

    if (!account) {
      if (modelsWithoutAuth && entry.method === "GET" && /\/models$/.test(entry.path)) {
        sendJson(res, 200, {
          object: "list",
          data: defaultModels.map((id) => ({ id, object: "model", owned_by: "agnes" })),
        });
        return;
      }
      sendJson(res, 401, { error: { message: "Invalid token", type: "AgnesAI_error" } });
      return;
    }

    // Scripted 429 before any routing decisions.
    const rateLimit = account.behavior.rateLimit;
    if (rateLimit && rateLimit.remaining > 0 && rateLimitApplies(rateLimit, entry)) {
      rateLimit.remaining -= 1;
      /** @type {Record<string,string>} */
      const headers = {};
      if (rateLimit.retryAfter !== undefined) headers["retry-after"] = String(rateLimit.retryAfter);
      sendJson(res, 429, {
        error: {
          code: "",
          message: "You've reached the API rate limit for free users. Upgrade to a Token Plan.",
          type: "AgnesAI_error",
        },
      }, headers);
      return;
    }

    if (account.behavior.forcedStatus) {
      sendJson(res, account.behavior.forcedStatus, {
        error: { code: account.behavior.forcedStatus, message: scriptedErrorMessage(account.behavior.forcedStatus) },
      });
      return;
    }

    if (entry.path === "/agnesapi" && entry.method === "GET") {
      handleVideoStatus(res, account, entry);
      return;
    }
    if (entry.path.startsWith("/v1/agnesapi") && entry.method === "GET") {
      handleVideoStatus(res, account, entry);
      return;
    }
    if (/\/models$/.test(entry.path) && entry.method === "GET") {
      sendJson(res, 200, {
        object: "list",
        data: account.models.map((id) => ({ id, object: "model", owned_by: "agnes" })),
      });
      return;
    }
    if (/\/chat\/completions$/.test(entry.path) && entry.method === "POST") {
      sendJson(res, 200, {
        id: `chatcmpl_fake_${++sequence}`,
        object: "chat.completion",
        model: body?.model ?? "agnes-2.5-flash",
        choices: [{ index: 0, message: { role: "assistant", content: account.behavior.chatContent }, finish_reason: "stop" }],
      });
      return;
    }
    if (/\/images\/generations$/.test(entry.path) && entry.method === "POST") {
      sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: account.behavior.imageUrl }],
      });
      return;
    }
    if (/\/videos$/.test(entry.path) && entry.method === "POST") {
      handleVideoCreate(res, account, body);
      return;
    }
    if (/\/videos\/[^/]+$/.test(entry.path) && entry.method === "GET") {
      handleLegacyVideoStatus(res, account, entry);
      return;
    }
    sendJson(res, 404, { error: { code: 404, message: `fake server has no route ${entry.method} ${entry.path}` } });
  }

  function handleVideoCreate(res, account, body) {
    sequence += 1;
    const videoId = `video_${sequence}`;
    const taskId = `task_${sequence}`;
    const video = {
      videoId,
      taskId,
      key: account.key,
      accountId: account.id,
      model: body?.model ?? "agnes-video-2.5",
      status: account.behavior.videoStatus,
      polls: 0,
      pollsToComplete: account.behavior.pollsToComplete,
      videoUrl: `https://cdn.example.com/fake/${account.id}/${videoId}.mp4`,
    };
    videos.set(videoId, video);
    videosByTask.set(taskId, video);
    sendJson(res, 200, {
      id: taskId,
      task_id: taskId,
      video_id: videoId,
      model: video.model,
      status: "queued",
    });
  }

  function handleVideoStatus(res, account, entry) {
    const videoId = entry.query.video_id;
    const video = videoId ? videos.get(videoId) : undefined;
    if (!video || video.key !== account.key) {
      sendJson(res, 404, { error: { code: 404, message: `task not found for ${videoId}` } });
      return;
    }
    video.polls += 1;
    if (video.polls >= video.pollsToComplete) video.status = "completed";
    sendVideoStatus(res, video);
  }

  function handleLegacyVideoStatus(res, account, entry) {
    const taskId = entry.path.split("/").pop();
    const video = videosByTask.get(taskId);
    if (!video || video.key !== account.key) {
      sendJson(res, 400, { code: "task_not_exist", message: "task not found" });
      return;
    }
    video.polls += 1;
    if (video.polls >= video.pollsToComplete) video.status = "completed";
    sendVideoStatus(res, video);
  }

  function sendVideoStatus(res, video) {
    const status = video.status === "completed" ? "succeeded" : video.status;
    sendJson(res, 200, {
      id: video.taskId,
      task_id: video.taskId,
      video_id: video.videoId,
      model: video.model,
      status,
      ...(video.status === "completed"
        ? { completed_at: Math.floor(Date.now() / 1000), metadata: { url: video.videoUrl } }
        : {}),
    });
  }

  // Wait for the server to accept connections before building URLs.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const rootUrl = `http://127.0.0.1:${port}`;

  const api = {
    /** Base URL including the /v1 prefix (use as AGNES_BASE_URL). */
    get baseUrl() {
      return `${rootUrl}/v1`;
    },
    /** Server origin without /v1 (GET /agnesapi lives here). */
    get rootUrl() {
      return rootUrl;
    },
    get port() {
      return port;
    },
    /** Mutable request log; entries carry accountId + full request data. */
    requests,
    /** Alias kept for readability in attempt-oriented tests. */
    get attempts() {
      return requests;
    },
    /** Registered fake accounts (key + resolved behaviour). */
    get accounts() {
      return accounts;
    },
    /** Snapshot of account references without key material. */
    accountRefs() {
      return [...accounts.values()].map(({ key, id, models, behavior }) => ({
        key,
        id,
        models: [...models],
        behavior: { ...behavior, rateLimit: behavior.rateLimit ? { ...behavior.rateLimit } : null },
      }));
    },
    /** Add or replace an account after startup. */
    addAccount(account) {
      return registerAccount(account);
    },
    /** Merge a behaviour patch into one account (or all accounts when key omitted). */
    setAccountBehavior(key, patch = {}) {
      const targets = key ? [requireAccount(key)] : [...accounts.values()];
      for (const account of targets) {
        Object.assign(account.behavior, patch);
        if (patch.rateLimit && typeof patch.rateLimit.times === "number") {
          account.behavior.rateLimit = {
            appliesTo: "all",
            retryAfter: undefined,
            ...patch.rateLimit,
            remaining: patch.rateLimit.times,
          };
        }
        if (patch.rateLimit === null) account.behavior.rateLimit = null;
      }
    },
    /**
     * Make the next `times` matching requests answer 429.
     * @param {string} key
     * @param {{times?: number, retryAfter?: number|string, appliesTo?: "all"|"create"|"status"}} [config]
     */
    setRateLimit(key, config = {}) {
      const times = config.times ?? 1;
      api.setAccountBehavior(key, {
        rateLimit: {
          times,
          remaining: times,
          retryAfter: config.retryAfter,
          appliesTo: config.appliesTo ?? "all",
        },
      });
    },
    clearRateLimit(key) {
      api.setAccountBehavior(key, { rateLimit: null });
    },
    /** Force an HTTP status for every request on an account (null clears). */
    setForcedStatus(key, status) {
      api.setAccountBehavior(key, { forcedStatus: status ?? null });
    },
    /** Add latency for one account (or all accounts when key omitted). */
    setDelay(key, delayMs) {
      if (key) {
        requireAccount(key).behavior.delayMs = delayMs;
        return;
      }
      for (const account of accounts.values()) account.behavior.delayMs = delayMs;
    },
    /** Resolve an account id to its fake key (tests never hardcode keys twice). */
    keyForAccount(accountId) {
      for (const account of accounts.values()) {
        if (account.id === accountId) return account.key;
      }
      throw new Error(`fake server: unknown account id ${accountId}`);
    },
    /** Create/seed a video directly (as if another process created it). */
    addVideo({ key, accountId, videoId, taskId, model, status = "queued", pollsToComplete = 1 } = {}) {
      const account = key ? requireAccount(key) : requireAccountById(accountId);
      sequence = Math.max(sequence, numericSuffix(videoId), numericSuffix(taskId));
      const resolvedVideoId = videoId ?? `video_seed_${++sequence}`;
      const resolvedTaskId = taskId ?? `task_seed_${sequence}`;
      const video = {
        videoId: resolvedVideoId,
        taskId: resolvedTaskId,
        key: account.key,
        accountId: account.id,
        model: model ?? "agnes-video-2.5",
        status,
        polls: 0,
        pollsToComplete,
        videoUrl: `https://cdn.example.com/fake/${account.id}/${resolvedVideoId}.mp4`,
      };
      videos.set(resolvedVideoId, video);
      videosByTask.set(resolvedTaskId, video);
      return video;
    },
    getVideo(videoId) {
      return videos.get(videoId);
    },
    /** Mutate a video record: { status, pollsToComplete, videoUrl }. */
    setVideoBehavior(videoId, patch = {}) {
      const video = videos.get(videoId);
      if (!video) throw new Error(`fake server: unknown video id ${videoId}`);
      Object.assign(video, patch);
      return video;
    },
    setVideoStatus(videoId, status) {
      return api.setVideoBehavior(videoId, { status });
    },
    /** Count requests matching { method?, pathIncludes?, pathname?, accountId?, keyRecognized? }. */
    countRequests(filter = {}) {
      return requests.filter((entry) => matchesRequest(entry, filter)).length;
    },
    requestsFor(accountId, filter = {}) {
      return requests.filter((entry) => entry.accountId === accountId && matchesRequest(entry, filter));
    },
    lastRequest(filter = {}) {
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        if (matchesRequest(requests[index], filter)) return requests[index];
      }
      return undefined;
    },
    resetRequests() {
      requests.length = 0;
    },
    /** Restore all accounts/videos to a pristine state between assertions. */
    reset() {
      requests.length = 0;
      videos.clear();
      videosByTask.clear();
      sequence = 0;
      for (const account of accounts.values()) {
        account.behavior.rateLimit = null;
        account.behavior.forcedStatus = null;
        account.behavior.delayMs = null;
      }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };

  return api;

  function requireAccount(key) {
    const account = accounts.get(key);
    if (!account) throw new Error(`fake server: unknown key ${key}`);
    return account;
  }

  function requireAccountById(accountId) {
    for (const account of accounts.values()) {
      if (account.id === accountId) return account;
    }
    throw new Error(`fake server: unknown account id ${accountId}`);
  }
}

function rateLimitApplies(rateLimit, entry) {
  const appliesTo = rateLimit.appliesTo ?? "all";
  if (appliesTo === "all") return true;
  const isCreate = entry.method === "POST";
  if (appliesTo === "create") return isCreate;
  if (appliesTo === "status") return entry.method === "GET" && (entry.path === "/agnesapi" || entry.path.startsWith("/v1/videos/"));
  return true;
}

function matchesRequest(entry, filter) {
  if (filter.method && entry.method !== filter.method.toUpperCase()) return false;
  if (filter.accountId && entry.accountId !== filter.accountId) return false;
  if (filter.pathIncludes && !entry.path.includes(filter.pathIncludes)) return false;
  if (filter.pathname && entry.pathname !== filter.pathname) return false;
  if (filter.keyRecognized !== undefined && entry.keyRecognized !== filter.keyRecognized) return false;
  return true;
}

function bearerToken(header) {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

function numericSuffix(value) {
  if (typeof value !== "string") return 0;
  const match = /(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function scriptedErrorMessage(status) {
  if (status === 401) return "Invalid token";
  if (status === 402) return "Insufficient quota: Token Plan quota exhausted.";
  if (status === 403) return "Forbidden: model access denied for this credential.";
  if (status === 429) return "You've reached the API rate limit for free users.";
  return `Scripted HTTP ${status}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, value, headers = {}) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
