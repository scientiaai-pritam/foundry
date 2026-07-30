/**
 * Error model for the AWS RDS Postgres provisioner (design v1, §7).
 *
 * Mirrors @foundry/aws-dynamodb/errors.ts: cloud calls classify into actionable
 * errors that name the resource, the action, the underlying API error, and a
 * suggested next step — so a stop-on-error orchestrator surfaces something useful.
 *
 * SECURITY: error messages never include credential values. A credsRef is a
 * pointer, not a value; only identifiers/names ever appear in messages.
 */

/** Base class for every error raised by this provisioner. */
export class AwsRdsPostgresProvisionerError extends Error {
  readonly resourceId: string;
  readonly action: string;
  override readonly cause: unknown;
  readonly suggestion?: string;

  constructor(
    message: string,
    resourceId: string,
    action: string,
    cause?: unknown,
    suggestion?: string,
  ) {
    super(message);
    this.name = "AwsRdsPostgresProvisionerError";
    this.resourceId = resourceId;
    this.action = action;
    this.cause = cause;
    // exactOptionalPropertyTypes: only attach when we actually have a value.
    if (suggestion !== undefined) {
      this.suggestion = suggestion;
    }
  }
}

/**
 * Raised when a `deletionProtection: true` (protected) resource is asked to
 * destroy/replace without force (`allowProtectedDestroy`). Design v1 §9: for RDS,
 * `deletionProtection` is the native cloud attribute AND the framework protect
 * signal.
 */
export class ProtectedResourceError extends AwsRdsPostgresProvisionerError {
  constructor(resourceId: string, action: string) {
    super(
      `Refusing to ${action} protected resource '${resourceId}' ` +
        `(deletionProtection=true). Re-run with force enabled (allowProtectedDestroy) ` +
        `or set deletionProtection:false in config.`,
      resourceId,
      action,
    );
    this.name = "ProtectedResourceError";
  }
}

/** Raised when a desired config is invalid / incomplete (fail-fast). */
export class RdsPostgresConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RdsPostgresConfigError";
  }
}

/** Narrow a thrown value to the AWS SDK error shape (has a string `name`). */
export function isAwsError(
  e: unknown,
): e is { name: string; message?: string; $metadata?: unknown } {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    typeof (e as { name: unknown }).name === "string"
  );
}

/** Wrap any thrown value into an AwsRdsPostgresProvisionerError, attaching a suggestion. */
export function wrapAwsError(
  e: unknown,
  resourceId: string,
  action: string,
): AwsRdsPostgresProvisionerError {
  if (e instanceof AwsRdsPostgresProvisionerError) return e;
  const awsName = isAwsError(e) ? e.name : "Error";
  const awsMessage = isAwsError(e) && e.message ? e.message : String(e);
  return new AwsRdsPostgresProvisionerError(
    `RDS ${action} failed for '${resourceId}': ${awsName} — ${awsMessage}`,
    resourceId,
    action,
    e,
    suggest(action, awsName),
  );
}

function suggest(action: string, awsName: string): string | undefined {
  switch (awsName) {
    case "ThrottlingException":
    case "RequestLimitExceeded":
      return "Throttled by AWS — back off and retry; reduce request rate.";
    case "DBInstanceAlreadyExists":
      return action === "create"
        ? "An instance with this identifier already exists or a creation is already in flight."
        : "The identifier collides with an existing instance.";
    case "DBInstanceNotFound":
      return "The DB instance does not exist (or has already been deleted).";
    case "DBSnapshotAlreadyExistsFault":
      return "A final snapshot with this name already exists; the per-destroy suffix should have prevented this — retry destroy.";
    case "InvalidDBInstanceStateException":
    case "InvalidDBInstanceState":
      return "The instance is in a state that blocks this operation; wait for 'available' and retry.";
    case "InsufficientDBInstanceCapacityException":
      return "The selected DB instance class is not available in this AZ; pick a different class or AZ.";
    case "InstanceQuotaExceeded":
      return "AWS account DB-instance quota reached; request a quota increase.";
    case "StorageQuotaExceeded":
      return "AWS account total-storage quota reached; request a quota increase.";
    case "DBSubnetGroupNotFoundFault":
      return "dbSubnetGroupName does not refer to an existing DB subnet group.";
    case "InvalidVPCNetworkStateFault":
      return "The VPC/subnet configuration is invalid for this instance.";
    case "KMSKeyNotAccessibleFault":
      return "storageEncrypted needs a KMS key the ambient credentials cannot access.";
    case "AccessDeniedException":
      return "AWS credentials lack the required rds:* IAM permissions.";
    case "ValidationException":
      return "AWS rejected the request as malformed; check dbInstanceIdentifier / dbInstanceClass / allocatedStorage.";
    default:
      return undefined;
  }
}
