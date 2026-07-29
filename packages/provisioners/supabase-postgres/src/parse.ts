/**
 * Spec parsing for the Supabase Postgres provisioner.
 *
 * `parseSpecProps` turns the raw `ResourceSpec.props` record into a validated
 * {@link NormalizedProject}; `outputsToNormalized` recovers one from persisted
 * state outputs for drift diffing. The DB password is stored only as a POINTER
 * (`dbPassRef`); its VALUE never flows through parse or outputs.
 */
import type { SecretRef } from "@scientia/core";
import { SupabaseConfigError } from "./errors.js";
import type { NormalizedProject } from "./types.js";

/* ----------------------------- guards ------------------------------ */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown, field: string): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v === undefined) return undefined;
  throw new SupabaseConfigError(`'${field}' must be a non-empty string, got ${typeof v}`);
}

function asBoolean(v: unknown, field: string): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === undefined) return undefined;
  throw new SupabaseConfigError(`'${field}' must be a boolean, got ${typeof v}`);
}

/** Validate a raw value as a SecretRef POINTER (either env or secretId form). */
function asSecretRef(v: unknown, field: string): SecretRef {
  if (!isObject(v)) {
    throw new SupabaseConfigError(
      `'${field}' must be a credsRef ({ from: "env:VAR" } or { secretId: "..." }), got ${typeof v}`,
    );
  }
  if ("from" in v && typeof v.from === "string" && v.from.startsWith("env:")) {
    if (v.from.length <= 4) {
      throw new SupabaseConfigError(`'${field}' uses an empty env: reference`);
    }
    // Reconstruct as a typed `env:${string}` literal so the returned shape
    // satisfies SecretRef without an `as` cast; validation above guarantees the
    // "env:" prefix and a non-empty var name.
    return { from: `env:${v.from.slice(4)}` };
  }
  if ("secretId" in v && typeof v.secretId === "string" && v.secretId.length > 0) {
    return { secretId: v.secretId };
  }
  throw new SupabaseConfigError(
    `'${field}' is not a valid credsRef; expected { from: "env:VAR" } or { secretId: "..." }`,
  );
}

/* --------------------------- spec props ---------------------------- */

/**
 * Parse and validate spec props into a {@link NormalizedProject}.
 *
 * `name` is always required. `organizationId`, `region`, and `dbPass` are
 * validated at create time (parse keeps them optional so read/drift calls on a
 * bare spec don't fail). `dbPass` is stored only as a SecretRef POINTER.
 */
export function parseSpecProps(props: Record<string, unknown>): NormalizedProject {
  if (!isObject(props)) {
    throw new SupabaseConfigError("spec props must be an object");
  }
  const name = asString(props.name, "name");
  if (!name) {
    throw new SupabaseConfigError("'name' is required for a Supabase project");
  }

  const out: NormalizedProject = {
    name,
    protect: asBoolean(props.protect, "protect") ?? false,
  };

  const ref = asString(props.ref, "ref");
  if (ref) out.ref = ref;
  const organizationId = asString(props.organizationId, "organizationId");
  if (organizationId) out.organizationId = organizationId;
  const plan = asString(props.plan, "plan");
  if (plan) out.plan = plan;
  const region = asString(props.region, "region");
  if (region) out.region = region;
  const instanceSize = asString(props.instanceSize, "instanceSize");
  if (instanceSize) out.instanceSize = instanceSize;
  const kubeClusterIdentifier = asString(props.kubeClusterIdentifier, "kubeClusterIdentifier");
  if (kubeClusterIdentifier) out.kubeClusterIdentifier = kubeClusterIdentifier;

  if (props.dbPass !== undefined) {
    out.dbPassRef = asSecretRef(props.dbPass, "dbPass");
  }

  return out;
}

/**
 * Recover a {@link NormalizedProject} from persisted state outputs.
 *
 * Returns `null` when outputs are absent or lack the identifying `ref` — the
 * planner then proposes a full reconciliation rather than guessing. The DB
 * password POINTER is intentionally NOT recovered here: it is never persisted,
 * so it cannot contribute to drift (a deliberate security property).
 */
export function outputsToNormalized(
  outputs?: Record<string, unknown>,
): NormalizedProject | null {
  if (!isObject(outputs)) return null;
  const name = asString(outputs.name, "name");
  const ref = asString(outputs.ref, "ref");
  if (!name || !ref) return null;

  const out: NormalizedProject = {
    name,
    ref,
    protect: asBoolean(outputs.protect, "protect") ?? false,
  };
  const organizationId = asString(outputs.organizationId, "organizationId");
  if (organizationId) out.organizationId = organizationId;
  const plan = asString(outputs.plan, "plan");
  if (plan) out.plan = plan;
  const region = asString(outputs.region, "region");
  if (region) out.region = region;
  const instanceSize = asString(outputs.instanceSize, "instanceSize");
  if (instanceSize) out.instanceSize = instanceSize;
  return out;
}
