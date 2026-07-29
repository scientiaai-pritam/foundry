/**
 * Factory + convenience client builder for the AWS RDS Postgres provisioner.
 * Mirrors @scientia/aws-dynamodb/factory.ts.
 */
import { RDSClient } from "@aws-sdk/client-rds";
import type { AwsRdsPostgresProvisionerOptions } from "./types.js";
import { AwsRdsPostgresProvisioner } from "./provisioner.js";

/** Construct a provisioner from options (the config region/credsRef path). */
export function createAwsRdsPostgresProvisioner(
  opts: AwsRdsPostgresProvisionerOptions,
): AwsRdsPostgresProvisioner {
  return new AwsRdsPostgresProvisioner(opts);
}

/**
 * Build an `RDSClient` authenticated via the AMBIENT cloud credential chain
 * (env vars, shared-config profile, IMDS, …). The framework never handles
 * cloud-admin credentials directly.
 */
export function createRdsClient(region: string): RDSClient {
  return new RDSClient({ region });
}
