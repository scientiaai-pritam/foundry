/**
 * Spec model and option types for the Supabase Postgres provisioner.
 *
 * Mirrors the shape of aws-dynamodb/types.ts, swapping the SDK client type for
 * our thin {@link SupabaseManagementClient} fetch wrapper. Secrets are strictly
 * BY-REFERENCE here: `dbPassRef` is a {@link SecretRef} POINTER — its value is
 * never stored on this type.
 */
import type { SecretRef, WaitForOptions } from "@scientia/core";
import type { SupabaseManagementClient } from "./client.js";

/**
 * Normalized, validated desired/current view of a Supabase Postgres project.
 *
 * `dbPassRef` is the SecretRef POINTER to the Postgres DB password; it is held
 * in memory only long enough to (transiently) resolve the value for the create
 * POST and to emit it on the ConnectionTarget. The VALUE is never persisted.
 */
export interface NormalizedProject {
  /** Project name (Supabase requires this on create). */
  name: string;
  /**
   * Project ref — the immutable 20-char identifier once the project exists.
   * Omitted on first create; populated from the API response and stored in
   * state. May be supplied in config to target an existing project.
   */
  ref?: string;
  /** Organization that owns the project. Required on create. */
  organizationId?: string;
  /** Pricing plan (free/pro/team/enterprise). Best-effort; not enforceable via the project PATCH endpoint. */
  plan?: string;
  /** Region (AWS-style code, e.g. us-east-1). Required on create. */
  region?: string;
  /** Desired compute instance size (e.g. ci_micro). Best-effort in-place via billing addons. */
  instanceSize?: string;
  /** Optional dedicated k8s cluster identifier (Supabase create-only field). */
  kubeClusterIdentifier?: string;
  /** POINTER (never the value) to the Postgres DB password. Required on create. */
  dbPassRef?: SecretRef;
  /** If true, destroy/replace refuse without allowProtectedDestroy. Defaults false. */
  protect: boolean;
}

/** Options for constructing {@link SupabasePostgresProvisioner} directly (tests / DI). */
export interface SupabasePostgresProvisionerOptions {
  /** Injected Management API client. */
  client: SupabaseManagementClient;
  /**
   * Optional resolver for `{ secretId }`-style SecretRefs. The provisioner
   * resolves the DB password and the admin token transiently; the values are
   * never logged or persisted. For `{ from: "env:VAR" }` refs this is unused.
   */
  secretResolver?: (secretId: string) => Promise<string>;
  /** Allow destroy/replace of `protect: true` resources. Defaults false. */
  allowProtectedDestroy?: boolean;
  /** Polling options for eventual-consistency waits. Defaults to 5 min timeout. */
  waitFor?: WaitForOptions;
}

/** Options for the {@link createSupabasePostgresProvisioner} factory. */
export interface SupabasePostgresProvisionerFactoryOptions {
  /** POINTER to the provider's Supabase personal access token (Bearer). Never logged. */
  tokenRef: SecretRef;
  /** Optional resolver for `{ secretId }`-style SecretRefs (admin token + DB password). */
  secretResolver?: (secretId: string) => Promise<string>;
  /** Injectable fetch (tests / custom agents). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override the API base URL. Defaults to https://api.supabase.com/v1. */
  baseUrl?: string;
  /** Allow destroy/replace of `protect: true` resources. Defaults false. */
  allowProtectedDestroy?: boolean;
  /** Polling options for eventual-consistency waits. Defaults to 5 min timeout. */
  waitFor?: WaitForOptions;
}
