/**
 * @foundry/connector-postgres — PostgreSQL connector implementation.
 *
 * Implements the Connector interface for PostgreSQL using `pg` (node-postgres).
 * Connections are backed by a real `pg.Pool`, so pool stats are LIVE (read from
 * the pool at access time, not snapshotted at connect time).
 *
 * Key design decisions:
 * - Secrets are BY-REFERENCE: `credsRef` on the ConnectionTarget is a SecretRef
 *   that points at THIS DATABASE'S OWN secret (the pg role password / connection
 *   config). The connector resolves it at runtime (env var or AWS Secrets
 *   Manager). The value is NEVER logged, stored in state, or echoed in errors.
 * - pg has NO ambient cloud credential chain, so `credsRef` is REQUIRED — the
 *   connector fails fast with a clear message if it is missing.
 * - A resolved secret is either a JSON document
 *   `{ host, port, user, password, database, ssl? }` (mapped to Pool options) or
 *   a plain `postgres://` connection string. Malformed JSON that does not match
 *   the documented shape is rejected (never silently fed to pg as a connection
 *   string, which risks leaking the secret in a parser error).
 * - Health check runs `SELECT 1` through the pool and measures round-trip latency.
 * - migrate() runs each `Migration.up` (a SQL string) in its own transaction and
 *   tracks applied ids in a `__foundry_migrations` table.
 */

import { Pool } from "pg";
import type { PoolConfig } from "pg";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { checksumMigration } from "@foundry/core";
import type {
  AppliedMigration,
  Connector,
  Connection,
  ConnectionTarget,
  SecretRef,
  HealthStatus,
  Migration,
  MigrationResult,
} from "@foundry/core";

/** Tracking table for applied migrations (created on first migrate() call). */
const MIGRATIONS_TABLE = "__foundry_migrations";

/**
 * Resolve a SecretRef to its secret string value.
 *
 * - `{ from: "env:VAR" }`  → read from `process.env.VAR`
 * - `{ secretId: "..." }`  → fetch from AWS Secrets Manager (GetSecretValue)
 *
 * SECURITY: this NEVER logs the secret value. The returned string is handed
 * straight to `pg` (as a connection string or parsed JSON); it must not be
 * printed, stored, or included in error messages.
 */
async function resolveSecret(credsRef: SecretRef, region?: string): Promise<string> {
  if ("from" in credsRef) {
    // Env-var reference, e.g. { from: "env:PGPASSWORD" }.
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

  // Managed secret → AWS Secrets Manager. The Secrets Manager client itself
  // authenticates via the ambient AWS credential chain (env / IAM role / ~/.aws)
  // — this is the framework's cloud-admin path and is independent of the DB
  // secret being fetched.
  const sm = new SecretsManagerClient(region !== undefined ? { region } : {});
  try {
    const out = await sm.send(
      new GetSecretValueCommand({ SecretId: credsRef.secretId }),
    );
    const secret = out.SecretString;
    if (!secret) {
      throw new Error(
        `Secret "${credsRef.secretId}" has no SecretString to read`,
      );
    }
    return secret;
  } finally {
    sm.destroy();
  }
}

/** Shape of a JSON-encoded Postgres connection document stored in a secret. */
interface PostgresConnectionJson {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl?: boolean;
}

/**
 * If a resolved secret looks like a Postgres connection JSON document, parse it
 * into explicit `pg.Pool` options. Returns `undefined` when the value is not
 * connection-JSON-shaped (e.g. a `postgres://` connection string). Never logs
 * the value.
 *
 * With `exactOptionalPropertyTypes`, `ssl` is only included when it is actually
 * a boolean, so the returned config never carries an `undefined` slot.
 */
function tryParsePoolConfig(secret: string): PoolConfig | undefined {
  try {
    const parsed = JSON.parse(secret) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { host?: unknown }).host === "string" &&
      typeof (parsed as { port?: unknown }).port === "number" &&
      typeof (parsed as { user?: unknown }).user === "string" &&
      typeof (parsed as { password?: unknown }).password === "string" &&
      typeof (parsed as { database?: unknown }).database === "string"
    ) {
      const c = parsed as PostgresConnectionJson;
      const config: PoolConfig = {
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
        ...(typeof c.ssl === "boolean" ? { ssl: c.ssl } : {}),
      };
      return config;
    }
  } catch {
    // Not JSON — fall through; the caller treats the raw string as a connection string.
  }
  return undefined;
}

/**
 * Create a `pg.Pool` from a ConnectionTarget.
 *
 * `credsRef` is REQUIRED: unlike DynamoDB, pg has no ambient cloud credential
 * chain, so there is nothing to fall back to. The resolved secret is either a
 * JSON connection document or a connection string. Values are NEVER logged.
 */
async function createPool(target: ConnectionTarget): Promise<Pool> {
  if (target.credsRef === undefined) {
    throw new Error(
      'Postgres requires "credsRef" in ConnectionTarget — pg has no ambient ' +
      "cloud credential chain. Provide a SecretRef " +
      '({ from: "env:VAR" } or { secretId: "..." }) that resolves to a ' +
      "`postgres://` connection string or a JSON document " +
      "{ host, port, user, password, database, ssl? }.",
    );
  }

  const secret = await resolveSecret(target.credsRef, target.region);

  const poolConfig = tryParsePoolConfig(secret);
  let config: PoolConfig;
  if (poolConfig !== undefined) {
    config = poolConfig;
  } else {
    // Not (valid) connection JSON → treat as a connection string. But refuse to
    // fall back when the secret clearly IS JSON yet failed shape validation:
    // passing a secret-bearing JSON blob to pg's connection-string parser risks
    // leaking the value in a parse error. Fail fast instead.
    const trimmed = secret.trim();
    if (trimmed.startsWith("{")) {
      throw new Error(
        "Postgres credsRef resolved to JSON missing required fields " +
          "(expected host, port, user, password, database). " +
          "Refusing to interpret a malformed JSON document as a connection string.",
      );
    }
    config = { connectionString: secret };
  }

  return new Pool(config);
}

/**
 * Postgres connector implementation.
 */
export const postgresConnector: Connector = {
  engine: "postgres",

  /**
   * Connect to Postgres.
   *
   * Resolves credentials from the target, creates a `pg.Pool`, and returns a
   * Connection. Pool stats are LIVE: the `pool` property uses getters that read
   * `pool.totalCount` / `pool.idleCount` / `pool.waitingCount` fresh on every
   * access, so monitoring always sees current pool occupancy.
   *
   * SECURITY: the resolved secret is never placed on the returned Connection or
   * otherwise retained in a reachable place — only the constructed `Pool` (which
   * holds the credentials internally) is exposed as `client`.
   *
   * @param target - Connection target with a REQUIRED credsRef
   * @returns Promise<Connection> backed by a pg.Pool
   */
  async connect(target: ConnectionTarget): Promise<Connection> {
    const pool = await createPool(target);

    return {
      engine: "postgres",
      client: pool,
      // Live pool stats — re-read from the pool on every property access.
      pool: {
        get size(): number {
          return pool.totalCount;
        },
        get idle(): number {
          return pool.idleCount;
        },
        get inUse(): number {
          return pool.totalCount - pool.idleCount;
        },
        get waiting(): number {
          return pool.waitingCount;
        },
      },
      close: async (): Promise<void> => {
        // Drain active clients, disconnect them, and shut down pool timers.
        await pool.end();
      },
    };
  },

  /**
   * Health check for Postgres.
   *
   * Runs `SELECT 1` through the pool (acquiring + releasing a client) and
   * measures round-trip latency in milliseconds.
   *
   * @param conn - Connection (client is the pg.Pool)
   * @returns Promise<HealthStatus> with ok / latencyMs / detail
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
      // pg connection errors report host/port, never the password; safe to surface.
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
   * Contract (from @foundry/core Connector): each `Migration.up` is a SQL
   * string executed as one statement. The CALLER is responsible for loading
   * migrations from disk (e.g. a directory of `*.sql` files applied in sorted
   * order) and constructing the `Migration[]`; this method only executes the
   * array it receives.
   *
   * Behavior:
   * - Ensures a `__foundry_migrations` tracking table exists (idempotent).
   * - Each migration runs in its own transaction (BEGIN ... COMMIT) on a
   *   checked-out pool client; `up` may itself be a multi-statement script (pg
   *   runs statement strings in simple-query mode).
   * - Already-applied migrations (matched by id) are skipped.
   * - On the first error the run aborts: the transaction is rolled back, the
   *   failing migration is recorded in `errors`, and no further migrations run.
   *
   * SECURITY: migration SQL is user-supplied DDL, not credentials; error detail
   * is the driver's message (no credential values are added).
   *
   * @param conn - Connection (client is the pg.Pool)
   * @param migrations - Ordered list of migrations to apply
   * @returns Promise<MigrationResult>
   */
  async migrate(
    conn: Connection,
    migrations: Migration[],
  ): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    // Ensure the tracking table exists (outside any migration transaction).
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
        // Skip if this migration was already recorded; detect tampering via
        // a checksum mismatch (the applied migration was edited after the fact).
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
          // Best-effort rollback; swallow rollback errors so the original cause
          // is what surfaces in `errors`.
          await client.query("ROLLBACK").catch(() => {
            /* ignore rollback failure */
          });
          const err = error as Error;
          errors.push({
            id: migration.id,
            error: err.message || "Unknown migration error",
          });
          // Stop-on-error: abort the remainder of the run.
          break;
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

export default postgresConnector;
