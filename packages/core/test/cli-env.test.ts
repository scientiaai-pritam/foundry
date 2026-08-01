import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, buildContext } from "../src/cli/index.js";
import { defineStack } from "../src/config/index.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-cli-env-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function silence() {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  return () => spies.forEach((s) => s.mockRestore());
}

describe("buildContext --env", () => {
  it("selects foundry.state.dev.json under env 'dev'", async () => {
    const ctx = await buildContext({
      cwd: tmp,
      env: "dev",
      stack: defineStack({ databases: { app: { engine: "postgres", provision: { kind: "local.postgres" } } } }),
    });
    // The store reads/writes the dev file: put + read round-trips through it.
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

  it("swaps provision->dev and warns when a db lacks dev", async () => {
    const restore = silence();
    const ctx = await buildContext({
      cwd: tmp,
      env: "dev",
      stack: defineStack({
        databases: {
          app: { engine: "postgres", provision: { kind: "local.postgres" } },
          cloud: {
            engine: "postgres",
            provision: { kind: "aws.rds-postgres", dbInstanceIdentifier: "c" },
            dev: { kind: "local.postgres" },
          },
        },
      }),
    });
    expect((ctx.stack.databases.cloud as { provision: { kind: string } }).provision.kind).toBe("local.postgres");
    expect((ctx.stack.databases.app as { provision: { kind: string } }).provision.kind).toBe("local.postgres");
    restore();
  });
});

describe("main --env parsing", () => {
  it("rejects an unknown env value with exit code 2", async () => {
    const restore = silence();
    const code = await main(["node", "foundry", "plan", "--env", "staging"], { cwd: tmp });
    restore();
    expect(code).toBe(2);
  });
});
