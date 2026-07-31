# Foundry

![status](https://img.shields.io/badge/status-v1_(Phase_1)-blue)
![node](https://img.shields.io/badge/node-%E2%89%A520-green)
![typescript](https://img.shields.io/badge/TypeScript-5.5-3178c6)
![license](https://img.shields.io/badge/license-TBD-lightgrey)

**One declarative interface for the full database lifecycle — provision, connect, migrate, observe — across engines and platforms.**

foundry fuses two layers into a single framework:

- An **infra-as-code provisioning layer** (Terraform/Pulumi-feel): create, update, and destroy *real* database instances through cloud management APIs.
- A **runtime layer** (Prisma-*feel*, not a full ORM): connect, pool, run migrations, and expose health/observability — handing your application the engine's **native client**.

The line we will not cross: **foundry never wraps or re-implements a driver's query API.** There is no universal query DSL — that cripples every engine to the lowest common feature. You always get the real driver (`pg.Pool`, `DynamoDBClient`, `MongoClient`, …) with its full types and power.

---

## The problem

Standing up a database per project is a repeated, manual, error-prone chore: create the instance in a cloud console, wire credentials, write connection boilerplate, configure pooling, add health checks, run migrations. Different engines (Postgres, DynamoDB, Mongo, Redshift) and platforms (AWS, Supabase) multiply the surface area. foundry collapses it to one declarative config and a couple of commands.

## Why foundry

- **Native clients, not a universal DSL.** The framework owns pooling, health, and migrations; *you* own the query surface, with full native typing.
- **Provisioning + runtime in one.** The same `foundry.config` drives `apply` (cloud) and `db.connect()` (runtime), joined by a single `ConnectionTarget`.
- **Secrets by reference, never by value.** Credentials live in AWS Secrets Manager / Supabase / env — state and config hold only pointers.
- **Pluggable per engine/platform.** Adding a database means writing one package, not touching the core. `kind` selects a Provisioner; `engine` selects a Connector.
- **Drift-first, stop-on-error.** Plans refresh live state before diffing; `apply` stops on the first failure with no risky auto-rollback.

## Supported engines & platforms (v1)

| `kind` (Provisioner) | `engine` (Connector) | Provisioner package | Connector package |
|---|---|---|---|
| `aws.dynamodb` | `dynamodb` | `@foundry/aws-dynamodb` | `@foundry/connector-dynamodb` |
| `aws.rds-postgres` | `postgres` | `@foundry/aws-rds-postgres` | `@foundry/connector-postgres` |
| `aws.redshift` | `redshift` | `@foundry/aws-redshift` | `@foundry/connector-redshift` |
| `supabase.postgres` | `postgres` | `@foundry/supabase-postgres` | `@foundry/connector-postgres` |
| _(external)_ | `mongodb` | — _(runtime-only in v1)_ | `@foundry/connector-mongodb` |

Note the engine→connector decoupling: the single `postgres` connector serves **both** RDS and Supabase Postgres databases. Mongo is runtime-only in v1 (`provision: "external"`).

## Quick start

**Prerequisites:** Node ≥ 20. For AWS provisioning, the ambient AWS credential chain must be configured (`AWS_REGION`/`AWS_DEFAULT_REGION` + credentials via env, shared credentials, SSO, etc.).

```bash
git clone https://github.com/scientiaai-pritam/foundry.git foundry
cd foundry
npm install
npm run build
```

Define your stack in `foundry.config.ts`:

```ts
import { defineStack } from "@foundry/core";

export default defineStack({
  databases: {
    // AWS DynamoDB — no DB-level credentials (uses the ambient AWS chain).
    sessions: {
      engine: "dynamodb",
      provision: {
        kind: "aws.dynamodb",
        tableName: "sessions",
        attributeDefinitions: [{ name: "userId", type: "S" }],
        keySchema: [{ name: "userId", type: "HASH" }],
        billingMode: "pay_per_request", // PITR defaults on (design §7)
      },
    },

    // AWS RDS Postgres — the master password is auto-managed by RDS
    // (ManageMasterUserPassword), stored in Secrets Manager, and resolved by
    // the connector at runtime; you never write a credential value. Provision
    // props are engine-specific (here: dbInstanceIdentifier/class, storage,
    // masterUsername).
    analytics: {
      engine: "postgres",
      provision: {
        kind: "aws.rds-postgres",
        dbInstanceIdentifier: "analytics",
        dbInstanceClass: "db.t4g.small",
        allocatedStorage: 20,
        masterUsername: "postgres",
        dbName: "analytics",
      },
    },

    // Externally-managed Mongo — runtime-only; foundry does not provision it.
    // connectionString is a SECRET REFERENCE (here, from the environment).
    users: {
      engine: "mongodb",
      provision: "external",
      connectionString: { from: "env:MONGO_URI" },
    },
  },
});
```

Plan, apply, and (when you're done) destroy:

```bash
foundry plan            # diff desired vs. state (+ optional drift refresh)
foundry plan --refresh  # read live cloud first, surface drift explicitly
foundry apply           # create / update / replace / destroy, stop-on-error
foundry migrate analytics            # run schema migrations
foundry destroy --force # irreversible — refuses without --force
```

Then connect from application code and use the **native** driver:

```ts
import { createAppContext } from "@foundry/app";
import { ConnectionRegistry, ConnectionManager } from "@foundry/core";

// Loads foundry.config.ts and wires the default provisioner/connector registry.
const ctx = await createAppContext();

const registry = new ConnectionRegistry(ctx.connectors, {
  state: ctx.state,   // provisioned DBs resolve their endpoint from state
  stack: ctx.stack,   // external DBs resolve from config
});
const manager = new ConnectionManager(registry);

const conn = await manager.connect("analytics");
// conn.client is the engine's NATIVE driver — here, a pg.Pool:
const { rows } = await (conn.client as import("pg").Pool).query("SELECT NOW()");

await manager.health("analytics");   // liveness for readiness probes
manager.poolStats("analytics");      // size / idle / in-use / waiting
await manager.closeAll();            // graceful drain (call on SIGTERM)
```

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

## Architecture

Two layers, connected by a shared state file. **Provisioning is rare and slow; runtime is frequent and fast.** They share nothing but the `ConnectionTarget` that provisioning emits and runtime consumes.

```
        PROVISIONING   (CLI:  plan → apply → migrate → destroy)
        ────────────
  foundry.config ─► Planner ─► Apply Orchestrator ─► Provisioners
   (desired state)    (diff)     retry · poll ·          aws-rds-postgres
                       │         drift-detect            aws-redshift
                       ▼                                  aws-dynamodb
                   state.json  ◄── updates ◄── outputs   supabase-postgres
                       │
                       └──► emits ConnectionTarget (endpoint + credsRef)
                                 │
        ─────────────────────────┼──────────────────────────
        RUNTIME       (library)  ▼
        ────────                             Connection Manager
                                              pool · health · obs
                                                    │
                                       Connectors (native drivers)
                                       pg · mongodb · aws-sdk · redshift
```

**Key boundary:** Provisioners speak cloud management APIs; Connectors speak database wire protocols. They never overlap, and both are pluggable. `kind` selects the Provisioner; `engine` selects the Connector.

### Monorepo layout

```
packages/
├── core/                  # engine-agnostic kernel (contracts + config/state/plan/apply/runtime/cli)
├── provisioners/          # cloud-management-API adapters (one package each)
│   ├── aws-dynamodb/      aws-redshift/   aws-rds-postgres/   supabase-postgres/
└── connectors/            # native-driver runtime wrappers (one package each)
    ├── dynamodb/   postgres/   mongodb/   redshift/
└── app/                   # composition root — wires concrete plugins into the CLI/runtime defaults
```

## Configuration reference

```ts
interface Stack {
  databases: Record<string, ProvisionedDatabase | ExternalDatabase>;
}

// A database foundry provisions via a cloud Provisioner.
interface ProvisionedDatabase {
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  provision: { kind: ResourceKind; [engineProp: string]: unknown };
  region?: string;   // defaults to AWS_REGION / AWS_DEFAULT_REGION
  credsRef?: SecretRef;   // pointer to the DB's own secret (e.g. RDS master password)
  tags?: Record<string, string>;
}

// A database foundry does NOT provision (runtime-only).
interface ExternalDatabase {
  engine: Engine;
  provision: "external";
  connectionString: SecretRef;
  endpoint?: string;
  region?: string;
}

// Secrets are referenced, never stored as values:
type SecretRef = { secretId: string } | { from: `env:${string}` };
```

The config loader resolves `foundry.config.{ts,mts,js,mjs,cjs}`. TypeScript configs load via Node's native TS support (Node ≥ 23.6, or `--experimental-strip-types`) and fall back to a lazy transpile via the `typescript` package.

## Security model

foundry's provisioning layer wields **cloud-admin credentials**, so it is built to be auditable and safe-by-default:

- **Secrets by reference.** Credential *values* are never stored in state or config, never logged, and never placed in error messages — only `SecretRef` pointers (`{ secretId }` or `{ from: "env:VAR" }`).
- **Ambient credential chain.** Provisioning authenticates via the standard AWS credential chain; the framework never takes custody of cloud-admin secrets. A database's `credsRef` refers to the *database's own* secret (e.g. an RDS master password), resolved by the connector at runtime — not the framework's API credentials.
- **Plan before apply.** `foundry plan` is a dry-run diff (with optional live drift refresh); nothing touches the cloud until `apply`.
- **Destroy safety.** `destroy` requires `--force` and lists every resource with its data-loss implication. `protect: true` refuses destroy without `--force` (RDS also gets native `DeletionProtection`). **Final DB snapshots are default-on** for RDS/Redshift destroy (`skipFinalSnapshot` opts out).
- **Stop-on-error, no auto-rollback.** Partial failures leave state reflecting exactly what happened; re-running `plan` shows what remains.

## Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Provisioning | **Native provisioners** calling cloud APIs directly | Seamless DX, self-contained for OSS, a state model we own — no external binary runtime. |
| Runtime | **Native clients**, no universal query DSL | A cross-engine query language cripples every engine to the lowest common feature. |
| Partial failure | **Stop-on-error, no auto-rollback** | Rolling back a half-created RDS is itself failure-prone; state is the source of truth. |
| Config | **Config-as-code (TypeScript)** | Type-safe, composable, matches the library DX. |
| State | **Local file + pluggable backend interface** | Simple now; remote/team backend (DynamoDB/S3) drops in later without core changes. |
| Plans | **Mandatory drift refresh** before diffing | State goes stale; the plan must reflect reality. |

## Project status & roadmap

**Phase 1 (v1 — current):** core kernel + four provisioners (AWS DynamoDB / RDS-Postgres / Redshift, Supabase Postgres) + four connectors (postgres / mongodb / dynamodb / redshift); `plan` / `apply` / `migrate` / `destroy` + programmatic `connect`; local state with locking; secrets-by-reference; full error-handling. **Status: complete, 235 tests green.**

**Phase 2:** remote/team state backend (DynamoDB/S3); Mongo Atlas provisioning; additional engines/platforms (MySQL, Neon, PlanetScale); RDS custom-VPC networking.

**Phase 3:** agent / natural-language provisioning; vector database support (pgvector, Pinecone, Weaviate).

**Out of scope (v1):** a universal query DSL/ORM; agent-driven provisioning; remote state backends; Mongo provisioning.

> **Validation note:** v1's test suite (235 tests) is mock-based — provisioners are validated against stubbed cloud APIs. Real-cloud integration tests (gated behind `INTEGRATION=1`) and LocalStack-in-CI are planned next.

## Development

npm-workspaces monorepo, TypeScript 5.5 (strict: `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`).

```bash
npm install          # install all workspaces
npm run build        # topological build: core → provisioners/connectors → app
npm run typecheck    # tsc --noEmit across all workspaces
npm test             # vitest run across all workspaces
npm run clean        # remove dist + tsbuildinfo from all workspaces
```

Scripts run across all workspaces via `npm run <script> --workspaces --if-present`. The workspace order in the root `package.json` is topological so `build` resolves cross-package `dist/` correctly.

### Adding an engine

1. Write a provisioner package under `packages/provisioners/<name>/` implementing the `Provisioner` contract (`plan`/`apply`/`read`/`destroy`), or a connector package under `packages/connectors/<name>/` implementing `Connector`.
2. Register it in `packages/app/src/context.ts` (`buildDefaultPlugins`).
3. Add the `kind`→`engine` mapping in `packages/core/src/config/index.ts` if it's a new provisionable kind.

The core never imports a concrete plugin — only the contract shapes — so new engines don't touch the kernel.

## License

To be determined — a `LICENSE` file will be added before public release.
