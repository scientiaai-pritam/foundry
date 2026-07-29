/**
 * Redshift provisioner — implements the scientia `Provisioner` contract for
 * `kind: "aws.redshift"` using AWS SDK v3's RedshiftClient.
 *
 * Lifecycle mapping (design v1, §5/§7):
 *   - plan    → diff desired vs current (update vs replace vs noop)
 *   - apply   → create (poll ClusterStatus→available), in-place update
 *               (resize: nodeType/numberOfNodes/clusterType, security groups,
 *               publiclyAccessible via ModifyCluster), replace (delete + create),
 *   - read    → DescribeClusters for drift detection
 *   - destroy → DeleteCluster (SkipFinalClusterSnapshot=true per the task spec),
 *               honoring a `protect` flag
 *
 * SECURITY: `masterUserPassword` is a SecretRef POINTER. The provisioner:
 *   - passes it through unchanged to ConnectionTarget.credsRef for the connector
 *     to resolve at runtime;
 *   - resolves it ONLY transiently (env-var refs in v1) to satisfy
 *     CreateCluster's required MasterUserPassword — Redshift cannot create a
 *     cluster without it; the value is used for the single SDK call and is never
 *     written to state, outputs, logs, or error messages.
 */
import type {
  ConnectionTarget,
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceSpec,
  ResourceState,
  SecretRef,
  WaitForOptions,
} from "@scientia/core";
import { waitFor } from "@scientia/core";
import {
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClustersCommand,
  ModifyClusterCommand,
} from "@aws-sdk/client-redshift";
import type {
  Cluster,
  CreateClusterCommandInput,
  ModifyClusterCommandInput,
  RedshiftClient,
} from "@aws-sdk/client-redshift";

import {
  RedshiftProvisionerError,
  ProtectedResourceError,
  isAwsError,
  wrapAwsError,
} from "./errors.js";
import { outputsToNormalized, parseSpecProps } from "./parse.js";
import { diffCluster } from "./diff.js";
import { clusterToNormalized, mapClusterStatus, toAwsTags } from "./convert.js";
import type { NormalizedCluster, RedshiftProvisionerOptions } from "./types.js";

export class RedshiftProvisioner implements Provisioner {
  readonly kind: ResourceKind = "aws.redshift";

  private readonly client: RedshiftClient;
  private readonly region: string;
  private readonly allowProtectedDestroy: boolean;
  private readonly skipFinalSnapshot: boolean;
  private readonly waitForOpts: WaitForOptions;

  constructor(opts: RedshiftProvisionerOptions) {
    this.client = opts.client;
    this.region = opts.region;
    this.allowProtectedDestroy = opts.allowProtectedDestroy ?? false;
    // Task spec mandates skipping the final snapshot for v1 (design §7 lists
    // final snapshots as the default for stateful engines — this is the
    // override). Maps to the SDK's SkipFinalClusterSnapshot input field.
    this.skipFinalSnapshot = opts.skipFinalSnapshot ?? true;
    this.skipFinalSnapshot = opts.skipFinalSnapshot ?? true;
    // Core's WaitForOptions requires timeoutMs; default to 15 min (Redshift
    // cluster provisioning can take several minutes to reach `available`).
    this.waitForOpts = opts.waitFor ?? { timeoutMs: 900_000 };
  }

  /* =========================== plan ============================ */

  plan(desired: ResourceSpec, current: ResourceState | null): PlanAction {
    if (current === null) {
      return { op: "create", spec: desired };
    }
    const desiredN = parseSpecProps(desired.props);
    const currentN = outputsToNormalized(current.outputs);
    if (!currentN) {
      // State predates the normalized outputs (or was hand-edited). Don't guess;
      // propose a full in-place reconciliation and let apply re-read live.
      return {
        op: "update",
        spec: desired,
        from: current,
        changedFields: ["*"],
      };
    }

    const d = diffCluster(desiredN, currentN);
    if (d.requiresReplace) {
      return {
        op: "replace",
        spec: desired,
        reason: d.replaceReason ?? "resource must be replaced",
      };
    }
    if (d.changedFields.length === 0) {
      return {
        op: "noop",
        id: desired.id,
        reason: `cluster '${desiredN.clusterIdentifier}' matches desired state`,
      };
    }
    return {
      op: "update",
      spec: desired,
      from: current,
      changedFields: d.changedFields,
    };
  }

  /* =========================== apply =========================== */

  async apply(action: PlanAction): Promise<ResourceState> {
    switch (action.op) {
      case "create":
        return this.applyCreate(action.spec);
      case "update":
        return this.applyUpdate(action.spec, action.from, action.changedFields);
      case "replace":
        return this.applyReplace(action.spec);
      // delete is routed through destroy() by the orchestrator; noop is skipped
      // before provisioner dispatch (it carries only an id, no spec/state). They
      // never reach apply() — surface a clear error if a caller misuses the API.
      case "delete":
      case "noop":
        throw new RedshiftProvisionerError(
          `apply() does not handle op "${action.op}" (delete uses destroy(); noop is skipped by the orchestrator)`,
          action.op === "delete" ? action.state.id : action.id,
          action.op,
        );
      default: {
        const _exhaustive: never = action;
        throw new RedshiftProvisionerError(
          `unknown action: ${JSON.stringify(_exhaustive)}`,
          "?",
          "apply",
        );
      }
    }
  }

  /* =========================== read ============================ */

  async read(spec: ResourceSpec): Promise<ResourceState | null> {
    const desired = parseSpecProps(spec.props);

    const cluster = await this.describeCluster(desired.clusterIdentifier, spec.id);
    if (!cluster) return null;

    const normalized = clusterToNormalized(cluster, desired.protect);

    const identifiers: Record<string, string> = {
      clusterIdentifier: cluster.ClusterIdentifier ?? desired.clusterIdentifier,
    };
    const endpointStr = endpointOf(cluster);
    if (endpointStr) identifiers.endpoint = endpointStr;

    const connection: ConnectionTarget = {
      engine: "redshift",
      region: this.region,
      // exactOptionalPropertyTypes: include endpoint / credsRef only when present.
      ...(endpointStr ? { endpoint: endpointStr } : {}),
      ...(desired.masterUserPasswordRef !== undefined
        ? { credsRef: desired.masterUserPasswordRef }
        : {}),
    };

    return {
      id: spec.id,
      kind: "aws.redshift",
      identifiers,
      status: mapClusterStatus(cluster.ClusterStatus),
      connection,
      outputs: { ...normalized },
    };
  }

  /* ========================= destroy =========================== */

  async destroy(state: ResourceState): Promise<void> {
    const clusterId = readClusterIdentifierFromState(state);
    if (!clusterId) {
      throw new RedshiftProvisionerError(
        "cannot destroy: clusterIdentifier not found in state (identifiers.clusterIdentifier or outputs.clusterIdentifier)",
        state.id,
        "destroy",
      );
    }

    const protect =
      typeof state.outputs?.protect === "boolean" ? state.outputs.protect : false;
    if (protect && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(state.id, "destroy");
    }

    await this.deleteCluster(clusterId, state.id);
    await this.pollUntilDeleted(clusterId, state.id);
  }

  /* ===================== apply sub-flows ====================== */

  private async applyCreate(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    // Redshift CreateCluster accepts NO ClientRequestToken (unlike some AWS
    // control-plane ops). The framework's unified idempotency token (from
    // @scientia/core) is still computed by the orchestrator and recorded on the
    // step result, but it has no SDK field to map onto here. Instead, create
    // idempotency is guaranteed by treating ClusterAlreadyExistsFault as success
    // and polling to available — so a retry that hits a cluster already being
    // created never fails the apply.
    const masterPassword = this.resolveMasterPassword(
      desired.masterUserPasswordRef,
      spec.id,
    );
    const input = this.buildCreateInput(desired, spec.tags, masterPassword);

    try {
      await this.client.send(new CreateClusterCommand(input));
    } catch (e) {
      if (!(isAwsError(e) && e.name === "ClusterAlreadyExistsFault")) {
        throw wrapAwsError(e, spec.id, "create");
      }
    }

    await this.pollUntilAvailable(desired.clusterIdentifier, spec.id);

    const state = await this.read(spec);
    if (!state) {
      throw wrapAwsError(
        new Error("cluster not found immediately after create"),
        spec.id,
        "create",
      );
    }
    return state;
  }

  private async applyUpdate(
    spec: ResourceSpec,
    _from: ResourceState,
    changedFields: readonly string[],
  ): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    const clusterId = desired.clusterIdentifier;

    // A single ModifyCluster call carries every in-place-changeable field that
    // the plan flagged (Redshift applies resize + security-group changes in one
    // shot). `*` (stale state) forces all mutable fields.
    const wants = (field: string): boolean =>
      changedFields.includes(field) || changedFields.includes("*");

    const upd: ModifyClusterCommandInput = { ClusterIdentifier: clusterId };
    let touched = false;
    if (wants("nodeType")) {
      upd.NodeType = desired.nodeType;
      touched = true;
    }
    if (wants("clusterType")) {
      upd.ClusterType = desired.clusterType;
      touched = true;
    }
    if (wants("numberOfNodes")) {
      upd.NumberOfNodes = desired.numberOfNodes;
      touched = true;
    }
    if (wants("vpcSecurityGroupIds")) {
      upd.VpcSecurityGroupIds = [...desired.vpcSecurityGroupIds];
      touched = true;
    }
    if (wants("publiclyAccessible")) {
      upd.PubliclyAccessible = desired.publiclyAccessible;
      touched = true;
    }

    // protect is a framework flag — no ModifyCluster call; read() re-derives it
    // from desired when building the new outputs.
    if (touched) {
      await this.sendModify(upd, spec.id, "modify");
      await this.pollUntilAvailable(clusterId, spec.id);
    }

    const state = await this.read(spec);
    if (!state) {
      throw wrapAwsError(
        new Error("cluster not found after update"),
        spec.id,
        "update",
      );
    }
    return state;
  }

  private async applyReplace(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    if (desired.protect && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(spec.id, "replace");
    }

    const existing = await this.read(spec);
    if (existing) {
      await this.deleteCluster(desired.clusterIdentifier, spec.id);
      await this.pollUntilDeleted(desired.clusterIdentifier, spec.id);
    }
    return this.applyCreate(spec);
  }

  /* ====================== private helpers ===================== */

  private buildCreateInput(
    desired: NormalizedCluster,
    tags: Record<string, string> | undefined,
    masterPassword: string,
  ): CreateClusterCommandInput {
    const input: CreateClusterCommandInput = {
      ClusterIdentifier: desired.clusterIdentifier,
      NodeType: desired.nodeType,
      MasterUsername: desired.masterUsername,
      // Transient value — never persisted (not stored on `desired` or in outputs).
      MasterUserPassword: masterPassword,
      ClusterType: desired.clusterType,
      NumberOfNodes: desired.numberOfNodes,
      PubliclyAccessible: desired.publiclyAccessible,
      Encrypted: desired.encrypted,
    };
    if (desired.dbName !== undefined) input.DBName = desired.dbName;
    if (desired.vpcSecurityGroupIds.length > 0) {
      input.VpcSecurityGroupIds = [...desired.vpcSecurityGroupIds];
    }
    if (desired.clusterSubnetGroupName !== undefined) {
      input.ClusterSubnetGroupName = desired.clusterSubnetGroupName;
    }
    if (tags) input.Tags = toAwsTags(tags);
    return input;
  }

  private async sendModify(
    upd: ModifyClusterCommandInput,
    resourceId: string,
    action: string,
  ): Promise<void> {
    try {
      await this.client.send(new ModifyClusterCommand(upd));
    } catch (e) {
      throw wrapAwsError(e, resourceId, action);
    }
  }

  private async deleteCluster(
    clusterIdentifier: string,
    resourceId: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new DeleteClusterCommand({
          ClusterIdentifier: clusterIdentifier,
          SkipFinalClusterSnapshot: this.skipFinalSnapshot,
        }),
      );
    } catch (e) {
      // Idempotent destroy: already gone is success.
      if (isAwsError(e) && e.name === "ClusterNotFoundFault") return;
      throw wrapAwsError(e, resourceId, "delete");
    }
  }

  private async describeCluster(
    clusterIdentifier: string,
    resourceId: string,
  ): Promise<Cluster | null> {
    try {
      const out = await this.client.send(
        new DescribeClustersCommand({ ClusterIdentifier: clusterIdentifier }),
      );
      // DescribeClusters returns a Clusters[] even when filtered by identifier.
      return out.Clusters?.[0] ?? null;
    } catch (e) {
      if (isAwsError(e) && e.name === "ClusterNotFoundFault") return null;
      throw wrapAwsError(e, resourceId, "describe");
    }
  }

  /**
   * Resolve the master-password SecretRef to the transient value CreateCluster
   * requires. Supports env-var refs in v1; secretId resolution needs a Secrets
   * Manager client the provisioner does not own, so it fails fast. The value is
   * used for one SDK call and never stored/logged/echoed — only the env-var NAME
   * appears in any failure message.
   */
  private resolveMasterPassword(ref: SecretRef | undefined, resourceId: string): string {
    if (!ref) {
      throw new RedshiftProvisionerError(
        "masterUserPassword credsRef is required to create a cluster",
        resourceId,
        "create",
      );
    }
    if ("from" in ref) {
      const name = ref.from.slice("env:".length);
      const value = process.env[name];
      if (typeof value !== "string" || value.length === 0) {
        throw new RedshiftProvisionerError(
          `masterUserPassword references env var '${name}' which is not set; cannot create cluster`,
          resourceId,
          "create",
        );
      }
      return value;
    }
    // { secretId } — managed-secret resolution is a connector/orchestrator
    // concern in v1. Fail fast; never log/echo a value.
    throw new RedshiftProvisionerError(
      "masterUserPassword uses a secretId reference; the provisioner cannot resolve " +
        "managed secrets in v1. Use an env-var reference (from: 'env:VAR') so the " +
        "value is supplied via the ambient environment.",
      resourceId,
      "create",
    );
  }

  private async pollUntilAvailable(
    clusterIdentifier: string,
    resourceId: string,
  ): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        const c = await this.describeCluster(clusterIdentifier, resourceId);
        if (!c) {
          lastStatus = "NOT_FOUND";
          return false;
        }
        lastStatus = c.ClusterStatus;
        return c.ClusterStatus === "available";
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new RedshiftProvisionerError(
          `cluster '${clusterIdentifier}' did not become available (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForAvailable",
          e,
          "Inspect the cluster in the AWS console; re-run apply to resume polling.",
        );
      }
      throw e;
    }
  }

  private async pollUntilDeleted(
    clusterIdentifier: string,
    resourceId: string,
  ): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        const c = await this.describeCluster(clusterIdentifier, resourceId);
        if (!c) return true; // gone
        lastStatus = c.ClusterStatus;
        return false; // still exists
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new RedshiftProvisionerError(
          `cluster '${clusterIdentifier}' did not finish deleting (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForDeleted",
          e,
        );
      }
      throw e;
    }
  }
}

/* -------------------------- module helpers ------------------------ */

/** Build a `host:port` endpoint string from a live Cluster, or "" if absent. */
function endpointOf(cluster: Cluster): string {
  const addr = cluster.Endpoint?.Address;
  if (typeof addr !== "string" || addr.length === 0) return "";
  const port = cluster.Endpoint?.Port ?? 5439;
  return `${addr}:${port}`;
}

function readClusterIdentifierFromState(state: ResourceState): string | undefined {
  const fromIdentifiers = state.identifiers.clusterIdentifier;
  if (typeof fromIdentifiers === "string" && fromIdentifiers.length > 0) {
    return fromIdentifiers;
  }
  const fromOutputs = state.outputs?.clusterIdentifier;
  return typeof fromOutputs === "string" && fromOutputs.length > 0
    ? fromOutputs
    : undefined;
}
