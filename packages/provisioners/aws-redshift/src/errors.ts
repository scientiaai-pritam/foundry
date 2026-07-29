/**
 * Error model for the Redshift provisioner (design v1, section 7).
 *
 * Cloud calls classify into actionable errors that name the resource, the
 * action, the underlying API error, and a suggested next step — so a
 * `stop-on-error` orchestrator can surface something useful to the user.
 *
 * SECURITY: no error message, suggestion, or cause ever includes a credential
 * VALUE. Only AWS fault names / opaque identifiers are surfaced.
 */

/** Base class for every error raised by this provisioner. */
export class RedshiftProvisionerError extends Error {
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
    this.name = "RedshiftProvisionerError";
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
export class ProtectedResourceError extends RedshiftProvisionerError {
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
export class RedshiftConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedshiftConfigError";
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

/** Wrap any thrown value into a RedshiftProvisionerError, attaching a suggestion. */
export function wrapAwsError(
  e: unknown,
  resourceId: string,
  action: string,
): RedshiftProvisionerError {
  if (e instanceof RedshiftProvisionerError) return e;
  const awsName = isAwsError(e) ? e.name : "Error";
  const awsMessage = isAwsError(e) && e.message ? e.message : String(e);
  return new RedshiftProvisionerError(
    `Redshift ${action} failed for '${resourceId}': ${awsName} — ${awsMessage}`,
    resourceId,
    action,
    e,
    suggest(action, awsName),
  );
}

function suggest(action: string, awsName: string): string | undefined {
  switch (awsName) {
    case "ThrottlingException":
    case "DependentServiceRequestThrottlingFault":
    case "RequestLimitExceeded":
      return "Throttled by AWS — back off and retry; reduce request rate.";
    case "ClusterAlreadyExistsFault":
      return action === "create"
        ? "A cluster with this identifier already exists or a creation is already in flight."
        : "The cluster is in a state that blocks this update; wait for available and retry.";
    case "NumberOfNodesQuotaExceededFault":
    case "LimitExceededFault":
      return "AWS account/service limit reached; request a quota increase.";
    case "InsufficientClusterCapacityFault":
      return "AWS has insufficient capacity for the requested node type/number in this AZ; retry or pick a different node type.";
    case "ClusterNotFoundFault":
      return "The cluster does not exist (or has already been deleted).";
    case "InvalidClusterStateFault":
      return "The cluster is in a state that blocks this operation; wait for 'available' and retry.";
    case "ClusterSubnetGroupNotFoundFault":
    case "ClusterSecurityGroupNotFoundFault":
      return "The referenced subnet group / security group does not exist in this account/region.";
    case "UnauthorizedOperation":
      return "AWS credentials lack the required redshift:* IAM permissions.";
    case "ValidationException":
    case "InvalidParameterValueException":
      return "AWS rejected the request as malformed; check clusterIdentifier / nodeType / clusterType / numberOfNodes / masterUsername.";
    default:
      return undefined;
  }
}
