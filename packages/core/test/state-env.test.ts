import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { defaultStatePath } from "../src/state/index.js";

describe("defaultStatePath", () => {
  it("returns foundry.state.json by default", () => {
    expect(defaultStatePath("/proj")).toBe(join("/proj", "foundry.state.json"));
  });
  it("returns foundry.state.dev.json under env 'dev'", () => {
    expect(defaultStatePath("/proj", "dev")).toBe(join("/proj", "foundry.state.dev.json"));
  });
  it("ignores env when undefined", () => {
    expect(defaultStatePath("/proj", undefined)).toBe(join("/proj", "foundry.state.json"));
  });
});
