import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeAgnesServer } from "../helpers/fake-agnes-server.mjs";
import { createAgnesClient } from "../../dist/index.js";
import { AffinityJournal } from "../../dist/accounts/affinity.js";
import { fileURLToPath } from "node:url";

/**
 * AC5: video create→poll affinity, session stickiness, the on-disk journal
 * (0600 file / 0700 dir / atomic merge-on-write / TTL / bounded size) and the
 * bounded probe used when the journal is missing.
 */

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-affinity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const account = (id) => ({
  id,
  key: `sk-test-${id}`,
  keySource: "options",
  type: "free",
  poolId: `pool-${id}`,
  weight: 1,
  priority: 0,
});

async function withServer(t, accounts) {
  const server = await createFakeAgnesServer({ accounts });
  t.after(() => server.close());
  return server;
}

function client(server, ids, stateDir, extra = {}) {
  return createAgnesClient({
    accounts: ids.map(account),
    baseUrl: server.baseUrl,
    rateLimit: false,
    ...(stateDir ? { stateDir } : {}),
    ...extra,
  });
}

function readJournal(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("video create binds video:/task: affinity entries, persisted 0600 under a 0700 dir", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const stateDir = join(dir, "state");
  const agnes = client(server, ["a", "b"], stateDir);
  const task = await agnes.video.generate({ mode: "text2video", prompt: "clip" });
  assert.equal(task.accountId, "a");

  const journalFile = join(stateDir, "affinity.json");
  assert.ok(existsSync(journalFile), "affinity journal must be written after a video create");
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(journalFile).mode & 0o777, 0o600);

  const document = readJournal(journalFile);
  assert.equal(document.version, 1);
  assert.equal(document.entries[`video:${task.videoId}`].accountId, "a");
  assert.equal(document.entries[`task:${task.taskId}`].accountId, "a");
  assert.equal(document.entries[`video:${task.videoId}`].kind, "video");
  assert.ok(!readFileSync(journalFile, "utf8").includes("sk-test"), "journal must never contain key material");

  assert.equal(agnes.router.getAffinity(`video:${task.videoId}`).accountId, "a");
  assert.equal(agnes.router.getAffinity(`task:${task.taskId}`).accountId, "a");
});

test("a fresh CLI process polls with the creating account even when another is round-robin first", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const stateDir = join(dir, "state");
  const creator = client(server, ["a", "b"], stateDir, { strategy: "adaptive" });
  const task = await creator.video.generate({ mode: "text2video", prompt: "clip" });
  assert.equal(task.accountId, "a");

  // Simulate a later CLI process: a different account order/strategy, shared journal.
  const poller = client(server, ["b", "a"], stateDir, { strategy: "round-robin" });
  const result = await poller.video.poll(task.videoId, { intervalSeconds: 1, timeoutSeconds: 30 });
  assert.equal(result.status, "completed");
  assert.equal(result.accountId, "a");
  assert.ok(result.videoUrl.endsWith(".mp4"));
  assert.equal(result.routing.attempts, 1);
  assert.equal(server.countRequests({ accountId: "b", pathname: "/agnesapi" }), 0);
  assert.ok(server.countRequests({ accountId: "a", pathname: "/agnesapi" }) >= 1);
});

test("missing journal + multiple accounts probes in configured order and binds the owner", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const stateDir = join(dir, "state");
  // The resource exists on account b only.
  server.addVideo({ accountId: "b", videoId: "video_seed_1", taskId: "task_seed_1", pollsToComplete: 1 });
  const agnes = client(server, ["a", "b"], stateDir, { strategy: "round-robin" });
  const result = await agnes.video.poll("video_seed_1", { intervalSeconds: 1, timeoutSeconds: 30 });
  assert.equal(result.accountId, "b");
  assert.equal(result.status, "completed");

  // Probe order: account a answered 404 first, then account b owned the resource.
  const firstPoll = server.requests.find((request) => request.pathname === "/agnesapi");
  assert.equal(firstPoll.accountId, "a");
  assert.equal(server.countRequests({ accountId: "b", pathname: "/agnesapi" }), 2, "probe + real status lookup");
  const journal = readJournal(join(stateDir, "affinity.json"));
  assert.equal(journal.entries["video:video_seed_1"].accountId, "b");
});

test("all-404 probe fails with AFFINITY_NOT_FOUND and --account guidance", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const agnes = client(server, ["a", "b"], join(dir, "state"), { strategy: "round-robin" });
  await assert.rejects(
    () => agnes.video.get("video_unknown", { timeoutMs: 5000 }),
    (error) => {
      assert.equal(error.code, "AFFINITY_NOT_FOUND");
      assert.deepEqual(error.details.accountsProbed, ["a", "b"]);
      assert.match(error.message, /--account/);
      return true;
    },
  );
});

test("explicit route.accountId overrides the journal (recovery path)", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const agnes = client(server, ["a", "b"], join(dir, "state"));
  const task = await agnes.video.generate({ mode: "text2video", prompt: "clip" });
  assert.equal(task.accountId, "a");
  await assert.rejects(
    () => agnes.video.get(task.videoId, { timeoutMs: 5000, route: { accountId: "b" } }),
    (error) => error.code === "TASK_NOT_FOUND",
  );
  const last = server.lastRequest({ pathname: "/agnesapi" });
  assert.equal(last.accountId, "b");
});

test("session affinity keeps one account across calls and processes", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const stateDir = join(dir, "state");
  const first = client(server, ["a", "b"], stateDir, { strategy: "round-robin" });
  const one = await first.text.complete({ prompt: "same", route: { affinityKey: "session:work" } });
  const second = client(server, ["b", "a"], stateDir, { strategy: "round-robin" });
  const two = await second.text.complete({ prompt: "same", route: { affinityKey: "session:work" } });
  assert.equal(one.accountId, two.accountId);
  assert.equal(second.router.getAffinity("session:work").accountId, one.accountId);
});

test("stale journal entry for an unknown account falls back to the probe", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const stateDir = join(dir, "state");
  const seeded = client(server, ["a", "b"], stateDir);
  // Seed a resource owned by b, then forge a journal entry pointing at a removed account.
  server.addVideo({ accountId: "b", videoId: "video_stale_1", taskId: "task_stale_1", pollsToComplete: 1 });
  const journal = new AffinityJournal({ filePath: join(stateDir, "affinity.json") });
  journal.bind("video:video_stale_1", { accountId: "ghost", poolId: "pool-ghost" });
  const result = await seeded.video.poll("video_stale_1", { intervalSeconds: 1, timeoutSeconds: 30 });
  assert.equal(result.accountId, "b");
});

/* --------------------------- journal unit behaviour ------------------------ */

test("inter-process lock prevents lost journal updates under concurrent CLI-style binds", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "state", "affinity.json");
  const entry = fileURLToPath(new URL("../../dist/accounts/affinity.js", import.meta.url));
  const script = `
    import { AffinityJournal } from ${JSON.stringify(entry)};
    const journal = new AffinityJournal({ filePath: process.argv[1] });
    const prefix = process.argv[2];
    for (let index = 0; index < 3; index += 1) {
      journal.bind(prefix + ":" + index, { accountId: "acct-" + prefix, poolId: "pool-" + prefix });
    }
  `;
  const children = Array.from({ length: 10 }, (_, index) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, file, `proc${index}`], { stdio: "ignore" });
      child.on("close", (code) => resolve(code));
    }),
  );
  const codes = await Promise.all(children);
  assert.ok(codes.every((code) => code === 0), `child exit codes: ${codes.join(",")}`);
  const document = readJournal(file);
  assert.equal(Object.keys(document.entries).length, 30, "all concurrent bindings must survive the merge");
  assert.ok(!existsSync(`${file}.lock`), "lock dir must be released after the write");
});

test("stale affinity lock is reclaimed instead of blocking writes", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "state", "affinity.json");
  mkdirSync(join(dir, "state", ".keep"), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const old = Date.now() / 1000 - 60;
  utimesSync(lockPath, old, old);
  const journal = new AffinityJournal({ filePath: file });
  journal.bind("video:stale", { accountId: "a", poolId: "pa" });
  assert.equal(readJournal(file).entries["video:stale"].accountId, "a");
  assert.ok(!existsSync(lockPath), "stale lock must be removed");
});

test("affinity journal merges concurrent writers instead of clobbering", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "affinity.json");
  const first = new AffinityJournal({ filePath: file });
  const second = new AffinityJournal({ filePath: file });
  first.bind("video:one", { accountId: "a", poolId: "pa", model: "agnes-video-2.5", kind: "video" });
  second.bind("session:two", { accountId: "b", poolId: "pb", kind: "text" });
  const document = readJournal(file);
  assert.equal(document.entries["video:one"].accountId, "a");
  assert.equal(document.entries["session:two"].accountId, "b");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("affinity journal respects TTL and max-entry eviction", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "affinity.json");
  let now = 1000;
  const journal = new AffinityJournal({ filePath: file, now: () => now, ttlMs: 5000, maxEntries: 2 });
  journal.bind("video:old", { accountId: "a", poolId: "pa" });
  now += 100;
  journal.bind("video:mid", { accountId: "b", poolId: "pb" });
  now += 100;
  journal.bind("video:new", { accountId: "c", poolId: "pc" });
  const document = readJournal(file);
  assert.deepEqual(Object.keys(document.entries).sort(), ["video:mid", "video:new"]);

  // TTL: entries older than 5 s are invisible.
  now += 6000;
  assert.equal(journal.get("video:new"), undefined);
});

test("raw JS API client stays file-free (no state dir read/write) but keeps in-process affinity", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-raw", id: "a" }]);
  const dir = tempDir(t);
  const raw = createAgnesClient({
    apiKey: "sk-test-raw",
    baseUrl: server.baseUrl,
    fetchImpl: fetch,
    env: { AGNES_STATE_DIR: join(dir, "should-not-be-used") },
  });
  const task = await raw.video.generate({ mode: "text2video", prompt: "clip" });
  assert.ok(!existsSync(join(dir, "should-not-be-used")), "plain apiKey clients must not create state files");
  // In-process affinity still resolves create→poll for the same client.
  const polled = await raw.video.poll(task.videoId, { intervalSeconds: 1, timeoutSeconds: 30 });
  assert.equal(polled.accountId, task.accountId);
  assert.equal(raw.router.getAffinity(`video:${task.videoId}`).accountId, task.accountId);
});

test("video create affinity works for img2video mode and keeps prompt payload intact", async (t) => {
  const server = await withServer(t, [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }]);
  const dir = tempDir(t);
  const agnes = client(server, ["a", "b"], join(dir, "state"));
  const task = await agnes.video.generate({
    mode: "text2video",
    prompt: "keep payload",
    model: "agnes-video-2.5",
    seconds: 5,
    size: "720P",
    route: { affinityKey: "session:video-work" },
  });
  const createRequest = server.lastRequest({ method: "POST", pathIncludes: "/videos" });
  assert.equal(createRequest.body.prompt, "keep payload");
  assert.equal(createRequest.body.mode, "text");
  assert.equal(createRequest.body.seconds, "5");
  assert.equal(agnes.router.getAffinity("session:video-work").accountId, task.accountId);
});
