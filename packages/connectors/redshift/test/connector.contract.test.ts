/**
 * Contract tests for @foundry/connector-redshift.
 *
 * Verifies the Connector interface implementation against its public contract:
 * connect() builds a pg.Pool with Redshift defaults, health() issues SELECT 1,
 * pool stats are read live from the pool, migrate() applies idempotently, and
 * secrets are never logged. The `pg` driver is mocked via vi.mock and Secrets
 * Manager (for { secretId } credsRef) is mocked via aws-sdk-client-mock.
 */

import assert from "node:assert";
import { vi, beforeEach, afterEach } from "vitest";
import { redshiftConnector } from "../src/connector";
import type { ConnectionTarget, SecretRef } from "@foundry/core";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

// Hoisted mock state (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  ctor: vi.fn(),
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

const CREDS_JSON = JSON.stringify({
  host: "redshift-cluster.example",
  port: 5439,
  user: "admin",
  password: "super-secret",
  database: "dev",
});

describe("Redshift Connector (Contract Tests)", () => {
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
      SecretString: CREDS_JSON,
      $metadata: {},
    });

    process.env.REDSHIFT_CREDS = CREDS_JSON;
  });

  afterEach(() => {
    smMock.restore();
    delete process.env.REDSHIFT_CREDS;
  });

  describe("connect()", () => {
    it("returns a Connection wrapping a pg.Pool", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };

      const connection = await redshiftConnector.connect(target);

      assert.strictEqual(connection.engine, "redshift");
      assert(connection.client, "pg.Pool client exists");
      assert.strictEqual(typeof connection.close, "function");
    });

    it("requires credsRef (the database's own secret)", async () => {
      const target: ConnectionTarget = { engine: "redshift", region: "us-east-1" };

      await assert.rejects(
        () => redshiftConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes("Redshift requires credsRef"));
          return true;
        },
      );
    });

    it("applies Redshift SSL + port defaults", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { from: "env:REDSHIFT_CREDS" },
      };

      await redshiftConnector.connect(target);

      const config = mocks.ctor.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      assert(config, "pool config was passed");
      assert.deepStrictEqual(config!.ssl, { rejectUnauthorized: false });
    });

    it("resolves a { secretId } credsRef via Secrets Manager", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };

      await redshiftConnector.connect(target);

      assert.strictEqual(smMock.commandCalls(GetSecretValueCommand).length, 1);
    });

    it("rejects an invalid credsRef format", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: {} as SecretRef,
      };

      await assert.rejects(
        () => redshiftConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes("Invalid credsRef format"));
          return true;
        },
      );
    });

    it("ends the pool on close()", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };

      const connection = await redshiftConnector.connect(target);
      await connection.close();

      assert.strictEqual(mocks.end.mock.calls.length, 1, "pool.end() called");
    });
  });

  describe("health()", () => {
    it("returns ok:true with latency on SELECT 1", async () => {
      mocks.query.mockReset();
      mocks.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };
      const connection = await redshiftConnector.connect(target);
      const status = await redshiftConnector.health(connection);

      assert.strictEqual(status.ok, true);
      assert.strictEqual(typeof status.latencyMs, "number");
      assert(status.detail);
      assert.strictEqual(mocks.query.mock.calls[0]?.[0], "SELECT 1");
    });

    it("returns ok:false with the error detail on failure", async () => {
      mocks.query.mockReset();
      mocks.query.mockRejectedValueOnce(new Error("server closed the connection"));

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };
      const connection = await redshiftConnector.connect(target);
      const status = await redshiftConnector.health(connection);

      assert.strictEqual(status.ok, false);
      assert.strictEqual(typeof status.latencyMs, "number");
      assert.strictEqual(status.detail, "server closed the connection");
    });
  });

  describe("migrate()", () => {
    it("applies a migration and records it as applied", async () => {
      const clientQuery = vi.fn();
      clientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT (not seen)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // up
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
      mocks.connect.mockResolvedValueOnce({ query: clientQuery, release: vi.fn() });

      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };
      const conn = await redshiftConnector.connect(target);

      const result = await redshiftConnector.migrate?.(conn, [
        { id: "001", up: "CREATE TABLE foo (id int)" },
      ]);

      assert.deepStrictEqual(result?.applied, ["001"]);
      assert.deepStrictEqual(result?.skipped, []);
      assert.deepStrictEqual(result?.errors, []);
    });
  });

  describe("Connector interface compliance", () => {
    it("implements the Connector contract (engine + connect + health + migrate)", () => {
      assert.strictEqual(redshiftConnector.engine, "redshift");
      assert.strictEqual(typeof redshiftConnector.connect, "function");
      assert.strictEqual(typeof redshiftConnector.health, "function");
      assert.strictEqual(typeof redshiftConnector.migrate, "function");
    });
  });

  describe("Pool stats", () => {
    it("returns live pool stats read from pg.Pool", async () => {
      mocks.stats = { totalCount: 4, idleCount: 1, waitingCount: 2 };
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "redshift/master" },
      };

      const connection = await redshiftConnector.connect(target);

      assert.deepStrictEqual(connection.pool, {
        size: 4,
        idle: 1,
        inUse: 3,
        waiting: 2,
      });
    });
  });

  describe("Security", () => {
    it("never logs secret values", async () => {
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
        assert.strictEqual(
          logs.join(" ").includes("super-secret"),
          false,
          "secret values must never be logged",
        );
      } finally {
        console.log = originalLog;
      }
    });

    it("never logs secretId ARNs", async () => {
      const target: ConnectionTarget = {
        engine: "redshift",
        region: "us-east-1",
        credsRef: { secretId: "arn:aws:secretsmanager:us-east-1:123:secret:redshift/master-XYZ" },
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };

      try {
        await redshiftConnector.connect(target);
        assert.strictEqual(
          logs.join(" ").includes("arn:aws:secretsmanager"),
          false,
          "secret ARNs must never be logged",
        );
      } finally {
        console.log = originalLog;
      }
    });
  });
});
