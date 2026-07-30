/**
 * foundry — Planner (design v1, sections 4 "Provision flow", 5 "Provisioner
 * interface", 6 "Mandatory drift refresh", 8 "Property tests").
 *
 * The Planner diffs a desired `Stack` against the current `State` and produces
 * a `Plan`: a list of create/update/replace/noop/delete actions.
 *
 * Classification (update vs replace) is *owned by the Provisioner* via
 * `Provisioner.plan(desired, current)` per the design contract. When no
 * provisioner is registered for a kind (the kernel-only / test path), the
 * Planner falls back to a built-in default diff: deep-equal field comparison
 * that classifies any change as `update` unless a `replacePredicate` flags it
 * as `replace` (e.g. a DynamoDB key-schema change). The default strategy
 * snapshots the last-applied desired props under `state.outputs[KEY]` so that
 * re-planning a fully-applied stack converges to `noop`.
 *
 * Depends only on `../contracts.js` and `../config`.
 */

import type {
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceSpec,
  ResourceState,
} from "../contracts.js";
import type { Stack } from "../config/index.js";
import { desiredResourceSpecs } from "../config/index.js";

/* ------------------------------------------------------------------ *
 * Last-applied snapshot convention (default diff only)
 * ------------------------------------------------------------------ */

/**
 * Reserved key under ResourceState.outputs where the default diff records the
 * last-applied desired snapshot. Real provisioners that implement `plan()`
 * themselves may ignore this; they should still embed it (via `embedLastApplied`)
 * so the convergence invariant holds.
 */
export const LAST_APPLIED_KEY = "__foundry:lastApplied";

export interface LastApplied {
  readonly kind: ResourceKind;
  readonly props: Record<string, unknown>;
  readonly tags?: Record<string, string>;
}

/** Read the last-applied snapshot embedded by a previous apply. */
export function readLastApplied(state: ResourceState): LastApplied | null {
  const raw = state.outputs?.[LAST_APPLIED_KEY];
  if (!isObject(raw)) return null;
  const la = raw as Partial<LastApplied>;
  if (typeof la.kind !== "string" || !isObject(la.props)) return null;
  // Build the snapshot in one shot so we never assign to a readonly field.
  const out: LastApplied = {
    kind: la.kind as ResourceKind,
    props: la.props,
    ...(isObject(la.tags) ? { tags: la.tags as Record<string, string> } : {}),
  };
  return out;
}

/**
 * Return a copy of `state` with the desired snapshot embedded. Provisioners
 * should call this on the ResourceState they return from `apply()` so the next
 * plan converges to `noop`. Does not mutate the input.
 */
export function embedLastApplied(state: ResourceState, spec: ResourceSpec): ResourceState {
  const snapshot: LastApplied = {
    kind: spec.kind,
    props: spec.props,
    ...(spec.tags !== undefined ? { tags: spec.tags } : {}),
  };
  const outputs: Record<string, unknown> = { ...(state.outputs ?? {}) };
  outputs[LAST_APPLIED_KEY] = snapshot;
  return { ...state, outputs };
}

/* ------------------------------------------------------------------ *
 * Plan types
 * ------------------------------------------------------------------ */

export interface DriftReport {
  readonly id: string;
  readonly detail: string;
}

export interface Plan {
  readonly actions: PlanAction[];
  /** Drift detected during a refresh-only read (see PlannerOptions.refresh). */
  readonly drift: DriftReport[];
}

export interface PlannerOptions {
  /** Registered provisioners; when present, classification is delegated to them. */
  readonly provisioners?: Map<ResourceKind, Provisioner>;
  /**
   * When true, call each provisioner's `read()` to refresh live state before
   * diffing (design §6: mandatory drift refresh for real runs). Default false
   * so the kernel is testable without cloud access.
   */
  readonly refresh?: boolean;
  /**
   * Used only by the default (no-provisioner) diff. Returns true to force a
   * `replace` for the given changed fields (e.g. a key-schema change). Default:
   * never replace — everything is an in-place update.
   */
  readonly replacePredicate?: (
    desired: ResourceSpec,
    current: ResourceState,
    changedFields: string[],
  ) => boolean;
}

/* ------------------------------------------------------------------ *
 * Planner
 * ------------------------------------------------------------------ */

export class Planner {
  private readonly provisioners: Map<ResourceKind, Provisioner>;
  private readonly refresh: boolean;
  private readonly replacePredicate: PlannerOptions["replacePredicate"];

  constructor(opts: PlannerOptions = {}) {
    this.provisioners = opts.provisioners ?? new Map();
    this.refresh = opts.refresh ?? false;
    this.replacePredicate = opts.replacePredicate;
  }

  async plan(
    stack: Stack,
    current: Record<string, ResourceState>,
  ): Promise<Plan> {
    const desired = desiredResourceSpecs(stack);
    const drift: DriftReport[] = [];
    const effective: Record<string, ResourceState> = { ...current };

    // 1. Optional drift refresh: read() live state via provisioners.
    if (this.refresh) {
      for (const [id, spec] of Object.entries(desired)) {
        const provisioner = this.provisioners.get(spec.kind);
        if (!provisioner) continue; // cannot refresh without a provisioner
        const live = await provisioner.read(spec);
        const stored = current[id] ?? null;
        if (live === null) {
          if (stored) drift.push({ id, detail: "resource tracked in state but missing in cloud" });
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete effective[id];
          continue;
        }
        if (stored && !shallowResourceEqual(live, stored)) {
          drift.push({ id, detail: describeDrift(stored, live) });
        }
        effective[id] = live;
      }
    }

    // 2. Desired -> create/update/replace/noop.
    const actions: PlanAction[] = [];
    for (const [id, spec] of Object.entries(desired)) {
      const cur = effective[id] ?? null;
      const provisioner = this.provisioners.get(spec.kind);
      const action = provisioner
        ? provisioner.plan(spec, cur)
        : defaultPlan(spec, cur, this.replacePredicate);
      actions.push(action);
    }

    // 3. Tracked but no longer desired -> delete.
    for (const [id, state] of Object.entries(effective)) {
      if (!(id in desired)) {
        actions.push({ op: "delete", state });
      }
    }

    return { actions, drift };
  }
}

/* ------------------------------------------------------------------ *
 * Default (no-provisioner) diff strategy — pure functions, exported for tests
 * ------------------------------------------------------------------ */

/**
 * Default classification when no Provisioner is registered for a kind.
 *
 * - no current state            -> create
 * - current exists, props equal -> noop
 * - current exists, props differ-> replace (if predicate matches) else update
 *
 * If the current state carries no last-applied snapshot (e.g. imported), it is
 * treated as a `noop`: the resource exists and is tracked, and without a
 * snapshot the kernel cannot classify safely. Re-apply via a real provisioner
 * to (re)establish the snapshot.
 */
export function defaultPlan(
  spec: ResourceSpec,
  current: ResourceState | null,
  replacePredicate?: PlannerOptions["replacePredicate"],
): PlanAction {
  if (current === null) {
    return { op: "create", spec };
  }
  const last = readLastApplied(current);
  if (last === null) {
    return { op: "noop", id: spec.id, reason: "no last-applied snapshot; cannot classify safely" };
  }
  const changedProps = diffFields(last.props, spec.props);
  const tagsChanged = !tagsEqual(last.tags, spec.tags);
  if (changedProps.length === 0 && !tagsChanged) {
    return { op: "noop", id: spec.id, reason: "no changes" };
  }
  if (replacePredicate && replacePredicate(spec, current, changedProps)) {
    return { op: "replace", spec, reason: "replacePredicate matched changed fields" };
  }
  const changedFields = changedProps;
  if (tagsChanged) changedFields.push("tags");
  return { op: "update", spec, from: current, changedFields };
}

/**
 * Deep diff of two values, returning dotted paths that differ (added,
 * removed, or changed). Arrays are compared by index/length. Returns an empty
 * array when the values are structurally equal.
 */
export function diffFields(a: unknown, b: unknown, prefix = ""): string[] {
  const out: string[] = [];
  const path = (key: string) => (prefix === "" ? key : `${prefix}.${key}`);

  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const av = (a as Record<string, unknown>)[key];
      const bv = (b as Record<string, unknown>)[key];
      if (!(key in a)) {
        out.push(path(key));
      } else if (!(key in b)) {
        out.push(path(key));
      } else if (!deepEqual(av, bv)) {
        // Recurse for nested objects/arrays; record leaf paths.
        const nested = diffFields(av, bv, path(key));
        out.push(...(nested.length > 0 ? nested : [path(key)]));
      }
    }
    return out;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return prefix === "" ? ["[length]"] : [`${prefix}[length]`];
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        const p = `${prefix}[${i}]`;
        out.push(p);
      }
    }
    return out;
  }

  if (!deepEqual(a, b)) {
    return prefix === "" ? ["<root>"] : [prefix];
  }
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in b)) return false;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
}

function tagsEqual(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  return deepEqual(a ?? {}, b ?? {});
}

function shallowResourceEqual(a: ResourceState, b: ResourceState): boolean {
  // Identity-by-content for drift surfacing: identifiers + status + connection endpoint.
  return (
    a.status === b.status &&
    deepEqual(a.identifiers, b.identifiers) &&
    deepEqual(a.connection, b.connection)
  );
}

function describeDrift(stored: ResourceState, live: ResourceState): string {
  const parts: string[] = [];
  if (stored.status !== live.status) parts.push(`status ${stored.status} -> ${live.status}`);
  if (!deepEqual(stored.identifiers, live.identifiers)) parts.push("identifiers changed");
  if (!deepEqual(stored.connection, live.connection)) parts.push("connection changed");
  return parts.length > 0 ? `drifted: ${parts.join("; ")}` : "drifted";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
