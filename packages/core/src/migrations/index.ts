/**
 * @foundry/core — migrations loader & helpers (pure functions).
 *
 * Reads a per-database migration directory, parses paired `<id>_<slug>.up.sql`
 * / `.down.sql` files, orders them by id, and computes a sha256 checksum of the
 * up SQL. No DB access — the connectors own execution (see Connector.migrate).
 *
 * `checksumMigration` is single-sourced here so every connector computes the
 * same checksum for the same SQL.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationsConfig } from "../config/index.js";

/** A migration loaded from disk (structurally compatible with `Migration`). */
export interface LoadedMigration {
  /** Canonical 6-digit zero-padded id, e.g. "000001". */
  readonly id: string;
  /** Slug parsed from the filename, e.g. "create_users". */
  readonly description: string;
  /** Raw up SQL. */
  readonly up: string;
  /** Raw down SQL, if a paired .down.sql exists. */
  readonly down?: string;
  /** Source filename (basename), for error messages. */
  readonly source: string;
}

const FILE_RE = /^(\d{1,6})_([a-z0-9_]+)\.up\.sql$/;
const UP_SUFFIX = ".up.sql";
const DOWN_SUFFIX = ".down.sql";

/**
 * Load and order migrations from a directory. Throws on a `.up.sql` whose name
 * does not match `<1-6 digits>_<slug>.up.sql`, on a duplicate canonical id, or
 * on a read error. Non `.up.sql`/`.down.sql` files are ignored; an orphan
 * `.down.sql` (no matching `.up.sql`) is warned and ignored.
 */
export async function loadMigrations(dir: string): Promise<LoadedMigration[]> {
  const entries = await readdir(dir);
  const upFiles = entries.filter((e) => e.endsWith(UP_SUFFIX)).sort();
  const byId = new Map<string, LoadedMigration>();

  for (const file of upFiles) {
    const match = FILE_RE.exec(file);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${file}" in ${dir}: expected "<id>_<slug>.up.sql" ` +
          `where id is 1-6 digits and slug is lowercase letters/digits/underscores.`,
      );
    }
    const num = Number.parseInt(match[1]!, 10);
    const id = String(num).padStart(6, "0");
    const description = match[2]!;
    if (byId.has(id)) {
      throw new Error(
        `Duplicate migration id "${id}" in ${dir}: "${file}" collides with "${byId.get(id)!.source}".`,
      );
    }
    const up = await readFile(join(dir, file), "utf8");
    const downFile = `${file.slice(0, -UP_SUFFIX.length)}${DOWN_SUFFIX}`;
    const hasDown = entries.includes(downFile);
    const down = hasDown ? await readFile(join(dir, downFile), "utf8") : undefined;

    byId.set(id, {
      id,
      description,
      up,
      ...(down !== undefined ? { down } : {}),
      source: file,
    });
  }

  for (const e of entries) {
    if (e.endsWith(DOWN_SUFFIX)) {
      const up = `${e.slice(0, -DOWN_SUFFIX.length)}${UP_SUFFIX}`;
      if (!entries.includes(up)) {
        console.warn(`Warning: orphan migration down-file "${e}" in ${dir} (no matching .up.sql); ignored.`);
      }
    }
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** sha256 hex of the up SQL — single-sourced so all connectors agree. */
export function checksumMigration(up: string): string {
  return createHash("sha256").update(up, "utf8").digest("hex");
}

/** Resolve the migration directory for a database. Default: <cwd>/migrations/<dbId>/. */
export function resolveMigrationDir(cwd: string, dbId: string, cfg?: MigrationsConfig): string {
  if (cfg?.dir) return join(cwd, cfg.dir);
  return join(cwd, "migrations", dbId);
}
