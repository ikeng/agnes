/**
 * Batch input parsing/validation (design contract: docs/multi-account-design.md §6.1).
 *
 * Two accepted shapes:
 *  - JSON object wrapper: {version?, batchId?, consistency?, defaults?, jobs:[...]}
 *  - JSONL: one job object per line (blank lines and `#`/`//` comment lines ignored)
 *
 * Validation is strict: unknown keys are rejected, duplicate job ids are
 * rejected, and the optional `defaults` block may only contain generation
 * params. All validation failures surface as INVALID_BATCH_INPUT (exit 2).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { AgnesCliError } from "../errors.js";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_RATIOS,
  IMAGE_SIZE_TIERS,
  TEXT_MODELS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODELS,
  VIDEO_SIZE_TIERS,
} from "../models.js";
import {
  BATCH_IMAGE_MODES,
  BATCH_TTLS,
  BATCH_VIDEO_MODES,
  type BatchJobKind,
  type BatchRoutingStrategy,
  type BatchTtl,
  type ConsistencyMode,
  type EffectiveJob,
  type EffectiveModelSource,
  type NormalizedBatchInput,
} from "./types.js";

const JOB_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const METADATA_MAX_BYTES = 4096;

export const BATCH_STRATEGIES: readonly BatchRoutingStrategy[] = [
  "adaptive",
  "round-robin",
  "weighted",
  "least-inflight",
  "primary",
];

const WRAPPER_KEYS = new Set(["version", "batchId", "consistency", "defaults", "defaultsByKind", "jobs"]);
const JOB_KINDS: readonly BatchJobKind[] = ["image", "video", "text"];
const JOB_KEYS = new Set([
  "id",
  "kind",
  "mode",
  "prompt",
  "model",
  "size",
  "ratio",
  "seconds",
  "aspectRatio",
  "seed",
  "n",
  "ttl",
  "image",
  "images",
  "affinity",
  "metadata",
]);
/** Generation params allowed inside `defaults` (never id/kind/mode/image(s)/affinity/metadata). */
const DEFAULT_KEYS = new Set([
  "prompt",
  "model",
  "size",
  "ratio",
  "seconds",
  "aspectRatio",
  "seed",
  "n",
  "ttl",
]);

export interface RawBatchJob {
  id: string;
  kind: BatchJobKind;
  mode?: string;
  prompt?: string;
  model?: string;
  size?: string;
  ratio?: string;
  seconds?: number;
  aspectRatio?: string;
  seed?: number;
  n?: number;
  ttl?: BatchTtl;
  image?: string;
  images?: string[];
  affinity?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedBatchInput {
  format: "json" | "jsonl";
  sourcePath: string;
  /** sha256 (hex) of the raw input file bytes. */
  rawSha256: string;
  batchId?: string;
  consistency?: ConsistencyMode;
  defaults: Record<string, unknown>;
  /** Per-kind defaults sections (JSON wrapper form only). */
  defaultsByKind?: Partial<Record<BatchJobKind, Record<string, unknown>>>;
  jobs: RawBatchJob[];
}

export interface BuildEffectiveOptions {
  batchId: string;
  /** Lower-priority defaults from CLI flags (JSONL form uses these as defaults). */
  fallbackDefaults?: Record<string, unknown>;
}

export function invalidBatchInput(issues: string[]): AgnesCliError {
  const message =
    issues.length === 1
      ? `Invalid batch input: ${issues[0]}`
      : `Invalid batch input (${issues.length} issues):\n${issues.map((issue) => `  - ${issue}`).join("\n")}`;
  return new AgnesCliError("INVALID_BATCH_INPUT", message, { issues }, 2);
}

/** Deterministic JSON string used for hashing/digests (object keys sorted). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Stable per-job hash over the effective definition (used by resume). */
export function jobInputHash(job: EffectiveJob): string {
  return digestOf({
    id: job.id,
    kind: job.kind,
    mode: job.mode,
    prompt: job.prompt,
    model: job.model ?? null,
    size: job.size ?? null,
    ratio: job.ratio ?? null,
    seconds: job.seconds ?? null,
    aspectRatio: job.aspectRatio ?? null,
    seed: job.seed ?? null,
    n: job.n ?? null,
    ttl: job.ttl ?? null,
    image: job.image ?? null,
    images: job.images ?? null,
    affinity: job.affinity,
    metadata: job.metadata ?? null,
  });
}

export function parseBatchInputFile(
  inputPath: string,
  options: { cliDefaults?: Record<string, unknown> } = {},
): ParsedBatchInput {
  const absolutePath = resolve(inputPath);
  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AgnesCliError(
        "BATCH_INPUT_NOT_FOUND",
        `Batch input file not found: ${absolutePath}`,
        { path: absolutePath },
        2,
      );
    }
    throw new AgnesCliError(
      "BATCH_INPUT_UNREADABLE",
      `Batch input file could not be read: ${absolutePath}`,
      { path: absolutePath, cause: error instanceof Error ? error.message : String(error) },
      2,
    );
  }
  const text = rawBytes.toString("utf8").replace(/^\uFEFF/, "");
  const sha256 = sha256Hex(rawBytes);

  const parsed = tryParseJsonDocument(text);
  if (parsed.kind === "wrapper") {
    return parseWrapper(parsed.value, absolutePath, sha256);
  }
  if (parsed.kind === "array") {
    throw invalidBatchInput([
      "top-level JSON array is not supported; use a wrapper object {jobs:[...]} or JSONL input",
    ]);
  }
  // Not a single JSON document: fall back to JSONL.
  return parseJsonl(text, absolutePath, sha256, options.cliDefaults ?? {});
}

function tryParseJsonDocument(
  text: string,
): { kind: "wrapper"; value: unknown } | { kind: "array" } | { kind: "jsonl" } {
  const trimmed = text.trim();
  if (!trimmed) {
    throw invalidBatchInput(["input file is empty"]);
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) return { kind: "array" };
    return { kind: "wrapper", value };
  } catch {
    return { kind: "jsonl" };
  }
}

function parseWrapper(value: unknown, sourcePath: string, rawSha256: string): ParsedBatchInput {
  const issues: string[] = [];
  if (!isPlainObject(value)) {
    throw invalidBatchInput(["expected a JSON object with a jobs array"]);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!WRAPPER_KEYS.has(key)) issues.push(`unknown top-level key "${key}"`);
  }
  if (record.version !== undefined && record.version !== 1) {
    issues.push(`unsupported version ${JSON.stringify(record.version)} (expected 1)`);
  }
  const batchId = optionalString(record.batchId, "batchId", issues);
  if (batchId !== undefined && !BATCH_ID_PATTERN.test(batchId)) {
    issues.push(`batchId must match ${BATCH_ID_PATTERN.source}`);
  }
  const consistency = parseConsistency(record.consistency, issues, "consistency");
  const defaults = parseDefaults(record.defaults, issues);
  const defaultsByKind = parseDefaultsByKind(record.defaultsByKind, issues);
  const rawJobs = record.jobs;
  let jobs: RawBatchJob[] = [];
  if (rawJobs === undefined) {
    issues.push('missing required "jobs" array');
  } else if (!Array.isArray(rawJobs)) {
    issues.push('"jobs" must be an array');
  } else {
    jobs = validateJobs(rawJobs, issues);
  }
  rejectDuplicateIds(jobs, issues);
  if (issues.length > 0) throw invalidBatchInput(issues);
  return {
    format: "json",
    sourcePath,
    rawSha256,
    ...(batchId !== undefined ? { batchId } : {}),
    ...(consistency !== undefined ? { consistency } : {}),
    defaults,
    ...(Object.keys(defaultsByKind).length > 0 ? { defaultsByKind } : {}),
    jobs,
  };
}

function parseJsonl(
  text: string,
  sourcePath: string,
  rawSha256: string,
  cliDefaults: Record<string, unknown>,
): ParsedBatchInput {
  const issues: string[] = [];
  const rawJobs: unknown[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) return;
    try {
      rawJobs.push(JSON.parse(trimmed));
    } catch (error) {
      issues.push(`line ${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  if (rawJobs.length === 0 && issues.length === 0) {
    issues.push("JSONL input contains no jobs");
  }
  const defaults = parseDefaults(cliDefaults, issues);
  const jobs = validateJobs(rawJobs, issues);
  rejectDuplicateIds(jobs, issues);
  if (issues.length > 0) throw invalidBatchInput(issues);
  return { format: "jsonl", sourcePath, rawSha256, defaults, jobs };
}

function validateJobs(rawJobs: unknown[], issues: string[]): RawBatchJob[] {
  const jobs: RawBatchJob[] = [];
  rawJobs.forEach((entry, index) => {
    const where = `jobs[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(`${where}: must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!JOB_KEYS.has(key)) issues.push(`${where}: unknown key "${key}"`);
    }
    const id = requiredString(record.id, `${where}.id`, issues);
    if (id !== undefined && !JOB_ID_PATTERN.test(id)) {
      issues.push(`${where}.id must match ${JOB_ID_PATTERN.source}`);
    } else if (id === "." || id === "..") {
      issues.push(`${where}.id must not be "." or ".."`);
    }
    const kind = parseKind(record.kind, where, issues);
    const mode = parseMode(record.mode, kind, where, issues);
    const prompt = optionalString(record.prompt, `${where}.prompt`, issues);
    const model = optionalString(record.model, `${where}.model`, issues);
    const size = optionalString(record.size, `${where}.size`, issues);
    const ratio = optionalString(record.ratio, `${where}.ratio`, issues);
    const seconds = optionalInteger(record.seconds, `${where}.seconds`, issues);
    const aspectRatio = optionalString(record.aspectRatio, `${where}.aspectRatio`, issues);
    const seed = optionalInteger(record.seed, `${where}.seed`, issues);
    const n = optionalInteger(record.n, `${where}.n`, issues);
    const ttl = parseTtl(record.ttl, `${where}.ttl`, issues);
    const image = optionalString(record.image, `${where}.image`, issues);
    const images = optionalStringArray(record.images, `${where}.images`, issues);
    const affinity = optionalString(record.affinity, `${where}.affinity`, issues);
    const metadata = parseMetadata(record.metadata, `${where}.metadata`, issues);

    if (kind !== undefined && mode !== undefined) {
      validateModeInputs(kind, mode, image, images, where, issues);
    }
    if (metadata !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
      if (bytes > METADATA_MAX_BYTES) {
        issues.push(`${where}.metadata must be at most ${METADATA_MAX_BYTES} bytes (got ${bytes})`);
      }
    }
    if (id !== undefined && kind !== undefined) {
      jobs.push({
        id,
        kind,
        ...(mode !== undefined ? { mode } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(ratio !== undefined ? { ratio } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(n !== undefined ? { n } : {}),
        ...(ttl !== undefined ? { ttl } : {}),
        ...(image !== undefined ? { image } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(affinity !== undefined ? { affinity } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });
    }
  });
  return jobs;
}

function validateModeInputs(
  kind: BatchJobKind,
  mode: string,
  image: string | undefined,
  images: string[] | undefined,
  where: string,
  issues: string[],
): void {
  const allowsImage =
    (kind === "image" && mode === "img2img") || (kind === "video" && mode === "img2video");
  const allowsImages =
    (kind === "image" && mode === "compose") ||
    (kind === "video" && (mode === "multivideo" || mode === "keyframes"));
  if (!allowsImage && image !== undefined) {
    issues.push(`${where}: "image" is not accepted for ${kind} mode ${mode}; use "images"`);
  }
  if (!allowsImages && images !== undefined) {
    issues.push(`${where}: "images" is not accepted for ${kind} mode ${mode}; use "image"`);
  }
  if (allowsImage && image === undefined) {
    issues.push(`${where}: "image" is required for ${kind} mode ${mode}`);
  }
  if (allowsImages) {
    const count = images?.length ?? 0;
    if (count === 0) {
      issues.push(`${where}: "images" is required for ${kind} mode ${mode}`);
    } else if (mode === "keyframes" && count !== 2) {
      issues.push(`${where}: ${kind} mode keyframes requires exactly 2 images (got ${count})`);
    } else if (count < 2) {
      issues.push(`${where}: "images" requires at least 2 entries for ${kind} mode ${mode}`);
    }
  }
  if (!allowsImage && !allowsImages && image === undefined && images === undefined) return;
}

function parseKind(value: unknown, where: string, issues: string[]): BatchJobKind | undefined {
  if (value === undefined) {
    issues.push(`${where}.kind is required (image | video | text)`);
    return undefined;
  }
  if (value !== "image" && value !== "video" && value !== "text") {
    issues.push(`${where}.kind must be one of image | video | text (got ${JSON.stringify(value)})`);
    return undefined;
  }
  return value;
}

function parseMode(
  value: unknown,
  kind: BatchJobKind | undefined,
  where: string,
  issues: string[],
): string | undefined {
  if (kind === undefined) return undefined;
  if (kind === "text") {
    if (value === undefined) return "chat";
    if (value !== "chat") {
      issues.push(`${where}.mode must be "chat" for kind text (got ${JSON.stringify(value)})`);
      return undefined;
    }
    return "chat";
  }
  const allowed = kind === "image" ? BATCH_IMAGE_MODES : BATCH_VIDEO_MODES;
  if (value === undefined) {
    issues.push(`${where}.mode is required for kind ${kind} (${allowed.join(" | ")})`);
    return undefined;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.push(`${where}.mode must be one of ${allowed.join(" | ")} for kind ${kind}`);
    return undefined;
  }
  return value;
}

function parseConsistency(
  value: unknown,
  issues: string[],
  path: string,
): ConsistencyMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "record" && value !== "strict") {
    issues.push(`${path} must be one of record | strict`);
    return undefined;
  }
  return value;
}

export function parseStrategyOption(value: string): BatchRoutingStrategy {
  if (!(BATCH_STRATEGIES as readonly string[]).includes(value)) {
    throw new AgnesCliError(
      "INVALID_ARGUMENTS",
      `--strategy must be one of ${BATCH_STRATEGIES.join(" | ")} (got ${value})`,
      undefined,
      2,
    );
  }
  return value as BatchRoutingStrategy;
}

export function parseConsistencyOption(value: string): ConsistencyMode {
  if (value !== "record" && value !== "strict") {
    throw new AgnesCliError(
      "INVALID_ARGUMENTS",
      `--consistency must be one of record | strict (got ${value})`,
      undefined,
      2,
    );
  }
  return value;
}

function parseDefaults(
  value: unknown,
  issues: string[],
  pathPrefix = "defaults",
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    issues.push(`${pathPrefix} must be an object`);
    return {};
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!DEFAULT_KEYS.has(key)) {
      issues.push(`${pathPrefix}.${key} is not allowed (allowed: ${[...DEFAULT_KEYS].join(", ")})`);
    }
  }
  const defaults: Record<string, unknown> = {};
  for (const key of DEFAULT_KEYS) {
    if (!(key in record) || record[key] === undefined) continue;
    const path = `${pathPrefix}.${key}`;
    switch (key) {
      case "prompt":
      case "model":
      case "size":
      case "ratio":
      case "aspectRatio": {
        const parsed = optionalString(record[key], path, issues);
        if (parsed !== undefined) defaults[key] = parsed;
        break;
      }
      case "seconds":
      case "seed":
      case "n": {
        const parsed = optionalInteger(record[key], path, issues);
        if (parsed !== undefined) defaults[key] = parsed;
        break;
      }
      case "ttl": {
        const parsed = parseTtl(record[key], path, issues);
        if (parsed !== undefined) defaults[key] = parsed;
        break;
      }
      default:
        break;
    }
  }
  return defaults;
}

/**
 * Validate `defaultsByKind: {image?: {...}, video?: {...}, text?: {...}}`.
 * These sections override flat defaults for the matching kind, and may only
 * contain params that kind actually accepts.
 */
function parseDefaultsByKind(
  value: unknown,
  issues: string[],
): Partial<Record<BatchJobKind, Record<string, unknown>>> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    issues.push("defaultsByKind must be an object");
    return {};
  }
  const record = value as Record<string, unknown>;
  const result: Partial<Record<BatchJobKind, Record<string, unknown>>> = {};
  for (const [key, section] of Object.entries(record)) {
    if (!(JOB_KINDS as readonly string[]).includes(key)) {
      issues.push(`defaultsByKind.${key} is not a job kind (allowed: ${JOB_KINDS.join(", ")})`);
      continue;
    }
    const kind = key as BatchJobKind;
    const parsed = parseDefaults(section, issues, `defaultsByKind.${kind}`);
    for (const paramKey of Object.keys(parsed)) {
      if (!KIND_FLAT_DEFAULTS_ALLOWED[kind].has(paramKey)) {
        issues.push(
          `defaultsByKind.${kind}.${paramKey} is not supported for kind ${kind} (allowed: ${[...KIND_FLAT_DEFAULTS_ALLOWED[kind]].join(", ")})`,
        );
      }
    }
    result[kind] = parsed;
  }
  return result;
}

function rejectDuplicateIds(jobs: RawBatchJob[], issues: string[]): void {
  const seen = new Map<string, number>();
  jobs.forEach((job, index) => {
    const previous = seen.get(job.id);
    if (previous !== undefined) {
      issues.push(`jobs[${index}].id "${job.id}" duplicates jobs[${previous}].id`);
    } else {
      seen.set(job.id, index);
    }
  });
}

const KIND_DEFAULT_MODELS: Record<BatchJobKind, string> = {
  image: DEFAULT_IMAGE_MODEL,
  video: DEFAULT_VIDEO_MODEL,
  text: DEFAULT_TEXT_MODEL,
};

const KIND_MODEL_CATALOG: Record<BatchJobKind, readonly string[]> = {
  image: IMAGE_MODELS,
  video: VIDEO_MODELS,
  text: TEXT_MODELS,
};

/**
 * Params a flat (kind-agnostic) `defaults` block may contribute to a job of a
 * given kind. Params a kind does not accept are dropped instead of being sent
 * to a client whose schema would reject them.
 */
const KIND_FLAT_DEFAULTS_ALLOWED: Record<BatchJobKind, ReadonlySet<string>> = {
  image: new Set(["prompt", "model", "size", "ratio", "seed", "ttl"]),
  video: new Set(["prompt", "model", "seconds", "size", "aspectRatio", "seed", "n", "ttl"]),
  text: new Set(["prompt", "model"]),
};

function isValidImageSizeValue(size: string): boolean {
  return (IMAGE_SIZE_TIERS as readonly string[]).includes(size) || /^\d{2,5}x\d{2,5}$/.test(size);
}

/** Whether a flat default value is safe to apply to this kind (keys AND values). */
function isFlatDefaultCompatible(kind: BatchJobKind, key: string, value: unknown): boolean {
  if (!KIND_FLAT_DEFAULTS_ALLOWED[kind].has(key)) return false;
  switch (key) {
    case "prompt":
      return true;
    case "model":
      // Resolved separately (catalog-filtered, with a kind-default fallback).
      return false;
    case "size":
      if (typeof value !== "string") return false;
      if (kind === "image") return isValidImageSizeValue(value);
      if (kind === "video") return (VIDEO_SIZE_TIERS as readonly string[]).includes(value);
      return false;
    case "ratio":
      return typeof value === "string" && (IMAGE_RATIOS as readonly string[]).includes(value);
    case "aspectRatio":
      return typeof value === "string" && (VIDEO_ASPECT_RATIOS as readonly string[]).includes(value);
    case "seconds":
    case "seed":
    case "n":
    case "ttl":
      return true;
    default:
      return false;
  }
}

export interface ResolvedJob extends EffectiveJob {
  rawSha256?: string;
}

/**
 * Merge defaults into raw jobs, resolve affinity defaults and media paths, and
 * validate mode/kind combinations that only make sense after merging.
 *
 * Defaults are kind-aware: a flat `defaults` block is shared by every job, so
 * its values only apply to kinds that accept them. In particular a flat
 * `model` default is only used when it belongs to the job kind's model
 * catalog; otherwise the kind's built-in default model is used and recorded as
 * `modelSource: "kind-default"` (so an image model default never leaks into a
 * video/text job).
 *
 * Per-parameter merge order: `defaultsByKind[kind]` > flat `defaults` (when
 * kind-compatible) > built-in kind default; a value on the job always wins.
 */
export function buildEffectiveJobs(
  parsed: ParsedBatchInput,
  options: BuildEffectiveOptions,
): EffectiveJob[] {
  const issues: string[] = [];
  const flatDefaults: Record<string, unknown> = {
    ...(options.fallbackDefaults ?? {}),
    ...parsed.defaults,
  };
  const defaultsByKind = parsed.defaultsByKind ?? {};
  const baseDir = dirname(parsed.sourcePath);
  const jobs: EffectiveJob[] = [];
  parsed.jobs.forEach((raw, index) => {
    const where = `jobs[${index}] (id=${raw.id})`;
    const kindDefaults = defaultsByKind[raw.kind] ?? {};
    const pick = <T>(key: keyof RawBatchJob | string): T | undefined => {
      const own = (raw as unknown as Record<string, unknown>)[key];
      if (own !== undefined) return own as T;
      const fromKindDefaults = kindDefaults[key];
      if (fromKindDefaults !== undefined) return fromKindDefaults as T;
      const fromFlatDefaults = flatDefaults[key];
      if (fromFlatDefaults !== undefined && isFlatDefaultCompatible(raw.kind, key, fromFlatDefaults)) {
        return fromFlatDefaults as T;
      }
      return undefined;
    };
    const prompt = pick<string>("prompt");
    if (prompt === undefined || prompt.trim() === "") {
      issues.push(`${where}: prompt is required (provide it on the job or in defaults)`);
    }
    const mode = raw.mode ?? (raw.kind === "text" ? "chat" : undefined);
    if (mode === undefined) {
      issues.push(`${where}: mode is required for kind ${raw.kind}`);
    }
    const image = raw.image === undefined ? undefined : resolveMediaInput(raw.image, baseDir);
    const images = raw.images === undefined ? undefined : raw.images.map((entry) => resolveMediaInput(entry, baseDir));
    if (raw.kind !== undefined && mode !== undefined) {
      const modeIssues: string[] = [];
      validateModeInputs(raw.kind, mode, image, images, where, modeIssues);
      issues.push(...modeIssues);
    }
    if (prompt === undefined || mode === undefined) return;

    const kindDefaultModel = KIND_DEFAULT_MODELS[raw.kind];
    const flatModel = flatDefaults.model;
    let model: string;
    let modelSource: EffectiveModelSource;
    if (raw.model !== undefined) {
      model = raw.model;
      modelSource = "job";
    } else if (typeof kindDefaults.model === "string") {
      model = kindDefaults.model;
      modelSource = "defaults";
    } else if (
      typeof flatModel === "string" &&
      (KIND_MODEL_CATALOG[raw.kind] as readonly string[]).includes(flatModel)
    ) {
      model = flatModel;
      modelSource = "defaults";
    } else {
      model = kindDefaultModel;
      modelSource = "kind-default";
    }

    const size = pick<string>("size");
    const ratio = pick<string>("ratio");
    const seconds = pick<number>("seconds");
    const aspectRatio = pick<string>("aspectRatio");
    const seed = pick<number>("seed");
    const n = pick<number>("n");
    const ttl = pick<BatchTtl>("ttl");
    jobs.push({
      index,
      id: raw.id,
      kind: raw.kind,
      mode,
      prompt,
      model,
      modelSource,
      ...(size !== undefined ? { size } : {}),
      ...(ratio !== undefined ? { ratio } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
      ...(aspectRatio !== undefined ? { aspectRatio } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(n !== undefined ? { n } : {}),
      ...(ttl !== undefined ? { ttl } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(images !== undefined ? { images } : {}),
      affinity: raw.affinity ?? `batch:${options.batchId}:${raw.id}`,
      ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
    });
  });
  if (issues.length > 0) throw invalidBatchInput(issues);
  return jobs;
}

/** Parse a persisted normalized input document (`<out>/input.json`). */
export function parseNormalizedInput(value: unknown): {
  batchId: string;
  consistency: ConsistencyMode;
  strategy?: string;
  defaults: Record<string, unknown>;
  jobs: EffectiveJob[];
} {
  if (!isPlainObject(value)) {
    throw new AgnesCliError("BATCH_INPUT_INVALID", "Stored input.json is not an object.", undefined, 2);
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "agnes-batch-input/1" || record.version !== 1) {
    throw new AgnesCliError(
      "BATCH_INPUT_INVALID",
      "Stored input.json has an unsupported schema/version.",
      { schema: record.schema, version: record.version },
      2,
    );
  }
  const batchId = typeof record.batchId === "string" ? record.batchId : undefined;
  const consistency = record.consistency === "strict" ? "strict" : record.consistency === "record" ? "record" : undefined;
  if (!batchId || !consistency || !Array.isArray(record.jobs)) {
    throw new AgnesCliError("BATCH_INPUT_INVALID", "Stored input.json is missing batchId/consistency/jobs.", undefined, 2);
  }
  const jobs = record.jobs.map((entry, index) => validateStoredJob(entry, index));
  return {
    batchId,
    consistency,
    ...(typeof record.strategy === "string" ? { strategy: record.strategy } : {}),
    defaults: isPlainObject(record.defaults) ? (record.defaults as Record<string, unknown>) : {},
    jobs,
  };
}

function validateStoredJob(value: unknown, index: number): EffectiveJob {
  if (!isPlainObject(value)) {
    throw new AgnesCliError("BATCH_INPUT_INVALID", `Stored input.json jobs[${index}] is not an object.`, undefined, 2);
  }
  const job = value as unknown as EffectiveJob;
  if (
    typeof job.id !== "string" ||
    (job.kind !== "image" && job.kind !== "video" && job.kind !== "text") ||
    typeof job.mode !== "string" ||
    typeof job.prompt !== "string" ||
    typeof job.affinity !== "string"
  ) {
    throw new AgnesCliError(
      "BATCH_INPUT_INVALID",
      `Stored input.json jobs[${index}] is missing id/kind/mode/prompt/affinity.`,
      undefined,
      2,
    );
  }
  const modelSource: EffectiveModelSource =
    job.modelSource === "job" || job.modelSource === "defaults" || job.modelSource === "kind-default"
      ? job.modelSource
      : typeof job.model === "string"
        ? "job"
        : "kind-default";
  return { ...job, index, ...(typeof job.model === "string" ? { model: job.model } : {}), modelSource };
}

/** Resolve local media inputs relative to the input file directory. */
export function resolveMediaInput(value: string, baseDir: string): string {
  if (/^(?:https?|data):/i.test(value) || isAbsolute(value)) return value;
  return resolve(baseDir, value);
}

/** Build the normalized document persisted to `<out>/input.json`. */
export function buildNormalizedInput(
  batchId: string,
  consistency: ConsistencyMode,
  strategy: BatchRoutingStrategy | undefined,
  defaults: Record<string, unknown>,
  jobs: EffectiveJob[],
  defaultsByKind?: Partial<Record<BatchJobKind, Record<string, unknown>>>,
): NormalizedBatchInput {
  const normalized: NormalizedBatchInput = {
    schema: "agnes-batch-input/1",
    version: 1,
    batchId,
    consistency,
    ...(strategy !== undefined ? { strategy } : {}),
    defaults,
    ...(defaultsByKind !== undefined && Object.keys(defaultsByKind).length > 0
      ? {
          defaultsByKind: Object.fromEntries(
            Object.entries(defaultsByKind).map(([kind, section]) => [kind, { ...section }]),
          ) as Partial<Record<BatchJobKind, Record<string, unknown>>>,
        }
      : {}),
    jobs: jobs.map((job) => ({ ...job })),
  };
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    issues.push(`${path} is required`);
    return undefined;
  }
  return optionalString(value, path, issues);
}

function optionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string`);
    return undefined;
  }
  if (value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function optionalInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push(`${path} must be an integer`);
    return undefined;
  }
  return value;
}

function optionalStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of strings`);
    return undefined;
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.push(`${path}[${index}] must be a non-empty string`);
    } else {
      result.push(entry);
    }
  });
  return result;
}

function parseTtl(value: unknown, path: string, issues: string[]): BatchTtl | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(BATCH_TTLS as readonly string[]).includes(value)) {
    issues.push(`${path} must be one of ${BATCH_TTLS.join(", ")}`);
    return undefined;
  }
  return value as BatchTtl;
}

function parseMetadata(
  value: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    issues.push(`${path} must be a JSON object`);
    return undefined;
  }
  return value;
}

/** Validate CLI-provided default flags (`--model` etc.) using the same schema. */
export function cliDefaultsFromFlags(flags: {
  model?: string;
  size?: string;
  ratio?: string;
  seconds?: number;
  ttl?: string;
}): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const issues: string[] = [];
  if (flags.model !== undefined) defaults.model = requiredString(flags.model, "--model", issues);
  if (flags.size !== undefined) defaults.size = requiredString(flags.size, "--size", issues);
  if (flags.ratio !== undefined) defaults.ratio = requiredString(flags.ratio, "--ratio", issues);
  if (flags.seconds !== undefined) defaults.seconds = optionalInteger(flags.seconds, "--seconds", issues);
  if (flags.ttl !== undefined) defaults.ttl = parseTtl(flags.ttl, "--ttl", issues);
  if (issues.length > 0) throw invalidBatchInput(issues);
  return defaults;
}
