/**
 * Batch artifacts: manifest.json, input.json, results/<id>.json, events.jsonl
 * (design contract: docs/multi-account-design.md §6.2 / §6.4).
 *
 * All artifacts are written atomically (tmp + rename) with mode 0600 because a
 * manifest can contain prompts. No key material is ever written: callers pass
 * sanitized result objects (see runner.ts).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AgnesCliError } from "../errors.js";
import type {
  BatchEvent,
  BatchManifest,
  BatchSummary,
  ManifestJobRecord,
} from "./types.js";

export const MANIFEST_SCHEMA = "agnes-batch/1" as const;
export const MANIFEST_VERSION = 1 as const;

export interface BatchLayout {
  outDir: string;
  manifestPath: string;
  inputPath: string;
  resultsDir: string;
  eventsPath: string;
}

export function batchLayout(outDir: string): BatchLayout {
  const absolute = resolve(outDir);
  return {
    outDir: absolute,
    manifestPath: join(absolute, "manifest.json"),
    inputPath: join(absolute, "input.json"),
    resultsDir: join(absolute, "results"),
    eventsPath: join(absolute, "events.jsonl"),
  };
}

/** Refuse non-empty output dirs unless the caller asked to resume or force. */
export function prepareOutputDir(
  outDir: string,
  options: { resume?: boolean; force?: boolean } = {},
): BatchLayout {
  const layout = batchLayout(outDir);
  if (existsSync(layout.outDir)) {
    if (!statSync(layout.outDir).isDirectory()) {
      throw new AgnesCliError(
        "BATCH_OUT_DIR_INVALID",
        `Batch output path exists and is not a directory: ${layout.outDir}`,
        { outDir: layout.outDir },
        2,
      );
    }
    const entries = readdirSync(layout.outDir);
    if (entries.length > 0 && !options.resume && !options.force) {
      throw new AgnesCliError(
        "BATCH_OUT_DIR_NOT_EMPTY",
        `Batch output directory is not empty: ${layout.outDir}. Use --resume to continue a batch or --force to start a new batch in it.`,
        { outDir: layout.outDir },
        2,
      );
    }
  }
  mkdirSync(layout.outDir, { recursive: true });
  return layout;
}

/** Create results dir only when a batch actually runs (dry-run writes nothing). */
export function ensureArtifactDirs(layout: BatchLayout): void {
  mkdirSync(layout.outDir, { recursive: true });
  if (!existsSync(layout.resultsDir)) {
    mkdirSync(layout.resultsDir, { recursive: true, mode: 0o700 });
  }
}

export function readManifest(outDir: string): BatchManifest | undefined {
  const layout = batchLayout(outDir);
  if (!existsSync(layout.manifestPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(layout.manifestPath, "utf8"));
  } catch (error) {
    throw new AgnesCliError(
      "BATCH_MANIFEST_INVALID",
      `Batch manifest is not valid JSON: ${layout.manifestPath}`,
      { path: layout.manifestPath, cause: error instanceof Error ? error.message : String(error) },
      2,
    );
  }
  return validateManifest(parsed, layout.manifestPath);
}

export function requireManifest(outDir: string): BatchManifest {
  const manifest = readManifest(outDir);
  if (!manifest) {
    throw new AgnesCliError(
      "BATCH_MANIFEST_MISSING",
      `No batch manifest found in ${resolve(outDir)} (expected manifest.json).`,
      { outDir: resolve(outDir) },
      2,
    );
  }
  return manifest;
}

function validateManifest(value: unknown, path: string): BatchManifest {
  const fail = (reason: string): never => {
    throw new AgnesCliError("BATCH_MANIFEST_INVALID", `Batch manifest is invalid: ${reason}`, { path }, 2);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const record = value as Record<string, unknown>;
  if (record.schema !== MANIFEST_SCHEMA) fail(`unsupported schema ${JSON.stringify(record.schema)}`);
  if (record.version !== MANIFEST_VERSION) fail(`unsupported version ${JSON.stringify(record.version)}`);
  if (typeof record.batchId !== "string" || !record.batchId) fail("missing batchId");
  if (!record.input || typeof record.input !== "object") fail("missing input block");
  if (!record.config || typeof record.config !== "object") fail("missing config block");
  if (!Array.isArray(record.jobs)) fail("missing jobs array");
  const jobs = record.jobs as unknown[];
  jobs.forEach((job, index) => {
    if (!job || typeof job !== "object" || Array.isArray(job)) fail(`jobs[${index}] is not an object`);
    const entry = job as Record<string, unknown>;
    if (typeof entry.id !== "string") fail(`jobs[${index}] is missing id`);
    if (typeof entry.index !== "number") fail(`jobs[${index}] is missing index`);
  });
  const summary = (record.summary ?? {}) as Partial<BatchSummary>;
  return {
    ...(record as unknown as BatchManifest),
    summary: normalizeSummary(summary, jobs as ManifestJobRecord[]),
  };
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore cleanup failures; the original error is more useful.
    }
    throw error;
  }
}

export function writeManifest(layout: BatchLayout, manifest: BatchManifest): void {
  writeJsonAtomic(layout.manifestPath, manifest);
}

export function writeNormalizedInput(layout: BatchLayout, normalized: unknown): void {
  writeJsonAtomic(layout.inputPath, normalized);
}

export function appendEvent(layout: BatchLayout, event: BatchEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  // "a" with an explicit mode only applies the mode when the file is created;
  // normalize permissions afterwards to keep 0600 even when it pre-existed.
  writeFileSync(layout.eventsPath, line, { encoding: "utf8", mode: 0o600, flag: "a" });
  try {
    chmodSync(layout.eventsPath, 0o600);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

export function computeSummary(jobs: ManifestJobRecord[], elapsedMs?: number): BatchSummary {
  const summary: BatchSummary = {
    total: jobs.length,
    succeeded: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    mixedAccounts: false,
    accountsUsed: [],
  };
  const accounts = new Set<string>();
  for (const job of jobs) {
    if (job.status === "succeeded") summary.succeeded += 1;
    else if (job.status === "failed") summary.failed += 1;
    else if (job.status === "skipped") summary.skipped += 1;
    else summary.pending += 1;
    if (job.accountId) accounts.add(job.accountId);
  }
  summary.accountsUsed = [...accounts].sort();
  summary.mixedAccounts = summary.accountsUsed.length > 1;
  if (elapsedMs !== undefined) summary.elapsedMs = elapsedMs;
  return summary;
}

function normalizeSummary(summary: Partial<BatchSummary>, jobs: ManifestJobRecord[]): BatchSummary {
  return {
    ...computeSummary(jobs, summary.elapsedMs),
  };
}

export function generateBatchId(now: Date, random: () => number = Math.random): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  const randomPart = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .slice(-4);
  return `batch-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomPart}`;
}

export function isoNow(now: () => Date): string {
  return now().toISOString();
}

/**
 * Serializes async artifact writes so concurrent job completions never
 * interleave an atomic manifest rename or duplicate events.
 */
export class BatchArtifactWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly layout: BatchLayout) {}

  enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.queue.catch(() => {}).then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  persistManifest(manifest: BatchManifest): Promise<void> {
    return this.enqueue(() => {
      manifest.updatedAt = new Date().toISOString();
      writeManifest(this.layout, manifest);
    });
  }

  writeJobResult(job: ManifestJobRecord, batchId: string): Promise<void> {
    return this.enqueue(() => writeJobResultFile(this.layout, batchId, job));
  }

  appendEvent(event: BatchEvent): Promise<void> {
    return this.enqueue(() => appendEvent(this.layout, event));
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

function writeJobResultFile(
  layout: BatchLayout,
  batchId: string,
  job: ManifestJobRecord,
): void {
  ensureArtifactDirs(layout);
  const path = join(layout.resultsDir, `${job.id}.json`);
  writeJsonAtomic(path, {
    schema: "agnes-batch-result/1",
    batchId,
    job,
  });
}
