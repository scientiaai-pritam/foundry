/**
 * foundry — `foundry init` scaffolding (the local-DB on-ramp).
 *
 * Scaffolds a new foundry project from a template: a `foundry.config.ts`
 * (default: instant local Postgres via `local.postgres`, pgvector-ready), a
 * first migration under `migrations/<dbId>/`, and `.gitignore` entries for the
 * local secret store + state. This kills the config-authoring friction that
 * stops people from ever reaching `foundry apply`.
 *
 * The same config is portable: change `kind` to `aws.rds-postgres` /
 * `supabase.postgres` and `foundry apply` ships to cloud instead — migrations
 * and state carry over unchanged.
 *
 * Extends the existing `migrate:new` scaffolding pattern (slugify +
 * `<id>_<slug>.up.sql`/`.down.sql`) to the config file.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "../migrations/index.js";

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

/** Raised when `foundry init` would overwrite an existing config without --force. */
export class ConfigAlreadyExistsError extends InitError {
  constructor(readonly path: string) {
    super(
      `A foundry config already exists at ${path}. Re-run with --force to overwrite, or remove it first.`,
    );
    this.name = "ConfigAlreadyExistsError";
  }
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

/** Kinds `foundry init` can scaffold out of the box. */
export const INIT_KINDS = [
  "local.postgres",
  "aws.rds-postgres",
  "supabase.postgres",
  "aws.dynamodb",
] as const;
export type InitKind = (typeof INIT_KINDS)[number];

const DEFAULT_DB_ID = "app";
const FIRST_MIGRATION_ID = "000001";
const FIRST_MIGRATION_SLUG = "init";

/** Whether a kind runs SQL migrations (postgres/redshift) vs not (dynamodb). */
function kindHasMigrations(kind: InitKind): boolean {
  return kind === "local.postgres" || kind === "aws.rds-postgres" || kind === "supabase.postgres";
}

/** Render the `databases.<id>` block for a kind. */
function renderDatabaseBlock(dbId: string, kind: InitKind): string {
  switch (kind) {
    case "local.postgres":
      return [
        `    ${dbId}: {`,
        `      engine: "postgres",`,
        `      provision: {`,
        `        kind: "local.postgres",`,
        `        // image: "pgvector/pgvector:pg16", // pgvector baked in (RAG-ready)`,
        `        // port: 5432,`,
        `        // dbName: "app",`,
        `        // username: "postgres",`,
        `      },`,
        `    },`,
      ].join("\n");
    case "aws.rds-postgres":
      return [
        `    ${dbId}: {`,
        `      engine: "postgres",`,
        `      provision: {`,
        `        kind: "aws.rds-postgres",`,
        `        dbInstanceIdentifier: "${dbId}",`,
        `        dbInstanceClass: "db.t4g.micro",`,
        `        allocatedStorage: 20,`,
        `        masterUsername: "postgres",`,
        `        // masterUserPassword is managed by RDS (ManageMasterUserPassword);`,
        `        // resolved by the connector at runtime. Set a region below.`,
        `      },`,
        `      dev: { kind: "local.postgres" }, // instant local DB: \`foundry apply --env dev\``,
        `      // region: "us-east-1",`,
        `    },`,
      ].join("\n");
    case "supabase.postgres":
      return [
        `    ${dbId}: {`,
        `      engine: "postgres",`,
        `      provision: {`,
        `        kind: "supabase.postgres",`,
        `        name: "${dbId}",`,
        `        // organizationId + region are required to create; the DB password`,
        `        // is a credsRef resolved by the connector at runtime.`,
        `      },`,
        `      dev: { kind: "local.postgres" }, // instant local DB: \`foundry apply --env dev\``,
        `    },`,
      ].join("\n");
    case "aws.dynamodb":
      return [
        `    ${dbId}: {`,
        `      engine: "dynamodb",`,
        `      provision: {`,
        `        kind: "aws.dynamodb",`,
        `        tableName: "${dbId}",`,
        `        attributeDefinitions: [{ name: "pk", type: "S" }],`,
        `        keySchema: [{ name: "pk", type: "HASH" }],`,
        `        billingMode: "pay_per_request",`,
        `      },`,
        `    },`,
      ].join("\n");
    default: {
      const _exhaustive: never = kind;
      throw new InitError(`Unsupported init kind: ${String(_exhaustive)}`);
    }
  }
}

/** Render the full `foundry.config.ts` contents. */
export function renderConfigTemplate(opts: {
  dbId: string;
  kind: InitKind;
  stackName?: string;
}): string {
  const { dbId, kind, stackName } = opts;
  const block = renderDatabaseBlock(dbId, kind);
  const header = [
    "/**",
    " * foundry.config.ts — declarative database lifecycle (scaffolded by `foundry init`).",
    " *",
    " * The default below uses `local.postgres`: an instant local Postgres (pgvector)",
    " * Docker container, started in seconds by `foundry apply`. To ship the SAME config",
    " * to a cloud, change `kind` to `aws.rds-postgres` / `supabase.postgres` — your",
    " * migrations and state carry over unchanged.",
    " *",
    " *   foundry apply        # provision (local: start the container; cloud: create the DB)",
    ` *   foundry migrate ${dbId}  # run migrations/${dbId}/`,
    ` *   foundry env ${dbId}      # print DATABASE_URL (add --write to update .env.foundry)`,
    " */",
  ].join("\n");
  const stackNameLine = stackName ? `  name: "${stackName}",\n` : "";
  return `${header}
import { defineStack } from "@foundry/core";

export default defineStack({
${stackNameLine}  databases: {
${block}
  },
});
`;
}

/** Render the first migration's up SQL (pgvector-aware for postgres kinds). */
export function renderFirstMigrationUp(dbId: string, kind: InitKind): string {
  if (!kindHasMigrations(kind)) return "";
  return [
    `-- Migration 000001 (init) for ${dbId}`,
    "",
    "-- pgvector is baked into the default local image; enable it for RAG/vector work.",
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "",
    "-- A starter table — drop or edit as needed.",
    "CREATE TABLE IF NOT EXISTS example (",
    "  id BIGSERIAL PRIMARY KEY,",
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ");",
    "",
  ].join("\n");
}

/** Render the first migration's down SQL. */
export function renderFirstMigrationDown(dbId: string, kind: InitKind): string {
  if (!kindHasMigrations(kind)) return "";
  return [
    `-- Rollback for 000001 (init) for ${dbId}`,
    "DROP TABLE IF EXISTS example;",
    "-- pgvector extension intentionally left in place (shared; drop manually if needed).",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * .gitignore management
 * ------------------------------------------------------------------ */

/** Entries init ensures exist in the project's .gitignore. */
export const GITIGNORE_ENTRIES = ["*.state.json", ".foundry/", ".env.foundry"] as const;

/**
 * Ensure the project `.gitignore` contains {@link GITIGNORE_ENTRIES}. Creates
 * the file if absent; appends missing entries under a foundry header if present.
 * Returns the path, or null if nothing changed and the file didn't exist.
 */
export async function ensureGitignore(cwd: string): Promise<string> {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length === 0) return path; // already complete

  const header = "# foundry: local state + local secret store + local env";
  const block = `\n${header}\n${missing.join("\n")}\n`;
  const next = existing.length === 0 ? block.replace(/^\n/, "") : `${existing.replace(/\n?$/, "\n")}${block}`;
  await writeFile(path, next, "utf8");
  return path;
}

/* ------------------------------------------------------------------ *
 * scaffoldInit
 * ------------------------------------------------------------------ */

export interface InitOptions {
  readonly cwd: string;
  readonly stackName?: string;
  /** Database id (object key + migration dir). Default "app". */
  readonly dbId?: string;
  /** Provisioner kind to scaffold. Default "local.postgres". */
  readonly kind?: InitKind;
  /** Overwrite an existing config. Default false. */
  readonly force?: boolean;
  /** Skip writing the first migration (postgres kinds). */
  readonly noMigration?: boolean;
}

export interface InitResult {
  readonly configPath: string;
  readonly migrationDir?: string;
  readonly upPath?: string;
  readonly downPath?: string;
  readonly gitignorePath: string;
  readonly kind: InitKind;
  readonly dbId: string;
}

/** Validate a db id: non-empty, identifier-ish (letters/digits/_/-). */
function assertValidDbId(dbId: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(dbId)) {
    throw new InitError(
      `Invalid database id "${dbId}": must start with a letter and contain only letters, digits, "_" or "-".`,
    );
  }
}

/**
 * Scaffold a foundry project: config + first migration + .gitignore entries.
 * Idempotent for the gitignore; refuses to overwrite an existing config unless
 * `force` is set. The first migration round-trips through the migrations loader.
 */
export async function scaffoldInit(opts: InitOptions): Promise<InitResult> {
  const cwd = opts.cwd;
  const dbId = opts.dbId ?? DEFAULT_DB_ID;
  assertValidDbId(dbId);
  // slugify doubles as a validation that the id is filesystem-safe.
  slugify(dbId);

  const kind = opts.kind ?? "local.postgres";
  if (!INIT_KINDS.includes(kind)) {
    throw new InitError(
      `Unsupported kind "${String(kind)}". Supported: ${INIT_KINDS.join(", ")}.`,
    );
  }

  const configPath = join(cwd, "foundry.config.ts");
  if (existsSync(configPath) && !opts.force) {
    throw new ConfigAlreadyExistsError(configPath);
  }

  await mkdir(cwd, { recursive: true });
  const config = renderConfigTemplate({ dbId, kind, ...(opts.stackName !== undefined ? { stackName: opts.stackName } : {}) });
  await writeFile(configPath, config, "utf8");

  let migrationDir: string | undefined;
  let upPath: string | undefined;
  let downPath: string | undefined;
  if (!opts.noMigration && kindHasMigrations(kind)) {
    migrationDir = join(cwd, "migrations", dbId);
    upPath = join(migrationDir, `${FIRST_MIGRATION_ID}_${FIRST_MIGRATION_SLUG}.up.sql`);
    downPath = join(migrationDir, `${FIRST_MIGRATION_ID}_${FIRST_MIGRATION_SLUG}.down.sql`);
    await mkdir(migrationDir, { recursive: true });
    await writeFile(upPath, renderFirstMigrationUp(dbId, kind), "utf8");
    await writeFile(downPath, renderFirstMigrationDown(dbId, kind), "utf8");
  }

  const gitignorePath = await ensureGitignore(cwd);

  return {
    configPath,
    ...(migrationDir !== undefined ? { migrationDir } : {}),
    ...(upPath !== undefined ? { upPath } : {}),
    ...(downPath !== undefined ? { downPath } : {}),
    gitignorePath,
    kind,
    dbId,
  };
}
