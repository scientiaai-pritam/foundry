/**
 * @foundry/connector-mongodb — MongoDB connector implementation.
 *
 * Implements the Connector interface for MongoDB using the `mongodb` driver
 * (MongoClient). In foundry v1 MongoDB is runtime-only
 * (`provision: "external"`) — there is no provisioner for it; this connector is
 * the single integration point.
 *
 * Key design decisions:
 * - credsRef is REQUIRED and resolves to the FULL connection URI
 *   (e.g. `mongodb+srv://user:pass@host/?opts`). That URI is the database's own
 *   secret, resolved at runtime from env or AWS Secrets Manager — never the
 *   value itself.
 * - NEVER logs secret values (the URI embeds credentials).
 * - Pool stats are STATIC zeros: the `mongodb` driver does not expose cheap,
 *   stable per-client pool counters (server topology is discovered lazily and
 *   re-evaluated by SDAM heartbeats), so we report zeros rather than guess.
 *   Mirrors the DynamoDB rationale.
 * - Health check: `client.db().command({ ping: 1 })`, treating `ok === 1` as
 *   healthy, with measured round-trip latency.
 * - No migrate method (MongoDB is schemaless).
 */

import type {
  Connector,
  Connection,
  ConnectionTarget,
  SecretRef,
  HealthStatus,
  PoolStats,
} from "@foundry/core";
import { MongoClient } from "mongodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

/**
 * Static pool stats for MongoDB.
 *
 * The `mongodb` node driver manages a dynamic, SDAM-driven server topology
 * (discovered lazily, re-evaluated on heartbeats) and does not expose stable,
 * cheaply-readable per-client pool counters the way `pg.Pool` does. Rather than
 * emit numbers we cannot back, we report zeros — the same posture DynamoDB
 * takes for its managed HTTP plane. Callers needing real concurrency signals
 * should instrument the driver directly.
 */
const STATIC_POOL_STATS: PoolStats = {
  size: 0,
  idle: 0,
  inUse: 0,
  waiting: 0,
};

/**
 * Resolve a SecretRef to its secret string value.
 *
 * For the MongoDB connector the resolved value is the full connection URI
 * (e.g. `mongodb+srv://user:pass@host/?opts`) — the database's own secret.
 *
 * - `{ from: "env:VAR" }`  → read from `process.env.VAR` (e.g. env:MONGO_URI)
 * - `{ secretId: "..." }`  → fetch from AWS Secrets Manager (GetSecretValue)
 *
 * SECURITY: this NEVER logs the secret value. The URI embeds credentials, so it
 * is handed straight to MongoClient and must not be printed, stored, or included
 * in error messages.
 */
async function resolveSecret(credsRef: SecretRef, region?: string): Promise<string> {
  if ("from" in credsRef) {
    // Env-var reference, e.g. { from: "env:MONGO_URI" }.
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
  // ambient AWS credential chain (env / IAM role / ~/.aws).
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

/**
 * Create + open a MongoClient from a ConnectionTarget.
 *
 * The connection URI is resolved from the target's REQUIRED `credsRef` (the
 * database's own secret). `MongoClient.connect()` is awaited so a malformed URI
 * or unreachable host fails fast at connect() rather than surfacing on first
 * use. The resolved URI is NEVER logged.
 */
async function createClient(target: ConnectionTarget): Promise<MongoClient> {
  // credsRef is REQUIRED for MongoDB — it carries the connection URI.
  if (target.credsRef === undefined) {
    throw new Error(
      'MongoDB requires "credsRef" in ConnectionTarget (the connection URI secret)',
    );
  }

  const uri = await resolveSecret(target.credsRef, target.region);
  const client = new MongoClient(uri);
  await client.connect();
  return client;
}

/**
 * MongoDB connector implementation.
 */
export const mongodbConnector: Connector = {
  engine: "mongodb",

  /**
   * Connect to MongoDB.
   *
   * Resolves the connection URI from the target's REQUIRED credsRef, opens a
   * MongoClient (awaiting topology discovery), and returns a Connection.
   *
   * The Connection.client is the MongoClient itself — obtain a `Db` lazily via
   * `conn.client.db("name")` when you need it (the driver resolves the database
   * on first use). Pool stats are static (see STATIC_POOL_STATS).
   *
   * @param target - Connection target with credsRef (the connection URI secret)
   * @returns Promise<Connection> with MongoClient
   */
  async connect(target: ConnectionTarget): Promise<Connection> {
    const client = await createClient(target);

    return {
      engine: "mongodb",
      client,
      pool: STATIC_POOL_STATS,
      close: async (): Promise<void> => {
        await client.close();
      },
    };
  },

  /**
   * Health check for MongoDB.
   *
   * Issues `{ ping: 1 }` against the default database and treats `ok === 1` as
   * healthy. Measures round-trip latency in milliseconds.
   *
   * @param conn - Connection to check
   * @returns Promise<HealthStatus> with latencyMs
   */
  async health(conn: Connection): Promise<HealthStatus> {
    const client = conn.client as MongoClient;
    const startTime = performance.now();

    try {
      const res = (await client.db().command({ ping: 1 })) as { ok?: number };
      const latencyMs = performance.now() - startTime;

      if (res.ok === 1) {
        return {
          ok: true,
          latencyMs,
          detail: "ping ok",
        };
      }

      return {
        ok: false,
        latencyMs,
        detail: `ping returned ok=${res.ok ?? "unknown"}`,
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

  // migrate is intentionally omitted — MongoDB is schemaless; collections are
  // created on first use and there is no engine-native DDL migration to run.
};

export default mongodbConnector;
