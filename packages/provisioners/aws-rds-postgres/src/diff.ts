/**
 * Diff a desired {@link NormalizedInstance} against the current one and classify
 * each change as in-place update vs. requires-replace. Mirrors
 * @scientia/aws-dynamodb/diff.ts.
 *
 * RDS mutability (verified against the ModifyDBInstance API):
 *   in-place  → dbInstanceClass, allocatedStorage, backupRetentionPeriod,
 *               multiAz, deletionProtection, publiclyAccessible,
 *               vpcSecurityGroupIds, dbSubnetGroupName
 *   replace   → dbInstanceIdentifier (identity), masterUsername (immutable),
 *               dbName (immutable after create), storageEncrypted (immutable)
 *
 * `engine` (constant "postgres") and the by-reference master-password SecretRef
 * are intentionally not in NormalizedInstance, so they never trigger drift here.
 */
import type { NormalizedInstance } from "./types.js";

export interface DiffResult {
  requiresReplace: boolean;
  replaceReason?: string;
  changedFields: string[];
}

/* --------------------- structural equality ----------------------- */

/** Order-insensitive set equality for VPC security-group lists. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  for (const id of a) if (!sb.has(id)) return false;
  return true;
}

/* ----------------------------- diff ------------------------------ */

/** The mutable (in-place ModifyDBInstance) field names. */
const MUTABLE_FIELDS = [
  "dbInstanceClass",
  "allocatedStorage",
  "backupRetentionPeriod",
  "multiAz",
  "deletionProtection",
  "publiclyAccessible",
  "dbSubnetGroupName",
] as const;

export function diffInstance(
  desired: NormalizedInstance,
  current: NormalizedInstance,
): DiffResult {
  // Identity / immutable replacements take precedence.
  if (desired.dbInstanceIdentifier !== current.dbInstanceIdentifier) {
    return {
      requiresReplace: true,
      replaceReason:
        "dbInstanceIdentifier cannot be changed in place (RDS identity; recreate required)",
      changedFields: ["dbInstanceIdentifier"],
    };
  }
  if (desired.masterUsername !== current.masterUsername) {
    return {
      requiresReplace: true,
      replaceReason: "masterUsername is immutable after creation",
      changedFields: ["masterUsername"],
    };
  }
  if (desired.dbName !== current.dbName) {
    return {
      requiresReplace: true,
      replaceReason: "dbName is immutable after creation",
      changedFields: ["dbName"],
    };
  }
  if (desired.storageEncrypted !== current.storageEncrypted) {
    return {
      requiresReplace: true,
      replaceReason:
        "storageEncrypted is immutable after creation (encryption cannot be toggled in place)",
      changedFields: ["storageEncrypted"],
    };
  }

  // In-place mutable scalars.
  const changedFields: string[] = [];
  for (const field of MUTABLE_FIELDS) {
    if (desired[field] !== current[field]) {
      changedFields.push(field);
    }
  }

  // VPC SGs compared order-insensitively.
  if (!sameSet(desired.vpcSecurityGroupIds, current.vpcSecurityGroupIds)) {
    changedFields.push("vpcSecurityGroupIds");
  }

  return {
    requiresReplace: false,
    changedFields,
  };
}
