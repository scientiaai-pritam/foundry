/**
 * Contract tests for @foundry/connector-dynamodb using aws-sdk-client-mock.
 *
 * Tests the Connector interface implementation with proper AWS SDK mocking.
 * Verifies correct API calls, credential resolution (without logging secrets),
 * health checks, and error handling.
 */

import assert from "node:assert";
import { beforeEach, afterEach } from "vitest";
import { dynamodbConnector } from "../src/connector";
import type { Connection, ConnectionTarget, SecretRef } from "@foundry/core";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

describe("DynamoDB Connector (Contract Tests with aws-sdk-client-mock)", () => {
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
    it("should create a connection with DynamoDBClient", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test-secret" },
      };

      const connection = await dynamodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "dynamodb");
      assert(connection.client); // DynamoDBClient exists
      assert.strictEqual(connection.pool.size, 0);
      assert.strictEqual(connection.pool.idle, 0);
      assert.strictEqual(connection.pool.inUse, 0);
      assert.strictEqual(connection.pool.waiting, 0);
      assert.strictEqual(typeof connection.close, "function");
    });

    it("should create a connection with env var credsRef", async () => {
      // Set up environment variables
      process.env.AWS_ACCESS_KEY_ID = "test-key";
      process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-west-2",
        credsRef: { from: "env:AWS_ACCESS_KEY_ID" },
      };

      const connection = await dynamodbConnector.connect(target);

      assert(connection);
      assert.strictEqual(connection.engine, "dynamodb");
      assert(connection.client);

      // Clean up
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });

    it("should throw if region is missing", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        credsRef: { secretId: "test" },
      };

      await assert.rejects(
        async () => await dynamodbConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes('DynamoDB requires "region"'));
          return true;
        }
      );
    });

    it("should throw if env var in credsRef is not set", async () => {
      // Ensure the env var is not set
      delete process.env.NONEXISTENT_VAR;

      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { from: "env:NONEXISTENT_VAR" },
      };

      await assert.rejects(
        async () => await dynamodbConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes("Environment variable \"NONEXISTENT_VAR\" is not set"));
          return true;
        }
      );
    });

    it("should reject invalid credsRef format", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: {} as SecretRef,
      };

      await assert.rejects(
        async () => await dynamodbConnector.connect(target),
        (error: Error) => {
          assert(error.message.includes("Invalid credsRef format"));
          return true;
        }
      );
    });

    it("should call destroy() on close", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);

      // Mock destroy to verify it's called
      let destroyCalled = false;
      (connection.client as { destroy: () => void }).destroy = () => {
        destroyCalled = true;
      };

      await connection.close();

      assert.strictEqual(destroyCalled, true, "client.destroy() should be called");
    });
  });

  describe("health()", () => {
    it("should return ok: true with latency on successful health check", async () => {
      // Reset mock
      ddbMock.reset();

      // Mock successful ListTables response
      ddbMock.on(ListTablesCommand).resolves({
        TableNames: ["test-table"],
        $metadata: { httpStatusCode: 200 },
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
      assert.strictEqual(healthStatus.detail.includes("1 table(s) exist"), true);
    });

    it("should return ok: true with 'No tables yet' message", async () => {
      // Reset mock
      ddbMock.reset();

      // Mock ListTables response with no tables
      ddbMock.on(ListTablesCommand).resolves({
        TableNames: [],
        $metadata: { httpStatusCode: 200 },
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
      assert.strictEqual(healthStatus.detail, "No tables yet");
    });

    it("should return ok: false on error", async () => {
      // Reset mock
      ddbMock.reset();

      // Mock error response
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
      // Reset mock
      ddbMock.reset();

      // Mock response
      ddbMock.on(ListTablesCommand).resolves({
        TableNames: [],
        $metadata: { httpStatusCode: 200 },
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
    it("should implement Connector interface correctly", () => {
      assert.strictEqual(dynamodbConnector.engine, "dynamodb");
      assert.strictEqual(typeof dynamodbConnector.connect, "function");
      assert.strictEqual(typeof dynamodbConnector.health, "function");
      assert.strictEqual("migrate" in dynamodbConnector, false);
    });
  });

  describe("Security", () => {
    it("should never log secret values", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { from: "env:SECRET_PASSWORD" },
      };

      process.env.SECRET_PASSWORD = "super-secret-value";

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(" "));
      };

      try {
        await dynamodbConnector.connect(target);

        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("super-secret-value"),
          false,
          "Secret values should never be logged"
        );
      } finally {
        console.log = originalLog;
        delete process.env.SECRET_PASSWORD;
      }
    });

    it("should never log secretId ARNs", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "arn:aws:secretsmanager:secret:my-secret" },
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(" "));
      };

      try {
        await dynamodbConnector.connect(target);

        const logOutput = logs.join(" ");
        assert.strictEqual(
          logOutput.includes("arn:aws:secretsmanager:secret:my-secret"),
          false,
          "Secret ARNs should never be logged"
        );
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe("Pool stats", () => {
    it("should return static pool stats (no connection pooling for DynamoDB)", async () => {
      const target: ConnectionTarget = {
        engine: "dynamodb",
        region: "us-east-1",
        credsRef: { secretId: "test" },
      };

      const connection = await dynamodbConnector.connect(target);

      assert.deepStrictEqual(connection.pool, {
        size: 0,
        idle: 0,
        inUse: 0,
        waiting: 0,
      });
    });
  });
});
