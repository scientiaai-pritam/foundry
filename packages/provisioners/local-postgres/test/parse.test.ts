import { describe, it, expect } from "vitest";
import {
  parseSpecProps,
  extractPassword,
  outputsToNormalized,
  normalizedToOutputs,
  DEFAULT_IMAGE,
} from "../src/parse.js";
import { diffLocal } from "../src/diff.js";
import { LocalPostgresConfigError } from "../src/errors.js";
import type { NormalizedLocal } from "../src/types.js";

function normalized(over: Partial<NormalizedLocal> = {}): NormalizedLocal {
  return {
    containerName: "foundry-app",
    image: DEFAULT_IMAGE,
    port: 5432,
    portExplicit: true, // recovered-from-outputs values are authoritative
    dbName: "app",
    username: "postgres",
    persistent: true,
    ...over,
  };
}

describe("parseSpecProps", () => {
  it("applies dev-friendly defaults so an empty props object is valid", () => {
    const n = parseSpecProps({}, "app");
    expect(n).toEqual({
      containerName: "foundry-app",
      image: "pgvector/pgvector:pg16",
      port: 5432,
      portExplicit: false, // port was NOT user-supplied
      dbName: "app",
      username: "postgres",
      persistent: true,
    });
  });

  it("accepts explicit overrides", () => {
    const n = parseSpecProps(
      {
        containerName: "pg1",
        image: "postgres:16",
        port: 5500,
        dbName: "main",
        username: "u",
        network: "net1",
        persistent: false,
      },
      "app",
    );
    expect(n).toEqual({
      containerName: "pg1",
      image: "postgres:16",
      port: 5500,
      portExplicit: true, // port WAS user-supplied
      dbName: "main",
      username: "u",
      network: "net1",
      persistent: false,
    });
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseSpecProps({ port: 0 }, "app")).toThrow(LocalPostgresConfigError);
    expect(() => parseSpecProps({ port: 70000 }, "app")).toThrow(LocalPostgresConfigError);
  });

  it("rejects a non-boolean persistent", () => {
    expect(() => parseSpecProps({ persistent: "yes" }, "app")).toThrow(LocalPostgresConfigError);
  });
});

describe("extractPassword", () => {
  it("returns undefined when no password is supplied", () => {
    expect(extractPassword(undefined)).toBeUndefined();
    expect(extractPassword({})).toBeUndefined();
  });
  it("returns the value when supplied", () => {
    expect(extractPassword({ password: "s3cret" })).toBe("s3cret");
  });
  it("rejects an empty/non-string password", () => {
    expect(() => extractPassword({ password: "" })).toThrow(LocalPostgresConfigError);
  });
});

describe("normalized <-> outputs round-trip", () => {
  it("round-trips through state outputs without the password", () => {
    const n = normalized({ network: "net1" });
    const outputs = normalizedToOutputs(n);
    // Password is NEVER part of outputs.
    expect("password" in outputs).toBe(false);
    const recovered = outputsToNormalized(outputs);
    expect(recovered).toEqual(n);
  });

  it("outputsToNormalized returns null for malformed outputs", () => {
    expect(outputsToNormalized(undefined)).toBeNull();
    expect(outputsToNormalized({ containerName: "x" })).toBeNull();
  });
});

describe("diffLocal", () => {
  it("no change", () => {
    const d = diffLocal(normalized(), normalized());
    expect(d.requiresReplace).toBe(false);
    expect(d.changedFields).toEqual([]);
  });
  it("containerName change forces replace", () => {
    const d = diffLocal(normalized({ containerName: "x" }), normalized());
    expect(d.requiresReplace).toBe(true);
    expect(d.changedFields).toEqual(["containerName"]);
    expect(d.replaceReason).toMatch(/containerName/);
  });
  it("image change forces replace", () => {
    const d = diffLocal(normalized({ image: "postgres:16" }), normalized());
    expect(d.requiresReplace).toBe(true);
    expect(d.changedFields).toEqual(["image"]);
  });
  it("port change is an update, not a replace", () => {
    const d = diffLocal(normalized({ port: 5500 }), normalized());
    expect(d.requiresReplace).toBe(false);
    expect(d.changedFields).toEqual(["port"]);
  });
  it("ignores an auto-picked port mismatch (port not explicitly desired)", () => {
    const desired = normalized({ port: 5432, portExplicit: false }); // spec omitted port
    const current = normalized({ port: 5599, portExplicit: true });   // persisted auto-port
    const d = diffLocal(desired, current);
    expect(d.requiresReplace).toBe(false);
    expect(d.changedFields).not.toContain("port");
  });
  it("still flags an explicitly-desired port change", () => {
    const d = diffLocal(normalized({ port: 5500, portExplicit: true }), normalized({ port: 5432, portExplicit: true }));
    expect(d.changedFields).toContain("port");
  });
});
