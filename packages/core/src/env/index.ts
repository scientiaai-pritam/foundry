/**
 * foundry — env / connection-string resolution (design v1 local-DB workflow).
 *
 * Two responsibilities:
 *
 *  1. A generic `.env`-style file reader/writer, plus a "local secret store"
 *     convention: `<cwd>/.foundry/local.env`. Cloud DBs keep their secret values
 *     in AWS Secrets Manager / a provider vault; LOCAL dev has no managed vault,
 *     so this gitignored file is the local analog. `foundry apply` (local
 *     provisioner) WRITES here; the runtime connector and `foundry env` READ
 *     here via the ConnectionTarget's `credsRef: { from: "env:..." }`. The state
 *     file still carries only the POINTER — the value never lives in state.
 *
 *  2. `resolveConnectionString()` — resolve a ConnectionTarget + its credsRef to
 *     a native connection string (DATABASE_URL). Engine-agnostic in shape; today
 *     concrete for `postgres` (the local-DB engine). `{ secretId }` refs need an
 *     injected resolver (cloud); `{ from: "env:..." }` is resolved from the
 *     process env (after loading the local secret store).
 *
 * Depends only on `../contracts.js` and Node built-ins — no plugin imports.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectionTarget, SecretRef } from "../contracts.js";

/* ------------------------------------------------------------------ *
 * .env file convention
 * ------------------------------------------------------------------ */

/** Default directory (relative to cwd) for the local secret store. */
export const DEFAULT_LOCAL_ENV_DIRNAME = ".foundry";
/** Default local secret-store file name. */
export const DEFAULT_LOCAL_ENV_FILENAME = "local.env";

/** Resolve the local secret-store file path for a cwd. */
export function localEnvFilePath(
  cwd: string = process.cwd(),
  dirname_ = DEFAULT_LOCAL_ENV_DIRNAME,
  filename = DEFAULT_LOCAL_ENV_FILENAME,
): string {
  return join(cwd, dirname_, filename);
}

/**
 * Parse a `.env`-style file into a key→value record. Blank/comment lines are
 * ignored; values may be unquoted, single-, or double-quoted. Malformed lines
 * are ignored rather than thrown (the file is tool-generated).
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Format a key→value record to `.env` text (sorted, stable, round-trippable). */
export function formatEnvFile(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .sort()
    .map((k) => `${k}=${quoteEnvValue(values[k]!)}`);
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** Quote a value only when it contains characters that would break a re-parse. */
export function quoteEnvValue(value: string): string {
  if (/[\s#=]/.test(value) || value.startsWith('"') || value.startsWith("'")) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** Read a `.env` file; returns {} when absent. */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  return parseEnvFile(text);
}

/** Upsert a single key=value entry, preserving all others; creates the file. */
export async function writeEnvFileEntry(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  const existing = await readEnvFile(path);
  existing[key] = value;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatEnvFile(existing), "utf8");
}

/** Remove a single key from a `.env` file (no-op if the file/key is absent). */
export async function removeEnvFileEntry(path: string, key: string): Promise<void> {
  if (!existsSync(path)) return;
  const existing = await readEnvFile(path);
  if (!(key in existing)) return;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete existing[key];
  await writeFile(path, formatEnvFile(existing), "utf8");
}

/**
 * Load a `.env` file into `process.env` WITHOUT overriding variables already
 * set. This is what makes a local `credsRef: { from: "env:..." }` resolvable
 * after `foundry apply` has written the connection string to the local secret
 * store. Harmless when the file is absent (the cloud path).
 *
 * @returns the number of newly-set variables (0 if the file is absent).
 */
export async function loadEnvFileIntoProcess(
  path: string,
  target: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const values = await readEnvFile(path);
  let n = 0;
  for (const [k, v] of Object.entries(values)) {
    if (target[k] === undefined) {
      target[k] = v;
      n++;
    }
  }
  return n;
}

/** Convenience: load `<cwd>/.foundry/local.env` into process.env (no overrides). */
export async function loadLocalEnvIntoProcess(
  cwd: string = process.cwd(),
): Promise<number> {
  return loadEnvFileIntoProcess(localEnvFilePath(cwd));
}

/* ------------------------------------------------------------------ *
 * Connection-string resolution
 * ------------------------------------------------------------------ */

export interface ResolveConnectionOptions {
  /**
   * Resolver for `{ secretId }` credsRefs (cloud-managed secrets). Local/env
   * refs need no resolver. When a secretId ref is encountered and no resolver
   * is injected, resolution fails with a clear, actionable error.
   */
  secretResolver?: (secretId: string) => Promise<string>;
}

/**
 * Resolve a ConnectionTarget + its credsRef to a native connection string
 * (a `postgres://` URL for the postgres engine).
 *
 * Resolution rules:
 *   - `engine !== "postgres"` → throws (DATABASE_URL is a postgres concept
 *     today; other engines resolve their own way at runtime).
 *   - `credsRef` required (pg has no ambient credential chain).
 *   - `{ from: "env:X" }`  → read `process.env[X]`.
 *   - `{ secretId: "..." }` → `opts.secretResolver(secretId)`.
 *   - The resolved value is either a `postgres://` / `postgresql://` string
 *     (used verbatim) or a JSON document `{host,port,user,password,database}`
 *     (assembled into a URL).
 */
export async function resolveConnectionString(
  target: ConnectionTarget,
  opts: ResolveConnectionOptions = {},
): Promise<string> {
  if (target.engine !== "postgres") {
    throw new EnvResolutionError(
      `foundry env emits a DATABASE_URL for the "postgres" engine (target engine is "${target.engine}"). ` +
        `Connect via the runtime connector for this engine instead.`,
    );
  }
  if (target.credsRef === undefined) {
    throw new EnvResolutionError(
      'Postgres requires "credsRef" on its ConnectionTarget (pg has no ambient credential chain).',
    );
  }
  const secret = await resolveSecretValue(target.credsRef, opts);
  return interpretPostgresSecret(secret, target);
}

export interface PostgresConnectionParts {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/**
 * Resolve a postgres ConnectionTarget to a structured connection (URL + PG*
 * parts). Wraps {@link resolveConnectionString} and parses the resulting URL.
 */
export async function resolvePostgresConnection(
  target: ConnectionTarget,
  opts: ResolveConnectionOptions = {},
): Promise<PostgresConnectionParts> {
  const url = await resolveConnectionString(target, opts);
  return parsePostgresUrl(url);
}

/** Parse a `postgres://` URL into PG* connection parts. */
export function parsePostgresUrl(url: string): PostgresConnectionParts {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : 5432;
  return {
    url,
    host: u.hostname,
    port,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

export type EnvFormat = "dotenv" | "shell" | "json";

/** Format a key→value set as dotenv / shell / json for `foundry env`. */
export function formatConnectionVars(vars: Record<string, string>, format: EnvFormat): string {
  if (format === "json") return JSON.stringify(vars, null, 2);
  const prefix = format === "shell" ? "export " : "";
  return Object.entries(vars)
    .map(([k, v]) => `${prefix}${k}=${quoteEnvValue(v)}`)
    .join("\n");
}

/** Upsert multiple key=value entries, preserving all others; creates the file. */
export async function writeEnvFileEntries(
  path: string,
  entries: Record<string, string>,
): Promise<void> {
  const existing = await readEnvFile(path);
  for (const [k, v] of Object.entries(entries)) existing[k] = v;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatEnvFile(existing), "utf8");
}

/** Errors surfaced by env resolution. */
export class EnvResolutionError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "EnvResolutionError";
  }
}

async function resolveSecretValue(
  ref: SecretRef,
  opts: ResolveConnectionOptions,
): Promise<string> {
  if ("from" in ref) {
    const envVarName = ref.from.slice(4); // strip "env:" prefix
    const value = process.env[envVarName];
    if (value === undefined || value === "") {
      throw new EnvResolutionError(
        `Environment variable "${envVarName}" is not set. For a local database, run \`foundry apply\` first ` +
          `(it writes the connection string to .foundry/local.env), then re-run \`foundry env\`.`,
        `If you set it manually, export ${envVarName}=... in your shell.`,
      );
    }
    return value;
  }
  if ("secretId" in ref) {
    if (opts.secretResolver === undefined) {
      throw new EnvResolutionError(
        `credsRef { secretId: "${ref.secretId}" } needs a secret resolver. foundry env resolves env-based ` +
          `and local secrets directly; cloud-managed secrets require the app to inject a resolver.`,
        `Run the postgres connector at runtime, or pass a resolver via createAppContext().`,
      );
    }
    return opts.secretResolver(ref.secretId);
  }
  throw new EnvResolutionError(
    'Invalid credsRef: expected { from: "env:VAR" } or { secretId: "..." }.',
  );
}

interface PostgresConnectionJson {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** A resolved secret → a `postgres://` URL (string passthrough or JSON assembly). */
function interpretPostgresSecret(secret: string, target: ConnectionTarget): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return trimmed;
  }
  // JSON connection document → assemble a URL. Refuse to feed a malformed JSON
  // blob to a URL parser (it would surface the secret in a parse error).
  if (trimmed.startsWith("{")) {
    const json = tryParsePostgresJson(trimmed);
    if (json) {
      return `postgres://${encodeURIComponent(json.user)}:${encodeURIComponent(json.password)}@${json.host}:${json.port}/${encodeURIComponent(json.database)}`;
    }
    throw new EnvResolutionError(
      "Postgres credsRef resolved to JSON missing required fields (expected host, port, user, password, database).",
    );
  }
  // A bare password with no host: combine with the target endpoint when present.
  if (target.endpoint) {
    throw new EnvResolutionError(
      "Postgres credsRef resolved to a bare value (not a postgres:// URL or connection JSON); " +
        "foundry env cannot assemble a full URL from it. Store a full postgres:// connection string instead.",
    );
  }
  throw new EnvResolutionError(
    "Postgres credsRef resolved to a value that is neither a postgres:// URL nor a connection JSON document.",
  );
}

function tryParsePostgresJson(text: string): PostgresConnectionJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.host === "string" &&
    typeof o.port === "number" &&
    typeof o.user === "string" &&
    typeof o.password === "string" &&
    typeof o.database === "string"
  ) {
    return {
      host: o.host,
      port: o.port,
      user: o.user,
      password: o.password,
      database: o.database,
    };
  }
  return null;
}
