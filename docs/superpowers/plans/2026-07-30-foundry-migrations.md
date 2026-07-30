# Foundry Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the stubbed `foundry migrate` into a real, integrity-checked migration system (imperative `up`/`down` SQL + sha256 tamper detection) and wire it into the provision→connect lifecycle via `apply --migrate`.

**Architecture:** A new pure `migrations/` module in `@foundry/core` owns disk loading, ordering, and checksumming. The `Connector` contract gains optional `rollback?` / `migrationStatus?` (next to the existing `migrate?`); the postgres + redshift connectors own all `__foundry_migrations` SQL and the checksum/tamper logic (single-sourcing `checksumMigration` from core). The CLI loads migrations from `migrations/<dbId>/` and dispatches `up` / `--down` / `--status` / `--dry-run`; `apply --migrate` runs a post-provision pass over each produced `ConnectionTarget`.

**Tech Stack:** TypeScript 5.5 (strict), Node ≥ 20 ESM, `pg`, vitest, npm workspaces. Spec: `docs/superpowers/specs/2026-07-30-foundry-migrations-design.md`.

## Global Constraints

(Every task's requirements implicitly include these — copied verbatim from the spec + house conventions.)

- **TypeScript strict:** `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `isolatedModules` are all ON. Use `import type` for types; conditional spread `...(x !== undefined ? { x } : {})` for optional props; `arr[i]` is `T | undefined`.
- **ESM specifiers:** every intra-package import uses the `.js` extension (e.g. `"../contracts.js"`).
- **`contracts.ts` is types-only.** Runtime helpers (`checksumMigration`, `loadMigrations`) live in the new `migrations/` module; only types (`AppliedMigration`) go in `contracts.ts`.
- **Stop-on-error, no auto-rollback.** A failing/tampered migration aborts the run; rollback of the failing migration's own transaction is best-effort.
- **Secrets by reference only.** Migration SQL is user DDL, not credentials — surface driver errors verbatim, never add secret values.
- **Tests:** vitest. Core tests MUST `import { describe, it, expect, vi } from "vitest"` (core's vitest config does NOT enable globals). Run one workspace: `npm test -w @foundry/core` / `@foundry/connector-postgres` / `@foundry/connector-redshift`. Single file: `npm test -w @foundry/core -- migrations.test.ts`.
- **Build order matters for tests:** `@foundry/core` is a `peerDependency` of the connectors; the connectors runtime-import `checksumMigration` from it, so build core before running connector tests: `npm run build -w @foundry/core`.
- **Commits:** frequent, one per task. **Never** add a `Co-Authored-By` trailer. Conventional-commit prefixes (`feat`, `test`, `docs`, `refactor`).
- **Engine scope:** postgres + redshift only. dynamodb/mongodb omit the new methods.

---

## File Structure

**New files:**
- `packages/core/src/migrations/index.ts` — pure loader + checksum + dir resolver.
- `packages/core/test/migrations-config.test.ts` — config validation for `migrations`.
- `packages/core/test/migrations.test.ts` — loader/checksum/dir unit tests.
- `packages/core/test/runtime-migrations.test.ts` — `ConnectionManager.rollback` / `migrationStatus`.
- `packages/core/test/cli-migrate.test.ts` — CLI `migrate` modes with a fake connector.
- `packages/core/test/apply-migrate.test.ts` — `apply --migrate` post-provision pass.

**Modified files:**
- `packages/core/src/contracts.ts` — add `AppliedMigration`; add `rollback?` + `migrationStatus?` to `Connector`.
- `packages/core/src/config/index.ts` — add `MigrationsConfig`; add `migrations?` to both DB types; validate.
- `packages/core/src/index.ts` — re-export the new `migrations/` module.
- `packages/core/src/runtime/index.ts` — `ConnectionManager.rollback` + `migrationStatus`.
- `packages/core/src/cli/index.ts` — `cwd` on `CLIContext`; disk-load + `--down`/`--status`/`--dry-run` dispatch; formatters.
- `packages/core/src/apply/index.ts` — `migrations?` summary on `ApplyStepResult`.
- `packages/core/src/cli/index.ts` (apply) — `migrate?: boolean` on `ApplyOptions`; post-provision pass.
- `packages/connectors/postgres/src/connector.ts` — checksum/tamper in `migrate`; add `rollback` + `migrationStatus`.
- `packages/connectors/postgres/test/connector.test.ts` — extend migrate mock + add rollback/status tests.
- `packages/connectors/redshift/src/connector.ts` — align table to `__foundry_migrations`, stop-on-error, checksum/tamper; add `rollback` + `migrationStatus`.
- `packages/connectors/redshift/test/connector.test.ts` — rewrite migrate tests; add rollback/status.
- `README.md` — migrations section.

---

## Task 1: Core types — `AppliedMigration`, `Connector.rollback?`/`migrationStatus?`, `MigrationsConfig` + validation

**Files:**
- Modify: `packages/core/src/contracts.ts`
- Modify: `packages/core/src/config/index.ts`
- Test: `packages/core/test/migrations-config.test.ts`

**Interfaces:**
- Produces (consumed by later tasks): `AppliedMigration` type; `Connector.rollback?(conn, migrations, count)` and `Connector.migrationStatus?(conn)`; `MigrationsConfig` type and `ProvisionedDatabase.migrations?` / `ExternalDatabase.migrations?`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/migrations-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateStack, ConfigError } from "../src/index.js";

describe("migrations config validation", () => {
  it("accepts a database without migrations", () => {
    expect(() =>
      validateStack({ databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" } } } }),
    ).not.toThrow();
  });

  it("accepts enabled:false", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { enabled: false } } },
      }),
    ).not.toThrow();
  });

  it("accepts a custom dir", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { dir: "db/a" } } },
      }),
    ).not.toThrow();
  });

  it("accepts migrations on an external database", () => {
    expect(() =>
      validateStack({
        databases: {
          a: { engine: "postgres", provision: "external", connectionString: { from: "env:PG" }, migrations: { enabled: true } },
        },
      }),
    ).not.toThrow();
  });

  it("rejects migrations as a non-object", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: "nope" } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects enabled as non-boolean", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { enabled: "yes" } } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects dir as an empty string", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { dir: "" } } },
      }),
    ).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @foundry/core -- migrations-config.test.ts`
Expected: FAIL — `migrations` is not a recognized field, so `validateStack` ignores it; the rejection tests fail (no throw). Also TS may error on the unknown field at compile, but `validateStack(input: unknown)` accepts the shape.

- [ ] **Step 3: Add `AppliedMigration` + extend `Connector` in contracts.ts**

In `packages/core/src/contracts.ts`, after the `MigrationResult` interface (around line 119), add:

```ts
/** A migration row as recorded in the tracking table (returned by migrationStatus). */
interface AppliedMigration {
  id: string;
  description?: string;
  checksum: string;
  appliedAt: Date;
}
```

Extend the `Connector` interface (around line 80–85) to:

```ts
interface Connector {
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  connect(target: ConnectionTarget): Promise<Connection>;
  health(conn: Connection): Promise<HealthStatus>;
  migrate?(conn: Connection, migrations: Migration[]): Promise<MigrationResult>;
  /** Roll back `count` applied migrations, newest-first (engines that support it). */
  rollback?(conn: Connection, migrations: Migration[], count: number): Promise<MigrationResult>;
  /** Read the applied-migration rows from the tracking table. */
  migrationStatus?(conn: Connection): Promise<AppliedMigration[]>;
}
```

Add `AppliedMigration` to the `export { type ... }` block at the bottom of the file.

- [ ] **Step 4: Add `MigrationsConfig` + validation in config/index.ts**

In `packages/core/src/config/index.ts`, add the interface near the other config types (after `ExternalDatabase`, before `type DatabaseConfig`):

```ts
/** Per-database migration settings (postgres/redshift). */
export interface MigrationsConfig {
  /** Disable migrations for this database. Default: enabled if a dir resolves. */
  readonly enabled?: boolean;
  /** Migration directory, relative to cwd. Default: migrations/<dbId>/. */
  readonly dir?: string;
}
```

Add `readonly migrations?: MigrationsConfig;` to BOTH `ProvisionedDatabase` and `ExternalDatabase` (as a sibling of `engine` / `region`).

Add the validator helper (near `assertSecretRef`):

```ts
function validateMigrationsConfig(mig: unknown, path: string[], id: string): asserts mig is MigrationsConfig {
  if (!isObject(mig)) {
    throw new ConfigError(`Database "${id}" migrations must be an object`, path);
  }
  const m = mig as Partial<MigrationsConfig>;
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
    throw new ConfigError(`Database "${id}" migrations.enabled must be a boolean`, [...path, "enabled"]);
  }
  if (m.dir !== undefined && (typeof m.dir !== "string" || m.dir.length === 0)) {
    throw new ConfigError(`Database "${id}" migrations.dir must be a non-empty string`, [...path, "dir"]);
  }
}
```

Call it from `validateDatabase`, just before the function's closing (after the existing `credsRef` check, so it runs for both provisioned and external databases):

```ts
  const migField = (cfg as Partial<{ migrations: unknown }>).migrations;
  if (migField !== undefined) {
    validateMigrationsConfig(migField, [...path, "migrations"], id);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @foundry/core -- migrations-config.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck -w @foundry/core`
Expected: clean.

```bash
git add packages/core/src/contracts.ts packages/core/src/config/index.ts packages/core/test/migrations-config.test.ts
git commit -m "feat(core): add MigrationsConfig + Connector rollback/migrationStatus contract"
```

---

## Task 2: Core `migrations/` module — loader, checksum, dir resolver

**Files:**
- Create: `packages/core/src/migrations/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/migrations.test.ts`

**Interfaces:**
- Consumes: `MigrationsConfig` from `../config/index.js` (Task 1).
- Produces (consumed by Tasks 4, 5, 6, 7): `LoadedMigration` type; `loadMigrations(dir): Promise<LoadedMigration[]>`; `checksumMigration(up): string`; `resolveMigrationDir(cwd, dbId, cfg?): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/migrations.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, checksumMigration, resolveMigrationDir } from "../src/index.js";

describe("migrations loader", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "foundry-mig-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads paired up/down files ordered by numeric id", async () => {
    await writeFile(join(dir, "000002_b.up.sql"), "B;");
    await writeFile(join(dir, "000002_b.down.sql"), "B-down;");
    await writeFile(join(dir, "000001_a.up.sql"), "A;");
    const m = await loadMigrations(dir);
    expect(m.map((x) => x.id)).toEqual(["000001", "000002"]);
    expect(m[0]!.description).toBe("a");
    expect(m[0]!.up).toBe("A;");
    expect(m[0]!.down).toBeUndefined();
    expect(m[1]!.down).toBe("B-down;");
  });

  it("canonicalizes a 1-digit id to 6 digits", async () => {
    await writeFile(join(dir, "1_first.up.sql"), "x;");
    const m = await loadMigrations(dir);
    expect(m[0]!.id).toBe("000001");
  });

  it("errors on a duplicate canonical id", async () => {
    await writeFile(join(dir, "1_a.up.sql"), "a;");
    await writeFile(join(dir, "001_b.up.sql"), "b;");
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration id "000001"/);
  });

  it("errors on a malformed .up.sql filename", async () => {
    await writeFile(join(dir, "create_users.up.sql"), "x;");
    await expect(loadMigrations(dir)).rejects.toThrow(/Invalid migration filename/);
  });

  it("ignores non-migration files", async () => {
    await writeFile(join(dir, "README.md"), "# hi");
    await writeFile(join(dir, "000001_a.up.sql"), "a;");
    const m = await loadMigrations(dir);
    expect(m).toHaveLength(1);
  });

  it("errors when the directory does not exist", async () => {
    await expect(loadMigrations(join(dir, "missing"))).rejects.toThrow();
  });
});

describe("checksumMigration", () => {
  it("is a deterministic 64-char hex", () => {
    const cs = checksumMigration("CREATE TABLE x ();");
    expect(cs).toHaveLength(64);
    expect(cs).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumMigration("a")).not.toBe(checksumMigration("b"));
    expect(checksumMigration("a")).toBe(checksumMigration("a"));
  });
});

describe("resolveMigrationDir", () => {
  it("defaults to migrations/<dbId>", () => {
    expect(resolveMigrationDir("/cwd", "analytics")).toBe(join("/cwd", "migrations", "analytics"));
  });
  it("uses cfg.dir when provided", () => {
    expect(resolveMigrationDir("/cwd", "analytics", { dir: "db/analytics" })).toBe(join("/cwd", "db", "analytics"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @foundry/core -- migrations.test.ts`
Expected: FAIL — `loadMigrations` / `checksumMigration` / `resolveMigrationDir` are not exported.

- [ ] **Step 3: Create the migrations module**

Create `packages/core/src/migrations/index.ts`:

```ts
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
```

- [ ] **Step 4: Re-export the module from core's barrel**

In `packages/core/src/index.ts`, add after the existing `export *` lines:

```ts
export * from "./migrations/index.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @foundry/core -- migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Build + typecheck + commit**

Run: `npm run build -w @foundry/core && npm run typecheck -w @foundry/core`
Expected: clean.

```bash
git add packages/core/src/migrations/index.ts packages/core/src/index.ts packages/core/test/migrations.test.ts
git commit -m "feat(core): add migrations loader, checksum, and dir resolver"
```

---

## Task 3: Core runtime — `ConnectionManager.rollback` + `migrationStatus`

**Files:**
- Modify: `packages/core/src/runtime/index.ts`
- Test: `packages/core/test/runtime-migrations.test.ts`

**Interfaces:**
- Consumes: `Connector.rollback?` / `migrationStatus?` (Task 1).
- Produces: `ConnectionManager.rollback(id, migrations, count)` and `ConnectionManager.migrationStatus(id)` — used by the CLI (Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/runtime-migrations.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ConnectionManager, ConnectionRegistry } from "../src/index.js";
import type {
  AppliedMigration,
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
} from "../src/index.js";

function setup(overrides: Partial<Connector> = {}): {
  manager: ConnectionManager;
  connector: Connector;
  conn: Connection;
} {
  const conn: Connection = {
    engine: "postgres",
    client: {},
    pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
    close: vi.fn(async () => {}),
  };
  const connector: Connector = {
    engine: "postgres",
    connect: vi.fn(async (_target: ConnectionTarget): Promise<Connection> => conn),
    health: vi.fn(async (): Promise<HealthStatus> => ({ ok: true, latencyMs: 0 })),
    ...overrides,
  };
  const registry = new ConnectionRegistry(new Map([["postgres", connector]]), {
    stack: {
      databases: {
        db: { engine: "postgres", provision: "external", connectionString: { from: "env:PG" } },
      },
    },
  });
  return { manager: new ConnectionManager(registry), connector, conn };
}

const okResult = (ids: string[]): MigrationResult => ({ applied: ids, skipped: [], errors: [] });

describe("ConnectionManager rollback / migrationStatus", () => {
  it("delegates rollback to the connector with the count", async () => {
    const rollback = vi.fn(async (_c: Connection, _m: Migration[], count: number) => okResult(["000002"].slice(0, count)));
    const { manager } = setup({ rollback });
    await manager.connect("db");
    const res = await manager.rollback("db", [{ id: "000002", up: "x", down: "y" }], 1);
    expect(res.applied).toEqual(["000002"]);
    expect(rollback).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 1);
  });

  it("delegates migrationStatus to the connector", async () => {
    const rows: AppliedMigration[] = [{ id: "000001", checksum: "abc", appliedAt: new Date(0) }];
    const migrationStatus = vi.fn(async () => rows);
    const { manager } = setup({ migrationStatus });
    await manager.connect("db");
    const out = await manager.migrationStatus("db");
    expect(out).toBe(rows);
  });

  it("throws ConnectionError when the connector lacks rollback", async () => {
    const { manager } = setup();
    await manager.connect("db");
    await expect(manager.rollback("db", [], 1)).rejects.toThrow(/does not support migrations/);
  });

  it("throws ConnectionError when the connector lacks migrationStatus", async () => {
    const { manager } = setup();
    await manager.connect("db");
    await expect(manager.migrationStatus("db")).rejects.toThrow(/does not support migrations/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @foundry/core -- runtime-migrations.test.ts`
Expected: FAIL — `manager.rollback` / `manager.migrationStatus` are not functions.

- [ ] **Step 3: Implement the two delegators**

In `packages/core/src/runtime/index.ts`, add `AppliedMigration` to the contracts import list:

```ts
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
```

Add these two methods to `ConnectionManager`, immediately after the existing `migrate` method (after line 225):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @foundry/core -- runtime-migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck -w @foundry/core`
Expected: clean.

```bash
git add packages/core/src/runtime/index.ts packages/core/test/runtime-migrations.test.ts
git commit -m "feat(core): add ConnectionManager rollback and migrationStatus"
```

---

## Task 4: Core CLI — wire `migrate` to disk + `--down` / `--status` / `--dry-run`

**Files:**
- Modify: `packages/core/src/cli/index.ts`
- Test: `packages/core/test/cli-migrate.test.ts`

**Interfaces:**
- Consumes: `loadMigrations`, `resolveMigrationDir`, `LoadedMigration`, `checksumMigration` (Task 2); `ConnectionManager.rollback`/`migrationStatus` (Task 3); `MigrationsConfig` (Task 1).
- Produces: `CLIContext.cwd`; `runMigrateDown`, `runMigrateStatus`, `runMigrateDryRun`; `MigrationStatus` type; `formatMigrationStatus`; updated `main()` migrate dispatch.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/cli-migrate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMigrate,
  runMigrateDown,
  runMigrateStatus,
  runMigrateDryRun,
  type CLIContext,
} from "../src/index.js";
import type {
  AppliedMigration,
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
} from "../src/index.js";
import type { StateStore, State } from "../src/index.js";
import type { ResourceState } from "../src/index.js";

/** Minimal in-memory StateStore (no existing impl to reuse). */
function memState(): StateStore {
  let resources: Record<string, ResourceState> = {};
  return {
    read: async (): Promise<State> => ({ version: 1 as const, resources }),
    write: async (s) => {
      resources = s.resources;
    },
    get: async (id) => resources[id] ?? null,
    put: async (r) => {
      resources[r.id] = r;
    },
    delete: async (id) => {
      delete resources[id];
    },
    lock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
}

interface FakePgOpts {
  applied?: AppliedMigration[];
  migrateResult?: MigrationResult;
  rollbackResult?: MigrationResult;
}
function fakePgConnector(opts: FakePgOpts = {}): {
  connector: Connector;
  calls: {
    migrate: Migration[][];
    rollback: { migrations: Migration[]; count: number }[];
    status: number;
  };
} {
  const calls = {
    migrate: [] as Migration[][],
    rollback: [] as { migrations: Migration[]; count: number }[],
    status: 0,
  };
  const conn: Connection = {
    engine: "postgres",
    client: {},
    pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
    close: async () => {},
  };
  const connector: Connector = {
    engine: "postgres",
    connect: vi.fn(async (_t: ConnectionTarget): Promise<Connection> => conn),
    health: vi.fn(async (): Promise<HealthStatus> => ({ ok: true, latencyMs: 0 })),
    migrate: vi.fn(async (_c: Connection, migrations: Migration[]) => {
      calls.migrate.push(migrations);
      return opts.migrateResult ?? { applied: migrations.map((m) => m.id), skipped: [], errors: [] };
    }),
    rollback: vi.fn(async (_c: Connection, migrations: Migration[], count: number) => {
      calls.rollback.push({ migrations, count });
      return opts.rollbackResult ?? { applied: migrations.slice(0, count).map((m) => m.id), skipped: [], errors: [] };
    }),
    migrationStatus: vi.fn(async () => {
      calls.status++;
      return opts.applied ?? [];
    }),
  };
  return { connector, calls };
}

function ctxWith(
  connector: Connector,
  cwd: string,
): CLIContext {
  return {
    cwd,
    stack: {
      databases: {
        db: { engine: "postgres", provision: "external", connectionString: { from: "env:PG" } },
      },
    },
    state: memState(),
    provisioners: new Map(),
    connectors: new Map([["postgres", connector]]),
    logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("CLI migrate dispatch", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "foundry-cli-mig-"));
    await mkdir(join(cwd, "migrations", "db"), { recursive: true });
    await writeFile(join(cwd, "migrations", "db", "000001_a.up.sql"), "A;");
    await writeFile(join(cwd, "migrations", "db", "000001_a.down.sql"), "A-down;");
    await writeFile(join(cwd, "migrations", "db", "000002_b.up.sql"), "B;");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("up: loads from disk and applies pending", async () => {
    const { connector, calls } = fakePgConnector();
    const ctx = ctxWith(connector, cwd);
    const res = await runMigrate(ctx, "db", await loadDisk(ctx, "db"));
    expect(res.applied).toEqual(["000001", "000002"]);
    expect(calls.migrate[0]!.map((m) => m.id)).toEqual(["000001", "000002"]);
  });

  it("down: default count is 1", async () => {
    const { connector, calls } = fakePgConnector();
    const ctx = ctxWith(connector, cwd);
    await runMigrateDown(ctx, "db", await loadDisk(ctx, "db"));
    expect(calls.rollback[0]!.count).toBe(1);
  });

  it("down: explicit count", async () => {
    const { connector, calls } = fakePgConnector();
    const ctx = ctxWith(connector, cwd);
    await runMigrateDown(ctx, "db", await loadDisk(ctx, "db"), { count: 2 });
    expect(calls.rollback[0]!.count).toBe(2);
  });

  it("status: reports applied/pending/tampered", async () => {
    const applied: AppliedMigration[] = [
      { id: "000001", description: "a", checksum: "WRONG", appliedAt: new Date(0) },
    ];
    const { connector } = fakePgConnector({ applied });
    const ctx = ctxWith(connector, cwd);
    const status = await runMigrateStatus(ctx, "db", await loadDisk(ctx, "db"));
    expect(status.applied.map((a) => a.id)).toEqual(["000001"]);
    expect(status.pending.map((p) => p.id)).toEqual(["000002"]);
    expect(status.tampered.map((t) => t.id)).toEqual(["000001"]); // checksum mismatch
  });

  it("dry-run: hasWork true when pending exist", async () => {
    const { connector } = fakePgConnector({ applied: [] });
    const ctx = ctxWith(connector, cwd);
    const { status, hasWork } = await runMigrateDryRun(ctx, "db", await loadDisk(ctx, "db"));
    expect(hasWork).toBe(true);
    expect(status.pending).toHaveLength(2);
  });

  it("dry-run: hasWork false when fully applied + no tamper", async () => {
    const onDisk = await loadDisk(ctxWith(fakePgConnector().connector, cwd), "db");
    const applied: AppliedMigration[] = onDisk.map((m) => ({
      id: m.id,
      description: m.description,
      checksum: checksumOf(m.up),
      appliedAt: new Date(0),
    }));
    const { connector } = fakePgConnector({ applied });
    const ctx = ctxWith(connector, cwd);
    const { hasWork } = await runMigrateDryRun(ctx, "db", onDisk);
    expect(hasWork).toBe(false);
  });
});

// Helpers used above (kept at the bottom to mirror house style).
import { loadMigrations, resolveMigrationDir, checksumMigration } from "../src/index.js";
function loadDisk(ctx: CLIContext, dbId: string) {
  return loadMigrations(resolveMigrationDir(ctx.cwd, dbId));
}
function checksumOf(up: string): string {
  return checksumMigration(up);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @foundry/core -- cli-migrate.test.ts`
Expected: FAIL — `runMigrateDown` / `runMigrateStatus` / `runMigrateDryRun` are not exported; `CLIContext.cwd` does not exist.

- [ ] **Step 3: Add `cwd` to CLIContext**

In `packages/core/src/cli/index.ts`, add `cwd` to the `CLIContext` interface (after `stack`):

```ts
export interface CLIContext {
  readonly stack: Stack;
  readonly cwd: string;
  readonly state: StateStore;
  readonly provisioners: Map<ResourceKind, Provisioner>;
  readonly connectors: Map<Engine, Connector>;
  readonly logger?: Logger;
  readonly planner?: Planner;
}
```

In `buildContext`, set it. Replace the `return { ... }` block with:

```ts
  return {
    stack,
    cwd,
    state,
    provisioners: opts.provisioners ?? new Map(),
    connectors: opts.connectors ?? new Map(),
    logger: opts.logger ?? console,
    ...(opts.planner !== undefined ? { planner: opts.planner } : {}),
  };
```

- [ ] **Step 4: Add imports + new migrate handlers**

Add these imports near the top of `packages/core/src/cli/index.ts` (with the other imports). `AppliedMigration` comes from `../contracts.js`; `MigrationsConfig` comes from `../config/index.js`:

```ts
import { loadMigrations, resolveMigrationDir, checksumMigration } from "../migrations/index.js";
import type { LoadedMigration } from "../migrations/index.js";
import type { AppliedMigration } from "../contracts.js";
import type { MigrationsConfig } from "../config/index.js";
```

Replace the entire `migrate` section (the existing `runMigrate` + its comment, roughly lines 115–136) with:

```ts
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

/** Load on-disk migrations for a database; ENOENT (no dir) => empty list. */
export async function loadMigrationsForDb(ctx: CLIContext, dbId: string): Promise<LoadedMigration[]> {
  const db = ctx.stack.databases[dbId];
  const cfg = db && "migrations" in db ? (db as { migrations?: MigrationsConfig }).migrations : undefined;
  const dir = resolveMigrationDir(ctx.cwd, dbId, cfg);
  try {
    return await loadMigrations(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
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
```

- [ ] **Step 5: Rewrite the `migrate` case in `main()`**

In `main()`, replace the `case "migrate": { ... }` block with:

```ts
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w @foundry/core -- cli-migrate.test.ts`
Expected: PASS (delete the noted weak 2nd `it` first).

- [ ] **Step 7: Typecheck + full core suite + commit**

Run: `npm run typecheck -w @foundry/core && npm test -w @foundry/core`
Expected: clean; all core tests green.

```bash
git add packages/core/src/cli/index.ts packages/core/test/cli-migrate.test.ts
git commit -m "feat(core): wire migrate to disk + --down/--status/--dry-run"
```

---

## Task 5: Core — `apply --migrate` post-provision pass

**Files:**
- Modify: `packages/core/src/apply/index.ts` — add `migrations?` to `ApplyStepResult`.
- Modify: `packages/core/src/cli/index.ts` — `migrate?: boolean` on `ApplyOptions`; post-pass.
- Test: `packages/core/test/apply-migrate.test.ts`

**Interfaces:**
- Consumes: `ApplyOrchestrator`/`ApplyResult`/`ApplyStepResult` (existing); `loadMigrations`/`resolveMigrationDir` (Task 2); `ConnectionManager.migrate` (existing); `CLIContext.cwd` (Task 4).
- Produces: `ApplyStepResult.migrations?`; `runApply(ctx, plan, { migrate: true })` runs pending migrations against each produced `ConnectionTarget`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/apply-migrate.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApply, type CLIContext, type Plan } from "../src/index.js";
import type {
  Connection,
  ConnectionTarget,
  Connector,
  HealthStatus,
  Migration,
  MigrationResult,
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceState,
} from "../src/index.js";
import type { StateStore, State } from "../src/index.js";

function memState(): StateStore {
  let resources: Record<string, ResourceState> = {};
  return {
    read: async (): Promise<State> => ({ version: 1 as const, resources }),
    write: async (s) => {
      resources = s.resources;
    },
    get: async (id) => resources[id] ?? null,
    put: async (r) => {
      resources[r.id] = r;
    },
    delete: async (id) => {
      delete resources[id];
    },
    lock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
}

function producedState(id: string): ResourceState {
  return {
    id,
    kind: "aws.rds-postgres",
    identifiers: { arn: `arn:aws:rds:::${id}` },
    status: "available",
    connection: { engine: "postgres", endpoint: `${id}.example:5432`, credsRef: { from: "env:PG" } },
  };
}

describe("apply --migrate", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "foundry-apply-mig-"));
    await mkdir(join(cwd, "migrations", "db"), { recursive: true });
    await writeFile(join(cwd, "migrations", "db", "000001_init.up.sql"), "CREATE TABLE t ();");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs pending migrations against the produced ConnectionTarget after create", async () => {
    const migrate = vi.fn(
      async (_c: Connection, migrations: Migration[]): Promise<MigrationResult> => ({
        applied: migrations.map((m) => m.id),
        skipped: [],
        errors: [],
      }),
    );
    const conn: Connection = {
      engine: "postgres",
      client: {},
      pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
      close: async () => {},
    };
    const connector: Connector = {
      engine: "postgres",
      connect: vi.fn(async (_t: ConnectionTarget): Promise<Connection> => conn),
      health: vi.fn(async (): Promise<HealthStatus> => ({ ok: true, latencyMs: 0 })),
      migrate,
    };
    const provisioner: Provisioner = {
      kind: "aws.rds-postgres" satisfies ResourceKind,
      plan: vi.fn(() => ({ op: "create", spec: { id: "db", kind: "aws.rds-postgres", props: {} } }) as PlanAction),
      apply: vi.fn(async () => producedState("db")),
      read: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };

    const ctx: CLIContext = {
      cwd,
      stack: {
        databases: {
          db: { engine: "postgres", provision: { kind: "aws.rds-postgres" } },
        },
      },
      state: memState(),
      provisioners: new Map([["aws.rds-postgres", provisioner]]),
      connectors: new Map([["postgres", connector]]),
      logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    const plan: Plan = {
      actions: [{ op: "create", spec: { id: "db", kind: "aws.rds-postgres", props: {} } }],
      drift: [],
    };

    const result = await runApply(ctx, plan, { migrate: true });
    expect(result.failed).toBe(0);
    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate.mock.calls[0]![1]!.map((m) => m.id)).toEqual(["000001"]);
    const step = result.results.find((r) => r.id === "db")!;
    expect(step.migrations).toEqual({ applied: 1, skipped: 0, errors: 0 });
  });

  it("skips migration when the connector lacks migrate", async () => {
    const conn: Connection = {
      engine: "dynamodb",
      client: {},
      pool: { size: 0, idle: 0, inUse: 0, waiting: 0 },
      close: async () => {},
    };
    const connector: Connector = {
      engine: "dynamodb",
      connect: vi.fn(async () => conn),
      health: vi.fn(async () => ({ ok: true, latencyMs: 0 })),
      // no migrate
    };
    const provisioner: Provisioner = {
      kind: "aws.dynamodb",
      plan: vi.fn(() => ({ op: "create", spec: { id: "db", kind: "aws.dynamodb", props: {} } }) as PlanAction),
      apply: vi.fn(async () => ({
        id: "db",
        kind: "aws.dynamodb",
        identifiers: { arn: "arn:aws:dynamodb:::db" },
        status: "available",
        connection: { engine: "dynamodb", region: "us-east-1" },
      })),
      read: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const ctx: CLIContext = {
      cwd,
      stack: { databases: { db: { engine: "dynamodb", provision: { kind: "aws.dynamodb" } } } },
      state: memState(),
      provisioners: new Map([["aws.dynamodb", provisioner]]),
      connectors: new Map([["dynamodb", connector]]),
      logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };
    const plan: Plan = {
      actions: [{ op: "create", spec: { id: "db", kind: "aws.dynamodb", props: {} } }],
      drift: [],
    };
    const result = await runApply(ctx, plan, { migrate: true });
    expect(result.failed).toBe(0);
    expect(result.results.find((r) => r.id === "db")!.migrations).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @foundry/core -- apply-migrate.test.ts`
Expected: FAIL — `ApplyStepResult.migrations` and `runApply(..., { migrate: true })` don't exist.

- [ ] **Step 3: Add `migrations?` to `ApplyStepResult`**

In `packages/core/src/apply/index.ts`, extend `ApplyStepResult`:

```ts
export interface ApplyStepResult {
  readonly id: string;
  readonly op: PlanAction["op"];
  readonly status: StepStatus;
  readonly idempotencyToken?: string;
  readonly state?: ResourceState;
  readonly error?: ApplyActionError;
  /** Per-database migration counts (present only after an `apply --migrate` pass). */
  readonly migrations?: { applied: number; skipped: number; errors: number };
}
```

- [ ] **Step 4: Add `migrate?` to `ApplyOptions` + the post-pass in cli/index.ts**

In `packages/core/src/cli/index.ts`, extend `ApplyOptions`:

```ts
export interface ApplyOptions {
  readonly continueOnError?: boolean;
  /** After apply, run pending migrations against each produced ConnectionTarget. */
  readonly migrate?: boolean;
}
```

Add the needed imports (LoadedMigration already imported in Task 4; add `MigrationsConfig` if not present — it is). Then replace `runApply` with:

```ts
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
```

Add the post-pass function (and its ENOENT helper) after `runApply`:

```ts
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

  let migrations: LoadedMigration[];
  try {
    migrations = await loadMigrations(resolveMigrationDir(ctx.cwd, dbId, cfg));
  } catch (err) {
    if (isENOENT(err)) return undefined;
    throw err;
  }
  if (migrations.length === 0) return undefined;

  const connector = ctx.connectors.get(ctx.stack.databases[dbId]?.engine ?? "");
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
```

Add `ApplyStepResult` to the imports from `../apply/index.js` at the top of cli/index.ts (it currently imports `ApplyOrchestrator`, `ApplyResult`, `Logger`):

```ts
import { ApplyOrchestrator, type ApplyResult, type ApplyStepResult, type Logger } from "../apply/index.js";
```

- [ ] **Step 5: Wire the `--migrate` flag in `main()`**

In `main()`, the `case "apply":` block currently calls `runApply(ctx, undefined, { continueOnError })` (or the equivalent already-present options object). Add `migrate: parsed.flags["migrate"] === true` to that options object:

```ts
        const result = await runApply(ctx, undefined, {
          continueOnError,
          migrate: parsed.flags["migrate"] === true,
        });
```

Leave the rest of the apply case (its logging and exit-code logic) untouched. If the existing apply case reads `continueOnError` under a different name, keep that name — only `migrate` is new.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w @foundry/core -- apply-migrate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + full core suite + commit**

Run: `npm run typecheck -w @foundry/core && npm test -w @foundry/core`
Expected: clean; all green.

```bash
git add packages/core/src/apply/index.ts packages/core/src/cli/index.ts packages/core/test/apply-migrate.test.ts
git commit -m "feat(core): apply --migrate runs pending migrations after provisioning"
```

---

## Task 6: Postgres connector — checksum/tamper in `migrate` + `rollback` + `migrationStatus`

**Files:**
- Modify: `packages/connectors/postgres/src/connector.ts`
- Modify: `packages/connectors/postgres/test/connector.test.ts`

**Interfaces:**
- Consumes: `checksumMigration` (runtime) + `AppliedMigration` (type) from `@foundry/core` (Tasks 1–2).
- Produces: `postgresConnector.migrate` (checksum + tamper), `postgresConnector.rollback`, `postgresConnector.migrationStatus`.

- [ ] **Step 0: Build core so the runtime import resolves**

Run: `npm run build -w @foundry/core`
Expected: clean (dist updated with `checksumMigration` + `AppliedMigration`).

- [ ] **Step 1: Update imports + `migrate()` in the connector**

In `packages/connectors/postgres/src/connector.ts`, add the runtime import after the existing `pg` imports:

```ts
import { checksumMigration } from "@foundry/core";
```

Add `AppliedMigration` to the type import from `@foundry/core`:

```ts
import type {
  AppliedMigration,
  Connector,
  Connection,
  ConnectionTarget,
  SecretRef,
  HealthStatus,
  Migration,
  MigrationResult,
} from "@foundry/core";
```

Replace the entire `migrate` method (currently the `async migrate(conn, migrations) { ... }` block, roughly lines 294–354) with:

```ts
  async migrate(conn: Connection, migrations: Migration[]): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        description TEXT,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );

    for (const migration of migrations) {
      const client = await pool.connect();
      try {
        const existing = await client.query(
          `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE id = $1`,
          [migration.id],
        );
        if ((existing.rowCount ?? 0) > 0) {
          const stored = (existing.rows[0]?.checksum ?? "") as string;
          if (stored !== checksumMigration(migration.up)) {
            errors.push({
              id: migration.id,
              error: `checksum mismatch: migration "${migration.id}" was modified after it was applied`,
            });
            break; // tamper -> stop
          }
          skipped.push(migration.id);
          continue;
        }

        try {
          await client.query("BEGIN");
          await client.query(migration.up);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (id, description, checksum) VALUES ($1, $2, $3)`,
            [migration.id, migration.description ?? null, checksumMigration(migration.up)],
          );
          await client.query("COMMIT");
          applied.push(migration.id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            /* best-effort; surface the original cause */
          });
          const err = error as Error;
          errors.push({ id: migration.id, error: err.message || "Unknown migration error" });
          break; // stop-on-error
        }
      } finally {
        client.release();
      }
    }

    return { applied, skipped, errors };
  },

  async rollback(conn: Connection, migrations: Migration[], count: number): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    const result = await pool.query(
      `SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT $1`,
      [count],
    );
    const ids = (result.rows as { id: string }[]).map((r) => r.id);

    for (const id of ids) {
      const migration = migrations.find((m) => m.id === id);
      if (migration === undefined || migration.down === undefined) {
        errors.push({ id, error: `migration "${id}" has no down migration` });
        break;
      }
      const client = await pool.connect();
      try {
        try {
          await client.query("BEGIN");
          await client.query(migration.down);
          await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = $1`, [id]);
          await client.query("COMMIT");
          applied.push(id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            /* best-effort */
          });
          const err = error as Error;
          errors.push({ id, error: err.message || "Unknown rollback error" });
          break;
        }
      } finally {
        client.release();
      }
    }
    return { applied, skipped, errors };
  },

  async migrationStatus(conn: Connection): Promise<AppliedMigration[]> {
    const pool = conn.client as Pool;
    const result = await pool.query(
      `SELECT id, description, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`,
    );
    return (result.rows as { id: string; description: string | null; checksum: string; applied_at: Date }[]).map(
      (r) => ({
        id: r.id,
        checksum: r.checksum,
        appliedAt: r.applied_at,
        ...(r.description !== null ? { description: r.description } : {}),
      }),
    );
  },
```

- [ ] **Step 2: Update the migrate test mock + add rollback/status tests**

Open `packages/connectors/postgres/test/connector.test.ts`. The existing migrate tests use a routing helper (e.g. `applyMigrateMock(appliedIds, failingUps)`) over the shared `pgMock.query`. **Replace** that helper with a checksum-aware version (if a constant `MIGRATIONS_TABLE` is not already defined at the top of the file, add `const MIGRATIONS_TABLE = "__foundry_migrations";`):

```ts
function applyMigrateMock(appliedChecksums: Map<string, string>, failingUps: Set<string>) {
  pgMock.query.mockImplementation(async (text: string, values?: unknown[]) => {
    if (text.includes("CREATE TABLE") && text.includes(MIGRATIONS_TABLE)) {
      return { rowCount: 0, rows: [] };
    }
    if (text.startsWith("SELECT checksum FROM")) {
      const id = values?.[0] as string;
      const cs = appliedChecksums.get(id);
      return cs ? { rowCount: 1, rows: [{ checksum: cs }] } : { rowCount: 0, rows: [] };
    }
    if (text.startsWith("INSERT INTO")) {
      const id = values?.[0] as string;
      const cs = values?.[2] as string;
      appliedChecksums.set(id, cs);
      return { rowCount: 1, rows: [] };
    }
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (failingUps.has(text)) throw new Error(`migration failed: ${text}`);
    return { rowCount: 0, rows: [] };
  });
}
```

Delete the existing migrate `describe` block (its cases assert the pre-checksum `appliedIds`-Set routing and will not compile against the new helper signature) and replace it with the block below, which covers migrate (apply / skip / tamper) plus the new rollback and status paths:

```ts
import { checksumMigration } from "@foundry/core";

describe("postgres migrate / rollback / migrationStatus", () => {
  beforeEach(() => {
    pgMock.query.mockReset();
    pgMock.query.mockResolvedValue({ rowCount: 0, rows: [] });
    pgMock.connect.mockResolvedValue(pgMock.poolClient);
  });

  it("applies pending migrations and records checksums", async () => {
    const applied = new Map<string, string>();
    applyMigrateMock(applied, new Set());
    const res = await migrate(
      { engine: "postgres", client: pgMock.pool, pool: emptyPool(), close: async () => {} } as never,
      [
        { id: "000001", description: "a", up: "CREATE TABLE a ();" },
        { id: "000002", description: "b", up: "CREATE TABLE b ();" },
      ],
    );
    expect(res.applied).toEqual(["000001", "000002"]);
    expect(applied.get("000001")).toBe(checksumMigration("CREATE TABLE a ();"));
  });

  it("skips already-applied with matching checksum", async () => {
    const applied = new Map<string, string>([["000001", checksumMigration("CREATE TABLE a ();")]]);
    applyMigrateMock(applied, new Set());
    const res = await migrate(
      { engine: "postgres", client: pgMock.pool, pool: emptyPool(), close: async () => {} } as never,
      [{ id: "000001", description: "a", up: "CREATE TABLE a ();" }],
    );
    expect(res.skipped).toEqual(["000001"]);
    expect(res.applied).toEqual([]);
  });

  it("detects tampering and stops", async () => {
    const applied = new Map<string, string>([["000001", "STALE-CHECKSUM"]]);
    applyMigrateMock(applied, new Set());
    const res = await migrate(
      { engine: "postgres", client: pgMock.pool, pool: emptyPool(), close: async () => {} } as never,
      [
        { id: "000001", description: "a", up: "CREATE TABLE a ();" },
        { id: "000002", description: "b", up: "CREATE TABLE b ();" },
      ],
    );
    expect(res.errors[0]!.id).toBe("000001");
    expect(res.errors[0]!.error).toMatch(/checksum mismatch/);
    expect(res.applied).toEqual([]); // stopped before applying 000002
  });

  it("rolls back the newest N migrations", async () => {
    // SELECT id ... DESC LIMIT returns 000002 then 000001; DELETE is routed.
    pgMock.query.mockImplementation(async (text: string, values?: unknown[]) => {
      if (text.startsWith("SELECT id FROM")) return { rowCount: 2, rows: [{ id: "000002" }, { id: "000001" }] };
      if (text.startsWith("DELETE FROM")) return { rowCount: 1, rows: [] };
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const rollback = postgresConnector.rollback!;
    const res = await rollback(
      { engine: "postgres", client: pgMock.pool, pool: emptyPool(), close: async () => {} } as never,
      [
        { id: "000001", up: "x", down: "DROP a;" },
        { id: "000002", up: "x", down: "DROP b;" },
      ],
      2,
    );
    expect(res.applied).toEqual(["000002", "000001"]);
  });

  it("errors when a down migration is missing", async () => {
    pgMock.query.mockImplementation(async (text: string) => {
      if (text.startsWith("SELECT id FROM")) return { rowCount: 1, rows: [{ id: "000001" }] };
      return { rowCount: 0, rows: [] };
    });
    const rollback = postgresConnector.rollback!;
    const res = await rollback(
      { engine: "postgres", client: pgMock.pool, pool: emptyPool(), close: async () => {} } as never,
      [{ id: "000001", up: "x" }], // no down
      1,
    );
    expect(res.errors[0]!.error).toMatch(/no down migration/);
  });

  it("migrationStatus maps tracking rows", async () => {
    pgMock.query.mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "000001", description: "a", checksum: "abc", applied_at: new Date(0) }],
    });
    const status = postgresConnector.migrationStatus!;
    const out = await status({ engine: "postgres", client: pgMock.pool, pool: emptyPool(), close: async () => {} } as never);
    expect(out[0]!.id).toBe("000001");
    expect(out[0]!.checksum).toBe("abc");
  });
});

function emptyPool() {
  return { size: 0, idle: 0, inUse: 0, waiting: 0 };
}
```

> The `{ engine, client: pgMock.pool, ... } as never` stands in for a `Connection` whose `.client` is the mock Pool (so `conn.client as Pool` inside migrate/rollback/status yields `pgMock.pool`, whose `query`/`connect` are the shared spies). If the file already has a `makeConn()` helper, reuse it instead.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -w @foundry/connector-postgres`
Expected: PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck -w @foundry/connector-postgres`
Expected: clean.

```bash
git add packages/connectors/postgres/src/connector.ts packages/connectors/postgres/test/connector.test.ts
git commit -m "feat(connector-postgres): checksum integrity + rollback + migrationStatus"
```

---

## Task 7: Redshift connector — align to `__foundry_migrations`, stop-on-error, checksum/tamper + `rollback` + `migrationStatus`

**Files:**
- Modify: `packages/connectors/redshift/src/connector.ts`
- Modify: `packages/connectors/redshift/test/connector.test.ts`

**Interfaces:**
- Consumes: `checksumMigration` (runtime) + `AppliedMigration` (type) from `@foundry/core`.
- Produces: aligned `redshiftConnector.migrate`/`rollback`/`migrationStatus` (identical behavior to postgres).

> The redshift connector currently uses table `schema_migrations`, a single shared client for the whole run, and **continues on error**. This task aligns it with postgres: table `__foundry_migrations`, per-migration client, stop-on-error, checksum/tamper. Pre-release, so the table-name change is free (no real `schema_migrations` exists in the wild).

- [ ] **Step 0: Build core**

Run: `npm run build -w @foundry/core`
Expected: clean.

- [ ] **Step 1: Update imports + rewrite migrate, add rollback + migrationStatus**

In `packages/connectors/redshift/src/connector.ts`, add `checksumMigration` as a runtime value import from `@foundry/core`, and add `AppliedMigration` to the connector's existing type-only import from `@foundry/core`. The two import lines look like:

```ts
import { checksumMigration } from "@foundry/core";
import type { AppliedMigration } from "@foundry/core";
```

(Merge `AppliedMigration` into the existing multi-name `import type { ... } from "@foundry/core"` line rather than adding a second type import.)

Add a module-level constant near the top (mirroring postgres):

```ts
const MIGRATIONS_TABLE = "__foundry_migrations";
```

Replace the existing `migrate` method (the block using `schema_migrations`, roughly lines 311–357) with the three methods below. They are identical to the postgres connector's (Task 6) — redshift speaks the Postgres wire protocol via `pg.Pool`, so the SQL is unchanged — and are reproduced here **in full** because each task is implemented by a fresh subagent that sees only its own task:

```ts
  async migrate(conn: Connection, migrations: Migration[]): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        description TEXT,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );

    for (const migration of migrations) {
      const client = await pool.connect();
      try {
        const existing = await client.query(
          `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE id = $1`,
          [migration.id],
        );
        if ((existing.rowCount ?? 0) > 0) {
          const stored = (existing.rows[0]?.checksum ?? "") as string;
          if (stored !== checksumMigration(migration.up)) {
            errors.push({
              id: migration.id,
              error: `checksum mismatch: migration "${migration.id}" was modified after it was applied`,
            });
            break; // tamper -> stop
          }
          skipped.push(migration.id);
          continue;
        }

        try {
          await client.query("BEGIN");
          await client.query(migration.up);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (id, description, checksum) VALUES ($1, $2, $3)`,
            [migration.id, migration.description ?? null, checksumMigration(migration.up)],
          );
          await client.query("COMMIT");
          applied.push(migration.id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            /* best-effort; surface the original cause */
          });
          const err = error as Error;
          errors.push({ id: migration.id, error: err.message || "Unknown migration error" });
          break; // stop-on-error
        }
      } finally {
        client.release();
      }
    }

    return { applied, skipped, errors };
  },

  async rollback(conn: Connection, migrations: Migration[], count: number): Promise<MigrationResult> {
    const pool = conn.client as Pool;
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];

    const result = await pool.query(
      `SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT $1`,
      [count],
    );
    const ids = (result.rows as { id: string }[]).map((r) => r.id);

    for (const id of ids) {
      const migration = migrations.find((m) => m.id === id);
      if (migration === undefined || migration.down === undefined) {
        errors.push({ id, error: `migration "${id}" has no down migration` });
        break;
      }
      const client = await pool.connect();
      try {
        try {
          await client.query("BEGIN");
          await client.query(migration.down);
          await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = $1`, [id]);
          await client.query("COMMIT");
          applied.push(id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            /* best-effort */
          });
          const err = error as Error;
          errors.push({ id, error: err.message || "Unknown rollback error" });
          break;
        }
      } finally {
        client.release();
      }
    }
    return { applied, skipped, errors };
  },

  async migrationStatus(conn: Connection): Promise<AppliedMigration[]> {
    const pool = conn.client as Pool;
    const result = await pool.query(
      `SELECT id, description, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`,
    );
    return (result.rows as { id: string; description: string | null; checksum: string; applied_at: Date }[]).map(
      (r) => ({
        id: r.id,
        checksum: r.checksum,
        appliedAt: r.applied_at,
        ...(r.description !== null ? { description: r.description } : {}),
      }),
    );
  },
```

- [ ] **Step 2: Rewrite the redshift migrate tests + add rollback/status tests**

Open `packages/connectors/redshift/test/connector.test.ts`. The redshift harness uses a hoisted `mocks` object (`mocks.query`, `mocks.connect`, `mocks.end`, `mocks.ctor`). For the new tests, route every query through `mocks.query` and make `pool.connect()` return a client whose `query` is `mocks.query`:

```ts
// inside beforeEach for the migrate describe, or at the top of each test:
mocks.connect.mockResolvedValue({ query: mocks.query, release: vi.fn() });
```

Then add the same six test cases as postgres (Task 6, Step 2), substituting `mocks.query` for `pgMock.query` and `mocks.pool`/the redshift mock pool for the connection's client. Concretely, a checksum-aware routing helper:

```ts
function applyMigrateMock(appliedChecksums: Map<string, string>, failingUps: Set<string>) {
  mocks.query.mockImplementation(async (text: string, values?: unknown[]) => {
    if (text.includes("CREATE TABLE") && text.includes("__foundry_migrations")) return { rowCount: 0, rows: [] };
    if (text.startsWith("SELECT checksum FROM")) {
      const id = values?.[0] as string;
      const cs = appliedChecksums.get(id);
      return cs ? { rowCount: 1, rows: [{ checksum: cs }] } : { rowCount: 0, rows: [] };
    }
    if (text.startsWith("INSERT INTO")) {
      appliedChecksums.set(values?.[0] as string, values?.[2] as string);
      return { rowCount: 1, rows: [] };
    }
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (failingUps.has(text)) throw new Error(`migration failed: ${text}`);
    return { rowCount: 0, rows: [] };
  });
}
```

Remove the old `schema_migrations` / `mockResolvedValueOnce`-sequence migrate tests (they asserted the prior single-client/continue-on-error behavior) and replace with the six cases from Task 6 Step 2, calling `redshiftConnector.migrate!` / `.rollback!` / `.migrationStatus!` against a connection whose `.client` is the redshift mock pool.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -w @foundry/connector-redshift`
Expected: PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck -w @foundry/connector-redshift`
Expected: clean.

```bash
git add packages/connectors/redshift/src/connector.ts packages/connectors/redshift/test/connector.test.ts
git commit -m "feat(connector-redshift): align migrations + checksum integrity + rollback + status"
```

---

## Task 8: Docs — README migrations section + example

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a migrations section**

In `README.md`, after the "Quick start" section's command block (which currently lists `foundry migrate analytics <migrations>`), add a "## Migrations" section:

```markdown
## Migrations

foundry runs imperative, versioned SQL migrations (`up`/`down`) for the engines that support them (postgres, redshift). Drop paired files in a per-database directory:

```
migrations/
└── analytics/
    ├── 000001_create_users.up.sql
    ├── 000001_create_users.down.sql     # optional
    └── 000002_add_email_index.up.sql
```

The leading 1–6 digit id sets the order; foundry tracks applied migrations in a `__foundry_migrations` table with a sha256 **checksum** and refuses to run if an applied migration was edited (tamper detection).

```bash
foundry migrate analytics            # apply pending up
foundry migrate analytics --down 1   # roll back the newest migration
foundry migrate analytics --status   # applied / pending / tampered report
foundry migrate analytics --dry-run  # plan only; exits non-zero if work remains (CI gate)
```

To bring a freshly provisioned database to a migrated state in one command, opt in with `--migrate`:

```bash
foundry apply --migrate              # after create/update/replace, runs pending migrations
```

Override the directory or disable migrations per database in `foundry.config.ts`:

```ts
analytics: {
  engine: "postgres",
  provision: { kind: "aws.rds-postgres", /* ... */ },
  migrations: { dir: "db/analytics", enabled: true },
}
```
```

Also update the existing one-liner in Quick start from `foundry migrate analytics <migrations>` to `foundry migrate analytics`.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the migrations system"
```

---

## Final verification

- [ ] **Full build + typecheck + test (central — single run to avoid lockfile races):**

```bash
npm run build && npm run typecheck && npm test
```

Expected: all workspaces build; typecheck clean across all packages; all tests green (the prior 235 + the new core/loader/runtime/cli/apply + postgres/redshift migration suites).

- [ ] **Sanity grep:** confirm no stray `schema_migrations` remains and the new symbols are exported:

```bash
grep -rn "schema_migrations" packages   # expect no hits
grep -rn "checksumMigration\|migrationStatus\|runMigrateDown" packages/core/src/index.js 2>/dev/null || true
```

---

## Notes for the executor

- **Per project policy, implement coding tasks on Sonnet subagents and run the review pass on Opus.** Use superpowers:subagent-driven-development (one subagent per task, review between tasks).
- **Central install only:** if `npm install` is needed, the orchestrator runs it once — subagents must NOT run `npm install` (lockfile races).
- **`@foundry/core` must be built before connector tests** (the connectors runtime-import `checksumMigration` from core's `dist`).
- **No `Co-Authored-By` trailer** on any commit.
- The redshift connector's behavior change (table name + stop-on-error) is intentional and called out in the spec; it has no real-world migration history to preserve (pre-release, CLI never loaded migrations before).
