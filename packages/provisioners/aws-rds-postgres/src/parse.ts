/**
 * Parse a user-supplied `ResourceSpec.props` (an untyped Record) into a fully
 * validated, defaulted {@link NormalizedInstance}, and recover a NormalizedInstance
 * from persisted `ResourceState.outputs`. Also extract the by-reference
 * master-password SecretRef (without ever materializing its value).
 *
 * All validation happens here so the rest of the provisioner assumes a well-formed
 * shape. Fail-fast on a malformed credsRef (design v1 §6: "resolveSecret must
 * never log the value" — we go further and never resolve it at all).
 *
 * Defaults (design §5/§7, security-forward like DynamoDB's PITR=true):
 *   - engine              → "postgres" (this provisioner is postgres-only)
 *   - backupRetentionPeriod → 1   (AWS default; automated backups enabled)
 *   - multiAz             → false
 *   - storageEncrypted    → true  (encrypted-by-default)
 *   - deletionProtection  → false (destroy works without force by default)
 *   - publiclyAccessible  → false (never internet-exposed by default)
 *   - vpcSecurityGroupIds → []    (AWS then uses the subnet group's default SG)
 */
import type { SecretRef } from "@foundry/core";
import type { NormalizedInstance } from "./types.js";
import { RdsPostgresConfigError } from "./errors.js";

/* ----------------------------- guards ----------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* --------------------------- coercions ---------------------------- */

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new RdsPostgresConfigError(`${field} must be a non-empty string`);
  }
  return v;
}
function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new RdsPostgresConfigError(`${field} must be a non-empty string when provided`);
  }
  return v;
}
function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") {
    throw new RdsPostgresConfigError(`${field} must be a boolean`);
  }
  return v;
}
function asPositiveInteger(v: unknown, field: string, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new RdsPostgresConfigError(`${field} must be an integer >= ${min}`);
  }
  return v;
}
function asRetentionPeriod(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 35) {
    throw new RdsPostgresConfigError(`${field} must be an integer between 0 and 35`);
  }
  return v;
}
function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new RdsPostgresConfigError(`${field} must be an array of strings`);
  }
  return v.map((item, i) => asString(item, `${field}[${i}]`));
}

/**
 * Validate a SecretRef WITHOUT ever reading or logging its value. Accepts the
 * two SecretRef shapes from @foundry/core: `{ secretId: string }` (pointer to a
 * Secrets Manager / vault secret) or `{ from: "env:VAR" }` (env-var binding).
 * Throws on anything else — fail-fast on a malformed credsRef.
 */
export function asSecretRef(v: unknown, field: string): SecretRef {
  if (!isObject(v)) {
    throw new RdsPostgresConfigError(
      `${field} must be a SecretRef ({ secretId: string } or { from: \"env:VAR\" })`,
    );
  }
  if (typeof v.secretId === "string" && v.secretId.length > 0) {
    return { secretId: v.secretId };
  }
  if (typeof v.from === "string" && v.from.startsWith("env:")) {
    return { from: v.from as `env:${string}` };
  }
  throw new RdsPostgresConfigError(
    `${field} must be a SecretRef ({ secretId: string } or { from: \"env:VAR\" })`,
  );
}

/* ------------------------- public parsers ------------------------- */

/**
 * Parse + default `ResourceSpec.props` into a NormalizedInstance. Throws on
 * invalid config. Also validates `masterUserPassword` (if present) as a SecretRef
 * purely for fail-fast — its value is intentionally NOT retained here.
 */
export function parseSpecProps(props: Record<string, unknown>): NormalizedInstance {
  const dbInstanceIdentifier = asString(
    props.dbInstanceIdentifier,
    "dbInstanceIdentifier",
  );

  if (props.engine !== undefined && props.engine !== "postgres") {
    throw new RdsPostgresConfigError(
      `engine must be 'postgres' for the aws.rds-postgres provisioner (got '${String(props.engine)}')`,
    );
  }

  const dbInstanceClass = asString(props.dbInstanceClass, "dbInstanceClass");
  // Postgres on gp2/gp3 (the default storage type) requires >= 20 GiB.
  const allocatedStorage = asPositiveInteger(props.allocatedStorage, "allocatedStorage", 20);
  const masterUsername = asString(props.masterUsername, "masterUsername");

  // SECURITY: validate the credsRef shape so a malformed one fails fast, but do
  // NOT keep the value. It is re-extracted in read() via extractCredsRef().
  if (props.masterUserPassword !== undefined) {
    asSecretRef(props.masterUserPassword, "masterUserPassword");
  }

  const dbName = asOptionalString(props.dbName, "dbName");
  const vpcSecurityGroupIds = asStringArray(props.vpcSecurityGroupIds, "vpcSecurityGroupIds");
  const dbSubnetGroupName = asOptionalString(props.dbSubnetGroupName, "dbSubnetGroupName");
  const backupRetentionPeriod =
    props.backupRetentionPeriod === undefined
      ? 1
      : asRetentionPeriod(props.backupRetentionPeriod, "backupRetentionPeriod");
  const multiAz =
    props.multiAz === undefined ? false : asBoolean(props.multiAz, "multiAz");
  const storageEncrypted =
    props.storageEncrypted === undefined ? true : asBoolean(props.storageEncrypted, "storageEncrypted");
  const deletionProtection =
    props.deletionProtection === undefined
      ? false
      : asBoolean(props.deletionProtection, "deletionProtection");
  const publiclyAccessible =
    props.publiclyAccessible === undefined
      ? false
      : asBoolean(props.publiclyAccessible, "publiclyAccessible");

  const out: NormalizedInstance = {
    dbInstanceIdentifier,
    dbInstanceClass,
    allocatedStorage,
    masterUsername,
    vpcSecurityGroupIds,
    backupRetentionPeriod,
    multiAz,
    storageEncrypted,
    deletionProtection,
    publiclyAccessible,
  };
  if (dbName) out.dbName = dbName;
  if (dbSubnetGroupName) out.dbSubnetGroupName = dbSubnetGroupName;
  return out;
}

/** Extract the by-reference master-password SecretRef, if declared. Validates shape. */
export function extractCredsRef(props: Record<string, unknown>): SecretRef | undefined {
  if (props.masterUserPassword === undefined) return undefined;
  return asSecretRef(props.masterUserPassword, "masterUserPassword");
}

/**
 * Recover a NormalizedInstance from persisted `ResourceState.outputs`. Returns
 * null if the shape is unrecognized/hand-edited (the provisioner then re-reads
 * live instead of guessing). Wrapped in try/catch so a single bad field degrades
 * to a re-read rather than crashing plan().
 */
export function outputsToNormalized(
  outputs?: Record<string, unknown>,
): NormalizedInstance | null {
  if (!isObject(outputs)) return null;
  try {
    if (
      typeof outputs.dbInstanceIdentifier !== "string" ||
      outputs.dbInstanceIdentifier.length === 0
    )
      return null;
    if (typeof outputs.dbInstanceClass !== "string") return null;
    if (typeof outputs.allocatedStorage !== "number") return null;
    if (typeof outputs.masterUsername !== "string") return null;
    if (!Array.isArray(outputs.vpcSecurityGroupIds)) return null;
    if (typeof outputs.backupRetentionPeriod !== "number") return null;
    if (typeof outputs.multiAz !== "boolean") return null;
    if (typeof outputs.storageEncrypted !== "boolean") return null;
    if (typeof outputs.deletionProtection !== "boolean") return null;
    if (typeof outputs.publiclyAccessible !== "boolean") return null;

    const out: NormalizedInstance = {
      dbInstanceIdentifier: outputs.dbInstanceIdentifier,
      dbInstanceClass: outputs.dbInstanceClass,
      allocatedStorage: outputs.allocatedStorage,
      masterUsername: outputs.masterUsername,
      vpcSecurityGroupIds: outputs.vpcSecurityGroupIds.filter(
        (s): s is string => typeof s === "string",
      ),
      backupRetentionPeriod: outputs.backupRetentionPeriod,
      multiAz: outputs.multiAz,
      storageEncrypted: outputs.storageEncrypted,
      deletionProtection: outputs.deletionProtection,
      publiclyAccessible: outputs.publiclyAccessible,
    };
    if (typeof outputs.dbName === "string" && outputs.dbName.length > 0) {
      out.dbName = outputs.dbName;
    }
    if (
      typeof outputs.dbSubnetGroupName === "string" &&
      outputs.dbSubnetGroupName.length > 0
    ) {
      out.dbSubnetGroupName = outputs.dbSubnetGroupName;
    }
    return out;
  } catch {
    return null;
  }
}
