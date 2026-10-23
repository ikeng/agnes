/**
 * Persistent create→poll affinity journal
 * (docs/multi-account-research.md §2 P3/P5, docs/multi-account-design.md §3).
 *
 * `$AGNES_STATE_DIR/affinity.json` maps affinity keys (`video:<id>`,
 * `task:<id>`, `session:<name>`, `batch:<id>:<job>`) to the account that owns
 * the resource. State dir is 0700, the journal 0600, writes are atomic
 * (tmp + rename) and merge-on-write so concurrent CLI processes do not clobber
 * each other's entries. Entries expire after 7 days; the journal is bounded to
 * 5000 entries. It never contains key material.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AffinityEntry } from "./types.js";

export const AFFINITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AFFINITY_MAX_ENTRIES = 5000;
export const AFFINITY_FILE_NAME = "affinity.json";

/** Inter-process lock tuning: bounded retries; treat older locks as stale. */
export const AFFINITY_LOCK = {
  retryMs: 5,
  budgetMs: 1000,
  staleMs: 10_000,
} as const;

export interface AffinityJournalOptions {
  filePath: string;
  /** Injectable clock for TTL tests. */
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

export interface BindAffinityInput {
  accountId: string;
  poolId: string;
  model?: string;
  kind?: string;
}

interface JournalDocument {
  version: 1;
  entries: Record<string, StoredAffinityEntry>;
}

interface StoredAffinityEntry {
  accountId: string;
  poolId: string;
  model?: string;
  kind?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * File-backed affinity journal. All filesystem work is synchronous so a
 * CLI process cannot lose a binding between create and poll; failures degrade
 * to in-memory only instead of crashing a generation call.
 */
export class AffinityJournal {
  readonly filePath: string;
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly now: () => number;
  private entries = new Map<string, StoredAffinityEntry>();
  private loaded = false;
  private writeWarned = false;
  private lockWarned = false;

  constructor(options: AffinityJournalOptions) {
    this.filePath = options.filePath;
    this.ttlMs = options.ttlMs ?? AFFINITY_TTL_MS;
    this.maxEntries = options.maxEntries ?? AFFINITY_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  static forStateDir(stateDir: string, options: Partial<AffinityJournalOptions> = {}): AffinityJournal {
    return new AffinityJournal({ ...options, filePath: `${stateDir.replace(/\/$/, "")}/${AFFINITY_FILE_NAME}` });
  }

  /** Load (once) entries from disk, merging the in-memory view. Never throws. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return;
    }
    if (!document || typeof document !== "object") return;
    const entries = (document as JournalDocument).entries;
    if (!entries || typeof entries !== "object") return;
    const now = this.now();
    for (const [key, candidate] of Object.entries(entries)) {
      if (!isStoredEntry(candidate)) continue;
      if (now - candidate.updatedAt > this.ttlMs) continue;
      const existing = this.entries.get(key);
      if (!existing || existing.updatedAt <= candidate.updatedAt) {
        this.entries.set(key, candidate);
      }
    }
  }

  get(key: string): AffinityEntry | undefined {
    this.load();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.updatedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...entry };
  }

  bind(key: string, input: BindAffinityInput): AffinityEntry {
    this.load();
    const now = this.now();
    const existing = this.entries.get(key);
    const entry: StoredAffinityEntry = {
      accountId: input.accountId,
      poolId: input.poolId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(key, entry);
    this.persist();
    return { ...entry };
  }

  /** All live entries (for tests / diagnostics). */
  all(): Record<string, AffinityEntry> {
    this.load();
    const now = this.now();
    const result: Record<string, AffinityEntry> = {};
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt <= this.ttlMs) result[key] = { ...entry };
    }
    return result;
  }

  /**
   * Acquire the cross-process lock directory (atomic mkdir). Returns false when
   * the budget is exhausted; callers then proceed best-effort so a generation
   * is never failed by a contended state dir.
   */
  private acquireLock(): boolean {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + AFFINITY_LOCK.budgetMs;
    // The parent state dir must exist before the lock dir can be created;
    // otherwise the first concurrent bind of a fresh state dir silently races.
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    } catch (error) {
      this.warnLock(`Could not create the affinity state dir: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    for (;;) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        return true;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "EEXIST") {
          this.warnLock(`Could not create the affinity lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
        try {
          const stats = statSync(lockPath);
          if (Date.now() - stats.mtimeMs > AFFINITY_LOCK.staleMs) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock vanished between mkdir and stat: retry immediately
          continue;
        }
        if (Date.now() >= deadline) {
          this.warnLock(`Timed out waiting for the affinity lock at ${lockPath}; writing best-effort.`);
          return false;
        }
        sleepSync(AFFINITY_LOCK.retryMs);
      }
    }
  }

  private releaseLock(): void {
    try {
      rmSync(`${this.filePath}.lock`, { recursive: true, force: true });
    } catch {
      // A leftover lock is treated as stale after AFFINITY_LOCK.staleMs.
    }
  }

  private warnLock(message: string): void {
    if (this.lockWarned) return;
    this.lockWarned = true;
    process.emitWarning(message);
  }

  private persist(): void {
    // Merge-on-write is only safe when competing processes serialize their
    // read → merge → tmp+rename sequence; the lock dir is that serialization.
    const locked = this.acquireLock();
    try {
      this.mergeAndWrite();
    } finally {
      if (locked) this.releaseLock();
    }
  }

  /** Read the current on-disk journal, merge the in-memory view, write atomically. */
  private mergeAndWrite(): void {
    const now = this.now();
    // Merge current on-disk entries so concurrent processes keep their bindings.
    const merged = new Map<string, StoredAffinityEntry>();
    try {
      const document = JSON.parse(readFileSync(this.filePath, "utf8")) as JournalDocument;
      if (document?.entries && typeof document.entries === "object") {
        for (const [key, candidate] of Object.entries(document.entries)) {
          if (!isStoredEntry(candidate)) continue;
          if (now - candidate.updatedAt > this.ttlMs) continue;
          merged.set(key, candidate);
        }
      }
    } catch {
      // missing/corrupt journal: start from the in-memory view
    }
    for (const [key, entry] of this.entries) {
      const disk = merged.get(key);
      if (!disk || disk.updatedAt <= entry.updatedAt) merged.set(key, entry);
    }
    let ordered = [...merged.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    if (ordered.length > this.maxEntries) ordered = ordered.slice(ordered.length - this.maxEntries);
    const document: JournalDocument = { version: 1, entries: Object.fromEntries(ordered) };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      try {
        chmodSync(dirname(this.filePath), 0o700);
      } catch {
        // Permission fixes are best-effort; the file mode below still protects content.
      }
      const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.filePath);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // best effort
      }
      this.entries = new Map(ordered);
    } catch (error) {
      if (!this.writeWarned) {
        this.writeWarned = true;
        // Never fail a generation because the state dir is read-only.
        process.emitWarning(
          `Could not persist the affinity journal at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** Synchronous sleep without a busy loop (Node main thread allows Atomics.wait). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // fallback busy wait for runtimes without SharedArrayBuffer
    }
  }
}

function isStoredEntry(value: unknown): value is StoredAffinityEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountId === "string" &&
    record.accountId.length > 0 &&
    typeof record.poolId === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}
