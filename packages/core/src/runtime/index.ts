/**
 * foundry — Runtime layer (design v1, sections 4 "Runtime flow", 5
 * "Connector interface", 7 "Runtime errors").
 *
 * The runtime is the frequent/fast path: `db.connect("analytics")` resolves a
 * database id to its ConnectionTarget (from state, or from config for external
 * dbs), then to its Connector, which opens a pooled NATIVE client. The
 * framework owns pool lifecycle, health checks, and observability hooks; it
 * never wraps or re-implements a driver's query API (the anti-pattern line).
 *
 * Depends only on `../contracts.js`, `../config`, and `../state`.
 */

import type {
  AppliedMigration,
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
  PoolStats,
} from "../contracts.js";
import type { DatabaseConfig, Engine, ExternalDatabase, Stack } from "../config/index.js";
import type { StateStore } from "../state/index.js";

/* ------------------------------------------------------------------ *
 * Observability hooks
 * ------------------------------------------------------------------ */

export interface ObservabilityHooks {
  onConnect?(id: string, target: ConnectionTarget): void;
  onConnected?(id: string, connection: Connection): void;
  onHealth?(id: string, status: HealthStatus): void;
  onPool?(id: string, stats: PoolStats): void;
  onError?(id: string, error: unknown): void;
  onClose?(id: string): void;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly dbId: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

/* ------------------------------------------------------------------ *
 * Connection registry: db id -> ConnectionTarget -> Connector
 * ------------------------------------------------------------------ */

export interface ConnectionRegistryOptions {
  /** Live state (provisioned dbs resolve their ConnectionTarget from here). */
  readonly state?: StateStore;
  /** Desired stack (external / runtime-only dbs resolve from here). */
  readonly stack?: Stack;
}

/**
 * Resolves a database id to its ConnectionTarget, and a ConnectionTarget to the
 * Connector registered for its engine. Provisioned dbs are resolved from
 * `StateStore` (the endpoint emitted by apply); external dbs from the `Stack`.
 */
export class ConnectionRegistry {
  private readonly connectors: Map<Engine, Connector>;
  private readonly state: StateStore | undefined;
  private readonly stack: Stack | undefined;

  constructor(
    connectors: Map<Engine, Connector> = new Map(),
    opts: ConnectionRegistryOptions = {},
  ) {
    this.connectors = new Map(connectors);
    this.state = opts.state;
    this.stack = opts.stack;
  }

  /** Register (or replace) the Connector for an engine. */
  register(engine: Engine, connector: Connector): void {
    this.connectors.set(engine, connector);
  }

  /** Look up the Connector for a resolved target's engine. */
  connectorFor(target: ConnectionTarget): Connector {
    const connector = this.connectors.get(target.engine);
    if (!connector) {
      throw new ConnectionError(
        `No connector registered for engine "${target.engine}"`,
        "<unknown>",
      );
    }
    return connector;
  }

  /**
   * Resolve the ConnectionTarget for a database id. State is authoritative for
   * provisioned dbs; the stack supplies targets for external (runtime-only) dbs.
   */
  async targetFor(id: string): Promise<ConnectionTarget> {
    if (this.state) {
      const resource = await this.state.get(id);
      if (resource) return resource.connection;
    }
    if (this.stack) {
      const db: DatabaseConfig | undefined = this.stack.databases[id];
      if (db && db.provision === "external") {
        return targetFromExternal(db);
      }
    }
    throw new ConnectionError(
      `No ConnectionTarget for "${id}": not present in state${
        this.stack ? " and not an external database in config" : ""
      }.`,
      id,
    );
  }
}

function targetFromExternal(db: ExternalDatabase): ConnectionTarget {
  const target: ConnectionTarget = {
    engine: db.engine,
    credsRef: db.connectionString,
  };
  // exactOptionalPropertyTypes: only set optionals when actually provided.
  if (db.endpoint !== undefined) target.endpoint = db.endpoint;
  if (db.region !== undefined) target.region = db.region;
  return target;
}

/* ------------------------------------------------------------------ *
 * ConnectionManager: pool, health, observability
 * ------------------------------------------------------------------ */

interface ManagedConnection {
  readonly connection: Connection;
  readonly connector: Connector;
  readonly target: ConnectionTarget;
}

export interface ConnectionManagerOptions {
  /** Observability callbacks (tracing/metrics). Never affect control flow. */
  readonly hooks?: ObservabilityHooks;
}

/**
 * Owns the lifetime of pooled native connections keyed by database id.
 * `connect()` is idempotent (returns the live connection if already open).
 * Health and pool stats are surfaced for readiness/liveness probes; pools
 * drain via `close()` / `closeAll()` (call on SIGTERM).
 */
export class ConnectionManager {
  private readonly pool = new Map<string, ManagedConnection>();
  private readonly hooks: ObservabilityHooks;

  constructor(
    private readonly registry: ConnectionRegistry,
    opts: ConnectionManagerOptions = {},
  ) {
    this.hooks = opts.hooks ?? {};
  }

  /** Open (or reuse) the pooled native client for a database id. */
  async connect(id: string): Promise<Connection> {
    const existing = this.pool.get(id);
    if (existing) return existing.connection;

    let target: ConnectionTarget;
    try {
      target = await this.registry.targetFor(id);
    } catch (err) {
      this.hooks.onError?.(id, err);
      throw err;
    }
    const connector = this.registry.connectorFor(target);

    this.hooks.onConnect?.(id, target);
    let connection: Connection;
    try {
      connection = await connector.connect(target);
    } catch (err) {
      this.hooks.onError?.(id, err);
      throw new ConnectionError(
        `Failed to connect to "${id}" (${target.engine}): ${errorMessage(err)}`,
        id,
        err,
      );
    }
    this.pool.set(id, { connection, connector, target });
    this.hooks.onConnected?.(id, connection);
    return connection;
  }

  /** Run a connector health check for an open connection. */
  async health(id: string): Promise<HealthStatus> {
    const managed = this.getManaged(id);
    const status = await managed.connector.health(managed.connection);
    this.hooks.onHealth?.(id, status);
    return status;
  }

  /** Snapshot pool stats for an open connection (for metrics/readiness). */
  poolStats(id: string): PoolStats {
    const managed = this.getManaged(id);
    const stats = managed.connection.pool;
    this.hooks.onPool?.(id, stats);
    return stats;
  }

  /** Run migrations on an open connection (engines that support it). */
  async migrate(id: string, migrations: Migration[]): Promise<MigrationResult> {
    const managed = this.getManaged(id);
    if (!managed.connector.migrate) {
      throw new ConnectionError(
        `Engine "${managed.target.engine}" does not support migrations.`,
        id,
      );
    }
    return await managed.connector.migrate(managed.connection, migrations);
  }

  /** Roll back `count` applied migrations (newest-first), engines that support it. */
  async rollback(id: string, migrations: Migration[], count: number): Promise<MigrationResult> {
    const managed = this.getManaged(id);
    if (!managed.connector.rollback) {
      throw new ConnectionError(
        `Engine "${managed.target.engine}" does not support migrations.`,
        id,
      );
    }
    return await managed.connector.rollback(managed.connection, migrations, count);
  }

  /** Read the applied-migration rows from the tracking table. */
  async migrationStatus(id: string): Promise<AppliedMigration[]> {
    const managed = this.getManaged(id);
    if (!managed.connector.migrationStatus) {
      throw new ConnectionError(
        `Engine "${managed.target.engine}" does not support migrations.`,
        id,
      );
    }
    return await managed.connector.migrationStatus(managed.connection);
  }

  /** Resolve the ConnectionTarget an open connection is using. */
  targetOf(id: string): ConnectionTarget | null {
    return this.pool.get(id)?.target ?? null;
  }

  /** Close one connection, draining its pool. No-op if not open. */
  async close(id: string): Promise<void> {
    const managed = this.pool.get(id);
    if (!managed) return;
    try {
      await managed.connection.close();
    } catch (err) {
      this.hooks.onError?.(id, err);
      throw err;
    }
    this.pool.delete(id);
    this.hooks.onClose?.(id);
  }

  /** Close every open connection (call on SIGTERM for graceful drain). */
  async closeAll(): Promise<void> {
    const ids = [...this.pool.keys()];
    let firstError: unknown;
    for (const id of ids) {
      try {
        await this.close(id);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
  }

  private getManaged(id: string): ManagedConnection {
    const managed = this.pool.get(id);
    if (!managed) {
      throw new ConnectionError(`No active connection for "${id}". Call connect() first.`, id);
    }
    return managed;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
