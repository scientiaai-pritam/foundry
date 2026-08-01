import { describe, it, expect } from "vitest";
import { defineStack, resolveStackForEnv, ConfigError } from "../src/config/index.js";

const cloudPg = {
  engine: "postgres" as const,
  provision: { kind: "aws.rds-postgres" as const, dbInstanceIdentifier: "app" },
  dev: { kind: "local.postgres" as const },
};

describe("resolveStackForEnv", () => {
  it("returns the stack unchanged when env is undefined", () => {
    const stack = defineStack({ databases: { app: cloudPg } });
    const { stack: resolved, fallbacks } = resolveStackForEnv(stack);
    expect(resolved).toBe(stack);
    expect(fallbacks).toEqual([]);
  });

  it("swaps provision -> dev for env 'dev'", () => {
    const stack = defineStack({ databases: { app: cloudPg } });
    const { stack: resolved, fallbacks } = resolveStackForEnv(stack, "dev");
    expect((resolved.databases.app as { provision: { kind: string } }).provision.kind).toBe("local.postgres");
    expect(fallbacks).toEqual([]);
  });

  it("falls back to provision (with a warning id) when dev is absent", () => {
    const stack = defineStack({
      databases: { app: { engine: "postgres", provision: { kind: "local.postgres" } } },
    });
    const { stack: resolved, fallbacks } = resolveStackForEnv(stack, "dev");
    expect((resolved.databases.app as { provision: { kind: string } }).provision.kind).toBe("local.postgres");
    expect(fallbacks).toEqual(["app"]);
  });

  it("passes external databases through unchanged and does not list them as fallbacks", () => {
    const stack = defineStack({
      databases: {
        ext: { engine: "postgres", provision: "external", connectionString: { from: "env:EXT_URL" } },
      },
    });
    const { stack: resolved, fallbacks } = resolveStackForEnv(stack, "dev");
    expect((resolved.databases.ext as { provision: string }).provision).toBe("external");
    expect(fallbacks).toEqual([]);
  });
});

describe("dev validation (defineStack)", () => {
  it("rejects a dev block whose kind engine mismatches the database engine", () => {
    expect(() =>
      defineStack({
        databases: {
          app: {
            engine: "postgres",
            provision: { kind: "aws.rds-postgres", dbInstanceIdentifier: "app" },
            dev: { kind: "aws.dynamodb" } as unknown as { kind: "local.postgres" },
          },
        },
      }),
    ).toThrow(ConfigError);
  });

  it("accepts a dev block with a matching engine", () => {
    const stack = defineStack({ databases: { app: cloudPg } });
    expect((stack.databases.app as { dev?: { kind: string } }).dev?.kind).toBe("local.postgres");
  });

  it("reports a field-accurate message for a non-object dev block", () => {
    expect(() =>
      defineStack({
        databases: {
          app: {
            engine: "postgres",
            provision: { kind: "local.postgres" },
            dev: 42 as unknown as { kind: "local.postgres" },
          },
        },
      }),
    ).toThrow(/"app" dev must be an object with a kind/);
  });
});
