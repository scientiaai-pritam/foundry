import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMigrate,
  runMigrateDown,
  runMigrateStatus,
  runMigrateDryRun,
  type CLIContext,
} from "../src/index.js";
import type {
  AppliedMigration,
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
} from "../src/index.js";
import type { StateStore, State } from "../src/index.js";
import type { ResourceState } from "../src/index.js";

/** Minimal in-memory StateStore (no existing impl to reuse). */
function memState(): StateStore {
  let resources: Record<string, ResourceState> = {};
  return {
    read: async (): Promise<State> => ({ version: 1 as const, resources }),
    write: async (s) => {
      resources = s.resources;
    },
    get: async (id) => resources[id] ?? null,
    put: async (r) => {
      resources[r.id] = r;
    },
    delete: async (id) => {
      delete resources[id];
    },
    lock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
}

interface FakePgOpts {
  applied?: AppliedMigration[];
  migrateResult?: MigrationResult;
  rollbackResult?: MigrationResult;
}
function fakePgConnector(opts: FakePgOpts = {}): {
  connector: Connector;
  calls: {
    migrate: Migration[][];
    rollback: { migrations: Migration[]; count: number }[];
    status: number;
  };
} {
  const calls = {
    migrate: [] as Migration[][],
    rollback: [] as { migrations: Migration[]; count: number }[],
    status: 0,
  };
  const conn: Connection = {
    engine: "postgres",
    client: {},
    pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
    close: async () => {},
  };
  const connector: Connector = {
    engine: "postgres",
    connect: vi.fn(async (_t: ConnectionTarget): Promise<Connection> => conn),
    health: vi.fn(async (): Promise<HealthStatus> => ({ ok: true, latencyMs: 0 })),
    migrate: vi.fn(async (_c: Connection, migrations: Migration[]) => {
      calls.migrate.push(migrations);
      return opts.migrateResult ?? { applied: migrations.map((m) => m.id), skipped: [], errors: [] };
    }),
    rollback: vi.fn(async (_c: Connection, migrations: Migration[], count: number) => {
      calls.rollback.push({ migrations, count });
      return opts.rollbackResult ?? { applied: migrations.slice(0, count).map((m) => m.id), skipped: [], errors: [] };
    }),
    migrationStatus: vi.fn(async () => {
      calls.status++;
      return opts.applied ?? [];
    }),
  };
  return { connector, calls };
}

function ctxWith(
  connector: Connector,
  cwd: string,
): CLIContext {
  return {
    cwd,
    stack: {
      databases: {
        db: { engine: "postgres", provision: "external", connectionString: { from: "env:PG" } },
      },
    },
    state: memState(),
    provisioners: new Map(),
    connectors: new Map([["postgres", connector]]),
    logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("CLI migrate dispatch", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "foundry-cli-mig-"));
    await mkdir(join(cwd, "migrations", "db"), { recursive: true });
    await writeFile(join(cwd, "migrations", "db", "000001_a.up.sql"), "A;");
    await writeFile(join(cwd, "migrations", "db", "000001_a.down.sql"), "A-down;");
    await writeFile(join(cwd, "migrations", "db", "000002_b.up.sql"), "B;");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("up: loads from disk and applies pending", async () => {
    const { connector, calls } = fakePgConnector();
    const ctx = ctxWith(connector, cwd);
    const res = await runMigrate(ctx, "db", await loadDisk(ctx, "db"));
    expect(res.applied).toEqual(["000001", "000002"]);
    expect(calls.migrate[0]!.map((m) => m.id)).toEqual(["000001", "000002"]);
  });

  it("down: default count is 1", async () => {
    const { connector, calls } = fakePgConnector();
    const ctx = ctxWith(connector, cwd);
    await runMigrateDown(ctx, "db", await loadDisk(ctx, "db"));
    expect(calls.rollback[0]!.count).toBe(1);
  });

  it("down: explicit count", async () => {
    const { connector, calls } = fakePgConnector();
    const ctx = ctxWith(connector, cwd);
    await runMigrateDown(ctx, "db", await loadDisk(ctx, "db"), { count: 2 });
    expect(calls.rollback[0]!.count).toBe(2);
  });

  it("status: reports applied/pending/tampered", async () => {
    const applied: AppliedMigration[] = [
      { id: "000001", description: "a", checksum: "WRONG", appliedAt: new Date(0) },
    ];
    const { connector } = fakePgConnector({ applied });
    const ctx = ctxWith(connector, cwd);
    const status = await runMigrateStatus(ctx, "db", await loadDisk(ctx, "db"));
    expect(status.applied.map((a) => a.id)).toEqual(["000001"]);
    expect(status.pending.map((p) => p.id)).toEqual(["000002"]);
    expect(status.tampered.map((t) => t.id)).toEqual(["000001"]); // checksum mismatch
  });

  it("dry-run: hasWork true when pending exist", async () => {
    const { connector } = fakePgConnector({ applied: [] });
    const ctx = ctxWith(connector, cwd);
    const { status, hasWork } = await runMigrateDryRun(ctx, "db", await loadDisk(ctx, "db"));
    expect(hasWork).toBe(true);
    expect(status.pending).toHaveLength(2);
  });

  it("dry-run: hasWork false when fully applied + no tamper", async () => {
    const onDisk = await loadDisk(ctxWith(fakePgConnector().connector, cwd), "db");
    const applied: AppliedMigration[] = onDisk.map((m) => ({
      id: m.id,
      description: m.description,
      checksum: checksumOf(m.up),
      appliedAt: new Date(0),
    }));
    const { connector } = fakePgConnector({ applied });
    const ctx = ctxWith(connector, cwd);
    const { hasWork } = await runMigrateDryRun(ctx, "db", onDisk);
    expect(hasWork).toBe(false);
  });
});

// Helpers used above (kept at the bottom to mirror house style).
import { loadMigrations, resolveMigrationDir, checksumMigration } from "../src/index.js";
function loadDisk(ctx: CLIContext, dbId: string) {
  return loadMigrations(resolveMigrationDir(ctx.cwd, dbId));
}
function checksumOf(up: string): string {
  return checksumMigration(up);
}
