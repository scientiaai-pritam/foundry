/**
 * scientia-db — State store (design v1, sections 4 "State" and 6).
 *
 * The framework's source of truth for "what it owns". Secrets never live here —
 * only credsRef pointers (see ConnectionTarget). v1 ships a local file-backed
 * store with a process-local lock; the `StateStore` interface is pluggable so a
 * remote/team backend (DynamoDB/S3) drops in later without touching the core
 * (Phase 2).
 *
 * Depends only on `../contracts.js` and Node built-ins.
 */

import { open, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { ResourceState } from "../contracts.js";

/* ------------------------------------------------------------------ *
 * State shape
 * ------------------------------------------------------------------ */

export const STATE_VERSION = 1 as const;

export interface State {
  readonly version: typeof STATE_VERSION;
  readonly resources: Record<string, ResourceState>;
}

export function emptyState(): State {
  return { version: STATE_VERSION, resources: {} };
}

/* ------------------------------------------------------------------ *
 * Pluggable backend interface
 * ------------------------------------------------------------------ */

/**
 * State backend. `lock()` guarantees mutual exclusion for the duration of `fn`
 * (used by the apply orchestrator). `get/put/delete` are convenience helpers
 * over `read/write` for incremental updates.
 */
export interface StateStore {
  /** Read the full state. Returns an empty state if nothing has been written. */
  read(): Promise<State>;
  /** Atomically replace the full state. */
  write(state: State): Promise<void>;
  /** Read a single resource state, or null if absent. */
  get(id: string): Promise<ResourceState | null>;
  /** Upsert a single resource state. */
  put(state: ResourceState): Promise<void>;
  /** Remove a single resource state (no-op if absent). */
  delete(id: string): Promise<void>;
  /**
   * Hold an exclusive lock for the duration of `fn`. The lock is re-entrant
   * within a single process call; concurrent callers wait.
   */
  lock<T>(fn: () => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class StateFileCorruptError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "StateFileCorruptError";
  }
}

export class StateLockTimeoutError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "StateLockTimeoutError";
  }
}

/* ------------------------------------------------------------------ *
 * FileStateStore
 * ------------------------------------------------------------------ */

export interface FileStateStoreOptions {
  /** Path to the state JSON file (e.g. ./scientia.state.json). */
  readonly path: string;
  /** Lock-poll interval in ms. Default 25. */
  readonly lockPollMs?: number;
  /** Give up acquiring the lock after this many ms. Default 30000. */
  readonly lockTimeoutMs?: number;
  /** Force-break a lock older than this (crashed-holder recovery). Default 60000. */
  readonly staleLockMs?: number;
}

interface LockInfo {
  readonly pid: number;
  readonly hostname: string;
  readonly createdMs: number;
}

/**
 * Local file-backed StateStore.
 *
 * - read: JSON.parse; missing file => empty state; bad JSON => `StateFileCorruptError`.
 * - write: atomic (write temp then rename).
 * - lock: exclusive lockfile via O_EXCL (`wx`), with stale-lock detection and
 *   bounded retry. This is a local, single-host lock — sufficient for v1; a
 *   distributed backend replaces it for team use (Phase 2).
 */
export class FileStateStore implements StateStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly lockPollMs: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(opts: FileStateStoreOptions) {
    this.path = opts.path;
    this.lockPath = `${opts.path}.lock`;
    this.lockPollMs = opts.lockPollMs ?? 25;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 30_000;
    this.staleLockMs = opts.staleLockMs ?? 60_000;
  }

  async read(): Promise<State> {
    let data: string;
    try {
      data = await readFile(this.path, "utf8");
    } catch (err) {
      if (isENOENT(err)) return emptyState();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw new StateFileCorruptError(
        `Failed to parse state JSON at ${this.path}: ${(err as Error).message}`,
        this.path,
      );
    }
    return normalizeState(parsed, this.path);
  }

  async write(state: State): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    const data = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = `${this.path}.tmp-${randomUUID()}`;
    await writeFile(tmp, data, "utf8");
    // Atomic replace. rename overwrites an existing destination on POSIX and
    // Windows (for files) in Node >= 10.
    await rename(tmp, this.path);
  }

  async get(id: string): Promise<ResourceState | null> {
    const state = await this.read();
    return state.resources[id] ?? null;
  }

  async put(resourceState: ResourceState): Promise<void> {
    await this.modify((state) => {
      state.resources[resourceState.id] = resourceState;
    });
  }

  async delete(id: string): Promise<void> {
    await this.modify((state) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete state.resources[id];
    });
  }

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }

  /* ------------------------- internals ------------------------- */

  private async modify(fn: (state: State) => void): Promise<void> {
    const state = await this.read();
    // Mutate a shallow clone so we never hand callers a live reference.
    const next: State = { version: STATE_VERSION, resources: { ...state.resources } };
    fn(next);
    await this.write(next);
  }

  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + this.lockTimeoutMs;
    // Ensure parent dir exists so the lockfile can be created.
    await mkdir(dirname(this.lockPath), { recursive: true });
    for (;;) {
      try {
        const handle = await open(this.lockPath, "wx");
        const info: LockInfo = { pid: process.pid, hostname: hostname(), createdMs: Date.now() };
        await handle.writeFile(JSON.stringify(info), "utf8");
        await handle.close();
        return;
      } catch (err) {
        if (!isEEXIST(err)) throw err;
        if (await this.isStale()) {
          // Holder looks dead — break and immediately retry.
          await rm(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new StateLockTimeoutError(
            `Timed out after ${this.lockTimeoutMs}ms waiting for state lock ${this.lockPath}`,
            this.lockPath,
            this.lockTimeoutMs,
          );
        }
        await sleep(this.lockPollMs + Math.random() * this.lockPollMs);
      }
    }
  }

  private async isStale(): Promise<boolean> {
    try {
      const info = JSON.parse(await readFile(this.lockPath, "utf8")) as Partial<LockInfo>;
      const created = typeof info.createdMs === "number" ? info.createdMs : 0;
      return Date.now() - created > this.staleLockMs;
    } catch {
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    await rm(this.lockPath, { force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function normalizeState(parsed: unknown, path: string): State {
  if (!isObject(parsed)) {
    throw new StateFileCorruptError(`State at ${path} is not an object`, path);
  }
  const obj = parsed as Partial<State>;
  if (obj.version !== STATE_VERSION) {
    throw new StateFileCorruptError(
      `State at ${path} has unsupported version ${String(obj.version)} (expected ${STATE_VERSION})`,
      path,
    );
  }
  const resources = isObject(obj.resources) ? (obj.resources as Record<string, ResourceState>) : {};
  return { version: STATE_VERSION, resources };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isEEXIST(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
