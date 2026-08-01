/**
 * Diff two {@link NormalizedLocal} values for the local Postgres provisioner.
 *
 * Classification:
 *   - containerName change → replace (it is the container identity; renaming a
 *     container is not supported, you recreate it).
 *   - image change         → replace (an image is immutable on a running
 *     container; a pgvector upgrade etc. requires recreation).
 *   - port / dbName / username / network / persistent → update (cheap local
 *     recreate in place — local is fast, so there is no "in-place modify", just
 *     a recreate. Modelled as update so replace's snapshot semantics don't
 *     apply and to keep the plan output honest about what changed).
 */
import type { NormalizedLocal } from "./types.js";

export interface LocalDiff {
  readonly changedFields: string[];
  readonly requiresReplace: boolean;
  readonly replaceReason?: string;
}

/** Fields whose change forces a container recreate (identity / image). */
const REPLACE_FIELDS = ["containerName", "image"] as const;
/** Fields whose change is a cheap local recreate (modelled as update). */
const UPDATE_FIELDS = ["port", "dbName", "username", "network", "persistent"] as const;

export function diffLocal(desired: NormalizedLocal, current: NormalizedLocal): LocalDiff {
  for (const key of REPLACE_FIELDS) {
    if (desired[key] !== current[key]) {
      return {
        changedFields: [key],
        requiresReplace: true,
        replaceReason: `'${key}' cannot be changed in place (recreate the container)`,
      };
    }
  }

  const changedFields: string[] = [];
  for (const key of UPDATE_FIELDS) {
    if (key === "port" && !desired.portExplicit) continue; // auto-port is not a desired field
    if (desired[key] !== current[key]) {
      changedFields.push(key);
    }
  }

  return { changedFields, requiresReplace: false };
}
