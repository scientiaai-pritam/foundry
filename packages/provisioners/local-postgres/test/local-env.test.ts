import { describe, it, expect } from "vitest";
import {
  parseEnvFile,
  formatEnvFile,
  credEnvVar,
  dbIdSuffix,
  buildPostgresUrl,
} from "../src/local-env.js";

describe("parseEnvFile / formatEnvFile", () => {
  it("parses KEY=value lines, ignoring blanks and comments", () => {
    expect(
      parseEnvFile("# header\nFOO=bar\n\nBAZ=qux\n"),
    ).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching quotes", () => {
    expect(parseEnvFile('A="1 2"\nB=\'3\'\n')).toEqual({ A: "1 2", B: "3" });
  });

  it("round-trips through formatEnvFile (sorted, stable)", () => {
    const text = formatEnvFile({ B: "2", A: "1", C: "x y" });
    expect(text).toBe('A=1\nB=2\nC="x y"\n');
    // Re-parse to confirm a faithful round-trip.
    expect(parseEnvFile(text)).toEqual({ A: "1", B: "2", C: "x y" });
  });

  it("does not quote a plain postgres:// string", () => {
    const url = "postgres://u:p@localhost:5432/app";
    expect(formatEnvFile({ DB: url })).toBe(`DB=${url}\n`);
  });
});

describe("credEnvVar / dbIdSuffix", () => {
  it("derives a stable, env-safe var name from a db id", () => {
    expect(credEnvVar("app")).toBe("FOUNDRY_LOCAL_APP");
    expect(credEnvVar("analytics-db")).toBe("FOUNDRY_LOCAL_ANALYTICS_DB");
    expect(credEnvVar("db_2")).toBe("FOUNDRY_LOCAL_DB_2");
    expect(dbIdSuffix("Analytics DB!")).toBe("ANALYTICS_DB");
  });
});

describe("buildPostgresUrl", () => {
  it("URL-encodes user/password/db", () => {
    const url = buildPostgresUrl({
      user: "u@1",
      password: "p@:ss",
      host: "localhost",
      port: 5432,
      database: "my db",
    });
    expect(url).toBe("postgres://u%401:p%40%3Ass@localhost:5432/my%20db");
  });
});
