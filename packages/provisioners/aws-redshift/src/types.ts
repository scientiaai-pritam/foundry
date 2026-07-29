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
 * SECURITY: `masterUserPassword` is a {@link SecretRef} — a POINTER to the
 * database's own master-password secret. Its VALUE is never stored in state,
 * config, logs, or error messages. The provisioner resolves it only transiently
 * to satisfy `CreateCluster` (Redshift requires the password at creation time);
 * the same ref is passed through to {@link ConnectionTarget.credsRef} for the
 * connector to resolve at runtime.
 */
export interface RedshiftSpecProps {
  clusterIdentifier: string;
  nodeType: string;
  masterUsername: string;
  /** POINTER to the master-password secret — never the value itself. */
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
  /** Desired-only: the master-password SecretRef. Never present in outputs/state. */
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
   * Skip the final snapshot on delete. The task spec mandates this for v1
   * (design §7 lists final snapshots as default for stateful engines — this is
   * the documented override). Maps to the SDK's `SkipFinalClusterSnapshot`.
   */
  skipFinalSnapshot?: boolean;
  /** Polling tuning (mostly for tests). `timeoutMs` defaults to 15 min when unset. */
  waitFor?: WaitForOptions;
}
