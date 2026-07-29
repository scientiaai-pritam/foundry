/**
 * Tests for @scientia/connector-redshift.
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
import type { ConnectionTarget, SecretRef } from "@scientia/core";
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

  describe("migrate()", () => {
    it("applies a new migration inside a transaction", async () => {
      const clientQuery = vi.fn();
      // CREATE TABLE → SELECT(check, not seen) → BEGIN → up → INSERT → COMMIT
      clientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const release = vi.fn();
      mocks.connect.mockResolvedValueOnce({ query: clientQuery, release });

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };
      const conn = await redshiftConnector.connect(target);

      const result = await redshiftConnector.migrate?.(conn, [
        { id: "001", up: "CREATE TABLE foo (id int)" },
      ]);

      assert.deepStrictEqual(result?.applied, ["001"]);
      assert.deepStrictEqual(result?.skipped, []);
      assert.deepStrictEqual(result?.errors, []);
      assert.strictEqual(release.mock.calls.length, 1, "client.release() called");
    });

    it("skips an already-applied migration", async () => {
      const clientQuery = vi.fn();
      clientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }); // seen
      const release = vi.fn();
      mocks.connect.mockResolvedValueOnce({ query: clientQuery, release });

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };
      const conn = await redshiftConnector.connect(target);

      const result = await redshiftConnector.migrate?.(conn, [
        { id: "001", up: "CREATE TABLE foo (id int)" },
      ]);

      assert.deepStrictEqual(result?.applied, []);
      assert.deepStrictEqual(result?.skipped, ["001"]);
      assert.deepStrictEqual(result?.errors, []);
    });

    it("records an error and rolls back on failure", async () => {
      const clientQuery = vi.fn();
      clientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT (not seen)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error("syntax error")) // up fails
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      const release = vi.fn();
      mocks.connect.mockResolvedValueOnce({ query: clientQuery, release });

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };
      const conn = await redshiftConnector.connect(target);

      const result = await redshiftConnector.migrate?.(conn, [
        { id: "001", up: "CREATE BAD SQL" },
      ]);

      assert.deepStrictEqual(result?.applied, []);
      assert.deepStrictEqual(result?.skipped, []);
      assert.strictEqual(result?.errors.length, 1);
      assert.strictEqual(result?.errors[0]?.id, "001");
      assert.strictEqual(result?.errors[0]?.error, "syntax error");
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
