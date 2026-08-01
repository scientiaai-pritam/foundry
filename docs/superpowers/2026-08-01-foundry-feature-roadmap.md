# Foundry Feature Roadmap (Research-Grounded)

> **Status:** Strategy / direction document — not an implementation plan.
> **Date:** 2026-08-01
> **Method:** Competitive landscape research (GitHub metadata + README deep-reads) → convergence analysis → phased roadmap.
> **Related:** The first actionable implementation plan derived from this roadmap is [`plans/2026-08-01-foundry-cost-estimation.md`](./plans/2026-08-01-foundry-cost-estimation.md).

> **Update (post-roadmap, adopted & shipped):** A re-sequencing review identified a
> higher-leverage move than any item below for the immediate term: an **instant
> local DB** path that collapses project setup from a 5–20-minute cloud wait to
> ~seconds. This re-sequences the priorities below — local-DB first, the phased
> roadmap as fast-follows — and is now **implemented and shipped** as:
> - `local.postgres` provisioner (`@foundry/local-postgres`, Docker `pgvector/pgvector`),
>   emitting the same `ConnectionTarget` as RDS so the kernel/connector/migrations
>   are unchanged;
> - `foundry init` (scaffolds `foundry.config.ts` + `migrations/<dbId>/` + `.gitignore`);
> - `foundry env` (resolves target+secret → `DATABASE_URL`, `.env.foundry`).
> pgvector is baked into the default local image by default (pulling the roadmap's
> Phase-4 pgvector work forward for the AI-dev audience). The roadmap below is
> otherwise unchanged; cost estimation / lint / MCP remain the fast-follow sequence.

## 1. Purpose

To decide what foundry should build next — *beyond migrations* — grounded in what the
database-lifecycle / schema-management ecosystem already does well, where it converges,
and where foundry has a structural advantage nobody else has.

## 2. Competitive landscape (researched)

Star counts and descriptions fetched from the GitHub API (2026-08-01).

| Tool | ★ | What it does | Relevance to foundry |
|---|---|---|---|
| **Atlas** (`ariga/atlas`) | 8.6k | Declarative + versioned **schema** migrations, schema-as-code (HCL/SQL/16 ORMs), **50+ lint analyzers**, drift detection, schema testing, security-as-code (roles/RLS), AI Agent Skills | **Direct competitor** — but schema-only; does *not* provision the DB instance. |
| **Bytebase** (`bytebase/bytebase`) | 14.3k | DB governance: GUI/GitOps change management, **200+ SQL-review rules**, fine-grained RBAC, JIT access, dynamic data masking, audit logging, **MCP server**, text-to-SQL | Enterprise benchmark for governance + AI integration. |
| **Infracost** (`infracost/infracost`) | 12.4k | **Cloud cost estimates before deploy**, FinOps policies/guardrails, IDE extensions via LSP, **AI agent skills**, CI/CD PR comments | Proves the cost-before-deploy thesis; generic IaC (1100+ resources). |
| **Squawk** (`sbdchd/squawk`) | 1.1k | **Postgres zero-downtime migration linter** (concurrent indexes, NOT VALID constraints, not-null defaults, ban destructive ops), `.squawk.toml` config, `--squawk-ignore` directives, JSON/CI reporters | Concrete, bounded, portable rule set. |
| **Skeema** (`skeema/skeema`) | 1.4k | Declarative pure-SQL schema management for MySQL/MariaDB: diff live DB ↔ repo, generate DDL, online-schema-change hooks (`pt-osc`, `gh-ost`), 20+ lint rules | Prior art for declarative diff + OSC integration. |
| **golang-migrate** | 18.8k | Migration *runner* only (no schema-as-code, no linting) | Baseline; foundry already matches/exceeds its runner features. |
| **pgvector** 22k · **Neon** 23k · **Supabase** 107k · **Chroma** 29k · **Weaviate** 17k | — | Vector / serverless / AI-DB ecosystem | Demand signal: AI-native data tooling is a huge, growing market. |
| **MCP servers** (`modelcontextprotocol/servers`) | **89k** | Model Context Protocol reference servers | Confirms **MCP is the dominant AI-agent integration standard.** |

### Key deep-read takeaways

- **Atlas** is the feature benchmark for *schema* lifecycle. Its standout capabilities are
  migration **linting** (50+ analyzers), **schema testing**, and packaging expertise for AI
  agents ("Agent Skills"). It explicitly does **not** create cloud resources — it assumes the
  DB exists. This is foundry's structural opening: **the whole database, including the cloud
  resource, in one tool.**
- **Bytebase** shows where "serious" DB tooling lands long-term: governance (RBAC, JIT access,
  masking, audit), 200+ review rules, and — critically — an **MCP server** so AI agents can
  drive it. Linting + MCP are the accessible, high-leverage parts.
- **Infracost** validates "cost-before-deploy" but operates on *generic* IaC. foundry owns the
  provisioners, so it knows the exact instance class / node type / RCU-WCU and can be far more
  precise for the database niche.
- **Squawk** hands us a ready-made, well-documented zero-downtime rule set with prior-art
  citations (`strong_migrations`, `django-migration-linter`, `pg-schema-diff`, `sqlfluff`).
- **MCP** at 89k stars is the clear standard for exposing a tool to AI coding agents — every
  serious player (Bytebase, Atlas, Infracost) is converging on it.

## 3. Four convergence signals

1. **Migration / SQL linting is table-stakes.** Atlas, Bytebase, Squawk, and Skeema all ship it.
   foundry currently has none — the most obvious gap to close.
2. **AI-agent integration is the strategic frontier.** Atlas (Agent Skills), Bytebase (MCP
   server), and Infracost (agent skills) all converge on exposing their capabilities to AI
   coding agents via MCP. This is the most on-thesis move for an AI-application company.
3. **Cost-before-deploy earns trust.** Infracost's entire product — but generic. A
   provisioning-aware version is strictly better for databases.
4. **foundry's unique wedge: nobody else provisions the database.** Atlas/Bytebase/Squawk/
   Infracost all assume the DB *exists*. foundry owns **provision → connect → migrate**, so it
   alone can offer **provisioning-aware** cost, policy, and lifecycle in one tool.

## 4. Phased roadmap

### Phase 1 — Safe migrations *(extends the migrations story just built)*
- **`foundry migrate:lint`** — zero-downtime linter. Port Squawk's rule set: `require-concurrent-index-creation`, `require-concurrent-index-deletion`, `constraint-missing-not-valid`, `disallowed-unique-constraint`, `adding-not-null-field`, `ban-drop-column`/`table`/`database`, `renaming-column`, `prefer-bigint-over-int`, `prefer-identity`, `prefer-text-field`. Support `.foundry-lint` config + `-- foundry-ignore` directives + JSON reporter for CI.
- **Advisory locking** — `pg_advisory_lock` around migrate/rollback/status (named fast-follow in the migrations spec).
- **`foundry migrate:lint` as a CI gate** — non-zero exit when violations found.

### Phase 2 — Plan-time intelligence *(foundry's wedge — provisioning-aware)*
- **Cost estimation in `plan`** ← *first implementation plan written* → [`plans/2026-08-01-foundry-cost-estimation.md`](./plans/2026-08-01-foundry-cost-estimation.md). Provisioners expose `estimate(action): CostEstimate`; pure `summarizeCost` rolls up totals; `plan` prints a per-resource + total table with a "not a quote" disclaimer. DB-precise vs Infracost's generic IaC.
- **Policy guardrails** — declarative policies (`requireEncryption: true`, `noPublicAccess: true`, `maxInstanceClass`, `destroyNeedsApproval`), enforced by the planner at `plan` time; `apply` refuses on violations. checkov/tfsec are generic-IaC; foundry is DB-aware.

### Phase 3 — AI-agent native *(most differentiated, most on-thesis)*
- **MCP server** — expose foundry's capabilities (`plan`, `apply`, `migrate`, `migrate:lint`, `estimate`) as Model Context Protocol tools so AI coding agents can drive the whole lifecycle. Aligns with where Atlas/Bytebase/Infracost are all heading; MCP is the 89k-star standard.
- **NL provisioning** — `foundry draft "a RAG-ready Postgres in us-east-1 with pgvector"` → proposes a `foundry.config.ts`, runs `plan` (with cost + policy checks), asks to apply. Built on top of the MCP server.

### Phase 4 — Platform breadth *(roadmap expansion)*
- **pgvector / Neon / Supabase-migrate** connectors and provisioners — directly serve RAG/AI workloads (pgvector 22k, Neon 23k demand signal).
- **Declarative schema diff** (Atlas/Skeema-style) — generate `up`/`down` files from a schema definition; currently an explicit non-goal of v1 migrations, but the loader is shaped to accept generated files.
- **Remote state backend** — `DynamoDBStateStore` (+ optional S3 lock) behind the existing `StateStore` interface; resolves the team state-conflict risk (design spec §9).

## 5. Recommendation

**Immediate next:** implement **Phase 2 cost estimation** — clearest non-migration feature,
maximally differentiated (leverages provisioner ownership no competitor has), well-scoped for a
tight TDD plan. Implementation plan already written:
[`plans/2026-08-01-foundry-cost-estimation.md`](./plans/2026-08-01-foundry-cost-estimation.md).

**Strategic north star:** **Phase 3 MCP server** — the most defensible, on-thesis move, and the
direction the entire ecosystem is converging on. Pursue after Phase 1 linting + Phase 2 cost/policy
establish foundry as trustworthy for cloud-admin operations.

**Sequence:** Phase 1 (linting, lock) → Phase 2 (cost, policy) → Phase 3 (MCP, NL) → Phase 4 (breadth).

## 6. Research provenance

- GitHub API repo metadata (stars/description/topics) + raw `README.md` deep-reads for: `ariga/atlas`, `sbdchd/squawk`, `bytebase/bytebase`, `infracost/infracost`, `skeema/skeema`.
- Star-only metadata for: `prisma/prisma`, `drizzle-team/drizzle-orm`, `golang-migrate/migrate`, `amacneil/dbmate`, `kysely-org/kysely`, `bridgecrewio/checkov`, `pgvector/pgvector`, `neondatabase/neon`, `supabase/supabase`, `chroma-core/chroma`, `weaviate/weaviate`, `modelcontextprotocol/servers`.
- Date of fetch: 2026-08-01.
