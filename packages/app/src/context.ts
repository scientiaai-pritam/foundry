/**
 * @scientia/app — Composition root for scientia-db (design v1, §4 "Module
 * layout", §5 "Key boundary").
 *
 * The core kernel (`@scientia/core`) NEVER imports a concrete provisioner or
 * connector — it only knows the two contract shapes and consumes them via the
 * `provisioners` / `connectors` maps on `CLIContext`. Nothing registered
 * `DynamoDBProvisioner` (kind "aws.dynamodb") or the dynamodb connector
 * (engine "dynamodb") into the CLI, so `scientia apply` (→ MissingProvisioner)
 * and `db.connect()` (→ "No connector registered for engine") failed out of
 * the box.
 *
 * This package is that missing wiring. It is the ONE place that knows about
 * concrete plugins and glues them into the kernel's context defaults. Both the
 * `scientia` CLI binary (src/cli.ts) and programmatic callers (createAppContext)
 * get their plugins from the same single source of truth: {@link buildDefaultPlugins}.
 */
import { join } from "node:path";

import type {
  Connector,
  Logger,
  Provisioner,
  ResourceKind,
} from "@scientia/core";
import {
  FileStateStore,
  loadStack,
  resolveAwsRegion,
} from "@scientia/core";
import type { CLIContext } from "@scientia/core";
import type { Engine, Stack } from "@scientia/core";

import { DynamoDBProvisioner } from "@scientia/aws-dynamodb";
import { createDynamoDBClient } from "@scientia/aws-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { dynamodbConnector } from "@scientia/connector-dynamodb";

/* ------------------------------------------------------------------ *
 * Plugin registry — the composition root
 * ------------------------------------------------------------------ */

export interface BuildPluginsOptions {
  /**
   * AWS region. Falls back to the ambient credential-chain region
   * (AWS_REGION / AWS_DEFAULT_REGION) via resolveAwsRegion. Required to
   * construct the DynamoDB client and to surface on the ConnectionTarget.
   */
  readonly region?: string;
  /**
   * Inject a DynamoDBClient (e.g. a LocalStack endpoint, or a test stub).
   * Defaults to a real client built from `region` using the ambient AWS
   * credential chain. aws-sdk-client-mock patches the prototype, so tests can
   * omit this and mock globally.
   */
  readonly dynamodbClient?: DynamoDBClient;
  /**
   * Override the provisioner's poll tuning (mostly for tests; default is a
   * 5-min ceiling so it works for slow engines too).
   */
  readonly waitFor?: ConstructorParameters<typeof DynamoDBProvisioner>[0]["waitFor"];
}

export interface Plugins {
  readonly provisioners: Map<ResourceKind, Provisioner>;
  readonly connectors: Map<Engine, Connector>;
}

/**
 * Build the default plugin registry: a DynamoDBProvisioner for kind
 * "aws.dynamodb" and the dynamodb connector for engine "dynamodb". This is the
 * single composition point — both the CLI binary and {@link createAppContext}
 * source their plugins here, so adding a new engine later means adding one line
 * here (and its package), not touching the core.
 */
export function buildDefaultPlugins(opts: BuildPluginsOptions = {}): Plugins {
  const region = resolveAwsRegion(opts.region);
  if (!region) {
    throw new Error(
      "scientia: AWS region not configured. Set AWS_REGION / AWS_DEFAULT_REGION or pass { region }.",
    );
  }

  const provisioners = new Map<ResourceKind, Provisioner>();
  const client = opts.dynamodbClient ?? createDynamoDBClient(region);
  provisioners.set(
    "aws.dynamodb",
    new DynamoDBProvisioner({
      client,
      region,
      // Provisioners own their readiness predicate (design §7); the wait options
      // only tune polling. Default to a generous ceiling; tests pass a fast one.
      ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
    }),
  );

  const connectors = new Map<Engine, Connector>();
  connectors.set("dynamodb", dynamodbConnector);

  return { provisioners, connectors };
}

/* ------------------------------------------------------------------ *
 * Programmatic context
 * ------------------------------------------------------------------ */

export interface AppContextOptions {
  /** Working directory for config/state resolution (default: process.cwd()). */
  readonly cwd?: string;
  /** Override the state-file path (default: <cwd>/scientia.state.json). */
  readonly statePath?: string;
  /**
   * Provide the desired stack directly (programmatic / test path). When set,
   * loadStack() is skipped. When omitted, the stack is loaded from
   * `scientia.config.{ts,js}` in `cwd`.
   */
  readonly stack?: Stack;
  readonly region?: string;
  /** Inject a DynamoDBClient (tests / LocalStack). */
  readonly dynamodbClient?: DynamoDBClient;
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
    path: opts.statePath ?? join(cwd, "scientia.state.json"),
  });

  const plugins = buildDefaultPlugins({
    ...(opts.region !== undefined ? { region: opts.region } : {}),
    ...(opts.dynamodbClient !== undefined ? { dynamodbClient: opts.dynamodbClient } : {}),
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
    state,
    provisioners: plugins.provisioners,
    connectors: plugins.connectors,
  };
  if (opts.logger !== undefined) {
    return { ...ctx, logger: opts.logger };
  }
  return ctx;
}
