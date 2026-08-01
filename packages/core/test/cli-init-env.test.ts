/**
 * Integration tests for the `foundry init` and `foundry env` CLI commands.
 *
 * `init` runs before context build (no config exists yet); `env` resolves a
 * database's ConnectionTarget + credsRef to DATABASE_URL, loading the local
 * secret store first. Together they close the local-DB loop:
 *
 *   foundry init → foundry apply (local) → foundry env
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, runEnv, type CLIContext } from "../src/cli/index.js";
import { FileStateStore } from "../src/state/index.js";
import { defineStack } from "../src/config/index.js";
import {
  writeEnvFileEntry,
  readEnvFile,
  localEnvFilePath,
} from "../src/env/index.js";
import type { ResourceState } from "../src/contracts.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-cli-initenv-"));
  // runEnv deliberately loads the local secret store into process.env (so the
  // runtime connector can resolve credsRef). Clear the leaked var between tests
  // for isolation.
  delete process.env.FOUNDRY_LOCAL_APP;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FOUNDRY_LOCAL_APP;
});

function silenceConsole() {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
  return () => spies.forEach((s) => s.mockRestore());
}

/* ------------------------------ foundry init ------------------------------ */

describe("foundry init (via main)", () => {
  it("scaffolds a local.postgres project and returns 0", async () => {
    const restore = silenceConsole();
    const code = await main(["node", "foundry", "init"], { cwd: tmp });
    restore();

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "foundry.config.ts"))).toBe(true);
    expect(existsSync(join(tmp, "migrations", "app", "000001_init.up.sql"))).toBe(true);
  });

  it("refuses to clobber an existing config (exit 2)", async () => {
    // First init succeeds.
    let restore = silenceConsole();
    await main(["node", "foundry", "init"], { cwd: tmp });
    restore();
    // Second init without --force fails fast.
    restore = silenceConsole();
    const code = await main(["node", "foundry", "init"], { cwd: tmp });
    restore();
    expect(code).toBe(2);
  });

  it("honors --db-id, --kind, and a positional stack name", async () => {
    const restore = silenceConsole();
    const code = await main(
      ["node", "foundry", "init", "mydemo", "--db-id", "store", "--kind", "aws.rds-postgres"],
      { cwd: tmp },
    );
    restore();
    expect(code).toBe(0);
    const cfg = await readFile(join(tmp, "foundry.config.ts"), "utf8");
    expect(cfg).toContain("mydemo");
    expect(cfg).toContain("store");
    expect(cfg).toContain("aws.rds-postgres");
    expect(existsSync(join(tmp, "migrations", "store", "000001_init.up.sql"))).toBe(true);
  });
});

/* ------------------------------ foundry env ------------------------------ */

/** Build a CLIContext with a local.postgres resource already in state. */
async function ctxWithLocalDb(cwd: string): Promise<CLIContext> {
  const stack = defineStack({
    databases: {
      app: { engine: "postgres", provision: { kind: "local.postgres" } },
    },
  });
  const state = new FileStateStore({ path: join(cwd, "foundry.state.json") });
  const resource: ResourceState = {
    id: "app",
    kind: "local.postgres",
    identifiers: { containerName: "foundry-app" },
    status: "available",
    connection: {
      engine: "postgres",
      endpoint: "localhost:5432",
      credsRef: { from: "env:FOUNDRY_LOCAL_APP" },
    },
    outputs: {
      containerName: "foundry-app",
      image: "pgvector/pgvector:pg16",
      port: 5432,
      dbName: "app",
      username: "postgres",
      persistent: true,
    },
  };
  await state.put(resource);
  return {
    cwd,
    stack,
    state,
    provisioners: new Map(),
    connectors: new Map(),
  };
}

describe("foundry env (runEnv)", () => {
  it("resolves DATABASE_URL from the local secret store", async () => {
    await writeEnvFileEntry(localEnvFilePath(tmp), "FOUNDRY_LOCAL_APP", "postgres://u:p@localhost:5432/app");
    const ctx = await ctxWithLocalDb(tmp);
    const result = await runEnv(ctx, "app");
    expect(result.url).toBe("postgres://u:p@localhost:5432/app");
    expect(result.line).toBe("DATABASE_URL=postgres://u:p@localhost:5432/app");
    expect(result.writtenTo).toBeUndefined();
  });

  it("writes the value to .env.foundry with --write", async () => {
    await writeEnvFileEntry(localEnvFilePath(tmp), "FOUNDRY_LOCAL_APP", "postgres://u:p@localhost:5432/app");
    const ctx = await ctxWithLocalDb(tmp);
    const result = await runEnv(ctx, "app", { write: true });
    expect(result.writtenTo).toBe(join(tmp, ".env.foundry"));
    const written = await readEnvFile(join(tmp, ".env.foundry"));
    expect(written.DATABASE_URL).toBe("postgres://u:p@localhost:5432/app");
  });

  it("honors a custom --var name", async () => {
    await writeEnvFileEntry(localEnvFilePath(tmp), "FOUNDRY_LOCAL_APP", "postgres://u:p@localhost:5432/app");
    const ctx = await ctxWithLocalDb(tmp);
    const result = await runEnv(ctx, "app", { varName: "DB_URL" });
    expect(result.line).toBe("DB_URL=postgres://u:p@localhost:5432/app");
  });

  it("fails clearly when the local secret store is missing (apply not run)", async () => {
    const ctx = await ctxWithLocalDb(tmp);
    await expect(runEnv(ctx, "app")).rejects.toThrow(/FOUNDRY_LOCAL_APP/);
  });
});

describe("foundry env (via main, end to end)", () => {
  it("prints DATABASE_URL after writing a config + state + local secret store", async () => {
    // 1. init writes the config.
    let restore = silenceConsole();
    await main(["node", "foundry", "init"], { cwd: tmp });
    restore();

    // 2. Simulate `foundry apply` having provisioned the DB: write state + the
    //    local secret store entry.
    const ctx = await ctxWithLocalDb(tmp);
    await writeEnvFileEntry(localEnvFilePath(tmp), "FOUNDRY_LOCAL_APP", "postgres://postgres:pw@localhost:5432/app");

    // 3. Capture main's stdout for the DATABASE_URL line.
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      seen.push(args.join(" "));
    });
    const code = await main(["node", "foundry", "env", "app"], { cwd: tmp });
    spy.mockRestore();

    expect(code).toBe(0);
    expect(seen.join("\n")).toContain("DATABASE_URL=postgres://postgres:pw@localhost:5432/app");
  });
});
