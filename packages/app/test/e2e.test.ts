/**
 * Golden-path END-TO-END vertical slice (design v1, §8 "End-to-end vertical
 * slice — one golden path: defineStack → plan → apply → assert available →
 * db.connect() → query → destroy → assert gone").
 *
 * This is the one test that crosses all three package boundaries of the
 * DynamoDB slice:
 *   - @scientia/core            — defineStack, runPlan, runApply, runDestroy,
 *                                 ConnectionRegistry, ConnectionManager, state.
 *   - @scientia/aws-dynamodb    — DynamoDBProvisioner (create / read / destroy,
 *                                 incl. canonical waitFor + idempotency).
 *   - @scientia/connector-dynamodb — connect() → native DynamoDBClient, health().
 *
 * No LocalStack and no real cloud: the AWS layer is mocked at the provisioner
 * boundary with `aws-sdk-client-mock`. `mockClient(DynamoDBClient)` patches the
 * DynamoDBClient prototype, so it intercepts BOTH the provisioner's injected
 * client AND the connector's freshly-constructed client — one mock serves the
 * whole slice. The composition root (@scientia/app) builds a REAL client from
 * region (no test injection), proving the wiring is genuine; the mock just
 * intercepts its traffic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  UpdateContinuousBackupsCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  DescribeContinuousBackupsCommandOutput,
  DescribeTableCommandOutput,
} from "@aws-sdk/client-dynamodb";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineStack,
  runPlan,
  runApply,
  runDestroy,
  ConnectionRegistry,
  ConnectionManager,
  type ResourceSpec,
} from "@scientia/core";
import { createAppContext } from "../src/context.js";

/* ------------------------------ fixtures ------------------------------ */

const REGION = "us-east-1";

/** Single shared mock; patches DynamoDBClient.prototype globally. */
const ddb = mockClient(DynamoDBClient);

/** A DescribeTable output with the given TableStatus. */
function desc(
  status: "CREATING" | "ACTIVE" | "DELETING" = "ACTIVE",
): DescribeTableCommandOutput {
  return {
    // $metadata is required on every CommandOutput (MetadataBearer); all its
    // fields are optional, so an empty object satisfies it for the mock.
    $metadata: {},
    Table: {
      TableName: "sessions",
      TableStatus: status,
      TableArn: `arn:aws:dynamodb:${REGION}:123456789012:table/sessions`,
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
      CreationDateTime: new Date(0),
      ItemCount: 0,
      TableSizeBytes: 0,
    },
  };
}

const notFound = Object.assign(new Error("Requested resource not found"), {
  name: "ResourceNotFoundException",
});

/** A well-formed DescribeContinuousBackups response (PITR enabled). */
const pitrEnabled: Partial<DescribeContinuousBackupsCommandOutput> = {
  ContinuousBackupsDescription: {
    // ContinuousBackupsStatus is required on ContinuousBackupsDescription.
    ContinuousBackupsStatus: "ENABLED",
    PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" },
  },
};

/** The desired stack (config-as-code, §5). */
const stack = defineStack({
  databases: {
    sessions: {
      engine: "dynamodb",
      provision: {
        kind: "aws.dynamodb",
        tableName: "sessions",
        attributeDefinitions: [{ name: "pk", type: "S" }],
        keySchema: [{ name: "pk", type: "HASH" }],
        billingMode: "pay_per_request",
      },
    },
  },
});

/** A ResourceSpec for the same table, for direct provisioner.read() calls. */
const sessionsSpec: ResourceSpec = {
  id: "sessions",
  kind: "aws.dynamodb",
  props: {
    tableName: "sessions",
    attributeDefinitions: [{ name: "pk", type: "S" }],
    keySchema: [{ name: "pk", type: "HASH" }],
    billingMode: "pay_per_request",
  },
};

/** A silent logger so the slice doesn't noise up test output. */
const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
};

let tmpDir = "";

beforeEach(() => {
  ddb.reset();
  tmpDir = mkdtempSync(join(tmpdir(), "scientia-e2e-"));

  // --- steady-state responses (used in any order, any number of times) ---
  ddb.on(CreateTableCommand).resolves({});
  ddb.on(UpdateContinuousBackupsCommand).resolves({});
  ddb.on(DescribeContinuousBackupsCommand).resolves(pitrEnabled);
  ddb.on(DeleteTableCommand).resolves({});
  ddb.on(ListTablesCommand).resolves({ TableNames: ["sessions"] });
  ddb.on(PutItemCommand).resolves({});
  ddb.on(GetItemCommand).resolves({ Item: { pk: { S: "user-1" } } });

  // --- DescribeTable is called across phases in a known order ---
  //   apply:  poll CREATING -> ACTIVE  (calls 1-2)
  //           read() after create      (call 3)
  //   destroy: poll DELETING -> gone   (calls 4-5)
  //   assert-gone: read()              (call 6+, persistent)
  ddb
    .on(DescribeTableCommand)
    .resolvesOnce(desc("CREATING")) // 1: pollUntilActive
    .resolvesOnce(desc("ACTIVE")) // 2: pollUntilActive -> ready
    .resolvesOnce(desc("ACTIVE")) // 3: apply's final read()
    .resolvesOnce(desc("DELETING")) // 4: pollUntilDeleted
    .rejectsOnce(notFound) // 5: pollUntilDeleted -> gone
    .rejects(notFound); // 6+: stays gone (assert-gone read)
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/* =============================== the slice =============================== */

describe("golden path: DynamoDB vertical slice (defineStack → plan → apply → connect → query → destroy → gone)", () => {
  it("runs the full lifecycle across core + provisioner + connector", async () => {
    // --- composition root: wires DynamoDBProvisioner + dynamodb connector ---
    // No client injected — the composition root builds a REAL DynamoDBClient
    // from region; the shared mock intercepts its traffic at the boundary.
    const ctx = await createAppContext({
      stack,
      region: REGION,
      statePath: join(tmpDir, "scientia.state.json"),
      waitFor: { initialIntervalMs: 1, timeoutMs: 2000 },
      logger: silentLogger,
    });

    // Sanity: the composition root actually registered both plugins.
    expect(ctx.provisioners.get("aws.dynamodb")).toBeDefined();
    expect(ctx.connectors.get("dynamodb")).toBeDefined();

    // 1. plan -------------------------------------------------------------
    const plan = await runPlan(ctx);
    const createAction = plan.actions.find((a) => a.op === "create");
    expect(createAction).toBeTruthy();
    if (createAction && createAction.op === "create") {
      expect(createAction.spec.id).toBe("sessions");
      expect(createAction.spec.kind).toBe("aws.dynamodb");
    }

    // 2. apply ------------------------------------------------------------
    const applied = await runApply(ctx, plan);
    expect(applied.failed).toBe(0);
    expect(applied.succeeded).toBe(1);

    // The create went to the provisioner with the expected table shape.
    // (aws-sdk-client-mock v4: commandCalls()[n].args is the [command] tuple
    // passed to client.send(); the input lives at args[0].input.)
    const createCalls = ddb.commandCalls(CreateTableCommand);
    expect(createCalls).toHaveLength(1);
    const createInput = createCalls[0]?.args[0]?.input as unknown as Record<string, unknown>;
    expect(createInput["TableName"]).toBe("sessions");
    expect(createInput["BillingMode"]).toBe("PAY_PER_REQUEST");

    // Canonical idempotency from core: the orchestrator attaches a deterministic
    // token (derived from resource id + op) to the create step result — a retry
    // of the same logical action is de-duplicated at the framework layer.
    const createResult = applied.results.find((r) => r.id === "sessions");
    expect(createResult).toBeDefined();
    expect(typeof createResult?.idempotencyToken).toBe("string");

    // 3. assert resource available (state is the source of truth) ---------
    const resource = await ctx.state.get("sessions");
    expect(resource).not.toBeNull();
    expect(resource?.status).toBe("available");
    expect(resource?.kind).toBe("aws.dynamodb");
    expect(resource?.identifiers.tableName).toBe("sessions");
    expect(resource?.connection.engine).toBe("dynamodb");
    expect(resource?.connection.region).toBe(REGION);
    // DynamoDB has no DB-level creds → credsRef omitted (ambient AWS chain).
    expect(resource?.connection.credsRef).toBeUndefined();

    // 4. db.connect() → ConnectionManager → dynamodb connector -----------
    const registry = new ConnectionRegistry(ctx.connectors, {
      state: ctx.state,
      stack: ctx.stack,
    });
    const manager = new ConnectionManager(registry);
    const conn = await manager.connect("sessions");
    expect(conn.engine).toBe("dynamodb");
    // The native client is the real driver type — we never wrap its API.
    const client = conn.client as DynamoDBClient;
    expect(client).toBeInstanceOf(DynamoDBClient);

    // 4a. observability: health check via the connector
    const health = await manager.health("sessions");
    expect(health.ok).toBe(true);
    expect(ddb.commandCalls(ListTablesCommand)).toHaveLength(1);

    // 4b. USE THE NATIVE CLIENT (PutItem / GetItem through the connector)
    await client.send(
      new PutItemCommand({
        TableName: "sessions",
        Item: { pk: { S: "user-1" }, data: { S: "hello" } },
      }),
    );
    const got = await client.send(
      new GetItemCommand({ TableName: "sessions", Key: { pk: { S: "user-1" } } }),
    );
    expect(got.Item).toBeDefined();
    expect(got.Item?.pk?.S).toBe("user-1");
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(ddb.commandCalls(GetItemCommand)).toHaveLength(1);

    // Drain the pool (graceful shutdown).
    await manager.closeAll();

    // 5. destroy ----------------------------------------------------------
    const destroyed = await runDestroy(ctx, { force: true });
    expect(destroyed.failed).toBe(0);
    expect(destroyed.succeeded).toBe(1);
    expect(ddb.commandCalls(DeleteTableCommand)).toHaveLength(1);

    // 6. assert gone ------------------------------------------------------
    // (a) state no longer tracks it.
    expect(await ctx.state.get("sessions")).toBeNull();
    // (b) live read via the provisioner confirms the cloud resource is gone.
    const provisioner = ctx.provisioners.get("aws.dynamodb");
    expect(provisioner).toBeDefined();
    const liveAfterDestroy = await provisioner!.read(sessionsSpec);
    expect(liveAfterDestroy).toBeNull();
  }, 15_000);
});
