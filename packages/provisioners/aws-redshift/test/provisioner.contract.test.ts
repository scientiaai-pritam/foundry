/**
 * Contract tests for the Redshift provisioner (design v1, §8 — "Contract tests
 * per plugin ... tested against a stubbed API (aws-sdk-client-mock)").
 *
 * No real AWS calls. These pin the behaviour the orchestrator relies on:
 * correct calls on create/update/replace/destroy, polling-to-ready, idempotency,
 * protect-guard refusal, read-driven drift mapping — AND that the master
 * password VALUE never leaks into state/outputs while still reaching CreateCluster.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClustersCommand,
  ModifyClusterCommand,
  RedshiftClient,
  type Cluster,
  type DescribeClustersCommandOutput,
} from "@aws-sdk/client-redshift";

import { RedshiftProvisioner, ProtectedResourceError } from "../src/index.js";
import type { RedshiftProvisionerOptions } from "../src/index.js";
import { idempotencyToken } from "@scientia/core";
import type { ResourceSpec, ResourceState, SecretRef } from "@scientia/core";

/* ------------------------------ fixtures ------------------------------ */

const FAST_WAIT = { initialIntervalMs: 1, timeoutMs: 2000 };
const PW_ENV = "SCIENTIA_REDSHIFT_TEST_PW";
const PW_VALUE = "S3cret-Pw_123!";
const CREDS: SecretRef = { from: `env:${PW_ENV}` };

function spec(
  props: Record<string, unknown>,
  id = "warehouse",
  tags?: Record<string, string>,
): ResourceSpec {
  const s: ResourceSpec = { id, kind: "aws.redshift", props };
  if (tags) s.tags = tags;
  return s;
}

const BASE_PROPS = {
  clusterIdentifier: "warehouse",
  nodeType: "ra3.xlplus",
  masterUsername: "admin",
  masterUserPassword: CREDS,
  clusterType: "multi-node",
  numberOfNodes: 2,
};

/** A well-formed DescribeClusters response (one available cluster). */
function availableClustersOutput(
  overrides: Partial<Cluster> = {},
): DescribeClustersCommandOutput {
  return {
    // $metadata is required on every CommandOutput (MetadataBearer); all its
    // fields are optional, so an empty object satisfies it for the mock.
    $metadata: {},
    Clusters: [
      {
        ClusterIdentifier: "warehouse",
        NodeType: "ra3.xlplus",
        MasterUsername: "admin",
        DBName: "dev",
        NumberOfNodes: 2,
        ClusterStatus: "available",
        PubliclyAccessible: false,
        Encrypted: false,
        VpcSecurityGroups: [
          { VpcSecurityGroupId: "sg-1", Status: "active" },
          { VpcSecurityGroupId: "sg-2", Status: "active" },
        ],
        Endpoint: {
          Address: "warehouse.abc.redshift.amazonaws.com",
          Port: 5439,
        },
        ...overrides,
      },
    ],
  };
}

/** A Describe response whose single cluster has the given status. */
function clustersWithStatus(status: string): DescribeClustersCommandOutput {
  return availableClustersOutput({ ClusterStatus: status });
}

function stateFromOutputs(
  outputs: Record<string, unknown>,
  id = "warehouse",
): ResourceState {
  return {
    id,
    kind: "aws.redshift",
    identifiers: { clusterIdentifier: outputs.clusterIdentifier as string },
    status: "available",
    connection: { engine: "redshift", region: "us-east-1", credsRef: CREDS },
    outputs,
  };
}

const redshiftMock = mockClient(RedshiftClient);

function makeProvisioner(
  allowProtectedDestroy = false,
  extra: Partial<RedshiftProvisionerOptions> = {},
): RedshiftProvisioner {
  return new RedshiftProvisioner({
    client: new RedshiftClient({ region: "us-east-1" }),
    region: "us-east-1",
    allowProtectedDestroy,
    waitFor: FAST_WAIT,
    ...extra,
  });
}

beforeEach(() => {
  redshiftMock.reset();
  process.env[PW_ENV] = PW_VALUE;
});

afterEach(() => {
  delete process.env[PW_ENV];
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
      clusterIdentifier: "warehouse",
      nodeType: "ra3.xlplus",
      masterUsername: "admin",
      clusterType: "multi-node",
      numberOfNodes: 2,
      // BASE_PROPS omits vpcSecurityGroupIds, so the provisioner defaults it to
      // []. The current state must mirror that, else vpcSecurityGroupIds would
      // be (correctly) flagged as drift.
      vpcSecurityGroupIds: [],
      publiclyAccessible: false,
      encrypted: false,
      protect: false,
    });
    const action = prov.plan(spec(BASE_PROPS), current);
    expect(action.op).toBe("noop");
  });

  it("updates nodeType / numberOfNodes in place (resize)", () => {
    const current = stateFromOutputs({
      clusterIdentifier: "warehouse",
      nodeType: "ra3.xlplus",
      masterUsername: "admin",
      clusterType: "multi-node",
      numberOfNodes: 2,
      vpcSecurityGroupIds: [],
      publiclyAccessible: false,
      encrypted: false,
      protect: false,
    });
    const desired = spec({
      ...BASE_PROPS,
      nodeType: "ra3.4xlarge",
      numberOfNodes: 4,
    });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("update");
    if (action.op === "update") {
      expect(action.changedFields).toContain("nodeType");
      expect(action.changedFields).toContain("numberOfNodes");
      expect(action.changedFields).not.toContain("masterUsername");
    }
  });

  it("replaces when clusterIdentifier changes (cannot be renamed)", () => {
    const current = stateFromOutputs({
      clusterIdentifier: "warehouse",
      nodeType: "ra3.xlplus",
      masterUsername: "admin",
      clusterType: "multi-node",
      numberOfNodes: 2,
      vpcSecurityGroupIds: [],
      publiclyAccessible: false,
      encrypted: false,
      protect: false,
    });
    const desired = spec({ ...BASE_PROPS, clusterIdentifier: "warehouse-v2" });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/clusterIdentifier/i);
    }
  });

  it("replaces when masterUsername changes (immutable)", () => {
    const current = stateFromOutputs({
      clusterIdentifier: "warehouse",
      nodeType: "ra3.xlplus",
      masterUsername: "admin",
      clusterType: "multi-node",
      numberOfNodes: 2,
      vpcSecurityGroupIds: [],
      publiclyAccessible: false,
      encrypted: false,
      protect: false,
    });
    const desired = spec({ ...BASE_PROPS, masterUsername: "root" });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/masterUsername/i);
    }
  });
});

/* =============================== apply ============================== */

describe("apply (create)", () => {
  it("creates the cluster, polls to available, returns a redshift connection state", async () => {
    const prov = makeProvisioner();
    redshiftMock.on(CreateClusterCommand).resolves({});
    // Polling: creating once, then available (reused by the final read too).
    redshiftMock
      .on(DescribeClustersCommand)
      .resolvesOnce(clustersWithStatus("creating"))
      .resolves(availableClustersOutput());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

    expect(state.kind).toBe("aws.redshift");
    expect(state.status).toBe("available");
    expect(state.identifiers.clusterIdentifier).toBe("warehouse");
    expect(state.identifiers.endpoint).toBe(
      "warehouse.abc.redshift.amazonaws.com:5439",
    );
    expect(state.connection).toEqual({
      engine: "redshift",
      endpoint: "warehouse.abc.redshift.amazonaws.com:5439",
      region: "us-east-1",
      credsRef: CREDS,
    });
    expect(state.outputs?.nodeType).toBe("ra3.xlplus");
    expect(state.outputs?.numberOfNodes).toBe(2);

    // CreateCluster carried the expected shape. (aws-sdk-client-mock v4:
    // commandCalls(...).args is the send() args tuple [Command] — read the
    // constructed command's input via .args[0].input.)
    const creates = redshiftMock.commandCalls(CreateClusterCommand);
    expect(creates).toHaveLength(1);
    const input = creates[0]?.args[0]?.input;
    expect(input?.ClusterIdentifier).toBe("warehouse");
    expect(input?.NodeType).toBe("ra3.xlplus");
    expect(input?.MasterUsername).toBe("admin");
    expect(input?.ClusterType).toBe("multi-node");
    expect(input?.NumberOfNodes).toBe(2);
    expect(input?.PubliclyAccessible).toBe(false);
    expect(input?.Encrypted).toBe(false);
    // The master password was resolved transiently from the env ref and reached
    // CreateCluster...
    expect(input?.MasterUserPassword).toBe(PW_VALUE);
    // ...but the VALUE never appears anywhere in the persisted state.
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(PW_VALUE);
    expect(state.outputs?.masterUserPassword).toBeUndefined();
    expect(state.outputs?.masterUserPasswordRef).toBeUndefined();

    // The polling loop actually iterated (creating → available).
    expect(
      redshiftMock.commandCalls(DescribeClustersCommand).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("emits no ClientRequestToken (Redshift CreateCluster has no such field)", async () => {
    const prov = makeProvisioner();
    redshiftMock.on(CreateClusterCommand).resolves({});
    redshiftMock.on(DescribeClustersCommand).resolves(availableClustersOutput());

    await prov.apply({ op: "create", spec: spec(BASE_PROPS, "analytics") });

    // The unified idempotency token from @scientia/core stays deterministic from
    // (resource.id, op) — the orchestrator derives it and records it on the step
    // result. Redshift CreateCluster has no ClientRequestToken field, so the
    // provisioner must not emit an invalid one.
    expect(idempotencyToken("analytics", "create")).toBe(
      idempotencyToken("analytics", "create"),
    );
    const input = redshiftMock.commandCalls(CreateClusterCommand)[0]?.args[0]?.input;
    expect(
      (input as Record<string, unknown> | undefined)?.ClientRequestToken,
    ).toBeUndefined();
  });

  it("treats a duplicate create (ClusterAlreadyExistsFault) as success and polls to available", async () => {
    const prov = makeProvisioner();
    redshiftMock
      .on(CreateClusterCommand)
      .rejects(
        Object.assign(new Error("already exists"), {
          name: "ClusterAlreadyExistsFault",
        }),
      );
    redshiftMock.on(DescribeClustersCommand).resolves(availableClustersOutput());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });
    expect(state.status).toBe("available");
  });
});

describe("apply (update)", () => {
  it("resizes via a single ModifyCluster (nodeType + numberOfNodes)", async () => {
    const prov = makeProvisioner();
    redshiftMock.on(ModifyClusterCommand).resolves({});
    redshiftMock
      .on(DescribeClustersCommand)
      .resolves(
        availableClustersOutput({
          NodeType: "ra3.4xlarge",
          NumberOfNodes: 4,
        }),
      );

    const desired = spec({
      ...BASE_PROPS,
      nodeType: "ra3.4xlarge",
      numberOfNodes: 4,
    });
    const from = stateFromOutputs({
      clusterIdentifier: "warehouse",
      nodeType: "ra3.xlplus",
      masterUsername: "admin",
      clusterType: "multi-node",
      numberOfNodes: 2,
      vpcSecurityGroupIds: [],
      publiclyAccessible: false,
      encrypted: false,
      protect: false,
    });

    await prov.apply({
      op: "update",
      spec: desired,
      from,
      changedFields: ["nodeType", "numberOfNodes"],
    });

    const updates = redshiftMock.commandCalls(ModifyClusterCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]?.args[0]?.input;
    expect(input?.ClusterIdentifier).toBe("warehouse");
    expect(input?.NodeType).toBe("ra3.4xlarge");
    expect(input?.NumberOfNodes).toBe(4);
    // Master password is never touched on modify.
    expect(
      (input as Record<string, unknown> | undefined)?.MasterUserPassword,
    ).toBeUndefined();
  });
});

describe("apply (replace)", () => {
  it("deletes the existing cluster then recreates it", async () => {
    const prov = makeProvisioner();
    redshiftMock.on(DeleteClusterCommand).resolves({});
    // read() before delete sees the cluster; pollUntilDeleted sees it gone;
    // then create's poll + final read see it available again.
    redshiftMock
      .on(DescribeClustersCommand)
      .resolvesOnce(availableClustersOutput()) // read() before delete
      .rejectsOnce(
        Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }),
      ) // pollUntilDeleted
      .resolves(availableClustersOutput()); // create poll + final read
    redshiftMock.on(CreateClusterCommand).resolves({});

    const state = await prov.apply({
      op: "replace",
      spec: spec({ ...BASE_PROPS }),
      reason: "masterUsername change",
    });

    expect(state.status).toBe("available");
    expect(redshiftMock.commandCalls(DeleteClusterCommand)).toHaveLength(1);
    expect(redshiftMock.commandCalls(CreateClusterCommand)).toHaveLength(1);
    // replace skips the final snapshot (recreation, not terminal destroy);
    // destroy is the snapshot-default-on path (asserted in the destroy block).
    const del = redshiftMock.commandCalls(DeleteClusterCommand)[0]?.args[0]?.input;
    expect(del?.SkipFinalClusterSnapshot).toBe(true);
  });

  it("refuses to replace a protected resource without force", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.apply({
        op: "replace",
        spec: spec({ ...BASE_PROPS, protect: true }),
        reason: "masterUsername change",
      }),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(redshiftMock.commandCalls(DeleteClusterCommand)).toHaveLength(0);
  });
});

/* =============================== read ============================== */

describe("read", () => {
  it("maps a live cluster to a ResourceState for drift detection", async () => {
    const prov = makeProvisioner();
    redshiftMock.on(DescribeClustersCommand).resolves(availableClustersOutput());

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).not.toBeNull();
    expect(state?.status).toBe("available");
    expect(state?.outputs?.clusterType).toBe("multi-node");
    expect(state?.outputs?.vpcSecurityGroupIds).toEqual(["sg-1", "sg-2"]);
  });

  it("returns null when the cluster does not exist", async () => {
    const prov = makeProvisioner();
    redshiftMock
      .on(DescribeClustersCommand)
      .rejects(
        Object.assign(new Error("not found"), { name: "ClusterNotFoundFault" }),
      );

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).toBeNull();
  });
});

/* ============================= destroy ============================ */

describe("destroy", () => {
  it("requests a final snapshot by default and polls until gone (design §7 default-on)", async () => {
    const prov = makeProvisioner(false, { finalSnapshotSuffix: () => "t1" });
    redshiftMock.on(DeleteClusterCommand).resolves({});
    redshiftMock
      .on(DescribeClustersCommand)
      // still deleting once, then gone
      .resolvesOnce(clustersWithStatus("deleting"))
      .rejects(Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }));

    await prov.destroy(stateFromOutputs({ ...BASE_PROPS }));
    expect(redshiftMock.commandCalls(DeleteClusterCommand)).toHaveLength(1);
    const del = redshiftMock.commandCalls(DeleteClusterCommand)[0]?.args[0]?.input;
    // Default-on: a unique FinalClusterSnapshotIdentifier is sent...
    expect(del?.FinalClusterSnapshotIdentifier).toBe("scientia-warehouse-final-t1");
    // ...and SkipFinalClusterSnapshot is omitted (mutually exclusive in the API).
    expect(
      (del as Record<string, unknown> | undefined)?.SkipFinalClusterSnapshot,
    ).toBeUndefined();
  });

  it("derives a shape-correct final-snapshot identifier from the default suffix", async () => {
    // No injected suffix: the default Date.now()-based generator must still
    // produce a scientia-<clusterId>-final-* identifier (shape, not exact value).
    const prov = makeProvisioner();
    redshiftMock.on(DeleteClusterCommand).resolves({});
    redshiftMock
      .on(DescribeClustersCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }));

    await prov.destroy(stateFromOutputs({ ...BASE_PROPS }));
    const del = redshiftMock.commandCalls(DeleteClusterCommand)[0]?.args[0]?.input;
    expect(del?.FinalClusterSnapshotIdentifier).toMatch(
      /^scientia-warehouse-final-[a-z0-9]+$/,
    );
    expect(
      (del as Record<string, unknown> | undefined)?.SkipFinalClusterSnapshot,
    ).toBeUndefined();
  });

  it("skipFinalSnapshot:true opts out of the final snapshot", async () => {
    const prov = makeProvisioner(false, { skipFinalSnapshot: true });
    redshiftMock.on(DeleteClusterCommand).resolves({});
    redshiftMock
      .on(DescribeClustersCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }));

    await prov.destroy(stateFromOutputs({ ...BASE_PROPS }));
    const del = redshiftMock.commandCalls(DeleteClusterCommand)[0]?.args[0]?.input;
    expect(del?.SkipFinalClusterSnapshot).toBe(true);
    expect(
      (del as Record<string, unknown> | undefined)?.FinalClusterSnapshotIdentifier,
    ).toBeUndefined();
  });

  it("refuses a protected cluster without allowProtectedDestroy", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.destroy(stateFromOutputs({ ...BASE_PROPS, protect: true })),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(redshiftMock.commandCalls(DeleteClusterCommand)).toHaveLength(0);
  });

  it("destroys a protected cluster when allowProtectedDestroy is set (force)", async () => {
    const prov = makeProvisioner(true);
    redshiftMock.on(DeleteClusterCommand).resolves({});
    redshiftMock
      .on(DescribeClustersCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }));

    await prov.destroy(stateFromOutputs({ ...BASE_PROPS, protect: true }));
    expect(redshiftMock.commandCalls(DeleteClusterCommand)).toHaveLength(1);
  });

  it("is idempotent when the cluster is already gone", async () => {
    const prov = makeProvisioner();
    redshiftMock
      .on(DeleteClusterCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }));
    redshiftMock
      .on(DescribeClustersCommand)
      .rejects(Object.assign(new Error("gone"), { name: "ClusterNotFoundFault" }));

    await expect(
      prov.destroy(stateFromOutputs({ ...BASE_PROPS })),
    ).resolves.toBeUndefined();
  });
});

/* ================ security: password value never leaks ================= */

describe("security: master password value never leaks (regression)", () => {
  // Design §5/§6 + the one-transient-resolution contract (types.ts SECURITY note):
  // CreateCluster MUST receive the resolved password literal (AWS requires it),
  // but the VALUE is never persisted, logged, or echoed in an error — only the
  // SecretRef reaches ConnectionTarget.credsRef.

  it("reaches CreateCluster but never appears in state, outputs, connection, or logs", async () => {
    const prov = makeProvisioner();
    redshiftMock.on(CreateClusterCommand).resolves({});
    redshiftMock
      .on(DescribeClustersCommand)
      .resolvesOnce(clustersWithStatus("creating"))
      .resolves(availableClustersOutput());

    // Capture every console sink so a future regression that logs the value is
    // caught (the provisioner does not log today; this locks that in).
    const spies = (
      ["log", "error", "warn", "info", "debug"] as const
    ).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));

    try {
      const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

      // The value WAS resolved and reached CreateCluster (proves transient use)...
      const input = redshiftMock.commandCalls(CreateClusterCommand)[0]?.args[0]?.input;
      expect(input?.MasterUserPassword).toBe(PW_VALUE);

      // ...but never appears anywhere in the persisted state or connection.
      expect(JSON.stringify(state)).not.toContain(PW_VALUE);
      expect(state.outputs?.masterUserPassword).toBeUndefined();
      expect(state.outputs?.masterUserPasswordRef).toBeUndefined();
      expect(JSON.stringify(state.connection)).not.toContain(PW_VALUE);
      // Only the ref (not the value) reaches credsRef.
      expect(state.connection.credsRef).toEqual(CREDS);

      // ...and never appeared in any console output.
      for (const s of spies) {
        for (const call of s.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(PW_VALUE);
        }
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("does not appear in a thrown error when the env-var ref is unset (only the NAME)", async () => {
    delete process.env[PW_ENV]; // force resolution failure
    const prov = makeProvisioner();
    redshiftMock.on(CreateClusterCommand).resolves({});
    redshiftMock.on(DescribeClustersCommand).resolves(availableClustersOutput());

    const err = await prov
      .apply({ op: "create", spec: spec(BASE_PROPS) })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).not.toContain(PW_VALUE);
    // Only the env-var NAME is surfaced — never the value.
    expect(msg).toContain(PW_ENV);
  });

  it("does not appear in a thrown error when a secretId ref is used (provisioner cannot resolve)", async () => {
    const secretIdRef: SecretRef = { secretId: "scientia/warehouse" };
    const prov = makeProvisioner();
    redshiftMock.on(CreateClusterCommand).resolves({});
    redshiftMock.on(DescribeClustersCommand).resolves(availableClustersOutput());

    const err = await prov
      .apply({
        op: "create",
        spec: spec({ ...BASE_PROPS, masterUserPassword: secretIdRef }),
      })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).not.toContain(PW_VALUE);
    // The message points at the secretId path without echoing any value.
    expect(msg).toContain("secretId");
  });
});
