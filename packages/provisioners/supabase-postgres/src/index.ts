/**
 * @foundry/supabase-postgres — Supabase Postgres provisioner for foundry.
 *
 * Implements the `Provisioner` contract for `kind: "supabase.postgres"` via a
 * thin typed fetch client against the Supabase Management REST API. Non-AWS:
 * no cloud SDK dependency; uses the global fetch.
 */
// Re-export the shared lifecycle primitives the orchestrator/tests expect from
// every provisioner package (mirrors aws-dynamodb/index.ts).
export { waitFor, WaitForTimeoutError, idempotencyToken } from "@foundry/core";
export type { WaitForOptions } from "@foundry/core";

// Provisioner + factory.
export { SupabasePostgresProvisioner } from "./provisioner.js";
export { createSupabasePostgresProvisioner } from "./factory.js";

// Client + secret resolution.
export {
  SupabaseManagementClient,
  resolveSecret,
  DEFAULT_SUPABASE_BASE_URL,
} from "./client.js";
export type {
  CreateProjectBody,
  FetchLike,
  ProjectDatabaseRef,
  ProjectResponse,
  SupabaseManagementClientOptions,
  UpdateProjectBody,
} from "./client.js";

// Parse / diff / convert helpers.
export { outputsToNormalized, parseSpecProps } from "./parse.js";
export { diffProject } from "./diff.js";
export type { DiffResult } from "./diff.js";
export {
  isPausedStatus,
  isReadyStatus,
  mapProjectStatus,
  projectHost,
  toCreateBody,
  toUpdateBody,
  withDbPort,
} from "./convert.js";

// Error taxonomy.
export {
  ProtectedResourceError,
  SupabaseApiError,
  SupabaseConfigError,
  SupabasePostgresProvisionerError,
  isSupabaseApiError,
  wrapApiError,
} from "./errors.js";

// Spec model + option types.
export type {
  NormalizedProject,
  SupabasePostgresProvisionerFactoryOptions,
  SupabasePostgresProvisionerOptions,
} from "./types.js";
