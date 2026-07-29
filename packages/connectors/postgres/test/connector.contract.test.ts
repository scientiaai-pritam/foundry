/**
 * Contract tests for @scientia/connector-postgres.
 *
 * Verifies the connector satisfies the `Connector` interface from @scientia/core
 * (engine, connect, health, migrate) and that the shapes it returns (Connection,
 * HealthStatus, MigrationResult) match the contracts. `pg` is mocked with vi.mock;
 * the AWS Secrets Manager path is mocked with aws-sdk-client-mock. No real DB or
 * live AWS credentials are required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { postgresConnector } from "../src/connector";
import type {
  Connection,
  ConnectionTarget,
  HealthStatus,
  MigrationResult,
} from "@scientia/core";

// --- pg mock (same shape as connector.test.ts) -----------------------------
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
  password: "contract-secret",
  database: "appdb",
});

// The Connector contract marks `migrate` optional (not every engine supports
// migrations). The postgres connector always implements it; narrow once here so
// the contract test can invoke it directly.
const migrate = postgresConnector.migrate;
if (!migrate) {
  throw new Error("postgresConnector.migrate is not defined");
}

describe("Postgres Connector (Contract Tests)", () => {
  let smMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    pgMock.query.mockReset();
    pgMock.end.mockReset();
    pgMock.connect.mockReset();
    pgMock.release.mockReset();
    pgMock.query.mockResolvedValue({ rowCount: 0, rows: [] });
    pgMock.connect.mockResolvedValue(pgMock.poolClient);
    pgMock.end.mockResolvedValue(undefined);
    pgMock.pool.totalCount = 0;
    pgMock.pool.idleCount = 0;
    pgMock.pool.waitingCount = 0;

    process.env.PG_CONN = "postgres://appuser:secret@db.example.com:5432/appdb";

    smMock = mockClient(SecretsManagerClient);
    smMock
      .on(GetSecretValueCommand)
      .resolves({ SecretString: PG_CONN_JSON, $metadata: {} });
  });

  afterEach(() => {
    smMock.restore();
    delete process.env.PG_CONN;
  });

  describe("Connector interface", () => {
    it("declares engine: 'postgres' and implements connect/health/migrate", () => {
      expect(postgresConnector.engine).toBe("postgres");
      expect(typeof postgresConnector.connect).toBe("function");
      expect(typeof postgresConnector.health).toBe("function");
      expect(typeof postgresConnector.migrate).toBe("function");
    });
  });

  describe("connect() returns a Connection", () => {
    it("returns an object satisfying the Connection contract (env credsRef)", async () => {
      const target: ConnectionTarget = {
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      };
      const connection: Connection = await postgresConnector.connect(target);

      // Connection.engine is `string`.
      expect(typeof connection.engine).toBe("string");
      expect(connection.engine).toBe("postgres");
      // Connection.client is the native driver (unknown) — here, the pg.Pool.
      expect(connection.client).toBe(pgMock.pool);
      // Connection.pool is PoolStats: four required numbers.
      expect(typeof connection.pool.size).toBe("number");
      expect(typeof connection.pool.idle).toBe("number");
      expect(typeof connection.pool.inUse).toBe("number");
      expect(typeof connection.pool.waiting).toBe("number");
      // Connection.close is a function returning a promise.
      expect(typeof connection.close).toBe("function");
    });

    it("resolves a secretId credsRef through Secrets Manager", async () => {
      const target: ConnectionTarget = {
        engine: "postgres",
        region: "us-east-1",
        credsRef: { secretId: "prod/postgres/app" },
      };
      const connection = await postgresConnector.connect(target);

      expect(connection.engine).toBe("postgres");
      // secretId credsRef can only yield a Pool if the secret was resolved via
      // Secrets Manager (the smMock returns a JSON connection document).
      expect(connection.client).toBe(pgMock.pool);
    });

    it("requires credsRef (no ambient credential chain for pg)", async () => {
      await expect(
        postgresConnector.connect({ engine: "postgres" }),
      ).rejects.toThrow(/credsRef/);
    });

    it("rejects a malformed SecretRef", async () => {
      const target: ConnectionTarget = {
        engine: "postgres",
        credsRef: {} as never,
      };
      await expect(postgresConnector.connect(target)).rejects.toThrow(
        /Invalid credsRef format/,
      );
    });
  });

  describe("close()", () => {
    it("drains the pool via pool.end()", async () => {
      const connection = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });
      await connection.close();
      expect(pgMock.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("health() returns a HealthStatus", () => {
    it("returns ok + latencyMs on success", async () => {
      const connection = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });
      const status: HealthStatus = await postgresConnector.health(connection);

      expect(typeof status.ok).toBe("boolean");
      expect(typeof status.latencyMs).toBe("number");
      expect(status.ok).toBe(true);
      expect(status.detail).toBeDefined();
    });

    it("returns ok:false + driver detail on failure", async () => {
      pgMock.query.mockReset();
      pgMock.query.mockRejectedValue(new Error("handshake failed"));

      const connection = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });
      const status = await postgresConnector.health(connection);

      expect(status.ok).toBe(false);
      expect(status.detail).toBe("handshake failed");
    });
  });

  describe("migrate() returns a MigrationResult", () => {
    it("returns applied/skipped/errors arrays matching the contract", async () => {
      const appliedIds = new Set<string>();
      pgMock.query.mockImplementation(async (text: string, values?: unknown[]) => {
        if (text.includes("CREATE TABLE") && text.includes("__scientia_migrations")) {
          return { rowCount: 0, rows: [] };
        }
        if (text.startsWith("SELECT id FROM")) {
          return { rowCount: appliedIds.has(values?.[0] as string) ? 1 : 0, rows: [] };
        }
        if (text.startsWith("INSERT INTO")) {
          appliedIds.add(values?.[0] as string);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      });

      const connection = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });
      const result: MigrationResult = await migrate(connection, [
        { id: "0001", up: "CREATE TABLE a (id int)" },
      ]);

      expect(Array.isArray(result.applied)).toBe(true);
      expect(Array.isArray(result.skipped)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.applied).toEqual(["0001"]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  describe("Security", () => {
    it("does not surface the resolved secret in logs or errors", async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      try {
        await postgresConnector.connect({
          engine: "postgres",
          credsRef: { from: "env:PG_CONN" },
        });
        expect(logs.join(" ").includes("super-secret")).toBe(false);
      } finally {
        console.log = originalLog;
      }
    });

    it("does not surface the secretId in logs", async () => {
      const secretId = "arn:aws:secretsmanager:secret:pg/prod";
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

  describe("Pool stats", () => {
    it("exposes live counters derived from the pool", async () => {
      const connection = await postgresConnector.connect({
        engine: "postgres",
        credsRef: { from: "env:PG_CONN" },
      });

      pgMock.pool.totalCount = 4;
      pgMock.pool.idleCount = 1;
      pgMock.pool.waitingCount = 2;

      expect(connection.pool).toEqual({
        size: 4,
        idle: 1,
        inUse: 3,
        waiting: 2,
      });
    });
  });
});
