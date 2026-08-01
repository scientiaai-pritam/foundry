/**
 * Tests for `foundry init` scaffolding (config + first migration + .gitignore).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scaffoldInit,
  renderConfigTemplate,
  ConfigAlreadyExistsError,
  InitError,
  INIT_KINDS,
} from "../src/init/index.js";
import { loadMigrations } from "../src/migrations/index.js";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-init-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderConfigTemplate", () => {
  it("renders a local.postgres config by default with pgvector hints", () => {
    const cfg = renderConfigTemplate({ dbId: "app", kind: "local.postgres" });
    expect(cfg).toContain('import { defineStack } from "@foundry/core"');
    expect(cfg).toContain('kind: "local.postgres"');
    expect(cfg).toContain("pgvector");
  });

  it("includes a stack name when provided", () => {
    const cfg = renderConfigTemplate({ dbId: "app", kind: "local.postgres", stackName: "demo" });
    expect(cfg).toContain('name: "demo"');
  });
});

describe("scaffoldInit (default local.postgres)", () => {
  it("writes foundry.config.ts, a first migration, and .gitignore entries", async () => {
    const result = await scaffoldInit({ cwd: tmp });

    expect(existsSync(join(tmp, "foundry.config.ts"))).toBe(true);
    expect(result.kind).toBe("local.postgres");
    expect(result.dbId).toBe("app");

    // First migration present and round-trips through the loader.
    expect(result.upPath).toBeDefined();
    expect(existsSync(result.upPath!)).toBe(true);
    const loaded = await loadMigrations(join(tmp, "migrations", "app"));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("000001");
    expect(loaded[0]!.description).toBe("init");
    // pgvector-aware first migration.
    expect(loaded[0]!.up).toContain("CREATE EXTENSION IF NOT EXISTS vector");

    // .gitignore gained the local secret store + state + env entries.
    const gi = await readFile(join(tmp, ".gitignore"), "utf8");
    expect(gi).toMatch(/\.foundry\//);
    expect(gi).toMatch(/\*\.state\.json/);
    expect(gi).toMatch(/\.env\.foundry/);
  });

  it("refuses to overwrite an existing config without --force", async () => {
    await scaffoldInit({ cwd: tmp });
    await expect(scaffoldInit({ cwd: tmp })).rejects.toBeInstanceOf(ConfigAlreadyExistsError);
  });

  it("overwrites an existing config with --force", async () => {
    await scaffoldInit({ cwd: tmp });
    await expect(scaffoldInit({ cwd: tmp, force: true })).resolves.toBeDefined();
  });

  it("is idempotent on .gitignore (running twice does not duplicate entries)", async () => {
    await scaffoldInit({ cwd: tmp });
    await scaffoldInit({ cwd: tmp, force: true });
    const gi = await readFile(join(tmp, ".gitignore"), "utf8");
    expect(gi.match(/\.foundry\//g)).toHaveLength(1);
  });
});

describe("scaffoldInit (other kinds)", () => {
  it("scaffolds aws.rds-postgres with a SQL first migration", async () => {
    const result = await scaffoldInit({ cwd: tmp, kind: "aws.rds-postgres" });
    const cfg = await readFile(join(tmp, "foundry.config.ts"), "utf8");
    expect(cfg).toContain('kind: "aws.rds-postgres"');
    expect(result.upPath).toBeDefined();
  });

  it("scaffolds aws.dynamodb with NO first migration (not a SQL-migrated engine)", async () => {
    const result = await scaffoldInit({ cwd: tmp, kind: "aws.dynamodb", dbId: "sessions" });
    expect(result.upPath).toBeUndefined();
    expect(result.downPath).toBeUndefined();
    const cfg = await readFile(join(tmp, "foundry.config.ts"), "utf8");
    expect(cfg).toContain('kind: "aws.dynamodb"');
    expect(cfg).toContain("sessions");
  });
});

describe("scaffoldInit validation", () => {
  it("rejects an invalid db id", async () => {
    await expect(scaffoldInit({ cwd: tmp, dbId: "1bad" })).rejects.toBeInstanceOf(InitError);
    await expect(scaffoldInit({ cwd: tmp, dbId: "has space" })).rejects.toBeInstanceOf(InitError);
  });

  it("rejects an unsupported kind", async () => {
    await expect(
      scaffoldInit({ cwd: tmp, kind: "nope" as unknown as (typeof INIT_KINDS)[number] }),
    ).rejects.toBeInstanceOf(InitError);
  });
});
