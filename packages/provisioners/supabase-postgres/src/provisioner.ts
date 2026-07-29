/**
 * Supabase Postgres provisioner — implements the scientia `Provisioner` contract
 * for `kind: "supabase.postgres"` via a thin fetch client against the Supabase
 * Management REST API.
 *
 * Lifecycle mapping (design v1, §5/§7):
 *   - plan    → diff desired vs current (update vs replace vs noop)
 *   - apply   → create (read-before-create idempotency, poll status→ACTIVE),
 *               in-place update (PATCH name/instanceSize, best-effort), replace
 *               (delete + create), STOP-on-error, NO auto-rollback
 *   - read    → GET /v1/projects/{ref} for drift detection
 *   - destroy → DELETE /v1/projects/{ref}, honoring a `protect` flag
 *
 * Security posture:
 *   - The provider's Supabase access token (Bearer) is resolved transiently by
 *     the client from a tokenRef POINTER — its VALUE is never logged/stored.
 *   - The Postgres DB password (dbPass credsRef) is resolved transiently ONLY to
 *     send `db_pass` on the create POST; the VALUE is never stored in state,
 *     outputs, or error messages. The POINTER is emitted on
 *     ConnectionTarget.credsRef for the postgres connector to resolve.
 */
import type {
  ConnectionTarget,
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceSpec,
  ResourceState,
  WaitForOptions,
} from "@scientia/core";
import { waitFor } from "@scientia/core";

import type { ProjectResponse, SupabaseManagementClient } from "./client.js";
import { resolveSecret } from "./client.js";
import {
  ProtectedResourceError,
  SupabaseApiError,
  SupabaseConfigError,
  SupabasePostgresProvisionerError,
  isSupabaseApiError,
  wrapApiError,
} from "./errors.js";
import { diffProject } from "./diff.js";
import { outputsToNormalized, parseSpecProps } from "./parse.js";
import {
  isPausedStatus,
  isReadyStatus,
  mapProjectStatus,
  projectHost,
  toCreateBody,
  toUpdateBody,
  withDbPort,
} from "./convert.js";
import type { NormalizedProject, SupabasePostgresProvisionerOptions } from "./types.js";

export class SupabasePostgresProvisioner implements Provisioner {
  readonly kind: ResourceKind = "supabase.postgres";

  private readonly client: SupabaseManagementClient;
  // exactOptionalPropertyTypes: type as `| undefined` (not `?`) so assigning a
  // possibly-undefined opts value is allowed, mirroring aws-dynamodb.
  private readonly secretResolver: ((secretId: string) => Promise<string>) | undefined;
  private readonly allowProtectedDestroy: boolean;
  private readonly waitForOpts: WaitForOptions;

  constructor(opts: SupabasePostgresProvisionerOptions) {
    this.client = opts.client;
    this.secretResolver = opts.secretResolver;
    this.allowProtectedDestroy = opts.allowProtectedDestroy ?? false;
    // Core's WaitForOptions requires timeoutMs; default to 5 min (project
    // creation + DB provisioning can take a couple of minutes).
    this.waitForOpts = opts.waitFor ?? { timeoutMs: 300_000 };
  }

  /* =========================== plan ============================ */

  plan(desired: ResourceSpec, current: ResourceState | null): PlanAction {
    if (current === null) {
      return { op: "create", spec: desired };
    }
    const desiredN = parseSpecProps(desired.props);
    const currentN = outputsToNormalized(current.outputs);
    if (!currentN) {
      // State predates normalized outputs (or was hand-edited). Don't guess;
      // propose a full in-place reconciliation and let apply re-read live.
      return {
        op: "update",
        spec: desired,
        from: current,
        changedFields: ["*"],
      };
    }

    const d = diffProject(desiredN, currentN);
    if (d.requiresReplace) {
      return {
        op: "replace",
        spec: desired,
        reason: d.replaceReason ?? "resource must be replaced",
      };
    }
    if (d.changedFields.length === 0) {
      return {
        op: "noop",
        id: desired.id,
        reason: `project '${desiredN.name}' matches desired state`,
      };
    }
    return {
      op: "update",
      spec: desired,
      from: current,
      changedFields: d.changedFields,
    };
  }

  /* =========================== apply =========================== */

  async apply(action: PlanAction): Promise<ResourceState> {
    switch (action.op) {
      case "create":
        return this.applyCreate(action.spec);
      case "update":
        return this.applyUpdate(action.spec, action.from, action.changedFields);
      case "replace":
        return this.applyReplace(action.spec);
      // delete is routed through destroy() by the orchestrator; noop is skipped
      // before provisioner dispatch (it carries only an id, no spec/state). They
      // never reach apply() — surface a clear error if a caller misuses the API.
      case "delete":
      case "noop":
        throw new SupabasePostgresProvisionerError(
          `apply() does not handle op "${action.op}" (delete uses destroy(); noop is skipped by the orchestrator)`,
          action.op === "delete" ? action.state.id : action.id,
          action.op,
        );
      default: {
        const _exhaustive: never = action;
        throw new SupabasePostgresProvisionerError(
          `unknown action: ${JSON.stringify(_exhaustive)}`,
          "?",
          "apply",
        );
      }
    }
  }

  /* =========================== read ============================ */

  async read(spec: ResourceSpec): Promise<ResourceState | null> {
    return this.readInternal(spec);
  }

  /* ========================= destroy =========================== */

  async destroy(state: ResourceState): Promise<void> {
    const ref = readRefFromState(state);
    if (!ref) {
      throw new SupabasePostgresProvisionerError(
        "cannot destroy: project ref not found in state (identifiers.ref or outputs.ref)",
        state.id,
        "destroy",
      );
    }

    const protect =
      typeof state.outputs?.protect === "boolean" ? state.outputs.protect : false;
    if (protect && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(state.id, "destroy");
    }

    await this.deleteProject(ref, state.id);
    await this.pollUntilDeleted(ref, state.id);
  }

  /* ===================== apply sub-flows ====================== */

  private async applyCreate(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    if (!desired.organizationId) {
      throw new SupabaseConfigError("'organizationId' is required to create a Supabase project");
    }
    if (!desired.region) {
      throw new SupabaseConfigError("'region' is required to create a Supabase project");
    }
    if (!desired.dbPassRef) {
      throw new SupabaseConfigError("'dbPass' (credsRef) is required to create a Supabase project");
    }

    // Supabase has NO native create idempotency token (unlike RDS
    // ClientRequestToken). We guard with read-before-create: if a project with
    // the same ref (or name) already exists and is healthy, treat it as
    // already-created. The framework's unified idempotency token (from
    // @scientia/core) is still recorded by the orchestrator on the step result.
    const existingRef = await this.resolveRef(spec).catch((e) => {
      throw wrapApiError(e, spec.id, "create");
    });
    if (existingRef) {
      const existing = await this.tryGetProject(existingRef);
      if (existing && isReadyStatus(existing.status)) {
        return this.buildState(spec, existing, desired);
      }
    }

    // Resolve the DB password transiently — sent ONLY in the create POST,
    // never persisted anywhere. The POINTER is emitted via ConnectionTarget.
    const dbPass = await resolveSecret(desired.dbPassRef, this.secretResolver);
    const body = toCreateBody(desired, dbPass);

    let createdRef: string;
    try {
      const created = await this.client.createProject(body);
      createdRef = created.ref;
    } catch (e) {
      // Tolerate a conflict (409) / validation duplicate (422): the
      // read-before-create may have raced; fall back to resolving the existing
      // project rather than failing the apply.
      if (isSupabaseApiError(e) && (e.status === 409 || e.status === 422)) {
        const fallback = await this.resolveRef(spec).catch(() => null);
        if (!fallback) throw wrapApiError(e, spec.id, "create");
        createdRef = fallback;
      } else {
        throw wrapApiError(e, spec.id, "create");
      }
    }

    await this.pollUntilActive(createdRef, spec.id);

    const state = await this.readInternal(spec, createdRef);
    if (!state) {
      throw wrapApiError(
        new Error("project not found immediately after create"),
        spec.id,
        "create",
      );
    }
    return state;
  }

  private async applyUpdate(
    spec: ResourceSpec,
    from: ResourceState,
    changedFields: readonly string[],
  ): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    const ref = await this.resolveRefFromState(spec, from);

    // name / instanceSize are the only genuinely in-place-patchable fields.
    // plan drift is reported by the planner but NOT enforced here (Supabase does
    // not expose direct plan changes via the project PATCH endpoint). "*" means
    // the planner could not diff against prior outputs — re-apply everything we
    // can. dbPass is never part of an update.
    const wantsPatch =
      changedFields.includes("name") ||
      changedFields.includes("instanceSize") ||
      changedFields.includes("*");

    if (wantsPatch) {
      const body = toUpdateBody(desired);
      if (body.name !== undefined || body.desired_instance_size !== undefined) {
        try {
          await this.client.updateProject(ref, body);
        } catch (e) {
          throw wrapApiError(e, spec.id, "update");
        }
        await this.pollUntilActive(ref, spec.id);
      }
    }

    const state = await this.readInternal(spec, ref);
    if (!state) {
      throw wrapApiError(new Error("project not found after update"), spec.id, "update");
    }
    return state;
  }

  private async applyReplace(spec: ResourceSpec): Promise<ResourceState> {
    const desired = parseSpecProps(spec.props);
    if (desired.protect && !this.allowProtectedDestroy) {
      throw new ProtectedResourceError(spec.id, "replace");
    }

    const existingRef = await this.resolveRef(spec).catch((e) => {
      throw wrapApiError(e, spec.id, "replace");
    });
    if (existingRef) {
      const existing = await this.tryGetProject(existingRef);
      if (existing) {
        await this.deleteProject(existingRef, spec.id);
        await this.pollUntilDeleted(existingRef, spec.id);
      }
    }
    return this.applyCreate(spec);
  }

  /* ====================== private helpers ===================== */

  /** Resolve the project ref from a spec: explicit ref first, else list+match by name. */
  private async resolveRef(spec: ResourceSpec): Promise<string | null> {
    const desired = parseSpecProps(spec.props);
    if (desired.ref) return desired.ref;
    const projects = await this.client.listProjects();
    const match = projects.find((p) => p.name === desired.name);
    return match?.ref ?? null;
  }

  /** Resolve the ref for an update (from state preferred, else spec/lookup). */
  private async resolveRefFromState(spec: ResourceSpec, from: ResourceState): Promise<string> {
    const ref = readRefFromState(from) ?? (await this.resolveRef(spec));
    if (!ref) {
      throw wrapApiError(
        new Error("cannot update: project ref not found in state or by name lookup"),
        spec.id,
        "update",
      );
    }
    return ref;
  }

  /** GET a project, returning null on 404 and re-throwing other errors. */
  private async tryGetProject(ref: string): Promise<ProjectResponse | null> {
    try {
      return await this.client.getProject(ref);
    } catch (e) {
      if (isSupabaseApiError(e) && e.status === 404) return null;
      throw e;
    }
  }

  /** DELETE a project, treating 404 (already gone) as success. */
  private async deleteProject(ref: string, resourceId: string): Promise<void> {
    try {
      await this.client.deleteProject(ref);
    } catch (e) {
      if (isSupabaseApiError(e) && e.status === 404) return;
      throw wrapApiError(e, resourceId, "delete");
    }
  }

  /**
   * Build a ResourceState. `desired` contributes the dbPassRef POINTER (emitted
   * on ConnectionTarget.credsRef) and any spec fields not returned by the API.
   * No secret VALUE is placed on the state.
   */
  private buildState(
    spec: ResourceSpec,
    project: ProjectResponse,
    desired: NormalizedProject,
  ): ResourceState {
    const host = projectHost(project);
    const region = project.region ?? desired.region;
    const ref = project.ref;

    const connection: ConnectionTarget = { engine: "postgres" };
    if (host) connection.endpoint = withDbPort(host);
    if (region) connection.region = region;
    if (desired.dbPassRef) connection.credsRef = desired.dbPassRef;

    const identifiers: Record<string, string> = { ref };
    if (project.name) identifiers.name = project.name;

    // Outputs are persisted for the next plan() diff. NO dbPass pointer/value
    // is stored: drift on the password is undetectable by design.
    const outputs: Record<string, unknown> = {
      name: project.name ?? desired.name,
      ref,
      protect: desired.protect,
    };
    if (desired.organizationId) outputs.organizationId = desired.organizationId;
    else if (project.organization_id) outputs.organizationId = project.organization_id;
    if (desired.plan) outputs.plan = desired.plan;
    if (region) outputs.region = region;
    if (desired.instanceSize) outputs.instanceSize = desired.instanceSize;

    return {
      id: spec.id,
      kind: "supabase.postgres",
      identifiers,
      status: mapProjectStatus(project.status),
      connection,
      outputs,
    };
  }

  /**
   * Read-driven state builder. `knownRef` lets apply flows pass the just-created
   * ref directly instead of re-resolving by name.
   */
  private async readInternal(
    spec: ResourceSpec,
    knownRef?: string,
  ): Promise<ResourceState | null> {
    const desired = parseSpecProps(spec.props);
    const ref = knownRef ?? (await this.resolveRef(spec).catch((e) => {
      throw wrapApiError(e, spec.id, "read");
    }));
    if (!ref) return null;

    const project = await this.tryGetProject(ref);
    if (!project) return null;
    return this.buildState(spec, project, desired);
  }

  /** Poll GET /v1/projects/{ref} until the project is ACTIVE/ACTIVE_HEALTHY. */
  private async pollUntilActive(ref: string, resourceId: string): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        try {
          const p = await this.client.getProject(ref);
          lastStatus = p.status;
          return isReadyStatus(p.status);
        } catch (e) {
          // During create, the project may briefly be not-yet-visible (404).
          if (isSupabaseApiError(e) && e.status === 404) {
            lastStatus = "NOT_FOUND";
            return false;
          }
          throw e;
        }
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        const paused = isPausedStatus(lastStatus);
        throw new SupabasePostgresProvisionerError(
          `project '${ref}' did not become ACTIVE (last status: ${lastStatus ?? "unknown"})` +
            (paused ? "; the project is paused/stopped and will not become ready on its own" : ""),
          resourceId,
          "waitForActive",
          e,
          paused
            ? "Restore the project (POST /v1/projects/{ref}/restore) then re-run apply."
            : "Inspect the project in the Supabase dashboard; re-run apply to resume polling.",
        );
      }
      throw e;
    }
  }

  /** Poll GET /v1/projects/{ref} until it 404s (gone). */
  private async pollUntilDeleted(ref: string, resourceId: string): Promise<void> {
    let lastStatus: string | undefined;
    try {
      await waitFor(async () => {
        try {
          const p = await this.client.getProject(ref);
          lastStatus = p.status;
          return false; // still exists
        } catch (e) {
          if (isSupabaseApiError(e) && e.status === 404) return true;
          throw e;
        }
      }, this.waitForOpts);
    } catch (e) {
      if (e instanceof Error && e.name === "WaitForTimeoutError") {
        throw new SupabasePostgresProvisionerError(
          `project '${ref}' did not finish deleting (last status: ${lastStatus ?? "unknown"})`,
          resourceId,
          "waitForDeleted",
          e,
        );
      }
      throw e;
    }
  }
}

/** Read the project ref off persisted state (identifiers first, then outputs). */
function readRefFromState(state: ResourceState): string | undefined {
  const fromIdentifiers = state.identifiers.ref;
  if (typeof fromIdentifiers === "string" && fromIdentifiers.length > 0) return fromIdentifiers;
  const fromOutputs = state.outputs?.ref;
  return typeof fromOutputs === "string" && fromOutputs.length > 0 ? fromOutputs : undefined;
}
