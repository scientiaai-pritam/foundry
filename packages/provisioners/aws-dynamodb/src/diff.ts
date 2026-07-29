/**
 * Desired-vs-current diffing for a DynamoDB table (design v1, §5 Provisioner
 * interface, §7 Drift). Owns the load-bearing `update` vs `replace` judgment:
 *
 *   - tableName change  → replace (AWS cannot rename a table in place)
 *   - keySchema change  → replace (DynamoDB has no in-place key-schema update)
 *   - billingMode       → update (UpdateTable BillingModeSpecification)
 *   - add/remove GSI    → update (UpdateTable GlobalSecondaryIndexUpdates)
 *   - PITR toggle       → update (UpdateContinuousBackups)
 *   - protect toggle    → update (framework flag, no cloud call)
 *   - provisioned RU/WU → update (UpdateTable ProvisionedThroughput)
 */
import type {
  DynamoAttributeDefinition,
  DynamoGSI,
  NormalizedTable,
} from "./types.js";
import { DynamoConfigError } from "./errors.js";

export interface DiffResult {
  requiresReplace: boolean;
  /** Only present when requiresReplace is true (exactOptional-friendly). */
  replaceReason?: string;
  /** In-place-changeable fields that differ. Empty when requiresReplace. */
  changedFields: string[];
}

/* ---------------------- deep equality (order-stable) ------------- */

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, val]) => `${k}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function sortBy<T>(arr: readonly T[], key: (t: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Key schema order is significant in DynamoDB (HASH before RANGE) — compared as-is. */
function keySchemaEqual(a: readonly { name: string; type: string }[], b: readonly { name: string; type: string }[]): boolean {
  return deepEqual(a, b);
}

/** Attribute definitions are an unordered set — compare sorted by name. */
function attributeDefinitionsEqual(
  a: readonly DynamoAttributeDefinition[],
  b: readonly DynamoAttributeDefinition[],
): boolean {
  return deepEqual(sortBy(a, (x) => x.name), sortBy(b, (x) => x.name));
}

function diffGsis(desired: readonly DynamoGSI[], current: readonly DynamoGSI[]): {
  toAdd: DynamoGSI[];
  toRemove: string[];
  changed: boolean;
} {
  const desiredMap = new Map(desired.map((g) => [g.indexName, g]));
  const currentMap = new Map(current.map((g) => [g.indexName, g]));

  const toAdd: DynamoGSI[] = [];
  const toRemove: string[] = [];
  let changed = false;

  for (const [name, g] of desiredMap) {
    const c = currentMap.get(name);
    if (!c) {
      toAdd.push(g);
      changed = true;
    } else if (!deepEqual(g, c)) {
      // AWS does not support an in-place *modification* of an existing GSI's keys;
      // treat as remove + add so apply replays it cleanly.
      toRemove.push(name);
      toAdd.push(g);
      changed = true;
    }
  }
  for (const name of currentMap.keys()) {
    if (!desiredMap.has(name)) {
      toRemove.push(name);
      changed = true;
    }
  }
  return { toAdd, toRemove, changed };
}

/** Attribute definitions required to create a GSI (looked up from the table's set). */
export function gsiKeyAttributes(
  g: DynamoGSI,
  attrDefs: readonly DynamoAttributeDefinition[],
): DynamoAttributeDefinition[] {
  const byName = new Map(attrDefs.map((a) => [a.name, a.type]));
  const out: DynamoAttributeDefinition[] = [];
  for (const k of g.keySchema) {
    const type = byName.get(k.name);
    if (!type) {
      throw new DynamoConfigError(
        `GSI '${g.indexName}' key attribute '${k.name}' is not declared in attributeDefinitions`,
      );
    }
    out.push({ name: k.name, type });
  }
  return out;
}

export function computeGsiChanges(
  desired: readonly DynamoGSI[],
  current: readonly DynamoGSI[],
): { toAdd: DynamoGSI[]; toRemove: string[] } {
  const r = diffGsis(desired, current);
  return { toAdd: r.toAdd, toRemove: r.toRemove };
}

/* ----------------------------- diff ------------------------------ */

export function diffTable(desired: NormalizedTable, current: NormalizedTable): DiffResult {
  if (desired.tableName !== current.tableName) {
    return {
      requiresReplace: true,
      replaceReason: `tableName cannot be changed in place ('${current.tableName}' → '${desired.tableName}'); DynamoDB tables cannot be renamed`,
      changedFields: [],
    };
  }
  if (!keySchemaEqual(desired.keySchema, current.keySchema)) {
    return {
      requiresReplace: true,
      replaceReason:
        "keySchema cannot be modified in place; DynamoDB does not support changing a table's primary key schema",
      changedFields: [],
    };
  }

  const changedFields: string[] = [];

  if (desired.billingMode !== current.billingMode) changedFields.push("billingMode");
  if (!attributeDefinitionsEqual(desired.attributeDefinitions, current.attributeDefinitions)) {
    changedFields.push("attributeDefinitions");
  }
  const gsi = diffGsis(desired.globalSecondaryIndexes, current.globalSecondaryIndexes);
  if (gsi.changed) changedFields.push("globalSecondaryIndexes");

  if (
    desired.billingMode === "PROVISIONED" &&
    current.billingMode === "PROVISIONED" &&
    !deepEqual(desired.provisionedThroughput, current.provisionedThroughput)
  ) {
    changedFields.push("provisionedThroughput");
  }

  // Only diff PITR when both sides actually know the live value.
  if (
    desired.pointInTimeRecoveryKnown &&
    current.pointInTimeRecoveryKnown &&
    desired.pointInTimeRecovery !== current.pointInTimeRecovery
  ) {
    changedFields.push("pointInTimeRecovery");
  }

  if (desired.protect !== current.protect) changedFields.push("protect");

  return { requiresReplace: false, changedFields };
}
