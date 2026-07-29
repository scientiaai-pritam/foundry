/**
 * DynamoDB-specific types for the scientia-db DynamoDB provisioner.
 *
 * The user writes a scientia-native (camelCase) shape inside `ResourceSpec.props`;
 * we convert to/from AWS's PascalCase at the SDK boundary (see `convert.ts`).
 * Keeping a framework-native shape keeps config-as-code ergonomic and lets the
 * planner diff without leaking SDK types into the core contract.
 */
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { SecretRef, WaitForOptions } from "@scientia/core";

export type DynamoAttributeType = "S" | "N" | "B";
export type DynamoKeyType = "HASH" | "RANGE";
/**
 * Internal canonical billing mode — always AWS PascalCase (what the SDK speaks).
 * The user writes the spec's lowercase form (see {@link BillingModeInput}); the
 * parser normalizes to this.
 */
export type DynamoBillingMode = "PROVISIONED" | "PAY_PER_REQUEST";
/**
 * User-facing billing-mode values accepted in `ResourceSpec.props.billingMode`
 * (design §5): the spec's lowercase `"pay_per_request" | "provisioned"`, plus
 * the AWS PascalCase forms for direct compatibility. Normalized to
 * {@link DynamoBillingMode} by the parser.
 */
export type BillingModeInput = "pay_per_request" | "provisioned" | DynamoBillingMode;
export type DynamoProjectionType = "ALL" | "KEYS_ONLY" | "INCLUDE";

export interface DynamoAttributeDefinition {
  name: string;
  type: DynamoAttributeType;
}

export interface DynamoKeyElement {
  name: string;
  type: DynamoKeyType;
}

export interface DynamoProjection {
  type: DynamoProjectionType;
  nonKeyAttributes?: string[];
}

export interface DynamoProvisionedThroughput {
  readCapacityUnits: number;
  writeCapacityUnits: number;
}

export interface DynamoGSI {
  indexName: string;
  keySchema: DynamoKeyElement[];
  projection: DynamoProjection;
  /** Only valid when billingMode === "PROVISIONED". */
  provisionedThroughput?: DynamoProvisionedThroughput;
}

/**
 * What the user WROTE inside `ResourceSpec.props` for `kind: "aws.dynamodb"`.
 * Every field is optional at the type level (it arrives as Record<string,
 * unknown>) but validated/normalized by `parseSpecProps`.
 */
export interface DynamoDBSpecProps {
  tableName: string;
  attributeDefinitions: DynamoAttributeDefinition[];
  keySchema: DynamoKeyElement[];
  globalSecondaryIndexes?: DynamoGSI[];
  /** Default PAY_PER_REQUEST. Accepts lowercase (`pay_per_request`/`provisioned`) or AWS PascalCase. */
  billingMode?: BillingModeInput;
  /** Required when billingMode === "PROVISIONED". */
  provisionedThroughput?: DynamoProvisionedThroughput;
  /** Default true (design §7: PITR enabled by default for DynamoDB). */
  pointInTimeRecovery?: boolean;
  /** Framework-level destroy guard. Default false. */
  protect?: boolean;
}

/**
 * Fully-resolved, defaulted view of a table — used for diffing (plan) and as
 * the canonical contents of `ResourceState.outputs` (so a later `plan` can diff
 * desired-vs-state without a live read).
 */
export interface NormalizedTable {
  tableName: string;
  attributeDefinitions: DynamoAttributeDefinition[];
  keySchema: DynamoKeyElement[];
  globalSecondaryIndexes: DynamoGSI[];
  billingMode: DynamoBillingMode;
  provisionedThroughput?: DynamoProvisionedThroughput;
  pointInTimeRecovery: boolean;
  /** False when the live PITR read failed (don't diff PITR then). */
  pointInTimeRecoveryKnown: boolean;
  protect: boolean;
}

/** Constructor options for {@link DynamoDBProvisioner}. */
export interface DynamoDBProvisionerOptions {
  /** An AWS SDK v3 client. Injected so tests can stub it with aws-sdk-client-mock. */
  client: DynamoDBClient;
  /** AWS region the table lives in — surfaces on the emitted ConnectionTarget. */
  region: string;
  /**
   * Optional pointer to the DATABASE's own secret, surfaced on the emitted
   * ConnectionTarget for the connector to resolve at runtime. DynamoDB has no
   * DB-level credentials (it authenticates via the ambient AWS credential
   * chain), so this is typically omitted for DynamoDB.
   */
  credsRef?: SecretRef;
  /** Allow destroy/replace of `protect:true` resources (set when CLI passes --force). */
  allowProtectedDestroy?: boolean;
  /** Polling tuning (mostly for tests). `timeoutMs` defaults to 5 min when unset. */
  waitFor?: WaitForOptions;
}
