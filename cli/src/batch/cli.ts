/**
 * `agnes batch` command group (design contract: docs/multi-account-design.md §6).
 *
 * Wiring contract for cli/src/cli.ts:
 *   registerBatchCommands(program, () => client)
 *
 * This file is intentionally the only integration point: the core CLI never
 * imports the runner directly.
 */
import type { Command } from "commander";
import { printJson, printLines } from "../output.js";
import { cliDefaultsFromFlags, parseConsistencyOption, parseStrategyOption } from "./input.js";
import { batchStatus, retryBatch, runBatch, type BatchStatusReport } from "./runner.js";
import type {
  BatchRetryOptions,
  BatchRunOptions,
  BatchRunOutcome,
  AgnesClientLike,
} from "./types.js";

export type { AgnesClientLike };

export function registerBatchCommands(program: Command, getClient: () => AgnesClientLike): void {
  const batch = program
    .command("batch")
    .description("Run reproducible batch production jobs across the configured account pool")
    .addHelpText("after", `
Examples:
  agnes batch run jobs.json --out ./out
  agnes batch run jobs.jsonl --out ./out --concurrency 4 --consistency strict
  agnes batch status ./out --json
  agnes batch retry ./out --only failed

Input: JSON object with {batchId, consistency, defaults, defaultsByKind, jobs} or JSONL (one job per line).
Defaults: flat "defaults" are kind-aware (a "model" default is only used for kinds whose model catalog contains it,
otherwise that kind's built-in model is used); "defaultsByKind": {image,video,text} overrides flat defaults per kind.
Each manifest job records model + modelSource (job | defaults | kind-default).
Artifacts: manifest.json, input.json, events.jsonl, results/<id>.json in the output directory.
Resume: re-run with --resume to skip succeeded jobs without creating new tasks.
Exit codes: 0 = all succeeded/skipped, 1 = one or more jobs failed, 2 = invalid input/config.
`);

  batch
    .command("run")
    .description("Validate and run a batch job file")
    .argument("<file>", "JSON object or JSONL batch input file")
    .requiredOption("--out <dir>", "Output directory for manifest/results/events")
    .option("--concurrency <n>", "Maximum concurrent jobs (default 4)", parseInteger)
    .option("--consistency <mode>", "record | strict (overrides input)")
    .option("--strategy <name>", "Routing strategy override")
    .option("--account <id>", "Force one account for the whole batch (implies strict)")
    .option("--max-attempts <n>", "Maximum attempts per job (default 2)", parseInteger)
    .option("--poll-interval <ms>", "Video poll interval floor in milliseconds", parseInteger)
    .option("--poll-timeout <ms>", "Video poll budget in milliseconds", parseInteger)
    .option("--model <model>", "Default model for JSONL input (JSON `defaults` wins)")
    .option("--size <size>", "Default image/video size for JSONL input")
    .option("--ratio <ratio>", "Default image ratio for JSONL input")
    .option("--seconds <n>", "Default video duration for JSONL input", parseInteger)
    .option("--ttl <ttl>", "Default temporary upload TTL for JSONL input")
    .option("--resume", "Resume an existing output directory")
    .option("--force", "Allow a non-empty output directory without --resume")
    .option("--fail-fast", "Stop scheduling new jobs after the first failure")
    .option("--dry-run", "Validate input and print the plan; send no requests and write nothing")
    .option("--json", "Print the final summary as JSON on stdout")
    .action(async (file: string, options: any, command: Command) => {
      const globals = safeGlobals(command);
      const defaults = cliDefaultsFromFlags({
        model: options.model,
        size: options.size,
        ratio: options.ratio,
        seconds: options.seconds,
        ttl: options.ttl,
      });
      const runOptions: BatchRunOptions = {
        inputPath: file,
        outDir: options.out,
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        ...(options.consistency !== undefined
          ? { consistency: parseConsistencyOption(options.consistency) }
          : {}),
        ...(options.strategy !== undefined ? { strategy: parseStrategyOption(options.strategy) } : {}),
        ...(options.account !== undefined ? { account: options.account } : {}),
        ...(globals.account !== undefined && options.account === undefined
          ? { account: String(globals.account) }
          : {}),
        ...(globals.strategy !== undefined && options.strategy === undefined
          ? { strategy: parseStrategyOption(String(globals.strategy)) }
          : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.pollInterval !== undefined ? { pollIntervalMs: options.pollInterval } : {}),
        ...(options.pollTimeout !== undefined ? { pollTimeoutMs: options.pollTimeout } : {}),
        ...(options.resume ? { resume: true } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.failFast ? { failFast: true } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...Object.keys(defaults).length > 0 ? { defaults } : {},
      };
      const outcome = await runBatch(runOptions, clientDeps(getClient));
      if (options.dryRun) {
        printJson(outcome.plan);
        return;
      }
      printOutcome(outcome, {
        json: Boolean(options.json),
        outDir: options.out,
        command: "batch run",
      });
      if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
    });

  batch
    .command("status")
    .description("Show batch status from an output directory")
    .argument("<dir>", "Batch output directory")
    .option("--json", "Output JSON")
    .action(async (dir: string, options: any) => {
      const report = await batchStatus({ outDir: dir, json: Boolean(options.json) });
      if (options.json) {
        printJson(report);
        return;
      }
      printStatus(report);
    });

  batch
    .command("retry")
    .description("Retry failed or pending jobs from an existing batch")
    .argument("<dir>", "Batch output directory")
    .option("--only <mode>", "failed | pending | all (default failed)", "failed")
    .option("--concurrency <n>", "Maximum concurrent jobs", parseInteger)
    .option("--max-attempts <n>", "Maximum attempts per job", parseInteger)
    .option("--fail-fast", "Stop scheduling new jobs after the first failure")
    .option("--json", "Print the final summary as JSON on stdout")
    .action(async (dir: string, options: any) => {
      const retryOptions: BatchRetryOptions = {
        outDir: dir,
        only: options.only,
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.failFast ? { failFast: true } : {}),
      };
      const outcome = await retryBatch(retryOptions, clientDeps(getClient));
      printOutcome(outcome, {
        json: Boolean(options.json),
        outDir: dir,
        command: "batch retry",
        only: options.only,
      });
      if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
    });
}

function clientDeps(getClient: () => AgnesClientLike) {
  return {
    client: getClient(),
    stderr: (line: string) => console.error(line),
  };
}

function safeGlobals(command: Command | undefined): Record<string, unknown> {
  try {
    return (command?.optsWithGlobals?.() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function printOutcome(
  outcome: BatchRunOutcome,
  options: { json: boolean; outDir: string; command: string; only?: string },
): void {
  const manifest = outcome.manifest;
  const summary = manifest?.summary ?? {
    total: 0,
    succeeded: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    mixedAccounts: false,
    accountsUsed: [] as string[],
  };
  const failures = (manifest?.jobs ?? []).filter((job) => job.status === "failed");
  if (options.json) {
    printJson({
      ok: outcome.ok,
      command: options.command,
      batchId: manifest?.batchId,
      outDir: outcome.plan?.batchId ? undefined : options.outDir,
      ...(options.only !== undefined ? { only: options.only } : {}),
      summary,
      config: manifest
        ? {
            consistency: manifest.config.consistency,
            ...(manifest.config.strategy !== undefined ? { strategy: manifest.config.strategy } : {}),
            concurrency: manifest.config.concurrency,
          }
        : undefined,
      ...(manifest?.pinnedAccountId !== undefined
        ? { pinnedAccountId: manifest.pinnedAccountId }
        : {}),
      failedJobs: failures.map((job) => ({
        id: job.id,
        attempts: job.attempts,
        code: job.error?.code ?? "UNKNOWN",
        message: job.error?.message ?? "",
        ...(job.error?.ambiguous ? { ambiguous: true } : {}),
      })),
    });
    return;
  }
  const accounts = summary.accountsUsed.length > 0 ? summary.accountsUsed.join(", ") : "none";
  printLines([
    `batch: ${manifest?.batchId ?? "unknown"}`,
    `output: ${options.outDir}`,
    manifest
      ? `consistency: ${manifest.config.consistency}` +
        (manifest.config.strategy !== undefined ? `  strategy: ${manifest.config.strategy}` : "") +
        `  concurrency: ${manifest.config.concurrency}`
      : undefined,
    `summary: total=${summary.total} succeeded=${summary.succeeded} failed=${summary.failed} pending=${summary.pending} skipped=${summary.skipped}`,
    `accounts: ${accounts}${summary.mixedAccounts ? " (mixedAccounts=true)" : ""}`,
    ...failures.map(
      (job) =>
        `failed: ${job.id}  ${job.error?.code ?? "UNKNOWN"}${job.error?.ambiguous ? " (AMBIGUOUS)" : ""}  ${job.error?.message ?? ""}`,
    ),
  ]);
}

function printStatus(report: BatchStatusReport): void {
  const summary = report.summary;
  printLines([
    `batch: ${report.batchId}`,
    `output: ${report.outDir}`,
    `consistency: ${report.config.consistency}` +
      (report.config.strategy !== undefined ? `  strategy: ${report.config.strategy}` : "") +
      (report.pinnedAccountId !== undefined ? `  pinnedAccount: ${report.pinnedAccountId}` : ""),
    `summary: total=${summary.total} succeeded=${summary.succeeded} failed=${summary.failed} pending=${summary.pending} skipped=${summary.skipped}`,
    `accounts: ${summary.accountsUsed.length > 0 ? summary.accountsUsed.join(", ") : "none"}${summary.mixedAccounts ? " (mixedAccounts=true)" : ""}`,
    "jobs:",
    ...report.jobs.map((job) => {
      const parts = [
        `#${String(job.index + 1).padStart(3, "0")}`,
        job.id,
        job.status,
        job.accountId !== undefined ? `account=${job.accountId}` : undefined,
        job.resultUrl,
        job.error ? `${job.error.code}${job.error.ambiguous ? " (AMBIGUOUS)" : ""}` : undefined,
      ].filter(Boolean);
      return `  ${parts.join("  ")}`;
    }),
  ]);
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}
