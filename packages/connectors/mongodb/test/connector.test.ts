/**
 * Tests for @foundry/connector-mongodb.
 *
 * The native `mongodb` driver is mocked via `vi.mock` + `vi.hoisted` (there is
 * no mongodb equivalent of aws-sdk-client-mock). The AWS Secrets Manager path
 * is mocked with aws-sdk-client-mock, mirroring the DynamoDB connector tests.
 * Verifies connect/health lifecycle, credential resolution without logging
 * secrets, static pool stats, and error handling.
 */

import assert from "node:assert";
import { beforeEach, afterEach, vi } from "vitest";
import { mongodbConnector } from "../src/connector";
import type { ConnectionTarget, SecretRef } from "@foundry/core";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

// vi.hoisted runs before the hoisted vi.mock factory, so these refs are visible
// inside the factory. The connector binds `MongoClient` to this same vi.fn ref,
// so configuration applied at top-level is live by the time any test calls
// connect().
const mongoMocks = vi.hoisted(() => ({
  command: vi.fn(),
  db: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  MongoClient: vi.fn(),
}));

mongoMocks.MongoClient.mockImplementation(() => ({
  connect: mongoMocks.connect,
  db: mongoMocks.db,
  close: mongoMocks.close,
}));
mongoMocks.db.mockReturnValue({ command: mongoMocks.command });
mongoMocks.connect.mockResolvedValue(undefined);
mongoMocks.close.mockResolvedValue(undefined);

vi.mock("mongodb", () => ({
  MongoClient: mongoMocks.MongoClient,
}));

describe("MongoDB Connector", () => {
  let smMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    // Default: any { secretId } resolves to a fake URI so no real AWS call is
    // ever made in tests.
    smMock = mockClient(SecretsManagerClient);
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: "mongodb://localhost:27017",
      $metadata: {},
    });

    // Reset call history (keep implementations) and restore defaults.
    mongoMocks.MongoClient.mockClear();
    mongoMocks.connect.mockClear();
    mongoMocks.close.mockClear();
    mongoMocks.db.mockClear();
    mongoMocks.command.mockClear();
    mongoMocks.connect.mockResolvedValue(undefined);
    mongoMocks.close.mockResolvedValue(undefined);
    mongoMocks.command.mockResolvedValue({ ok: 1 });
  });

  afterEach(() => {
    smMock.restore();
  });

  describe("connect()", () => {
    it("should create a MongoClient from a credsRef URI", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { from: "env:MONGO_URI" },
      };

      process.env.MONGO_URI = "mongodb://user:pass@host:27017/?retryWrites=true";

      const connection = await mongodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "mongodb");
      assert(connection.client); // MongoClient exists
      assert.strictEqual(connection.pool.size, 0);
      assert.strictEqual(connection.pool.idle, 0);
      assert.strictEqual(connection.pool.inUse, 0);
      assert.strictEqual(connection.pool.waiting, 0);
      assert.strictEqual(typeof connection.close, "function");

      // MongoClient was constructed with the resolved URI and connect() awaited.
      assert.strictEqual(mongoMocks.MongoClient.mock.calls.length, 1);
      assert.strictEqual(
        mongoMocks.MongoClient.mock.calls[0]?.[0],
        "mongodb://user:pass@host:27017/?retryWrites=true",
      );
      assert.strictEqual(mongoMocks.connect.mock.calls.length, 1);

      delete process.env.MONGO_URI;
    });

    it("should throw if credsRef is missing (REQUIRED)", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
      };

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        /MongoDB requires "credsRef" in ConnectionTarget/
      );
    });

    it("should throw if env var in credsRef is not set", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { from: "env:NONEXISTENT_VAR" },
      };

      delete process.env.NONEXISTENT_VAR;

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        /Environment variable "NONEXISTENT_VAR" is not set/
      );
    });

    it("should accept secretId in credsRef", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "secret-arn" },
      };

      const connection = await mongodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "mongodb");
      // SM was consulted for the URI (aws-sdk-client-mock exposes calls as a method)
      assert.strictEqual(smMock.calls().length, 1);
    });

    it("should reject invalid credsRef format", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: {} as SecretRef, // Invalid format
      };

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        /Invalid credsRef format/
      );
    });

    it("should throw if MongoClient.connect() fails", async () => {
      mongoMocks.connect.mockRejectedValueOnce(new Error("authentication failed"));

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        /authentication failed/
      );
    });

    it("should call close() and close the client", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);

      await connection.close();

      assert.strictEqual(mongoMocks.close.mock.calls.length, 1);
    });
  });

  describe("health()", () => {
    it("should return ok: true with latency on a successful ping", async () => {
      mongoMocks.command.mockResolvedValueOnce({ ok: 1 });

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);
      const healthStatus = await mongodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, true);
      assert.strictEqual(healthStatus.latencyMs >= 0, true);
      assert(healthStatus.detail);
      assert.strictEqual(mongoMocks.command.mock.calls.length, 1);
      // ping command was issued
      assert.deepStrictEqual(mongoMocks.command.mock.calls[0]?.[0], { ping: 1 });
    });

    it("should return ok: false when ping returns ok !== 1", async () => {
      mongoMocks.command.mockResolvedValueOnce({ ok: 0 });

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);
      const healthStatus = await mongodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, false);
      assert.strictEqual(healthStatus.latencyMs >= 0, true);
      assert(healthStatus.detail);
    });

    it("should return ok: false with error detail on failure", async () => {
      mongoMocks.command.mockRejectedValueOnce(new Error("not authorized"));

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);
      const healthStatus = await mongodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, false);
      assert.strictEqual(healthStatus.latencyMs >= 0, true);
      assert.strictEqual(healthStatus.detail, "not authorized");
    });

    it("should measure latency in milliseconds", async () => {
      mongoMocks.command.mockResolvedValueOnce({ ok: 1 });

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);
      const healthStatus = await mongodbConnector.health(connection);

      assert.strictEqual(typeof healthStatus.latencyMs, "number");
    });
  });

  describe("Connector interface compliance", () => {
    it("should have engine: 'mongodb'", () => {
      assert.strictEqual(mongodbConnector.engine, "mongodb");
    });

    it("should have connect() method", () => {
      assert.strictEqual(typeof mongodbConnector.connect, "function");
    });

    it("should have health() method", () => {
      assert.strictEqual(typeof mongodbConnector.health, "function");
    });

    it("should NOT have migrate() method (MongoDB is schemaless)", () => {
      assert.strictEqual("migrate" in mongodbConnector, false);
    });
  });

  describe("Security", () => {
    it("should never log secret values in connect()", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { from: "env:MONGO_URI" },
      };

      process.env.MONGO_URI = "mongodb://user:super-secret-value@host:27017/";

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(" "));
      };

      try {
        await mongodbConnector.connect(target);

        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("super-secret-value"),
          false,
          "Secret values should never be logged"
        );
      } finally {
        console.log = originalLog;
        delete process.env.MONGO_URI;
      }
    });

    it("should never log secretId values in connect()", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "arn:aws:secretsmanager:secret:my-mongo-secret" },
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(" "));
      };

      try {
        await mongodbConnector.connect(target);

        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("arn:aws:secretsmanager:secret:my-mongo-secret"),
          false,
          "Secret ARNs should never be logged"
        );
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe("Pool stats", () => {
    it("should return static pool stats (size=0, idle=0, inUse=0, waiting=0)", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);

      assert.deepStrictEqual(connection.pool, {
        size: 0,
        idle: 0,
        inUse: 0,
        waiting: 0,
      });
    });

    it("should have consistent pool stats across connections", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const conn1 = await mongodbConnector.connect(target);
      const conn2 = await mongodbConnector.connect(target);

      // All MongoDB connections report the same static pool stats
      assert.deepStrictEqual(conn1.pool, conn2.pool);
      assert.deepStrictEqual(conn1.pool, {
        size: 0,
        idle: 0,
        inUse: 0,
        waiting: 0,
      });
    });
  });
});
