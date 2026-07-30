# Foundry Migrations — Design

- **Date:** 2026-07-30
- **Status:** Approved design → pending spec review
- **Phase:** Phase 1 extension (builds on the v1 kernel)
- **Related:** `docs/superpowers/specs/2026-07-28-foundry-design.md` (v1 design, §4–§7)

## 1. Problem

The v1 kernel ships a `migrate` command and a `Connector.migrate?` contract, but the
feature is **stubbed at the seam**:

- The **postgres** and **redshift** connectors implement `migrate()` — but only the
  forward (`up`) path, and the `__foundry_migrations` tracking table has **no checksum
  column**, so a migration edited after it was applied is undetectable.
- `foundry migrate <db>` is wired to `runMigrate(ctx, dbId, opts.migrations ?? [])`, and
  `main()` **never populates `opts.migrations`** — the CLI runs **zero** migrations today.
  There is no loader that reads migration files from disk.
- There is no `down`, no `status`, no integrity check, and no integration with `apply` —
  so a freshly provisioned Postgres comes up with an empty schema unless the operator
  remembers a separate `migrate` step.

This design closes those gaps and, critically, makes migrations a **first-class part of the
provision → connect lifecycle**: `foundry apply` can bring a new database to a *migrated*
state in one command.

## 2. Goals

1. **Disk loader.** Read, parse, order, and de-duplicate migration files from a
   per-database directory.
2. **Forward integrity.** Extend the tracking table with a checksum; detect and refuse
   tampered (edited-after-apply) migrations.
3. **Rollback.** `down` migrations run newest-first to a count.
4. **Status & dry-run.** Report applied / pending / tampered; a CI-safe dry-run that plans
   without executing.
5. **Integrated lifecycle.** `foundry apply --migrate` runs pending migrations against a
   just-provisioned (or just-updated) target — the same `ConnectionTarget` provisioning
   emits and runtime consumes.
6. **Wire the stub.** `foundry migrate <db>` actually loads and applies migrations.

## 3. Non-goals (deferred)

These are explicitly out of scope for this iteration:

- **Declarative schema diff** (Prisma-migrate-style SQL generation from a schema file).
  v1 stays imperative (`up`/`down` SQL you author). The loader is shaped so a declarative
  generator can drop files in later.
- **`.ts` / programmatic migrations.** SQL files only; a programmatic migration type is a
  fast-follow.
- **Zero-downtime / expand-contract policies.**
- **Cross-database transactional migrations.**
- **Migration branching / merge-conflict resolution tooling.**
- **Concurrent-migrator locking** (e.g. a `pg_advisory_lock` around the run). v1 assumes a
  single migrator process (one CI runner / one operator). Documented as an assumption;
  advisory locking is a fast-follow.
- **Hard-error on a migration applied but later deleted from disk.** `--status` reports it
  as a warning; v1 only hard-errors on checksum mismatch of a *present* migration.

## 4. Paradigm

**Imperative SQL, hybrid-ready** — the golang-migrate / Flyway model: paired `up`/`down`
SQL files, ordered by a numeric prefix, tracked in a table with checksums. No declarative
diff, no proprietary schema language. The connector exposes the engine's native SQL
execution; foundry owns ordering, tracking, and integrity.

This matches the project's core boundary (v1 design): foundry never wraps a driver's
query surface. Migrations are no exception — `up` is raw SQL handed to the native client.

## 5. File model

### 5.1 Layout

Per-database directory, default `migrations/<dbId>/` relative to the working directory
(the directory `foundry` runs in, i.e. where `foundry.config.*` lives):

```
migrations/
└── analytics/
    ├── 000001_create_users.up.sql
    ├── 000001_create_users.down.sql        # optional
    ├── 000002_add_email_index.up.sql
    └── 000003_orders.up.sql
```

Overridable per-database via config (§6):

```ts
analytics: { engine: "postgres", provision: {...}, migrations: { dir: "db/analytics" } }
```

### 5.2 Filename contract

```
<id>_<slug>.up.sql     (required)
<id>_<slug>.down.sql   (optional)
```

- `id` = 1–6 ASCII digits. Canonicalized to a **6-digit zero-padded string** (`1` →
  `"000001"`) so lexicographic sort == numeric order up to 999999. This canonical string
  is the `Migration.id` stored in the tracking table.
- `slug` = `[a-z0-9_]+`, the human description (`create_users`). Becomes `Migration.description`.
- The `<id>_<slug>` pair must match for `.up.sql` and `.down.sql`.

A file ending in `.up.sql` that does **not** match `^(\d{1,6})_([a-z0-9_]+)\.up\.sql$` is a
hard error (catches typos like `001.foo.up.sql` or `create_users.up.sql`). Files that are
not `.up.sql` / `.down.sql` (e.g. a `README.md`) are **ignored**.

### 5.3 Loader output

```ts
interface LoadedMigration {
  id: string;          // canonical "000001"
  description: string; // "create_users"
  up: string;          // file contents
  down?: string;       // .down.sql contents, if present
  source: string;      // filename, for error messages
}
```

Loader contract (`loadMigrations(dir)`):

1. Read the directory. Collect every `*.up.sql` entry.
2. Parse each against the filename regex; error on a `.up.sql` that fails the pattern
   (include the filename in the message).
3. For each, read the paired `*.down.sql` if it exists; warn (not error) on an orphan
   `.down.sql` with no matching `.up.sql`.
4. Canonicalize `id`, build `LoadedMigration`.
5. **De-duplicate:** error if two source files canonicalize to the same `id`.
6. **Order** ascending by canonical `id`.
7. Return `LoadedMigration[]`.

### 5.4 Module placement

New module **`packages/core/src/migrations/index.ts`** exports:

```ts
export interface LoadedMigration { ... }                     // above
export function loadMigrations(dir: string): LoadedMigration[];
export function checksumMigration(up: string): string;       // sha256 hex of the up SQL
export function resolveMigrationDir(cwd: string, dbId: string, cfg?: MigrationsConfig): string;
```

`checksumMigration` is **single-sourced in core** (not duplicated per connector) so the
postgres and redshift connectors compute identical checksums. It is sha256 of the UTF-8
`up` string, hex-encoded.

## 6. Configuration

### 6.1 New type

Add to `@foundry/core` config (`packages/core/src/config/index.ts`):

```ts
export interface MigrationsConfig {
  /** Disable migrations for this database. Default: enabled if a dir resolves. */
  readonly enabled?: boolean;
  /** Migration directory, relative to cwd. Default: migrations/<dbId>/. */
  readonly dir?: string;
}
```

Add `readonly migrations?: MigrationsConfig;` to **both** `ProvisionedDatabase` and
`ExternalDatabase` (an externally-managed Postgres can carry migrations too). It is a
sibling of `engine` / `provision` / `region`, not a provision prop.

### 6.2 Validation

`validateDatabase` gains a branch: if `migrations` is present it must be an object;
`enabled` must be boolean if present; `dir` must be a non-empty string if present. Config
validation **cannot** know whether an engine's connector supports `migrate?` (core never
imports connectors), so engine-capability is checked at run time:

- `migrate <db>` against a connector with no `migrate?` → clear error:
  `engine "dynamodb" does not support migrations`.
- `apply --migrate` silently skips databases whose connector lacks `migrate?`.

## 7. Tracking table & integrity

### 7.1 Schema (extended)

```sql
CREATE TABLE IF NOT EXISTS __foundry_migrations (
  id          TEXT PRIMARY KEY,
  description TEXT,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The `checksum` column is **added now** (pre-release — no migration-of-the-migration-table).
`applied_at` is retained for `--status`.

### 7.2 Apply (`up`) semantics — connector

Ensure `__foundry_migrations` exists first (idempotent `CREATE TABLE IF NOT EXISTS`), then
for each `LoadedMigration` in order:

1. `SELECT checksum FROM __foundry_migrations WHERE id = $1`.
2. **Not applied** → `BEGIN`; execute `up`; `INSERT (id, description, checksum)`; `COMMIT`.
   Record in `applied`.
3. **Applied, checksum matches** → skip. Record in `skipped`.
4. **Applied, checksum MISMATCH** → tamper detected. Push
   `{ id, error: "checksum mismatch: migration \"<id>\" was modified after it was applied" }`
   to `errors` and **stop** (stop-on-error, consistent with the apply orchestrator). Do not
   run further migrations.

This is the existing postgres `migrate()` loop, extended with the checksum column on the
table and the mismatch check in step 3. Redshift's `migrate()` gets the same treatment.

### 7.3 Rollback (`down`) semantics — connector

`rollback(conn, migrations, count)`:

1. `SELECT id FROM __foundry_migrations ORDER BY id DESC LIMIT <count>`.
2. For each returned `id`, **newest first**, find the matching `LoadedMigration`:
   - No matching migration on disk, or `down` is `undefined` → error
     `migration "<id>" has no down migration` and stop.
   - Otherwise: `BEGIN`; execute `down`; `DELETE FROM __foundry_migrations WHERE id = $1`;
     `COMMIT`. Record the `id` in `applied` (semantics: "rolled back").
3. Stop-on-error, as everywhere else.

Rollback always reverses in LIFO (newest-first) order, which is the only safe order when
later migrations depend on earlier ones' objects.

### 7.4 Status — connector

`migrationStatus(conn): Promise<AppliedMigration[]>` — a single
`SELECT id, description, checksum, applied_at FROM __foundry_migrations ORDER BY id ASC`.
Returns the raw applied rows; the CLI diffs these against the on-disk set to compute
pending / tampered.

New contract type:

```ts
interface AppliedMigration {
  id: string;
  description?: string;
  checksum: string;
  appliedAt: Date;
}
```

## 8. Connector contract changes

`packages/core/src/contracts.ts`:

```ts
interface Connector {
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  connect(target: ConnectionTarget): Promise<Connection>;
  health(conn: Connection): Promise<HealthStatus>;
  migrate?(conn: Connection, migrations: Migration[]): Promise<MigrationResult>;          // + checksum/tamper
  rollback?(conn: Connection, migrations: Migration[], count: number): Promise<MigrationResult>;
  migrationStatus?(conn: Connection): Promise<AppliedMigration[]>;
}
```

`migrate?` keeps its existing signature (it already receives the full `Migration[]`); the
change is internal (checksum + tamper). The two new optionals live where `migrate?` does —
on the connector, which owns the driver and all `__foundry_migrations` SQL. The
postgres and redshift connectors implement all three; dynamodb and mongodb omit them.

`MigrationResult` is reused for `rollback`; for rollback, `applied` means "rolled back."
This avoids widening the contract with a parallel result type.

## 9. Runtime manager

`ConnectionManager` (`packages/core/src/runtime/index.ts`) gains two thin delegators that
mirror the existing `migrate(dbId, migrations)`:

```ts
rollback(dbId: string, migrations: Migration[], count: number): Promise<MigrationResult>;
migrationStatus(dbId: string): Promise<AppliedMigration[]>;
```

Each connects (via the registry), calls the connector's optional method, and drains in a
`finally`. If the connector lacks the method, throw a clear `EngineMigrationsUnsupportedError`.

## 10. CLI surface

### 10.1 `foundry migrate <db>`

| Flag | Behavior | Exit code |
|---|---|---|
| *(none)* | Load `<dir>` and apply pending `up`. | 0, or 1 on any error |
| `--down [N]` | Roll back N (default 1) applied migrations, newest-first. | 0, or 1 on error |
| `--status` | Report applied / pending / tampered. Read-only. | 0; **1 if tampered** |
| `--dry-run` | Plan only (no execution). Print pending + tampered. | **0 only if nothing pending AND nothing tampered** (CI gate) |

`--down` takes an optional integer: bare `--down` means N=1; `--down 3` rolls back three.
(The existing `parseArgs` already yields `true` for a bare flag and a string for a valued
one, so the dispatch is `N = flags.down === true ? 1 : Number(flags.down)`.)

`--status` and `--dry-run` both connect, call `migrationStatus`, and disconnect without
running `up`/`down`. The difference is intent: `--status` is a human report (exits 0 unless
there's a real integrity problem); `--dry-run` is a CI gate (exits non-zero the moment there
is unapplied work, so a deploy pipeline fails fast when migrations were forgotten).

`main()`'s `migrate` case is rewritten: resolve the dir for `<db>`, `loadMigrations`, then
dispatch on the flag. `MainOptions.migrations` stays as a test-injection override of the
disk load.

### 10.2 `foundry apply --migrate`

`--migrate` is an **explicit opt-in** flag on `apply` (default off) — a plain
`foundry apply` never connects to a database and runs schema changes. With `--migrate`:

1. Run the normal apply (create / update / replace / delete / noop).
2. For each step result where `op ∈ {create, update, replace}`, `status === "applied"`,
   and the step carries a `state` with a `ConnectionTarget`, evaluate the **migration
   predicate** — run migrations iff **all** hold:
   - the database's config has `migrations.enabled !== false` (explicit `false` opts out;
     absent defaults to enabled), **and**
   - a migration dir resolves for the database **and** `loadMigrations` returns a non-empty
     list (missing/empty dir → skip silently), **and**
   - the connector for `state.connection.engine` exposes `migrate?`.
3. For each database that passes: connect to `state.connection`, run pending `up`
   (already-applied skipped), drain, and record the result on the step.
4. Migrations run **after** the apply succeeds; a migration failure does **not** roll back
   the provisioning (consistent with stop-on-error, no-auto-rollback). The apply result
   reports the migration error on the step.

**Step-result reporting:** `ApplyStepResult` (`packages/core/src/apply/index.ts`) gains an
optional `migrations?: { applied: number; skipped: number; errors: number }` summary so the
apply output can show, per database, how many migrations ran. Counts only — the full
`MigrationResult` is logged, not serialized into state.

**Why `replace` is included:** a replace destroys and recreates the instance, yielding a
fresh, empty database that needs its schema — so it is create-equivalent for migration
purposes. `delete` and `noop` never trigger migrations.

### 10.3 Ordering within apply

Migrations run **after all provisioning steps complete**, not interleaved. Rationale: a
single DB's endpoint is only usable after its instance is `available`, and provisioning
already polls to availability inside the provisioner. Running migrations in a dedicated
post-apply pass keeps the orchestrator's existing stop-on-error / state-persistence logic
untouched.

## 11. Engine scope

| Engine | `migrate` (up+checksum) | `rollback` (down) | `migrationStatus` |
|---|---|---|---|
| postgres | ✓ (extend) | ✓ (new) | ✓ (new) |
| redshift | ✓ (extend) | ✓ (new) | ✓ (new) |
| dynamodb | — (no schema) | — | — |
| mongodb | — (deferred; mongo connector has no `migrate?` in v1) | — | — |

## 12. Security

Inherits the v1 security model, no new surface:

- Migration SQL is **user-authored DDL**, not credentials. Error detail is the driver's
  message; no credential values are added (same posture as the existing postgres
  `migrate()`).
- The connector connects via the existing `ConnectionTarget` + `credsRef` resolution path;
  `apply --migrate` reuses the **same** connection the runtime would use — no new secret
  handling.
- Checksums are sha256 of public SQL; storing them in `__foundry_migrations` leaks nothing.

## 13. Testing

All mock-based (consistent with the existing 235-test suite; real-cloud `INTEGRATION=1`
tests remain deferred).

**`packages/core/src/migrations/` (new, pure functions):**
- Filename parsing: canonical id zero-padding, slug extraction, regex reject cases.
- Ordering: numeric order regardless of filename sort quirks.
- De-dup error on duplicate canonical id.
- `.down.sql` pairing; orphan-down warning.
- `checksumMigration` determinism + stability across identical/differing input.
- `resolveMigrationDir` default vs override.

**postgres connector (`packages/connectors/postgres`):**
- Extend the existing migrate tests: checksum stored on first apply; re-run skips; **tamper**
  (edit `up` between two runs) → error + stop; partial-then-stop-on-error rolls back the
  failing migration's tx.
- New `rollback` tests: newest-first ordering, `count` limit, missing `down` → error,
  deletes the tracking row on success.
- New `migrationStatus` test: returns rows in id order.

**redshift connector (`packages/connectors/redshift`):** parallel set.

**CLI / apply (`packages/core`):**
- `runMigrate` dispatch: no-flag applies up; `--down N` rolls back; `--status` reports;
  `--dry-run` exits non-zero when pending. Use an injected **fake connector** implementing
  `migrate`/`rollback`/`migrationStatus` over an in-memory tracking map.
- `apply --migrate` integration: fake provisioner emits a `ConnectionTarget`; assert the
  post-apply pass connects, runs pending up, and appends the summary; assert it is **skipped**
  when the connector lacks `migrate?`, and skipped for `delete`/`noop`.
- Disk-loader wiring: point `loadMigrations` at a temp dir of fixture `.sql` files.

## 14. Build order (preview — the plan will detail this)

1. `@foundry/core`: `migrations/` module (loader + checksum + dir resolver) + tests.
2. `@foundry/core`: contract additions (`AppliedMigration`, `rollback?`, `migrationStatus?`,
   `checksumMigration` export) + config (`MigrationsConfig`) + validation.
3. `@foundry/core`: `ConnectionManager.rollback` / `migrationStatus`; CLI `migrate` flag
   dispatch + disk wiring; `apply --migrate` post-pass + step-summary.
4. `@foundry/connectors/postgres`: extend `migrate` (checksum/tamper), add `rollback` +
   `migrationStatus` + tests.
5. `@foundry/connectors/redshift`: same.
6. Docs: README migration section + a `migrations/` example.

Per project policy: fan out the coding work on **Sonnet** subagents; run the review/verify
pass on **Opus**. No `Co-Authored-By` trailer on commits.

## 15. Open questions for review

1. **`apply --migrate` default.** Off-by-default (explicit opt-in) is the safe choice
   proposed here. Alternative: default-on for databases with a `migrations/` dir. leaning
   off.
2. **`--dry-run` gate strictness.** Proposed: exit 1 if *anything* is pending or tampered.
   Alternative: exit 0 when nothing is *tampered* (treat pending as informational).
3. **Missing-on-disk applied migration.** `--status` warns; migrate-up does not hard-error.
   Confirm this is the right v1 posture (vs. Flyway-style hard error).
