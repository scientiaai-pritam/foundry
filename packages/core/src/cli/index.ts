/**
 * foundry — CLI command handlers (design v1, sections 4, 7).
 *
 * Wires config + state + plan + apply + runtime into the four lifecycle
 * commands: `plan`, `apply`, `migrate`, `destroy`. The core never imports a
 * concrete provisioner or connector — they are injected via `CLIContext`. A
 * real `foundry` binary (in the app or a separate package) builds the context
 * with concrete plugins; the kernel ships the handlers + a thin `main`.
 *
 * Depends only on the other core modules.
 */

import { join, relative } from "node:path";
import type {
  AppliedMigration,
  Connector,
  Migration,
  MigrationResult,
  PlanAction,
  Provisioner,
  ResourceKind,
} from "../contracts.js";
import type { Engine, MigrationsConfig, Stack } from "../config/index.js";
import { loadStack, resolveStackForEnv } from "../config/index.js";
import { FileStateStore, defaultStatePath, type StateStore } from "../state/index.js";
import { Planner, type Plan } from "../plan/index.js";
import { ApplyOrchestrator, type ApplyResult, type ApplyStepResult, type Logger } from "../apply/index.js";
import { ConnectionManager, ConnectionRegistry } from "../runtime/index.js";
import { loadMigrations, resolveMigrationDir, checksumMigration, createMigration } from "../migrations/index.js";
import type { LoadedMigration, CreatedMigration } from "../migrations/index.js";
import {
  loadLocalEnvIntoProcess,
  resolvePostgresConnection,
  formatConnectionVars,
  writeEnvFileEntries,
  localEnvFilePath,
  EnvResolutionError,
  type ResolveConnectionOptions,
  type EnvFormat,
} from "../env/index.js";
import {
  scaffoldInit,
  ConfigAlreadyExistsError,
  InitError,
  INIT_KINDS,
  type InitKind,
  type InitOptions,
  type InitResult,
} from "../init/index.js";

export { type Logger } from "../apply/index.js";
export { actionResourceId } from "../apply/index.js";

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

export interface CLIContext {
  readonly stack: Stack;
  readonly cwd: string;
  readonly state: StateStore;
  readonly provisioners: Map<ResourceKind, Provisioner>;
  readonly connectors: Map<Engine, Connector>;
  readonly logger?: Logger;
  /** Override the default Planner (e.g. inject a replacePredicate). */
  readonly planner?: Planner;
}

export interface BuildContextOptions {
  readonly cwd?: string;
  readonly statePath?: string;
  /** Environment selector (`--env dev`); when set, the stack is dev-resolved and
   * state is scoped to `foundry.state.dev.json`. */
  readonly env?: "dev";
  /** Inject a stack directly (tests / programmatic); otherwise loaded from disk. */
  readonly stack?: Stack;
  readonly provisioners?: Map<ResourceKind, Provisioner>;
  readonly connectors?: Map<Engine, Connector>;
  readonly logger?: Logger;
  readonly planner?: Planner;
}

/** Build a CLIContext from defaults: loadStack(cwd) + FileStateStore(cwd). */
export async function buildContext(opts: BuildContextOptions = {}): Promise<CLIContext> {
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? console;
  const loaded = opts.stack ?? (await loadStack({ cwd }));
  const { stack, fallbacks } = resolveStackForEnv(loaded, opts.env);
  if (fallbacks.length > 0) {
    logger.warn?.(
      `--env dev: no \`dev\` block on [${fallbacks.join(", ")}]; falling back to \`provision\`.`,
    );
  }
  const state: StateStore = new FileStateStore({
    path: opts.statePath ?? defaultStatePath(cwd, opts.env),
  });
  return {
    stack,
    cwd,
    state,
    provisioners: opts.provisioners ?? new Map(),
    connectors: opts.connectors ?? new Map(),
    logger,
    // exactOptionalPropertyTypes: include `planner` only when actually provided.
    ...(opts.planner !== undefined ? { planner: opts.planner } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * plan
 * ------------------------------------------------------------------ */

export interface PlanOptions {
  /** Refresh drift via provisioner.read() before diffing (design §6). */
  readonly refresh?: boolean;
}

/** Compute a plan against the current state. */
export async function runPlan(ctx: CLIContext, opts: PlanOptions = {}): Promise<Plan> {
  const planner =
    ctx.planner ??
    new Planner({ provisioners: ctx.provisioners, refresh: opts.refresh ?? false });
  const current = (await ctx.state.read()).resources;
  return await planner.plan(ctx.stack, current);
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

export interface ApplyOptions {
  readonly continueOnError?: boolean;
  /** After apply, run pending migrations against each produced ConnectionTarget. */
  readonly migrate?: boolean;
}

/** Apply a plan (or a freshly computed one). Stop-on-error, no rollback. */
export async function runApply(
  ctx: CLIContext,
  plan?: Plan,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const thePlan = plan ?? (await runPlan(ctx));
  const orchestrator = new ApplyOrchestrator({
    provisioners: ctx.provisioners,
    state: ctx.state,
    continueOnError: opts.continueOnError ?? false,
    ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
  });
  const result = await orchestrator.apply(thePlan);
  return opts.migrate ? await runPostApplyMigrations(ctx, result) : result;
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * After a successful apply, for each create/update/replace that produced a
 * ConnectionTarget, connect and run pending `up` migrations. Migrations never
 * run for delete/noop, and a migration failure does NOT roll back provisioning
 * (stop-on-error, no auto-rollback) — it is logged and the step is annotated.
 */
async function runPostApplyMigrations(ctx: CLIContext, result: ApplyResult): Promise<ApplyResult> {
  const newResults: ApplyStepResult[] = [];
  for (const step of result.results) {
    let summary: { applied: number; skipped: number; errors: number } | undefined;
    const state = step.state;
    if (
      step.status === "applied" &&
      (step.op === "create" || step.op === "update" || step.op === "replace") &&
      state !== undefined
    ) {
      summary = await tryRunMigrations(ctx, state.id).catch((err) => {
        ctx.logger?.error?.(`[${state.id}] migrations failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
    }
    newResults.push(summary !== undefined ? { ...step, migrations: summary } : step);
  }
  return { ...result, results: newResults };
}

async function tryRunMigrations(
  ctx: CLIContext,
  dbId: string,
): Promise<{ applied: number; skipped: number; errors: number } | undefined> {
  const db = ctx.stack.databases[dbId];
  const cfg = db && "migrations" in db ? (db as { migrations?: MigrationsConfig }).migrations : undefined;
  if (cfg?.enabled === false) return undefined;
  if (db === undefined) return undefined;

  let migrations: LoadedMigration[];
  try {
    migrations = await loadMigrations(resolveMigrationDir(ctx.cwd, dbId, cfg));
  } catch (err) {
    if (isENOENT(err)) return undefined;
    throw err;
  }
  if (migrations.length === 0) return undefined;

  const connector = ctx.connectors.get(db.engine);
  if (connector === undefined || connector.migrate === undefined) return undefined;

  const registry = new ConnectionRegistry(ctx.connectors, { state: ctx.state, stack: ctx.stack });
  const manager = new ConnectionManager(registry);
  try {
    await manager.connect(dbId);
    const res = await manager.migrate(dbId, migrations);
    ctx.logger?.info?.(
      `[${dbId}] migrations: ${res.applied.length} applied, ${res.skipped.length} skipped, ${res.errors.length} errors`,
    );
    return { applied: res.applied.length, skipped: res.skipped.length, errors: res.errors.length };
  } finally {
    await manager.closeAll().catch(() => {
      /* best-effort drain */
    });
  }
}

/* ------------------------------------------------------------------ *
 * migrate
 * ------------------------------------------------------------------ */

/** Connect to a database, run pending `up` migrations, then drain. */
export async function runMigrate(
  ctx: CLIContext,
  dbId: string,
  migrations: Migration[],
): Promise<MigrationResult> {
  const { manager } = await connectForMigrate(ctx, dbId);
  try {
    return await manager.migrate(dbId, migrations);
  } finally {
    await manager.closeAll();
  }
}

export interface MigrateDownOptions {
  /** Number of migrations to roll back (newest-first). Default 1. */
  readonly count?: number;
}

/** Connect, roll back `count` applied migrations, then drain. */
export async function runMigrateDown(
  ctx: CLIContext,
  dbId: string,
  migrations: Migration[],
  opts: MigrateDownOptions = {},
): Promise<MigrationResult> {
  const { manager } = await connectForMigrate(ctx, dbId);
  try {
    return await manager.rollback(dbId, migrations, opts.count ?? 1);
  } finally {
    await manager.closeAll();
  }
}

/** Snapshot of migration state for a database (applied vs on-disk). */
export interface MigrationStatus {
  readonly applied: AppliedMigration[];
  readonly pending: Migration[];
  readonly tampered: AppliedMigration[];
}

/** Connect, read applied rows, diff against on-disk migrations, then drain. */
export async function runMigrateStatus(
  ctx: CLIContext,
  dbId: string,
  migrations: Migration[],
): Promise<MigrationStatus> {
  const { manager } = await connectForMigrate(ctx, dbId);
  try {
    const applied = await manager.migrationStatus(dbId);
    const appliedIds = new Set(applied.map((a) => a.id));
    const diskById = new Map(migrations.map((m) => [m.id, m]));
    return {
      applied,
      pending: migrations.filter((m) => !appliedIds.has(m.id)),
      tampered: applied.filter((a) => {
        const onDisk = diskById.get(a.id);
        return onDisk !== undefined && checksumMigration(onDisk.up) !== a.checksum;
      }),
    };
  } finally {
    await manager.closeAll();
  }
}

/** Plan-only (no execution). `hasWork` is the CI-gate signal. */
export async function runMigrateDryRun(
  ctx: CLIContext,
  dbId: string,
  migrations: Migration[],
): Promise<{ status: MigrationStatus; hasWork: boolean }> {
  const status = await runMigrateStatus(ctx, dbId, migrations);
  return { status, hasWork: status.pending.length > 0 || status.tampered.length > 0 };
}

/** Human-readable status report. */
export function formatMigrationStatus(dbId: string, status: MigrationStatus): string {
  const lines: string[] = [`Migrations for ${dbId}:`];
  lines.push(`  Applied (${status.applied.length}):`);
  for (const a of status.applied) lines.push(`    + ${a.id} ${a.description ?? ""}`.trimEnd());
  lines.push(`  Pending (${status.pending.length}):`);
  for (const p of status.pending) lines.push(`    ? ${p.id} ${p.description}`);
  if (status.tampered.length > 0) {
    lines.push(`  TAMPERED (${status.tampered.length}):`);
    for (const t of status.tampered) lines.push(`    ! ${t.id} ${t.description ?? ""} (checksum mismatch)`.trimEnd());
  }
  return lines.join("\n");
}

/** Resolve the on-disk migration directory for a database (cwd + cfg.dir aware). */
function migrationDirFor(ctx: CLIContext, dbId: string): string {
  const db = ctx.stack.databases[dbId];
  const cfg = db && "migrations" in db ? (db as { migrations?: MigrationsConfig }).migrations : undefined;
  return resolveMigrationDir(ctx.cwd, dbId, cfg);
}

/** Load on-disk migrations for a database; ENOENT (no dir) => empty list. */
export async function loadMigrationsForDb(ctx: CLIContext, dbId: string): Promise<LoadedMigration[]> {
  const dir = migrationDirFor(ctx, dbId);
  try {
    return await loadMigrations(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Scaffold a paired up/down migration at the next free id for a database. Writes
 * `<id>_<slug>.up.sql` / `.down.sql` into the database's migration dir (created
 * if absent). `name` is slugified; the next id is one past the highest existing.
 */
export async function runMigrateNew(
  ctx: CLIContext,
  dbId: string,
  name: string,
): Promise<CreatedMigration> {
  const dir = migrationDirFor(ctx, dbId);
  const existing = await loadMigrationsForDb(ctx, dbId);
  return createMigration(dir, name, existing);
}

/** Build a one-shot ConnectionManager for a migrate command. */
async function connectForMigrate(
  ctx: CLIContext,
  dbId: string,
): Promise<{ manager: ConnectionManager }> {
  const registry = new ConnectionRegistry(ctx.connectors, {
    state: ctx.state,
    stack: ctx.stack,
  });
  const manager = new ConnectionManager(registry);
  await manager.connect(dbId);
  return { manager };
}

/* ------------------------------------------------------------------ *
 * env — resolve target+secret → DATABASE_URL
 * ------------------------------------------------------------------ */

/** Default env-file path that `foundry env --write` updates. */
export const DEFAULT_ENV_OUTFILE = ".env.foundry";
/** Default variable name emitted by `foundry env`. */
export const DEFAULT_ENV_VAR = "DATABASE_URL";

export interface EnvOptions {
  /** Write/update the value to an env file (default <cwd>/.env.foundry). */
  readonly write?: boolean;
  /** Variable name (default DATABASE_URL). */
  readonly varName?: string;
  /** Env-file path to write (default <cwd>/.env.foundry). Ignored unless write. */
  readonly outFile?: string;
  /** Output format (default dotenv). */
  readonly format?: EnvFormat;
  /** Secret resolver for { secretId } credsRefs (cloud-managed secrets). */
  readonly secretResolver?: ResolveConnectionOptions["secretResolver"];
}

export interface EnvResult {
  readonly url: string;
  readonly varName: string;
  /** Single `<varName>=<url>` line (backward-compat / single-var callers). */
  readonly line: string;
  /** Full emitted variable set: DATABASE_URL + PG*. */
  readonly vars: Record<string, string>;
  /** Formatted output for `format` (dotenv/shell/json). */
  readonly text: string;
  readonly format: EnvFormat;
  readonly writtenTo?: string;
}

/**
 * Resolve a database's ConnectionTarget + credsRef to a connection string
 * (DATABASE_URL) plus the standard PG* vars, loading the local secret store
 * first. Prints nothing — callers (the CLI) format the result. With `write`,
 * upserts the full var set into an env file so the app can connect without
 * foundry in its runtime path.
 */
export async function runEnv(
  ctx: CLIContext,
  dbId: string,
  opts: EnvOptions = {},
): Promise<EnvResult> {
  // Load the local secret store (.foundry/local.env) into process.env WITHOUT
  // overriding anything already set — this is what makes a local
  // `credsRef: { from: "env:..." }` resolvable after `foundry apply`.
  await loadLocalEnvIntoProcess(ctx.cwd);

  const registry = new ConnectionRegistry(ctx.connectors, {
    state: ctx.state,
    stack: ctx.stack,
  });
  const target = await registry.targetFor(dbId);
  const secretResolver = opts.secretResolver !== undefined ? { secretResolver: opts.secretResolver } : {};
  const parts = await resolvePostgresConnection(target, secretResolver);

  const varName = opts.varName ?? DEFAULT_ENV_VAR;
  const vars: Record<string, string> = {
    [varName]: parts.url,
    PGHOST: parts.host,
    PGPORT: String(parts.port),
    PGUSER: parts.user,
    PGPASSWORD: parts.password,
    PGDATABASE: parts.database,
  };
  const format: EnvFormat = opts.format ?? "dotenv";
  const text = formatConnectionVars(vars, format);
  const line = `${varName}=${parts.url}`;

  let writtenTo: string | undefined;
  if (opts.write) {
    writtenTo = opts.outFile ?? join(ctx.cwd, DEFAULT_ENV_OUTFILE);
    await writeEnvFileEntries(writtenTo, vars);
  }
  return {
    url: parts.url,
    varName,
    line,
    vars,
    text,
    format,
    ...(writtenTo !== undefined ? { writtenTo } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * destroy
 * ------------------------------------------------------------------ */

export class DestroyRequiresForceError extends Error {
  constructor(
    message: string,
    readonly resourceIds: readonly string[],
  ) {
    super(message);
    this.name = "DestroyRequiresForceError";
  }
}

export interface DestroyOptions {
  /** Confirm destruction of tracked resources (design §7: irreversible). */
  readonly force?: boolean;
}

/**
 * Destroy all tracked resources. Requires `force` (design §7). Builds a
 * destroy plan (every current resource -> delete, nothing desired) and applies
 * it. Per-resource `protect` is enforced by the provisioner; without `--force`
 * the kernel refuses wholesale.
 */
export async function runDestroy(ctx: CLIContext, opts: DestroyOptions = {}): Promise<ApplyResult> {
  const state = await ctx.state.read();
  const resources = Object.values(state.resources);
  if (resources.length === 0) {
    ctx.logger?.log?.("Nothing to destroy: state is empty.");
    return { results: [], succeeded: 0, failed: 0, stoppedOnError: false };
  }
  if (!opts.force) {
    const ids = resources.map((r) => r.id);
    const listing = resources.map((r) => `  - ${r.id} (${r.kind}) — irreversible data loss`).join("\n");
    throw new DestroyRequiresForceError(
      `Refusing to destroy without --force. Tracked resources:\n${listing}`,
      ids,
    );
  }
  const planner = new Planner({ provisioners: ctx.provisioners });
  const plan = await planner.plan({ databases: {} }, state.resources);
  const orchestrator = new ApplyOrchestrator({
    provisioners: ctx.provisioners,
    state: ctx.state,
    ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
  });
  return await orchestrator.apply(plan);
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Human-readable plan summary. */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  if (plan.drift.length > 0) {
    lines.push("Drift detected:");
    for (const d of plan.drift) lines.push(`  ! ${d.id}: ${d.detail}`);
    lines.push("");
  }
  lines.push("Plan:");
  for (const action of plan.actions) {
    lines.push(`  ${formatAction(action)}`);
  }
  const counts = countOps(plan);
  const summary = Object.entries(counts)
    .map(([op, n]) => `${n} ${op}`)
    .join(", ");
  lines.push("");
  lines.push(`(${summary})`);
  return lines.join("\n");
}

function formatAction(action: PlanAction): string {
  switch (action.op) {
    case "create":
      return `+ create  ${action.spec.id} (${action.spec.kind})`;
    case "update":
      return `~ update  ${action.spec.id} — ${action.changedFields.join(", ")}`;
    case "replace":
      return `± replace ${action.spec.id} — ${action.reason}`;
    case "delete":
      return `- delete  ${action.state.id} (${action.state.kind})`;
    case "noop":
      return `  noop    ${action.id} — ${action.reason}`;
  }
}

function countOps(plan: Plan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of plan.actions) {
    counts[a.op] = (counts[a.op] ?? 0) + 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * Argument parsing + main
 * ------------------------------------------------------------------ */

const COMMANDS = ["plan", "apply", "migrate", "migrate:new", "destroy", "init", "env"] as const;
export type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
  readonly command: Command | undefined;
  readonly flags: Record<string, string | boolean>;
  readonly positional: string[];
}

/** Minimal `--flag value` / `--flag` parser. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: Command | undefined;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!command && (COMMANDS as readonly string[]).includes(arg)) {
      command = arg as Command;
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

export interface MainOptions {
  readonly cwd?: string;
  readonly provisioners?: Map<ResourceKind, Provisioner>;
  readonly connectors?: Map<Engine, Connector>;
  readonly migrations?: Migration[];
  /** Secret resolver for `foundry env` ({ secretId } credsRefs, cloud-managed). */
  readonly secretResolver?: ResolveConnectionOptions["secretResolver"];
}

/**
 * Entry point: parse argv, build a context, dispatch to a command handler.
 * Returns a process exit code (0 = success). `plan` works without any plugins
 * (kernel default diff); `apply`/`destroy`/`migrate` require the relevant
 * provisioners/connectors to be injected.
 */
export async function main(
  argv: readonly string[],
  opts: MainOptions = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  const logger = console satisfies Logger;
  if (!parsed.command) {
    logger.error(`Usage: foundry <init|plan|apply|migrate|migrate:new|destroy|env> [options]`);
    return 2;
  }
  const force = parsed.flags["force"] === true;
  const refresh =
    parsed.flags["refresh"] === true || parsed.flags["refresh-only"] === true;
  const continueOnError = parsed.flags["continue-on-error"] === true;

  try {
    // init: no config exists yet, so it must run BEFORE context build
    // (buildContext calls loadStack, which would throw). It needs only cwd.
    if (parsed.command === "init") {
      const cwdFlag = parsed.flags["cwd"];
      const cwd = typeof cwdFlag === "string" ? cwdFlag : opts.cwd ?? process.cwd();
      const stackName = parsed.positional[0];
      const dbIdFlag = parsed.flags["db-id"];
      const kindFlag = parsed.flags["kind"];
      const initOpts: InitOptions = {
        cwd,
        ...(stackName !== undefined ? { stackName } : {}),
        ...(typeof dbIdFlag === "string" ? { dbId: dbIdFlag } : {}),
        ...(typeof kindFlag === "string" ? { kind: kindFlag as InitKind } : {}),
        ...(force ? { force } : {}),
        ...(parsed.flags["no-migration"] === true ? { noMigration: true } : {}),
      };
      try {
        const result = await scaffoldInit(initOpts);
        logger.log(`Initialized foundry project in ${relative(cwd, result.configPath) || "."}`);
        logger.log(`  kind: ${result.kind}, database: ${result.dbId}`);
        if (result.upPath) {
          logger.log(`  first migration: ${relative(cwd, result.upPath)}`);
        }
        logger.log(`  gitignore: ${relative(cwd, result.gitignorePath)}`);
        logger.log("");
        logger.log("Next steps:");
        logger.log("  foundry apply        # start the local DB (Docker)");
        logger.log(`  foundry migrate ${result.dbId}  # run migrations/${result.dbId}/`);
        logger.log(`  foundry env ${result.dbId}      # print DATABASE_URL (--write for .env.foundry)`);
        return 0;
      } catch (err) {
        if (err instanceof ConfigAlreadyExistsError) {
          logger.error(err.message);
          return 2;
        }
        if (err instanceof InitError) {
          logger.error(`${err.name}: ${err.message}`);
          return 2;
        }
        logger.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    const cwdFlag = parsed.flags["cwd"];
    const cwd = typeof cwdFlag === "string" ? cwdFlag : opts.cwd;

    // --env: validated once at the context boundary. Only "dev" is recognized;
    // an unknown value is a usage error (exit 2) before any config load.
    const envRaw = parsed.flags["env"];
    if (envRaw !== undefined && envRaw !== "dev") {
      logger.error(`--env currently accepts only "dev" (got "${String(envRaw)}").`);
      return 2;
    }
    const env = envRaw === "dev" ? "dev" : undefined;

    const ctx = await buildContext({
      // Conditional spreads keep optional props absent (exactOptionalPropertyTypes).
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(opts.provisioners !== undefined ? { provisioners: opts.provisioners } : {}),
      ...(opts.connectors !== undefined ? { connectors: opts.connectors } : {}),
      logger,
    });

    switch (parsed.command) {
      case "plan": {
        const plan = await runPlan(ctx, { refresh });
        logger.log(formatPlan(plan));
        return 0;
      }
      case "apply": {
        const result = await runApply(ctx, undefined, {
          continueOnError,
          migrate: parsed.flags["migrate"] === true,
        });
        logger.log(
          `Applied: ${result.succeeded} succeeded, ${result.failed} failed` +
            (result.stoppedOnError ? " (stopped on error — no rollback)" : "") + ".",
        );
        return result.failed > 0 ? 1 : 0;
      }
      case "migrate:new": {
        const dbId = parsed.positional[0];
        const name = parsed.positional[1];
        if (!dbId || !name) {
          logger.error("Usage: foundry migrate:new <database-id> <name>");
          return 2;
        }
        try {
          const created = await runMigrateNew(ctx, dbId, name);
          logger.log(`Created migration ${created.id} (${created.slug}) for ${dbId}:`);
          logger.log(`  ${relative(ctx.cwd, created.upPath)}`);
          logger.log(`  ${relative(ctx.cwd, created.downPath)}`);
          return 0;
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }
      case "migrate": {
        const dbId = parsed.positional[0];
        if (!dbId) {
          logger.error("Usage: foundry migrate <database-id> [--down N] [--status] [--dry-run]");
          return 2;
        }
        const migrations = opts.migrations ?? (await loadMigrationsForDb(ctx, dbId));
        if (parsed.flags["status"] === true) {
          const status = await runMigrateStatus(ctx, dbId, migrations);
          logger.log(formatMigrationStatus(dbId, status));
          return status.tampered.length > 0 ? 1 : 0;
        }
        if (parsed.flags["dry-run"] === true) {
          const { status, hasWork } = await runMigrateDryRun(ctx, dbId, migrations);
          logger.log(formatMigrationStatus(dbId, status));
          return hasWork ? 1 : 0;
        }
        if (parsed.flags["down"] !== undefined) {
          const raw = parsed.flags["down"];
          const count = raw === true ? 1 : Number(raw);
          if (!Number.isInteger(count) || count < 1) {
            logger.error(`--down requires a positive integer (got "${String(raw)}")`);
            return 2;
          }
          const result = await runMigrateDown(ctx, dbId, migrations, { count });
          logger.log(
            `Rolled back ${dbId}: ${result.applied.length} down, ${result.errors.length} errors.`,
          );
          return result.errors.length > 0 ? 1 : 0;
        }
        const result = await runMigrate(ctx, dbId, migrations);
        logger.log(
          `Migrated ${dbId}: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.errors.length} errors.`,
        );
        return result.errors.length > 0 ? 1 : 0;
      }
      case "destroy": {
        const result = await runDestroy(ctx, { force });
        logger.log(
          `Destroyed: ${result.succeeded} succeeded, ${result.failed} failed` +
            (result.stoppedOnError ? " (stopped on error — no rollback)" : "") + ".",
        );
        return result.failed > 0 ? 1 : 0;
      }
      case "env": {
        const dbId = parsed.positional[0];
        if (!dbId) {
          logger.error("Usage: foundry env <database-id> [--write] [--var NAME] [--out-file PATH] [--format shell|dotenv|json]");
          return 2;
        }
        const formatRaw = parsed.flags["format"];
        let format: EnvFormat | undefined;
        if (typeof formatRaw === "string") {
          if (formatRaw !== "dotenv" && formatRaw !== "shell" && formatRaw !== "json") {
            logger.error(`--format must be one of: shell, dotenv, json (got "${formatRaw}")`);
            return 2;
          }
          format = formatRaw;
        }
        try {
          const result = await runEnv(ctx, dbId, {
            ...(parsed.flags["write"] === true ? { write: true } : {}),
            ...(typeof parsed.flags["var"] === "string" ? { varName: parsed.flags["var"] } : {}),
            ...(typeof parsed.flags["out-file"] === "string"
              ? { outFile: parsed.flags["out-file"] }
              : {}),
            ...(format !== undefined ? { format } : {}),
            ...(opts.secretResolver !== undefined ? { secretResolver: opts.secretResolver } : {}),
          });
          if (result.writtenTo !== undefined) {
            logger.log(`Wrote ${Object.keys(result.vars).length} vars to ${relative(ctx.cwd, result.writtenTo) || "."}`);
          } else {
            logger.log(result.text);
          }
          return 0;
        } catch (err) {
          if (err instanceof EnvResolutionError) {
            const hint = err.hint !== undefined ? `\n  hint: ${err.hint}` : "";
            logger.error(`${err.name}: ${err.message}${hint}`);
            return 1;
          }
          logger.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }
    }
  } catch (err) {
    logger.error(`${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  // Unreachable guard for the type checker.
  return 1;
}
