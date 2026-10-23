/**
 * `agnes accounts list|check` command group (docs/multi-account-design.md §2.4/§5).
 *
 * `check --live` has two probes:
 *  - `--probe models` (default, free): GET {baseUrl}/models. IMPORTANT: the real
 *    gateway answers HTTP 200 for fabricated bearer tokens on this endpoint, so
 *    a successful probe only proves reachability, NOT credential validity.
 *  - `--probe text`: one minimal chat completion (max_tokens: 1) per account;
 *    a 2xx response proves the credential works. No image/video generation.
 *
 * Keys are never printed or stored; probe response bodies are drained, not shown.
 */
import type { Command } from "commander";
import type { ResolvedConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { DEFAULT_TEXT_MODEL } from "../models.js";
import { accountsSummary } from "./config.js";
import type { AccountConfig, RedactedAccountSummary } from "./types.js";

export interface AccountsCommandDeps {
  getResolved: () => ResolvedConfig;
}

export type ProbeKind = "models" | "text";

export const MODELS_PROBE_WARNING =
  "GET /v1/models is reachable without a valid credential on the real gateway; use --probe text to prove account access.";

interface LiveCheckResult {
  accountId: string;
  probe: ProbeKind;
  ok: boolean;
  /** models probe: HTTP status looked reachable. */
  reachable?: boolean;
  /** text probe: a 2xx chat-completions response proved the credential. */
  credentialValidated: boolean;
  httpStatus?: number;
  modelCount?: number;
  missingConfiguredModels: string[];
  /** text probe: model used for the proof request. */
  model?: string;
  error?: string;
}

export function registerAccountsCommands(program: Command, deps: AccountsCommandDeps): void {
  const accounts = program
    .command("accounts")
    .description("Inspect the configured multi-account pool")
    .addHelpText("after", `
Examples:
  agnes accounts list
  agnes accounts list --json
  agnes accounts check
  agnes accounts check --live
  agnes accounts check --live --probe text

Configuration (env): AGNES_ACCOUNTS, AGNES_ACCOUNT_<ID>_KEY/TYPE/POOL/WEIGHT/PRIORITY/MODELS/BASE_URL, or AGNES_ACCOUNTS_FILE.
Keys are never printed: only "present (len=N)" / "missing".

Note: "accounts check --live" defaults to the free GET /v1/models probe, which cannot
prove a credential (the gateway also answers it for fabricated tokens). Use
"accounts check --live --probe text" for a real credential proof (one max_tokens:1 chat call).
`);

  accounts
    .command("list")
    .description("List configured accounts and routing settings (redacted)")
    .option("--json", "Output JSON")
    .action((options) => {
      const resolved = deps.getResolved();
      const config = resolved.accountsConfig;
      const summary = accountsSummary(config);
      const live = resolved.router.summary();
      const liveById = new Map(live.accounts.map((account) => [account.id, account]));
      const accountsWithState: RedactedAccountSummary[] = summary.accounts.map((account) => {
        const state = liveById.get(account.id);
        return {
          ...account,
          ...(state
            ? {
                healthy: state.healthy,
                inflight: state.inflight,
                ...(state.coolingUntil !== undefined ? { coolingUntil: state.coolingUntil } : {}),
              }
            : {}),
        };
      });
      const payload = {
        ...summary,
        accounts: accountsWithState,
        pools: summary.pools,
        strategy: live.strategy,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const lines = [
        `strategy: ${payload.strategy}   rateLimit: ${payload.rateLimit ? "on" : "off"}${payload.source === "legacy" ? "   source: legacy" : ""}`,
        ...accountsWithState.map((account) => {
          const fields = [
            `${account.id}`.padEnd(8),
            `type=${account.type}`.padEnd(15),
            `pool=${account.poolId}`.padEnd(18),
            `weight=${account.weight} priority=${account.priority} concurrency=${account.concurrency}`,
            `key=${account.key}`,
            `source=${account.source}`,
          ];
          const flags = account.healthy ? [] : ["unhealthy"];
          if (account.coolingUntil !== undefined) flags.push("cooling");
          return flags.length > 0 ? `${fields.join(" ")} [${flags.join(",")}]` : fields.join(" ");
        }),
      ];
      if (accountsWithState.length === 0) lines.push("no accounts configured");
      if (payload.warnings.length > 0) {
        lines.push(`warnings: ${payload.warnings.length}`);
        for (const warning of payload.warnings) lines.push(`  - ${warning}`);
      }
      console.log(lines.join("\n"));
    });

  accounts
    .command("check")
    .description("Validate the account configuration; --live probes each account (--probe models|text)")
    .option("--live", "Probe each account (default probe: GET {baseUrl}/models, free but not a credential proof)")
    .option("--probe <probe>", "Live probe: models (reachability, free, default) | text (credential proof, 1 chat call)")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const resolved = deps.getResolved();
      const config = resolved.accountsConfig;
      const summary = accountsSummary(config);
      const configured = config.accounts.length > 0;
      const probeOption = typeof options.probe === "string" ? options.probe.trim().toLowerCase() : undefined;
      const probe = normalizeProbe(probeOption);
      // An explicit --probe implies --live; bare `check` stays config-only.
      const live = Boolean(options.live) || probeOption !== undefined;

      if (!live) {
        const payload = {
          ok: configured,
          configured,
          source: config.source === "legacy" ? "env" : config.source,
          strategy: config.strategy,
          pools: config.pools,
          live: false,
          accounts: summary.accounts.map((account) => ({
            accountId: account.id,
            ok: true,
            type: account.type,
            poolId: account.poolId,
            key: account.key,
            source: account.source,
          })),
          warnings: config.warnings,
        };
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else if (!configured) {
          console.log("AGNES_API_KEY is missing. Configure AGNES_API_KEY or AGNES_ACCOUNT_<ID>_KEY.");
        } else {
          const lines = config.accounts.map(
            (account) =>
              `${account.id.padEnd(8)} type=${account.type.padEnd(13)} pool=${account.poolId.padEnd(16)} key=present (len=${account.key.length}) source=${account.keySource}`,
          );
          lines.push(`accounts: ${config.accounts.length}   pools: ${config.pools.join(", ")}   strategy: ${config.strategy}`);
          for (const warning of config.warnings) lines.push(`warning: ${warning}`);
          console.log(lines.join("\n"));
        }
        if (!configured) process.exitCode = 1;
        return;
      }

      const warnings = [...config.warnings];
      if (probe === "models" && configured) warnings.push(MODELS_PROBE_WARNING);
      const results = await checkAccountsLive(config.accounts, resolved, probe);
      const ok = configured && results.every((result) => result.ok);
      const payload = {
        ok,
        configured,
        source: config.source === "legacy" ? "env" : config.source,
        strategy: config.strategy,
        pools: config.pools,
        live: true,
        probe,
        accounts: results,
        warnings,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (!configured) {
        console.log("AGNES_API_KEY is missing. Nothing to check.");
      } else if (probe === "models") {
        const lines = results.map((result) =>
          result.reachable
            ? `${result.accountId.padEnd(8)} reachable http=${result.httpStatus} models=${result.modelCount}${
                result.missingConfiguredModels.length > 0
                  ? ` missing=${result.missingConfiguredModels.join(",")}`
                  : ""
              }`
            : `${result.accountId.padEnd(8)} UNREACHABLE${result.httpStatus ? ` http=${result.httpStatus}` : ""}${result.error ? ` ${result.error}` : ""}`,
        );
        lines.push(
          `live check (models reachability only — NOT a credential proof): ${results.filter((result) => result.ok).length}/${results.length} reachable`,
        );
        console.log(lines.join("\n"));
        console.error(`warning: ${MODELS_PROBE_WARNING}`);
      } else {
        const lines = results.map((result) =>
          result.ok
            ? `${result.accountId.padEnd(8)} credential=valid http=${result.httpStatus} model=${result.model}`
            : `${result.accountId.padEnd(8)} credential=invalid${result.httpStatus ? ` http=${result.httpStatus}` : ""}${result.error ? ` ${result.error}` : ""}`,
        );
        lines.push(`live check (credential proof): ${results.filter((result) => result.ok).length}/${results.length} accounts valid`);
        console.log(lines.join("\n"));
      }
      if (!ok) process.exitCode = 1;
    });
}

function normalizeProbe(value: string | undefined): ProbeKind {
  if (value === undefined) return "models";
  if (value === "models" || value === "text") return value;
  throw new AgnesCliError(
    "INVALID_PROBE",
    `Unknown accounts check probe "${value}". Allowed: models, text.`,
    { allowed: ["models", "text"] },
    2,
  );
}

async function checkAccountsLive(
  accounts: AccountConfig[],
  resolved: ResolvedConfig,
  probe: ProbeKind,
): Promise<LiveCheckResult[]> {
  const results: LiveCheckResult[] = new Array(accounts.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= accounts.length) return;
      results[index] =
        probe === "text"
          ? await probeCredentialWithText(accounts[index], resolved)
          : await probeModelsEndpoint(accounts[index], resolved);
    }
  };
  // Concurrency 2; models probe is a GET, text probe is one max_tokens:1 chat
  // call per account. Neither sends image/video generation requests.
  await Promise.all([worker(), worker()]);
  return results;
}

/** Free reachability probe. On the real gateway this does NOT validate credentials. */
async function probeModelsEndpoint(account: AccountConfig, resolved: ResolvedConfig): Promise<LiveCheckResult> {
  const baseUrl = (account.baseUrl ?? resolved.baseUrl).replace(/\/$/, "");
  const url = `${baseUrl}/models`;
  try {
    const response = await resolved.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${account.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      return {
        accountId: account.id,
        probe: "models",
        ok: false,
        reachable: false,
        credentialValidated: false,
        httpStatus: response.status,
        missingConfiguredModels: [],
        error: `HTTP ${response.status}`,
      };
    }
    const raw = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(raw?.data)
      ? raw.data.map((entry) => entry?.id).filter((id): id is string => typeof id === "string")
      : [];
    const missingConfiguredModels = (account.models ?? []).filter((model) => !models.includes(model));
    return {
      accountId: account.id,
      probe: "models",
      ok: true,
      reachable: true,
      credentialValidated: false,
      httpStatus: response.status,
      modelCount: models.length,
      missingConfiguredModels,
    };
  } catch (error) {
    return {
      accountId: account.id,
      probe: "models",
      ok: false,
      reachable: false,
      credentialValidated: false,
      missingConfiguredModels: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Real credential proof: one minimal chat completion with the account key.
 * 2xx => the credential works; 401/403/402/other => invalid or unverified.
 */
async function probeCredentialWithText(account: AccountConfig, resolved: ResolvedConfig): Promise<LiveCheckResult> {
  const baseUrl = (account.baseUrl ?? resolved.baseUrl).replace(/\/$/, "");
  const model = account.models?.[0] ?? DEFAULT_TEXT_MODEL;
  try {
    const response = await resolved.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    // Never surface the body: only the status matters for validation.
    await response.text().catch(() => undefined);
    if (response.ok) {
      return {
        accountId: account.id,
        probe: "text",
        ok: true,
        credentialValidated: true,
        httpStatus: response.status,
        model,
        missingConfiguredModels: [],
      };
    }
    return {
      accountId: account.id,
      probe: "text",
      ok: false,
      credentialValidated: false,
      httpStatus: response.status,
      model,
      missingConfiguredModels: [],
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      accountId: account.id,
      probe: "text",
      ok: false,
      credentialValidated: false,
      model,
      missingConfiguredModels: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
