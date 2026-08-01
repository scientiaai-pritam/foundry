/**
 * Tests for env / connection-string resolution (the `foundry env` engine).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseEnvFile,
  formatEnvFile,
  quoteEnvValue,
  readEnvFile,
  writeEnvFileEntry,
  removeEnvFileEntry,
  loadEnvFileIntoProcess,
  loadLocalEnvIntoProcess,
  localEnvFilePath,
  resolveConnectionString,
  resolvePostgresConnection,
  formatConnectionVars,
  writeEnvFileEntries,
  EnvResolutionError,
} from "../src/env/index.js";
import type { ConnectionTarget } from "../src/contracts.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-env-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe(".env primitives", () => {
  it("parse/format round-trips with quoting + sorting", () => {
    const text = formatEnvFile({ B: "2", A: "1", C: "x y" });
    expect(text).toBe('A=1\nB=2\nC="x y"\n');
    expect(parseEnvFile(text)).toEqual({ A: "1", B: "2", C: "x y" });
  });

  it("does not quote a plain postgres:// string", () => {
    const url = "postgres://u:p@localhost:5432/app";
    expect(quoteEnvValue(url)).toBe(url);
  });

  it("readEnvFile returns {} when absent", async () => {
    expect(await readEnvFile(join(tmp, "nope.env"))).toEqual({});
  });

  it("writeEnvFileEntry upserts without clobbering other keys", async () => {
    const p = join(tmp, "local.env");
    await writeEnvFileEntry(p, "A", "1");
    await writeEnvFileEntry(p, "B", "2");
    await writeEnvFileEntry(p, "A", "1-updated");
    expect(await readEnvFile(p)).toEqual({ A: "1-updated", B: "2" });
  });

  it("removeEnvFileEntry removes a key and no-ops when absent", async () => {
    const p = join(tmp, "local.env");
    await writeEnvFileEntry(p, "A", "1");
    await removeEnvFileEntry(p, "A");
    expect(await readEnvFile(p)).toEqual({});
    // No-op on a missing file/key.
    await expect(removeEnvFileEntry(p, "A")).resolves.toBeUndefined();
  });
});

describe("loadEnvFileIntoProcess / loadLocalEnvIntoProcess", () => {
  it("loads values without overriding already-set vars", async () => {
    const p = join(tmp, "local.env");
    await writeEnvFileEntry(p, "FOO", "from-file");
    await writeEnvFileEntry(p, "BAR", "from-file");
    const target: Record<string, string | undefined> = { FOO: "from-env" };
    const n = await loadEnvFileIntoProcess(p, target);
    expect(n).toBe(1); // only BAR was newly set
    expect(target.FOO).toBe("from-env"); // NOT overridden
    expect(target.BAR).toBe("from-file");
  });

  it("loadLocalEnvIntoProcess reads <cwd>/.foundry/local.env", async () => {
    await writeEnvFileEntry(localEnvFilePath(tmp), "FOUNDRY_LOCAL_APP", "postgres://x");
    const target: Record<string, string | undefined> = {};
    await loadLocalEnvIntoProcess(tmp, target);
    // overload: loadLocalEnvIntoProcess(cwd) targets process.env by default;
    // call the underlying loader with an explicit cwd-backed path instead.
    const n = await loadEnvFileIntoProcess(localEnvFilePath(tmp), target);
    expect(n).toBe(1);
    expect(target.FOUNDRY_LOCAL_APP).toBe("postgres://x");
  });
});

describe("resolveConnectionString", () => {
  const pgTarget = (credsRef: ConnectionTarget["credsRef"]): ConnectionTarget => ({
    engine: "postgres",
    endpoint: "localhost:5432",
    ...(credsRef !== undefined ? { credsRef } : {}),
  });

  beforeEach(() => {
    // Ensure a clean slate for the env-var based cases.
    delete process.env.FOUNDRY_TEST_PG;
    delete process.env.FOUNDRY_TEST_PG_JSON;
  });

  it("returns a postgres:// env value verbatim", async () => {
    process.env.FOUNDRY_TEST_PG = "postgres://u:p@localhost:5432/app";
    const url = await resolveConnectionString(
      pgTarget({ from: "env:FOUNDRY_TEST_PG" }),
    );
    expect(url).toBe("postgres://u:p@localhost:5432/app");
  });

  it("assembles a URL from a connection-JSON env value", async () => {
    process.env.FOUNDRY_TEST_PG_JSON = JSON.stringify({
      host: "db.example",
      port: 5432,
      user: "u",
      password: "p",
      database: "app",
    });
    const url = await resolveConnectionString(
      pgTarget({ from: "env:FOUNDRY_TEST_PG_JSON" }),
    );
    expect(url).toBe("postgres://u:p@db.example:5432/app");
  });

  it("resolves a { secretId } ref via the injected resolver (JSON → URL-encoded)", async () => {
    const url = await resolveConnectionString(
      pgTarget({ secretId: "prod/db" }),
      {
        secretResolver: async () =>
          JSON.stringify({ host: "h", port: 5432, user: "from", password: "prod/db", database: "d" }),
      },
    );
    expect(url).toBe("postgres://from:prod%2Fdb@h:5432/d");
  });

  it("errors on an unset env var with an actionable hint", async () => {
    await expect(
      resolveConnectionString(pgTarget({ from: "env:FOUNDRY_TEST_PG" })),
    ).rejects.toBeInstanceOf(EnvResolutionError);
  });

  it("errors on a { secretId } ref with no resolver injected", async () => {
    await expect(
      resolveConnectionString(pgTarget({ secretId: "prod/db" })),
    ).rejects.toBeInstanceOf(EnvResolutionError);
  });

  it("errors for a non-postgres engine (DATABASE_URL is a postgres concept)", async () => {
    await expect(
      resolveConnectionString({ engine: "dynamodb", region: "us-east-1" }),
    ).rejects.toBeInstanceOf(EnvResolutionError);
  });

  it("errors when postgres has no credsRef", async () => {
    await expect(resolveConnectionString(pgTarget(undefined))).rejects.toBeInstanceOf(
      EnvResolutionError,
    );
  });

  it("errors on a malformed JSON secret (never fed to a URL parser)", async () => {
    process.env.FOUNDRY_TEST_PG = JSON.stringify({ host: "h" }); // missing fields
    await expect(
      resolveConnectionString(pgTarget({ from: "env:FOUNDRY_TEST_PG" })),
    ).rejects.toBeInstanceOf(EnvResolutionError);
  });
});

describe("resolvePostgresConnection", () => {
  beforeEach(() => {
    delete process.env.FOUNDRY_TEST_PG;
  });
  it("parses a postgres:// URL into PG* parts", async () => {
    process.env.FOUNDRY_TEST_PG = "postgres://u:p%2Fq@db.example:5532/appdb";
    const parts = await resolvePostgresConnection({
      engine: "postgres",
      endpoint: "db.example:5532",
      credsRef: { from: "env:FOUNDRY_TEST_PG" },
    });
    expect(parts.url).toBe("postgres://u:p%2Fq@db.example:5532/appdb");
    expect(parts.host).toBe("db.example");
    expect(parts.port).toBe(5532);
    expect(parts.user).toBe("u");
    expect(parts.password).toBe("p/q");
    expect(parts.database).toBe("appdb");
  });
});

describe("formatConnectionVars", () => {
  const vars = { DATABASE_URL: "postgres://u:p@h:5432/d", PGHOST: "h", PGPORT: "5432" };
  it("dotenv: KEY=value lines", () => {
    expect(formatConnectionVars(vars, "dotenv")).toBe(
      "DATABASE_URL=postgres://u:p@h:5432/d\nPGHOST=h\nPGPORT=5432",
    );
  });
  it("shell: export KEY=value lines", () => {
    expect(formatConnectionVars(vars, "shell")).toBe(
      "export DATABASE_URL=postgres://u:p@h:5432/d\nexport PGHOST=h\nexport PGPORT=5432",
    );
  });
  it("json: a JSON object", () => {
    expect(JSON.parse(formatConnectionVars(vars, "json"))).toEqual(vars);
  });
});

describe("writeEnvFileEntries", () => {
  it("upserts multiple keys without clobbering others", async () => {
    const p = join(tmp, "local.env");
    await writeEnvFileEntries(p, { A: "1", B: "2" });
    await writeEnvFileEntries(p, { B: "2-updated", C: "3" });
    expect(await readEnvFile(p)).toEqual({ A: "1", B: "2-updated", C: "3" });
  });
});
