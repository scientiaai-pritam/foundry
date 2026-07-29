/**
 * Parse a user-supplied `ResourceSpec.props` (an untyped Record) into a fully
 * validated, defaulted {@link NormalizedTable}, and recover a NormalizedTable
 * from persisted `ResourceState.outputs`.
 *
 * All validation happens here so the rest of the provisioner can assume a
 * well-formed shape. Defaults (design §5/§7):
 *   - billingMode        → PAY_PER_REQUEST
 *   - pointInTimeRecovery→ true
 *   - protect            → false
 */
import type {
  DynamoAttributeDefinition,
  DynamoAttributeType,
  DynamoBillingMode,
  DynamoGSI,
  DynamoKeyElement,
  DynamoKeyType,
  DynamoProjection,
  DynamoProjectionType,
  DynamoProvisionedThroughput,
  NormalizedTable,
} from "./types.js";
import { DynamoConfigError } from "./errors.js";

/* ----------------------------- guards ----------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isAttrType(v: unknown): v is DynamoAttributeType {
  return v === "S" || v === "N" || v === "B";
}
function isKeyType(v: unknown): v is DynamoKeyType {
  return v === "HASH" || v === "RANGE";
}
function isBillingMode(v: unknown): v is DynamoBillingMode {
  return v === "PROVISIONED" || v === "PAY_PER_REQUEST";
}
function isProjectionType(v: unknown): v is DynamoProjectionType {
  return v === "ALL" || v === "KEYS_ONLY" || v === "INCLUDE";
}
/**
 * Parse + normalize the user-supplied billing mode. Accepts the spec's
 * lowercase values (`pay_per_request` | `provisioned`, design §5) AND the AWS
 * PascalCase forms (`PAY_PER_REQUEST` | `PROVISIONED`), normalizing to the
 * canonical AWS PascalCase used internally / persisted in state.
 */
function parseBillingMode(v: unknown): DynamoBillingMode {
  if (v === undefined || v === "pay_per_request" || v === "PAY_PER_REQUEST") {
    return "PAY_PER_REQUEST";
  }
  if (v === "provisioned" || v === "PROVISIONED") return "PROVISIONED";
  throw new DynamoConfigError(
    "billingMode must be 'pay_per_request' | 'provisioned' (or AWS 'PAY_PER_REQUEST' | 'PROVISIONED')",
  );
}

/* --------------------------- coercions ---------------------------- */

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new DynamoConfigError(`${field} must be a non-empty string`);
  }
  return v;
}
function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") {
    throw new DynamoConfigError(`${field} must be a boolean`);
  }
  return v;
}
function asNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new DynamoConfigError(`${field} must be a non-negative finite number`);
  }
  return v;
}
function asArray<T>(
  v: unknown,
  field: string,
  parseItem: (item: unknown) => T,
): T[] {
  if (!Array.isArray(v)) {
    throw new DynamoConfigError(`${field} must be an array`);
  }
  return v.map((item) => parseItem(item));
}

/* --------------------------- field parsers ------------------------ */

function parseAttributeDefinition(item: unknown): DynamoAttributeDefinition {
  if (!isObject(item)) {
    throw new DynamoConfigError("attributeDefinitions entries must be objects");
  }
  const type = item.type;
  if (!isAttrType(type)) {
    throw new DynamoConfigError(
      "attributeDefinitions[].type must be one of 'S' | 'N' | 'B'",
    );
  }
  return { name: asString(item.name, "attributeDefinitions[].name"), type };
}

function parseKeyElement(item: unknown): DynamoKeyElement {
  if (!isObject(item)) {
    throw new DynamoConfigError("keySchema entries must be objects");
  }
  const type = item.type;
  if (!isKeyType(type)) {
    throw new DynamoConfigError("keySchema[].type must be 'HASH' or 'RANGE'");
  }
  return { name: asString(item.name, "keySchema[].name"), type };
}

function parseProjection(item: unknown): DynamoProjection {
  if (!isObject(item)) {
    throw new DynamoConfigError("globalSecondaryIndexes[].projection must be an object");
  }
  const type = item.type;
  if (!isProjectionType(type)) {
    throw new DynamoConfigError(
      "projection.type must be 'ALL' | 'KEYS_ONLY' | 'INCLUDE'",
    );
  }
  const nonKeyAttributes =
    item.nonKeyAttributes === undefined
      ? undefined
      : asArray(item.nonKeyAttributes, "projection.nonKeyAttributes", (x) =>
          asString(x, "projection.nonKeyAttributes[]"),
        );
  if (type === "INCLUDE" && (!nonKeyAttributes || nonKeyAttributes.length === 0)) {
    throw new DynamoConfigError(
      "projection.type 'INCLUDE' requires a non-empty nonKeyAttributes list",
    );
  }
  const out: DynamoProjection = { type };
  if (nonKeyAttributes) out.nonKeyAttributes = nonKeyAttributes;
  return out;
}

function parseProvisionedThroughput(item: unknown): DynamoProvisionedThroughput {
  if (!isObject(item)) {
    throw new DynamoConfigError("provisionedThroughput must be an object");
  }
  return {
    readCapacityUnits: asNumber(
      item.readCapacityUnits,
      "provisionedThroughput.readCapacityUnits",
    ),
    writeCapacityUnits: asNumber(
      item.writeCapacityUnits,
      "provisionedThroughput.writeCapacityUnits",
    ),
  };
}

function parseGsi(item: unknown): DynamoGSI {
  if (!isObject(item)) {
    throw new DynamoConfigError("globalSecondaryIndexes entries must be objects");
  }
  const keySchema = asArray(item.keySchema, "globalSecondaryIndexes[].keySchema", parseKeyElement);
  if (keySchema.length === 0 || !keySchema.some((k) => k.type === "HASH")) {
    throw new DynamoConfigError(
      "globalSecondaryIndexes[].keySchema must contain a HASH element",
    );
  }
  const g: DynamoGSI = {
    indexName: asString(item.indexName, "globalSecondaryIndexes[].indexName"),
    keySchema,
    projection: parseProjection(item.projection),
  };
  if (item.provisionedThroughput !== undefined) {
    g.provisionedThroughput = parseProvisionedThroughput(item.provisionedThroughput);
  }
  return g;
}

/* --------------------- cross-field validation --------------------- */

function indexAttributeTypes(attrs: readonly DynamoAttributeDefinition[]): Map<string, DynamoAttributeType> {
  const map = new Map<string, DynamoAttributeType>();
  for (const a of attrs) {
    if (map.has(a.name)) {
      throw new DynamoConfigError(`duplicate attributeDefinition for '${a.name}'`);
    }
    map.set(a.name, a.type);
  }
  return map;
}

function assertKeyAttributesDeclared(
  attrs: readonly DynamoAttributeDefinition[],
  keys: readonly DynamoKeyElement[],
  label: string,
): void {
  const types = indexAttributeTypes(attrs);
  for (const k of keys) {
    if (!types.has(k.name)) {
      throw new DynamoConfigError(
        `${label} key attribute '${k.name}' is not declared in attributeDefinitions`,
      );
    }
  }
}

/* ------------------------- public parsers ------------------------- */

/** Parse + default `ResourceSpec.props` into a NormalizedTable. Throws on invalid config. */
export function parseSpecProps(props: Record<string, unknown>): NormalizedTable {
  const tableName = asString(props.tableName, "tableName");

  const attributeDefinitions = asArray(
    props.attributeDefinitions,
    "attributeDefinitions",
    parseAttributeDefinition,
  );

  const keySchema = asArray(props.keySchema, "keySchema", parseKeyElement);
  if (keySchema.length === 0) {
    throw new DynamoConfigError("keySchema must contain at least one element (HASH)");
  }
  if (!keySchema.some((k) => k.type === "HASH")) {
    throw new DynamoConfigError("keySchema must contain a HASH key");
  }
  assertKeyAttributesDeclared(attributeDefinitions, keySchema, "table");

  const globalSecondaryIndexes =
    props.globalSecondaryIndexes === undefined
      ? []
      : asArray(props.globalSecondaryIndexes, "globalSecondaryIndexes", parseGsi);
  for (const g of globalSecondaryIndexes) {
    assertKeyAttributesDeclared(attributeDefinitions, g.keySchema, `GSI '${g.indexName}'`);
  }

  const billingMode = parseBillingMode(props.billingMode);

  let provisionedThroughput: DynamoProvisionedThroughput | undefined;
  if (props.provisionedThroughput !== undefined) {
    provisionedThroughput = parseProvisionedThroughput(props.provisionedThroughput);
  }
  if (billingMode === "PROVISIONED" && !provisionedThroughput) {
    throw new DynamoConfigError(
      "billingMode 'PROVISIONED' requires provisionedThroughput { readCapacityUnits, writeCapacityUnits }",
    );
  }
  if (billingMode === "PAY_PER_REQUEST") {
    const offender = globalSecondaryIndexes.find((g) => g.provisionedThroughput);
    if (offender) {
      throw new DynamoConfigError(
        `GSI '${offender.indexName}' sets provisionedThroughput but billingMode is PAY_PER_REQUEST`,
      );
    }
  }

  const pointInTimeRecovery =
    props.pointInTimeRecovery === undefined ? true : asBoolean(props.pointInTimeRecovery, "pointInTimeRecovery");
  const protect =
    props.protect === undefined ? false : asBoolean(props.protect, "protect");

  const out: NormalizedTable = {
    tableName,
    attributeDefinitions,
    keySchema,
    globalSecondaryIndexes,
    billingMode,
    pointInTimeRecovery,
    pointInTimeRecoveryKnown: true,
    protect,
  };
  if (provisionedThroughput) out.provisionedThroughput = provisionedThroughput;
  return out;
}

/** Recover a NormalizedTable from persisted `ResourceState.outputs`. Returns null if malformed. */
export function outputsToNormalized(outputs?: Record<string, unknown>): NormalizedTable | null {
  if (!isObject(outputs)) return null;
  try {
    if (typeof outputs.tableName !== "string" || outputs.tableName.length === 0) return null;
    if (!Array.isArray(outputs.attributeDefinitions)) return null;
    if (!Array.isArray(outputs.keySchema)) return null;
    if (!Array.isArray(outputs.globalSecondaryIndexes)) return null;
    if (!isBillingMode(outputs.billingMode)) return null;

    const out: NormalizedTable = {
      tableName: outputs.tableName,
      attributeDefinitions: outputs.attributeDefinitions.map((i) => parseAttributeDefinition(i)),
      keySchema: outputs.keySchema.map((i) => parseKeyElement(i)),
      globalSecondaryIndexes: outputs.globalSecondaryIndexes.map((i) => parseGsi(i)),
      billingMode: outputs.billingMode,
      pointInTimeRecovery:
        typeof outputs.pointInTimeRecovery === "boolean" ? outputs.pointInTimeRecovery : false,
      pointInTimeRecoveryKnown:
        typeof outputs.pointInTimeRecoveryKnown === "boolean"
          ? outputs.pointInTimeRecoveryKnown
          : true,
      protect: typeof outputs.protect === "boolean" ? outputs.protect : false,
    };
    if (isObject(outputs.provisionedThroughput)) {
      out.provisionedThroughput = parseProvisionedThroughput(outputs.provisionedThroughput);
    }
    return out;
  } catch {
    return null;
  }
}
