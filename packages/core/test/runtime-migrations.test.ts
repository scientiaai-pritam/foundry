import { describe, it, expect, vi } from "vitest";
import { ConnectionManager, ConnectionRegistry } from "../src/index.js";
import type {
  AppliedMigration,
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
} from "../src/index.js";

function setup(overrides: Partial<Connector> = {}): {
  manager: ConnectionManager;
  connector: Connector;
  conn: Connection;
} {
  const conn: Connection = {
    engine: "postgres",
    client: {},
    pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
    close: vi.fn(async () => {}),
  };
  const connector: Connector = {
    engine: "postgres",
    connect: vi.fn(async (_target: ConnectionTarget): Promise<Connection> => conn),
    health: vi.fn(async (): Promise<HealthStatus> => ({ ok: true, latencyMs: 0 })),
    ...overrides,
  };
  const registry = new ConnectionRegistry(new Map([["postgres", connector]]), {
    stack: {
      databases: {
        db: { engine: "postgres", provision: "external", connectionString: { from: "env:PG" } },
      },
    },
  });
  return { manager: new ConnectionManager(registry), connector, conn };
}

const okResult = (ids: string[]): MigrationResult => ({ applied: ids, skipped: [], errors: [] });

describe("ConnectionManager rollback / migrationStatus", () => {
  it("delegates rollback to the connector with the count", async () => {
    const rollback = vi.fn(async (_c: Connection, _m: Migration[], count: number) => okResult(["000002"].slice(0, count)));
    const { manager } = setup({ rollback });
    await manager.connect("db");
    const res = await manager.rollback("db", [{ id: "000002", up: "x", down: "y" }], 1);
    expect(res.applied).toEqual(["000002"]);
    expect(rollback).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 1);
  });

  it("delegates migrationStatus to the connector", async () => {
    const rows: AppliedMigration[] = [{ id: "000001", checksum: "abc", appliedAt: new Date(0) }];
    const migrationStatus = vi.fn(async () => rows);
    const { manager } = setup({ migrationStatus });
    await manager.connect("db");
    const out = await manager.migrationStatus("db");
    expect(out).toBe(rows);
  });

  it("throws ConnectionError when the connector lacks rollback", async () => {
    const { manager } = setup();
    await manager.connect("db");
    await expect(manager.rollback("db", [], 1)).rejects.toThrow(/does not support migrations/);
  });

  it("throws ConnectionError when the connector lacks migrationStatus", async () => {
    const { manager } = setup();
    await manager.connect("db");
    await expect(manager.migrationStatus("db")).rejects.toThrow(/does not support migrations/);
  });
});
