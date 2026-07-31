/**
 * @foundry/connector-redshift — Redshift connector implementation.
 *
 * Implements the Connector interface for Amazon Redshift. Redshift speaks the
 * Postgres wire protocol, so this connector uses the `pg` driver (pg.Pool) as
 * its NATIVE client — the same wire-level driver applications already use to
 * talk to Redshift directly.
 *
 * Key design decisions:
 * - NATIVE client: pg.Pool over the Postgres wire protocol. The AWS Redshift
 *   Data API (@aws-sdk/client-redshift-data, IAM-auth, no DB password) was
 *   considered and rejected — see the package report's designDecisions.
 * - Secrets are BY-REFERENCE (credsRef) and REQUIRED. credsRef points at the
 *   database's OWN secret (Redshift master password / connection JSON) and is
 *   resolved at runtime to either a JSON document
 *   { host, port, user, password, database, ssl } or a libpq connection string.
 *   The resolved value is NEVER logged.
 * - Redshift defaults: port 5439, SSL REQUIRED. The common Redshift-on-pg TLS
 *   setting is { rejectUnauthorized: false } (Redshift's certificate chain does
 *   not validate against the default trust store in many runtimes); applied as
 *   the SSL default unless the resolved secret supplies `ssl` explicitly.
 * - REAL pool stats: read live from pg.Pool (totalCount / idleCount /
 *   waitingCount) — not the static zeros used by the DynamoDB connector.
 * - migrate(): Redshift has a schema, so migrations are supported: a
 *   `__foundry_migrations` tracking table records each applied migration with a
 *   sha256 checksum of its `up` SQL (tamper detection), each migration runs in
 *   its own transaction, and the run stops on the first error (no auto-rollback
 *   of prior successes). rollback() + migrationStatus() mirror the postgres
 *   connector.
 */

import type {
  AppliedMigration,
  Connector,
  Connection,
  ConnectionTarget,
  SecretRef,
  HealthStatus,
  PoolStats,
  Migration,
  MigrationResult,
} from "@foundry/core";
import { checksumMigration } from "@foundry/core";
import type { ConnectionOptions } from "node:tls";
import type { PoolConfig } from "pg";
import { Pool } from "pg";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

/** Default Redshift port when neither JSON creds nor a connection string sets one. */
const DEFAULT_REDSHIFT_PORT = 5439;

/** Tracking table for applied migrations (created on first migrate() call). */
const MIGRATIONS_TABLE = "__foundry_migrations";

/**
 * Default SSL configuration for Redshift-over-pg.
 *
 * Redshift REQUIRES SSL, but its server certificate chain does not validate
 * against the default trust store in many runtimes, so the de-facto setting is
 * `{ rejectUnauthorized: false }`. Applied unless the resolved secret sets
 * `ssl` explicitly.
 */
const DEFAULT_REDSHIFT_SSL: ConnectionOptions = { rejectUnauthorized: false };

/**
 * Resolve a SecretRef to its secret string value.
 *
 * - `{ from: "env:VAR" }` → read from `process.env.VAR`
 * - `{ secretId: "..." }`  → fetch from AWS Secrets Manager (GetSecretValue)
 *
 * SECURITY: this NEVER logs the secret value. The returned string is parsed
 * into pg.Pool config and handed straight to the driver; it is never printed,
 * stored, or included in error messages.
 */
async function resolveSecret(credsRef: SecretRef, region?: string): Promise<string> {
  if ("from" in credsRef) {
    // Env-var reference, e.g. { from: "env:REDSHIFT_CREDS" }.
    const envVarName = credsRef.from.slice(4); // strip "env:" prefix
    const value = process.env[envVarName];
    if (value === undefined || value === "") {
      throw new Error(
        `Environment variable "${envVarName}" is not set (required by credsRef)`,
      );
    }
    return value;
  }

  if (!("secretId" in credsRef)) {
    // Fail fast on a malformed SecretRef rather than making a Secrets Manager
    // call with an undefined SecretId that surfaces as a confusing credential error.
    throw new Error(
      'Invalid credsRef format: expected { from: "env:VAR" } or { secretId: "..." }',
    );
  }

  // Managed secret → AWS Secrets Manager. The client authenticates via the
  // ambient AWS credential chain (env / IAM role / ~/.aws); the resolved value
  // is the DATABASE's own secret (Redshift password / connection JSON), not the
  // framework's cloud-admin creds.
  const sm = new SecretsManagerClient(region !== undefined ? { region } : {});
  try {
    const out = await sm.send(
      new GetSecretValueCommand({ SecretId: credsRef.secretId }),
    );
    const secret = out.SecretString;
    if (!secret) {
      throw new Error(`Secret "${credsRef.secretId}" has no SecretString to read`);
    }
    return secret;
  } finally {
    sm.destroy();
  }
}

/** Shape of the JSON form of a Redshift creds secret. */
interface RedshiftCredsJson {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl?: boolean | ConnectionOptions;
}

/** Coerce a parsed `ssl` field to pg's accepted shape, failing fast on garbage. */
function coerceSsl(ssl: unknown): boolean | ConnectionOptions {
  if (typeof ssl === "boolean") {
    return ssl;
  }
  if (typeof ssl === "object" && ssl !== null) {
    return ssl as ConnectionOptions;
  }
  throw new Error('credsRef secret JSON "ssl" must be a boolean or object');
}

/** Validate and read a required non-empty string field from parsed creds JSON. */
function requiredString(c: Record<string, unknown>, field: string): string {
  const v = c[field];
  if (typeof v !== "string" || v === "") {
    throw new Error(`credsRef secret JSON requires non-empty "${field}"`);
  }
  return v;
}

/**
 * Apply Redshift defaults (port 5439, required SSL) to a pg.Pool config.
 * Port is only defaulted when configuring fields directly (a connection string
 * carries its own port); SSL is defaulted for both forms because Redshift
 * requires it.
 */
function applyRedshiftDefaults(config: PoolConfig): PoolConfig {
  let result = config;
  if (result.ssl === undefined) {
    result = { ...result, ssl: DEFAULT_REDSHIFT_SSL };
  }
  if (result.port === undefined && result.connectionString === undefined) {
    result = { ...result, port: DEFAULT_REDSHIFT_PORT };
  }
  return result;
}

/**
 * Parse a resolved Redshift secret into pg.Pool config.
 *
 * Accepts either a JSON document `{ host, port?, user, password, database, ssl? }`
 * or a libpq connection string (`postgresql://...` / keyword=value). Fails fast
 * on malformed JSON or missing required fields. Never logs the value.
 */
function parseRedshiftCreds(secret: string): PoolConfig {
  const trimmed = secret.trim();
  if (trimmed === "") {
    throw new Error("credsRef secret is empty (expected JSON or connection string)");
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("credsRef secret is not valid JSON and not a connection string");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("credsRef secret JSON must be an object");
    }
    const c = parsed as Record<string, unknown>;

    const host = requiredString(c, "host");
    const user = requiredString(c, "user");
    const password = requiredString(c, "password");
    const database = requiredString(c, "database");

    const portRaw = c.port;
    let port: number | undefined;
    if (portRaw !== undefined) {
      if (typeof portRaw !== "number" || !Number.isFinite(portRaw)) {
        throw new Error('credsRef secret JSON "port" must be a number');
      }
      port = portRaw;
    }

    const sslRaw = c.ssl;
    const ssl = sslRaw === undefined ? undefined : coerceSsl(sslRaw);

    const config: PoolConfig = {
      host,
      user,
      password,
      database,
      ...(port !== undefined ? { port } : {}),
      ...(ssl !== undefined ? { ssl } : {}),
    };
    return applyRedshiftDefaults(config);
  }

  // Otherwise treat as a libpq connection string.
  return applyRedshiftDefaults({ connectionString: trimmed });
}

/**
 * Create a pg.Pool for Redshift from a ConnectionTarget.
 *
 * credsRef is REQUIRED — it points at the database's own secret. The secret is
 * resolved (env / Secrets Manager) and parsed into Pool config. Region, if
 * present, is used only to scope the Secrets Manager call.
 */
async function createPool(target: ConnectionTarget): Promise<Pool> {
  if (target.credsRef === undefined) {
    throw new Error(
      "Redshift requires credsRef in ConnectionTarget (the database's own secret)",
    );
  }
  const secret = await resolveSecret(target.credsRef, target.region);
  const config = parseRedshiftCreds(secret);
  return new Pool(config);
}

/** Read live pool statistics from a pg.Pool (snapshot at call time). */
function getPoolStats(pool: Pool): PoolStats {
  return {
    size: pool.totalCount,
    idle: pool.idleCount,
    inUse: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
  };
}

/**
 * Redshift connector implementation.
 */
export const redshiftConnector: Connector = {
  engine: "redshift",

  /**
   * Open a pooled Redshift connection.
   *
   * Resolves the database's own secret from credsRef, builds a pg.Pool over the
   * Postgres wire protocol (SSL enforced), and returns a Connection. Pool stats
   * are a live snapshot read from the pool.
   *
   * @param target - Connection target with credsRef (required) and optional region
   * @returns Promise<Connection> wrapping a pg.Pool
   */
  async connect(target: ConnectionTarget): Promise<Connection> {
    const pool = await createPool(target);

    return {
      engine: "redshift",
      client: pool,
      pool: getPoolStats(pool),
      close: async (): Promise<void> => {
        await pool.end();
      },
    };
  },

  /**
   * Health check: SELECT 1. Measures round-trip latency in milliseconds.
   *
   * @param conn - Connection to check
   * @returns Promise<HealthStatus> with latencyMs
   */
  async health(conn: Connection): Promise<HealthStatus> {
    const pool = conn.client as Pool;
    const startTime = performance.now();
    try {
      await pool.query("SELECT 1");
      const latencyMs = performance.now() - startTime;
      return {
        ok: true,
        latencyMs,
        detail: "SELECT 1 succeeded",
      };
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      const err = error as Error;
      return {
        ok: false,
        latencyMs,
        detail: err.message || "Unknown health check failure",
      };
    }
  },

  /**
   * Apply database migrations in order.
   *
   * Redshift speaks the Postgres wire protocol, so the SQL is identical to the
   * postgres connector: a `__foundry_migrations` tracking table records each
   * applied migration with a sha256 checksum of its `up` SQL (single-sourced
   * via `checksumMigration` from @foundry/core). Each migration runs in its own
   * transaction on a checked-out pool client; an already-applied migration is
   * skipped, but a checksum mismatch (tampering) aborts the run. The first
   * error stops the run (no auto-rollback of prior successes).
   */
  async migrate(conn: Connection, migrations: Migration[]): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        description TEXT,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );

    for (const migration of migrations) {
      const client = await pool.connect();
      try {
        const existing = await client.query(
          `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE id = $1`,
          [migration.id],
        );
        if ((existing.rowCount ?? 0) > 0) {
          const stored = (existing.rows[0]?.checksum ?? "") as string;
          if (stored !== checksumMigration(migration.up)) {
            errors.push({
              id: migration.id,
              error: `checksum mismatch: migration "${migration.id}" was modified after it was applied`,
            });
            break; // tamper -> stop
          }
          skipped.push(migration.id);
          continue;
        }

        try {
          await client.query("BEGIN");
          await client.query(migration.up);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (id, description, checksum) VALUES ($1, $2, $3)`,
            [migration.id, migration.description ?? null, checksumMigration(migration.up)],
          );
          await client.query("COMMIT");
          applied.push(migration.id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            /* best-effort; surface the original cause */
          });
          const err = error as Error;
          errors.push({ id: migration.id, error: err.message || "Unknown migration error" });
          break; // stop-on-error
        }
      } finally {
        client.release();
      }
    }

    return { applied, skipped, errors };
  },

  async rollback(conn: Connection, migrations: Migration[], count: number): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    const result = await pool.query(
      `SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT $1`,
      [count],
    );
    const ids = (result.rows as { id: string }[]).map((r) => r.id);

    for (const id of ids) {
      const migration = migrations.find((m) => m.id === id);
      if (migration === undefined || migration.down === undefined) {
        errors.push({ id, error: `migration "${id}" has no down migration` });
        break;
      }
      const client = await pool.connect();
      try {
        try {
          await client.query("BEGIN");
          await client.query(migration.down);
          await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = $1`, [id]);
          await client.query("COMMIT");
          applied.push(id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            /* best-effort */
          });
          const err = error as Error;
          errors.push({ id, error: err.message || "Unknown rollback error" });
          break;
        }
      } finally {
        client.release();
      }
    }
    return { applied, skipped, errors };
  },

  async migrationStatus(conn: Connection): Promise<AppliedMigration[]> {
    const pool = conn.client as Pool;
    const result = await pool.query(
      `SELECT id, description, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`,
    );
    return (result.rows as { id: string; description: string | null; checksum: string; applied_at: Date }[]).map(
      (r) => ({
        id: r.id,
        checksum: r.checksum,
        appliedAt: r.applied_at,
        ...(r.description !== null ? { description: r.description } : {}),
      }),
    );
  },
};

export default redshiftConnector;
