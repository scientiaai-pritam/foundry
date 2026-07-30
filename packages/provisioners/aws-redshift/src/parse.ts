/**
 * Parse a user-supplied `ResourceSpec.props` (an untyped Record) into a fully
 * validated, defaulted {@link NormalizedCluster}, and recover a NormalizedCluster
 * from persisted `ResourceState.outputs`.
 *
 * All validation happens here so the rest of the provisioner can assume a
 * well-formed shape. Defaults (design §5/§7):
 *   - numberOfNodes     → 1 (single-node) ; required >=2 for multi-node
 *   - vpcSecurityGroupIds → []
 *   - publiclyAccessible → false
 *   - encrypted         → false
 *   - protect           → false
 *
 * SECURITY: `masterUserPassword` is a SecretRef POINTER. It is validated here
 * (fail-fast on a malformed ref) but its VALUE is never parsed, stored, or
 * echoed. The ref is retained on the desired {@link NormalizedCluster} only long
 * enough to (a) be passed through to ConnectionTarget.credsRef and (b) be
 * resolved transiently for the create call. It is NEVER written to outputs.
 */
import type { NormalizedCluster, RedshiftClusterType } from "./types.js";
import type { SecretRef } from "@foundry/core";
import { RedshiftConfigError } from "./errors.js";

/* ----------------------------- guards ----------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isClusterType(v: unknown): v is RedshiftClusterType {
  return v === "multi-node" || v === "single-node";
}

/**
 * Validate that a value is a well-formed {@link SecretRef} (fail-fast on a
 * malformed credsRef, per the security contract). Returns the ref as-is — it is
 * NEVER a credential value, only a pointer.
 */
function asSecretRef(v: unknown, field: string): SecretRef {
  if (!isObject(v)) {
    throw new RedshiftConfigError(
      `${field} must be a SecretRef ({ secretId: string } | { from: 'env:VAR' })`,
    );
  }
  if (typeof v.secretId === "string" && v.secretId.length > 0) {
    return { secretId: v.secretId };
  }
  if (typeof v.from === "string" && v.from.startsWith("env:") && v.from.length > 4) {
    return { from: v.from as `env:${string}` };
  }
  throw new RedshiftConfigError(
    `${field} must be a SecretRef ({ secretId: string } | { from: 'env:VAR' })`,
  );
}

/* --------------------------- coercions ---------------------------- */

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new RedshiftConfigError(`${field} must be a non-empty string`);
  }
  return v;
}

function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") {
    throw new RedshiftConfigError(`${field} must be a boolean`);
  }
  return v;
}

function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) {
    throw new RedshiftConfigError(`${field} must be an array`);
  }
  return v.map((item, i) => asString(item, `${field}[${i}]`));
}

/* ------------------------- public parsers ------------------------- */

/** Parse + default `ResourceSpec.props` into a NormalizedCluster. Throws on invalid config. */
export function parseSpecProps(props: Record<string, unknown>): NormalizedCluster {
  const clusterIdentifier = asString(props.clusterIdentifier, "clusterIdentifier");
  const nodeType = asString(props.nodeType, "nodeType");
  const masterUsername = asString(props.masterUsername, "masterUsername");
  const masterUserPasswordRef = asSecretRef(
    props.masterUserPassword,
    "masterUserPassword",
  );

  const clusterTypeV = props.clusterType;
  if (!isClusterType(clusterTypeV)) {
    throw new RedshiftConfigError(
      "clusterType must be 'multi-node' | 'single-node'",
    );
  }

  // numberOfNodes: required (>=2) for multi-node; defaults to 1 for single-node.
  let numberOfNodes: number;
  if (props.numberOfNodes === undefined) {
    numberOfNodes = clusterTypeV === "multi-node" ? 2 : 1;
  } else {
    if (
      typeof props.numberOfNodes !== "number" ||
      !Number.isFinite(props.numberOfNodes) ||
      props.numberOfNodes < 1 ||
      !Number.isInteger(props.numberOfNodes)
    ) {
      throw new RedshiftConfigError(
        "numberOfNodes must be a positive integer",
      );
    }
    numberOfNodes = props.numberOfNodes;
  }
  if (clusterTypeV === "multi-node" && numberOfNodes < 2) {
    throw new RedshiftConfigError(
      "clusterType 'multi-node' requires numberOfNodes >= 2",
    );
  }
  if (clusterTypeV === "single-node" && numberOfNodes !== 1) {
    throw new RedshiftConfigError(
      "clusterType 'single-node' requires numberOfNodes === 1",
    );
  }

  const vpcSecurityGroupIds =
    props.vpcSecurityGroupIds === undefined
      ? []
      : asStringArray(props.vpcSecurityGroupIds, "vpcSecurityGroupIds");

  const publiclyAccessible =
    props.publiclyAccessible === undefined
      ? false
      : asBoolean(props.publiclyAccessible, "publiclyAccessible");
  const encrypted =
    props.encrypted === undefined ? false : asBoolean(props.encrypted, "encrypted");
  const protect =
    props.protect === undefined ? false : asBoolean(props.protect, "protect");

  const out: NormalizedCluster = {
    clusterIdentifier,
    nodeType,
    masterUsername,
    // Desired-only pointer; never persisted (see outputsToNormalized).
    masterUserPasswordRef,
    clusterType: clusterTypeV,
    numberOfNodes,
    vpcSecurityGroupIds,
    publiclyAccessible,
    encrypted,
    protect,
  };

  // Optional fields included only when present (exactOptionalPropertyTypes).
  if (props.dbName !== undefined) {
    out.dbName = asString(props.dbName, "dbName");
  }
  if (props.clusterSubnetGroupName !== undefined) {
    out.clusterSubnetGroupName = asString(
      props.clusterSubnetGroupName,
      "clusterSubnetGroupName",
    );
  }
  return out;
}

/**
 * Recover a NormalizedCluster from persisted `ResourceState.outputs`.
 *
 * Deliberately omits `masterUserPasswordRef`: the password ref is desired-only
 * and is never persisted (it is re-derived from the spec at plan time and
 * resolved transiently at apply time). Returns null if the outputs are malformed
 * or predate the normalized shape.
 */
export function outputsToNormalized(
  outputs?: Record<string, unknown>,
): NormalizedCluster | null {
  if (!isObject(outputs)) return null;
  try {
    if (
      typeof outputs.clusterIdentifier !== "string" ||
      outputs.clusterIdentifier.length === 0
    )
      return null;
    if (typeof outputs.nodeType !== "string" || outputs.nodeType.length === 0)
      return null;
    if (typeof outputs.masterUsername !== "string" || outputs.masterUsername.length === 0)
      return null;
    if (!isClusterType(outputs.clusterType)) return null;
    if (
      typeof outputs.numberOfNodes !== "number" ||
      !Number.isInteger(outputs.numberOfNodes) ||
      outputs.numberOfNodes < 1
    )
      return null;
    if (!Array.isArray(outputs.vpcSecurityGroupIds)) return null;
    if (typeof outputs.publiclyAccessible !== "boolean") return null;
    if (typeof outputs.encrypted !== "boolean") return null;

    const out: NormalizedCluster = {
      clusterIdentifier: outputs.clusterIdentifier,
      nodeType: outputs.nodeType,
      masterUsername: outputs.masterUsername,
      clusterType: outputs.clusterType,
      numberOfNodes: outputs.numberOfNodes,
      vpcSecurityGroupIds: outputs.vpcSecurityGroupIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
      publiclyAccessible: outputs.publiclyAccessible,
      encrypted: outputs.encrypted,
      protect: typeof outputs.protect === "boolean" ? outputs.protect : false,
    };
    if (typeof outputs.dbName === "string" && outputs.dbName.length > 0) {
      out.dbName = outputs.dbName;
    }
    if (
      typeof outputs.clusterSubnetGroupName === "string" &&
      outputs.clusterSubnetGroupName.length > 0
    ) {
      out.clusterSubnetGroupName = outputs.clusterSubnetGroupName;
    }
    return out;
  } catch {
    return null;
  }
}
