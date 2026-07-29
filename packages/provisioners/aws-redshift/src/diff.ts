/**
 * Desired-vs-current diffing for a Redshift cluster (design v1, §5 Provisioner
 * interface, §7 Drift). Owns the load-bearing `update` vs `replace` judgment:
 *
 *   - clusterIdentifier change  → replace (cannot rename a cluster in place)
 *   - masterUsername change     → replace (immutable after creation)
 *   - dbName change             → replace (immutable after creation)
 *   - clusterSubnetGroupName    → replace (not modifiable via ModifyCluster)
 *   - encrypted change          → replace (toggling encryption needs a restore)
 *   - nodeType                  → update (ModifyCluster resize)
 *   - numberOfNodes / clusterType → update (ModifyCluster resize)
 *   - vpcSecurityGroupIds       → update (ModifyCluster VpcSecurityGroupIds)
 *   - publiclyAccessible        → update (ModifyCluster PubliclyAccessible)
 *   - protect toggle            → update (framework flag, no cloud call)
 *
 * masterUserPassword is a SecretRef and is INTENTIONALLY never diffed (a secret
 * value cannot be compared, and Redshift does not return it). Master-password
 * rotation is out of scope for v1 drift detection.
 */
import type { NormalizedCluster } from "./types.js";

export interface DiffResult {
  requiresReplace: boolean;
  /** Only present when requiresReplace is true (exactOptional-friendly). */
  replaceReason?: string;
  /** In-place-changeable fields that differ. Empty when requiresReplace. */
  changedFields: string[];
}

/* ---------------------- deep equality (order-stable) ------------- */

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, val]) => `${k}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Security-group order is not significant — compare as sorted sets. */
function stringSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  return deepEqual([...a].sort(), [...b].sort());
}

/* ----------------------------- diff ------------------------------ */

const REPLACE_FIELDS: ReadonlyArray<{
  key: keyof NormalizedCluster;
  label: string;
  reason: string;
}> = [
  {
    key: "clusterIdentifier",
    label: "clusterIdentifier",
    reason: "clusterIdentifier cannot be changed in place; Redshift clusters cannot be renamed",
  },
  {
    key: "masterUsername",
    label: "masterUsername",
    reason: "masterUsername is immutable after cluster creation",
  },
  {
    key: "dbName",
    label: "dbName",
    reason: "dbName is immutable after cluster creation",
  },
  {
    key: "clusterSubnetGroupName",
    label: "clusterSubnetGroupName",
    reason: "clusterSubnetGroupName cannot be modified via ModifyCluster",
  },
  {
    key: "encrypted",
    label: "encrypted",
    reason: "encryption cannot be toggled in place (requires a snapshot/restore)",
  },
];

/** In-place-changeable fields and how to compare them. */
const UPDATE_FIELDS: ReadonlyArray<{
  key: keyof NormalizedCluster;
  label: string;
  eq: (a: NormalizedCluster, b: NormalizedCluster) => boolean;
}> = [
  { key: "nodeType", label: "nodeType", eq: (a, b) => a.nodeType === b.nodeType },
  { key: "clusterType", label: "clusterType", eq: (a, b) => a.clusterType === b.clusterType },
  {
    key: "numberOfNodes",
    label: "numberOfNodes",
    eq: (a, b) => a.numberOfNodes === b.numberOfNodes,
  },
  {
    key: "vpcSecurityGroupIds",
    label: "vpcSecurityGroupIds",
    eq: (a, b) => stringSetsEqual(a.vpcSecurityGroupIds, b.vpcSecurityGroupIds),
  },
  {
    key: "publiclyAccessible",
    label: "publiclyAccessible",
    eq: (a, b) => a.publiclyAccessible === b.publiclyAccessible,
  },
];

export function diffCluster(
  desired: NormalizedCluster,
  current: NormalizedCluster,
): DiffResult {
  // Replace checks first (any one forces a full recreate).
  for (const f of REPLACE_FIELDS) {
    const dv = desired[f.key];
    const cv = current[f.key];
    // An absent optional on either side is not a forced replace by itself — only
    // a defined, differing value is. This keeps `clusterSubnetGroupName`/`dbName`
    // optional fields from spuriously forcing a replace when one side omits them.
    if (dv !== undefined && cv !== undefined && !deepEqual(dv, cv)) {
      return {
        requiresReplace: true,
        replaceReason: `${f.label} change: ${f.reason}`,
        changedFields: [],
      };
    }
  }

  const changedFields: string[] = [];
  for (const f of UPDATE_FIELDS) {
    if (!f.eq(desired, current)) changedFields.push(f.label);
  }
  if (desired.protect !== current.protect) changedFields.push("protect");

  return { requiresReplace: false, changedFields };
}
