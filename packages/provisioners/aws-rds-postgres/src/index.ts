/**
 * Public entry point for @foundry/aws-rds-postgres.
 *
 * Mirrors @foundry/aws-dynamodb: re-exports the provisioner class, factory,
 * config/errors, the shared waitFor/idempotency primitives from @foundry/core,
 * and the parse/diff/convert helpers + types.
 */
export { AwsRdsPostgresProvisioner } from "./provisioner.js";
export {
  createAwsRdsPostgresProvisioner,
  createRdsClient,
} from "./factory.js";
export {
  AwsRdsPostgresProvisionerError,
  ProtectedResourceError,
  RdsPostgresConfigError,
  isAwsError,
  wrapAwsError,
} from "./errors.js";
export { parseSpecProps, extractCredsRef, outputsToNormalized, asSecretRef } from "./parse.js";
export { diffInstance } from "./diff.js";
export { dbInstanceToNormalized, mapDbInstanceStatus, toAwsTags } from "./convert.js";
export type {
  RDSPostgresSpecProps,
  NormalizedInstance,
  AwsRdsPostgresProvisionerOptions,
} from "./types.js";

// Re-export the shared lifecycle primitives so consumers can import everything
// from this package (parity with @foundry/aws-dynamodb).
export { waitFor, WaitForTimeoutError, idempotencyToken } from "@foundry/core";
export type { WaitForOptions } from "@foundry/core";
