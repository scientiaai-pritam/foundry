/**
 * Contract tests for @scientia/connector-dynamodb.
 *
 * Tests the Connector interface implementation using aws-sdk-client-mock.
 * Verifies correct API calls, credential resolution (without logging secrets),
 * health checks, and error handling.
 */

import assert from "node:assert";
import { beforeEach, afterEach } from "vitest";
import { dynamodbConnector } from "../src/connector";
import type { Connection, ConnectionTarget, SecretRef } from "@scientia/core";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

describe("DynamoDB Connector", () => {
  let ddbMock: ReturnType<typeof mockClient>;
  let smMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    ddbMock = mockClient(DynamoDBClient);
    smMock = mockClient(SecretsManagerClient);
    // Default: any { secretId } resolves to a non-credential string, so the
    // ambient AWS credential chain applies and no real Secrets Manager call
    // (which would need live AWS creds) is ever made in tests.
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "mock-secret-value", $metadata: {} });
  });

  afterEach(() => {
    ddbMock.restore();
    smMock.restore();
  });

  describe("connect()", () => {
    it("should create a DynamoDBClient with region", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { from: "env:AWS_ACCESS_KEY_ID" },
      };

      // Mock the environment variable
      process.env.AWS_ACCESS_KEY_ID = "test-key";
      process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

      const connection = await dynamodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "dynamodb");
      assert(connection.client); // DynamoDBClient exists
      assert.strictEqual(connection.pool.size, 0);
      assert.strictEqual(connection.pool.idle, 0);
      assert.strictEqual(connection.pool.inUse, 0);
      assert.strictEqual(connection.pool.waiting, 0);
      assert.strictEqual(typeof connection.close, "function");

      // Clean up
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });

    it("should throw if region is missing", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        credsRef: { from: "env:AWS_ACCESS_KEY_ID" },
      };

      await assert.rejects(
        async () => await dynamodbConnector.connect(target),
        /DynamoDB requires "region" in ConnectionTarget/
      );
    });

    it("should throw if env var in credsRef is not set", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { from: "env:NONEXISTENT_VAR" },
      };

      // Ensure the env var is not set
      delete process.env.NONEXISTENT_VAR;

      await assert.rejects(
        async () => await dynamodbConnector.connect(target),
        /Environment variable "NONEXISTENT_VAR" is not set/
      );
    });

    it("should accept secretId in credsRef", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "secret-arn" },
      };

      // This should not throw — the SDK will use its default credential chain
      const connection = await dynamodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "dynamodb");
    });

    it("should reject invalid credsRef format", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: {} as SecretRef, // Invalid format
      };

      await assert.rejects(
        async () => await dynamodbConnector.connect(target),
        /Invalid credsRef format/
      );
    });

    it("should call close() and destroy client", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);

      // Mock the client's destroy method
      let destroyCalled = false;
      (connection.client as { destroy: () => void }).destroy = () => {
        destroyCalled = true;
      };

      await connection.close();

      assert.strictEqual(destroyCalled, true, "client.destroy() should be called");
    });
  });

  describe("health()", () => {
    it("should return ok: true with latency on successful ListTables", async () => {
      ddbMock.reset();
      ddbMock.on(ListTablesCommand).resolves({
        TableNames: ["test-table"],
        $metadata: {},
      });

      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);
      const healthStatus = await dynamodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, true);
      assert.strictEqual(healthStatus.latencyMs > 0, true);
      assert(healthStatus.detail);
    });

    it("should return ok: false with error detail on failure", async () => {
      ddbMock.reset();
      ddbMock.on(ListTablesCommand).rejects(new Error("Access Denied"));

      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);
      const healthStatus = await dynamodbConnector.health(connection);

      assert.strictEqual(healthStatus.ok, false);
      assert.strictEqual(healthStatus.latencyMs > 0, true);
      assert.strictEqual(healthStatus.detail, "Access Denied");
    });

    it("should measure latency in milliseconds", async () => {
      ddbMock.reset();
      ddbMock.on(ListTablesCommand).resolves({
        TableNames: [],
        $metadata: {},
      });

      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);
      const healthStatus = await dynamodbConnector.health(connection);

      assert.strictEqual(typeof healthStatus.latencyMs, "number");
      assert.strictEqual(healthStatus.latencyMs > 0, true);
    });
  });

  describe("Connector interface compliance", () => {
    it("should have engine: 'dynamodb'", () => {
      assert.strictEqual(dynamodbConnector.engine, "dynamodb");
    });

    it("should have connect() method", () => {
      assert.strictEqual(typeof dynamodbConnector.connect, "function");
    });

    it("should have health() method", () => {
      assert.strictEqual(typeof dynamodbConnector.health, "function");
    });

    it("should NOT have migrate() method (DynamoDB is schemaless)", () => {
      assert.strictEqual("migrate" in dynamodbConnector, false);
    });
  });

  describe("Security", () => {
    it("should never log secret values in connect()", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { from: "env:SECRET_PASSWORD" },
      };

      process.env.SECRET_PASSWORD = "super-secret-value";

      // Mock console.log to verify secrets are not logged
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(" "));
      };

      try {
        await dynamodbConnector.connect(target);

        // Verify the secret value is not in any logs
        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("super-secret-value"),
          false,
          "Secret values should never be logged"
        );
      } finally {
        // Restore console.log
        console.log = originalLog;
        delete process.env.SECRET_PASSWORD;
      }
    });

    it("should never log secretId values in connect()", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "arn:aws:secretsmanager:secret:my-secret" },
      };

      // Mock console.log to verify secret ARNs are not logged
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(" "));
      };

      try {
        await dynamodbConnector.connect(target);

        // Verify the secret ARN is not in any logs
        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("arn:aws:secretsmanager:secret:my-secret"),
          false,
          "Secret ARNs should never be logged"
        );
      } finally {
        // Restore console.log
        console.log = originalLog;
      }
    });
  });

  describe("Pool stats", () => {
    it("should return static pool stats (size=0, idle=0, inUse=0, waiting=0)", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);

      assert.strictEqual(connection.pool.size, 0);
      assert.strictEqual(connection.pool.idle, 0);
      assert.strictEqual(connection.pool.inUse, 0);
      assert.strictEqual(connection.pool.waiting, 0);
    });

    it("should have consistent pool stats across connections", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const conn1 = await dynamodbConnector.connect(target);
      const conn2 = await dynamodbConnector.connect(target);

      // All DynamoDB connections have the same static pool stats
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
