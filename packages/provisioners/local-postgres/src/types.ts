/**
 * Spec model and option types for the local Postgres provisioner.
 *
 * Mirrors the shape of the other provisioners' types.ts. The local DB password
 * is a dev-only throwaway secret: it is NEVER placed on {@link NormalizedLocal}
 * (so it can never leak into state outputs). It lives only in the local env
 * file (the local secret store, see local-env.ts) for the lifetime of the
 * container.
 */
import type { WaitForOptions } from "@foundry/core";
import type { DockerRunner } from "./docker.js";

/**
 * User-facing spec props (camelCase) parsed from `ResourceSpec.props`. Every
 * field is optional — the provisioner applies dev-friendly defaults so a local
 * database can be declared in one line:
 *
 *   provision: { kind: "local.postgres" }
 */
export interface LocalPostgresSpecProps {
  /** Docker container name. Default: `foundry-<dbId>`. */
  containerName?: string;
  /**
   * Docker image. Default: `pgvector/pgvector:pg16` — the official pgvector
   * image, so RAG/vector workloads work out of the box with no extra setup.
   */
  image?: string;
  /** Host port to publish. Default: 5432. */
  port?: number;
  /** Postgres database created on first start. Default: "app". */
  dbName?: string;
  /** Postgres role/user. Default: "postgres". */
  username?: string;
  /**
   * Postgres password VALUE (dev only). Default: a deterministic dev password.
   * Stored in the local env file, never in foundry.state.json.
   */
  password?: string;
  /** Docker network to attach the container to. Optional. */
  network?: string;
  /**
   * Persist data in a named Docker volume across destroys/recreates. Default:
   * true. When false, the container uses an ephemeral (anonymous) volume.
   */
  persistent?: boolean;
}

/**
 * Validated, defaulted in-memory shape. The password is intentionally ABSENT
 * (it is a local secret, not state) — see {@link LocalPostgresSpecProps.password}.
 */
export interface NormalizedLocal {
  containerName: string;
  image: string;
  port: number;
  /**
   * Whether `port` was explicitly requested in the spec. When false, the port is
   * auto-picked on first create and reused thereafter; diffLocal ignores it.
   * NOT persisted in outputs — recovered-from-outputs values are always treated
   * as explicit (authoritative).
   */
  portExplicit: boolean;
  dbName: string;
  username: string;
  network?: string;
  persistent: boolean;
}

/** Constructor options. */
export interface LocalPostgresProvisionerOptions {
  /**
   * Injectable Docker transport. Tests pass a fake; the factory supplies a
   * `docker`-CLI-backed runner. When omitted the provisioner lazily constructs
   * the default CLI runner on first use.
   */
  runner?: DockerRunner;
  /**
   * Directory holding the local env (secret) file. Default: `<cwd>/.foundry`.
   * The file is the local analog of a cloud secret store; it should be
   * gitignored (foundry init writes the ignore entry).
   */
  secretsDir?: string;
  /**
   * Password generator for newly-created local DBs when the spec omits one.
   * Default: a fixed, deterministic dev password (good enough for a throwaway
   * local container; override for anything stronger).
   */
  generatePassword?: () => string;
  /** Poll tuning for container readiness. Default: ~30s ceiling, fast polls. */
  waitFor?: WaitForOptions;
  /** Override the local env file name. Default: `local.env`. */
  envFileName?: string;
}
