# foundry — Design (v1)

**Status:** Draft for review
**Date:** 2026-07-28
**Codename:** foundry

---

## 1. Overview

foundry is an internal framework (designed to be open-sourceable later) that reduces the time and friction of standing up databases across an AI-focused company's many projects and products. It provides a single declarative interface for the **full lifecycle** of a database — provision the instance, connect to it, migrate its schema, observe its health — across multiple engines and cloud platforms.

It is deliberately two things fused:

- An **infra-as-code provisioning layer** (Terraform/Pulumi-like): create, update, and destroy real database instances via cloud management APIs.
- A **runtime layer** (Prisma-*feel*, not a full ORM): connect, pool, run migrations, expose health and observability — and hand the application the engine's **native client**.

### Problem

Setting up a database per project is a repeated, manual, error-prone chore: create the instance in a cloud console, wire credentials, write connection boilerplate, configure pooling, add health checks and metrics, run migrations. Different engines (Postgres, DynamoDB, Mongo, Redshift) and different platforms (AWS, Supabase) multiply the surface area. The goal is to collapse this to one declarative config and a couple of commands.

### Goal (v1)

From a single `foundry.config`, a developer can `plan` and `apply` to provision real databases on AWS and Supabase, then `db.connect()` from application code to obtain a pooled, observable native client — with schema migrations where the engine supports them.

---

## 2. Scope

### In scope (v1)

- **Provisioning platforms:** AWS (DynamoDB tables, RDS-Postgres, Redshift clusters) and Supabase (Postgres projects with auth/realtime/storage toggles).
- **Runtime engines:** Postgres, MongoDB, DynamoDB, Redshift — reached through their **native drivers**.
- **Lifecycle commands:** `plan` (diff + drift), `apply` (create/update/replace/destroy), `migrate` (schema), `connect` (runtime), `destroy` (safe teardown).
- **Cross-cutting:** declarative config, file-backed state with locking, secrets-by-reference, retries/idempotency, health checks, observability hooks, audit logging.

### Out of scope (v1 — explicitly deferred)

- **Agent / natural-language provisioning** ("set me up a RAG Postgres") — Phase 3.
- **Vector database support** (pgvector, Pinecone, Weaviate, etc.) — Phase 3.
- **Full ORM / query DSL** (a Prisma-style schema language + generated cross-engine query builder). This is the **universal-query-language anti-pattern** the design rejects; the runtime always exposes native clients.
- **Remote / team state backends** (DynamoDB/S3) — Phase 2. The backend interface is in place now so this drops in later without touching the core.
- **Mongo provisioning** (Atlas cluster creation) — Phase 2. Mongo is runtime-only in v1.
- **Multi-cloud beyond AWS + Supabase** (GCP/Azure/Neon/PlanetScale) — later phases.

### Audience

Internal first; designed to be open-sourced later without breaking changes. This implies: clean plugin boundaries, no company-specific leakage, strong DX, safe defaults, and auditability (provisioning wields cloud-admin credentials).

---

## 3. Implementation language

**TypeScript (confirmed).**

Rationale: an AI-application company benefits most from TypeScript's DX, the broadest driver ecosystem for every engine in scope, the easiest path to OSS adoption, and it runs where the web/app layer runs. The architecture is language-agnostic — every contract maps 1:1 to Python type hints or Go interfaces — so a port later is mechanical, not a redesign.

---

## 4. Architecture

Two layers, connected by a shared state file. **Provisioning is rare and slow; runtime is frequent and fast.** They share nothing but the `ConnectionTarget` the provisioning layer emits and the runtime layer consumes.

```
        PROVISIONING   (CLI:  plan → apply → destroy)
        ────────────
  foundry.config ─► Planner ─► Apply Orchestrator ─► Provisioners
   (desired state)    (diff)     retry · poll ·          aws-rds-postgres
                       │         drift-detect            aws-redshift
                       ▼                                  aws-dynamodb
                   state.json  ◄── updates ◄── outputs   supabase-postgres
                       │
                       └──► emits ConnectionTarget (endpoint + creds)
                                 │
        ─────────────────────────┼──────────────────────────
        RUNTIME       (library:  db.connect())            ▼
        ────────                                 Connection Manager
                                                 pool · health · obs
                                                       │
                                          Connectors (native drivers)
                                          pg · mongodb · aws-sdk · redshift
```

### Module layout (monorepo)

```
packages/
├── core/                  # engine-agnostic kernel
│   ├── config/            # schema + loader  (foundry.config.ts)
│   ├── plan/              # desired-vs-state diffing → PlanAction[]
│   ├── apply/             # orchestrator: retry, poll, eventual-consistency, drift
│   ├── state/             # state.json read / write / lock  (pluggable backend)
│   ├── runtime/           # connection registry, pool, health, observability
│   └── cli/               # `foundry plan | apply | migrate | destroy`
├── provisioners/          # cloud-management-API adapters (one package each)
│   ├── aws-rds-postgres/  #   RDS CreateDBInstance (+ default-VPC quickstart)
│   ├── aws-redshift/      #   Redshift CreateCluster
│   ├── aws-dynamodb/      #   CreateTable + key schema + GSIs + billing mode
│   └── supabase-postgres/ #   Supabase Management API: create project + addon toggles
└── connectors/            # native-driver runtime wrappers (one package each)
    ├── postgres/          #   wraps `pg`
    ├── mongodb/           #   wraps the `mongodb` driver
    ├── dynamodb/          #   wraps AWS SDK v3 DynamoDBClient
    └── redshift/          #   wraps the Redshift Data API
```

### Provision flow

`foundry.config` (desired state) → **Planner** diffs it against `state.json` *and* live cloud reads (for drift) → emits a `Plan`: a list of create/update/replace/destroy actions. User reviews with `foundry plan`, then runs `foundry apply` → the **orchestrator** executes each action through the matching **Provisioner**, polling cloud APIs until resources are actually *available* (RDS and Redshift take minutes), retrying transient failures, writing updated state, and emitting each database's `ConnectionTarget` (endpoint + resolved credentials).

### Runtime flow

The application calls `db.connect("analytics")` → the **registry** resolves that database's `ConnectionTarget` (from state or env) → the matching **Connector** opens a pooled native client → the application receives the native driver (with its own types) → health checks and tracing/metrics hooks are active for the connection's lifetime.

### Key boundary

**Provisioners speak cloud management APIs; Connectors speak database wire protocols.** They never overlap, and both are pluggable per engine/platform. Adding a new database = writing one new package, not touching the core. Decoupling note: the same Postgres *engine* can be provisioned by *either* `aws.rds-postgres` *or* `supabase.postgres` — `kind` selects the Provisioner, `engine` selects the Connector.

---

## 5. Core contracts

Everything plugs in through two contracts. The core never imports a provisioner or connector — it only knows these shapes.

### Resource model (shared)

```ts
type ResourceKind =
  | "aws.rds-postgres" | "aws.redshift" | "aws.dynamodb" | "supabase.postgres";

interface ResourceSpec {          // what the user WROTE in config (desired)
  id: string;                     // stable logical name, e.g. "analytics"
  kind: ResourceKind;
  props: Record<string, unknown>; // engine-specific (instance class, key schema, nodes…)
  tags?: Record<string, string>;
}

interface ResourceState {         // what actually EXISTS (cloud + state.json)
  id: string;
  kind: ResourceKind;
  identifiers: Record<string, string>;  // ARN, cluster-id, project-ref, table name…
  status: "creating" | "available" | "updating" | "deleting" | "error";
  connection: ConnectionTarget;         // produced once available
  outputs?: Record<string, unknown>;    // provider bookkeeping (sg ids, subnet group…)
}

interface ConnectionTarget {      // everything the runtime needs to connect
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  endpoint?: string;              // host:port (postgres/redshift/mongo)
  region?: string;                // (dynamodb/redshift)
  credsRef: SecretRef;            // POINTER to a secret — never the value itself
}

// Secrets are referenced, never stored as values in state or config:
type SecretRef =
  | { secretId: string }        // managed secret (AWS Secrets Manager / Supabase vault)
  | { from: `env:${string}` };  // env-var reference, e.g. { from: "env:MONGO_URI" }
```

### Provisioner interface

```ts
interface Provisioner {
  kind: ResourceKind;
  plan(desired: ResourceSpec, current: ResourceState | null): PlanAction;
  apply(action: PlanAction): Promise<ResourceState>;   // polls until ready; returns new state
  read(spec: ResourceSpec): Promise<ResourceState | null>;  // live read for drift detection
  destroy(state: ResourceState): Promise<void>;
}

type PlanAction =
  | { op: "create";  spec: ResourceSpec }
  | { op: "update";  spec: ResourceSpec; from: ResourceState; changedFields: string[] }
  | { op: "replace"; spec: ResourceSpec; reason: string }   // force-recreate (e.g. key-schema change)
  | { op: "delete";  state: ResourceState }
  | { op: "noop";    reason: string };
```

The `update` vs `replace` split is load-bearing: scaling an RDS instance class or adding a DynamoDB GSI is in-place (`update`); changing a DynamoDB *key schema* cannot be done in place and forces a `replace`. Each provisioner owns that judgment.

### Connector interface

```ts
interface Connector {
  engine: "postgres" | "mongodb" | "dynamodb" | "redshift";
  connect(target: ConnectionTarget): Promise<Connection>;   // opens a pooled native client
  health(conn: Connection): Promise<HealthStatus>;
  migrate?(conn: Connection, migrations: Migration[]): Promise<MigrationResult>;  // where supported
}

interface Connection {
  engine: string;
  client: unknown;        // the NATIVE driver: pg.Pool | mongodb.Db | DynamoDBClient | ...
  pool: PoolStats;        // size, idle, in-use, waiting
  close(): Promise<void>;
}

interface HealthStatus { ok: boolean; latencyMs: number; detail?: string; }

// Supporting types (full definitions land in implementation):
interface PoolStats { size: number; idle: number; inUse: number; waiting: number; }
interface Migration { id: string; description?: string; up: string; down?: string; }   // SQL or engine-native DDL
interface MigrationResult { applied: string[]; skipped: string[]; errors: { id: string; error: string }[]; }
// `migrate` is optional: only engines with a schema concept implement it (postgres, redshift, mongodb-to-extent); DynamoDB omits it.
```

`client` is `unknown` at the core level, but each connector returns its engine's typed driver — so application code keeps full native typing and power. The framework owns the pool lifecycle and health checks; it **never** wraps or re-implements a driver's query API. That is the anti-pattern line this design will not cross.

### Config (desired state)

```ts
// foundry.config.ts  — config-as-code, type-safe, composable (SST/Pulumi-style)
import { defineStack } from "@foundry/core";

export default defineStack({
  databases: {
    analytics:  { engine: "postgres",  provision: { kind: "aws.rds-postgres", instanceClass: "db.t4g.small" } },
    sessions:   { engine: "dynamodb",  provision: { kind: "aws.dynamodb", tableName: "sessions", keySchema: { /* … */ }, billingMode: "pay_per_request" } },
    warehouse:  { engine: "redshift",  provision: { kind: "aws.redshift", nodeType: "ra3.xlplus", numberOfNodes: 2 } },
    appdb:      { engine: "postgres",  provision: { kind: "supabase.postgres", plan: "pro", addons: ["auth","realtime"] } },
    users:      { engine: "mongodb",   provision: "external", connectionString: { from: "env:MONGO_URI" } },
  },
});
```

`provision: "external"` (Mongo in v1) skips provisioning entirely — runtime-only.

### State

```jsonc
// foundry.state.json  (gitignored — the framework's source of truth for "what it owns")
{
  "version": 1,
  "resources": {
    "analytics": {
      "id": "analytics", "kind": "aws.rds-postgres", "status": "available",
      "identifiers": { "dbInstanceId": "foundry-analytics-9f3a", "arn": "arn:aws:rds:…" },
      "connection": { "engine": "postgres", "endpoint": "foundry-analytics-9f3a.xxxx.rds.amazonaws.com:5432",
                      "credsRef": { "secretId": "foundry/analytics" } },
      "outputs": { "securityGroupId": "sg-…", "subnetGroupId": "…" }
    }
  }
}
```

- **Secrets never live in state** — only `credsRef` pointers; values stay in AWS Secrets Manager / Supabase / env.
- **State lock** during `apply` (local lockfile for v1; pluggable remote backend like DynamoDB/S3 for teams in Phase 2).
- **Drift** = `read()` the live resource during `plan`, compare to state, surface differences explicitly.

---

## 6. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Provisioning mechanism | **Native provisioners** calling cloud APIs directly (not wrapped Terraform/Pulumi) | Seamless DX, self-contained for OSS, state model we own, no external binary runtime. Wrapping IaC re-imports the friction the product exists to kill. |
| Runtime abstraction | **Native clients**, no universal query DSL | A cross-engine query language is the anti-pattern; it cripples every engine to the lowest common feature. |
| Partial-failure semantics | **Stop-on-error, no auto-rollback** | Rollback of a half-created RDS is itself failure-prone. State is the source of truth; re-running `plan` shows what remains. |
| Config format | **Config-as-code (TS)** | Type-safe, composable, matches the library DX. |
| State storage | **Local file**, pluggable backend interface | Simple + OSS-friendly now; remote/team backend in Phase 2 without core changes. |
| Plan/apply | **Mandatory drift refresh** before diffing | State goes stale; the plan must reflect reality. |

---

## 7. Error handling

Cloud APIs are slow, eventually-consistent, and occasionally irreversible. This layer is where the framework earns or loses trust.

### Polling & eventual consistency
A provisioner's `apply()` **owns** polling its resource to readiness — it does not return until the resource is usable, or times out. The orchestrator supplies a shared `waitFor(predicate, {timeout, interval})` helper with exponential backoff. Each provisioner declares its readiness check:

- RDS → `DBInstanceStatus === "available"` (5–15 min)
- Redshift → cluster `available`
- DynamoDB → `TableStatus === "ACTIVE"` (seconds)
- Supabase → project `ACTIVE`

A timeout marks the resource `error` in state and surfaces a precise, retryable failure.

### Retries & idempotency
Every cloud call flows through a shared client wrapper:

- **Idempotency tokens** (AWS `ClientRequestToken`, derived from `resource.id` + action) — a retry after a network timeout never creates a second RDS instance.
- Exponential backoff + jitter on throttling / transient 5xx, respecting `Retry-After`.

### Partial-failure semantics
**Stop-on-error, no auto-rollback.** Prior successes stay applied; state reflects exactly what happened; the error names the resource, action, and underlying API error with a suggested next step. The user fixes the cause and re-runs `plan` (now showing only what's left) then `apply`. An opt-in `--continue-on-error` exists for batch-tolerant cases, but stop-on-error is the safe default.

### Drift
`plan` and `apply` always `read()` each tracked resource fresh from the cloud before diffing. Drift is shown explicitly — e.g. `sessions: drifted — billing mode changed externally (provisioned → pay_per_request)` — and the user chooses to reconcile (`apply`) or accept (update config). A `--refresh-only` mode shows drift without proposing changes.

### Destroy safety (irreversible ops)
- `destroy` requires explicit confirmation and lists exactly what is deleted plus the data-loss implication.
- `protect: true` in config → destroy refuses without `--force`. RDS gets native `DeletionProtection`; DynamoDB gets a framework-level guard plus point-in-time-recovery enabled by default.
- Final DB snapshot for RDS/Redshift on destroy (default on for stateful engines). `replace` never auto-destroys without confirmation.

### Runtime errors
Connector retries initial connect with backoff; `health()` exposes liveness for readiness probes; pools drain gracefully on `SIGTERM`; pool exhaustion has configurable timeouts and wait-time metrics.

---

## 8. Testing strategy

A framework that calls real cloud APIs needs a layered pyramid — most tests never touch the cloud.

- **Unit (fast, no cloud)** — the *Planner* (diffing desired-vs-state into correct `PlanAction`s; update-vs-replace classification), state read/write, config validation, retry/backoff math, idempotency-token derivation. The bulk of the suite.
- **Property tests** for the Planner — invariants like: `plan` after `apply` converges to `noop`; `apply(plan(x))` is idempotent.
- **Contract tests per plugin** — each Provisioner/Connector tested against a stubbed API (e.g. `aws-sdk-client-mock`): correct calls on create/update/destroy, polling-to-ready, retry-on-throttle, error classification.
- **LocalStack in CI** — emulates DynamoDB/RDS so provisioning tests run cheaply and credential-free on every PR.
- **Real-cloud integration (gated)** — a small suite that actually provisions + destroys a tiny RDS, a DynamoDB table, a Supabase project, behind `INTEGRATION=1` in a dedicated test account. Tagged, auto-cleaned, with a nightly "nuke" sweep to kill orphans. (Supabase has no emulator → leans more on mocks + one thin real test.)
- **End-to-end vertical slice** — one golden path: `defineStack → plan → apply → assert available → db.connect() → query → destroy → assert gone`. LocalStack in CI; real cloud nightly.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **RDS inside a real VPC** (subnets, security groups) is where native provisioning gets gnarly. | Ship RDS quickstart on the default VPC first. Keep a documented **Pulumi-bridge escape hatch** for custom networking *if* it proves disproportionate — not the starting design. |
| **Supabase Management API** has no emulator and tighter rate limits. | Thinner, more mock-dependent coverage; one thin real integration test; conservative retry/backoff for Supabase calls. |
| **State-file conflicts** in team use. | Local lock now; Phase 2 remote backend (DynamoDB/S3) removes the conflict surface. |

---

## 10. Roadmap

- **Phase 1 (this design — v1):** core kernel + four provisioners (AWS DynamoDB/RDS-Postgres/Redshift, Supabase Postgres) + four connectors (postgres/mongodb/dynamodb/redshift); plan/apply/migrate/destroy/connect; local state with locking; full error-handling + testing pyramid.
- **Phase 2:** remote/team state backend (DynamoDB/S3); Mongo Atlas provisioning; additional engines/platforms (MySQL, Neon, PlanetScale); RDS custom-VPC networking (or Pulumi bridge).
- **Phase 3:** agent / natural-language provisioning layer; vector database support (pgvector, Pinecone, Weaviate).

---

## 11. Status

All decisions confirmed at design review (2026-07-28). Implementation language locked as **TypeScript** (see §3). The design is ready for implementation.
