/**
 * Public entry point for @foundry/local-postgres.
 *
 * Mirrors the sibling provisioner packages: re-exports the provisioner class,
 * factory, config/errors, the Docker transport, and the local env helpers.
 */
export { LocalPostgresProvisioner } from "./provisioner.js";
export { createLocalPostgresProvisioner, createCliDockerRunner } from "./factory.js";
export {
  LocalPostgresConfigError,
  LocalPostgresProvisionerError,
  DockerUnavailableError,
  wrapLocalError,
} from "./errors.js";
export type { ApplyOp } from "./errors.js";
export {
  CliDockerRunner,
  DEFAULT_DOCKER_BIN,
} from "./docker.js";
export type {
  DockerRunner,
  ContainerInfo,
  ContainerPort,
  ExecResult,
  RemoveOptions,
  CliDockerRunnerOptions,
} from "./docker.js";
export {
  parseSpecProps,
  extractPassword,
  outputsToNormalized,
  normalizedToOutputs,
  DEFAULT_IMAGE,
  DEFAULT_PORT,
  DEFAULT_DB_NAME,
  DEFAULT_USERNAME,
} from "./parse.js";
export { diffLocal } from "./diff.js";
export type { LocalDiff } from "./diff.js";
export type {
  LocalPostgresSpecProps,
  NormalizedLocal,
  LocalPostgresProvisionerOptions,
} from "./types.js";
export {
  localEnvPath,
  credEnvVar,
  dbIdSuffix,
  buildPostgresUrl,
  // Generic .env primitives (re-exported from @foundry/core):
  parseEnvFile,
  formatEnvFile,
  readEnvFile,
  writeEnvFileEntry,
  removeEnvFileEntry,
  loadEnvFileIntoProcess,
  DEFAULT_SECRETS_DIRNAME,
  DEFAULT_ENV_FILENAME,
} from "./local-env.js";

// Re-export the shared lifecycle primitives so consumers can import everything
// from this package (parity with the other provisioner packages).
export { waitFor, WaitForTimeoutError } from "@foundry/core";
export type { WaitForOptions } from "@foundry/core";
