/**
 * Planner unit tests (design §8: "the bulk of the suite" + property test:
 * "plan after apply converges to noop").
 *
 * No cloud access — exercises the kernel default diff and provisioner delegation.
 */

import { describe, it, expect, vi } from "vitest";

import type {
  ConnectionTarget,
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceState,
} from "../src/contracts.js";
import { defineStack, desiredResourceSpecs, toResourceSpec, type Stack } from "../src/config/index.js";
import {
  Planner,
  defaultPlan,
  diffFields,
  deepEqual,
  embedLastApplied,
  readLastApplied,
  type PlannerOptions,
} from "../src/plan/index.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function connectionFor(id: string, kind: ResourceKind): ConnectionTarget {
  switch (kind) {
    case "aws.dynamodb":
      return { engine: "dynamodb", region: "us-east-1", credsRef: { secretId: `foundry/${id}` } };
    case "aws.redshift":
      return {
        engine: "redshift",
        endpoint: `${id}.redshift.example:5439`,
        region: "us-east-1",
        credsRef: { secretId: `foundry/${id}` },
      };
    case "aws.rds-postgres":
    case "supabase.postgres":
      return { engine: "postgres", endpoint: `${id}.pg.example:5432`, credsRef: { secretId: `foundry/${id}` } };
  }
}

/** Build an available ResourceState with the desired snapshot embedded (= "fully applied"). */
function appliedState(specId: string, kind: ResourceKind, props: Record<string, unknown>): ResourceState {
  const spec: import("../src/contracts.js").ResourceSpec = { id: specId, kind, props };
  const base: ResourceState = {
    id: specId,
    kind,
    identifiers: { cloudId: `cloud-${specId}` },
    status: "available",
    connection: connectionFor(specId, kind),
  };
  return embedLastApplied(base, spec);
}

const STACK: Stack = defineStack({
  databases: {
    analytics: {
      engine: "postgres",
      provision: { kind: "aws.rds-postgres", instanceClass: "db.t4g.small" },
    },
    sessions: {
      engine: "dynamodb",
      provision: {
        kind: "aws.dynamodb",
        tableName: "sessions",
        billingMode: "pay_per_request",
      },
    },
    // runtime-only — must be excluded from provisioning plans
    users: {
      engine: "mongodb",
      provision: "external",
      connectionString: { from: "env:MONGO_URI" },
    },
  },
});

/* ------------------------------------------------------------------ *
 * Convergence (the load-bearing invariant)
 * ------------------------------------------------------------------ */

describe("Planner convergence", () => {
  it("planning against a fully-applied state yields only noops", async () => {
    const planner = new Planner();

    // plan 1: empty state -> creates for both provisioned dbs (users is external)
    const plan1 = await planner.plan(STACK, {});
    const creates = plan1.actions.filter((a) => a.op === "create");
    expect(creates).toHaveLength(2);
    expect(plan1.actions.some((a) => a.op === "create" && a.spec.id === "analytics")).toBe(true);
    expect(plan1.actions.some((a) => a.op === "create" && a.spec.id === "sessions")).toBe(true);

    // simulate apply: produce ResourceState from each create, embedding the snapshot
    const current: Record<string, ResourceState> = {};
    for (const action of plan1.actions) {
      if (action.op === "create") {
        current[action.spec.id] = appliedState(action.spec.id, action.spec.kind, action.spec.props);
      }
    }

    // plan 2: fully-applied state -> everything noop
    const plan2 = await planner.plan(STACK, current);
    expect(plan2.actions).toHaveLength(2);
    expect(plan2.actions.every((a) => a.op === "noop")).toBe(true);
  });

  it("is idempotent: re-planning the same converged state is stable", async () => {
    const planner = new Planner();
    const current: Record<string, ResourceState> = {
      analytics: appliedState("analytics", "aws.rds-postgres", { instanceClass: "db.t4g.small" }),
      sessions: appliedState("sessions", "aws.dynamodb", {
        tableName: "sessions",
        billingMode: "pay_per_request",
      }),
    };
    const plan2 = await planner.plan(STACK, current);
    const plan3 = await planner.plan(STACK, current);
    expect(plan2.actions.every((a) => a.op === "noop")).toBe(true);
    expect(plan3.actions.map((a) => a.op)).toEqual(plan2.actions.map((a) => a.op));
  });
});

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

describe("Planner classification (default diff)", () => {
  it("classifies a property change as update with changedFields", async () => {
    const current = {
      analytics: appliedState("analytics", "aws.rds-postgres", { instanceClass: "db.t4g.small" }),
    };
    const changed = defineStack({
      databases: {
        analytics: {
          engine: "postgres",
          provision: { kind: "aws.rds-postgres", instanceClass: "db.t4g.medium" },
        },
      },
    });
    const plan = await new Planner().plan(changed, current);
    const update = plan.actions.find((a) => a.op === "update");
    expect(update).toBeDefined();
    if (update?.op === "update") {
      expect(update.changedFields).toContain("instanceClass");
      expect(update.from.id).toBe("analytics");
    }
  });

  it("classifies as replace when replacePredicate matches changed fields", async () => {
    const current = {
      sessions: appliedState("sessions", "aws.dynamodb", {
        tableName: "sessions",
        billingMode: "pay_per_request",
      }),
    };
    const changed = defineStack({
      databases: {
        sessions: {
          engine: "dynamodb",
          provision: { kind: "aws.dynamodb", tableName: "sessions", billingMode: "provisioned" },
        },
      },
    });
    const replaceOnBillingMode: PlannerOptions["replacePredicate"] = (_d, _c, fields) =>
      fields.includes("billingMode");
    const plan = await new Planner({ replacePredicate: replaceOnBillingMode }).plan(changed, current);
    const replace = plan.actions.find((a) => a.op === "replace");
    expect(replace).toBeDefined();
  });

  it("plans delete for resources tracked in state but absent from config", async () => {
    const orphan: ResourceState = {
      id: "legacy",
      kind: "aws.rds-postgres",
      identifiers: { cloudId: "cloud-legacy" },
      status: "available",
      connection: connectionFor("legacy", "aws.rds-postgres"),
      outputs: {},
    };
    const onlyAnalytics = defineStack({
      databases: {
        analytics: {
          engine: "postgres",
          provision: { kind: "aws.rds-postgres", instanceClass: "db.t4g.small" },
        },
      },
    });
    const plan = await new Planner().plan(onlyAnalytics, { legacy: orphan });
    const del = plan.actions.find((a) => a.op === "delete");
    expect(del).toBeDefined();
    if (del?.op === "delete") expect(del.state.id).toBe("legacy");
  });

  it("excludes external (runtime-only) databases from provisioning actions", async () => {
    const plan = await new Planner().plan(STACK, {});
    const ids = plan.actions.map((a) => (a.op === "delete" ? a.state.id : (a as { spec: { id: string } }).spec.id));
    expect(ids).not.toContain("users");
    expect(plan.actions).toHaveLength(2); // analytics + sessions only
  });
});

/* ------------------------------------------------------------------ *
 * Provisioner delegation + drift
 * ------------------------------------------------------------------ */

describe("Planner provisioner delegation", () => {
  it("delegates plan() to the registered provisioner with the refreshed current state", async () => {
    const spec = toResourceSpec("analytics", STACK.databases.analytics!)!;
    const stored = appliedState(spec.id, spec.kind, spec.props);
    const drifted: ResourceState = { ...stored, status: "updating" };

    const provisioner: Provisioner = {
      kind: "aws.rds-postgres",
      plan: vi.fn(() => ({ op: "noop", id: spec.id, reason: "stub-classification" } satisfies PlanAction)),
      apply: vi.fn(async () => stored),
      read: vi.fn(async () => drifted),
      destroy: vi.fn(async () => undefined),
    };

    const planner = new Planner({
      provisioners: new Map<ResourceKind, Provisioner>([["aws.rds-postgres", provisioner]]),
      refresh: true,
    });

    const plan = await planner.plan(STACK, { analytics: stored });

    expect(provisioner.read).toHaveBeenCalledWith(spec);
    expect(provisioner.plan).toHaveBeenCalledWith(spec, drifted);
    expect(plan.drift.some((d) => d.id === "analytics")).toBe(true);
  });

  it("reports drift when a resource tracked in state is missing in the cloud", async () => {
    const spec = toResourceSpec("analytics", STACK.databases.analytics!)!;
    const stored = appliedState(spec.id, spec.kind, spec.props);
    const provisioner: Provisioner = {
      kind: "aws.rds-postgres",
      plan: vi.fn(() => ({ op: "create", spec } satisfies PlanAction)),
      apply: vi.fn(async () => stored),
      read: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    };
    const planner = new Planner({
      provisioners: new Map<ResourceKind, Provisioner>([["aws.rds-postgres", provisioner]]),
      refresh: true,
    });
    const plan = await planner.plan(STACK, { analytics: stored });
    expect(plan.drift.some((d) => d.id === "analytics" && /missing/.test(d.detail))).toBe(true);
    // With no current after refresh, the provisioner is asked to create.
    expect(provisioner.plan).toHaveBeenCalledWith(spec, null);
  });
});

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe("defaultPlan / diffFields (pure)", () => {
  const spec = { id: "x", kind: "aws.dynamodb" as ResourceKind, props: { a: 1, nested: { b: 2 } } };

  it("returns create when there is no current state", () => {
    expect(defaultPlan(spec, null).op).toBe("create");
  });

  it("returns noop when the snapshot matches", () => {
    const state = appliedState("x", "aws.dynamodb", spec.props);
    expect(defaultPlan(spec, state).op).toBe("noop");
  });

  it("returns update on a nested change and reports the dotted path", () => {
    const state = appliedState("x", "aws.dynamodb", { a: 1, nested: { b: 2 } });
    const changed = { ...spec, props: { a: 1, nested: { b: 3 } } };
    const action = defaultPlan(changed, state);
    expect(action.op).toBe("update");
    if (action.op === "update") expect(action.changedFields).toContain("nested.b");
  });

  it("diffFields reports added, removed, and changed paths", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b"]);
    expect(diffFields({ a: 1 }, { a: 1, c: 3 })).toEqual(["c"]);
    expect(diffFields({ a: 1, c: 3 }, { a: 1 })).toEqual(["c"]);
    expect(diffFields([1, 2, 3], [1, 2, 4])).toEqual(["[2]"]);
    expect(diffFields({ x: 1 }, { x: 1 })).toEqual([]);
  });

  it("deepEqual handles nested objects and arrays", () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  });

  it("readLastApplied/embedLastApplied round-trip the snapshot", () => {
    const state = appliedState("x", "aws.dynamodb", spec.props);
    const la = readLastApplied(state);
    expect(la).not.toBeNull();
    expect(la?.kind).toBe("aws.dynamodb");
    expect(deepEqual(la?.props, spec.props)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * desiredResourceSpecs
 * ------------------------------------------------------------------ */

describe("desiredResourceSpecs", () => {
  it("includes provisioned dbs and strips `kind` into props", () => {
    const specs = desiredResourceSpecs(STACK);
    expect(Object.keys(specs).sort()).toEqual(["analytics", "sessions"]);
    expect(specs.analytics?.kind).toBe("aws.rds-postgres");
    expect(specs.analytics?.props).toMatchObject({ instanceClass: "db.t4g.small" });
    expect(specs.analytics?.props).not.toHaveProperty("kind");
  });
});
