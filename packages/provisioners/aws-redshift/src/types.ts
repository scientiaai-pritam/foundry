/**
 * Redshift-specific types for the scientia-db Redshift provisioner.
 *
 * The user writes a scientia-native (camelCase) shape inside `ResourceSpec.props`;
 * we convert to/from AWS's PascalCase at the SDK boundary (see `convert.ts`).
 * Keeping a framework-native shape keeps config-as-code ergonomic and lets the
 * planner diff without leaking SDK types into the core contract.
 */
import type { RedshiftClient } from "@aws-sdk/client-redshift";
import type { SecretRef, WaitForOptions } from "@scientia/core";

/** AWS Redshift `ClusterType` — exactly the two values the control plane speaks. */
export type RedshiftClusterType = "multi-node" | "single-node";

/**
 * What the user WROTE inside `ResourceSpec.props` for `kind: "aws.redshift"`.
 * Every field is optional at the type level (it arrives as Record<string,
 * unknown>) but validated/normalized by `parseSpecProps`.
 *
 * SECURITY — the ONE transient secret resolution in this provisioner: AWS
 * Redshift REQUIRES `MasterUserPassword` as a literal value on `CreateCluster`
 * (unlike RDS, Redshift exposes no ManageMasterUserPassword flag). So the
 * provisioner resolves `masterUserPassword` ONCE, transiently, to build that
 * single SDK call. This is an unavoidable AWS API constraint, NOT a violation of
 * secrets-by-reference: the resolved VALUE is never written to
 * `ResourceState.outputs`, never logged, never included in any error message,
 * and never returned as a value. ONLY the {@link SecretRef} is persisted and
 * passed through — to {@link ConnectionTarget.credsRef}, for the connector to
 * resolve at runtime.
 */
export interface RedshiftSpecProps {
  clusterIdentifier: string;
  nodeType: string;
  masterUsername: string;
  /**
   * POINTER to the master-password secret — never the value. Resolved transiently
   * ONLY for the single CreateCluster call (see SECURITY note above); the ref
   * itself flows to ConnectionTarget.credsRef for the connector to resolve.
   */
  masterUserPassword: SecretRef;
  /** Optional. AWS defaults to "dev" when omitted. */
  dbName?: string;
  clusterType: RedshiftClusterType;
  /** Required (>=2) when clusterType === "multi-node"; defaults to 1 otherwise. */
  numberOfNodes?: number;
  vpcSecurityGroupIds?: string[];
  clusterSubnetGroupName?: string;
  /** Default false. */
  publiclyAccessible?: boolean;
  /** Default false. */
  encrypted?: boolean;
  /** Framework-level destroy guard. Default false. */
  protect?: boolean;
}

/**
 * Fully-resolved, defaulted view of a cluster — used for diffing (plan) and as
 * the canonical contents of `ResourceState.outputs` (so a later `plan` can diff
 * desired-vs-state without a live read).
 *
 * NOTE: `masterUserPasswordRef` is populated ONLY when parsing the desired spec
 * (`parseSpecProps`); it is INTENTIONALLY ABSENT from persisted outputs and from
 * values recovered via {@link outputsToNormalized} (Redshift never returns the
 * password, and we never persist it). Drift detection ignores it.
 */
export interface NormalizedCluster {
  clusterIdentifier: string;
  nodeType: string;
  masterUsername: string;
  /**
   * Desired-only: the master-password SecretRef. Resolved transiently for the one
   * CreateCluster call; NEVER present in outputs/state (see SECURITY note on
   * RedshiftSpecProps) — only the ref reaches ConnectionTarget.credsRef.
   */
  masterUserPasswordRef?: SecretRef;
  dbName?: string;
  clusterType: RedshiftClusterType;
  numberOfNodes: number;
  vpcSecurityGroupIds: string[];
  clusterSubnetGroupName?: string;
  publiclyAccessible: boolean;
  encrypted: boolean;
  protect: boolean;
}

/** Constructor options for {@link RedshiftProvisioner}. */
export interface RedshiftProvisionerOptions {
  /** An AWS SDK v3 client. Injected so tests can stub it with aws-sdk-client-mock. */
  client: RedshiftClient;
  /** AWS region the cluster lives in — surfaces on the emitted ConnectionTarget. */
  region: string;
  /**
   * Allow destroy/replace of `protect:true` resources (set when CLI passes --force).
   */
  allowProtectedDestroy?: boolean;
  /**
   * OPT OUT of the final snapshot taken on `destroy` (design §7, line 294: "Final
   * DB snapshot for RDS/Redshift on destroy — default on for stateful engines").
   * DEFAULTS TO FALSE (snapshot taken) so a terminal destroy never silently loses
   * data without an explicit choice. When true, `DeleteCluster` is sent
   * `SkipFinalClusterSnapshot:true`; when false/omitted, a unique
   * `FinalClusterSnapshotIdentifier` is sent instead (see {@link finalSnapshotSuffix}).
   *
   * NOTE: a `replace` (delete + recreate) always skips the final snapshot — it is
   * a recreation of a tracked resource, not a terminal destroy, and snapshotting
   * on every immutable-field replace would accumulate orphan snapshots.
   */
  skipFinalSnapshot?: boolean;
  /**
   * Builds the uniqueness suffix for the `FinalClusterSnapshotIdentifier`
   * (`scientia-<clusterIdentifier>-final-<suffix>`). AWS requires the snapshot
   * name to be unique per destroy. Defaults to a `Date.now()`-based value; inject
   * a deterministic factory for tests. Ignored when {@link skipFinalSnapshot} is true.
   */
  finalSnapshotSuffix?: () => string;
  /** Polling tuning (mostly for tests). `timeoutMs` defaults to 15 min when unset. */
  waitFor?: WaitForOptions;
}
