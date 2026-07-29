/**
 * Conversion between scientia's camelCase project model and the Supabase
 * Management API's snake_case shapes, plus status mapping for drift detection.
 */
import type { ResourceState } from "@scientia/core";
import type { CreateProjectBody, ProjectResponse, UpdateProjectBody } from "./client.js";
import type { NormalizedProject } from "./types.js";

/**
 * Map a Supabase project `status` string to a scientia {@link ResourceState} status.
 *
 * Supabase's documented/observed statuses: ACTIVE_HEALTHY (healthy), ACTIVE,
 * INACTIVE (initial), UPGRADING, RESTARTING, RESTORING, PAUSING, PAUSED,
 * STOPPED, REMOVED, GOING_DOWN, plus the v2 branch statuses. A paused/stopped
 * project is not connectable — it is surfaced as "error" and requires a manual
 * restore (POST /v1/projects/{ref}/restore) before the connector can use it.
 */
export function mapProjectStatus(s: string | undefined): ResourceState["status"] {
  switch (s) {
    case "ACTIVE":
    case "ACTIVE_HEALTHY":
    case "READY":
      return "available";
    case "INACTIVE":
    case "INITIALIZING":
    case "RESETTING_HISTORICAL":
    case "RESETTING":
      return "creating";
    case "UPGRADING":
    case "RESTARTING":
    case "RESTORING":
    case "PAUSING":
    case "GOING_DOWN_UP":
      return "updating";
    case "REMOVED":
    case "GOING_DOWN":
    case "DELETING":
      return "deleting";
    case "PAUSED":
    case "STOPPED":
      // Not usable as-is; requires manual resume. Surfaced as error.
      return "error";
    default:
      return "error";
  }
}

/** A project is ready to serve connections when its status is healthy. */
export function isReadyStatus(s: string | undefined): boolean {
  return s === "ACTIVE" || s === "ACTIVE_HEALTHY" || s === "READY";
}

/** A project is paused/stopped (needs a manual restore to become usable). */
export function isPausedStatus(s: string | undefined): boolean {
  return s === "PAUSED" || s === "STOPPED";
}

/** Build the POST /v1/projects body. `dbPass` is the transient VALUE (never persisted). */
export function toCreateBody(desired: NormalizedProject, dbPass: string): CreateProjectBody {
  const body: CreateProjectBody = {
    name: desired.name,
    organization_id: desired.organizationId ?? "",
    db_pass: dbPass,
  };
  if (desired.plan) body.plan = desired.plan;
  if (desired.region) body.region = desired.region;
  if (desired.instanceSize) body.desired_instance_size = desired.instanceSize;
  if (desired.kubeClusterIdentifier) body.kube_cluster_identifier = desired.kubeClusterIdentifier;
  return body;
}

/** Build the PATCH /v1/projects/{ref} body (only genuinely in-place fields). */
export function toUpdateBody(desired: NormalizedProject): UpdateProjectBody {
  const body: UpdateProjectBody = {};
  if (desired.name) body.name = desired.name;
  if (desired.instanceSize) body.desired_instance_size = desired.instanceSize;
  return body;
}

/**
 * Append the Postgres direct port (5432) to a bare DB host if it has none.
 * `database.host` from the API is like `db.<ref>.supabase.co` (no port). The
 * connector may prefer the Supavisor pooler (port 6543) — that is its choice.
 */
export function withDbPort(host: string): string {
  return host.includes(":") ? host : `${host}:5432`;
}

/** Read the database host off a project response (best-effort). */
export function projectHost(p: ProjectResponse): string | undefined {
  return p.database?.host;
}
