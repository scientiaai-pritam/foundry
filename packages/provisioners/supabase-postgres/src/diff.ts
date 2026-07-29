/**
 * Declarative diff between a desired and current {@link NormalizedProject}.
 *
 * Mirrors the aws-dynamodb diff shape: fields that cannot be reconciled in place
 * force a `replace`; otherwise the divergent in-place fields are returned.
 *
 * Supabase modify gaps (documented):
 * - region / organizationId → cannot be changed in place → replace.
 * - plan → not exposed by PATCH /v1/projects/{ref}; treated as an in-place
 *   `update` but applyUpdate does not enforce it (billing tier changes need
 *   manual subscription management). Including it in changedFields keeps the
 *   drift visible without triggering a destructive recreate.
 * - name / instanceSize → genuinely in-place (PATCH / billing addons).
 * - dbPass → NEVER diffed: it is not persisted, so drift on it is undetectable
 *   by design (rotate via PATCH /v1/projects/{ref}/database/password instead).
 */
import type { NormalizedProject } from "./types.js";

export interface DiffResult {
  requiresReplace: boolean;
  replaceReason?: string;
  changedFields: string[];
}

export function diffProject(desired: NormalizedProject, current: NormalizedProject): DiffResult {
  // Identifier-like fields that cannot move in place → replace.
  if (
    desired.organizationId &&
    current.organizationId &&
    desired.organizationId !== current.organizationId
  ) {
    return replace(
      `organizationId cannot be changed in place ('${current.organizationId}' → '${desired.organizationId}'); recreate the project under the target organization`,
    );
  }
  if (desired.region && current.region && desired.region !== current.region) {
    return replace(
      `region cannot be changed in place ('${current.region}' → '${desired.region}'); Supabase projects cannot be moved between regions`,
    );
  }

  const changed: string[] = [];
  if (desired.name !== current.name) changed.push("name");
  if (desired.plan !== current.plan) changed.push("plan");
  if (desired.instanceSize !== current.instanceSize) changed.push("instanceSize");
  if (desired.protect !== current.protect) changed.push("protect");

  return { requiresReplace: false, changedFields: changed };
}

function replace(reason: string): DiffResult {
  return { requiresReplace: true, replaceReason: reason, changedFields: [] };
}
