/**
 * Safety: development and production state must be isolated. A `--env dev`
 * session reads/writes foundry.state.dev.json and cannot reach a resource
 * recorded in foundry.state.json.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppContext } from "../src/context.js";
import { defineStack } from "@foundry/core";
import type { ResourceState } from "@foundry/core";

let tmp = "";
const prodResource: ResourceState = {
  id: "app",
  kind: "aws.rds-postgres",
  identifiers: { dbInstanceIdentifier: "prod-app" },
  status: "available",
  connection: { engine: "postgres", endpoint: "prod-db.example:5432", credsRef: { secretId: "prod/db" } },
  outputs: {},
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-iso-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A prod state file body seeding a cloud resource (version 1 = STATE_VERSION). */
function prodStateFile(): string {
  return JSON.stringify({ version: 1, resources: { app: prodResource } });
}

describe("dev/prod state isolation", () => {
  it("a dev session cannot see a resource tracked in prod state", async () => {
    // Prod state file holds a cloud resource.
    writeFileSync(join(tmp, "foundry.state.json"), prodStateFile());

    const devCtx = await createAppContext({
      cwd: tmp,
      env: "dev",
      stack: defineStack({
        databases: {
          app: {
            engine: "postgres",
            provision: { kind: "aws.rds-postgres", dbInstanceIdentifier: "app" },
            dev: { kind: "local.postgres" },
          },
        },
      }),
    });
    // StateStore.get returns null when absent — the dev session reads only
    // foundry.state.dev.json, so the prod resource is invisible to it.
    expect(await devCtx.state.get("app")).toBeNull();
  });

  it("a dev session writes only foundry.state.dev.json", async () => {
    const devCtx = await createAppContext({
      cwd: tmp,
      env: "dev",
      stack: defineStack({ databases: { app: { engine: "postgres", provision: { kind: "local.postgres" } } } }),
    });
    await devCtx.state.put({
      id: "app",
      kind: "local.postgres",
      identifiers: { containerName: "foundry-app" },
      status: "available",
      connection: { engine: "postgres", endpoint: "localhost:5432", credsRef: { from: "env:FOUNDRY_LOCAL_APP" } },
      outputs: { containerName: "foundry-app", image: "pgvector/pgvector:pg16", port: 5432, dbName: "app", username: "postgres", persistent: true },
    });
    expect(existsSync(join(tmp, "foundry.state.dev.json"))).toBe(true);
    expect(existsSync(join(tmp, "foundry.state.json"))).toBe(false);
  });

  it("a prod (no-env) session sees the prod resource", async () => {
    writeFileSync(join(tmp, "foundry.state.json"), prodStateFile());
    const prodCtx = await createAppContext({
      cwd: tmp,
      stack: defineStack({
        databases: { app: { engine: "postgres", provision: { kind: "aws.rds-postgres", dbInstanceIdentifier: "app" } } },
      }),
    });
    expect(await prodCtx.state.get("app")).toBeDefined();
  });
});
