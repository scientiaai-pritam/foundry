/**
 * Contract tests for the local Postgres provisioner.
 *
 * No Docker daemon required: the provisioner depends on a {@link DockerRunner}
 * interface, so a fake in-memory runner simulates containers. This mirrors how
 * the AWS provisioners are tested against a stubbed `RDSClient`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { LocalPostgresProvisioner, DockerUnavailableError } from "../src/index.js";
import type { DockerRunner, ContainerInfo, ExecResult, RemoveOptions } from "../src/docker.js";
import type { ResourceSpec, ResourceState } from "@foundry/core";

/* ---------------------- fake docker runner ---------------------- */

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
  /** Names removed with a volume (terminal destroy) — asserted in tests. */
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
    if (!name) throw new Error("missing --name");
    const env: Record<string, string> = {};
    for (const a of args) {
      if (a.startsWith("POSTGRES_") && a.includes("=")) {
        const [k, ...rest] = a.split("=");
        env[k!] = rest.join("=");
      }
    }
    const portArg = argAfter(args, "-p");
    const port = portArg ? Number(portArg.split(":")[0]) : 5432;
    this.containers.set(name, { image, state: "running", env, port, readyCalls: 0 });
    // Fake container id.
    return "id-" + name;
  }
  async remove(name: string, opts: RemoveOptions = {}): Promise<void> {
    const c = this.containers.get(name);
    if (!c) throw Object.assign(new Error(`No such container: ${name}`), { stderr: "No such container" });
    this.containers.delete(name);
    if (opts.volumes) this.removedWithVolume.add(name);
  }
  async exec(name: string, cmd: readonly string[]): Promise<ExecResult> {
    const c = this.containers.get(name);
    if (!c) return { exitCode: 1, stdout: "", stderr: "No such container" };
    // Simulate pg_isready: succeed once the container has had a tick to boot.
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

function spec(props: Record<string, unknown> = {}, id = "app"): ResourceSpec {
  return { id, kind: "local.postgres", props };
}

const FAST_WAIT = { timeoutMs: 2000, initialIntervalMs: 1, maxIntervalMs: 10 };

let tmp = "";
let runner: FakeDockerRunner;
let prov: LocalPostgresProvisioner;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "foundry-local-"));
  runner = new FakeDockerRunner();
  prov = new LocalPostgresProvisioner({
    runner,
    secretsDir: tmp,
    waitFor: FAST_WAIT,
  });
});

function cleanup() {
  rmSync(tmp, { recursive: true, force: true });
}

/* =============================== plan =============================== */

describe("plan", () => {
  it("creates when there is no current state", () => {
    expect(prov.plan(spec(), null)).toEqual({ op: "create", spec: spec() });
  });

  it("noops when desired matches current", () => {
    const state: ResourceState = {
      id: "app",
      kind: "local.postgres",
      identifiers: { containerName: "foundry-app" },
      status: "available",
      connection: { engine: "postgres", endpoint: "localhost:5432", credsRef: { from: "env:FOUNDRY_LOCAL_APP" } },
      outputs: {
        containerName: "foundry-app",
        image: "pgvector/pgvector:pg16",
        port: 5432,
        dbName: "app",
        username: "postgres",
        persistent: true,
      },
    };
    const action = prov.plan(spec(), state);
    expect(action.op).toBe("noop");
  });

  it("replaces on an image change (immutable on a running container)", () => {
    const state: ResourceState = {
      id: "app",
      kind: "local.postgres",
      identifiers: { containerName: "foundry-app" },
      status: "available",
      connection: { engine: "postgres", endpoint: "localhost:5432", credsRef: { from: "env:FOUNDRY_LOCAL_APP" } },
      outputs: {
        containerName: "foundry-app",
        image: "postgres:16",
        port: 5432,
        dbName: "app",
        username: "postgres",
        persistent: true,
      },
    };
    const action = prov.plan(spec({ image: "pgvector/pgvector:pg16" }), state);
    expect(action.op).toBe("replace");
    if (action.op === "replace") expect(action.reason).toMatch(/image/);
  });

  it("updates on a port change (cheap local recreate)", () => {
    const state: ResourceState = {
      id: "app",
      kind: "local.postgres",
      identifiers: { containerName: "foundry-app" },
      status: "available",
      connection: { engine: "postgres", endpoint: "localhost:5432", credsRef: { from: "env:FOUNDRY_LOCAL_APP" } },
      outputs: {
        containerName: "foundry-app",
        image: "pgvector/pgvector:pg16",
        port: 5432,
        dbName: "app",
        username: "postgres",
        persistent: true,
      },
    };
    const action = prov.plan(spec({ port: 5500 }), state);
    expect(action.op).toBe("update");
    if (action.op === "update") expect(action.changedFields).toContain("port");
  });
});

/* =============================== apply ============================== */

describe("apply (create)", () => {
  it("starts a container and emits the same ConnectionTarget shape as RDS", async () => {
    const state = await prov.apply({ op: "create", spec: spec({ port: 5500 }) });
    expect(state.kind).toBe("local.postgres");
    expect(state.status).toBe("available");
    expect(state.identifiers.containerName).toBe("foundry-app");
    // Same shape as RDS Postgres: engine + endpoint + credsRef (a POINTER).
    expect(state.connection.engine).toBe("postgres");
    expect(state.connection.endpoint).toBe("localhost:5500");
    expect(state.connection.credsRef).toEqual({ from: "env:FOUNDRY_LOCAL_APP" });
    // Password is NEVER stored in state/outputs (only the credsRef POINTER).
    expect(state.outputs).toBeDefined();
    expect(Object.keys(state.outputs ?? {})).not.toContain("password");
    expect((state.outputs ?? {}).password).toBeUndefined();

    // The container was actually started with the right env + image.
    const c = runner.containers.get("foundry-app")!;
    expect(c).toBeDefined();
    expect(c.image).toBe("pgvector/pgvector:pg16");
    expect(c.env.POSTGRES_DB).toBe("app");
    expect(c.env.POSTGRES_USER).toBe("postgres");
    expect(c.env.POSTGRES_PASSWORD).toBe(DEFAULT_PASS()); // default dev password
  });

  it("writes the connection string to the local env file (the local secret store)", async () => {
    await prov.apply({ op: "create", spec: spec({ port: 5432 }) });
    const envFile = await readEnv(tmp);
    expect(envFile.FOUNDRY_LOCAL_APP).toBe(
      `postgres://postgres:${DEFAULT_PASS()}@localhost:5432/app`,
    );
  });

  it("is idempotent: re-apply on a healthy matching container does not restart it", async () => {
    await prov.apply({ op: "create", spec: spec() });
    const firstStarts = runner.containers.size;
    const state = await prov.apply({ op: "create", spec: spec() });
    expect(state.status).toBe("available");
    // No second container was created.
    expect(runner.containers.size).toBe(firstStarts);
  });

  it("honors an explicit spec password over the default", async () => {
    await prov.apply({ op: "create", spec: spec({ password: "custom-pw" }) });
    const c = runner.containers.get("foundry-app")!;
    expect(c.env.POSTGRES_PASSWORD).toBe("custom-pw");
    const envFile = await readEnv(tmp);
    expect(envFile.FOUNDRY_LOCAL_APP).toContain("custom-pw");
  });

  it("auto-picks a free host port when the spec omits port", async () => {
    const state = await prov.apply({ op: "create", spec: spec() }); // no port
    const c = runner.containers.get("foundry-app")!;
    expect(c.port).not.toBe(5432);
    expect(c.port).toBeGreaterThan(0);
    // The persisted outputs + endpoint carry the auto-picked port.
    expect((state.outputs ?? {}).port).toBe(c.port);
    expect(state.connection.endpoint).toBe(`localhost:${c.port}`);
  });

  it("reuses the previously-assigned port on update when port is not explicit", async () => {
    await prov.apply({ op: "create", spec: spec() }); // picks P
    const prior = await prov.read(spec());
    expect(prior).not.toBeNull();
    const before = runner.containers.get("foundry-app")!.port;
    // Change dbName (not port); port should be reused, not re-picked.
    const state = await prov.apply({
      op: "update",
      spec: spec({ dbName: "newdb" }),
      from: prior!,
      changedFields: ["dbName"],
    });
    expect(runner.containers.get("foundry-app")!.port).toBe(before);
    expect(state.connection.endpoint).toBe(`localhost:${before}`);
  });
});

describe("apply (update / replace)", () => {
  it("recreates the container on update (port change)", async () => {
    await prov.apply({ op: "create", spec: spec({ port: 5500 }) });
    // Simulate the orchestrator handing us the prior state as `from`.
    const prior = await prov.read(spec({ port: 5500 }));
    expect(prior).not.toBeNull();
    const state = await prov.apply({
      op: "update",
      spec: spec({ port: 5501 }),
      from: prior!,
      changedFields: ["port"],
    });
    expect(state.connection.endpoint).toBe("localhost:5501");
    expect(runner.containers.get("foundry-app")!.port).toBe(5501);
  });

  it("recreates the container on replace (image change)", async () => {
    await prov.apply({ op: "create", spec: spec({ image: "postgres:16" }) });
    const state = await prov.apply({
      op: "replace",
      spec: spec({ image: "pgvector/pgvector:pg16" }),
      reason: "image change",
    });
    expect(runner.containers.get("foundry-app")!.image).toBe("pgvector/pgvector:pg16");
    expect(state.status).toBe("available");
  });

  it("reuses the live port on replace (image upgrade of an auto-ported DB)", async () => {
    // Create an auto-ported DB (no explicit port).
    await prov.apply({ op: "create", spec: spec({ image: "postgres:16" }) });
    const before = runner.containers.get("foundry-app")!.port;
    expect(before).not.toBe(5432); // sanity: a port was actually auto-picked
    // Image upgrade triggers a replace (no `from` on the action). The port must
    // be reused, not re-picked — otherwise the connection string emitted by
    // `foundry env --write` would be silently invalidated.
    const state = await prov.apply({
      op: "replace",
      spec: spec({ image: "pgvector/pgvector:pg16" }),
      reason: "image change",
    });
    expect(runner.containers.get("foundry-app")!.port).toBe(before);
    expect(state.connection.endpoint).toBe(`localhost:${before}`);
  });
});

/* =============================== read ============================== */

describe("read", () => {
  it("returns null when the container does not exist", async () => {
    expect(await prov.read(spec())).toBeNull();
  });
  it("maps a running container to an available state", async () => {
    await prov.apply({ op: "create", spec: spec() });
    const state = await prov.read(spec());
    expect(state?.status).toBe("available");
  });
});

/* ============================= destroy ============================ */

describe("destroy", () => {
  it("removes the container and its data volume, and clears the env entry", async () => {
    await prov.apply({ op: "create", spec: spec() });
    const state = (await prov.read(spec()))!;
    expect(await readEnv(tmp)).toHaveProperty("FOUNDRY_LOCAL_APP");
    await prov.destroy(state);
    expect(runner.containers.has("foundry-app")).toBe(false);
    // Persistent by default → data volume dropped on terminal destroy.
    expect(runner.removedWithVolume.has("foundry-app")).toBe(true);
    // The now-stale connection string is cleared from the local env file.
    const envFile = await readEnv(tmp);
    expect(envFile.FOUNDRY_LOCAL_APP).toBeUndefined();
  });

  it("refuses to operate when Docker is unavailable", async () => {
    runner.available = false;
    await expect(prov.apply({ op: "create", spec: spec() })).rejects.toBeInstanceOf(
      DockerUnavailableError,
    );
  });
});

afterEach(cleanup);

/* ------------------------------ helpers ------------------------------ */

/** Default dev password the provisioner uses when none is supplied. */
function DEFAULT_PASS(): string {
  return "postgres";
}

async function readEnv(dir: string): Promise<Record<string, string>> {
  const { readEnvFile } = await import("../src/local-env.js");
  return readEnvFile(join(dir, "local.env"));
}
