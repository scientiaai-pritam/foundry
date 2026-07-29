# @scientia/connector-dynamodb

DynamoDB connector for scientia-db — implements the Connector interface using AWS SDK v3 DynamoDBClient.

## Overview

This connector provides runtime connectivity to Amazon DynamoDB, following the scientia-db Connector contract. It exposes the native AWS SDK v3 DynamoDBClient to applications while handling credential resolution, health checks, and connection lifecycle.

## Key Design Decisions

### 1. No Connection Pooling
DynamoDB is a fully managed service with no traditional connection pool. The AWS SDK manages HTTP keep-alive internally, so pool stats are static (all zeros). This contrasts with Postgres/Mongo where pool size/idle/in-use metrics are meaningful.

### 2. Secret Resolution Without Logging
- **Never logs secret values** — credentials are resolved from environment variables or the default AWS credential chain
- Supports two SecretRef formats:
  - `{ secretId: string }` — managed secrets (AWS Secrets Manager / Supabase vault)
  - `{ from: "env:VAR_NAME" }` — environment variable references
- Validation occurs without exposing actual values in logs or errors

### 3. Health Check Strategy
Uses `ListTablesCommand` with `Limit=1` for the cheapest reliable latency probe:
- Returns `ok: true` even with zero tables (empty response is valid)
- Measures round-trip latency in milliseconds
- Returns descriptive detail (e.g., "No tables yet" or "3 table(s) exist")

### 4. No Migrate Method
DynamoDB is schemaless — the `migrate` method is intentionally omitted from the Connector interface implementation.

### 5. Connection Lifecycle
- `connect()`: Creates DynamoDBClient with resolved region and credentials
- `close()`: Calls `client.destroy()` to clean up resources
- No explicit pool management (handled by AWS SDK)

## Usage

```typescript
import { dynamodbConnector } from "@scientia/connector-dynamodb";

// Connect to DynamoDB
const connection = await dynamodbConnector.connect({
  engine: "dynamodb",
  region: "us-east-1",
  credsRef: { secretId: "arn:aws:secretsmanager:secret:my-secret" }
});

// Access native client
const client = connection.client; // DynamoDBClient

// Check health
const health = await dynamodbConnector.health(connection);
// { ok: true, latencyMs: 42.5, detail: "2 table(s) exist" }

// Close connection
await connection.close();
```

## API

### Connector Implementation

- `engine: "dynamodb"` — Engine identifier
- `connect(target: ConnectionTarget): Promise<Connection>` — Opens connection
- `health(conn: Connection): Promise<HealthStatus>` — Health check
- No `migrate` method (DynamoDB is schemaless)

### Connection Shape

```typescript
{
  engine: "dynamodb",
  client: DynamoDBClient,  // AWS SDK v3 client
  pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },  // Static
  close(): Promise<void>  // Calls client.destroy()
}
```

### HealthStatus Shape

```typescript
{
  ok: boolean,
  latencyMs: number,
  detail?: string  // e.g., "No tables yet" or "3 table(s) exist"
}
```

## Dependencies

- `@scientia/core` — Core contracts (Connector, Connection, HealthStatus, etc.)
- `@aws-sdk/client-dynamodb` — AWS SDK v3 DynamoDB client
- `@aws-sdk/credential-providers` — AWS credential providers

## Testing

Contract tests use `aws-sdk-client-mock` to verify:
- Correct API calls (ListTables for health)
- Credential resolution without logging secrets
- Health check latency measurement
- Error handling (missing region, invalid creds, etc.)
- Static pool stats
- Connection lifecycle (connect/close)

Run tests:
```bash
npm test
```

## Error Handling

- **Missing region**: Throws `Error('DynamoDB requires "region" in ConnectionTarget')`
- **Missing env var**: Throws `Error('Environment variable "VAR_NAME" is not set')`
- **Invalid credsRef**: Throws `Error('Invalid credsRef format')`
- **Health check failures**: Returns `{ ok: false, latencyMs: number, detail: string }`

## Security

- Credentials are NEVER logged
- Secret values are NEVER exposed in error messages
- Uses AWS SDK's default credential chain (env vars, IAM roles, etc.)
- Validates credential references without revealing values

## Notes

- DynamoDB has no schema migration — applications manage table structure directly
- The connector is lightweight — no connection pooling overhead
- Health checks are cheap and fast (single API call with Limit=1)
- Compatible with AWS SDK v3 commands (PutItem, GetItem, Query, Scan, etc.)
