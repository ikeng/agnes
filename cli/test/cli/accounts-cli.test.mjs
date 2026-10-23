import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeAgnesServer } from "../helpers/fake-agnes-server.mjs";

/**
 * AC2/AC3/AC5 end-to-end: the real built CLI against the fake Agnes API.
 * Async spawn (never spawnSync) so the in-process fake server can answer.
 */
const CLI_BIN = fileURLToPath(new URL("../../bin/agnes.js", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-accounts-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    AGNES_NO_DOTENV: "1",
    AGNES_RATE_LIMIT: "off",
  };
}

function accountEnv(server, accounts, extra = {}) {
  const env = {
    ...baseEnv(),
    AGNES_ACCOUNTS: accounts.map((entry) => entry.id).join(","),
    ...extra,
  };
  for (const entry of accounts) {
    const prefix = `AGNES_ACCOUNT_${entry.id.toUpperCase()}`;
    env[`${prefix}_KEY`] = entry.key;
    env[`${prefix}_BASE_URL`] = server.baseUrl;
    env[`${prefix}_TYPE`] = entry.type ?? "free";
    env[`${prefix}_POOL`] = entry.pool ?? `pool-${entry.id}`;
  }
  return env;
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastJsonOutput(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    assert.ok(start >= 0, `no JSON object in stdout:\n${text}`);
    return JSON.parse(trimmed.slice(start + 1));
  }
}

test("real CLI: --version reports 0.3.0-local.1", async (t) => {
  const dir = tempDir(t);
  const result = await runCli(["--version"], { cwd: dir, env: baseEnv() });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "0.3.0-local.1");
});

test("real CLI: accounts list --json is redacted and lists pools", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b", models: ["agnes-2.5-flash"] }],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a", pool: "acct-main" },
    { id: "b", key: "sk-test-b", pool: "acct-backup", type: "tokenplan" },
  ], { AGNES_ROUTING_STRATEGY: "weighted" });
  const result = await runCli(["accounts", "list", "--json"], { cwd: dir, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.strategy, "weighted");
  assert.equal(payload.rateLimit, false);
  assert.equal(payload.source, "env");
  assert.deepEqual(payload.pools, ["acct-main", "acct-backup"]);
  assert.equal(payload.accounts.length, 2);
  assert.equal(payload.accounts[0].key, "present (len=9)");
  assert.equal(payload.accounts[1].type, "tokenplan");
  assert.ok(!result.stdout.includes("sk-test-a"));
  assert.ok(!result.stdout.includes("sk-test-b"));
  assert.ok(!/sk-[A-Za-z0-9]/.test(result.stdout));
});

test("real CLI: accounts check --live uses GET /v1/models only and exits 0", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a" },
    { id: "b", key: "sk-test-b" },
  ]);
  const result = await runCli(["accounts", "check", "--live", "--json"], { cwd: dir, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.live, true);
  assert.equal(payload.probe, "models");
  assert.deepEqual(payload.accounts.map((entry) => entry.accountId).sort(), ["a", "b"]);
  for (const entry of payload.accounts) {
    assert.equal(entry.probe, "models");
    assert.equal(entry.ok, true);
    assert.equal(entry.reachable, true);
    assert.equal(entry.credentialValidated, false, "models probe must never claim credential validation");
    assert.equal(entry.httpStatus, 200);
    assert.equal(entry.modelCount, 6);
  }
  assert.ok(
    payload.warnings.some((warning) => /reachable without a valid credential/.test(warning)),
    "models probe must warn that reachability is not credential proof",
  );
  assert.equal(server.countRequests({ method: "POST" }), 0, "check --live must never send generation requests");
  for (const request of server.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.pathname, "/v1/models");
  }
});

test("real CLI: accounts check --live exits 1 when one credential fails", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({ accounts: [{ key: "sk-test-a", id: "a" }] });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a" },
    { id: "b", key: "sk-test-invalid" },
  ]);
  const result = await runCli(["accounts", "check", "--live", "--json"], { cwd: dir, env });
  assert.equal(result.code, 1);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, false);
  const failed = payload.accounts.find((entry) => entry.accountId === "b");
  assert.equal(failed.ok, false);
  assert.equal(failed.reachable, false);
  assert.equal(failed.credentialValidated, false);
  assert.equal(failed.httpStatus, 401);
  assert.match(failed.error, /HTTP 401/);
});

test("real CLI: fabricated tokens can reach GET /v1/models — text probe is the real credential proof", async (t) => {
  const dir = tempDir(t);
  // Mimic the real gateway: /v1/models answers 200 for fabricated tokens too.
  const server = await createFakeAgnesServer({
    modelsWithoutAuth: true,
    accounts: [
      { key: "sk-test-valid", id: "valid", models: ["agnes-3.0-flash"] },
    ],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "valid", key: "sk-test-valid", pool: "pool-valid" },
    { id: "fabricated", key: "sk-fabricated-token", pool: "pool-fake" },
  ]);
  env.AGNES_ACCOUNT_VALID_MODELS = "agnes-3.0-flash";

  // 1) Default models probe: reachable for BOTH (including the fabricated key),
  //    but credentialValidated is false and the limitation is warned about.
  const modelsRun = await runCli(["accounts", "check", "--live", "--json"], { cwd: dir, env });
  assert.equal(modelsRun.code, 0, modelsRun.stderr);
  const modelsPayload = lastJsonOutput(modelsRun.stdout);
  assert.equal(modelsPayload.probe, "models");
  const fabricatedModels = modelsPayload.accounts.find((entry) => entry.accountId === "fabricated");
  assert.equal(fabricatedModels.ok, true);
  assert.equal(fabricatedModels.reachable, true);
  assert.equal(fabricatedModels.credentialValidated, false);
  assert.ok(modelsPayload.warnings.some((warning) => /--probe text/.test(warning)));
  assert.ok(server.requests.every((request) => request.method === "GET"));

  // 2) Text probe: fabricated token is rejected (401) => exit 1.
  server.resetRequests();
  const textRun = await runCli(["accounts", "check", "--live", "--probe", "text", "--json"], { cwd: dir, env });
  assert.equal(textRun.code, 1, textRun.stderr);
  const textPayload = lastJsonOutput(textRun.stdout);
  assert.equal(textPayload.probe, "text");
  assert.equal(textPayload.ok, false);
  const valid = textPayload.accounts.find((entry) => entry.accountId === "valid");
  assert.equal(valid.probe, "text");
  assert.equal(valid.ok, true);
  assert.equal(valid.credentialValidated, true);
  assert.equal(valid.httpStatus, 200);
  const fabricated = textPayload.accounts.find((entry) => entry.accountId === "fabricated");
  assert.equal(fabricated.ok, false);
  assert.equal(fabricated.credentialValidated, false);
  assert.equal(fabricated.httpStatus, 401);
  assert.match(fabricated.error, /HTTP 401/);

  // The proof request is one minimal chat completion per account, using the
  // account's first configured model; no image/video generation at all.
  const probes = server.requests.filter((request) => request.method === "POST");
  assert.equal(probes.length, 2);
  for (const probe of probes) {
    assert.equal(probe.pathname, "/v1/chat/completions");
    assert.deepEqual(probe.body.messages, [{ role: "user", content: "ping" }]);
    assert.equal(probe.body.max_tokens, 1);
  }
  assert.equal(server.lastRequest({ accountId: "valid" }).body.model, "agnes-3.0-flash");
  assert.equal(server.countRequests({ pathIncludes: "/images/" }), 0);
  assert.equal(server.countRequests({ pathIncludes: "/videos" }), 0);

  // 3) --probe implies --live; human models output warns on stderr.
  const human = await runCli(["accounts", "check", "--live"], { cwd: dir, env });
  assert.match(human.stderr, /warning: GET \/v1\/models is reachable without a valid credential/);
  assert.ok(!human.stdout.includes("sk-test-valid"));
  assert.ok(!human.stdout.includes("sk-fabricated-token"));
  assert.ok(!human.stderr.includes("sk-fabricated-token"));
});

test("real CLI: accounts check --probe text without --live still runs the credential probe", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({ accounts: [{ key: "sk-test-a", id: "a" }] });
  t.after(() => server.close());
  const env = accountEnv(server, [{ id: "a", key: "sk-test-a" }]);
  const result = await runCli(["accounts", "check", "--probe", "text", "--json"], { cwd: dir, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.live, true);
  assert.equal(payload.probe, "text");
  assert.equal(payload.accounts[0].credentialValidated, true);
});

test("real CLI: invalid --probe value exits 2 with INVALID_PROBE", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({ accounts: [{ key: "sk-test-a", id: "a" }] });
  t.after(() => server.close());
  const env = accountEnv(server, [{ id: "a", key: "sk-test-a" }]);
  const result = await runCli(["accounts", "check", "--live", "--probe", "generation", "--json"], { cwd: dir, env });
  assert.equal(result.code, 2, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.code, "INVALID_PROBE");
});

test("real CLI: invalid accounts config exits 2 with INVALID_ACCOUNTS_CONFIG", async (t) => {
  const dir = tempDir(t);
  const env = {
    ...baseEnv(),
    AGNES_ACCOUNT_A_KEY: "sk-test-a",
    AGNES_ACCOUNT_A_WEIGHT: "0",
  };
  const result = await runCli(["accounts", "list", "--json"], { cwd: dir, env });
  assert.equal(result.code, 2, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "INVALID_ACCOUNTS_CONFIG");
});

test("real CLI: env strategy round-robin distributes and --account pins", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a" },
    { id: "b", key: "sk-test-b" },
  ], { AGNES_ROUTING_STRATEGY: "round-robin" });

  // Round-robin state is per process (documented: no cross-process coordination),
  // so one invocation starts at the first configured account.
  const one = lastJsonOutput((await runCli(["text", "chat", "--prompt", "one", "--json"], { cwd: dir, env })).stdout);
  assert.equal(one.accountId, "a");
  assert.equal(one.routing.strategy, "round-robin");

  const pinned = lastJsonOutput(
    (await runCli(["--account", "b", "text", "chat", "--prompt", "pin", "--json"], { cwd: dir, env })).stdout,
  );
  assert.equal(pinned.accountId, "b");
  assert.equal(server.countRequests({ accountId: "a", pathIncludes: "chat/completions" }), 1);
  assert.equal(server.countRequests({ accountId: "b", pathIncludes: "chat/completions" }), 1);
});

test("real CLI: 429 failover produces routing provenance on stdout", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  server.setRateLimit("sk-test-a", { times: 1, retryAfter: 0, appliesTo: "create" });
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a" },
    { id: "b", key: "sk-test-b" },
  ], { AGNES_ROUTING_STRATEGY: "round-robin" });
  const result = await runCli(["text", "chat", "--prompt", "fail over", "--json"], { cwd: dir, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.accountId, "b");
  assert.equal(payload.routing.attempts, 2);
  assert.equal(payload.routing.fallback, true);
  assert.deepEqual(server.requests.map((request) => request.accountId).slice(0, 2), ["a", "b"]);
});

test("real CLI: video create→poll across processes keeps the same account via the journal", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  // Round-robin starts on b; the create may land on a or b, the poll must reuse it.
  const env = accountEnv(server, [
    { id: "b", key: "sk-test-b" },
    { id: "a", key: "sk-test-a" },
  ], {
    AGNES_ROUTING_STRATEGY: "round-robin",
    AGNES_STATE_DIR: join(dir, "state"),
  });

  const created = lastJsonOutput(
    (await runCli(["video", "text2video", "--prompt", "clip", "--json"], { cwd: dir, env })).stdout,
  );
  assert.ok(created.videoId);
  assert.equal(created.accountId, "b");

  const polled = lastJsonOutput(
    (await runCli(
      ["video", "poll", created.videoId, "--model", "agnes-video-2.5", "--interval", "1", "--timeout", "30", "--json"],
      { cwd: dir, env },
    )).stdout,
  );
  assert.equal(polled.status, "completed");
  assert.equal(polled.accountId, created.accountId);
  assert.ok(polled.videoUrl.endsWith(".mp4"));
  assert.equal(server.countRequests({ accountId: "a", pathname: "/agnesapi" }), 0);
  assert.ok(server.countRequests({ accountId: "b", pathname: "/agnesapi" }) >= 1);

  // Journal permissions survive the CLI process (design §3/§7).
  const { statSync } = await import("node:fs");
  const journal = join(dir, "state", "affinity.json");
  assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700);
  assert.equal(statSync(journal).mode & 0o777, 0o600);
  const { readFileSync } = await import("node:fs");
  assert.ok(!readFileSync(journal, "utf8").includes("sk-test"));
});

test("real CLI: legacy AGNES_API_KEY JSON gains routing fields and stdout stays key-free", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({ accounts: [{ key: "sk-test-legacy", id: "legacy" }] });
  t.after(() => server.close());
  const result = await runCli(["text", "chat", "--prompt", "hello", "--json"], {
    cwd: dir,
    env: { ...baseEnv(), AGNES_API_KEY: "sk-test-legacy", AGNES_BASE_URL: server.baseUrl, AGNES_RATE_LIMIT: "on" },
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = lastJsonOutput(result.stdout);
  assert.equal(payload.text, "pong");
  assert.equal(payload.accountId, "default");
  assert.equal(payload.poolId, "default");
  assert.deepEqual(payload.routing, { strategy: "primary", attempts: 1, waitedMs: 0, fallback: false });
  assert.ok(!result.stdout.includes("sk-test-legacy"));
  assert.ok(!result.stderr.includes("sk-test-legacy"));
});

test("real CLI: generated outputs never leak key material", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a" },
    { id: "b", key: "sk-test-b" },
  ]);
  const outputs = [];
  for (const args of [
    ["accounts", "list"],
    ["accounts", "list", "--json"],
    ["accounts", "check", "--live", "--json"],
    ["text", "chat", "--prompt", "leak check", "--json"],
    ["text", "chat", "--prompt", "leak check"],
  ]) {
    const result = await runCli(args, { cwd: dir, env });
    outputs.push(result.stdout, result.stderr);
  }
  for (const output of outputs) {
    assert.ok(!/sk-[A-Za-z0-9_-]{4,}/.test(output), `key material leaked in output: ${output}`);
  }
});

test("real CLI: --affinity session sticks across invocations", async (t) => {
  const dir = tempDir(t);
  const server = await createFakeAgnesServer({
    accounts: [{ key: "sk-test-a", id: "a" }, { key: "sk-test-b", id: "b" }],
  });
  t.after(() => server.close());
  const env = accountEnv(server, [
    { id: "a", key: "sk-test-a" },
    { id: "b", key: "sk-test-b" },
  ], {
    AGNES_ROUTING_STRATEGY: "round-robin",
    AGNES_STATE_DIR: join(dir, "state"),
  });
  const first = lastJsonOutput(
    (await runCli(["text", "chat", "--prompt", "one", "--affinity", "demo", "--json"], { cwd: dir, env })).stdout,
  );
  const second = lastJsonOutput(
    (await runCli(["text", "chat", "--prompt", "two", "--affinity", "demo", "--json"], { cwd: dir, env })).stdout,
  );
  assert.equal(first.accountId, "a");
  assert.equal(second.accountId, "a", "session affinity must keep the first account");
});
