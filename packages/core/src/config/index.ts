/**
 * foundry — Config (desired state).
 *
 * Design v1, sections 4 ("Config (desired state)") and 5 ("Config").
 *
 * `defineStack()` is the user-facing config-as-code entrypoint (SST/Pulumi
 * feel): it validates a `Stack` and returns it typed. `loadStack()` is the
 * CLI-facing loader that resolves `foundry.config.ts` from disk, imports it,
 * and returns the validated `Stack`.
 *
 * This module depends only on `../contracts.js` (plus Node built-ins). The TS
 * loader uses Node's native TypeScript support when available and falls back to
 * a lazy transpile via the `typescript` package (a soft, optional import).
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { ConnectionTarget, ResourceKind, ResourceSpec, SecretRef } from "../contracts.js";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Runtime engine — selects a Connector. Mirrors ConnectionTarget["engine"]. */
export type Engine = ConnectionTarget["engine"];

/**
 * Provisioning config for a managed database. `kind` selects a Provisioner;
 * the remaining fields are engine-specific props passed through verbatim.
 */
export interface ProvisionedConfig {
  readonly kind: ResourceKind;
  [prop: string]: unknown;
}

/** A database that foundry provisions via a cloud Provisioner. */
export interface ProvisionedDatabase {
  readonly engine: Engine;
  readonly provision: ProvisionedConfig;
  /**
   * Optional env-aware alternate target, selected at the context boundary under
   * `--env dev` (see {@link resolveStackForEnv}). Same shape as {@link provision}.
   * Enables one config to target a local DB in dev and a cloud DB in prod.
   */
  readonly dev?: ProvisionedConfig;
  /**
   * Cloud region for this database's resource. Optional — defaults to the
   * ambient `AWS_REGION` / `AWS_DEFAULT_REGION` (see {@link resolveAwsRegion}).
   * Provisioning authenticates via the ambient AWS credential chain.
   */
  readonly region?: string;
  /**
   * Pointer to the DATABASE's own secret (e.g. an RDS master password),
   * resolved by the connector at runtime. This is NOT the framework's AWS API
   * credential (those come from the ambient chain). Absent for engines with no
   * DB-level credentials (e.g. DynamoDB).
   */
  readonly credsRef?: SecretRef;
  readonly tags?: Record<string, string>;
  /** Per-database migration settings (postgres/redshift). */
  readonly migrations?: MigrationsConfig;
}

/**
 * A database foundry does NOT provision (e.g. Mongo in v1, or any
 * externally-managed store). Its ConnectionTarget is supplied directly in
 * config and consumed by the runtime only.
 */
export interface ExternalDatabase {
  readonly engine: Engine;
  readonly provision: "external";
  /** Pointer to the connection string/secret — never the value itself. */
  readonly connectionString: SecretRef;
  readonly endpoint?: string;
  readonly region?: string;
  readonly tags?: Record<string, string>;
  /** Per-database migration settings (postgres/redshift). */
  readonly migrations?: MigrationsConfig;
}

/** Per-database migration settings (postgres/redshift). */
export interface MigrationsConfig {
  /** Disable migrations for this database. Default: enabled if a dir resolves. */
  readonly enabled?: boolean;
  /** Migration directory, relative to cwd. Default: migrations/<dbId>/. */
  readonly dir?: string;
}

export type DatabaseConfig = ProvisionedDatabase | ExternalDatabase;

export interface Stack {
  /** Stable logical id -> database declaration. */
  readonly databases: Record<string, DatabaseConfig>;
  /** Optional human-friendly stack name (informational). */
  readonly name?: string;
}

/* ------------------------------------------------------------------ *
 * Engine <-> kind compatibility (the key boundary from design §4)
 * ------------------------------------------------------------------ */

const KIND_ENGINE: Readonly<Record<ResourceKind, Engine>> = {
  "aws.rds-postgres": "postgres",
  "supabase.postgres": "postgres",
  "aws.redshift": "redshift",
  "aws.dynamodb": "dynamodb",
  "local.postgres": "postgres",
};

const RESOURCE_KINDS = Object.keys(KIND_ENGINE) as readonly ResourceKind[];

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/* ------------------------------------------------------------------ *
 * Validation + defineStack
 * ------------------------------------------------------------------ */

/**
 * Validate a Stack in depth. Throws `ConfigError` on the first problem found.
 * Returns the same object, typed as `Stack`.
 */
export function validateStack(input: unknown): Stack {
  if (!isObject(input)) {
    throw new ConfigError("Stack must be an object");
  }
  const stack = input as Partial<Stack>;
  if (stack.databases === undefined || stack.databases === null) {
    throw new ConfigError("Stack is missing required field: databases", ["databases"]);
  }
  if (!isObject(stack.databases)) {
    throw new ConfigError("Stack.databases must be a record of id -> DatabaseConfig", ["databases"]);
  }

  for (const [id, db] of Object.entries(stack.databases)) {
    validateDatabase(id, db);
  }
  return stack as Stack;
}

function validateDatabase(id: string, db: unknown): asserts db is DatabaseConfig {
  const path = ["databases", id];
  if (!isObject(db)) {
    throw new ConfigError(`Database "${id}" must be an object`, path);
  }
  const cfg = db as Partial<DatabaseConfig>;
  if (cfg.engine === undefined) {
    throw new ConfigError(`Database "${id}" is missing required field: engine`, [...path, "engine"]);
  }
  const validEngines: readonly Engine[] = ["postgres", "mongodb", "dynamodb", "redshift"];
  if (!validEngines.includes(cfg.engine)) {
    throw new ConfigError(
      `Database "${id}" has invalid engine "${String(cfg.engine)}". Expected one of: ${validEngines.join(", ")}`,
      [...path, "engine"],
    );
  }
  if (cfg.provision === undefined) {
    throw new ConfigError(`Database "${id}" is missing required field: provision`, [...path, "provision"]);
  }

  // Optional per-database migrations config (shared by both database kinds).
  // Validated before the external/provisioned branching so a single call covers
  // both paths (the external branch returns early below).
  const migField = (cfg as Partial<{ migrations: unknown }>).migrations;
  if (migField !== undefined) {
    validateMigrationsConfig(migField, [...path, "migrations"], id);
  }

  if (cfg.provision === "external") {
    const ext = cfg as Partial<ExternalDatabase>;
    if (ext.connectionString === undefined) {
      throw new ConfigError(
        `Database "${id}" with provision: "external" requires a connectionString (SecretRef)`,
        [...path, "connectionString"],
      );
    }
    assertSecretRef(ext.connectionString, [...path, "connectionString"], id);
    return;
  }

  validateProvisionedConfig(cfg.provision, [...path, "provision"], id, cfg.engine);

  // Optional DB-level secret (e.g. RDS master password). This is the DATABASE's
  // own secret, resolved by the connector — NOT the framework's AWS API creds
  // (those come from the ambient credential chain). Engines with no DB-level
  // creds (e.g. DynamoDB) simply omit it.
  const provDb = cfg as Partial<ProvisionedDatabase>;
  if (provDb.credsRef !== undefined) {
    assertSecretRef(provDb.credsRef, [...path, "credsRef"], id);
  }
  // Optional env-aware dev block: validated exactly like provision (same kind
  // rules, same engine match). "external" is structurally impossible here
  // because dev is typed as ProvisionedConfig (an object with a kind).
  if (provDb.dev !== undefined) {
    validateProvisionedConfig(provDb.dev, [...path, "dev"], id, cfg.engine);
  }
}

/**
 * Validate a provisioned-config block (kind presence, valid ResourceKind,
 * engine/kind match). Used for both `provision` and the optional env-aware
 * `dev` block so they share identical validation.
 */
function validateProvisionedConfig(
  prov: unknown,
  path: string[],
  id: string,
  dbEngine: Engine,
): asserts prov is ProvisionedConfig {
  if (!isObject(prov)) {
    throw new ConfigError(`Database "${id}" provision must be "external" or an object with a kind`, path);
  }
  const p = prov as Partial<ProvisionedConfig>;
  if (p.kind === undefined) {
    throw new ConfigError(`Database "${id}" provision is missing required field: kind`, [...path, "kind"]);
  }
  if (!RESOURCE_KINDS.includes(p.kind)) {
    throw new ConfigError(
      `Database "${id}" has invalid provision.kind "${String(p.kind)}". Expected one of: ${RESOURCE_KINDS.join(", ")}`,
      [...path, "kind"],
    );
  }
  const kindEngine = KIND_ENGINE[p.kind];
  if (kindEngine !== dbEngine) {
    throw new ConfigError(
      `Database "${id}" engine/kind mismatch: kind "${p.kind}" requires engine "${kindEngine}" but engine is "${dbEngine}"`,
      [...path, "kind"],
    );
  }
}

function assertSecretRef(ref: unknown, path: string[], id: string): asserts ref is SecretRef {
  if (!isObject(ref)) {
    throw new ConfigError(`Database "${id}" connectionString must be a SecretRef object`, path);
  }
  // Treat ref as a plain record and narrow by key presence — avoids touching a
  // `Partial<SecretRef>` whose union members each only carry one discriminant.
  const r = ref as Record<string, unknown>;
  if (typeof r.secretId === "string" && r.secretId.length > 0) return;
  if (typeof r.from === "string" && r.from.startsWith("env:")) return;
  throw new ConfigError(
    `Database "${id}" connectionString must be { secretId: string } or { from: "env:NAME" }`,
    path,
  );
}

function validateMigrationsConfig(mig: unknown, path: string[], id: string): asserts mig is MigrationsConfig {
  if (!isObject(mig)) {
    throw new ConfigError(`Database "${id}" migrations must be an object`, path);
  }
  const m = mig as Partial<MigrationsConfig>;
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
    throw new ConfigError(`Database "${id}" migrations.enabled must be a boolean`, [...path, "enabled"]);
  }
  if (m.dir !== undefined && (typeof m.dir !== "string" || m.dir.length === 0)) {
    throw new ConfigError(`Database "${id}" migrations.dir must be a non-empty string`, [...path, "dir"]);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Type-safe, validating identity function for `foundry.config.ts`.
 *
 * Usage:
 *   export default defineStack({ databases: { ... } });
 *
 * Validates engine/kind compatibility and SecretRef shapes eagerly so config
 * errors surface at load time, not during apply.
 */
export function defineStack<const T extends Stack>(stack: T): T {
  return validateStack(stack) as T;
}

/* ------------------------------------------------------------------ *
 * Stack -> ResourceSpec (for the Planner)
 * ------------------------------------------------------------------ */

/**
 * Convert a declared database into the `ResourceSpec` the Planner/Provisioner
 * consume. Returns `null` for `provision: "external"` (runtime-only — never
 * provisioned). Engine-specific fields are passed through verbatim as `props`.
 */
export function toResourceSpec(id: string, db: DatabaseConfig): ResourceSpec | null {
  if (db.provision === "external") return null;
  const { kind, ...props } = db.provision;
  const spec: ResourceSpec = { id, kind, props };
  if (db.tags !== undefined) spec.tags = db.tags;
  return spec;
}

/** All provisionable ResourceSpecs in a stack (external dbs excluded). */
export function desiredResourceSpecs(stack: Stack): Record<string, ResourceSpec> {
  const out: Record<string, ResourceSpec> = {};
  for (const [id, db] of Object.entries(stack.databases)) {
    const spec = toResourceSpec(id, db);
    if (spec) out[id] = spec;
  }
  return out;
}

/**
 * Resolve the effective AWS region for a provisioned database. Falls back to the
 * ambient credential-chain region (`AWS_REGION`, then `AWS_DEFAULT_REGION`) so a
 * provisioner can be constructed without an explicit per-db region. This is the
 * single canonical path from `ProvisionedDatabase.region` → provisioner
 * construction; the wiring layer calls it and passes the result into the
 * provisioner constructor.
 */
export interface ResolvedStack {
  readonly stack: Stack;
  /** Database ids that had no `dev` block and fell back to `provision` under --env dev. */
  readonly fallbacks: readonly string[];
}

/**
 * Resolve a stack for an environment. When `env === "dev"`, each provisioned
 * database's `provision` is swapped for its `dev` block; databases without `dev`
 * keep `provision` and are reported in `fallbacks` (so the caller can warn).
 * `external` databases pass through unchanged in either environment. Returns the
 * input stack by reference when `env` is undefined.
 */
export function resolveStackForEnv(stack: Stack, env?: "dev"): ResolvedStack {
  if (env !== "dev") return { stack, fallbacks: [] };
  const fallbacks: string[] = [];
  const databases: Record<string, DatabaseConfig> = {};
  for (const [id, db] of Object.entries(stack.databases)) {
    if (db.provision === "external") {
      databases[id] = db;
      continue;
    }
    if (db.dev !== undefined) {
      const { dev, ...rest } = db;
      databases[id] = { ...rest, provision: dev };
    } else {
      databases[id] = db;
      fallbacks.push(id);
    }
  }
  return { stack: { ...stack, databases }, fallbacks };
}

export function resolveAwsRegion(region?: string): string | undefined {
  return region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
}

/* ------------------------------------------------------------------ *
 * Loader
 * ------------------------------------------------------------------ */

const CONFIG_CANDIDATES = [
  "foundry.config.ts",
  "foundry.config.mts",
  "foundry.config.js",
  "foundry.config.mjs",
  "foundry.config.cjs",
] as const;

export interface ResolveConfigOptions {
  readonly cwd?: string;
}

/** Resolve the config file path, or `null` if none found. */
export function resolveConfigPath({ cwd = process.cwd() }: ResolveConfigOptions = {}): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const full = join(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

export class ConfigNotFoundError extends Error {
  constructor(
    message: string,
    readonly searched: readonly string[],
  ) {
    super(message);
    this.name = "ConfigNotFoundError";
  }
}

/**
 * Load and validate `foundry.config.{ts,js}` from `cwd`.
 *
 * Resolution order: `.ts`/`.mts` -> `.js`/`.mjs`/`.cjs`.
 *
 * TypeScript configs are loaded via Node's native TypeScript support first
 * (Node >= 22.6 with `--experimental-strip-types`, or >= 23.6 / Node 26 by
 * default). If native loading is unavailable, the loader lazily imports the
 * `typescript` package (must be installed — it is a devDependency of this
 * package) and transpiles the config to a temporary `.mjs` written next to the
 * original file (so workspace bare-specifier resolution like `@foundry/core`
 * keeps working), then removes it. No hard runtime dependency is added.
 */
export async function loadStack({ cwd = process.cwd() }: ResolveConfigOptions = {}): Promise<Stack> {
  const found = resolveConfigPath({ cwd });
  if (!found) {
    throw new ConfigNotFoundError(
      `No foundry.config file found in ${cwd}. Looked for: ${CONFIG_CANDIDATES.join(", ")}`,
      CONFIG_CANDIDATES.map((c) => join(cwd, c)),
    );
  }
  const module = await loadConfigModule(found);
  const exported = module.default ?? module.stack ?? module.config;
  if (exported === undefined || exported === null) {
    throw new ConfigError(
      `Config module ${found} must default-export a Stack (or export a named "stack"/"config").`,
      [found],
    );
  }
  return validateStack(exported);
}

async function loadConfigModule(file: string): Promise<Record<string, unknown>> {
  const ext = extname(file);
  if (ext === ".ts" || ext === ".mts") {
    try {
      return await import(pathToFileURL(file).href);
    } catch (err) {
      // Native TS not supported on this runtime — fall back to transpile.
      if (isUnsupportedExtension(err)) {
        return await transpileAndImport(file);
      }
      throw err;
    }
  }
  return await import(pathToFileURL(file).href);
}

function isUnsupportedExtension(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    code === "ERR_UNSUPPORTED_ESM_URL_SCHEME" ||
    /Unknown file extension/.test(err.message)
  );
}

async function transpileAndImport(file: string): Promise<Record<string, unknown>> {
  // Lazy, optional dependency: native TS unsupported on this runtime, so
  // transpile via the (dev-installed) `typescript` package. `.catch` lets the
  // missing-package case narrow cleanly to a clear error below.
  const tsImport = (await import("typescript").catch(() => null)) as
    | typeof import("typescript")
    | null;
  if (tsImport === null) {
    throw new ConfigError(
      `Cannot load ${file}: this Node runtime does not support TypeScript natively, ` +
        `and the "typescript" package is not installed. Either run on Node >= 23.6 ` +
        `(or pass --experimental-strip-types) or install typescript.`,
      [file],
    );
  }
  const ts = tsImport;
  const source = await readFile(file, "utf8");
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const js = rewriteRelativeSpecifiers(result.outputText);
  const tempName = `.foundry.config.${randomUUID()}.mjs`;
  const tempPath = join(dirname(file), tempName);
  await writeFile(tempPath, js, "utf8");
  try {
    return await import(pathToFileURL(tempPath).href);
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Best-effort rewrite of relative import specifiers so a transpiled config can
 * still resolve sibling modules. Bare specifiers (e.g. `@foundry/core`) are
 * left untouched and resolve via the config directory's node_modules.
 */
function rewriteRelativeSpecifiers(js: string): string {
  return js.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (_m, pre: string, spec: string, post: string) => {
    if (spec.endsWith(".mjs")) return pre + spec + post;
    if (spec.endsWith(".ts") || spec.endsWith(".mts")) return pre + spec.slice(0, spec.lastIndexOf(".")) + ".mjs" + post;
    if (extname(spec) === "") return pre + spec + ".mjs" + post;
    return pre + spec + post;
  });
}
