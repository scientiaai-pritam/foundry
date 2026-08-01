/**
 * Errors for the local Postgres provisioner.
 *
 * Mirrors the convention used by the cloud provisioners: a single base error
 * carries the resource id + op so the orchestrator's stop-on-error path can
 * surface a clear, actionable message. A dedicated `DockerUnavailableError`
 * distinguishes the "Docker isn't installed / the daemon isn't running" case
 * (the one real new dependency this provisioner adds) from ordinary failures.
 */
import type { PlanAction } from "@foundry/core";

/** A malformed local.postgres spec/config (surfaced eagerly, like other provisioners). */
export class LocalPostgresConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalPostgresConfigError";
  }
}

export class LocalPostgresProvisionerError extends Error {
  constructor(
    message: string,
    readonly resourceId: string,
    readonly op: string,
    override readonly cause?: unknown,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LocalPostgresProvisionerError";
  }
}

/**
 * The Docker transport is unavailable (binary missing, daemon down, or a command
 * failed to produce the expected output). Because local Postgres rides a Docker
 * container, this is the primary failure mode a user hits on a misconfigured
 * machine — the message + hint point at the fix.
 */
export class DockerUnavailableError extends LocalPostgresProvisionerError {
  constructor(
    message: string,
    resourceId: string,
    op: string,
    cause?: unknown,
    hint?: string,
  ) {
    super(message, resourceId, op, cause, hint);
    this.name = "DockerUnavailableError";
  }
}

/** Wrap an arbitrary thrown value into a LocalPostgresProvisionerError. */
export function wrapLocalError(
  err: unknown,
  resourceId: string,
  op: string,
  hint?: string,
): LocalPostgresProvisionerError {
  if (err instanceof LocalPostgresProvisionerError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LocalPostgresProvisionerError(message, resourceId, op, err, hint);
}

/** The op string a Provisioner.apply receives; used for error context. */
export type ApplyOp = Extract<PlanAction, { op: "create" | "update" | "replace" }>["op"];
