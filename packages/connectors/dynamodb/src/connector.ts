/**
 * @scientia/connector-dynamodb — DynamoDB connector implementation.
 *
 * Implements the Connector interface for DynamoDB using AWS SDK v3.
 * DynamoDB is a fully managed service with no connection pooling — pool stats
 * are static (all zeros).
 *
 * Key design decisions:
 * - NEVER logs secret values (credentials are resolved from env or default chain)
 * - Optsimize for minimal overhead: direct DynamoDBClient usage
 * - Health check uses ListTables with Limit=1 for cheapest reliable latency probe
 * - No migrate method (DynamoDB is schemaless)
 */

import type {
  Connector,
  Connection,
  ConnectionTarget,
  SecretRef,
  HealthStatus,
  PoolStats,
} from "@scientia/core";
import {
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  DynamoDBClientConfig,
  ListTablesCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

/**
 * Static pool stats for DynamoDB (no connection pooling).
 * DynamoDB is a fully managed service — the SDK manages HTTP keep-alive,
 * but there's no traditional connection pool like pg.Pool.
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
 * - `{ from: "env:VAR" }`  → read from `process.env.VAR`
 * - `{ secretId: "..." }`  → fetch from AWS Secrets Manager (GetSecretValue)
 *
 * SECURITY: this NEVER logs the secret value. The returned string is handed
 * straight to the AWS SDK credential provider; it must not be printed, stored,
 * or included in error messages.
 */
async function resolveSecret(credsRef: SecretRef, region?: string): Promise<string> {
  if ("from" in credsRef) {
    // Env-var reference, e.g. { from: "env:AWS_ACCESS_KEY_ID" }.
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

/** A standard AWS credentials JSON document stored in Secrets Manager. */
interface AwsCredentialsJson {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * If a resolved secret looks like an AWS credentials JSON document, parse it
 * into an explicit credentials provider. Returns `undefined` when the value is
 * not AWS-credential-shaped (e.g. a DB password) — in which case the connector
 * falls back to the ambient credential chain. Never logs the value.
 */
function tryParseAwsCredentials(secret: string): AwsCredentialsJson | undefined {
  try {
    const parsed = JSON.parse(secret) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { accessKeyId?: unknown }).accessKeyId === "string" &&
      typeof (parsed as { secretAccessKey?: unknown }).secretAccessKey === "string"
    ) {
      const c = parsed as AwsCredentialsJson;
      return {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        ...(c.sessionToken !== undefined ? { sessionToken: c.sessionToken } : {}),
      };
    }
  } catch {
    // Not JSON — not an AWS-credentials document.
  }
  return undefined;
}

/**
 * Create a DynamoDBClient from a ConnectionTarget.
 *
 * Region is required. Authentication uses the ambient AWS credential chain by
 * default. When a DB-level `credsRef` is present on the target, the secret is
 * resolved (fetched from env / Secrets Manager) and, if it carries AWS
 * credentials, used explicitly. The ambient chain still backs IAM-role / env
 * deployments where no DB-level creds exist (the DynamoDB norm). Values are
 * NEVER logged.
 */
async function createClient(target: ConnectionTarget): Promise<DynamoDBClient> {
  if (!target.region) {
    throw new Error('DynamoDB requires "region" in ConnectionTarget');
  }

  const clientOpts: DynamoDBClientConfig = { region: target.region };

  if (target.credsRef !== undefined) {
    const secret = await resolveSecret(target.credsRef, target.region);
    const creds = tryParseAwsCredentials(secret);
    if (creds) {
      clientOpts.credentials = {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken !== undefined ? { sessionToken: creds.sessionToken } : {}),
      };
    }
    // If the secret is not AWS-credential-shaped (e.g. a DB password), it is
    // irrelevant to DynamoDB auth — the ambient credential chain applies.
  }

  return new DynamoDBClient(clientOpts);
}

/**
 * DynamoDB connector implementation.
 */
export const dynamodbConnector: Connector = {
  engine: "dynamodb",

  /**
   * Connect to DynamoDB.
   *
   * Resolves region and credentials from the target, creates a DynamoDBClient,
   * and returns a Connection. The connection's pool stats are static (DynamoDB
   * has no traditional connection pool).
   *
   * @param target - Connection target with region and credsRef
   * @returns Promise<Connection> with DynamoDBClient
   */
  async connect(target: ConnectionTarget): Promise<Connection> {
    const client = await createClient(target);

    return {
      engine: "dynamodb",
      client,
      pool: STATIC_POOL_STATS,
      close: async (): Promise<void> => {
        // DynamoDBClient has no explicit close method — it manages its own lifecycle
        // This is a no-op for API compatibility, but we could destroy() if needed
        client.destroy();
      },
    };
  },

  /**
   * Health check for DynamoDB.
   *
   * Uses ListTables with Limit=1 for the cheapest reliable latency probe.
   * Measures round-trip latency in milliseconds.
   *
   * @param conn - Connection to check
   * @returns Promise<HealthStatus> with latencyMs
   */
  async health(conn: Connection): Promise<HealthStatus> {
    const client = conn.client as DynamoDBClient;
    const startTime = performance.now();

    try {
      const response: ListTablesCommandOutput = await client.send(
        new ListTablesCommand({ Limit: 1 })
      );

      const latencyMs = performance.now() - startTime;

      // ListTables succeeds even with no tables — any response = healthy
      return {
        ok: true,
        latencyMs,
        detail: response.TableNames?.length
          ? `${response.TableNames.length} table(s) exist`
          : "No tables yet",
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

  // migrate is intentionally omitted — DynamoDB is schemaless
};

export default dynamodbConnector;
