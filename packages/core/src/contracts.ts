/**
 * foundry — Core contracts (design v1, section 5).
 *
 * Everything plugs in through two contracts (Provisioner + Connector). The core
 * never imports a provisioner or connector — it only knows these shapes.
 *
 * NOTE: This module is types/interfaces only. No runtime logic.
 */

/* ------------------------------------------------------------------ *
 * Resource model (shared)
 * ------------------------------------------------------------------ */

type ResourceKind =
  | "aws.rds-postgres"
  | "aws.redshift"
  | "aws.dynamodb"
  | "supabase.postgres"
  | "local.postgres";

interface ResourceSpec {
  // what the user WROTE in config (desired)
  id: string; // stable logical name, e.g. "analytics"
  kind: ResourceKind;
  props: Record<string, unknown>; // engine-specific (instance class, key schema, nodes…)
  tags?: Record<string, string>;
}

interface ResourceState {
  // what actually EXISTS (cloud + state.json)
  id: string;
  kind: ResourceKind;
  identifiers: Record<string, string>; // ARN, cluster-id, project-ref, table name…
  status: "creating" | "available" | "updating" | "deleting" | "error";
  connection: ConnectionTarget; // produced once available
  outputs?: Record<string, unknown>; // provider bookkeeping (sg ids, subnet group…)
}

interface ConnectionTarget {
  // everything the runtime needs to connect
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  endpoint?: string; // host:port (postgres/redshift/mongo)
  region?: string; // (dynamodb/redshift)
  /**
   * POINTER to the DATABASE's own secret (e.g. an RDS master password) — never
   * the value itself. OPTIONAL: engines with no DB-level credentials (e.g.
   * DynamoDB) authenticate via the ambient AWS credential chain and omit this.
   * The connector resolves a present credsRef at runtime (Secrets Manager / env).
   */
  credsRef?: SecretRef;
}

// Secrets are referenced, never stored as values in state or config:
type SecretRef =
  | { secretId: string } // managed secret (AWS Secrets Manager / Supabase vault)
  | { from: `env:${string}` }; // env-var reference, e.g. { from: "env:MONGO_URI" }

/* ------------------------------------------------------------------ *
 * Provisioner interface
 * ------------------------------------------------------------------ */

interface Provisioner {
  kind: ResourceKind;
  plan(desired: ResourceSpec, current: ResourceState | null): PlanAction;
  apply(action: PlanAction): Promise<ResourceState>; // polls until ready; returns new state
  read(spec: ResourceSpec): Promise<ResourceState | null>; // live read for drift detection
  destroy(state: ResourceState): Promise<void>;
}

type PlanAction =
  | { op: "create"; spec: ResourceSpec }
  | { op: "update"; spec: ResourceSpec; from: ResourceState; changedFields: string[] }
  | { op: "replace"; spec: ResourceSpec; reason: string } // force-recreate (e.g. key-schema change)
  | { op: "delete"; state: ResourceState }
  | { op: "noop"; id: string; reason: string }; // id: every action self-identifies its resource

/* ------------------------------------------------------------------ *
 * Connector interface
 * ------------------------------------------------------------------ */

interface Connector {
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  connect(target: ConnectionTarget): Promise<Connection>; // opens a pooled native client
  health(conn: Connection): Promise<HealthStatus>;
  migrate?(conn: Connection, migrations: Migration[]): Promise<MigrationResult>; // where supported
  /** Roll back `count` applied migrations, newest-first (engines that support it). */
  rollback?(conn: Connection, migrations: Migration[], count: number): Promise<MigrationResult>;
  /** Read the applied-migration rows from the tracking table. */
  migrationStatus?(conn: Connection): Promise<AppliedMigration[]>;
}

interface Connection {
  engine: string;
  client: unknown; // the NATIVE driver: pg.Pool | mongodb.Db | DynamoDBClient | ...
  pool: PoolStats; // size, idle, in-use, waiting
  close(): Promise<void>;
}

interface HealthStatus {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

// Supporting types:
interface PoolStats {
  size: number;
  idle: number;
  inUse: number;
  waiting: number;
}

interface Migration {
  id: string;
  description?: string;
  up: string;
  down?: string;
} // SQL or engine-native DDL

interface MigrationResult {
  applied: string[];
  skipped: string[];
  errors: { id: string; error: string }[];
}

/** A migration row as recorded in the tracking table (returned by migrationStatus). */
interface AppliedMigration {
  id: string;
  description?: string;
  checksum: string;
  appliedAt: Date;
}

export {
  type ResourceKind,
  type ResourceSpec,
  type ResourceState,
  type ConnectionTarget,
  type SecretRef,
  type Provisioner,
  type PlanAction,
  type Connector,
  type Connection,
  type HealthStatus,
  type PoolStats,
  type Migration,
  type MigrationResult,
  type AppliedMigration,
};
