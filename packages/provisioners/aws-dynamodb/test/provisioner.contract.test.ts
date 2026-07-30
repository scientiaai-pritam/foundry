/**
 * Contract tests for the DynamoDB provisioner (design v1, §8 — "Contract tests
 * per plugin ... tested against a stubbed API (aws-sdk-client-mock)").
 *
 * No real AWS calls. These pin the behaviour the orchestrator relies on:
 * correct calls on create/update/replace/destroy, polling-to-ready, idempotency,
 * protect-guard refusal, and read-driven drift mapping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
  type DescribeContinuousBackupsCommandOutput,
  type DescribeTableCommandOutput,
} from "@aws-sdk/client-dynamodb";

import { DynamoDBProvisioner, ProtectedResourceError } from "../src/index.js";
import { idempotencyToken } from "@foundry/core";
import type { ResourceSpec, ResourceState, SecretRef } from "@foundry/core";

/* ------------------------------ fixtures ------------------------------ */

const FAST_WAIT = { initialIntervalMs: 1, timeoutMs: 2000 };
const CREDS: SecretRef = { from: "env:AWS_ACCESS_KEY_ID" };

function spec(
  props: Record<string, unknown>,
  id = "users",
  tags?: Record<string, string>,
): ResourceSpec {
  const s: ResourceSpec = { id, kind: "aws.dynamodb", props };
  if (tags) s.tags = tags;
  return s;
}

const BASE_PROPS = {
  tableName: "users",
  attributeDefinitions: [{ name: "pk", type: "S" }],
  keySchema: [{ name: "pk", type: "HASH" }],
  billingMode: "PAY_PER_REQUEST",
};

function activeTableOutput(
  overrides: Partial<NonNullable<DescribeTableCommandOutput["Table"]>> = {},
): DescribeTableCommandOutput {
  return {
    // $metadata is required on every CommandOutput (MetadataBearer); all its
    // fields are optional, so an empty object satisfies it for the mock.
    $metadata: {},
    Table: {
      TableName: "users",
      TableStatus: "ACTIVE",
      TableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/users",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
      CreationDateTime: new Date(0),
      ItemCount: 0,
      TableSizeBytes: 0,
      ...overrides,
    },
  };
}

/** A well-formed DescribeContinuousBackups response (PITR enabled). */
function pitEnabledOutput(): Partial<DescribeContinuousBackupsCommandOutput> {
  return {
    ContinuousBackupsDescription: {
      // ContinuousBackupsStatus is required on ContinuousBackupsDescription.
      ContinuousBackupsStatus: "ENABLED",
      PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" },
    },
  };
}

function stateFromOutputs(
  outputs: Record<string, unknown>,
  id = "users",
): ResourceState {
  return {
    id,
    kind: "aws.dynamodb",
    identifiers: { tableName: outputs.tableName as string },
    status: "available",
    connection: { engine: "dynamodb", region: "us-east-1", credsRef: CREDS },
    outputs,
  };
}

const ddbMock = mockClient(DynamoDBClient);

function makeProvisioner(allowProtectedDestroy = false): DynamoDBProvisioner {
  return new DynamoDBProvisioner({
    client: new DynamoDBClient({ region: "us-east-1" }),
    region: "us-east-1",
    credsRef: CREDS,
    allowProtectedDestroy,
    waitFor: FAST_WAIT,
  });
}

beforeEach(() => {
  ddbMock.reset();
});

/* =============================== plan =============================== */

describe("plan", () => {
  const prov = makeProvisioner();

  it("creates when there is no current state", () => {
    const action = prov.plan(spec(BASE_PROPS), null);
    expect(action).toEqual({ op: "create", spec: spec(BASE_PROPS) });
  });

  it("noops when desired matches current", () => {
    const current = stateFromOutputs({
      ...BASE_PROPS,
      globalSecondaryIndexes: [],
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });
    const action = prov.plan(spec(BASE_PROPS), current);
    expect(action.op).toBe("noop");
  });

  it("updates billingMode in place", () => {
    const current = stateFromOutputs({
      ...BASE_PROPS,
      globalSecondaryIndexes: [],
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });
    const desired = spec({
      ...BASE_PROPS,
      billingMode: "PROVISIONED",
      provisionedThroughput: { readCapacityUnits: 5, writeCapacityUnits: 5 },
    });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("update");
    if (action.op === "update") {
      expect(action.changedFields).toContain("billingMode");
      expect(action.changedFields).not.toContain("keySchema");
    }
  });

  it("reports an added GSI as an update", () => {
    const current = stateFromOutputs({
      ...BASE_PROPS,
      attributeDefinitions: [{ name: "pk", type: "S" }],
      globalSecondaryIndexes: [],
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });
    const desired = spec({
      ...BASE_PROPS,
      attributeDefinitions: [
        { name: "pk", type: "S" },
        { name: "email", type: "S" },
      ],
      globalSecondaryIndexes: [
        {
          indexName: "byEmail",
          keySchema: [{ name: "email", type: "HASH" }],
          projection: { type: "ALL" },
        },
      ],
    });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("update");
    if (action.op === "update") {
      expect(action.changedFields).toContain("globalSecondaryIndexes");
    }
  });

  it("replaces when keySchema changes (cannot be done in place)", () => {
    const current = stateFromOutputs({
      ...BASE_PROPS,
      keySchema: [{ name: "pk", type: "HASH" }],
      attributeDefinitions: [{ name: "pk", type: "S" }],
      globalSecondaryIndexes: [],
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });
    const desired = spec({
      ...BASE_PROPS,
      keySchema: [
        { name: "pk", type: "HASH" },
        { name: "sk", type: "RANGE" },
      ],
      attributeDefinitions: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
      ],
    });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/keySchema/i);
    }
  });

  it("replaces when tableName changes (cannot be renamed)", () => {
    const current = stateFromOutputs({
      ...BASE_PROPS,
      tableName: "users",
      globalSecondaryIndexes: [],
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });
    const desired = spec({ ...BASE_PROPS, tableName: "users-v2" });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/tableName/i);
    }
  });
});

/* =============================== apply ============================== */

describe("apply (create)", () => {
  it("creates the table, polls to ACTIVE, enables PITR, returns a dynamodb connection state", async () => {
    const prov = makeProvisioner();
    ddbMock.on(CreateTableCommand).resolves({});
    // Polling: CREATING once, then ACTIVE (reused by the final read too).
    ddbMock
      .on(DescribeTableCommand)
      .resolvesOnce({ Table: { ...activeTableOutput().Table, TableStatus: "CREATING" } })
      .resolves(activeTableOutput());
    ddbMock.on(UpdateContinuousBackupsCommand).resolves({});
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

    expect(state.kind).toBe("aws.dynamodb");
    expect(state.status).toBe("available");
    expect(state.identifiers.tableName).toBe("users");
    expect(state.identifiers.tableArn).toContain("arn:aws:dynamodb");
    expect(state.connection).toEqual({
      engine: "dynamodb",
      region: "us-east-1",
      credsRef: CREDS,
    });
    expect(state.outputs?.billingMode).toBe("PAY_PER_REQUEST");
    expect(state.outputs?.pointInTimeRecovery).toBe(true);

    // CreateTable carried the expected shape. (aws-sdk-client-mock v4:
    // commandCalls(...).args is the send() args tuple [Command] — read the
    // constructed command's input via .args[0].input.)
    const creates = ddbMock.commandCalls(CreateTableCommand);
    expect(creates).toHaveLength(1);
    const input = creates[0]?.args[0]?.input;
    expect(input?.TableName).toBe("users");
    expect(input?.KeySchema).toEqual([{ AttributeName: "pk", KeyType: "HASH" }]);
    expect(input?.AttributeDefinitions).toEqual([{ AttributeName: "pk", AttributeType: "S" }]);
    expect(input?.BillingMode).toBe("PAY_PER_REQUEST");
    // DynamoDB CreateTable accepts no ClientRequestToken; idempotency is via
    // ResourceInUseException handling (asserted in the test below).
    expect((input as Record<string, unknown> | undefined)?.ClientRequestToken).toBeUndefined();

    // PITR enabled by default.
    expect(ddbMock.commandCalls(UpdateContinuousBackupsCommand)).toHaveLength(1);

    // The polling loop actually iterated (CREATING → ACTIVE).
    expect(ddbMock.commandCalls(DescribeTableCommand).length).toBeGreaterThanOrEqual(2);
  });

  it("relies on ResourceInUseException, not an invalid SDK token field, for create idempotency", async () => {
    const prov = makeProvisioner();
    ddbMock.on(CreateTableCommand).resolves({});
    ddbMock.on(DescribeTableCommand).resolves(activeTableOutput());
    ddbMock.on(UpdateContinuousBackupsCommand).resolves({});
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    await prov.apply({ op: "create", spec: spec(BASE_PROPS, "sessions") });

    // The unified idempotency token from @foundry/core stays deterministic from
    // (resource.id, op) — the orchestrator derives it and records it on the step
    // result. It simply has no DynamoDB CreateTable field to map onto, so the
    // provisioner must not emit an invalid ClientRequestToken.
    expect(idempotencyToken("sessions", "create")).toBe(idempotencyToken("sessions", "create"));
    const input = ddbMock.commandCalls(CreateTableCommand)[0]?.args[0]?.input;
    expect((input as Record<string, unknown> | undefined)?.ClientRequestToken).toBeUndefined();
  });

  it("treats a duplicate create (ResourceInUseException) as success and polls to ACTIVE", async () => {
    const prov = makeProvisioner();
    ddbMock
      .on(CreateTableCommand)
      .rejects(Object.assign(new Error("already exists"), { name: "ResourceInUseException" }));
    ddbMock.on(DescribeTableCommand).resolves(activeTableOutput());
    ddbMock.on(UpdateContinuousBackupsCommand).resolves({});
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });
    expect(state.status).toBe("available");
  });
});

describe("apply (update)", () => {
  it("switches billingMode to PROVISIONED with throughput via UpdateTable", async () => {
    const prov = makeProvisioner();
    ddbMock.on(UpdateTableCommand).resolves({});
    ddbMock.on(DescribeTableCommand).resolves(
      activeTableOutput({
        BillingModeSummary: { BillingMode: "PROVISIONED" },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      }),
    );
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    const desired = spec({
      ...BASE_PROPS,
      billingMode: "PROVISIONED",
      provisionedThroughput: { readCapacityUnits: 5, writeCapacityUnits: 5 },
    });
    const from = stateFromOutputs({
      ...BASE_PROPS,
      globalSecondaryIndexes: [],
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });

    await prov.apply({ op: "update", spec: desired, from, changedFields: ["billingMode"] });

    const updates = ddbMock.commandCalls(UpdateTableCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]?.args[0]?.input;
    expect(input?.TableName).toBe("users");
    // UpdateTableInput speaks BillingMode (the enum), not BillingModeSpecification.
    expect(input?.BillingMode).toBe("PROVISIONED");
    expect(input?.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
  });

  it("adds a GSI via UpdateTable with a Create index update", async () => {
    const prov = makeProvisioner();
    ddbMock.on(UpdateTableCommand).resolves({});
    ddbMock.on(DescribeTableCommand).resolves(activeTableOutput());
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    const desired = spec({
      ...BASE_PROPS,
      attributeDefinitions: [
        { name: "pk", type: "S" },
        { name: "email", type: "S" },
      ],
      globalSecondaryIndexes: [
        {
          indexName: "byEmail",
          keySchema: [{ name: "email", type: "HASH" }],
          projection: { type: "ALL" },
        },
      ],
    });
    const from = stateFromOutputs({
      tableName: "users",
      attributeDefinitions: [{ name: "pk", type: "S" }],
      keySchema: [{ name: "pk", type: "HASH" }],
      globalSecondaryIndexes: [],
      billingMode: "PAY_PER_REQUEST",
      pointInTimeRecovery: true,
      pointInTimeRecoveryKnown: true,
      protect: false,
    });

    await prov.apply({
      op: "update",
      spec: desired,
      from,
      changedFields: ["globalSecondaryIndexes"],
    });

    const updates = ddbMock.commandCalls(UpdateTableCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]?.args[0]?.input;
    expect(input?.GlobalSecondaryIndexUpdates).toEqual([
      {
        Create: {
          IndexName: "byEmail",
          KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      },
    ]);
    // New GSI's key attribute must be declared.
    expect(input?.AttributeDefinitions).toEqual([{ AttributeName: "email", AttributeType: "S" }]);
  });
});

describe("apply (replace)", () => {
  it("deletes the existing table then recreates it", async () => {
    const prov = makeProvisioner();
    ddbMock.on(DeleteTableCommand).resolves({});
    // read() before delete sees the table; pollUntilDeleted sees it gone.
    ddbMock
      .on(DescribeTableCommand)
      .resolvesOnce(activeTableOutput())
      .rejectsOnce(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }))
      .resolves(activeTableOutput());
    ddbMock.on(CreateTableCommand).resolves({});
    ddbMock.on(UpdateContinuousBackupsCommand).resolves({});
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    const state = await prov.apply({
      op: "replace",
      spec: spec({ ...BASE_PROPS, keySchema: [{ name: "pk", type: "HASH" }, { name: "sk", type: "RANGE" }], attributeDefinitions: [{ name: "pk", type: "S" }, { name: "sk", type: "S" }] }),
      reason: "keySchema change",
    });

    expect(state.status).toBe("available");
    expect(ddbMock.commandCalls(DeleteTableCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(CreateTableCommand)).toHaveLength(1);
  });

  it("refuses to replace a protected resource without force", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.apply({
        op: "replace",
        spec: spec({ ...BASE_PROPS, protect: true }),
        reason: "keySchema change",
      }),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(ddbMock.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });
});

/* =============================== read ============================== */

describe("read", () => {
  it("maps a live table to a ResourceState for drift detection", async () => {
    const prov = makeProvisioner();
    ddbMock.on(DescribeTableCommand).resolves(activeTableOutput());
    ddbMock.on(DescribeContinuousBackupsCommand).resolves(pitEnabledOutput());

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).not.toBeNull();
    expect(state?.status).toBe("available");
    expect(state?.outputs?.pointInTimeRecovery).toBe(true);
    expect(state?.outputs?.billingMode).toBe("PAY_PER_REQUEST");
  });

  it("returns null when the table does not exist", async () => {
    const prov = makeProvisioner();
    ddbMock
      .on(DescribeTableCommand)
      .rejects(Object.assign(new Error("not found"), { name: "ResourceNotFoundException" }));

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).toBeNull();
  });
});

/* ============================= destroy ============================ */

describe("destroy", () => {
  it("deletes the table and polls until it is gone", async () => {
    const prov = makeProvisioner();
    ddbMock.on(DeleteTableCommand).resolves({});
    ddbMock
      .on(DescribeTableCommand)
      // still DELETING once, then gone
      .resolvesOnce({ Table: { ...activeTableOutput().Table, TableStatus: "DELETING" } })
      .rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));

    await prov.destroy(stateFromOutputs({ ...BASE_PROPS }));
    expect(ddbMock.commandCalls(DeleteTableCommand)).toHaveLength(1);
  });

  it("refuses a protected table without allowProtectedDestroy", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.destroy(stateFromOutputs({ ...BASE_PROPS, protect: true })),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(ddbMock.commandCalls(DeleteTableCommand)).toHaveLength(0);
  });

  it("destroys a protected table when allowProtectedDestroy is set (force)", async () => {
    const prov = makeProvisioner(true);
    ddbMock.on(DeleteTableCommand).resolves({});
    ddbMock
      .on(DescribeTableCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));

    await prov.destroy(stateFromOutputs({ ...BASE_PROPS, protect: true }));
    expect(ddbMock.commandCalls(DeleteTableCommand)).toHaveLength(1);
  });

  it("is idempotent when the table is already gone", async () => {
    const prov = makeProvisioner();
    ddbMock
      .on(DeleteTableCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    ddbMock
      .on(DescribeTableCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));

    await expect(prov.destroy(stateFromOutputs({ ...BASE_PROPS }))).resolves.toBeUndefined();
  });
});
