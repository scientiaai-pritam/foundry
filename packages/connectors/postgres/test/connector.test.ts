/**
 * Unit + functional tests for @foundry/connector-postgres.
 *
 * `pg` is mocked with vi.mock (a MockPool exposing totalCount/idleCount/waitingCount
 * plus query/connect/end spies). The AWS Secrets Manager path is mocked with
 * aws-sdk-client-mock, mirroring the DynamoDB connector tests. No real database
 * or live AWS credentials are required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { postgresConnector } from "../src/connector";

// --- pg mock ---------------------------------------------------------------
// A single shared mock Pool is returned by `new Pool(config)`. pool.query and
// the PoolClient returned by pool.connect() share the SAME query spy so the
// migrate flow (which uses client.query) is observable through one fn.
const pgMock = vi.hoisted(() => {
  const query = vi.fn();
  const end = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const poolClient = { query, release };
  const connect = vi.fn().mockResolvedValue(poolClient);
  const pool = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query,
    connect,
    end,
  };
  return { pool, query, end, release, connect, poolClient };
});

vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation(() => pgMock.pool);
  return { Pool };
});

const PG_CONN_JSON = JSON.stringify({
  host: "db.example.com",
  port: 5432,
  user: "appuser",
  password: "super-secret-pg-password",
  database: "appdb",
});

// The Connector contract marks `migrate` optional (not every engine supports
// migrations — e.g. DynamoDB is schemaless). The postgres connector always
// implements it; narrow once here so the tests below can invoke it directly.
const migrate = postgresConnector.migrate;
if (!migrate) {
  throw new Error("postgresConnector.migrate is not defined");
}

describe("Postgres Connector", () => {
  let smMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    pgMock.query.mockReset();
    pgMock.end.mockReset();
    pgMock.connect.mockReset();
    pgMock.release.mockReset();
    // Sensible defaults: any query resolves to an empty result.
    pgMock.query.mockResolvedValue({ rowCount: 0, rows: [] });
    pgMock.connect.mockResolvedValue(pgMock.poolClient);
    pgMock.end.mockResolvedValue(undefined);
    pgMock.pool.totalCount = 0;
    pgMock.pool.idleCount = 0;
    pgMock.pool.waitingCount = 0;

    process.env.PG_CONN = "postgres://appuser:super-secret@db.example.com:5432/appdb";

    smMock = mockClient(SecretsManagerClient);
    smMock
      .on(GetSecretValueCommand)
      .resolves({ SecretString: PG_CONN_JSON, $metadata: {} });
  });

  afterEach(() => {
    smMock.restore();
    delete process.env.PG_CONN;
    delete process.env.SECRET_PASSWORD;
  });

  describe("connect()", () => {
    it("creates a Pool from a connection-string env ref", async () => {
      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      expect(conn).toBeTruthy();
      expect(conn.engine).toBe("postgres");
      expect(conn.client).toBe(pgMock.pool); // client is the live pg.Pool
      expect(typeof conn.close).toBe("function");
    });

    it("creates a Pool from a JSON connection document", async () => {
      process.env.PG_CONN = PG_CONN_JSON;

      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      expect(conn).toBeTruthy();
      expect(conn.engine).toBe("postgres");
      expect(conn.client).toBe(pgMock.pool);
    });

    it("accepts a secretId credsRef (resolved via Secrets Manager)", async () => {
      const conn = await postgresConnector.connect({
        engine: "postgres",
        region: "us-east-1",
        credsRef: { secretId: "prod/postgres/app" },
      });

      expect(conn).toBeTruthy();
      // secretId credsRef can only yield a Pool if the secret was resolved via
      // Secrets Manager (the smMock returns a JSON connection document).
      expect(conn.engine).toBe("postgres");
      expect(conn.client).toBe(pgMock.pool);
    });

    it("throws if credsRef is missing (pg has no ambient credential chain)", async () => {
      await expect(
        postgresConnector.connect({ engine: "postgres" }),
      ).rejects.toThrow(/Postgres requires "credsRef"/);
    });

    it("throws if the env var referenced by credsRef is unset", async () => {
      delete process.env.PG_CONN;

      await expect(
        postgresConnector.connect({
          engine: "postgres",
          credsRef: { from: "env:PG_CONN" },
        }),
      ).rejects.toThrow(/Environment variable "PG_CONN" is not set/);
    });

    it("rejects an invalid credsRef format", async () => {
      await expect(
        postgresConnector.connect({
          engine: "postgres",
          // Invalid: neither `from` nor `secretId`.
          credsRef: {} as never,
        }),
      ).rejects.toThrow(/Invalid credsRef format/);
    });

    it("fails fast on JSON missing required fields (does not leak as a connection string)", async () => {
      // JSON, but missing password/database — must NOT be passed to pg as a
      // connection string (which could echo the blob in a parse error).
      process.env.PG_CONN = JSON.stringify({ host: "h", port: 5432, user: "u" });

      await expect(
        postgresConnector.connect({
          engine: "postgres",
          credsRef: { from: "env:PG_CONN" },
        }),
      ).rejects.toThrow(/JSON missing required fields/);
    });
  });

  describe("close()", () => {
    it("calls pool.end()", async () => {
      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      await conn.close();

      expect(pgMock.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("health()", () => {
    it("returns ok: true with latency on a successful SELECT 1", async () => {
      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      const status = await postgresConnector.health(conn);

      expect(status.ok).toBe(true);
      expect(typeof status.latencyMs).toBe("number");
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      expect(status.detail).toBe("SELECT 1 succeeded");
      expect(pgMock.query).toHaveBeenCalledWith("SELECT 1");
    });

    it("returns ok: false with the driver error on failure", async () => {
      pgMock.query.mockReset();
      pgMock.query.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      const status = await postgresConnector.health(conn);

      expect(status.ok).toBe(false);
      expect(typeof status.latencyMs).toBe("number");
      expect(status.detail).toBe("connect ECONNREFUSED 127.0.0.1:5432");
    });
  });

  describe("migrate()", () => {
    // Shared query implementation that models the __foundry_migrations table
    // against an in-memory Set of applied ids, optionally failing specific
    // migration.up statements.
    const MIGRATIONS_TABLE = "__foundry_migrations";
    function applyMigrateMock(appliedIds: Set<string>, failingUps: Set<string>) {
      pgMock.query.mockImplementation(
        async (text: string, values?: unknown[]) => {
          if (text.includes("CREATE TABLE") && text.includes(MIGRATIONS_TABLE)) {
            return { rowCount: 0, rows: [] };
          }
          if (text.startsWith("SELECT id FROM")) {
            const id = values?.[0] as string;
            return { rowCount: appliedIds.has(id) ? 1 : 0, rows: [] };
          }
          if (text.startsWith("INSERT INTO")) {
            const id = values?.[0] as string;
            appliedIds.add(id);
            return { rowCount: 1, rows: [] };
          }
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rowCount: 0, rows: [] };
          }
          // Otherwise this is a migration.up statement.
          if (failingUps.has(text)) {
            throw new Error(`migration failed: ${text}`);
          }
          return { rowCount: 0, rows: [] };
        },
      );
    }

    it("creates the tracking table and applies new migrations in order", async () => {
      const appliedIds = new Set<string>();
      applyMigrateMock(appliedIds, new Set());

      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      const result = await migrate(conn, [
        { id: "0001", description: "first", up: "CREATE TABLE a (id int)" },
        { id: "0002", description: "second", up: "CREATE TABLE b (id int)" },
      ]);

      expect(result.applied).toEqual(["0001", "0002"]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
      // Tracking table creation was issued.
      expect(
        pgMock.query.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            (c[0] as string).includes("CREATE TABLE IF NOT EXISTS __foundry_migrations"),
        ),
      ).toBe(true);
      // Both migrations recorded.
      expect(appliedIds.has("0001")).toBe(true);
      expect(appliedIds.has("0002")).toBe(true);
    });

    it("skips already-applied migrations", async () => {
      const appliedIds = new Set<string>(["0001"]);
      applyMigrateMock(appliedIds, new Set());

      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      const result = await migrate(conn, [
        { id: "0001", up: "CREATE TABLE a (id int)" },
        { id: "0002", up: "CREATE TABLE b (id int)" },
      ]);

      expect(result.applied).toEqual(["0002"]);
      expect(result.skipped).toEqual(["0001"]);
      expect(result.errors).toEqual([]);
    });

    it("rolls back and stops on the first error", async () => {
      const appliedIds = new Set<string>();
      applyMigrateMock(
        appliedIds,
        new Set(["CREATE TABLE b (id int)"]), // 0002 fails
      );

      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      const result = await migrate(conn, [
        { id: "0001", up: "CREATE TABLE a (id int)" },
        { id: "0002", up: "CREATE TABLE b (id int)" },
        { id: "0003", up: "CREATE TABLE c (id int)" },
      ]);

      // 0001 applied; 0002 errored + rolled back; 0003 never attempted.
      expect(result.applied).toEqual(["0001"]);
      expect(result.skipped).toEqual([]);
      expect(result.errors.map((e) => e.id)).toEqual(["0002"]);
      expect(result.errors[0]?.error).toMatch(/migration failed/);
      expect(pgMock.query).toHaveBeenCalledWith("ROLLBACK");
      expect(appliedIds.has("0002")).toBe(false);
      expect(appliedIds.has("0003")).toBe(false);
    });

    it("runs each migration in its own transaction", async () => {
      const appliedIds = new Set<string>();
      applyMigrateMock(appliedIds, new Set());

      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      await migrate(conn, [
        { id: "0001", up: "CREATE TABLE a (id int)" },
        { id: "0002", up: "CREATE TABLE b (id int)" },
      ]);

      const calls = pgMock.query.mock.calls.map((c) => c[0]);
      // Two distinct BEGIN/COMMIT pairs (one per applied migration).
      const begins = calls.filter((t) => t === "BEGIN").length;
      const commits = calls.filter((t) => t === "COMMIT").length;
      expect(begins).toBe(2);
      expect(commits).toBe(2);
    });
  });

  describe("Pool stats (live)", () => {
    it("reflects current pool counters on every read (not a snapshot)", async () => {
      const conn = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      expect(conn.pool.size).toBe(0);
      expect(conn.pool.idle).toBe(0);
      expect(conn.pool.inUse).toBe(0);
      expect(conn.pool.waiting).toBe(0);

      // Mutate the underlying pool counters; the Connection must observe them.
      pgMock.pool.totalCount = 10;
      pgMock.pool.idleCount = 7;
      pgMock.pool.waitingCount = 3;

      expect(conn.pool.size).toBe(10);
      expect(conn.pool.idle).toBe(7);
      expect(conn.pool.inUse).toBe(3); // totalCount - idleCount
      expect(conn.pool.waiting).toBe(3);
    });
  });

  describe("Security", () => {
    it("never logs the resolved secret value", async () => {
      process.env.SECRET_PASSWORD = "super-secret-value";
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      try {
        await postgresConnector.connect({
          engine: "postgres",
          credsRef: { from: "env:SECRET_PASSWORD" },
        });

        expect(logs.join(" ").includes("super-secret-value")).toBe(false);
      } finally {
        console.log = originalLog;
      }
    });

    it("never logs the secretId", async () => {
      const secretId = "arn:aws:secretsmanager:us-east-1:123:secret:pg/prod-abc";
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      try {
        await postgresConnector.connect({
          engine: "postgres",
          region: "us-east-1",
          credsRef: { secretId },
        });

        expect(logs.join(" ").includes(secretId)).toBe(false);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe("Connector interface compliance", () => {
    it("exposes engine/connect/health/migrate with the right shapes", () => {
      expect(postgresConnector.engine).toBe("postgres");
      expect(typeof postgresConnector.connect).toBe("function");
      expect(typeof postgresConnector.health).toBe("function");
      expect(typeof postgresConnector.migrate).toBe("function");
    });
  });
});
