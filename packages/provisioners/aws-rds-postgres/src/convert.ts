/**
 * Conversion between foundry's camelCase instance model and AWS SDK v3's
 * PascalCase shapes, plus mapping a live `DBInstance` back to a
 * {@link NormalizedInstance} for drift detection.
 *
 * Mirrors @foundry/aws-dynamodb/convert.ts.
 */
import type { DBInstance } from "@aws-sdk/client-rds";
import type { ResourceState } from "@foundry/core";
import type { NormalizedInstance } from "./types.js";

/* --------------------------- to AWS ------------------------------ */

/** Convert foundry tags (Record) to the RDS `Tag[]` shape. */
export function toAwsTags(tags: Record<string, string>): { Key: string; Value: string }[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/** Stringify a VPC SG list only when non-empty (exactOptionalPropertyTypes-safe). */
export function toAwsVpcSecurityGroupIds(
  ids: readonly string[],
): string[] | undefined {
  return ids.length > 0 ? [...ids] : undefined;
}

/* -------------------------- from AWS ----------------------------- */

/**
 * Build a NormalizedInstance from a live `DBInstance` (DescribeDBInstances item).
 * `deletionProtection` is read straight off the cloud object — for RDS it is the
 * native attribute AND the framework protect signal (design v1 §9), so unlike
 * DynamoDB's protect it needs no separate parameter here.
 */
export function dbInstanceToNormalized(inst: DBInstance): NormalizedInstance {
  const out: NormalizedInstance = {
    dbInstanceIdentifier: inst.DBInstanceIdentifier ?? "",
    dbInstanceClass: inst.DBInstanceClass ?? "",
    allocatedStorage: inst.AllocatedStorage ?? 0,
    masterUsername: inst.MasterUsername ?? "",
    // VpcSecurityGroups[].VpcSecurityGroupId is optional under noUncheckedIndexedAccess.
    vpcSecurityGroupIds: (inst.VpcSecurityGroups ?? [])
      .map((g) => g.VpcSecurityGroupId)
      .filter((s): s is string => typeof s === "string" && s.length > 0),
    backupRetentionPeriod: inst.BackupRetentionPeriod ?? 0,
    multiAz: inst.MultiAZ ?? false,
    storageEncrypted: inst.StorageEncrypted ?? false,
    deletionProtection: inst.DeletionProtection ?? false,
    publiclyAccessible: inst.PubliclyAccessible ?? false,
  };
  if (typeof inst.DBName === "string" && inst.DBName.length > 0) {
    out.dbName = inst.DBName;
  }
  const sgName = inst.DBSubnetGroup?.DBSubnetGroupName;
  if (typeof sgName === "string" && sgName.length > 0) {
    out.dbSubnetGroupName = sgName;
  }
  return out;
}

/**
 * Map an RDS `DBInstanceStatus` string to the foundry lifecycle status.
 * Conservative default: an unrecognized/failed state maps to "error" (same
 * posture as DynamoDB's mapTableStatus), so drift detection flags it.
 */
export function mapDbInstanceStatus(
  s: string | undefined,
): ResourceState["status"] {
  switch (s) {
    case "creating":
      return "creating";
    case "available":
      return "available";
    case "deleting":
      return "deleting";
    case "modifying":
    case "upgrading":
    case "rebooting":
    case "resetting-master-credentials":
    case "configuring-log-exports":
    case "configuring-iam-database-authentication":
    case "configuring-enhanced-monitoring":
    case "maintenance":
    case "backing-up":
    case "storage-optimization":
    case "renaming":
      return "updating";
    default:
      // storage-full | restore-error | incompatible-* |
      // inaccessible-encryption-credentials | stopped | unknown
      return "error";
  }
}
