/**
 * @scientia/aws-dynamodb — scientia-db provisioner for AWS DynamoDB tables.
 *
 * Implements the `Provisioner` contract from @scientia/core for
 * `kind: "aws.dynamodb"`. The core never imports this package; the orchestrator
 * selects it by `kind` and injects an AWS SDK v3 `DynamoDBClient`.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export { DynamoDBProvisioner } from "./provisioner.js";
export { createDynamoDBProvisioner } from "./factory.js";

// Errors (importable for caller-side classification).
export {
  DynamoDBProvisionerError,
  ProtectedResourceError,
  DynamoConfigError,
  isAwsError,
  wrapAwsError,
} from "./errors.js";

// Shared polling + idempotency helpers — owned by @scientia/core (design §7).
// Re-exported here so callers/tests can import them from this package too.
export { waitFor, WaitForTimeoutError, idempotencyToken } from "@scientia/core";
export type { WaitForOptions } from "@scientia/core";

// Spec model + diff (useful for unit-testing the planner in isolation).
export { parseSpecProps, outputsToNormalized } from "./parse.js";
export { diffTable, computeGsiChanges, gsiKeyAttributes } from "./diff.js";
export {
  mapTableStatus,
  tableDescriptionToNormalized,
} from "./convert.js";

export type {
  DynamoAttributeDefinition,
  DynamoAttributeType,
  DynamoBillingMode,
  BillingModeInput,
  DynamoGSI,
  DynamoKeyElement,
  DynamoKeyType,
  DynamoProjection,
  DynamoProjectionType,
  DynamoProvisionedThroughput,
  DynamoDBSpecProps,
  DynamoDBProvisionerOptions,
  NormalizedTable,
} from "./types.js";

/**
 * Convenience: build a `DynamoDBClient` from a region. Credentials resolve via
 * the AWS default provider chain (env / shared-credentials / IMDS).
 */
export function createDynamoDBClient(region: string): DynamoDBClient {
  return new DynamoDBClient({ region });
}
