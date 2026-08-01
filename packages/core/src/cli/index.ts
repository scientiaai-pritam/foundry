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
import { loadStack } from "../config/index.js";
import { FileStateStore, type StateStore } from "../state/index.js";
import { Planner, type Plan } from "../plan/index.js";
import { ApplyOrchestrator, type ApplyResult, type ApplyStepResult, type Logger } from "../apply/index.js";
import { ConnectionManager, ConnectionRegistry } from "../runtime/index.js";
import { loadMigrations, resolveMigrationDir, checksumMigration, createMigration } from "../migrations/index.js";
import type { LoadedMigration, CreatedMigration } from "../migrations/index.js";

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
  readonly provisioners?: Map<ResourceKind, Provisioner>;
  readonly connectors?: Map<Engine, Connector>;
  readonly logger?: Logger;
  readonly planner?: Planner;
}

/** Build a CLIContext from defaults: loadStack(cwd) + FileStateStore(cwd). */
export async function buildContext(opts: BuildContextOptions = {}): Promise<CLIContext> {
  const cwd = opts.cwd ?? process.cwd();
  const stack = await loadStack({ cwd });
  const state: StateStore = new FileStateStore({
    path: opts.statePath ?? join(cwd, "foundry.state.json"),
  });
  return {
    stack,
    cwd,
    state,
    provisioners: opts.provisioners ?? new Map(),
    connectors: opts.connectors ?? new Map(),
    logger: opts.logger ?? console,
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

const COMMANDS = ["plan", "apply", "migrate", "migrate:new", "destroy"] as const;
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
    logger.error(`Usage: foundry <plan|apply|migrate|migrate:new|destroy> [options]`);
    return 2;
  }
  const force = parsed.flags["force"] === true;
  const refresh =
    parsed.flags["refresh"] === true || parsed.flags["refresh-only"] === true;
  const continueOnError = parsed.flags["continue-on-error"] === true;

  try {
    const cwdFlag = parsed.flags["cwd"];
    const cwd = typeof cwdFlag === "string" ? cwdFlag : opts.cwd;
    const ctx = await buildContext({
      // Conditional spreads keep optional props absent (exactOptionalPropertyTypes).
      ...(cwd !== undefined ? { cwd } : {}),
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
    }
  } catch (err) {
    logger.error(`${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  // Unreachable guard for the type checker.
  return 1;
}
