/**
 * @foundry/app — Composition root for foundry (design v1, §4 "Module
 * layout", §5 "Key boundary").
 *
 * The core kernel (`@foundry/core`) NEVER imports a concrete provisioner or
 * connector — it only knows the two contract shapes and consumes them via the
 * `provisioners` / `connectors` maps on `CLIContext`. Nothing registered
 * `DynamoDBProvisioner` (kind "aws.dynamodb") or the dynamodb connector
 * (engine "dynamodb") into the CLI, so `foundry apply` (→ MissingProvisioner)
 * and `db.connect()` (→ "No connector registered for engine") failed out of
 * the box.
 *
 * This package is that missing wiring. It is the ONE place that knows about
 * concrete plugins and glues them into the kernel's context defaults. Both the
 * `foundry` CLI binary (src/cli.ts) and programmatic callers (createAppContext)
 * get their plugins from the same single source of truth: {@link buildDefaultPlugins}.
 */
import { join } from "node:path";

import type {
  Connector,
  Logger,
  Provisioner,
  ResourceKind,
  WaitForOptions,
} from "@foundry/core";
import {
  FileStateStore,
  loadStack,
  resolveAwsRegion,
} from "@foundry/core";
import type { CLIContext } from "@foundry/core";
import type { Engine, Stack } from "@foundry/core";

import { DynamoDBProvisioner, createDynamoDBClient } from "@foundry/aws-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createAwsRdsPostgresProvisioner, createRdsClient } from "@foundry/aws-rds-postgres";
import type { RDSClient } from "@aws-sdk/client-rds";

import { createRedshiftProvisioner, createRedshiftClient } from "@foundry/aws-redshift";
import type { RedshiftClient } from "@aws-sdk/client-redshift";

import { createSupabasePostgresProvisioner } from "@foundry/supabase-postgres";

import { dynamodbConnector } from "@foundry/connector-dynamodb";
import { postgresConnector } from "@foundry/connector-postgres";
import { mongodbConnector } from "@foundry/connector-mongodb";
import { redshiftConnector } from "@foundry/connector-redshift";

/* ------------------------------------------------------------------ *
 * Plugin registry — the composition root
 * ------------------------------------------------------------------ */

export interface BuildPluginsOptions {
  /**
   * AWS region for the AWS provisioners (DynamoDB / RDS Postgres / Redshift).
   * Falls back to the ambient credential-chain region (AWS_REGION /
   * AWS_DEFAULT_REGION) via resolveAwsRegion. When absent, the AWS provisioners
   * are NOT registered (a stack targeting an AWS kind then surfaces a clear
   * MissingProvisioner at apply time) — this lets a non-AWS (e.g. Supabase-only)
   * stack work without any AWS configuration.
   */
  readonly region?: string;
  /**
   * Inject a DynamoDBClient (e.g. a LocalStack endpoint, or a test stub).
   * Defaults to a real client built from `region` using the ambient AWS
   * credential chain. aws-sdk-client-mock patches the prototype, so tests can
   * omit this and mock globally.
   */
  readonly dynamodbClient?: DynamoDBClient;
  /** Inject an RDSClient (tests / LocalStack). Defaults to ambient from `region`. */
  readonly rdsClient?: RDSClient;
  /** Inject a RedshiftClient (tests / LocalStack). Defaults to ambient from `region`. */
  readonly redshiftClient?: RedshiftClient;
  /**
   * Override the provisioners' poll tuning (mostly for tests; defaults are
   * generous ceilings so they work for slow engines too).
   */
  readonly waitFor?: WaitForOptions;
}

export interface Plugins {
  readonly provisioners: Map<ResourceKind, Provisioner>;
  readonly connectors: Map<Engine, Connector>;
}

/**
 * Build the default plugin registry for every v1 engine. This is the single
 * composition point — both the CLI binary and {@link createAppContext} source
 * their plugins here, so adding a new engine means adding a line here (and its
 * package), not touching the core.
 *
 * Connectors (engine → native client) are always registered; they carry no
 * cloud-admin credentials — a database's own credsRef is resolved by the
 * connector at connect time. Note the engine→connector decoupling: the single
 * "postgres" connector serves BOTH RDS Postgres and Supabase Postgres databases.
 *
 * AWS provisioners (kind → cloud control-plane) are registered only when an AWS
 * `region` resolves (they build a client from the ambient credential chain).
 * The Supabase provisioner is non-AWS and always registered; its provider
 * access token is a SecretRef POINTER resolved lazily per request (never logged).
 */
export function buildDefaultPlugins(opts: BuildPluginsOptions = {}): Plugins {
  const region = resolveAwsRegion(opts.region);

  const provisioners = new Map<ResourceKind, Provisioner>();
  const connectors = new Map<Engine, Connector>();

  // --- Connectors: engine → native client. One "postgres" connector serves
  // both RDS and Supabase Postgres DBs (the engine is what connects). ---
  connectors.set("dynamodb", dynamodbConnector);
  connectors.set("postgres", postgresConnector);
  connectors.set("mongodb", mongodbConnector);
  connectors.set("redshift", redshiftConnector);

  // --- AWS provisioners: need a region to build a client from the ambient
  // credential chain. Skipped when absent (a non-AWS stack). Provisioners own
  // their readiness predicate (design §7); waitFor only tunes polling. ---
  if (region) {
    provisioners.set(
      "aws.dynamodb",
      new DynamoDBProvisioner({
        client: opts.dynamodbClient ?? createDynamoDBClient(region),
        region,
        ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
      }),
    );
    provisioners.set(
      "aws.rds-postgres",
      createAwsRdsPostgresProvisioner({
        client: opts.rdsClient ?? createRdsClient(region),
        region,
        ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
      }),
    );
    provisioners.set(
      "aws.redshift",
      createRedshiftProvisioner({
        client: opts.redshiftClient ?? createRedshiftClient(region),
        region,
        ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
      }),
    );
  }

  // --- Supabase (non-AWS): the provider's personal access token is a SecretRef
  // POINTER to the ambient env; resolved lazily per request, never logged. ---
  provisioners.set(
    "supabase.postgres",
    createSupabasePostgresProvisioner({
      tokenRef: { from: "env:SUPABASE_ACCESS_TOKEN" },
      ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
    }),
  );

  return { provisioners, connectors };
}

/* ------------------------------------------------------------------ *
 * Programmatic context
 * ------------------------------------------------------------------ */

export interface AppContextOptions {
  /** Working directory for config/state resolution (default: process.cwd()). */
  readonly cwd?: string;
  /** Override the state-file path (default: <cwd>/foundry.state.json). */
  readonly statePath?: string;
  /**
   * Provide the desired stack directly (programmatic / test path). When set,
   * loadStack() is skipped. When omitted, the stack is loaded from
   * `foundry.config.{ts,js}` in `cwd`.
   */
  readonly stack?: Stack;
  readonly region?: string;
  /** Inject a DynamoDBClient (tests / LocalStack). */
  readonly dynamodbClient?: DynamoDBClient;
  /** Inject an RDSClient (tests / LocalStack). */
  readonly rdsClient?: RDSClient;
  /** Inject a RedshiftClient (tests / LocalStack). */
  readonly redshiftClient?: RedshiftClient;
  /** Override the provisioner's poll tuning (tests). */
  readonly waitFor?: BuildPluginsOptions["waitFor"];
  /** Extra/override plugins on top of the defaults. */
  readonly provisioners?: Map<ResourceKind, Provisioner>;
  readonly connectors?: Map<Engine, Connector>;
  readonly logger?: Logger;
}

/**
 * Compose a fully-wired {@link CLIContext}: desired stack + state store + the
 * default provisioner/connector registry. This is the entry point a programmatic
 * consumer (or `db.connect()` path) uses so that `runApply` finds a provisioner
 * for "aws.dynamodb" and the runtime finds a connector for "dynamodb".
 */
export async function createAppContext(
  opts: AppContextOptions = {},
): Promise<CLIContext> {
  const cwd = opts.cwd ?? process.cwd();
  const stack: Stack =
    opts.stack ?? (await loadStack({ cwd }));
  const state = new FileStateStore({
    path: opts.statePath ?? join(cwd, "foundry.state.json"),
  });

  const plugins = buildDefaultPlugins({
    ...(opts.region !== undefined ? { region: opts.region } : {}),
    ...(opts.dynamodbClient !== undefined ? { dynamodbClient: opts.dynamodbClient } : {}),
    ...(opts.rdsClient !== undefined ? { rdsClient: opts.rdsClient } : {}),
    ...(opts.redshiftClient !== undefined ? { redshiftClient: opts.redshiftClient } : {}),
    ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
  });

  // Merge caller-supplied plugins over the defaults (last write wins), so a
  // caller can override e.g. the dynamodb connector while keeping the rest.
  if (opts.provisioners) {
    for (const [kind, p] of opts.provisioners) plugins.provisioners.set(kind, p);
  }
  if (opts.connectors) {
    for (const [engine, c] of opts.connectors) plugins.connectors.set(engine, c);
  }

  // exactOptionalPropertyTypes: include `logger` only when provided.
  const ctx: CLIContext = {
    stack,
    cwd,
    state,
    provisioners: plugins.provisioners,
    connectors: plugins.connectors,
  };
  if (opts.logger !== undefined) {
    return { ...ctx, logger: opts.logger };
  }
  return ctx;
}
