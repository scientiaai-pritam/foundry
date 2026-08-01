/**
 * Parse a user-supplied `ResourceSpec.props` (untyped Record) into a validated,
 * defaulted {@link NormalizedLocal}, and recover a NormalizedLocal from
 * persisted `ResourceState.outputs`.
 *
 * All validation happens here so the rest of the provisioner assumes a
 * well-formed shape. The password is deliberately NOT part of NormalizedLocal
 * (it is a local secret stored in the local env file, never in state).
 */
import type { NormalizedLocal, LocalPostgresSpecProps } from "./types.js";
import { LocalPostgresConfigError } from "./errors.js";

/** Default image: official pgvector, Postgres 16 — vector-ready for AI/RAG. */
export const DEFAULT_IMAGE = "pgvector/pgvector:pg16";
export const DEFAULT_PORT = 5432;
export const DEFAULT_DB_NAME = "app";
export const DEFAULT_USERNAME = "postgres";

/* ----------------------------- guards ----------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new LocalPostgresConfigError(`${field} must be a non-empty string`);
  }
  return v;
}

function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new LocalPostgresConfigError(`${field} must be a non-empty string`);
  }
  return v;
}

function asPort(v: unknown, field: string): number {
  // noUncheckedIndexedAccess/strict: narrow before Number(...).
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new LocalPostgresConfigError(`${field} must be an integer in [1, 65535]`);
  }
  return n;
}

function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") {
    throw new LocalPostgresConfigError(`${field} must be a boolean`);
  }
  return v;
}

/* --------------------------- parse (spec) ------------------------- */

/**
 * Parse spec props into a NormalizedLocal, applying defaults. `dbId` seeds the
 * default container name (`foundry-<dbId>`). Throws on invalid types.
 */
export function parseSpecProps(
  props: Record<string, unknown> | undefined,
  dbId: string,
): NormalizedLocal {
  if (props !== undefined && !isObject(props)) {
    throw new LocalPostgresConfigError("local.postgres props must be an object");
  }
  const p = (props ?? {}) as Partial<LocalPostgresSpecProps>;

  const out: NormalizedLocal = {
    containerName: p.containerName !== undefined ? asString(p.containerName, "containerName") : `foundry-${dbId}`,
    image: p.image !== undefined ? asString(p.image, "image") : DEFAULT_IMAGE,
    port: p.port !== undefined ? asPort(p.port, "port") : DEFAULT_PORT,
    portExplicit: p.port !== undefined,
    dbName: p.dbName !== undefined ? asString(p.dbName, "dbName") : DEFAULT_DB_NAME,
    username: p.username !== undefined ? asString(p.username, "username") : DEFAULT_USERNAME,
    persistent: p.persistent !== undefined ? asBoolean(p.persistent, "persistent") : true,
  };
  const network = asOptionalString(p.network, "network");
  if (network !== undefined) out.network = network;
  return out;
}

/** Extract the spec's explicit password (a value), if any. Never stored in state. */
export function extractPassword(props: Record<string, unknown> | undefined): string | undefined {
  if (!props) return undefined;
  const p = props as Partial<LocalPostgresSpecProps>;
  if (p.password === undefined || p.password === null) return undefined;
  if (typeof p.password !== "string" || p.password.length === 0) {
    throw new LocalPostgresConfigError("password must be a non-empty string");
  }
  return p.password;
}

/* ---------------------- recover (state outputs) ------------------- */

/**
 * Recover a NormalizedLocal from persisted `ResourceState.outputs`. Returns null
 * when outputs are absent/malformed (state predates normalized outputs) so the
 * caller can propose a full reconciliation rather than guess.
 */
export function outputsToNormalized(
  outputs: Record<string, unknown> | undefined,
): NormalizedLocal | null {
  if (!isObject(outputs)) return null;
  if (typeof outputs.containerName !== "string" || typeof outputs.image !== "string") {
    return null;
  }
  if (
    typeof outputs.port !== "number" ||
    typeof outputs.dbName !== "string" ||
    typeof outputs.username !== "string" ||
    typeof outputs.persistent !== "boolean"
  ) {
    return null;
  }
  // Reads after the typeof guards above are narrowed to their literal types.
  const out: NormalizedLocal = {
    containerName: outputs.containerName,
    image: outputs.image,
    port: outputs.port,
    portExplicit: true, // a persisted port is authoritative
    dbName: outputs.dbName,
    username: outputs.username,
    persistent: outputs.persistent,
  };
  if (typeof outputs.network === "string") out.network = outputs.network;
  return out;
}

/** NormalizedLocal → plain outputs record (for state persistence). No password. */
export function normalizedToOutputs(n: NormalizedLocal): Record<string, unknown> {
  const out: Record<string, unknown> = {
    containerName: n.containerName,
    image: n.image,
    port: n.port,
    dbName: n.dbName,
    username: n.username,
    persistent: n.persistent,
  };
  if (n.network !== undefined) out.network = n.network;
  return out;
}
