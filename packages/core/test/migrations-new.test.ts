import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugify,
  nextMigrationId,
  createMigration,
  loadMigrations,
} from "../src/index.js";

describe("slugify", () => {
  it("lowercases and joins words with underscores", () => {
    expect(slugify("Create users")).toBe("create_users");
  });

  it("collapses non-alphanumeric runs to a single underscore", () => {
    expect(slugify("add-email-index!")).toBe("add_email_index");
  });

  it("keeps digits", () => {
    expect(slugify("1st migration")).toBe("1st_migration");
  });

  it("trims and de-duplicates leading/trailing underscores", () => {
    expect(slugify("  __weird__  ")).toBe("weird");
  });

  it("throws when the result is empty", () => {
    expect(() => slugify("!!!")).toThrow(/slug/);
  });
});

describe("nextMigrationId", () => {
  it("starts at 000001 with no existing migrations", () => {
    expect(nextMigrationId([])).toBe("000001");
  });

  it("is one greater than the highest existing id", () => {
    expect(nextMigrationId([{ id: "000001" }, { id: "000002" }])).toBe("000003");
  });

  it("handles non-contiguous ids", () => {
    expect(nextMigrationId([{ id: "000010" }])).toBe("000011");
  });

  it("throws when the next id would exceed 6 digits", () => {
    expect(() => nextMigrationId([{ id: "999999" }])).toThrow(/exceed/);
  });
});

describe("createMigration", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "foundry-mignew-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a paired up/down set at the next id", async () => {
    const created = await createMigration(dir, "create users", []);
    expect(created.id).toBe("000001");
    expect(created.slug).toBe("create_users");
    expect(created.upPath.endsWith("000001_create_users.up.sql")).toBe(true);
    expect(created.downPath.endsWith("000001_create_users.down.sql")).toBe(true);

    const loaded = await loadMigrations(dir);
    expect(loaded.map((m) => m.id)).toEqual(["000001"]);
    expect(loaded[0]!.description).toBe("create_users");
  });

  it("continues numbering from the highest existing id", async () => {
    await writeFile(join(dir, "000005_x.up.sql"), "x;");
    const created = await createMigration(dir, "y", await loadMigrations(dir));
    expect(created.id).toBe("000006");
    expect(created.slug).toBe("y");
  });

  it("creates the directory if it does not exist", async () => {
    const nested = join(dir, "nested", "deeper");
    const created = await createMigration(nested, "init", []);
    expect(created.id).toBe("000001");

    const loaded = await loadMigrations(nested);
    expect(loaded).toHaveLength(1);
  });
});
