/**
 * Docker transport abstraction for the local Postgres provisioner.
 *
 * The provisioner depends on the {@link DockerRunner} INTERFACE, not on the
 * `docker` binary — exactly as the AWS provisioners depend on an injected
 * `RDSClient` and the Supabase provisioner depends on an injected fetch fn.
 * This keeps the provisioner deterministic and testable with no Docker daemon
 * present (CI). The production {@link CliDockerRunner} shells out to `docker`.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A parsed view of a container (subset of `docker inspect`/`docker ps` JSON). */
export interface ContainerInfo {
  /** Container name (without leading slash). */
  name: string;
  /** Lifecycle state: "running" | "created" | "exited" | "restarting" | "dead" | "paused". */
  state: string;
  /** Human status text, e.g. "Up 3 seconds (healthy)". */
  status: string;
  /** Image the container was started from (repo:tag). */
  image: string;
  /** Published port mappings. */
  ports: ContainerPort[];
}

export interface ContainerPort {
  /** Host port (undefined if not published to the host). */
  hostPort?: number;
  /** In-container port. */
  privatePort: number;
  /** Bound host IP, when published. */
  hostIp?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export interface RemoveOptions {
  /** `docker rm -f` — kill a running container before removing. Default false. */
  force?: boolean;
  /** Also remove anonymous volumes. Default false. */
  volumes?: boolean;
}

/**
 * Minimal Docker surface the provisioner needs. Implementations: {@link
 * CliDockerRunner} (real) and a fake (tests).
 */
export interface DockerRunner {
  /** Is the `docker` binary present and the daemon reachable? */
  isAvailable(): Promise<boolean>;
  /** Inspect a container by name. Returns null when it does not exist. */
  inspect(name: string): Promise<ContainerInfo | null>;
  /**
   * `docker run` with the given args (everything after `docker run`). Returns
   * the container id (stdout of `docker run -d`).
   */
  run(args: readonly string[]): Promise<string>;
  /** Remove a container. Idempotent: a missing container is success. */
  remove(name: string, opts?: RemoveOptions): Promise<void>;
  /** Execute a command inside a running container. */
  exec(name: string, cmd: readonly string[]): Promise<ExecResult>;
}

/* ------------------------------------------------------------------ *
 * CLI-backed runner (production)
 * ------------------------------------------------------------------ */

/** The docker binary name (overridable for tests / devcontainers). */
export const DEFAULT_DOCKER_BIN = "docker";

export interface CliDockerRunnerOptions {
  /** Docker binary path/name. Default: "docker". */
  bin?: string;
  /** Max wait (ms) for a single docker invocation. Default 120_000. */
  timeoutMs?: number;
}

/**
 * {@link DockerRunner} backed by shelling out to the `docker` CLI. Used in
 * production by the factory. No Docker SDK dependency — the CLI is the most
 * universal surface (Docker Desktop on Mac/Win, docker engine on Linux).
 */
export class CliDockerRunner implements DockerRunner {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: CliDockerRunnerOptions = {}) {
    this.bin = opts.bin ?? DEFAULT_DOCKER_BIN;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // `docker version --format '{{.Server.Version}}'` requires the daemon.
      await this.raw(["version", "--format", "{{.Server.Version}}"]);
      return true;
    } catch {
      return false;
    }
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    let stdout: string;
    try {
      stdout = await this.raw(["inspect", "--type=container", "--format={{json .}}", name]);
    } catch (err) {
      // docker inspect prints "Error: No such object" and exits non-zero when
      // the container is absent — that is a "not found" result, not an error.
      if (isNoSuchContainer(err)) return null;
      throw err;
    }
    return parseInspectJson(stdout, name);
  }

  async run(args: readonly string[]): Promise<string> {
    const stdout = await this.raw(["run", ...args]);
    // `docker run -d` prints the container id (64-char hex) to stdout.
    return stdout.trim();
  }

  async remove(name: string, opts: RemoveOptions = {}): Promise<void> {
    const args = ["rm"];
    if (opts.force) args.push("-f");
    if (opts.volumes) args.push("-v");
    args.push(name);
    try {
      await this.raw(args);
    } catch (err) {
      // Idempotent: removing a container that's already gone is success.
      if (isNoSuchContainer(err) || isNoSuchObject(err)) return;
      throw err;
    }
  }

  async exec(name: string, cmd: readonly string[]): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await this.rawWithStderr(["exec", name, ...cmd]);
      return { exitCode: 0, stdout, ...(stderr !== "" ? { stderr } : {}) };
    } catch (err) {
      // exec fails non-zero when the in-container command fails; surface that
      // as a structured ExecResult rather than throwing.
      const e = err as ExecResultError;
      if (typeof e.code === "number") {
        return {
          exitCode: e.code,
          stdout: e.stdout ?? "",
          ...(e.stderr !== undefined && e.stderr !== "" ? { stderr: e.stderr } : {}),
        };
      }
      throw err;
    }
  }

  private async raw(args: readonly string[]): Promise<string> {
    const { stdout } = await this.rawWithStderr(args);
    return stdout;
  }

  private async rawWithStderr(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileP(this.bin, [...args], {
        timeout: this.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err) {
      const e = err as ExecFileException & { stdout?: string; stderr?: string; code?: number | string };
      // Normalise so callers can inspect `.code`/`.stdout`/`.stderr` uniformly.
      const enriched: ExecResultError = {
        message: e.message,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        ...(typeof e.code === "number" ? { code: e.code } : {}),
      };
      throw enriched;
    }
  }
}

interface ExecResultError {
  message: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** Parse `docker inspect --format={{json .}}` output into a {@link ContainerInfo}. */
function parseInspectJson(stdout: string, fallbackName: string): ContainerInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Should not happen for a well-formed `docker inspect` — treat as not found.
    return { name: fallbackName, state: "unknown", status: "unknown", image: "", ports: [] };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const state = readObj(o, "State");
  const name = typeof o.Name === "string" ? o.Name.replace(/^\/+/, "") : fallbackName;
  const image = typeof o.Config === "object" && o.Config !== null ? (readStr(o.Config, "Image") ?? "") : "";
  const ports = parsePorts(o);
  return {
    name,
    state: typeof state.Status === "string" ? state.Status : "unknown",
    status: typeof state.Status === "string" ? state.Status : "unknown",
    image,
    ports,
  };
}

function readObj(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = parent[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readStr(parent: unknown, key: string): string | undefined {
  if (typeof parent !== "object" || parent === null) return undefined;
  const v = (parent as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function parsePorts(o: Record<string, unknown>): ContainerPort[] {
  const ports: ContainerPort[] = [];
  const exposed = readObj(o, "NetworkSettings");
  const bindings = exposed.Ports;
  if (typeof bindings === "object" && bindings !== null) {
    // Bindings keyed by "5432/tcp" -> [{ HostPort: "5432", HostIp: "0.0.0.0" }]
    for (const [key, val] of Object.entries(bindings as Record<string, unknown>)) {
      const privatePort = Number.parseInt(key.split("/")[0] ?? "", 10);
      if (!Number.isFinite(privatePort)) continue;
      if (Array.isArray(val)) {
        for (const b of val) {
          const hostPort = readStr(b, "HostPort");
          const hostIp = readStr(b, "HostIp");
          ports.push({
            privatePort,
            ...(hostPort !== undefined && hostPort !== "" ? { hostPort: Number(hostPort) } : {}),
            ...(hostIp !== undefined && hostIp !== "" ? { hostIp } : {}),
          });
        }
      } else {
        ports.push({ privatePort });
      }
    }
  }
  return ports;
}

function isNoSuchContainer(err: unknown): boolean {
  const text = errText(err);
  return /No such container/i.test(text) || /No such object/i.test(text);
}

function isNoSuchObject(err: unknown): boolean {
  return /No such object/i.test(errText(err));
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = err as { stderr?: string; message?: string } | undefined;
  return e?.stderr ?? e?.message ?? String(err);
}
