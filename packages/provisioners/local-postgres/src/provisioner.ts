/**
 * Local Postgres provisioner — implements the foundry `Provisioner` contract for
 * `kind: "local.postgres"`.
 *
 * This is the "instant local DB" sibling of the cloud provisioners. It manages
 * a single Docker container (default image: `pgvector/pgvector`, so vector/RAG
 * workloads work out of the box) and emits the SAME `ConnectionTarget` shape as
 * RDS Postgres — `{ engine: "postgres", endpoint, credsRef }`. The kernel treats
 * it identically: the same `postgres` connector connects; the same migration
 * runner applies. The only difference is that `apply` takes ~seconds (container
 * start) instead of 5–20 minutes (RDS create).
 *
 * SECURITY / secrets (mirrors the cloud posture):
 *   - The DB password is a LOCAL dev secret. Its VALUE is never placed on state
 *     or outputs — only the `credsRef` POINTER is emitted. The value lives in a
 *     gitignored local env file (`<cwd>/.foundry/local.env`), the local analog
 *     of AWS Secrets Manager. `foundry env` / the connector resolve it from
 *     there at runtime. Lose the file → re-create the container to regenerate.
 *
 * Docker is reached through an injectable {@link DockerRunner} (default: a
 * `docker`-CLI runner) so the provisioner is deterministic and testable with no
 * daemon present.
 */
import { join } from "node:path";
import type {
  ConnectionTarget,
  PlanAction,
  Provisioner,
  ResourceKind,
  ResourceSpec,
  ResourceState,
  WaitForOptions,
} from "@foundry/core";
import { waitFor } from "@foundry/core";

import {
  DockerUnavailableError,
  LocalPostgresProvisionerError,
  wrapLocalError,
} from "./errors.js";
import type { LocalPostgresProvisionerOptions, NormalizedLocal } from "./types.js";
import type { DockerRunner } from "./docker.js";
import { CliDockerRunner } from "./docker.js";
import { diffLocal } from "./diff.js";
import { extractPassword, normalizedToOutputs, outputsToNormalized, parseSpecProps } from "./parse.js";
import {
  buildPostgresUrl,
  credEnvVar,
  localEnvPath,
  readEnvFile,
  removeEnvFileEntry,
  writeEnvFileEntry,
  DEFAULT_ENV_FILENAME,
  DEFAULT_SECRETS_DIRNAME,
} from "./local-env.js";

const LOCALHOST = "localhost";
const DEFAULT_PASSWORD = "postgres";
const POSTGRES_INTERNAL_PORT = 5432;

const DEFAULT_WAIT_FOR: WaitForOptions = {
  timeoutMs: 60_000,
  initialIntervalMs: 250,
  maxIntervalMs: 2_000,
};

export class LocalPostgresProvisioner implements Provisioner {
  readonly kind: ResourceKind = "local.postgres";

  private readonly runnerThunk: () => DockerRunner;
  private readonly secretsDir: string;
  private readonly envFileName: string;
  private readonly generatePassword: () => string;
  private readonly waitForOpts: WaitForOptions;

  constructor(opts: LocalPostgresProvisionerOptions = {}) {
    // Lazy default runner: construct the CLI runner only on first use so that
    // constructing the provisioner (e.g. always-registered in the app) never
    // shells out or fails when Docker is absent.
    const injected = opts.runner;
    this.runnerThunk = injected !== undefined ? () => injected : makeDefaultRunner();
    this.secretsDir = opts.secretsDir ?? join(process.cwd(), DEFAULT_SECRETS_DIRNAME);
    this.envFileName = opts.envFileName ?? DEFAULT_ENV_FILENAME;
    this.generatePassword = opts.generatePassword ?? (() => DEFAULT_PASSWORD);
    this.waitForOpts = opts.waitFor ?? DEFAULT_WAIT_FOR;
  }

  private get runner(): DockerRunner {
    return this.runnerThunk();
  }
  private get envPath(): string {
    return localEnvPath(this.secretsDir, this.envFileName);
  }

  /* =========================== plan ============================ */

  plan(desired: ResourceSpec, current: ResourceState | null): PlanAction {
    if (current === null) {
      return { op: "create", spec: desired };
    }
    const desiredN = parseSpecProps(desired.props, desired.id);
    const currentN = outputsToNormalized(current.outputs);
    if (!currentN) {
      // State predates normalized outputs (or was hand-edited). Don't guess;
      // propose a full reconciliation and let apply re-read live.
      return { op: "update", spec: desired, from: current, changedFields: ["*"] };
    }

    const d = diffLocal(desiredN, currentN);
    if (d.requiresReplace) {
      return { op: "replace", spec: desired, reason: d.replaceReason ?? "resource must be replaced" };
    }
    if (d.changedFields.length === 0) {
      return {
        op: "noop",
        id: desired.id,
        reason: `container '${desiredN.containerName}' matches desired state`,
      };
    }
    return { op: "update", spec: desired, from: current, changedFields: d.changedFields };
  }

  /* =========================== apply =========================== */

  async apply(action: PlanAction): Promise<ResourceState> {
    switch (action.op) {
      case "create":
        return this.applyCreate(action.spec);
      case "update":
        return this.applyRecreate(action.spec, "update");
      case "replace":
        return this.applyRecreate(action.spec, "replace");
      // delete is routed through destroy() by the orchestrator; noop is skipped
      // before dispatch. They never reach apply() — surface a clear error.
      case "delete":
      case "noop":
        throw new LocalPostgresProvisionerError(
          `apply() does not handle op "${action.op}" (delete uses destroy(); noop is skipped by the orchestrator)`,
          action.op === "delete" ? action.state.id : action.id,
          action.op,
        );
      default: {
        const _exhaustive: never = action;
        throw new LocalPostgresProvisionerError(
          `unknown action: ${JSON.stringify(_exhaustive)}`,
          "?",
          "apply",
        );
      }
    }
  }

  /* =========================== read ============================ */

  async read(spec: ResourceSpec): Promise<ResourceState | null> {
    await this.ensureDocker(spec.id, "read");
    const n = parseSpecProps(spec.props, spec.id);
    const info = await this.runner.inspect(n.containerName);
    if (!info) return null;
    return this.buildState(spec, n, info);
  }

  /* ========================= destroy =========================== */

  async destroy(state: ResourceState): Promise<void> {
    const n = outputsToNormalized(state.outputs);
    const containerName =
      n?.containerName ?? (state.identifiers.containerName as string | undefined);
    if (!containerName) {
      throw new LocalPostgresProvisionerError(
        "cannot destroy: containerName not found in state (outputs.containerName or identifiers.containerName)",
        state.id,
        "destroy",
      );
    }
    await this.ensureDocker(state.id, "destroy");
    try {
      // Remove the container; force-kill if running, and drop the data volume
      // when the DB was persistent (terminal destroy = data loss, by design).
      await this.runner.remove(containerName, { force: true, volumes: n?.persistent ?? true });
    } catch (err) {
      throw wrapLocalError(err, state.id, "destroy", "Is the Docker daemon running?");
    }
    // Best-effort: clear the now-stale connection string from the local env file.
    await removeEnvFileEntry(this.envPath, credEnvVar(state.id)).catch(() => {
      /* non-fatal */
    });
  }

  /* ===================== apply sub-flows ====================== */

  private async applyCreate(spec: ResourceSpec): Promise<ResourceState> {
    await this.ensureDocker(spec.id, "create");
    const n = parseSpecProps(spec.props, spec.id);

    // Idempotency: if a healthy container with the matching image already
    // exists, treat it as already-created. Keep the local env entry in sync so
    // `foundry env` / connect can resolve the password.
    const existing = await this.runner.inspect(n.containerName).catch((err) => {
      throw wrapLocalError(err, spec.id, "create", "Is the Docker daemon running?");
    });
    if (existing && existing.state === "running" && imagesMatch(existing.image, n.image)) {
      await this.ensureEnvEntry(spec.id, n);
      const refreshed = await this.runner.inspect(n.containerName);
      if (refreshed) return this.buildState(spec, n, refreshed);
    }

    // Any stale/wrong-image/exited container is removed before starting fresh.
    if (existing) {
      await this.runner.remove(n.containerName, { force: true, volumes: false }).catch(() => {
        /* best-effort; the run below will surface a name-in-use error */
      });
    }

    const password = this.resolvePassword(spec, n);
    await this.startContainer(spec.id, n, password);
    await this.waitForReady(spec.id, n);
    await writeEnvFileEntry(
      this.envPath,
      credEnvVar(spec.id),
      buildPostgresUrl({
        user: n.username,
        password,
        host: LOCALHOST,
        port: n.port,
        database: n.dbName,
      }),
    );

    const info = await this.runner.inspect(n.containerName);
    if (!info) {
      throw new LocalPostgresProvisionerError(
        `container '${n.containerName}' not found immediately after start`,
        spec.id,
        "create",
      );
    }
    return this.buildState(spec, n, info);
  }

  /** Update / replace both recreate the local container (cheap + instant). */
  private async applyRecreate(spec: ResourceSpec, op: "update" | "replace"): Promise<ResourceState> {
    await this.ensureDocker(spec.id, op);
    const n = parseSpecProps(spec.props, spec.id);
    // Remove the existing container (keep the volume when persistent so a
    // port/recreate keeps data; drop it only on terminal destroy).
    await this.runner.remove(n.containerName, { force: true, volumes: false }).catch(() => {
      /* idempotent: may not exist yet */
    });
    return this.applyCreate(spec);
  }

  /* ====================== private helpers ===================== */

  private async ensureDocker(resourceId: string, op: string): Promise<void> {
    let available: boolean;
    try {
      available = await this.runner.isAvailable();
    } catch (err) {
      throw new DockerUnavailableError(
        `Docker transport check failed: ${err instanceof Error ? err.message : String(err)}`,
        resourceId,
        op,
        err,
      );
    }
    if (!available) {
      throw new DockerUnavailableError(
        "Docker is not available (the 'docker' binary was not found or the daemon is not running).",
        resourceId,
        op,
        undefined,
        "Install Docker / start Docker Desktop, then re-run `foundry apply`. Local Postgres rides a Docker container.",
      );
    }
  }

  /**
   * Resolve the password for a fresh container: spec prop → existing local env
   * entry (keep a prior password on re-create) → generated default.
   */
  private resolvePassword(spec: ResourceSpec, n: NormalizedLocal): string {
    const fromSpec = extractPassword(spec.props);
    if (fromSpec !== undefined) return fromSpec;
    return this.generatePassword();
  }

  /**
   * If the container already exists but the local env file is missing its entry,
   * write a best-effort entry from a known password (spec prop or default). This
   * recovers from a deleted env file without forcing a container recreate.
   */
  private async ensureEnvEntry(dbId: string, n: NormalizedLocal): Promise<void> {
    const key = credEnvVar(dbId);
    const values = await readEnvFile(this.envPath);
    if (values[key] !== undefined) return;
    const password = this.generatePassword();
    await writeEnvFileEntry(
      this.envPath,
      key,
      buildPostgresUrl({
        user: n.username,
        password,
        host: LOCALHOST,
        port: n.port,
        database: n.dbName,
      }),
    );
  }

  private async startContainer(
    resourceId: string,
    n: NormalizedLocal,
    password: string,
  ): Promise<void> {
    const args: string[] = [
      "-d",
      "--name", n.containerName,
      "--restart", "unless-stopped",
      "-e", `POSTGRES_DB=${n.dbName}`,
      "-e", `POSTGRES_USER=${n.username}`,
      "-e", `POSTGRES_PASSWORD=${password}`,
      "-p", `${n.port}:${POSTGRES_INTERNAL_PORT}`,
    ];
    if (n.persistent) {
      args.push("-v", `${volumeName(n.containerName)}:/var/lib/postgresql/data`);
    }
    if (n.network !== undefined) {
      args.push("--network", n.network);
    }
    args.push(n.image);

    try {
      await this.runner.run(args);
    } catch (err) {
      throw wrapLocalError(
        err,
        resourceId,
        "create",
        "Is the Docker daemon running and the image pull reachable? The host port " +
          `${n.port} may already be in use (set a different 'port' in config).`,
      );
    }
  }

  private async waitForReady(resourceId: string, n: NormalizedLocal): Promise<void> {
    let lastErr = "";
    try {
      await waitFor(async () => {
        const res = await this.runner.exec(n.containerName, [
          "pg_isready",
          "-U", n.username,
          "-d", n.dbName,
        ]);
        if (res.exitCode === 0) return true;
        lastErr = res.stderr ?? res.stdout;
        return false;
      }, this.waitForOpts);
    } catch (err) {
      if (err instanceof Error && err.name === "WaitForTimeoutError") {
        throw new LocalPostgresProvisionerError(
          `container '${n.containerName}' did not become ready within the timeout (pg_isready: ${lastErr || "no output"})`,
          resourceId,
          "waitForReady",
          err,
          "Inspect the container with `docker logs " + n.containerName + "`; the host port may be busy or the image failed to start.",
        );
      }
      throw err;
    }
  }

  private buildState(
    spec: ResourceSpec,
    n: NormalizedLocal,
    info: { state: string; status: string; image: string },
  ): ResourceState {
    const connection: ConnectionTarget = {
      engine: "postgres",
      endpoint: `${LOCALHOST}:${n.port}`,
      credsRef: { from: `env:${credEnvVar(spec.id)}` },
    };
    return {
      id: spec.id,
      kind: "local.postgres",
      identifiers: { containerName: n.containerName },
      status: mapContainerStatus(info.state),
      connection,
      outputs: normalizedToOutputs(n),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function volumeName(containerName: string): string {
  return `${containerName}-data`;
}

/** Compare image refs leniently (pgvector/pgvector == pgvector/pgvector:latest). */
function imagesMatch(running: string, desired: string): boolean {
  return normalizeImage(running) === normalizeImage(desired);
}

function normalizeImage(image: string): string {
  // Strip a registry host and a default ":latest" so "pgvector/pgvector" and
  // "docker.io/pgvector/pgvector:latest" compare equal.
  const noHost = image.includes("/") && image.includes(".") ? image.split("/").slice(-2).join("/") : image;
  const [repo, tag] = noHost.split(":");
  return tag === undefined || tag === "latest" ? `${repo}` : `${repo}:${tag}`;
}

function mapContainerStatus(state: string): ResourceState["status"] {
  switch (state) {
    case "running":
      return "available";
    case "created":
      return "creating";
    case "restarting":
    case "paused":
      return "updating";
    case "removing":
      return "deleting";
    case "exited":
    case "dead":
      return "error";
    default:
      return "error";
  }
}

function makeDefaultRunner(): () => DockerRunner {
  let cached: DockerRunner | undefined;
  return () => {
    if (cached === undefined) cached = new CliDockerRunner();
    return cached;
  };
}
