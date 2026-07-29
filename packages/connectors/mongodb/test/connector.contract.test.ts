/**
 * Contract tests for @scientia/connector-mongodb.
 *
 * Verifies the connector satisfies the Connector interface from @scientia/core:
 * correct engine id, connect/health signatures, migrate intentionally omitted,
 * the BY-REFERENCE secret contract (credsRef → connection URI, never logged),
 * and the static pool-stats contract. The `mongodb` driver is mocked via
 * vi.mock; the AWS Secrets Manager path via aws-sdk-client-mock.
 */

import assert from "node:assert";
import { beforeEach, afterEach, vi } from "vitest";
import { mongodbConnector } from "../src/connector";
import type { ConnectionTarget, SecretRef } from "@scientia/core";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

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

describe("MongoDB Connector (Contract Tests)", () => {
  let smMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    smMock = mockClient(SecretsManagerClient);
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: "mongodb://localhost:27017",
      $metadata: {},
    });

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
    it("should create a connection with a MongoClient", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test-secret" },
      };

      const connection = await mongodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "mongodb");
      assert(connection.client); // MongoClient exists
      assert.strictEqual(connection.pool.size, 0);
      assert.strictEqual(connection.pool.idle, 0);
      assert.strictEqual(connection.pool.inUse, 0);
      assert.strictEqual(connection.pool.waiting, 0);
      assert.strictEqual(typeof connection.close, "function");
    });

    it("should create a connection with env-var credsRef", async () => {
      process.env.MONGO_URI = "mongodb://localhost:27017";

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { from: "env:MONGO_URI" },
      };

      const connection = await mongodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "mongodb");
      assert(connection.client);

      delete process.env.MONGO_URI;
    });

    it("should throw if credsRef is missing", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
      };

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes('MongoDB requires "credsRef"'));
          return true;
        }
      );
    });

    it("should throw if env var in credsRef is not set", async () => {
      delete process.env.NONEXISTENT_VAR;

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { from: "env:NONEXISTENT_VAR" },
      };

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes("Environment variable \"NONEXISTENT_VAR\" is not set"));
          return true;
        }
      );
    });

    it("should reject invalid credsRef format", async () => {
      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: {} as SecretRef,
      };

      await assert.rejects(
        async () => await mongodbConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes("Invalid credsRef format"));
          return true;
        }
      );
    });

    it("should call close() on the client", async () => {
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
    it("should return ok: true with latency on a healthy ping", async () => {
      mongoMocks.command.mockResolvedValueOnce({ ok: 1 });

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);
      const healthStatus = await mongodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, true);
      assert.strictEqual(typeof healthStatus.latencyMs, "number");
      assert(healthStatus.detail);
      assert.strictEqual(healthStatus.detail.includes("ping ok"), true);
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
      assert.strictEqual(typeof healthStatus.latencyMs, "number");
    });

    it("should return ok: false on error", async () => {
      mongoMocks.command.mockRejectedValueOnce(new Error("connection refused"));

      const target: ConnectionTarget = {
        engine: "mongodb",
        credsRef: { secretId: "test" },
      };

      const connection = await mongodbConnector.connect(target);
      const healthStatus = await mongodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, false);
      assert.strictEqual(typeof healthStatus.latencyMs, "number");
      assert.strictEqual(healthStatus.detail, "connection refused");
    });
  });

  describe("Connector interface compliance", () => {
    it("should implement the Connector interface correctly", () => {
      assert.strictEqual(mongodbConnector.engine, "mongodb");
      assert.strictEqual(typeof mongodbConnector.connect, "function");
      assert.strictEqual(typeof mongodbConnector.health, "function");
      assert.strictEqual("migrate" in mongodbConnector, false);
    });
  });

  describe("Security", () => {
    it("should never log secret values", async () => {
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

    it("should never log secretId ARNs", async () => {
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
    it("should return static pool stats (no stable per-client pool counters)", async () => {
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
  });
});
