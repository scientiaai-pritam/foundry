/**
 * Factory for the Redshift provisioner.
 */
import { RedshiftProvisioner } from "./provisioner.js";
import type { RedshiftProvisionerOptions } from "./types.js";

export function createRedshiftProvisioner(
  opts: RedshiftProvisionerOptions,
): RedshiftProvisioner {
  return new RedshiftProvisioner(opts);
}
