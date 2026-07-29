/**
 * DynamoDB provisioner — implements the scientia `Provisioner` contract for
 * `kind: "aws.dynamodb"` using AWS SDK v3's DynamoDBClient.
 *
 * Lifecycle mapping (design v1, §5/§7):
 *   - plan    → diff desired vs current (update vs replace vs noop)
 *   - apply   → create (poll TableStatus→ACTIVE, enable PITR), in-place update
 *               (billingMode, add/remove GSIs, PITR), replace (delete + create),
 *               with a ClientRequestToken derived from the resource id.
 *   - read    → DescribeTable (+ DescribeContinuousBackups) for drift detection
 *   - destroy → DeleteTable, honoring a `protect` flag
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
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  CreateTableCommandInput,
  DynamoDBClient,
  UpdateTableCommandInput,
} from "@aws-sdk/client-dynamodb";

import {
  DynamoDBProvisionerError,
  ProtectedResourceError,
  isAwsError,
  wrapAwsError,
} from "./errors.js";
import { outputsToNormalized, parseSpecProps } from "./parse.js";
import { diffTable, computeGsiChanges, gsiKeyAttributes } from "./diff.js";
import {
  mapTableStatus,
  tableDescriptionToNormalized,
  toAwsAttributeDefinitions,
  toAwsGSIs,
  toAwsGSI,
  toAwsKeySchema,
  toAwsProvisionedThroughput,
  toAwsTags,
} from "./convert.js";
import type {
  DynamoDBProvisionerOptions,
  NormalizedTable,
} from "./types.js";

export class DynamoDBProvisioner implements Provisioner {
  readonly kind: ResourceKind = "aws.dynamodb";

  private readonly client: DynamoDBClient;
  private readonly region: string;
  private readonly credsRef: SecretRef | undefined;
  private readonly allowProtectedDestroy: boolean;
  private readonly waitForOpts: WaitForOptions;

  constructor(opts: DynamoDBProvisionerOptions) {
    this.client = opts.client;
    this.region = opts.region;
    this.credsRef = opts.credsRef;
    this.allowProtectedDestroy = opts.allowProtectedDestroy ?? false;
    // Core's WaitForOptions requires timeoutMs; default to 5 min (RDS-ish
    // headroom, DynamoDB returns in seconds but this is a safe ceiling).
    this.waitForOpts = opts.waitFor ?? { timeoutMs: 300_000 };
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

    const d = diffTable(desiredN, currentN);
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
        reason: `table '${desiredN.tableName}' matches desired state`,
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
        throw new DynamoDBProvisionerError(
          `apply() does not handle op "${action.op}" (delete uses destroy(); noop is skipped by the orchestrator)`,
          action.op === "delete" ? action.state.id : action.id,
          action.op,
        );
      default: {
        const _exhaustive: never = action;
        throw new DynamoDBProvisionerError(
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

    let desc;
    try {
      const out = await this.client.send(
        new DescribeTableCommand({ TableName: desired.tableName }),
      );
      desc = out.Table ?? null;
    } catch (e) {
      if (isAwsError(e) && e.name === "ResourceNotFoundException") return null;
      throw wrapAwsError(e, spec.id, "read");
    }
    if (!desc) return null;

    const pitr = await this.readPitr(desired.tableName);
    const normalized = tableDescriptionToNormalized(desc, pitr, desired.protect);

    const identifiers: Record<string, string> = {
      tableName: desc.TableName ?? desired.tableName,
    };
    if (desc.TableArn) identifiers.tableArn = desc.TableArn;

    const connection: ConnectionTarget = {
      engine: "dynamodb",
      region: this.region,
      // exactOptionalPropertyTypes: include credsRef only when present (DynamoDB
      // typically has no DB-level creds → ambient chain, credsRef omitted).
      ...(this.credsRef !== undefined ? { credsRef: this.credsRef } : {}),
    };

    return {
      id: spec.id,
      kind: "aws.dynamodb",
      identifiers,
      status: mapTableStatus(desc.TableStatus),
      connection,
      outputs: { ...normalized },
    };
  }

  /* ========================= destroy =========================== */

  async destroy(state: ResourceState): Promise<void> {
    const tableName = readTableNameFromState(state);
    if (!tableName) {
      throw new DynamoDBProvisionerError(
        "cannot destroy: tableName not found in state (identifiers.tableName or outputs.tableName)",
        state.id,
        "destroy",
      );
    }

    const protect =
      typeof state.outputs?.protect === "boolean" ? state.outputs.protect : false;
    if (protect && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(state.id, "destroy");
    }

    await this.deleteTable(tableName, state.id);
    await this.pollUntilDeleted(tableName, state.id);
  }

  /* ===================== apply sub-flows ====================== */

  private async applyCreate(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    // DynamoDB CreateTable accepts NO client request token (unlike e.g. RDS).
    // The framework's unified idempotency token (from @scientia/core) is still
    // computed by the orchestrator and recorded on the step result, but it has
    // no SDK field to map onto here. Instead, create idempotency is guaranteed
    // by treating ResourceInUseException as success and polling to ACTIVE — so a
    // retry that hits a table already being created never fails the apply.
    const input = this.buildCreateInput(desired, spec.tags);

    try {
      await this.client.send(new CreateTableCommand(input));
    } catch (e) {
      if (!(isAwsError(e) && e.name === "ResourceInUseException")) {
        throw wrapAwsError(e, spec.id, "create");
      }
    }

    await this.pollUntilActive(desired.tableName, spec.id);

    if (desired.pointInTimeRecovery) {
      await this.ensurePitr(desired.tableName, true, spec.id);
    }

    const state = await this.read(spec);
    if (!state) {
      throw wrapAwsError(
        new Error("table not found immediately after create"),
        spec.id,
        "create",
      );
    }
    return state;
  }

  private async applyUpdate(
    spec: ResourceSpec,
    from: ResourceState,
    changedFields: readonly string[],
  ): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    const table = desired.tableName;

    const currentN = await this.resolveCurrent(spec, from);

    if (
      changedFields.includes("billingMode") ||
      changedFields.includes("provisionedThroughput") ||
      changedFields.includes("*")
    ) {
      const upd: UpdateTableCommandInput = {
        TableName: table,
        BillingMode: desired.billingMode,
      };
      if (desired.billingMode === "PROVISIONED" && desired.provisionedThroughput) {
        upd.ProvisionedThroughput = toAwsProvisionedThroughput(desired.provisionedThroughput);
      }
      await this.sendUpdate(upd, spec.id, "updateBillingMode");
      await this.pollUntilActive(table, spec.id);
    }

    if (
      changedFields.includes("globalSecondaryIndexes") ||
      changedFields.includes("attributeDefinitions") ||
      changedFields.includes("*")
    ) {
      await this.applyGsiChanges(table, desired, currentN, spec.id);
    }

    if (changedFields.includes("pointInTimeRecovery") || changedFields.includes("*")) {
      await this.ensurePitr(table, desired.pointInTimeRecovery, spec.id);
    }

    const state = await this.read(spec);
    if (!state) {
      throw wrapAwsError(
        new Error("table not found after update"),
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
      await this.deleteTable(desired.tableName, spec.id);
      await this.pollUntilDeleted(desired.tableName, spec.id);
    }
    return this.applyCreate(spec);
  }

  private async applyGsiChanges(
    table: string,
    desired: NormalizedTable,
    current: NormalizedTable,
    resourceId: string,
  ): Promise<void> {
    const { toAdd, toRemove } = computeGsiChanges(
      desired.globalSecondaryIndexes,
      current.globalSecondaryIndexes,
    );

    // Create first, delete second — keeps at least the old index serving while a
    // new one builds. AWS allows one create + one delete per UpdateTable call;
    // we issue them sequentially and poll to ACTIVE between each.
    for (const g of toAdd) {
      const attrs = toAwsAttributeDefinitions(gsiKeyAttributes(g, desired.attributeDefinitions));
      const upd: UpdateTableCommandInput = {
        TableName: table,
        GlobalSecondaryIndexUpdates: [{ Create: toAwsGSI(g) }],
      };
      if (attrs.length > 0) upd.AttributeDefinitions = attrs;
      await this.sendUpdate(upd, resourceId, `addGSI:${g.indexName}`);
      await this.pollUntilActive(table, resourceId);
    }
    for (const name of toRemove) {
      const upd: UpdateTableCommandInput = {
        TableName: table,
        GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }],
      };
      await this.sendUpdate(upd, resourceId, `removeGSI:${name}`);
      await this.pollUntilActive(table, resourceId);
    }
  }

  /* ====================== private helpers ===================== */

  private buildCreateInput(
    desired: NormalizedTable,
    tags: Record<string, string> | undefined,
  ): CreateTableCommandInput {
    const input: CreateTableCommandInput = {
      TableName: desired.tableName,
      AttributeDefinitions: toAwsAttributeDefinitions(desired.attributeDefinitions),
      KeySchema: toAwsKeySchema(desired.keySchema),
      BillingMode: desired.billingMode,
    };
    if (desired.globalSecondaryIndexes.length > 0) {
      input.GlobalSecondaryIndexes = toAwsGSIs(desired.globalSecondaryIndexes);
    }
    if (desired.billingMode === "PROVISIONED" && desired.provisionedThroughput) {
      input.ProvisionedThroughput = toAwsProvisionedThroughput(desired.provisionedThroughput);
    }
    if (tags) input.Tags = toAwsTags(tags);
    return input;
  }

  private async resolveCurrent(
    spec: ResourceSpec,
    from: ResourceState,
  ): Promise<NormalizedTable> {
    const fromOutputs = outputsToNormalized(from.outputs);
    if (fromOutputs) return fromOutputs;
    // Outputs absent/stale — re-read live so GSI diff reflects reality.
    const live = await this.read(spec);
    const liveOutputs = live ? outputsToNormalized(live.outputs) : null;
    if (!liveOutputs) {
      throw wrapAwsError(
        new Error("could not determine current table shape for update"),
        spec.id,
        "update",
      );
    }
    return liveOutputs;
  }

  private async sendUpdate(
    upd: UpdateTableCommandInput,
    resourceId: string,
    action: string,
  ): Promise<void> {
    try {
      await this.client.send(new UpdateTableCommand(upd));
    } catch (e) {
      throw wrapAwsError(e, resourceId, action);
    }
  }

  private async deleteTable(tableName: string, resourceId: string): Promise<void> {
    try {
      await this.client.send(new DeleteTableCommand({ TableName: tableName }));
    } catch (e) {
      // Idempotent destroy: already gone is success.
      if (isAwsError(e) && e.name === "ResourceNotFoundException") return;
      throw wrapAwsError(e, resourceId, "delete");
    }
  }

  private async ensurePitr(
    tableName: string,
    enabled: boolean,
    resourceId: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new UpdateContinuousBackupsCommand({
          TableName: tableName,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: enabled },
        }),
      );
    } catch (e) {
      throw wrapAwsError(e, resourceId, enabled ? "enablePointInTimeRecovery" : "disablePointInTimeRecovery");
    }
  }

  private async readPitr(tableName: string): Promise<boolean | null> {
    try {
      const out = await this.client.send(
        new DescribeContinuousBackupsCommand({ TableName: tableName }),
      );
      const status =
        out.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          ?.PointInTimeRecoveryStatus;
      return status === "ENABLED";
    } catch {
      // PITR read failure must not break drift detection of the table itself.
      return null;
    }
  }

  private async pollUntilActive(tableName: string, resourceId: string): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        try {
          const out = await this.client.send(
            new DescribeTableCommand({ TableName: tableName }),
          );
          lastStatus = out.Table?.TableStatus;
          return out.Table?.TableStatus === "ACTIVE";
        } catch (e) {
          // During create, the table may briefly be not-yet-visible.
          if (isAwsError(e) && e.name === "ResourceNotFoundException") {
            lastStatus = "NOT_FOUND";
            return false;
          }
          throw wrapAwsError(e, resourceId, "describe");
        }
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new DynamoDBProvisionerError(
          `table '${tableName}' did not become ACTIVE (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForActive",
          e,
          "Inspect the table in the AWS console; re-run apply to resume polling.",
        );
      }
      throw e;
    }
  }

  private async pollUntilDeleted(tableName: string, resourceId: string): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        try {
          const out = await this.client.send(
            new DescribeTableCommand({ TableName: tableName }),
          );
          lastStatus = out.Table?.TableStatus;
          return false; // still exists
        } catch (e) {
          if (isAwsError(e) && e.name === "ResourceNotFoundException") return true;
          throw wrapAwsError(e, resourceId, "describe");
        }
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new DynamoDBProvisionerError(
          `table '${tableName}' did not finish deleting (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForDeleted",
          e,
        );
      }
      throw e;
    }
  }
}

function readTableNameFromState(state: ResourceState): string | undefined {
  const fromIdentifiers = state.identifiers.tableName;
  if (typeof fromIdentifiers === "string" && fromIdentifiers.length > 0) return fromIdentifiers;
  const fromOutputs = state.outputs?.tableName;
  return typeof fromOutputs === "string" && fromOutputs.length > 0 ? fromOutputs : undefined;
}
