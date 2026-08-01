/**
 * Golden-path END-TO-END vertical slice for the LOCAL Postgres path — the
 * "instant local DB" killer feature:
 *
 *   defineStack(local.postgres) → plan → apply (instant, Docker) →
 *   assert available → foundry env → DATABASE_URL → destroy → gone
 *
 * No Docker daemon: the composition root (@foundry/app) builds a REAL
 * LocalPostgresProvisioner, but the Docker TRANSPORT is faked (the runner is
 * injected exactly like DynamoDBClient in the DynamoDB slice). This proves the
 * full wiring — provision→connect-target→env — crosses core + app + the local
 * provisioner package, and that `foundry apply` against local is instant.
 *
 * (The connect→migrate→query step needs a real pg server and is covered by the
 * connector-postgres contract tests + the provisioner contract tests; this slice
 * stops at DATABASE_URL, which is the handoff to the app.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineStack,
  runPlan,
  runApply,
  runDestroy,
  runEnv,
  type CLIContext,
} from "@foundry/core";
import { createAppContext } from "../src/context.js";
import type { DockerRunner, ContainerInfo, ExecResult, RemoveOptions } from "@foundry/local-postgres";

/* ------------------------------ fake docker ------------------------------ */

interface FakeContainer {
  image: string;
  state: string;
  env: Record<string, string>;
  port: number;
  readyCalls: number;
}

class FakeDockerRunner implements DockerRunner {
  available = true;
  readonly containers = new Map<string, FakeContainer>();
  readonly removedWithVolume = new Set<string>();

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async inspect(name: string): Promise<ContainerInfo | null> {
    const c = this.containers.get(name);
    if (!c) return null;
    return {
      name,
      state: c.state,
      status: c.state === "running" ? "Up" : c.state,
      image: c.image,
      ports: [{ hostPort: c.port, privatePort: 5432, hostIp: "0.0.0.0" }],
    };
  }
  async run(args: readonly string[]): Promise<string> {
    const name = argAfter(args, "--name");
    const image = args[args.length - 1] ?? "";
    const env: Record<string, string> = {};
    for (const a of args) {
      if (a.startsWith("POSTGRES_") && a.includes("=")) {
        const [k, ...rest] = a.split("=");
        env[k!] = rest.join("=");
      }
    }
    const portArg = argAfter(args, "-p");
    const port = portArg ? Number(portArg.split(":")[0]) : 5432;
    this.containers.set(name!, { image, state: "running", env, port, readyCalls: 0 });
    return `id-${name}`;
  }
  async remove(name: string, opts: RemoveOptions = {}): Promise<void> {
    this.containers.delete(name);
    if (opts.volumes) this.removedWithVolume.add(name);
  }
  async exec(name: string, cmd: readonly string[]): Promise<ExecResult> {
    const c = this.containers.get(name);
    if (!c) return { exitCode: 1, stdout: "", stderr: "No such container" };
    c.readyCalls++;
    if (cmd[0] === "pg_isready") {
      return c.readyCalls >= 1
        ? { exitCode: 0, stdout: "accepting connections" }
        : { exitCode: 1, stdout: "" };
    }
    return { exitCode: 0, stdout: "" };
  }
}

function argAfter(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/* ------------------------------ fixtures ------------------------------ */

const stack = defineStack({
  databases: {
    app: { engine: "postgres", provision: { kind: "local.postgres", port: 5500 } },
  },
});

const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
};

let tmp = "";
let runner: FakeDockerRunner;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-local-e2e-"));
  runner = new FakeDockerRunner();
  delete process.env.FOUNDRY_LOCAL_APP;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FOUNDRY_LOCAL_APP;
});

/* =============================== the slice =============================== */

describe("golden path: local Postgres slice (init-config → plan → apply → env → destroy)", () => {
  it("provisions instantly and hands DATABASE_URL to the app", async () => {
    const ctx: CLIContext = await createAppContext({
      cwd: tmp,
      stack,
      statePath: join(tmp, "foundry.state.json"),
      localPostgresRunner: runner,
      localPostgresSecretsDir: join(tmp, ".foundry"),
      waitFor: { initialIntervalMs: 1, timeoutMs: 2000 },
      logger: silentLogger,
    });

    // Composition root registered the local provisioner (no AWS region needed).
    expect(ctx.provisioners.get("local.postgres")).toBeDefined();
    expect(ctx.connectors.get("postgres")).toBeDefined();

    // 1. plan: a single create for the local DB.
    const plan = await runPlan(ctx);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.op).toBe("create");

    // 2. apply: instant (fake container start); zero failures.
    const applied = await runApply(ctx, plan);
    expect(applied.failed).toBe(0);
    expect(applied.succeeded).toBe(1);

    // 3. state is the source of truth — same ConnectionTarget shape as RDS.
    const resource = await ctx.state.get("app");
    expect(resource?.status).toBe("available");
    expect(resource?.connection.engine).toBe("postgres");
    expect(resource?.connection.endpoint).toBe("localhost:5500");
    expect(resource?.connection.credsRef).toEqual({ from: "env:FOUNDRY_LOCAL_APP" });
    // Password never in state.
    expect(resource?.outputs?.password).toBeUndefined();

    // 4. foundry env: resolves DATABASE_URL from the local secret store.
    const env = await runEnv(ctx, "app");
    expect(env.line).toMatch(/^DATABASE_URL=postgres:\/\/postgres:[^@]+@localhost:5500\/app$/);

    // 5. destroy: removes the container + its data volume.
    const destroyed = await runDestroy(ctx, { force: true });
    expect(destroyed.failed).toBe(0);
    expect(runner.containers.has("foundry-app")).toBe(false);
    expect(runner.removedWithVolume.has("foundry-app")).toBe(true);
    expect(await ctx.state.get("app")).toBeNull();
  }, 10_000);

  it("fails fast with a clear error when Docker is unavailable", async () => {
    runner.available = false;
    const ctx: CLIContext = await createAppContext({
      cwd: tmp,
      stack,
      statePath: join(tmp, "foundry.state.json"),
      localPostgresRunner: runner,
      waitFor: { initialIntervalMs: 1, timeoutMs: 2000 },
      logger: silentLogger,
    });
    const plan = await runPlan(ctx);
    const result = await runApply(ctx, plan);
    // Stop-on-error: the run aborts, no rollback, nothing provisioned.
    expect(result.failed).toBe(1);
    expect(result.stoppedOnError).toBe(true);
    expect(result.results[0]?.error?.message).toMatch(/Docker is not available/);
    expect(await ctx.state.get("app")).toBeNull();
  });
});
