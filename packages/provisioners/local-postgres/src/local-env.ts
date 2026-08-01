/**
 * Local secret-store helpers specific to the local Postgres provisioner.
 *
 * The GENERIC `.env`-file primitives (parse/format/read/write/load-into-process)
 * live in `@foundry/core` (`env/`) — they are a shared kernel convention (the
 * local analog of a cloud secret vault), so the local provisioner (a plugin)
 * imports them from core rather than re-implementing them. This keeps the
 * dependency direction correct: plugins depend on core, never vice versa.
 *
 * What stays HERE is the local-WRITER side: the env-var naming convention
 * (`FOUNDRY_LOCAL_<DBID>`) and connection-string assembly, used when the
 * provisioner writes a freshly-generated local DB's connection string into the
 * local secret store. `foundry env` / the connector READ it via the
 * ConnectionTarget's `credsRef: { from: "env:..." }`.
 */
import {
  DEFAULT_LOCAL_ENV_DIRNAME,
  DEFAULT_LOCAL_ENV_FILENAME,
  formatEnvFile,
  parseEnvFile,
  readEnvFile,
  writeEnvFileEntry,
  removeEnvFileEntry,
  loadEnvFileIntoProcess,
} from "@foundry/core";
import { join } from "node:path";

// Re-export the shared kernel primitives so consumers can import everything for
// a local DB from this one package (parity with the other provisioner packages).
export {
  parseEnvFile,
  formatEnvFile,
  readEnvFile,
  writeEnvFileEntry,
  removeEnvFileEntry,
  loadEnvFileIntoProcess,
  DEFAULT_LOCAL_ENV_DIRNAME as DEFAULT_SECRETS_DIRNAME,
  DEFAULT_LOCAL_ENV_FILENAME as DEFAULT_ENV_FILENAME,
};

/** Default directory (relative to cwd) for the local env file. */
export { DEFAULT_LOCAL_ENV_DIRNAME, DEFAULT_LOCAL_ENV_FILENAME };

/** Resolve the local env file path for a secrets directory + file name. */
export function localEnvPath(
  secretsDir: string,
  envFileName: string = DEFAULT_LOCAL_ENV_FILENAME,
): string {
  return join(secretsDir, envFileName);
}

/**
 * Normalise a database id into an env-var-safe suffix: uppercase, non-alphanum
 * runs collapsed to a single underscore. e.g. "analytics-db" → "ANALYTICS_DB".
 */
export function dbIdSuffix(dbId: string): string {
  return dbId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * The env var name under which the full `postgres://` connection string for a
 * local database is stored in the local env file — and the name used in the
 * ConnectionTarget's `credsRef: { from: "env:<this>" }`.
 */
export function credEnvVar(dbId: string): string {
  return `FOUNDRY_LOCAL_${dbIdSuffix(dbId)}`;
}

/** Build a `postgres://` connection string from discrete parts. */
export function buildPostgresUrl(parts: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  const { user, password, host, port, database } = parts;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}
