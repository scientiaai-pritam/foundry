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
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
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

const SLUG_INVALID = /[^a-z0-9]+/g;

/**
 * Derive a filesystem-safe slug (`[a-z0-9_]+`) from a free-form name, matching
 * the loader's filename contract. Throws if the name yields an empty slug.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(SLUG_INVALID, "_")
    .replace(/^_+|_+$/g, "");
  if (slug.length === 0) {
    throw new Error(
      `Cannot derive a migration slug from "${name}": the slug must contain at least one letter or digit.`,
    );
  }
  return slug;
}

const ID_MAX = 999999;

/**
 * Next canonical 6-digit id (one past the highest existing id). Throws if the
 * next id would overflow the loader's 6-digit limit.
 */
export function nextMigrationId(existing: readonly { id: string }[]): string {
  let max = 0;
  for (const m of existing) {
    const n = Number.parseInt(m.id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = max + 1;
  if (next > ID_MAX) {
    throw new Error(
      `Migration id overflow: next id ${next} would exceed the 6-digit limit (${ID_MAX}). Archive or renumber older migrations.`,
    );
  }
  return String(next).padStart(6, "0");
}

/** Result of scaffolding a new migration pair. */
export interface CreatedMigration {
  readonly id: string;
  readonly slug: string;
  readonly upPath: string;
  readonly downPath: string;
}

/**
 * Scaffold a paired `<id>_<slug>.up.sql` / `.down.sql` set at the next free id
 * in `dir` (creating the directory if needed). The written files round-trip
 * through {@link loadMigrations}. `name` is slugified; `existing` is the
 * already-loaded migration list for that directory (to pick the next id).
 */
export async function createMigration(
  dir: string,
  name: string,
  existing: readonly LoadedMigration[],
): Promise<CreatedMigration> {
  const id = nextMigrationId(existing);
  const slug = slugify(name);
  const upPath = join(dir, `${id}_${slug}.up.sql`);
  const downPath = join(dir, `${id}_${slug}.down.sql`);
  await mkdir(dir, { recursive: true });
  await writeFile(upPath, `-- Migration ${id}: ${slug}\n\n`);
  await writeFile(downPath, `-- Rollback for ${id}: ${slug}\n\n`);
  return { id, slug, upPath, downPath };
}
