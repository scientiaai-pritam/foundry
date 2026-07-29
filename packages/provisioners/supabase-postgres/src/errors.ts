/**
 * Error model for the Supabase Postgres provisioner (design v1, section 7).
 *
 * Supabase is NOT an AWS service — there is no SDK error `name` taxonomy to
 * switch on. Instead, the thin fetch client raises {@link SupabaseApiError}
 * carrying the HTTP status code, and {@link wrapApiError} maps that status to
 * an actionable suggestion. Every error names the resource, the action, the
 * underlying API error, and a suggested next step — so a stop-on-error
 * orchestrator can surface something useful to the user.
 */

/** Base class for every error raised by this provisioner. */
export class SupabasePostgresProvisionerError extends Error {
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
    this.name = "SupabasePostgresProvisionerError";
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
export class ProtectedResourceError extends SupabasePostgresProvisionerError {
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
export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

/**
 * Transport-level error raised by the fetch client when the Management API
 * returns a non-2xx response, or when the request fails at the network layer.
 * Carries the HTTP `status` (0 for network failures with no response).
 */
export class SupabaseApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  override readonly cause: unknown;

  constructor(
    message: string,
    status: number,
    requestId?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SupabaseApiError";
    this.status = status;
    this.cause = cause;
    if (requestId !== undefined) {
      this.requestId = requestId;
    }
  }
}

/** Narrow a thrown value to {@link SupabaseApiError}. */
export function isSupabaseApiError(e: unknown): e is SupabaseApiError {
  return e instanceof SupabaseApiError;
}

/** Wrap any thrown value into a {@link SupabasePostgresProvisionerError}, attaching a suggestion. */
export function wrapApiError(
  e: unknown,
  resourceId: string,
  action: string,
): SupabasePostgresProvisionerError {
  if (e instanceof SupabasePostgresProvisionerError) return e;
  if (e instanceof SupabaseConfigError) {
    // Config errors carry their own message; rewrap to keep the resource/action
    // context the orchestrator needs.
    return new SupabasePostgresProvisionerError(
      `Supabase ${action} for '${resourceId}' aborted: ${e.message}`,
      resourceId,
      action,
      e,
    );
  }
  const status = isSupabaseApiError(e) ? e.status : undefined;
  const apiMessage = isSupabaseApiError(e)
    ? e.message
    : e instanceof Error
      ? e.message
      : String(e);
  return new SupabasePostgresProvisionerError(
    status !== undefined && status > 0
      ? `Supabase ${action} failed for '${resourceId}': HTTP ${status} — ${apiMessage}`
      : `Supabase ${action} failed for '${resourceId}': ${apiMessage}`,
    resourceId,
    action,
    e,
    suggest(action, status),
  );
}

/** Map an HTTP status code (and action) to a human next-step. */
function suggest(action: string, status: number | undefined): string | undefined {
  switch (status) {
    case 401:
      return "Supabase rejected the access token. Verify the personal access token (PAT) or OAuth token supplied via credsRef is valid and not expired.";
    case 403:
      return "The token lacks the required scope (projects:write / project_admin_write) or is not a member of the target organization.";
    case 404:
      return action === "delete" || action === "update"
        ? "The project does not exist (or has already been deleted)."
        : "The project ref was not found; check that it is deployed to the configured organization.";
    case 409:
      return action === "create"
        ? "A project with this name/ref already exists. The read-before-create guard should treat a healthy duplicate as success; if it did not, the existing project may be in a non-healthy state."
        : "The request conflicts with the current project state; wait for ACTIVE and retry.";
    case 422:
      return "Supabase rejected the request body as invalid; check name, organizationId, region, plan, and instanceSize.";
    case 429:
      return "Rate limited by the Supabase API. Back off and retry; reduce concurrent apply concurrency.";
    case undefined:
      return undefined;
    default:
      if (status !== undefined && status >= 500) {
        return "Supabase returned a server error. Retry with backoff; check https://status.supabase.com if it persists.";
      }
      return undefined;
  }
}
