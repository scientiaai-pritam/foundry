import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppContext } from "../src/context.js";
import { defineStack } from "@foundry/core";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-app-env-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createAppContext --env", () => {
  it("writes dev state to foundry.state.dev.json", async () => {
    const ctx = await createAppContext({
      cwd: tmp,
      env: "dev",
      stack: defineStack({ databases: { app: { engine: "postgres", provision: { kind: "local.postgres" } } } }),
    });
    await ctx.state.put({
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

  it("swaps provision->dev for a database with a dev block", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = await createAppContext({
      cwd: tmp,
      env: "dev",
      stack: defineStack({
        databases: {
          app: {
            engine: "postgres",
            provision: { kind: "aws.rds-postgres", dbInstanceIdentifier: "a" },
            dev: { kind: "local.postgres" },
          },
        },
      }),
    });
    expect((ctx.stack.databases.app as { provision: { kind: string } }).provision.kind).toBe("local.postgres");
    warn.mockRestore();
  });
});
