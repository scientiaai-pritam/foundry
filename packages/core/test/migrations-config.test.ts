import { describe, it, expect } from "vitest";
import { validateStack, ConfigError } from "../src/index.js";

describe("migrations config validation", () => {
  it("accepts a database without migrations", () => {
    expect(() =>
      validateStack({ databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" } } } }),
    ).not.toThrow();
  });

  it("accepts enabled:false", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { enabled: false } } },
      }),
    ).not.toThrow();
  });

  it("accepts a custom dir", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { dir: "db/a" } } },
      }),
    ).not.toThrow();
  });

  it("accepts migrations on an external database", () => {
    expect(() =>
      validateStack({
        databases: {
          a: { engine: "postgres", provision: "external", connectionString: { from: "env:PG" }, migrations: { enabled: true } },
        },
      }),
    ).not.toThrow();
  });

  it("rejects migrations as a non-object", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: "nope" } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects enabled as non-boolean", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { enabled: "yes" } } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects dir as an empty string", () => {
    expect(() =>
      validateStack({
        databases: { a: { engine: "postgres", provision: { kind: "aws.rds-postgres" }, migrations: { dir: "" } } },
      }),
    ).toThrow(ConfigError);
  });
});
