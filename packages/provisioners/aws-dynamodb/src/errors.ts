/**
 * Error model for the DynamoDB provisioner (design v1, section 7).
 *
 * Cloud calls classify into actionable errors that name the resource, the
 * action, the underlying API error, and a suggested next step — so a
 * `stop-on-error` orchestrator can surface something useful to the user.
 */

/** Base class for every error raised by this provisioner. */
export class DynamoDBProvisionerError extends Error {
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
    this.name = "DynamoDBProvisionerError";
    this.resourceId = resourceId;
    this.action = action;
    this.cause = cause;
    // exactOptionalPropertyTypes: only attach when we actually have a value.
    if (suggestion !== undefined) {
      this.suggestion = suggestion;
    }
  }
}

/** Raised when a `protect: true` resource is asked to destroy/replace without force. */
export class ProtectedResourceError extends DynamoDBProvisionerError {
  constructor(resourceId: string, action: string) {
    super(
      `Refusing to ${action} protected resource '${resourceId}' (protect=true). ` +
        `Re-run with force enabled (allowProtectedDestroy) or set protect:false in config.`,
      resourceId,
      action,
    );
    this.name = "ProtectedResourceError";
  }
}

/** Raised when a desired config is invalid / incomplete. */
export class DynamoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DynamoConfigError";
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

/** Wrap any thrown value into a DynamoDBProvisionerError, attaching a suggestion. */
export function wrapAwsError(
  e: unknown,
  resourceId: string,
  action: string,
): DynamoDBProvisionerError {
  if (e instanceof DynamoDBProvisionerError) return e;
  const awsName = isAwsError(e) ? e.name : "Error";
  const awsMessage = isAwsError(e) && e.message ? e.message : String(e);
  return new DynamoDBProvisionerError(
    `DynamoDB ${action} failed for '${resourceId}': ${awsName} — ${awsMessage}`,
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
    case "ResourceInUseException":
      return action === "create"
        ? "A table with this name already exists or a creation is already in flight."
        : "The table is in a state that blocks this update; wait for ACTIVE and retry.";
    case "LimitExceededException":
      return "AWS account/service limit reached; request a quota increase.";
    case "ResourceNotFoundException":
      return "The table does not exist (or has already been deleted).";
    case "AccessDeniedException":
      return "AWS credentials lack the required dynamodb:* IAM permissions.";
    case "ValidationException":
      return "AWS rejected the request as malformed; check tableName / keySchema / attributeDefinitions / GSIs.";
    default:
      return undefined;
  }
}
