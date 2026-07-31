/**
 * Tests for @foundry/connector-redshift.
 *
 * The `pg` driver is mocked via vi.mock so tests never open a real socket.
 * Secrets Manager (for { secretId } credsRef) is mocked via aws-sdk-client-mock.
 * Verifies connection config building (Redshift SSL/port defaults), pool stats
 * read live from pg.Pool, health (SELECT 1), the migration runner, credential
 * resolution, and that secrets are never logged.
 */

import assert from "node:assert";
import { vi, beforeEach, afterEach } from "vitest";
import { redshiftConnector } from "../src/connector";
import { checksumMigration } from "@foundry/core";
import type { ConnectionTarget, SecretRef } from "@foundry/core";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

// Hoisted mock state. vi.mock is hoisted above imports, so any values the
// factory closes over must come from vi.hoisted (plain module-scope lets would
// still be in their temporal dead zone when the factory runs).
const mocks = vi.hoisted(() => ({
  // pg.Pool.query / connect / end, shared across every Pool instance in a test.
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  // Records the PoolConfig passed to each `new Pool(config)`.
  ctor: vi.fn(),
  // Live pool counters the connector reads via getPoolStats(). Snapshotted into
  // each Pool at construction so a test can set these BEFORE connect().
  stats: { totalCount: 0, idleCount: 0, waitingCount: 0 },
}));

vi.mock("pg", () => ({
  Pool: vi.fn((config?: unknown) => {
    mocks.ctor(config);
    return {
      totalCount: mocks.stats.totalCount,
      idleCount: mocks.stats.idleCount,
      waitingCount: mocks.stats.waitingCount,
      expiredCount: 0,
      ending: false,
      ended: false,
      query: mocks.query,
      connect: mocks.connect,
      end: mocks.end,
    };
  }),
}));

const VALID_CREDS_JSON = JSON.stringify({
  host: "redshift-cluster.example",
  port: 5439,
  user: "admin",
  password: "super-secret",
  database: "dev",
});

function lastPoolConfig(): Record<string, unknown> {
  const config = mocks.ctor.mock.calls[0]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!config) {
    throw new Error("pg.Pool was not constructed");
  }
  return config;
}

describe("Redshift Connector", () => {
  let smMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.connect.mockReset();
    mocks.end.mockReset();
    mocks.ctor.mockReset();
    mocks.stats = { totalCount: 0, idleCount: 0, waitingCount: 0 };
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.end.mockResolvedValue(undefined);

    smMock = mockClient(SecretsManagerClient);
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: VALID_CREDS_JSON,
      $metadata: {},
    });

    process.env.REDSHIFT_CREDS = VALID_CREDS_JSON;
  });

  afterEach(() => {
    smMock.restore();
    delete process.env.REDSHIFT_CREDS;
  });

  describe("connect()", () => {
    it("creates a pg.Pool and returns a redshift Connection", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      const conn = await redshiftConnector.connect(target);

      assert.strictEqual(conn.engine, "redshift");
      assert(conn.client, "client (pg.Pool) exists");
      assert.strictEqual(typeof conn.close, "function");
      assert.strictEqual(mocks.ctor.mock.calls.length, 1);
    });

    it("requires credsRef", async () => {
      const target: ConnectionTarget = { engine: "redshift", region: "us-east-1" };

      await assert.rejects(
        () => redshiftConnector.connect(target),
        /Redshift requires credsRef/,
      );
    });

    it("builds pg.Pool config from JSON creds", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await redshiftConnector.connect(target);

      const config = lastPoolConfig();
      assert.strictEqual(config.host, "redshift-cluster.example");
      assert.strictEqual(config.user, "admin");
      assert.strictEqual(config.password, "super-secret");
      assert.strictEqual(config.database, "dev");
      assert.strictEqual(config.port, 5439);
    });

    it("applies the Redshift SSL default ({ rejectUnauthorized: false })", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await redshiftConnector.connect(target);

      assert.deepStrictEqual(lastPoolConfig().ssl, { rejectUnauthorized: false });
    });

    it("defaults port to 5439 when JSON creds omit port", async () => {
      process.env.REDSHIFT_CREDS = JSON.stringify({
        host: "h",
        user: "u",
        password: "p",
        database: "d",
      });
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await redshiftConnector.connect(target);

      assert.strictEqual(lastPoolConfig().port, 5439);
      assert.deepStrictEqual(lastPoolConfig().ssl, { rejectUnauthorized: false });
    });

    it("honors an explicit ssl override from JSON creds", async () => {
      process.env.REDSHIFT_CREDS = JSON.stringify({
        host: "h",
        user: "u",
        password: "p",
        database: "d",
        ssl: true,
      });
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await redshiftConnector.connect(target);

      assert.strictEqual(lastPoolConfig().ssl, true);
    });

    it("accepts a libpq connection string", async () => {
      process.env.REDSHIFT_CREDS =
        "postgresql://admin:super-secret@redshift-cluster.example:5439/dev";
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await redshiftConnector.connect(target);

      assert.strictEqual(
        lastPoolConfig().connectionString,
        "postgresql://admin:super-secret@redshift-cluster.example:5439/dev",
      );
      // SSL still enforced even with a connection string.
      assert.deepStrictEqual(lastPoolConfig().ssl, { rejectUnauthorized: false });
    });

    it("rejects JSON creds missing a required field", async () => {
      process.env.REDSHIFT_CREDS = JSON.stringify({
        host: "h",
        user: "u",
        password: "p",
        // database missing
      });
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await assert.rejects(
        () => redshiftConnector.connect(target),
        /requires non-empty "database"/,
      );
    });

    it("resolves secretId credsRef via Secrets Manager", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };

      const conn = await redshiftConnector.connect(target);

      assert.strictEqual(conn.engine, "redshift");
      assert.strictEqual(
        smMock.commandCalls(GetSecretValueCommand).length,
        1,
        "GetSecretValue should be called once",
      );
      // JSON creds from the secret had port 5439.
      assert.strictEqual(lastPoolConfig().port, 5439);
    });

    it("throws on a malformed credsRef", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: {} as SecretRef,
      };

      await assert.rejects(
        () => redshiftConnector.connect(target),
        /Invalid credsRef format/,
      );
    });

    it("throws when the env var is unset", async () => {
      delete process.env.REDSHIFT_CREDS;
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await assert.rejects(
        () => redshiftConnector.connect(target),
        /Environment variable "REDSHIFT_CREDS" is not set/,
      );
    });

    it("close() ends the pool", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      const conn = await redshiftConnector.connect(target);
      await conn.close();

      assert.strictEqual(mocks.end.mock.calls.length, 1);
    });
  });

  describe("health()", () => {
    it("returns ok:true issuing SELECT 1", async () => {
      mocks.query.mockReset();
      mocks.query.mockResolvedValueOnce({
        rows: [{ "?column?": 1 }],
        rowCount: 1,
      });

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };
      const conn = await redshiftConnector.connect(target);
      const status = await redshiftConnector.health(conn);

      assert.strictEqual(status.ok, true);
      assert.strictEqual(typeof status.latencyMs, "number");
      assert(status.detail);
      assert.strictEqual(mocks.query.mock.calls[0]?.[0], "SELECT 1");
    });

    it("returns ok:false with the error message", async () => {
      mocks.query.mockReset();
      mocks.query.mockRejectedValueOnce(new Error("connection refused"));

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };
      const conn = await redshiftConnector.connect(target);
      const status = await redshiftConnector.health(conn);

      assert.strictEqual(status.ok, false);
      assert.strictEqual(typeof status.latencyMs, "number");
      assert.strictEqual(status.detail, "connection refused");
    });
  });

  describe("migrate / rollback / migrationStatus", () => {
    const MIGRATIONS_TABLE = "__foundry_migrations";
    // Checksum-aware routing over the shared mocks.query. Models the
    // __foundry_migrations table as a Map<id, checksum> and optionally fails
    // specific migration.up statements. pool.connect() returns a client whose
    // query is the SAME mocks.query spy, so the migrate flow is observable
    // through one fn.
    function applyMigrateMock(appliedChecksums: Map<string, string>, failingUps: Set<string>) {
      mocks.query.mockImplementation(async (text: string, values?: unknown[]) => {
        if (text.includes("CREATE TABLE") && text.includes(MIGRATIONS_TABLE)) return { rowCount: 0, rows: [] };
        if (text.startsWith("SELECT checksum FROM")) {
          const id = values?.[0] as string;
          const cs = appliedChecksums.get(id);
          return cs ? { rowCount: 1, rows: [{ checksum: cs }] } : { rowCount: 0, rows: [] };
        }
        if (text.startsWith("INSERT INTO")) {
          appliedChecksums.set(values?.[0] as string, values?.[2] as string);
          return { rowCount: 1, rows: [] };
        }
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
        if (failingUps.has(text)) throw new Error(`migration failed: ${text}`);
        return { rowCount: 0, rows: [] };
      });
    }

    function emptyPool() {
      return { size: 0, idle: 0, inUse: 0, waiting: 0 };
    }

    // Stand-in for a Connection whose .client is a mock pg.Pool (so conn.client
    // as Pool yields an object whose query/connect are the shared mocks spies).
    function fakeConn(): never {
      return {
        engine: "redshift",
        client: { query: mocks.query, connect: mocks.connect, end: mocks.end },
        pool: emptyPool(),
        close: async () => {},
      } as never;
    }

    beforeEach(() => {
      mocks.query.mockReset();
      mocks.query.mockResolvedValue({ rowCount: 0, rows: [] });
      mocks.connect.mockResolvedValue({ query: mocks.query, release: vi.fn() });
    });

    it("applies pending migrations and records checksums", async () => {
      const applied = new Map<string, string>();
      applyMigrateMock(applied, new Set());
      const res = await redshiftConnector.migrate!(fakeConn(), [
        { id: "000001", description: "a", up: "CREATE TABLE a ();" },
        { id: "000002", description: "b", up: "CREATE TABLE b ();" },
      ]);
      expect(res.applied).toEqual(["000001", "000002"]);
      expect(applied.get("000001")).toBe(checksumMigration("CREATE TABLE a ();"));
    });

    it("skips already-applied with matching checksum", async () => {
      const applied = new Map<string, string>([["000001", checksumMigration("CREATE TABLE a ();")]]);
      applyMigrateMock(applied, new Set());
      const res = await redshiftConnector.migrate!(fakeConn(), [
        { id: "000001", description: "a", up: "CREATE TABLE a ();" },
      ]);
      expect(res.skipped).toEqual(["000001"]);
      expect(res.applied).toEqual([]);
    });

    it("detects tampering and stops", async () => {
      const applied = new Map<string, string>([["000001", "STALE-CHECKSUM"]]);
      applyMigrateMock(applied, new Set());
      const res = await redshiftConnector.migrate!(fakeConn(), [
        { id: "000001", description: "a", up: "CREATE TABLE a ();" },
        { id: "000002", description: "b", up: "CREATE TABLE b ();" },
      ]);
      expect(res.errors[0]?.id).toBe("000001");
      expect(res.errors[0]?.error).toMatch(/checksum mismatch/);
      expect(res.applied).toEqual([]); // stopped before applying 000002
    });

    it("rolls back the newest N migrations", async () => {
      // SELECT id ... DESC LIMIT returns 000002 then 000001; DELETE is routed.
      mocks.query.mockImplementation(async (text: string) => {
        if (text.startsWith("SELECT id FROM")) return { rowCount: 2, rows: [{ id: "000002" }, { id: "000001" }] };
        if (text.startsWith("DELETE FROM")) return { rowCount: 1, rows: [] };
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      });
      const rollback = redshiftConnector.rollback!;
      const res = await rollback(
        fakeConn(),
        [
          { id: "000001", up: "x", down: "DROP a;" },
          { id: "000002", up: "x", down: "DROP b;" },
        ],
        2,
      );
      expect(res.applied).toEqual(["000002", "000001"]);
    });

    it("errors when a down migration is missing", async () => {
      mocks.query.mockImplementation(async (text: string) => {
        if (text.startsWith("SELECT id FROM")) return { rowCount: 1, rows: [{ id: "000001" }] };
        return { rowCount: 0, rows: [] };
      });
      const rollback = redshiftConnector.rollback!;
      const res = await rollback(
        fakeConn(),
        [{ id: "000001", up: "x" }], // no down
        1,
      );
      expect(res.errors[0]?.error).toMatch(/no down migration/);
    });

    it("migrationStatus maps tracking rows", async () => {
      mocks.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ id: "000001", description: "a", checksum: "abc", applied_at: new Date(0) }],
      });
      const status = redshiftConnector.migrationStatus!;
      const out = await status(fakeConn());
      expect(out[0]?.id).toBe("000001");
      expect(out[0]?.checksum).toBe("abc");
    });
  });

  describe("Connector interface compliance", () => {
    it("has engine 'redshift' and connect/health/migrate methods", () => {
      assert.strictEqual(redshiftConnector.engine, "redshift");
      assert.strictEqual(typeof redshiftConnector.connect, "function");
      assert.strictEqual(typeof redshiftConnector.health, "function");
      assert.strictEqual(typeof redshiftConnector.migrate, "function");
    });
  });

  describe("Pool stats", () => {
    it("reads live stats from pg.Pool (not static zeros)", async () => {
      mocks.stats = { totalCount: 5, idleCount: 2, waitingCount: 1 };
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      const conn = await redshiftConnector.connect(target);

      assert.deepStrictEqual(conn.pool, {
        size: 5,
        idle: 2,
        inUse: 3, // totalCount - idleCount
        waiting: 1,
      });
    });
  });

  describe("Security", () => {
    it("never logs the resolved secret value", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      try {
        await redshiftConnector.connect(target);
        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("super-secret"),
          false,
          "secret values must never be logged",
        );
      } finally {
        console.log = originalLog;
      }
    });

    it("never logs the secretId", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "arn:aws:secretsmanager:us-east-1:123:secret:redshift/master-ABC" },
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      try {
        await redshiftConnector.connect(target);
        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("arn:aws:secretsmanager"),
          false,
          "secret ARNs must never be logged",
        );
      } finally {
        console.log = originalLog;
      }
    });
  });
});
