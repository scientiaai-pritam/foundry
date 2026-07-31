/**
 * foundry — Apply orchestrator (design v1, sections 4, 6, 7).
 *
 * Executes a `Plan` action-by-action through the matching Provisioner. Key
 * semantics (design §6/§7):
 *
 * - Stop-on-error, NO auto-rollback. Prior successes stay applied; state is the
 *   source of truth, so re-running `plan` shows what remains. Opt-in
 *   `continueOnError` for batch-tolerant cases.
 * - Persist state after EACH successful step (inside a state lock so concurrent
 *   applies serialize).
 * - `waitFor` — shared poll helper with exponential backoff + jitter that
 *   provisioners use to wait for eventual consistency (RDS/Redshift readiness).
 * - `idempotencyToken` — deterministic token derived from resource id + op, so
 *   a retry after a network timeout never creates a second resource.
 *
 * Depends only on `../contracts.js`, `../state`, and `../plan`.
 */

import { createHash } from "node:crypto";
import type { PlanAction, Provisioner, ResourceKind, ResourceState } from "../contracts.js";
import type { StateStore } from "../state/index.js";
import type { Plan } from "../plan/index.js";

/* ------------------------------------------------------------------ *
 * Idempotency token
 * ------------------------------------------------------------------ */

/** AWS ClientRequestToken etc. are 1-64 alphanumeric chars. */
const IDEMPOTENCY_MAX_LEN = 64;
const IDEMPOTENCY_PREFIX = "foundry";

/**
 * Derive a stable idempotency token from a resource id + action op. A retry of
 * the same logical action yields the same token, so cloud APIs that accept a
 * client request token (AWS `ClientRequestToken`) de-duplicate safely across
 * network retries. Deterministic — orchestrator and provisioner derive the same
 * value from the same inputs (see `actionId` / action.op).
 */
export function idempotencyToken(resourceId: string, op: PlanAction["op"]): string {
  const hash = createHash("sha256").update(`${resourceId}|${op}`).digest("hex");
  const token = `${IDEMPOTENCY_PREFIX}-${hash}`;
  return token.length > IDEMPOTENCY_MAX_LEN ? token.slice(0, IDEMPOTENCY_MAX_LEN) : token;
}

/* ------------------------------------------------------------------ *
 * waitFor — exponential-backoff poll helper
 * ------------------------------------------------------------------ */

export class WaitForTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
    readonly lastError: unknown,
  ) {
    super(message);
    this.name = "WaitForTimeoutError";
  }
}

export class WaitForAbortedError extends Error {
  constructor() {
    super("waitFor aborted");
    this.name = "WaitForAbortedError";
  }
}

export interface WaitForOptions {
  /** Hard deadline in ms. A timeout marks the resource `error` and is retryable. */
  readonly timeoutMs: number;
  /** First poll interval. Default 2000. */
  readonly initialIntervalMs?: number;
  /** Backoff cap. Default 30000. */
  readonly maxIntervalMs?: number;
  /** Backoff multiplier. Default 2. */
  readonly factor?: number;
  /** Add +/- jitter to each wait to avoid thundering herds. Default true. */
  readonly jitter?: boolean;
  /** Abort the poll loop. */
  readonly signal?: AbortSignal;
}

/**
 * Call `fn` until it returns a truthy value, then return it. Between calls,
 * wait with exponential backoff (and optional jitter). A thrown error inside
 * `fn` is treated as transient (throttle / 5xx) and keeps polling until the
 * deadline; the last error is surfaced on timeout.
 *
 * Provisioners own their readiness predicate (design §7): e.g. RDS waits until
 * `DBInstanceStatus === "available"`, DynamoDB until `TableStatus === "ACTIVE"`.
 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: WaitForOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs;
  const initialIntervalMs = opts.initialIntervalMs ?? 2000;
  const maxIntervalMs = opts.maxIntervalMs ?? 30_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? true;

  const deadline = Date.now() + timeoutMs;
  let interval = initialIntervalMs;
  let lastError: unknown;

  for (;;) {
    if (opts.signal?.aborted) throw new WaitForAbortedError();
    let result: T | null | undefined | false;
    try {
      result = await fn();
    } catch (err) {
      // Transient — keep polling until the deadline surfaces it.
      lastError = err;
      result = null;
    }
    if (result) return result;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new WaitForTimeoutError(
        `waitFor timed out after ${timeoutMs}ms${detail}`,
        timeoutMs,
        lastError,
      );
    }
    const base = Math.min(interval, maxIntervalMs);
    const wait = jitter ? base * (0.5 + Math.random() * 0.5) : base;
    await sleep(Math.min(wait, remaining));
    interval = Math.min(interval * factor, maxIntervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * Orchestrator
 * ------------------------------------------------------------------ */

export type Logger = Pick<Console, "log" | "info" | "warn" | "error">;

export interface ApplyOrchestratorOptions {
  readonly provisioners: Map<ResourceKind, Provisioner>;
  readonly state: StateStore;
  /** Default false — stop on first error, no rollback. */
  readonly continueOnError?: boolean;
  readonly logger?: Logger;
}

export type StepStatus = "applied" | "noop" | "skipped" | "failed";

export interface ApplyStepResult {
  readonly id: string;
  readonly op: PlanAction["op"];
  readonly status: StepStatus;
  /** Deterministic idempotency token used for this step (create/update/replace). */
  readonly idempotencyToken?: string;
  readonly state?: ResourceState;
  readonly error?: ApplyActionError;
  /** Per-database migration counts (present only after an `apply --migrate` pass). */
  readonly migrations?: { applied: number; skipped: number; errors: number };
}

export interface ApplyResult {
  readonly results: readonly ApplyStepResult[];
  readonly succeeded: number;
  readonly failed: number;
  /** True iff the run stopped early because of an error (no rollback performed). */
  readonly stoppedOnError: boolean;
}

export class ApplyActionError extends Error {
  constructor(
    message: string,
    readonly resourceId: string,
    readonly op: PlanAction["op"],
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "ApplyActionError";
  }
}

export class MissingProvisionerError extends ApplyActionError {
  constructor(resourceId: string, op: PlanAction["op"], kind: ResourceKind) {
    super(
      `No provisioner registered for kind "${kind}" (needed to ${op} "${resourceId}"). ` +
        `Register a Provisioner for this kind before applying.`,
      resourceId,
      op,
      undefined,
    );
    this.name = "MissingProvisionerError";
  }
}

/**
 * Execute a Plan. Runs under the state store's lock. For each non-noop action,
 * resolves the matching provisioner and calls `apply(action)`; on success, the
 * returned ResourceState is persisted immediately (delete actions remove the
 * state entry). On the first error the run stops — there is deliberately NO
 * rollback (design §6). Set `continueOnError` to keep going.
 */
export class ApplyOrchestrator {
  private readonly provisioners: Map<ResourceKind, Provisioner>;
  private readonly state: StateStore;
  private readonly continueOnError: boolean;
  private readonly logger: Logger | undefined;

  constructor(opts: ApplyOrchestratorOptions) {
    this.provisioners = opts.provisioners;
    this.state = opts.state;
    this.continueOnError = opts.continueOnError ?? false;
    this.logger = opts.logger;
  }

  async apply(plan: Plan): Promise<ApplyResult> {
    return await this.state.lock(async () => {
      const results: ApplyStepResult[] = [];
      let failed = 0;
      let stoppedOnError = false;

      for (const action of plan.actions) {
        // noop carries no spec/state and is never applied — short-circuit it
        // before computing the resource id / idempotency token / provisioner so
        // those paths only ever see actionable (create/update/replace/delete)
        // actions and stay type-narrowable.
        if (action.op === "noop") {
          results.push({ id: action.id, op: "noop", status: "noop" });
          continue;
        }

        const id = actionResourceId(action);
        const op = action.op;
        const token = op === "delete" ? undefined : idempotencyToken(id, op);
        try {
          if (action.op === "delete") {
            // Delete -> destroy() (no new state produced). The contract's
            // `apply` returns new state for create/update/replace; destroy is
            // the dedicated teardown path (design §5/§7).
            const provisioner = this.lookupProvisioner(action);
            await provisioner.destroy(action.state);
            await this.state.delete(id);
            results.push({ id, op, status: "applied", ...withToken(token) });
            this.logger?.info?.(`[${id}] delete -> destroyed`);
            continue;
          }
          const provisioner = this.lookupProvisioner(action);
          const next = await provisioner.apply(action);
          if (!next || next.id !== id) {
            throw new ApplyActionError(
              `Provisioner for kind "${action.spec.kind}" returned invalid state for "${id}"`,
              id,
              op,
              undefined,
            );
          }
          await this.state.put(next);
          results.push({ id, op, status: "applied", ...withToken(token), state: next });
          this.logger?.info?.(`[${id}] ${op} -> applied`);
        } catch (err) {
          failed++;
          const error =
            err instanceof ApplyActionError
              ? err
              : new ApplyActionError(errorMessage(err), id, op, err);
          results.push({ id, op, status: "failed", ...withToken(token), error });
          this.logger?.error?.(`[${id}] ${op} failed: ${error.message}`);
          if (!this.continueOnError) {
            stoppedOnError = true;
            break;
          }
        }
      }

      const succeeded = results.filter((r) => r.status === "applied" || r.status === "noop").length;
      return { results, succeeded, failed, stoppedOnError };
    });
  }

  private lookupProvisioner(action: ActionablePlanAction): Provisioner {
    if (action.op === "delete") {
      const kind = action.state.kind;
      const provisioner = this.provisioners.get(kind);
      if (!provisioner) throw new MissingProvisionerError(action.state.id, "delete", kind);
      return provisioner;
    }
    const kind = action.spec.kind;
    const provisioner = this.provisioners.get(kind);
    if (!provisioner) throw new MissingProvisionerError(action.spec.id, action.op, kind);
    return provisioner;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * A PlanAction with the `noop` variant excluded — the actions the orchestrator
 * actually executes (create/update/replace/delete). noop is short-circuited
 * before any provisioner lookup, so every action here carries a spec or state.
 */
export type ActionablePlanAction = Exclude<PlanAction, { op: "noop" }>;

/** The stable resource id an action targets. Valid for every PlanAction variant. */
export function actionResourceId(action: PlanAction): string {
  switch (action.op) {
    case "delete":
      return action.state.id;
    case "noop":
      return action.id;
    default:
      return action.spec.id;
  }
}

/**
 * Conditionally include the idempotency token on a step result (only for
 * create/update/replace; never for delete or noop). Keeps the object literal
 * clean under `exactOptionalPropertyTypes`.
 */
function withToken(token: string | undefined): { idempotencyToken: string } | Record<string, never> {
  return token !== undefined ? { idempotencyToken: token } : {};
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
