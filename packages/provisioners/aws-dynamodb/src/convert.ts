/**
 * Conversion between scientia's camelCase table model and AWS SDK v3's
 * PascalCase shapes, plus mapping a live `TableDescription` back to a
 * {@link NormalizedTable} for drift detection.
 */
import type {
  AttributeDefinition,
  BillingMode,
  GlobalSecondaryIndex,
  GlobalSecondaryIndexDescription,
  KeySchemaElement,
  Projection,
  ProvisionedThroughput,
  ScalarAttributeType,
  TableDescription,
} from "@aws-sdk/client-dynamodb";
import type { ResourceState } from "@scientia/core";
import type {
  DynamoAttributeDefinition,
  DynamoGSI,
  DynamoKeyElement,
  DynamoProjection,
  DynamoProvisionedThroughput,
  NormalizedTable,
} from "./types.js";

/* --------------------------- to AWS ------------------------------ */

export function toAwsAttributeDefinitions(
  attrs: readonly DynamoAttributeDefinition[],
): AttributeDefinition[] {
  return attrs.map((a) => ({
    AttributeName: a.name,
    AttributeType: a.type as ScalarAttributeType,
  }));
}

export function toAwsKeySchema(keys: readonly DynamoKeyElement[]): KeySchemaElement[] {
  return keys.map((k) => ({ AttributeName: k.name, KeyType: k.type }));
}

export function toAwsProjection(p: DynamoProjection): Projection {
  const out: Projection = { ProjectionType: p.type };
  if (p.nonKeyAttributes) out.NonKeyAttributes = [...p.nonKeyAttributes];
  return out;
}

export function toAwsProvisionedThroughput(
  t: DynamoProvisionedThroughput,
): ProvisionedThroughput {
  return {
    ReadCapacityUnits: t.readCapacityUnits,
    WriteCapacityUnits: t.writeCapacityUnits,
  };
}

export function toAwsGSI(g: DynamoGSI): GlobalSecondaryIndex {
  const out: GlobalSecondaryIndex = {
    IndexName: g.indexName,
    KeySchema: toAwsKeySchema(g.keySchema),
    Projection: toAwsProjection(g.projection),
  };
  if (g.provisionedThroughput) {
    out.ProvisionedThroughput = toAwsProvisionedThroughput(g.provisionedThroughput);
  }
  return out;
}

export function toAwsGSIs(gs: readonly DynamoGSI[]): GlobalSecondaryIndex[] {
  return gs.map(toAwsGSI);
}

export function toAwsTags(tags: Record<string, string>): { Key: string; Value: string }[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/* -------------------------- from AWS ----------------------------- */

export function fromAwsAttributeDefinitions(attrs?: AttributeDefinition[]): DynamoAttributeDefinition[] {
  // Normalize: SDK AttributeName/AttributeType are optional under
  // noUncheckedIndexedAccess, but scientia types require them. Drop any
  // malformed entries (AWS always populates both for real DescribeTable output).
  const out: DynamoAttributeDefinition[] = [];
  for (const a of attrs ?? []) {
    if (a.AttributeName !== undefined && a.AttributeType !== undefined) {
      out.push({ name: a.AttributeName, type: a.AttributeType });
    }
  }
  return out;
}

export function fromAwsKeySchema(keys?: KeySchemaElement[]): DynamoKeyElement[] {
  const out: DynamoKeyElement[] = [];
  for (const k of keys ?? []) {
    if (k.AttributeName !== undefined && k.KeyType !== undefined) {
      out.push({ name: k.AttributeName, type: k.KeyType });
    }
  }
  return out;
}

export function fromAwsProjection(p?: Projection): DynamoProjection {
  if (!p) return { type: "ALL" };
  const out: DynamoProjection = { type: p.ProjectionType ?? "ALL" };
  if (p.NonKeyAttributes) out.nonKeyAttributes = [...p.NonKeyAttributes];
  return out;
}

export function fromAwsGSI(g: GlobalSecondaryIndexDescription): DynamoGSI | null {
  if (!g.IndexName || !g.KeySchema) return null;
  const out: DynamoGSI = {
    indexName: g.IndexName,
    keySchema: fromAwsKeySchema(g.KeySchema),
    projection: fromAwsProjection(g.Projection),
  };
  if (g.ProvisionedThroughput) {
    out.provisionedThroughput = {
      readCapacityUnits: g.ProvisionedThroughput.ReadCapacityUnits ?? 0,
      writeCapacityUnits: g.ProvisionedThroughput.WriteCapacityUnits ?? 0,
    };
  }
  return out;
}

export function fromAwsGSIs(gs?: GlobalSecondaryIndexDescription[]): DynamoGSI[] {
  const out: DynamoGSI[] = [];
  for (const g of gs ?? []) {
    const parsed = fromAwsGSI(g);
    if (parsed) out.push(parsed);
  }
  return out;
}

/* ---------------------- live description → state ------------------ */

/** Build a NormalizedTable from a DescribeTable result. `pitr` is read separately. */
export function tableDescriptionToNormalized(
  desc: TableDescription,
  pitr: boolean | null,
  protect: boolean,
): NormalizedTable {
  const billingMode: BillingMode = desc.BillingModeSummary?.BillingMode ?? "PROVISIONED";
  const out: NormalizedTable = {
    tableName: desc.TableName ?? "",
    attributeDefinitions: fromAwsAttributeDefinitions(desc.AttributeDefinitions),
    keySchema: fromAwsKeySchema(desc.KeySchema),
    globalSecondaryIndexes: fromAwsGSIs(desc.GlobalSecondaryIndexes),
    billingMode,
    pointInTimeRecovery: pitr ?? false,
    pointInTimeRecoveryKnown: pitr !== null,
    protect,
  };
  if (desc.ProvisionedThroughput) {
    out.provisionedThroughput = {
      readCapacityUnits: desc.ProvisionedThroughput.ReadCapacityUnits ?? 0,
      writeCapacityUnits: desc.ProvisionedThroughput.WriteCapacityUnits ?? 0,
    };
  }
  return out;
}

export function mapTableStatus(s: string | undefined): ResourceState["status"] {
  switch (s) {
    case "CREATING":
      return "creating";
    case "UPDATING":
      return "updating";
    case "DELETING":
      return "deleting";
    case "ACTIVE":
      return "available";
    default:
      // ARCHIVING | ARCHIVED | INACCESSIBLE_ENCRYPTION_CREDENTIALS | unknown
      return "error";
  }
}
