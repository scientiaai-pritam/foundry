/**
 * AWS RDS Postgres provisioner — implements the scientia `Provisioner` contract
 * for `kind: "aws.rds-postgres"` using AWS SDK v3's RDSClient.
 *
 * Lifecycle mapping (design v1, §5/§7):
 *   - plan    → diff desired vs current (update vs replace vs noop)
 *   - apply   → create (CreateDBInstance, poll DBInstanceStatus→available),
 *               in-place update (ModifyDBInstance with ApplyImmediately),
 *               replace (delete + create), honoring deletionProtection
 *   - read    → DescribeDBInstances for drift detection
 *   - destroy → DeleteDBInstance with a unique FinalDBSnapshotIdentifier (design
 *               §7: final snapshot DEFAULT-ON for stateful engines; skipFinalSnapshot
 *               opts out), honoring deletionProtection. A `replace` skips the
 *               snapshot (recreation, not terminal destroy).
 *
 * SECURITY (design v1, §6/§9):
 *   - Authenticates to the RDS API via the AMBIENT cloud credential chain (the
 *     injected RDSClient). A database's master password is a SEPARATE secret,
 *     referenced BY a credsRef (SecretRef) and resolved by the connector at
 *     runtime — never by this provisioner.
 *   - CreateDBInstance is sent `ManageMasterUserPassword:true` so RDS itself
 *     generates and manages the master password in Secrets Manager. The
 *     provisioner NEVER reads, stores, or logs the password value. The credsRef
 *     is only surfaced on the emitted ConnectionTarget.
 *
 * CreateDBInstance accepts NO client idempotency token (the RDS API has no
 * ClientToken field — unlike e.g. some other AWS actions). The framework's
 * unified idempotency token (from @scientia/core) is still computed by the
 * orchestrator and recorded on the step result, but it has no SDK field to map
 * onto here. Create idempotency is instead guaranteed by treating
 * DBInstanceAlreadyExists as success and polling to "available" — mirroring the
 * DynamoDB provisioner's ResourceInUseException handling.
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
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  ModifyDBInstanceCommand,
} from "@aws-sdk/client-rds";
import type {
  CreateDBInstanceCommandInput,
  DBInstance,
  DeleteDBInstanceCommandInput,
  ModifyDBInstanceCommandInput,
  RDSClient,
} from "@aws-sdk/client-rds";

import {
  AwsRdsPostgresProvisionerError,
  ProtectedResourceError,
  isAwsError,
  wrapAwsError,
} from "./errors.js";
import { extractCredsRef, outputsToNormalized, parseSpecProps } from "./parse.js";
import { diffInstance } from "./diff.js";
import { dbInstanceToNormalized, mapDbInstanceStatus, toAwsTags, toAwsVpcSecurityGroupIds } from "./convert.js";
import type { AwsRdsPostgresProvisionerOptions, NormalizedInstance } from "./types.js";

export class AwsRdsPostgresProvisioner implements Provisioner {
  readonly kind: ResourceKind = "aws.rds-postgres";

  private readonly client: RDSClient;
  private readonly region: string;
  private readonly credsRef: SecretRef | undefined;
  private readonly allowProtectedDestroy: boolean;
  private readonly skipFinalSnapshot: boolean;
  private readonly finalSnapshotSuffix: () => string;
  private readonly waitForOpts: WaitForOptions;

  constructor(opts: AwsRdsPostgresProvisionerOptions) {
    this.client = opts.client;
    this.region = opts.region;
    this.credsRef = opts.credsRef;
    this.allowProtectedDestroy = opts.allowProtectedDestroy ?? false;
    // Design §7 (line 294): final snapshot is DEFAULT-ON for stateful engines.
    // skipFinalSnapshot is an explicit OPT-OUT (maps to the SDK's
    // SkipFinalSnapshot). When a snapshot is requested, DeleteDBInstance is sent
    // a unique FinalDBSnapshotIdentifier instead (see buildFinalSnapshotIdentifier).
    this.skipFinalSnapshot = opts.skipFinalSnapshot ?? false;
    this.finalSnapshotSuffix = opts.finalSnapshotSuffix ?? defaultFinalSnapshotSuffix;
    // RDS creates realistically take 5–15 min (design v1 §8); default to a 15 min
    // ceiling. Tests override with a fast WaitForOptions.
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
      // State predates normalized outputs (or was hand-edited). Don't guess;
      // propose a full in-place reconciliation and let apply re-read live.
      return {
        op: "update",
        spec: desired,
        from: current,
        changedFields: ["*"],
      };
    }

    const d = diffInstance(desiredN, currentN);
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
        reason: `db instance '${desiredN.dbInstanceIdentifier}' matches desired state`,
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
        throw new AwsRdsPostgresProvisionerError(
          `apply() does not handle op "${action.op}" (delete uses destroy(); noop is skipped by the orchestrator)`,
          action.op === "delete" ? action.state.id : action.id,
          action.op,
        );
      default: {
        const _exhaustive: never = action;
        throw new AwsRdsPostgresProvisionerError(
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

    const inst = await this.describeInstance(desired.dbInstanceIdentifier, spec.id);
    if (!inst) return null;

    const normalized = dbInstanceToNormalized(inst);

    const identifiers: Record<string, string> = {
      dbInstanceId: inst.DBInstanceIdentifier ?? desired.dbInstanceIdentifier,
    };
    if (inst.DBInstanceArn) identifiers.arn = inst.DBInstanceArn;

    const connection = this.buildConnection(inst, spec);

    return {
      id: spec.id,
      kind: "aws.rds-postgres",
      identifiers,
      status: mapDbInstanceStatus(inst.DBInstanceStatus),
      connection,
      outputs: { ...normalized },
    };
  }

  /* ========================= destroy =========================== */

  async destroy(state: ResourceState): Promise<void> {
    const identifier = readIdentifierFromState(state);
    if (!identifier) {
      throw new AwsRdsPostgresProvisionerError(
        "cannot destroy: dbInstanceIdentifier not found in state (identifiers.dbInstanceId or outputs.dbInstanceIdentifier)",
        state.id,
        "destroy",
      );
    }

    // Framework guard keyed on RDS-native deletionProtection (design v1 §9).
    const protect =
      typeof state.outputs?.deletionProtection === "boolean"
        ? state.outputs.deletionProtection
        : false;
    if (protect && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(state.id, "destroy");
    }

    await this.deleteDbInstance(identifier, state.id, {
      finalSnapshot: !this.skipFinalSnapshot,
    });
    await this.pollUntilDeleted(identifier, state.id);
  }

  /* ===================== apply sub-flows ====================== */

  private async applyCreate(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    // CreateDBInstance accepts NO ClientToken (verified against the RDS API).
    // The framework's unified idempotency token is still computed by the
    // orchestrator and recorded on the step result, but it has no SDK field to
    // map onto here. Create idempotency is instead guaranteed by treating
    // DBInstanceAlreadyExists as success and polling to "available".
    const input = this.buildCreateInput(desired, spec.tags);

    try {
      await this.client.send(new CreateDBInstanceCommand(input));
    } catch (e) {
      if (!(isAwsError(e) && e.name === "DBInstanceAlreadyExists")) {
        throw wrapAwsError(e, spec.id, "create");
      }
    }

    await this.pollUntilAvailable(desired.dbInstanceIdentifier, spec.id);

    const state = await this.read(spec);
    if (!state) {
      throw wrapAwsError(
        new Error("db instance not found immediately after create"),
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
    const identifier = desired.dbInstanceIdentifier;

    const cloudMutable = changedFields.includes("*")
      ? true
      : changedFields.some((f) =>
          [
            "dbInstanceClass",
            "allocatedStorage",
            "backupRetentionPeriod",
            "multiAz",
            "deletionProtection",
            "publiclyAccessible",
            "dbSubnetGroupName",
            "vpcSecurityGroupIds",
          ].includes(f),
        );

    if (cloudMutable) {
      const input = this.buildModifyInput(identifier, desired, changedFields);
      await this.sendModify(input, spec.id, "modify");
      await this.pollUntilAvailable(identifier, spec.id);
    }

    const state = await this.read(spec);
    if (!state) {
      throw wrapAwsError(
        new Error("db instance not found after update"),
        spec.id,
        "update",
      );
    }
    return state;
  }

  private async applyReplace(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    if (desired.deletionProtection && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(spec.id, "replace");
    }

    const existing = await this.read(spec);
    if (existing) {
      // replace skips the final snapshot: it is a recreation of a tracked
      // resource, not a terminal destroy (design §7 ties snapshots to `destroy`).
      await this.deleteDbInstance(desired.dbInstanceIdentifier, spec.id, {
        finalSnapshot: false,
      });
      await this.pollUntilDeleted(desired.dbInstanceIdentifier, spec.id);
    }
    return this.applyCreate(spec);
  }

  /* ====================== private helpers ===================== */

  private buildCreateInput(
    desired: NormalizedInstance,
    tags: Record<string, string> | undefined,
  ): CreateDBInstanceCommandInput {
    const input: CreateDBInstanceCommandInput = {
      DBInstanceIdentifier: desired.dbInstanceIdentifier,
      DBInstanceClass: desired.dbInstanceClass,
      Engine: "postgres",
      AllocatedStorage: desired.allocatedStorage,
      MasterUsername: desired.masterUsername,
      // SECURITY: never supply MasterUserPassword (we never hold the value).
      // ManageMasterUserPassword makes RDS generate & manage the master password
      // in Secrets Manager. The credsRef is surfaced separately on the
      // ConnectionTarget for the connector to resolve at runtime.
      ManageMasterUserPassword: true,
      BackupRetentionPeriod: desired.backupRetentionPeriod,
      MultiAZ: desired.multiAz,
      StorageEncrypted: desired.storageEncrypted,
      DeletionProtection: desired.deletionProtection,
      PubliclyAccessible: desired.publiclyAccessible,
    };
    const sgIds = toAwsVpcSecurityGroupIds(desired.vpcSecurityGroupIds);
    if (sgIds) input.VpcSecurityGroupIds = sgIds;
    if (desired.dbSubnetGroupName) input.DBSubnetGroupName = desired.dbSubnetGroupName;
    if (desired.dbName) input.DBName = desired.dbName;
    if (tags) input.Tags = toAwsTags(tags);
    return input;
  }

  private buildModifyInput(
    identifier: string,
    desired: NormalizedInstance,
    changedFields: readonly string[],
  ): ModifyDBInstanceCommandInput {
    const all = changedFields.includes("*");
    const want = (field: string): boolean => all || changedFields.includes(field);

    const input: ModifyDBInstanceCommandInput = {
      DBInstanceIdentifier: identifier,
      // Apply synchronously rather than deferring to the maintenance window, so
      // the declarative apply model observes the change this run.
      ApplyImmediately: true,
    };
    if (want("dbInstanceClass")) input.DBInstanceClass = desired.dbInstanceClass;
    if (want("allocatedStorage")) input.AllocatedStorage = desired.allocatedStorage;
    if (want("backupRetentionPeriod"))
      input.BackupRetentionPeriod = desired.backupRetentionPeriod;
    if (want("multiAz")) input.MultiAZ = desired.multiAz;
    if (want("deletionProtection")) input.DeletionProtection = desired.deletionProtection;
    if (want("publiclyAccessible")) input.PubliclyAccessible = desired.publiclyAccessible;
    if (want("dbSubnetGroupName") && desired.dbSubnetGroupName) {
      input.DBSubnetGroupName = desired.dbSubnetGroupName;
    }
    if (want("vpcSecurityGroupIds")) {
      const sgIds = toAwsVpcSecurityGroupIds(desired.vpcSecurityGroupIds);
      if (sgIds) input.VpcSecurityGroupIds = sgIds;
    }
    return input;
  }

  private buildConnection(
    inst: DBInstance,
    spec: ResourceSpec,
  ): ConnectionTarget {
    const connection: ConnectionTarget = {
      engine: "postgres",
      region: this.region,
    };
    const addr = inst.Endpoint?.Address;
    if (typeof addr === "string" && addr.length > 0) {
      const port = inst.Endpoint?.Port ?? 5432;
      connection.endpoint = `${addr}:${port}`;
    }
    // credsRef: prefer the spec's by-reference master-password secret, else the
    // provisioner-option fallback. Passed through, never resolved.
    const ref = this.resolveCredsRef(spec);
    if (ref) connection.credsRef = ref;
    return connection;
  }

  private resolveCredsRef(spec: ResourceSpec): SecretRef | undefined {
    const fromSpec = extractCredsRef(spec.props);
    if (fromSpec) return fromSpec;
    return this.credsRef;
  }

  private async describeInstance(
    identifier: string,
    resourceId: string,
  ): Promise<DBInstance | null> {
    try {
      const out = await this.client.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
      );
      // DescribeDBInstancesCommandOutput.DBInstances is an array (possibly empty).
      const list = out.DBInstances ?? [];
      return list.length > 0 ? (list[0] ?? null) : null;
    } catch (e) {
      if (isAwsError(e) && e.name === "DBInstanceNotFound") return null;
      throw wrapAwsError(e, resourceId, "describe");
    }
  }

  private async sendModify(
    input: ModifyDBInstanceCommandInput,
    resourceId: string,
    action: string,
  ): Promise<void> {
    try {
      await this.client.send(new ModifyDBInstanceCommand(input));
    } catch (e) {
      throw wrapAwsError(e, resourceId, action);
    }
  }

  /**
   * Delete a DB instance. First disables cloud-level DeletionProtection if it is
   * set on the live instance (RDS rejects DeleteDBInstance while protection is
   * on). Idempotent: DBInstanceNotFound at any step is success.
   *
   * Design §7: when `options.finalSnapshot` is true (the default on destroy), a
   * unique FinalDBSnapshotIdentifier is sent and SkipFinalSnapshot is OMITTED
   * (the RDS API treats them as mutually exclusive — SkipFinalSnapshot defaults
   * to false). When false (opt-out, or a replace), SkipFinalSnapshot:true is sent.
   */
  private async deleteDbInstance(
    identifier: string,
    resourceId: string,
    options: { finalSnapshot: boolean },
  ): Promise<void> {
    const live = await this.describeInstance(identifier, resourceId);
    if (!live) return; // already gone — idempotent destroy

    if (live.DeletionProtection === true) {
      await this.sendModify(
        {
          DBInstanceIdentifier: identifier,
          DeletionProtection: false,
          ApplyImmediately: true,
        },
        resourceId,
        "disableDeletionProtection",
      );
    }

    const input: DeleteDBInstanceCommandInput = options.finalSnapshot
      ? {
          DBInstanceIdentifier: identifier,
          FinalDBSnapshotIdentifier:
            this.buildFinalSnapshotIdentifier(identifier),
        }
      : {
          DBInstanceIdentifier: identifier,
          SkipFinalSnapshot: true,
        };
    try {
      await this.client.send(new DeleteDBInstanceCommand(input));
    } catch (e) {
      if (isAwsError(e) && e.name === "DBInstanceNotFound") return;
      throw wrapAwsError(e, resourceId, "delete");
    }
  }

  /**
   * Build a per-destroy-unique `FinalDBSnapshotIdentifier`. AWS requires
   * uniqueness; the `scientia-` prefix brands the framework-owned snapshot and
   * the suffix (default Date.now-based, injectable via the constructor) makes it
   * unique across destroys of the same instance.
   */
  private buildFinalSnapshotIdentifier(identifier: string): string {
    return `scientia-${identifier}-final-${this.finalSnapshotSuffix()}`;
  }

  private async pollUntilAvailable(
    identifier: string,
    resourceId: string,
  ): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        try {
          const out = await this.client.send(
            new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
          );
          const inst = (out.DBInstances ?? [])[0];
          lastStatus = inst?.DBInstanceStatus;
          return inst?.DBInstanceStatus === "available";
        } catch (e) {
          // During create, the instance may briefly be not-yet-visible.
          if (isAwsError(e) && e.name === "DBInstanceNotFound") {
            lastStatus = "NOT_FOUND";
            return false;
          }
          throw wrapAwsError(e, resourceId, "describe");
        }
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new AwsRdsPostgresProvisionerError(
          `db instance '${identifier}' did not become available (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForAvailable",
          e,
          "Inspect the instance in the AWS console; re-run apply to resume polling.",
        );
      }
      throw e;
    }
  }

  private async pollUntilDeleted(
    identifier: string,
    resourceId: string,
  ): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        try {
          const out = await this.client.send(
            new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
          );
          const inst = (out.DBInstances ?? [])[0];
          lastStatus = inst?.DBInstanceStatus;
          return false; // still exists
        } catch (e) {
          if (isAwsError(e) && e.name === "DBInstanceNotFound") return true;
          throw wrapAwsError(e, resourceId, "describe");
        }
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new AwsRdsPostgresProvisionerError(
          `db instance '${identifier}' did not finish deleting (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForDeleted",
          e,
        );
      }
      throw e;
    }
  }
}

/** Default uniqueness suffix for a final-snapshot identifier (design §7). */
const defaultFinalSnapshotSuffix = (): string => Date.now().toString(36);

function readIdentifierFromState(state: ResourceState): string | undefined {
  const fromIdentifiers = state.identifiers.dbInstanceId;
  if (typeof fromIdentifiers === "string" && fromIdentifiers.length > 0) {
    return fromIdentifiers;
  }
  const fromOutputs = state.outputs?.dbInstanceIdentifier;
  return typeof fromOutputs === "string" && fromOutputs.length > 0
    ? fromOutputs
    : undefined;
}
