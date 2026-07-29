/**
 * Conversion between scientia's camelCase cluster model and AWS SDK v3's
 * PascalCase shapes, plus mapping a live `Cluster` back to a
 * {@link NormalizedCluster} for drift detection.
 */
import type { Cluster, Tag } from "@aws-sdk/client-redshift";
import type { ResourceState } from "@scientia/core";
import type { NormalizedCluster, RedshiftClusterType } from "./types.js";

/* --------------------------- to AWS ------------------------------ */

export function toAwsTags(tags: Record<string, string>): Tag[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/* -------------------------- from AWS ----------------------------- */

/**
 * Extract the VPC security-group IDs from a live Cluster. The SDK describes
 * these as `VpcSecurityGroupMembership[]` ({ VpcSecurityGroupId, Status }); we
 * keep only the IDs (the membership Status is not modelled/diffed).
 */
export function fromAwsVpcSecurityGroups(cluster: Cluster): string[] {
  const out: string[] = [];
  for (const m of cluster.VpcSecurityGroups ?? []) {
    if (typeof m.VpcSecurityGroupId === "string" && m.VpcSecurityGroupId.length > 0) {
      out.push(m.VpcSecurityGroupId);
    }
  }
  return out;
}

/**
 * Derive the Redshift `ClusterType` from a live node count. The SDK `Cluster`
 * response never echoes `ClusterType`, but the field is a pure function of node
 * count: 1 node = "single-node", 2+ = "multi-node". Returns "single-node" when
 * the count is absent (the safest default — see `clusterToNormalized`).
 */
export function clusterTypeFromNodeCount(
  numberOfNodes: number | undefined,
): RedshiftClusterType {
  return numberOfNodes !== undefined && numberOfNodes >= 2
    ? "multi-node"
    : "single-node";
}

/**
 * Build a NormalizedCluster from a DescribeClusters result. `protect` is a
 * framework flag carried outside the cloud resource — supplied by the caller.
 *
 * NOTE: no master-password ref is recoverable here (Redshift never returns it),
 * which is exactly why outputs never contain a credential.
 */
export function clusterToNormalized(
  cluster: Cluster,
  protect: boolean,
): NormalizedCluster {
  const numberOfNodes = cluster.NumberOfNodes ?? 1;
  const out: NormalizedCluster = {
    clusterIdentifier: cluster.ClusterIdentifier ?? "",
    nodeType: cluster.NodeType ?? "",
    masterUsername: cluster.MasterUsername ?? "",
    // The SDK `Cluster` response does NOT echo `ClusterType` back. Recover it
    // losslessly from NumberOfNodes — Redshift's own definition is exact: one
    // node is single-node, two or more is multi-node. (Defaulting everyone to
    // single-node would falsely flag clusterType drift on every multi-node plan.)
    clusterType: clusterTypeFromNodeCount(numberOfNodes),
    numberOfNodes,
    vpcSecurityGroupIds: fromAwsVpcSecurityGroups(cluster),
    publiclyAccessible: cluster.PubliclyAccessible ?? false,
    encrypted: cluster.Encrypted ?? false,
    protect,
  };
  if (typeof cluster.DBName === "string" && cluster.DBName.length > 0) {
    out.dbName = cluster.DBName;
  }
  if (
    typeof cluster.ClusterSubnetGroupName === "string" &&
    cluster.ClusterSubnetGroupName.length > 0
  ) {
    out.clusterSubnetGroupName = cluster.ClusterSubnetGroupName;
  }
  return out;
}

/**
 * Map a Redshift `ClusterStatus` string onto scientia's lifecycle status.
 *
 * Redshift states: available · creating · deleting · modifying · rebooting ·
 * resizing · renaming · final-snapshot · rotating-keys · paused ·
 * incompatible-* · *-failure … We fold the in-flight maintenance states into
 * "updating" and treat anything unexpected as "error" (fail loud, never lie
 * about availability).
 */
export function mapClusterStatus(s: string | undefined): ResourceState["status"] {
  switch (s) {
    case "available":
      return "available";
    case "creating":
      return "creating";
    case "deleting":
      return "deleting";
    case "modifying":
    case "rebooting":
    case "resizing":
    case "renaming":
    case "final-snapshot":
    case "rotating-keys":
    case "updating-hsm":
      return "updating";
    default:
      // paused, incompatible-*, *-failure, unknown
      return "error";
  }
}
