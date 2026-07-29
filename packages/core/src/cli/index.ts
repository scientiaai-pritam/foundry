/**
 * scientia-db — CLI command handlers (design v1, sections 4, 7).
 *
 * Wires config + state + plan + apply + runtime into the four lifecycle
 * commands: `plan`, `apply`, `migrate`, `destroy`. The core never imports a
 * concrete provisioner or connector — they are injected via `CLIContext`. A
 * real `scientia` binary (in the app or a separate package) builds the context
 * with concrete plugins; the kernel ships the handlers + a thin `main`.
 *
 * Depends only on the other core modules.
 */

import { join } from "node:path";
import type {
  Connector,
  Migration,
  MigrationResult,
  PlanAction,
  Provisioner,
  ResourceKind,
} from "../contracts.js";
import type { Engine, Stack } from "../config/index.js";
import { loadStack } from "../config/index.js";
import { FileStateStore, type StateStore } from "../state/index.js";
import { Planner, type Plan } from "../plan/index.js";
import { ApplyOrchestrator, type ApplyResult, type Logger } from "../apply/index.js";
import { ConnectionManager, ConnectionRegistry } from "../runtime/index.js";

export { type Logger } from "../apply/index.js";
export { actionResourceId } from "../apply/index.js";

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

export interface CLIContext {
  readonly stack: Stack;
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
    path: opts.statePath ?? join(cwd, "scientia.state.json"),
  });
  return {
    stack,
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
  return await orchestrator.apply(thePlan);
}

/* ------------------------------------------------------------------ *
 * migrate
 * ------------------------------------------------------------------ */

/** Connect to a database, run migrations, then drain the connection. */
export async function runMigrate(
  ctx: CLIContext,
  dbId: string,
  migrations: Migration[],
): Promise<MigrationResult> {
  const registry = new ConnectionRegistry(ctx.connectors, {
    state: ctx.state,
    stack: ctx.stack,
  });
  const manager = new ConnectionManager(registry);
  try {
    await manager.connect(dbId);
    return await manager.migrate(dbId, migrations);
  } finally {
    await manager.closeAll();
  }
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

const COMMANDS = ["plan", "apply", "migrate", "destroy"] as const;
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
    logger.error(`Usage: scientia <plan|apply|migrate|destroy> [options]`);
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
        const result = await runApply(ctx, undefined, { continueOnError });
        logger.log(
          `Applied: ${result.succeeded} succeeded, ${result.failed} failed` +
            (result.stoppedOnError ? " (stopped on error — no rollback)" : "") + ".",
        );
        return result.failed > 0 ? 1 : 0;
      }
      case "migrate": {
        const dbId = parsed.positional[0];
        if (!dbId) {
          logger.error("Usage: scientia migrate <database-id>");
          return 2;
        }
        const result = await runMigrate(ctx, dbId, opts.migrations ?? []);
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
