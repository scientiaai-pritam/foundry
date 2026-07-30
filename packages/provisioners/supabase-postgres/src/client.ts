/**
 * Thin typed fetch client for the Supabase Management REST API.
 *
 * This replaces the external SDK client import used by the AWS provisioners.
 * Supabase authenticates with a Bearer personal access token (or OAuth token)
 * resolved via {@link resolveSecret} from a SecretRef POINTER — the VALUE is
 * placed directly into the Authorization header and is NEVER logged, stored in
 * state, or included in error messages. The client is injectable (custom
 * `fetch`) so tests stub the transport rather than mock an SDK.
 */
import type { SecretRef } from "@foundry/core";
import { SupabaseApiError, SupabaseConfigError } from "./errors.js";

/** Base URL for the Supabase Management API (v1). */
export const DEFAULT_SUPABASE_BASE_URL = "https://api.supabase.com/v1";

/** A fetch function shaped like the global fetch (injectable for tests). */
export type FetchLike = typeof globalThis.fetch;

/** The `database` block returned by GET /v1/projects/{ref} and GET /v1/projects. */
export interface ProjectDatabaseRef {
  host?: string;
  version?: string;
  postgres_engine?: string;
  release_channel?: string;
}

/** A Supabase project as returned by the Management API. */
export interface ProjectResponse {
  id?: string | number;
  ref: string;
  organization_id?: string;
  organization_slug?: string;
  name: string;
  region?: string;
  status: string;
  created_at?: string;
  database?: ProjectDatabaseRef;
}

/** Body for POST /v1/projects. */
export interface CreateProjectBody {
  name: string;
  organization_id: string;
  plan?: string;
  region?: string;
  /** The DB password VALUE — sent ONLY here, transiently, on create. Never persisted. */
  db_pass: string;
  kube_cluster_identifier?: string;
  desired_instance_size?: string;
}

/** Body for PATCH /v1/projects/{ref} (limited in-place modify). */
export interface UpdateProjectBody {
  name?: string;
  desired_instance_size?: string;
}

export interface SupabaseManagementClientOptions {
  /**
   * Returns the provider's Supabase access token for the Bearer header.
   * SECURITY: the returned value is never logged.
   */
  tokenProvider: () => Promise<string>;
  /** Injectable fetch (defaults to the global fetch). */
  fetch?: FetchLike;
  /** Override base URL (defaults to the public v1 API). */
  baseUrl?: string;
}

/**
 * Thin Management API client. All methods throw {@link SupabaseApiError} on a
 * non-2xx response or network failure; the caller decides how to wrap/map.
 */
export class SupabaseManagementClient {
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: SupabaseManagementClientOptions) {
    this.tokenProvider = opts.tokenProvider;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    // Trim a trailing slash so `${baseUrl}/projects` is always well-formed.
    const raw = opts.baseUrl ?? DEFAULT_SUPABASE_BASE_URL;
    this.baseUrl = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  }

  /** POST /v1/projects — create a project. */
  async createProject(body: CreateProjectBody): Promise<ProjectResponse> {
    return this.request<ProjectResponse>("POST", "/projects", body);
  }

  /** GET /v1/projects/{ref} — read a single project. */
  async getProject(ref: string): Promise<ProjectResponse> {
    return this.request<ProjectResponse>("GET", `/projects/${encodeURIComponent(ref)}`);
  }

  /** GET /v1/projects — list all projects (used for read-before-create name matching). */
  async listProjects(): Promise<ProjectResponse[]> {
    return this.request<ProjectResponse[]>("GET", "/projects");
  }

  /** PATCH /v1/projects/{ref} — limited in-place modify (name / instance size). */
  async updateProject(ref: string, body: UpdateProjectBody): Promise<ProjectResponse> {
    return this.request<ProjectResponse>("PATCH", `/projects/${encodeURIComponent(ref)}`, body);
  }

  /** DELETE /v1/projects/{ref} — delete a project. */
  async deleteProject(ref: string): Promise<void> {
    await this.request<void>("DELETE", `/projects/${encodeURIComponent(ref)}`);
  }

  /**
   * Core request executor. Resolves the token (may throw — propagated), performs
   * the fetch, and raises {@link SupabaseApiError} on non-2xx / network failure.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Token resolution failures (e.g. missing env var) propagate as-is so they
    // surface as config errors rather than being swallowed into a 401.
    const token = await this.tokenProvider();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== "GET" && method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let resp: Response;
    try {
      resp = await this.fetchFn(url, init);
    } catch (e) {
      // Network / DNS / connection failure — no HTTP status to report.
      throw new SupabaseApiError(
        `Supabase API ${method} ${path} network error: ${errMessage(e)}`,
        0,
        undefined,
        e,
      );
    }

    if (resp.status === 204) {
      return undefined as T;
    }

    const text = await resp.text();
    if (!resp.ok) {
      throw new SupabaseApiError(
        `Supabase API ${method} ${path} failed: HTTP ${resp.status} ${extractApiMessage(text)}`.trim(),
        resp.status,
        resp.headers.get("x-request-id") ?? undefined,
      );
    }

    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new SupabaseApiError(
        `Supabase API ${method} ${path} returned a non-JSON body`,
        resp.status,
        resp.headers.get("x-request-id") ?? undefined,
        e,
      );
    }
  }
}

/**
 * Resolve a SecretRef to its secret string VALUE.
 *
 * - `{ from: "env:VAR" }`  → read from `process.env.VAR`
 * - `{ secretId: "..." }`  → resolved via the injected `secretResolver`
 *
 * SECURITY: this NEVER logs the value. The returned string is handed straight
 * to the API client (Bearer header) or sent transiently in the create POST;
 * it must not be printed, stored in state, or included in error messages.
 *
 * Unlike the DynamoDB connector, the secretId backend is NOT AWS Secrets
 * Manager — Supabase deployments bring their own secret store, so a resolver
 * must be injected; we fail fast with a clear error otherwise.
 */
export async function resolveSecret(
  ref: SecretRef,
  secretResolver?: (secretId: string) => Promise<string>,
): Promise<string> {
  if ("from" in ref) {
    const envVarName = ref.from.slice(4); // strip "env:" prefix
    const value = process.env[envVarName];
    if (value === undefined || value === "") {
      throw new SupabaseConfigError(
        `Environment variable "${envVarName}" is not set (required by credsRef)`,
      );
    }
    return value;
  }

  if (!("secretId" in ref)) {
    // Fail fast on a malformed SecretRef.
    throw new SupabaseConfigError(
      'Invalid credsRef format: expected { from: "env:VAR" } or { secretId: "..." }',
    );
  }

  if (!secretResolver) {
    throw new SupabaseConfigError(
      `credsRef { secretId: "${ref.secretId}" } requires a secretResolver to be injected into the provisioner/factory`,
    );
  }
  return secretResolver(ref.secretId);
}

/** Safely reduce a thrown value to a short message (never re-thrown). */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Extract a human-readable message from a Supabase error body (JSON or text). */
function extractApiMessage(text: string): string {
  if (text === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
  if (parsed !== null && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    // Supabase commonly nests: { message } | { error } | { error: { message } } | { msg }.
    for (const key of ["message", "error", "msg"]) {
      const v = o[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return text.slice(0, 500);
}
