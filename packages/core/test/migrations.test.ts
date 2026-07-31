import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, checksumMigration, resolveMigrationDir } from "../src/index.js";

describe("migrations loader", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "foundry-mig-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads paired up/down files ordered by numeric id", async () => {
    await writeFile(join(dir, "000002_b.up.sql"), "B;");
    await writeFile(join(dir, "000002_b.down.sql"), "B-down;");
    await writeFile(join(dir, "000001_a.up.sql"), "A;");
    const m = await loadMigrations(dir);
    expect(m.map((x) => x.id)).toEqual(["000001", "000002"]);
    expect(m[0]!.description).toBe("a");
    expect(m[0]!.up).toBe("A;");
    expect(m[0]!.down).toBeUndefined();
    expect(m[1]!.down).toBe("B-down;");
  });

  it("canonicalizes a 1-digit id to 6 digits", async () => {
    await writeFile(join(dir, "1_first.up.sql"), "x;");
    const m = await loadMigrations(dir);
    expect(m[0]!.id).toBe("000001");
  });

  it("errors on a duplicate canonical id", async () => {
    await writeFile(join(dir, "1_a.up.sql"), "a;");
    await writeFile(join(dir, "001_b.up.sql"), "b;");
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration id "000001"/);
  });

  it("errors on a malformed .up.sql filename", async () => {
    await writeFile(join(dir, "create_users.up.sql"), "x;");
    await expect(loadMigrations(dir)).rejects.toThrow(/Invalid migration filename/);
  });

  it("ignores non-migration files", async () => {
    await writeFile(join(dir, "README.md"), "# hi");
    await writeFile(join(dir, "000001_a.up.sql"), "a;");
    const m = await loadMigrations(dir);
    expect(m).toHaveLength(1);
  });

  it("errors when the directory does not exist", async () => {
    await expect(loadMigrations(join(dir, "missing"))).rejects.toThrow();
  });
});

describe("checksumMigration", () => {
  it("is a deterministic 64-char hex", () => {
    const cs = checksumMigration("CREATE TABLE x ();");
    expect(cs).toHaveLength(64);
    expect(cs).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumMigration("a")).not.toBe(checksumMigration("b"));
    expect(checksumMigration("a")).toBe(checksumMigration("a"));
  });
});

describe("resolveMigrationDir", () => {
  it("defaults to migrations/<dbId>", () => {
    expect(resolveMigrationDir("/cwd", "analytics")).toBe(join("/cwd", "migrations", "analytics"));
  });
  it("uses cfg.dir when provided", () => {
    expect(resolveMigrationDir("/cwd", "analytics", { dir: "db/analytics" })).toBe(join("/cwd", "db", "analytics"));
  });
});
