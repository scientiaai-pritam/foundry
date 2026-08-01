/**
 * Factory + convenience helpers for the local Postgres provisioner.
 *
 * Mirrors @foundry/aws-rds-postgres/factory.ts and @foundry/supabase-postgres:
 * the factory constructs a provisioner from options, and a thin helper builds
 * the default `docker`-CLI-backed runner.
 */
import { LocalPostgresProvisioner } from "./provisioner.js";
import { CliDockerRunner } from "./docker.js";
import type { LocalPostgresProvisionerOptions } from "./types.js";

/** Construct a provisioner from options (the config/secrets-dir path). */
export function createLocalPostgresProvisioner(
  opts: LocalPostgresProvisionerOptions = {},
): LocalPostgresProvisioner {
  return new LocalPostgresProvisioner(opts);
}

/** Build the default `docker`-CLI-backed runner. */
export function createCliDockerRunner(): CliDockerRunner {
  return new CliDockerRunner();
}
