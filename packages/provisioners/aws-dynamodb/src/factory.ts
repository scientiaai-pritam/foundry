/**
 * Factory for the DynamoDB provisioner.
 */
import { DynamoDBProvisioner } from "./provisioner.js";
import type { DynamoDBProvisionerOptions } from "./types.js";

export function createDynamoDBProvisioner(
  opts: DynamoDBProvisionerOptions,
): DynamoDBProvisioner {
  return new DynamoDBProvisioner(opts);
}
