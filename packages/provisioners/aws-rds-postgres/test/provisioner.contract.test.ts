/**
 * Contract tests for the AWS RDS Postgres provisioner (design v1, §8 — "Contract
 * tests per plugin ... tested against a stubbed API (aws-sdk-client-mock)").
 *
 * No real AWS calls. These pin the behaviour the orchestrator relies on: correct
 * calls on create/update/replace/destroy, polling-to-ready, BY-REFERENCE secret
 * handling (no plaintext, no MasterUserPassword, no invalid ClientToken),
 * deletion-protection refusal, and read-driven drift mapping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  ModifyDBInstanceCommand,
  RDSClient,
  type DBInstance,
  type DescribeDBInstancesCommandOutput,
} from "@aws-sdk/client-rds";

import { AwsRdsPostgresProvisioner, ProtectedResourceError } from "../src/index.js";
import type { AwsRdsPostgresProvisionerOptions } from "../src/index.js";
import { idempotencyToken } from "@foundry/core";
import type { ResourceSpec, ResourceState, SecretRef } from "@foundry/core";

/* ------------------------------ fixtures ------------------------------ */

const FAST_WAIT = { initialIntervalMs: 1, timeoutMs: 2000 };
const CREDS: SecretRef = { from: "env:RDS_MASTER_PASSWORD" };

function spec(
  props: Record<string, unknown>,
  id = "analytics",
  tags?: Record<string, string>,
): ResourceSpec {
  const s: ResourceSpec = { id, kind: "aws.rds-postgres", props };
  if (tags) s.tags = tags;
  return s;
}

const BASE_PROPS = {
  dbInstanceIdentifier: "analytics",
  dbInstanceClass: "db.t4g.micro",
  allocatedStorage: 20,
  masterUsername: "postgres",
  masterUserPassword: CREDS,
};

/** The NormalizedInstance shape parseSpecProps(BASE_PROPS) produces (with defaults). */
const NORMALIZED = {
  dbInstanceIdentifier: "analytics",
  dbInstanceClass: "db.t4g.micro",
  allocatedStorage: 20,
  masterUsername: "postgres",
  vpcSecurityGroupIds: [],
  backupRetentionPeriod: 1,
  multiAz: false,
  storageEncrypted: true,
  deletionProtection: false,
  publiclyAccessible: false,
};

function instanceOutput(
  overrides: Partial<DBInstance> = {},
): DescribeDBInstancesCommandOutput {
  return {
    // $metadata is required on every CommandOutput (MetadataBearer); all its
    // fields are optional, so an empty object satisfies it for the mock.
    $metadata: {},
    DBInstances: [
      {
        DBInstanceIdentifier: "analytics",
        DBInstanceStatus: "available",
        DBInstanceArn: "arn:aws:rds:us-east-1:123456789012:db:analytics",
        DBInstanceClass: "db.t4g.micro",
        Engine: "postgres",
        AllocatedStorage: 20,
        MasterUsername: "postgres",
        BackupRetentionPeriod: 1,
        MultiAZ: false,
        StorageEncrypted: true,
        DeletionProtection: false,
        PubliclyAccessible: false,
        VpcSecurityGroups: [],
        Endpoint: {
          Address: "analytics.xxxx.rds.amazonaws.com",
          Port: 5432,
          HostedZoneId: "Zxxxx",
        },
        ...overrides,
      },
    ],
  };
}

function stateFromOutputs(
  outputs: Record<string, unknown>,
  id = "analytics",
): ResourceState {
  return {
    id,
    kind: "aws.rds-postgres",
    identifiers: { dbInstanceId: outputs.dbInstanceIdentifier as string },
    status: "available",
    connection: { engine: "postgres", region: "us-east-1", credsRef: CREDS },
    outputs,
  };
}

const rdsMock = mockClient(RDSClient);

function makeProvisioner(
  allowProtectedDestroy = false,
  extra: Partial<AwsRdsPostgresProvisionerOptions> = {},
): AwsRdsPostgresProvisioner {
  return new AwsRdsPostgresProvisioner({
    client: new RDSClient({ region: "us-east-1" }),
    region: "us-east-1",
    credsRef: CREDS,
    allowProtectedDestroy,
    waitFor: FAST_WAIT,
    ...extra,
  });
}

beforeEach(() => {
  rdsMock.reset();
});

/* =============================== plan =============================== */

describe("plan", () => {
  const prov = makeProvisioner();

  it("creates when there is no current state", () => {
    const action = prov.plan(spec(BASE_PROPS), null);
    expect(action).toEqual({ op: "create", spec: spec(BASE_PROPS) });
  });

  it("noops when desired matches current", () => {
    const current = stateFromOutputs({ ...NORMALIZED });
    const action = prov.plan(spec(BASE_PROPS), current);
    expect(action.op).toBe("noop");
  });

  it("updates dbInstanceClass in place", () => {
    const current = stateFromOutputs({ ...NORMALIZED });
    const desired = spec({ ...BASE_PROPS, dbInstanceClass: "db.t4g.small" });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("update");
    if (action.op === "update") {
      expect(action.changedFields).toContain("dbInstanceClass");
    }
  });

  it("replaces when dbInstanceIdentifier changes (cannot be renamed)", () => {
    const current = stateFromOutputs({ ...NORMALIZED });
    const desired = spec({ ...BASE_PROPS, dbInstanceIdentifier: "analytics-v2" });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/dbInstanceIdentifier/i);
    }
  });

  it("replaces when storageEncrypted changes (immutable)", () => {
    const current = stateFromOutputs({ ...NORMALIZED });
    const desired = spec({ ...BASE_PROPS, storageEncrypted: false });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/storageEncrypted/i);
    }
  });
});

/* =============================== apply ============================== */

describe("apply (create)", () => {
  it("creates the instance, polls to available, returns a postgres connection state", async () => {
    const prov = makeProvisioner();
    rdsMock.on(CreateDBInstanceCommand).resolves({});
    // Polling: CREATING once, then available (reused by the final read too).
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce(instanceOutput({ DBInstanceStatus: "creating" }))
      .resolves(instanceOutput());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

    expect(state.kind).toBe("aws.rds-postgres");
    expect(state.status).toBe("available");
    expect(state.identifiers.dbInstanceId).toBe("analytics");
    expect(state.identifiers.arn).toContain("arn:aws:rds");
    expect(state.connection).toEqual({
      engine: "postgres",
      region: "us-east-1",
      endpoint: "analytics.xxxx.rds.amazonaws.com:5432",
      credsRef: CREDS,
    });
    expect(state.outputs?.storageEncrypted).toBe(true);
    expect(state.outputs?.dbInstanceClass).toBe("db.t4g.micro");

    // CreateDBInstance carried the expected shape. (aws-sdk-client-mock v4:
    // commandCalls(...).args is the send() args tuple [Command] — read the
    // constructed command's input via .args[0].input.)
    const creates = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(creates).toHaveLength(1);
    const input = creates[0]?.args[0]?.input;
    expect(input?.DBInstanceIdentifier).toBe("analytics");
    expect(input?.Engine).toBe("postgres");
    expect(input?.DBInstanceClass).toBe("db.t4g.micro");
    expect(input?.AllocatedStorage).toBe(20);
    expect(input?.MasterUsername).toBe("postgres");
    // SECURITY: RDS manages the master password — never supply the value.
    expect(input?.ManageMasterUserPassword).toBe(true);
    expect(
      (input as Record<string, unknown> | undefined)?.MasterUserPassword,
    ).toBeUndefined();
    // Encrypted by default.
    expect(input?.StorageEncrypted).toBe(true);
    // CreateDBInstance accepts no ClientToken; idempotency is via
    // DBInstanceAlreadyExists handling (asserted in the test below).
    expect((input as Record<string, unknown> | undefined)?.ClientToken).toBeUndefined();

    // The polling loop actually iterated (creating → available).
    expect(rdsMock.commandCalls(DescribeDBInstancesCommand).length).toBeGreaterThanOrEqual(2);
  });

  it("relies on DBInstanceAlreadyExists, not an invalid SDK token field, for create idempotency", async () => {
    const prov = makeProvisioner();
    rdsMock.on(CreateDBInstanceCommand).resolves({});
    rdsMock.on(DescribeDBInstancesCommand).resolves(instanceOutput());

    await prov.apply({ op: "create", spec: spec(BASE_PROPS, "sessions") });

    // The unified idempotency token from @foundry/core stays deterministic from
    // (resource.id, op) — the orchestrator derives it and records it on the step
    // result. RDS CreateDBInstance has no ClientToken field to map it onto, so
    // the provisioner must not emit an invalid one.
    expect(idempotencyToken("sessions", "create")).toBe(idempotencyToken("sessions", "create"));
    const input = rdsMock.commandCalls(CreateDBInstanceCommand)[0]?.args[0]?.input;
    expect((input as Record<string, unknown> | undefined)?.ClientToken).toBeUndefined();
  });

  it("treats a duplicate create (DBInstanceAlreadyExists) as success and polls to available", async () => {
    const prov = makeProvisioner();
    rdsMock
      .on(CreateDBInstanceCommand)
      .rejects(Object.assign(new Error("already exists"), { name: "DBInstanceAlreadyExists" }));
    rdsMock.on(DescribeDBInstancesCommand).resolves(instanceOutput());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });
    expect(state.status).toBe("available");
  });
});

describe("apply (update)", () => {
  it("modifies dbInstanceClass via ModifyDBInstance with ApplyImmediately", async () => {
    const prov = makeProvisioner();
    rdsMock.on(ModifyDBInstanceCommand).resolves({});
    rdsMock.on(DescribeDBInstancesCommand).resolves(
      instanceOutput({ DBInstanceClass: "db.t4g.small" }),
    );

    const desired = spec({ ...BASE_PROPS, dbInstanceClass: "db.t4g.small" });
    const from = stateFromOutputs({ ...NORMALIZED });

    await prov.apply({
      op: "update",
      spec: desired,
      from,
      changedFields: ["dbInstanceClass"],
    });

    const modifies = rdsMock.commandCalls(ModifyDBInstanceCommand);
    expect(modifies).toHaveLength(1);
    const input = modifies[0]?.args[0]?.input;
    expect(input?.DBInstanceIdentifier).toBe("analytics");
    expect(input?.ApplyImmediately).toBe(true);
    expect(input?.DBInstanceClass).toBe("db.t4g.small");
  });
});

describe("apply (replace)", () => {
  it("deletes the existing instance then recreates it", async () => {
    const prov = makeProvisioner();
    rdsMock.on(DeleteDBInstanceCommand).resolves({});
    // read() before delete sees the instance; describeInstance sees it;
    // pollUntilDeleted sees it gone; pollUntilAvailable + final read see it back.
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce(instanceOutput()) // read() in applyReplace
      .resolvesOnce(instanceOutput()) // describeInstance() in deleteDbInstance
      .rejectsOnce(Object.assign(new Error("gone"), { name: "DBInstanceNotFound" })) // pollUntilDeleted
      .resolves(instanceOutput()); // pollUntilAvailable + final read
    rdsMock.on(CreateDBInstanceCommand).resolves({});

    const state = await prov.apply({
      op: "replace",
      spec: spec({ ...BASE_PROPS, dbInstanceIdentifier: "analytics-v2" }),
      reason: "dbInstanceIdentifier change",
    });

    expect(state.status).toBe("available");
    expect(rdsMock.commandCalls(DeleteDBInstanceCommand)).toHaveLength(1);
    expect(rdsMock.commandCalls(CreateDBInstanceCommand)).toHaveLength(1);
    // replace skips the final snapshot (recreation, not terminal destroy);
    // destroy is the snapshot-default-on path (asserted in the destroy block).
    const del = rdsMock.commandCalls(DeleteDBInstanceCommand)[0]?.args[0]?.input;
    expect(del?.SkipFinalSnapshot).toBe(true);
    expect(
      (del as Record<string, unknown> | undefined)?.FinalDBSnapshotIdentifier,
    ).toBeUndefined();
  });

  it("refuses to replace a protected resource without force", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.apply({
        op: "replace",
        spec: spec({ ...BASE_PROPS, deletionProtection: true }),
        reason: "dbInstanceIdentifier change",
      }),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(rdsMock.commandCalls(DeleteDBInstanceCommand)).toHaveLength(0);
  });
});

/* =============================== read ============================== */

describe("read", () => {
  it("maps a live instance to a ResourceState for drift detection", async () => {
    const prov = makeProvisioner();
    rdsMock.on(DescribeDBInstancesCommand).resolves(instanceOutput());

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).not.toBeNull();
    expect(state?.status).toBe("available");
    expect(state?.outputs?.storageEncrypted).toBe(true);
    expect(state?.outputs?.dbInstanceClass).toBe("db.t4g.micro");
    expect(state?.connection.endpoint).toBe("analytics.xxxx.rds.amazonaws.com:5432");
  });

  it("returns null when the instance does not exist", async () => {
    const prov = makeProvisioner();
    rdsMock
      .on(DescribeDBInstancesCommand)
      .rejects(Object.assign(new Error("not found"), { name: "DBInstanceNotFound" }));

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).toBeNull();
  });
});

/* ============================= destroy ============================ */

describe("destroy", () => {
  it("requests a final snapshot by default and polls until gone (design §7 default-on)", async () => {
    const prov = makeProvisioner(false, { finalSnapshotSuffix: () => "t1" });
    rdsMock.on(DeleteDBInstanceCommand).resolves({});
    // describeInstance() sees it (not protected); pollUntilDeleted sees it gone.
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce(instanceOutput())
      .rejects(Object.assign(new Error("gone"), { name: "DBInstanceNotFound" }));

    await prov.destroy(stateFromOutputs({ ...NORMALIZED }));
    expect(rdsMock.commandCalls(DeleteDBInstanceCommand)).toHaveLength(1);
    expect(rdsMock.commandCalls(ModifyDBInstanceCommand)).toHaveLength(0);
    const del = rdsMock.commandCalls(DeleteDBInstanceCommand)[0]?.args[0]?.input;
    // Default-on: a unique FinalDBSnapshotIdentifier is sent...
    expect(del?.FinalDBSnapshotIdentifier).toBe("foundry-analytics-final-t1");
    // ...and SkipFinalSnapshot is omitted (mutually exclusive in the RDS API).
    expect(
      (del as Record<string, unknown> | undefined)?.SkipFinalSnapshot,
    ).toBeUndefined();
  });

  it("derives a shape-correct final-snapshot identifier from the default suffix", async () => {
    // No injected suffix: the default Date.now()-based generator must still
    // produce a foundry-<id>-final-* identifier (shape, not exact value).
    const prov = makeProvisioner();
    rdsMock.on(DeleteDBInstanceCommand).resolves({});
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce(instanceOutput())
      .rejects(Object.assign(new Error("gone"), { name: "DBInstanceNotFound" }));

    await prov.destroy(stateFromOutputs({ ...NORMALIZED }));
    const del = rdsMock.commandCalls(DeleteDBInstanceCommand)[0]?.args[0]?.input;
    expect(del?.FinalDBSnapshotIdentifier).toMatch(
      /^foundry-analytics-final-[a-z0-9]+$/,
    );
    expect(
      (del as Record<string, unknown> | undefined)?.SkipFinalSnapshot,
    ).toBeUndefined();
  });

  it("skipFinalSnapshot:true opts out of the final snapshot", async () => {
    const prov = makeProvisioner(false, { skipFinalSnapshot: true });
    rdsMock.on(DeleteDBInstanceCommand).resolves({});
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce(instanceOutput())
      .rejects(Object.assign(new Error("gone"), { name: "DBInstanceNotFound" }));

    await prov.destroy(stateFromOutputs({ ...NORMALIZED }));
    const del = rdsMock.commandCalls(DeleteDBInstanceCommand)[0]?.args[0]?.input;
    expect(del?.SkipFinalSnapshot).toBe(true);
    expect(
      (del as Record<string, unknown> | undefined)?.FinalDBSnapshotIdentifier,
    ).toBeUndefined();
  });

  it("refuses a protected instance without allowProtectedDestroy", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.destroy(stateFromOutputs({ ...NORMALIZED, deletionProtection: true })),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(rdsMock.commandCalls(DeleteDBInstanceCommand)).toHaveLength(0);
  });

  it("destroys a protected instance when allowProtectedDestroy is set (disables cloud deletion protection first)", async () => {
    const prov = makeProvisioner(true);
    rdsMock.on(ModifyDBInstanceCommand).resolves({});
    rdsMock.on(DeleteDBInstanceCommand).resolves({});
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce(instanceOutput({ DeletionProtection: true }))
      .rejects(Object.assign(new Error("gone"), { name: "DBInstanceNotFound" }));

    await prov.destroy(stateFromOutputs({ ...NORMALIZED, deletionProtection: true }));

    // First disabled cloud-level DeletionProtection, then deleted.
    const modifies = rdsMock.commandCalls(ModifyDBInstanceCommand);
    expect(modifies).toHaveLength(1);
    expect(modifies[0]?.args[0]?.input?.DeletionProtection).toBe(false);
    expect(rdsMock.commandCalls(DeleteDBInstanceCommand)).toHaveLength(1);
  });

  it("is idempotent when the instance is already gone", async () => {
    const prov = makeProvisioner();
    rdsMock
      .on(DescribeDBInstancesCommand)
      .rejects(Object.assign(new Error("gone"), { name: "DBInstanceNotFound" }));

    await expect(prov.destroy(stateFromOutputs({ ...NORMALIZED }))).resolves.toBeUndefined();
    expect(rdsMock.commandCalls(DeleteDBInstanceCommand)).toHaveLength(0);
    expect(rdsMock.commandCalls(ModifyDBInstanceCommand)).toHaveLength(0);
  });
});
