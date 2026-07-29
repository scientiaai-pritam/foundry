/**
 * @scientia/aws-redshift — scientia-db provisioner for AWS Redshift clusters.
 *
 * Implements the `Provisioner` contract from @scientia/core for
 * `kind: "aws.redshift"`. The core never imports this package; the orchestrator
 * selects it by `kind` and injects an AWS SDK v3 `RedshiftClient`.
 */
import { RedshiftClient } from "@aws-sdk/client-redshift";

export { RedshiftProvisioner } from "./provisioner.js";
export { createRedshiftProvisioner } from "./factory.js";

// Errors (importable for caller-side classification).
export {
  RedshiftProvisionerError,
  ProtectedResourceError,
  RedshiftConfigError,
  isAwsError,
  wrapAwsError,
} from "./errors.js";

// Shared polling + idempotency helpers — owned by @scientia/core (design §7).
// Re-exported here so callers/tests can import them from this package too.
export { waitFor, WaitForTimeoutError, idempotencyToken } from "@scientia/core";
export type { WaitForOptions } from "@scientia/core";

// Spec model + diff (useful for unit-testing the planner in isolation).
export { parseSpecProps, outputsToNormalized } from "./parse.js";
export { diffCluster } from "./diff.js";
export { clusterToNormalized, mapClusterStatus } from "./convert.js";

export type {
  RedshiftClusterType,
  RedshiftSpecProps,
  RedshiftProvisionerOptions,
  NormalizedCluster,
} from "./types.js";

/**
 * Convenience: build a `RedshiftClient` from a region. Credentials resolve via
 * the AWS default provider chain (env / shared-credentials / IMDS).
 */
export function createRedshiftClient(region: string): RedshiftClient {
  return new RedshiftClient({ region });
}
