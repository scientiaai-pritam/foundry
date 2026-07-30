/**
 * FileStateStore unit tests (design §8: "state read/write" + lock semantics).
 *
 * Uses a real temp directory; no cloud. Exercises read/write/get/put/delete and
 * the local file lock (mutual exclusion, release-on-error, stale-break, timeout).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore, StateLockTimeoutError, emptyState, type State } from "../src/state/index.js";
import type { ResourceState } from "../src/contracts.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-state-"));
  path = join(dir, "foundry.state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function rs(id: string): ResourceState {
  return {
    id,
    kind: "aws.rds-postgres",
    identifiers: { arn: `arn:aws:rds:::${id}` },
    status: "available",
    connection: {
      engine: "postgres",
      endpoint: `${id}.example:5432`,
      credsRef: { secretId: `foundry/${id}` },
    },
  };
}

describe("FileStateStore read/write", () => {
  it("returns an empty state when the file does not exist", async () => {
    const store = new FileStateStore({ path });
    const state = await store.read();
    expect(state).toEqual(emptyState());
    expect(state.resources).toEqual({});
  });

  it("persists and round-trips a full state via write/read", async () => {
    const store = new FileStateStore({ path });
    const state: State = {
      version: 1,
      resources: { analytics: rs("analytics") },
    };
    await store.write(state);
    const read = await store.read();
    expect(read.version).toBe(1);
    expect(read.resources.analytics?.id).toBe("analytics");
    expect(read.resources.analytics?.connection.credsRef).toEqual({ secretId: "foundry/analytics" });
  });

  it("does not store secret values — only credsRef pointers", async () => {
    const store = new FileStateStore({ path });
    await store.put(rs("analytics"));
    // The raw file must contain only a secretId reference, never a credential.
    // (Sanity check on the contract guarantee from design §5.)
    const raw = await import("node:fs/promises").then((m) => m.readFile(path, "utf8"));
    expect(raw).toContain('"secretId"');
    expect(raw).not.toMatch(/password|apiKey|secret\s*:/i);
  });

  it("rejects corrupt JSON with StateFileCorruptError", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, "{ not valid json");
    const store = new FileStateStore({ path });
    await expect(store.read()).rejects.toThrow(/Failed to parse state JSON/);
  });

  it("rejects an unsupported state version", async () => {
    await writeFile(path, JSON.stringify({ version: 999, resources: {} }));
    const store = new FileStateStore({ path });
    await expect(store.read()).rejects.toThrow(/unsupported version/);
  });
});

describe("FileStateStore get/put/delete", () => {
  it("get returns null for an absent id", async () => {
    const store = new FileStateStore({ path });
    expect(await store.get("nope")).toBeNull();
  });

  it("put upserts and get reads back", async () => {
    const store = new FileStateStore({ path });
    await store.put(rs("x"));
    expect((await store.get("x"))?.id).toBe("x");
    // upsert (update in place)
    const updated = { ...rs("x"), status: "updating" as const };
    await store.put(updated);
    expect((await store.get("x"))?.status).toBe("updating");
  });

  it("delete removes an entry and is a no-op when absent", async () => {
    const store = new FileStateStore({ path });
    await store.put(rs("x"));
    await store.delete("x");
    expect(await store.get("x")).toBeNull();
    // idempotent
    await expect(store.delete("x")).resolves.toBeUndefined();
  });
});

describe("FileStateStore lock", () => {
  it("serializes concurrent lock holders", async () => {
    const store = new FileStateStore({ path, lockPollMs: 5 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const p1 = store.lock(async () => {
      order.push("p1-acquire");
      await gate;
      order.push("p1-release");
    });

    // Wait for p1 to acquire the lock by checking the order array
    while (order.length === 0) {
      await new Promise((r) => setTimeout(r, 1));
    }

    const p2 = store.lock(async () => {
      order.push("p2-acquire");
    });

    // Flush microtasks to ensure p2's lock() call has started
    await new Promise((r) => setTimeout(r, 0));

    // p2 should be blocked (not yet acquired) while p1 holds the lock
    expect(order).toEqual(["p1-acquire"]);

    // Verify p2 is still pending by checking order hasn't changed
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["p1-acquire"]);

    // Release p1's gate and wait for both to complete
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["p1-acquire", "p1-release", "p2-acquire"]);
  });

  it("releases the lock if the critical section throws", async () => {
    const store = new FileStateStore({ path });
    await expect(store.lock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // A subsequent acquire must succeed immediately (lock was released).
    let ran = false;
    await store.lock(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("breaks a stale lock left by a crashed holder", async () => {
    const lockPath = `${path}.lock`;
    await mkdir(dir, { recursive: true });
    // A lockfile well past the stale threshold.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, hostname: "ghost", createdMs: Date.now() - 60_000 }),
    );
    const store = new FileStateStore({ path, staleLockMs: 1000, lockPollMs: 5 });
    let ran = false;
    await store.lock(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("times out when a live (non-stale) foreign lock is held", async () => {
    const lockPath = `${path}.lock`;
    await mkdir(dir, { recursive: true });
    // A fresh lockfile owned by some other process.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, hostname: "other", createdMs: Date.now() }),
    );
    const store = new FileStateStore({ path, lockTimeoutMs: 40, lockPollMs: 5, staleLockMs: 60_000 });
    await expect(store.lock(async () => {})).rejects.toBeInstanceOf(StateLockTimeoutError);
    // The foreign lock must be left intact (we never owned it).
    const raw = await import("node:fs/promises").then((m) => m.readFile(lockPath, "utf8"));
    expect(JSON.parse(raw).hostname).toBe("other");
  });

  it("lock wraps a value-returning critical section", async () => {
    const store = new FileStateStore({ path });
    const value = await store.lock(async () => 42);
    expect(value).toBe(42);
  });
});
