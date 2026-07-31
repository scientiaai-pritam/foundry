import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApply, type CLIContext, type Plan } from "../src/index.js";
import type {
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceState,
} from "../src/index.js";
import type { StateStore, State } from "../src/index.js";

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

function producedState(id: string): ResourceState {
  return {
    id,
    kind: "aws.rds-postgres",
    identifiers: { arn: `arn:aws:rds:::${id}` },
    status: "available",
    connection: { engine: "postgres", endpoint: `${id}.example:5432`, credsRef: { from: "env:PG" } },
  };
}

describe("apply --migrate", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "foundry-apply-mig-"));
    await mkdir(join(cwd, "migrations", "db"), { recursive: true });
    await writeFile(join(cwd, "migrations", "db", "000001_init.up.sql"), "CREATE TABLE t ();");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs pending migrations against the produced ConnectionTarget after create", async () => {
    const migrate = vi.fn(
      async (_c: Connection, migrations: Migration[]): Promise<MigrationResult> => ({
        applied: migrations.map((m) => m.id),
        skipped: [],
        errors: [],
      }),
    );
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
      migrate,
    };
    const provisioner: Provisioner = {
      kind: "aws.rds-postgres" satisfies ResourceKind,
      plan: vi.fn(() => ({ op: "create", spec: { id: "db", kind: "aws.rds-postgres", props: {} } }) as PlanAction),
      apply: vi.fn(async () => producedState("db")),
      read: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };

    const ctx: CLIContext = {
      cwd,
      stack: {
        databases: {
          db: { engine: "postgres", provision: { kind: "aws.rds-postgres" } },
        },
      },
      state: memState(),
      provisioners: new Map([["aws.rds-postgres", provisioner]]),
      connectors: new Map([["postgres", connector]]),
      logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    const plan: Plan = {
      actions: [{ op: "create", spec: { id: "db", kind: "aws.rds-postgres", props: {} } }],
      drift: [],
    };

    const result = await runApply(ctx, plan, { migrate: true });
    expect(result.failed).toBe(0);
    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate.mock.calls[0]![1]!.map((m) => m.id)).toEqual(["000001"]);
    const step = result.results.find((r) => r.id === "db")!;
    expect(step.migrations).toEqual({ applied: 1, skipped: 0, errors: 0 });
  });

  it("skips migration when the connector lacks migrate", async () => {
    const conn: Connection = {
      engine: "dynamodb",
      client: {},
      pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
      close: async () => {},
    };
    const connector: Connector = {
      engine: "dynamodb",
      connect: vi.fn(async () => conn),
      health: vi.fn(async () => ({ ok: true, latencyMs: 0 })),
      // no migrate
    };
    const provisioner: Provisioner = {
      kind: "aws.dynamodb" satisfies ResourceKind,
      plan: vi.fn(() => ({ op: "create", spec: { id: "db", kind: "aws.dynamodb", props: {} } }) as PlanAction),
      apply: vi.fn(async () => ({
        id: "db",
        kind: "aws.dynamodb",
        identifiers: { arn: "arn:aws:dynamodb:::db" },
        status: "available",
        connection: { engine: "dynamodb", region: "us-east-1" },
      })),
      read: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const ctx: CLIContext = {
      cwd,
      stack: { databases: { db: { engine: "dynamodb", provision: { kind: "aws.dynamodb" } } } },
      state: memState(),
      provisioners: new Map([["aws.dynamodb", provisioner]]),
      connectors: new Map([["dynamodb", connector]]),
      logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };
    const plan: Plan = {
      actions: [{ op: "create", spec: { id: "db", kind: "aws.dynamodb", props: {} } }],
      drift: [],
    };
    const result = await runApply(ctx, plan, { migrate: true });
    expect(result.failed).toBe(0);
    expect(result.results.find((r) => r.id === "db")!.migrations).toBeUndefined();
  });
});
