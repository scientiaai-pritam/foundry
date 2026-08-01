# Foundry Cost Estimation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show estimated monthly/one-time cost for every resource in `foundry plan` output — *before* anything is applied — by adding an optional `estimate()` method to the `Provisioner` contract and a pure cost-summarization engine in `@foundry/core`. Implement estimates for the postgres, redshift, and dynamodb provisioners using a versioned, dependency-free static price map.

**Why this feature (research-grounded):** [Infracost](https://github.com/infracost/infracost) (★12.4k) proves the model — "cloud cost estimates before changes are deployed" — and supports 1,100+ generic IaC resources. But foundry's unique advantage is that **it owns the provisioners**: it knows the exact DB instance class, node type, storage, and RCU/WCU being requested, so it can produce *database-precise* estimates without parsing Terraform. No schema-migration tool (Atlas, Bytebase, Squawk) or generic IaC tool does DB-cost this precisely. This is foundry's clearest non-migration wedge and directly serves its "declarative DB lifecycle" thesis: *provision → connect → migrate*, now with *cost* visible at plan time.

**Architecture:** A new pure `cost/` module in `@foundry/core` owns the price map + a `summarizeCost(actions, provisioners)` function that maps each `PlanAction` to its provisioner's `estimate()` and rolls up totals. The `Provisioner` contract gains an optional `estimate?(action): CostEstimate` (types-only addition to `contracts.ts`). The `Plan` object gains an optional `cost?: CostSummary`, populated by the planner when any provisioner implements `estimate`. The CLI `plan` command prints a per-resource + total cost table.

**Tech Stack:** TypeScript 5.5 (strict), Node ≥ 20 ESM, vitest, npm workspaces. No new runtime dependencies — pricing is a versioned static map (clearly marked "approximate, us-east-1 on-demand; not a quote"), keeping core dependency-free per the "no cloud SDK in core" philosophy.

## Global Constraints

(Every task's requirements implicitly include these — copied verbatim from the spec + house conventions.)

- **TypeScript strict:** `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `isolatedModules` are all ON. Use `import type` for types; conditional spread `...(x !== undefined ? { x } : {})` for optional props; `arr[i]` is `T | undefined`.
- **ESM specifiers:** every intra-package import uses the `.js` extension (e.g. `"../contracts.js"`).
- **`contracts.ts` is types-only.** Runtime helpers (`summarizeCost`, the price map) live in the new `cost/` module; only types (`CostEstimate`, `CostSummary`, `CostComponent`) go in `contracts.ts`.
- **Tests:** vitest. Core tests MUST `import { describe, it, expect, vi } from "vitest"` (core's vitest config does NOT enable globals). Run one workspace: `npm test -w @foundry/core`. Single file: `npm test -w @foundry/core -- cost.test.ts`.
- **Build order matters for tests:** `@foundry/core` is a `peerDependency` of the connectors/provisioners; build core before running their tests: `npm run build -w @foundry/core`.
- **Commits:** frequent, one per task. **Never** add a `Co-Authored-By` trailer. Conventional-commit prefixes (`feat`, `test`, `docs`, `refactor`).
- **Never a quote.** Every surfaced estimate must be accompanied by a disclaimer that it is approximate, region/usage-dependent, and not a billing quote. Prices are a best-effort static snapshot, not sourced from a live API.
- **Engine scope:** postgres (RDS) + redshift + dynamodb get real estimates this plan. mongodb/supabase-postgres provisioners omit `estimate` (listed as "no estimate" by the engine).

---

## File Structure

**New files:**
- `packages/core/src/cost/index.ts` — `CostEstimate` runtime helpers: the versioned price map, `estimateRdsPostgres`, `estimateRedshift`, `estimateDynamoDb`, and `summarizeCost`.
- `packages/core/test/cost.test.ts` — pure unit tests for the summarizer + per-engine estimators (no network).

**Modified files:**
- `packages/core/src/contracts.ts` — add `CostEstimate`, `CostComponent`, `CostSummary` types; add optional `estimate?` to `Provisioner`.
- `packages/core/src/cost/priceMap.ts` — the static price data (kept separate so it can be regenerated/versioned independently).
- `packages/core/src/plan/index.ts` — populate optional `cost?: CostSummary` on `Plan`.
- `packages/core/src/cli/index.ts` — print cost table in `plan` output; add `--no-cost` flag (default: show when available).
- `packages/core/src/index.ts` — re-export the new `cost/` module.
- `packages/connectors/postgres/...` (RDS provisioner) — implement `estimate`.
- `packages/connectors/redshift/...` — implement `estimate`.
- `packages/connectors/dynamodb/...` (provisioner) — implement `estimate`.
- `README.md` — "Cost estimation" section + disclaimer.

---

## Types (reference — implement in Task 1)

```ts
// contracts.ts (types only)
interface CostComponent {
  readonly name: string;          // e.g. "db.r6g.large (us-east-1, on-demand)"
  readonly monthlyUsd: number;    // 0 for purely free components
  readonly usageBased?: boolean;  // true => estimate is a floor, real cost varies
}

interface CostEstimate {
  readonly monthlyUsd: number;    // sum of recurring components
  readonly oneTimeUsd?: number;   // e.g. snapshot restore, transfer (rare here)
  readonly currency: "USD";
  readonly components: CostComponent[];
  readonly note?: string;         // caveats: approximate, region, usage-dependent
}

interface CostSummary {
  readonly totalMonthlyUsd: number;
  readonly totalOneTimeUsd: number;
  readonly currency: "USD";
  readonly items: ReadonlyArray<{ id: string; op: PlanAction["op"]; estimate: CostEstimate } | { id: string; op: PlanAction["op"]; noEstimate: true }>;
  readonly note: string;          // global disclaimer
}

// Provisioner gains:
interface Provisioner {
  // ...existing members...
  /** Best-effort cost estimate for an action. `undefined` => "no estimate". */
  estimate?(action: PlanAction): CostEstimate | undefined;
}
```

---

## Task 1 — Contracts: cost types + `Provisioner.estimate?`

- [ ] Add `CostEstimate`, `CostComponent`, `CostSummary` interfaces to `packages/core/src/contracts.ts` (types-only) and export them.
- [ ] Add optional `estimate?(action: PlanAction): CostEstimate | undefined;` to `Provisioner`.
- [ ] Re-export the three cost types from `packages/core/src/index.ts`.
- [ ] `npm run typecheck -w @foundry/core` passes.
- [ ] Commit: `feat(core): add CostEstimate types and Provisioner.estimate`.

## Task 2 — Pure cost engine + price map

- [ ] Create `packages/core/src/cost/priceMap.ts` — a versioned, region-scoped (us-east-1, on-demand) static map:
  - RDS instance class → $/hr (e.g. `db.t4g.micro`, `db.r6g.large`, …) + storage $/GB-mo + Multi-AZ factor (×2 on instance).
  - Redshift node type → $/hr (e.g. `ra3.xlplus`, `dc2.large`) — cost = nodeType × nodeCount.
  - DynamoDB: `PAY_PER_REQUEST` → "usage-based" component (monthlyUsd: 0, usageBased: true, note); `PROVISIONED` → RCU/WCU → $/hr via the published formula.
  - Export `PRICE_MAP_VERSION` + a `region` constant + a header comment: "Approximate us-east-1 on-demand list prices, manually curated snapshot YYYY-MM. NOT a billing quote."
- [ ] Create `packages/core/src/cost/index.ts`:
  - `estimateRdsPostgres(spec): CostEstimate | undefined`
  - `estimateRedshift(spec): CostEstimate | undefined`
  - `estimateDynamoDb(spec): CostEstimate | undefined`
  - `summarizeCost(actions, provisioners): CostSummary` — for each action, look up its provisioner; if it implements `estimate`, call it (else `{ noEstimate: true }`); roll up totals.
- [ ] Re-export the `cost/` module from `packages/core/src/index.ts`.
- [ ] Write `packages/core/test/cost.test.ts` (failing first):
  - `summarizeCost` with no estimators → all items `noEstimate`, totals 0.
  - `summarizeCost` with a fake provisioner returning a 2-component estimate → totals correct, items ordered.
  - `estimateRdsPostgres`: single-AZ `db.t4g.micro` + 20GB → monthly ≈ (hrly × 730) + (20 × storage).
  - `estimateRdsPostgres`: Multi-AZ doubles the instance line, storage not doubled.
  - `estimateRedshift`: 2 × `dc2.large` → nodeType × 2 × 730.
  - `estimateDynamoDb`: `PAY_PER_REQUEST` → usageBased component, monthlyUsd 0.
  - Unknown instance class → `undefined` (no estimate), not a throw.
- [ ] Verify tests fail, implement, verify pass, `npm run typecheck -w @foundry/core`.
- [ ] Commit: `feat(core): add pure cost estimation engine + price map`.

## Task 3 — Wire cost into the planner

- [ ] Add `readonly cost?: CostSummary;` to `Plan` in `packages/core/src/plan/index.ts`.
- [ ] After actions are computed, if any registered provisioner implements `estimate`, call `summarizeCost(actions, ctx.provisioners)` and attach to the returned `Plan`. (When no provisioner implements `estimate`, leave `cost` undefined so existing tests/assertions are unaffected.)
- [ ] Add a test in the plan suite: with a fake provisioner that implements `estimate`, the returned `Plan.cost` is populated and totals match; with plain provisioners, `Plan.cost` is `undefined`.
- [ ] Verify pass, typecheck core.
- [ ] Commit: `feat(core): attach CostSummary to Plan`.

## Task 4 — CLI: print cost in `plan`

- [ ] Add a `formatCost(summary, cwd?): string` helper to `packages/core/src/cli/index.ts` (or `cost/index.ts`): a table — one row per item (`id`, `op`, `monthly $`), a `TOTAL — $/mo` line, and the global disclaimer line. Items with `noEstimate` print `—`.
- [ ] In `main()` `case "plan":`, after printing actions, if `plan.cost` is present and `--no-cost` was NOT passed, print `formatCost`.
- [ ] Add `--no-cost` to the plan flag parsing + usage string.
- [ ] Test (extend the existing plan CLI test or add `cli-cost.test.ts`): with a fake provisioner implementing `estimate`, the plan output contains the resource line, the `TOTAL` line, and the disclaimer; `--no-cost` suppresses it.
- [ ] Verify pass, typecheck core.
- [ ] Commit: `feat(core): print cost estimates in foundry plan`.

## Task 5 — RDS Postgres provisioner `estimate`

- [ ] Implement `estimate(action)` in the RDS provisioner: delegate to `estimateRdsPostgres(spec)` from core for create/update/replace; return `undefined` for delete/noop.
- [ ] Build core, then run the postgres provisioner tests; add a unit test asserting `estimate` returns sensible $/mo for a known instance class and `undefined` for an unknown one.
- [ ] Commit: `feat(postgres): estimate RDS monthly cost`.

## Task 6 — Redshift + DynamoDB provisioner `estimate`

- [ ] Implement `estimate` in the redshift provisioner via `estimateRedshift(spec)`.
- [ ] Implement `estimate` in the dynamodb provisioner via `estimateDynamoDb(spec)`.
- [ ] Add a unit test per provisioner (node-type×count for redshift; pay-per-request vs provisioned for dynamodb).
- [ ] Commit: `feat(redshift,dynamodb): estimate monthly cost`.

## Task 7 — Docs

- [ ] Add a "Cost estimation" section to `README.md`: what it does, the `foundry plan` output shape, the **disclaimer** (approximate, us-east-1 on-demand, not a quote, usage-based resources are floors), `--no-cost`, and how to extend (`estimate()` on a provisioner).
- [ ] Commit: `docs: document cost estimation`.

---

## Validation (final)

- [ ] `npm run build` (all workspaces) succeeds.
- [ ] `npm run typecheck` (all workspaces) succeeds.
- [ ] `npm test` — all suites green; new tests in `cost.test.ts` + plan/CLI/provisioner additions.
- [ ] Manual smoke: in a temp project with a postgres RDS db, `foundry plan` prints the cost table + disclaimer; `foundry plan --no-cost` omits it; an unknown instance class prints `—` and never throws.

## Out of scope (future work)

- Live pricing API integration (AWS Price List API) — keep static map for v1.
- Regions beyond us-east-1 on-demand (reserved/Savings Plans) — future `--region`/`--pricing-tier` flags.
- Usage-based resource precision (real DynamoDB request volume, Redshift Spectrum, data transfer) — surface as `usageBased` floors for now.
- Cost diff on drift (`foundry plan` showing cost *delta* vs current state) — natural follow-up once totals are trusted.
