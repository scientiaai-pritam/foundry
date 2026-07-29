/**
 * Types for the AWS RDS Postgres provisioner (kind "aws.rds-postgres").
 *
 * Mirrors @scientia/aws-dynamodb: a validated, defaulted {@link NormalizedInstance}
 * is the single in-memory shape the rest of the provisioner works against.
 *
 * SECURITY (design v1, §6/§9): the master password is BY-REFERENCE. The spec's
 * `masterUserPassword` is a SecretRef (a pointer) — resolved by the connector at
 * runtime, never by this provisioner. It is therefore NOT part of
 * NormalizedInstance (so it can never leak into state/outputs/logs). CreateDBInstance
 * is sent `ManageMasterUserPassword:true` so RDS itself generates and manages the
 * password in Secrets Manager; the provisioner never reads, stores, or logs it.
 */
import type { SecretRef, WaitForOptions } from "@scientia/core";
import type { RDSClient } from "@aws-sdk/client-rds";

/**
 * User-facing spec props (camelCase) parsed from `ResourceSpec.props`. Everything
 * except `dbInstanceIdentifier` / `dbInstanceClass` / `allocatedStorage` /
 * `masterUsername` is optional with a secure default applied during parsing.
 *
 * `masterUserPassword` is a SecretRef — a POINTER to this database's own master
 * password (e.g. `{ secretId: "arn:aws:secretsmanager:..." }` or
 * `{ from: "env:RDS_MASTER_PASSWORD" }`). Its VALUE is never stored.
 */
export interface RDSPostgresSpecProps {
  dbInstanceIdentifier: string;
  /** Always "postgres" for this provisioner; validated if supplied. */
  engine?: "postgres";
  dbInstanceClass: string;
  allocatedStorage: number;
  masterUsername: string;
  /** BY-REFERENCE master-password secret. VALUE NEVER stored — see file header. */
  masterUserPassword?: SecretRef;
  /** Optional additional database (RDS for Postgres always creates "postgres"). */
  dbName?: string;
  vpcSecurityGroupIds?: string[];
  dbSubnetGroupName?: string;
  backupRetentionPeriod?: number;
  multiAz?: boolean;
  storageEncrypted?: boolean;
  deletionProtection?: boolean;
  publiclyAccessible?: boolean;
}

/**
 * Validated, defaulted in-memory shape. The RDS `Engine` ("postgres") and the
 * by-reference master-password SecretRef are intentionally absent: engine is a
 * constant for this provisioner, and the secret pointer lives on the
 * ConnectionTarget (never in state outputs).
 */
export interface NormalizedInstance {
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  allocatedStorage: number;
  masterUsername: string;
  dbName?: string;
  vpcSecurityGroupIds: string[];
  dbSubnetGroupName?: string;
  backupRetentionPeriod: number;
  multiAz: boolean;
  storageEncrypted: boolean;
  /** RDS-native deletion protection; doubles as the framework `protect` signal. */
  deletionProtection: boolean;
  publiclyAccessible: boolean;
}

/** Constructor options. Mirrors the DynamoDB provisioner option surface. */
export interface AwsRdsPostgresProvisionerOptions {
  client: RDSClient;
  region: string;
  /**
   * Optional DB-secret credsRef (config region/credsRef path). For RDS the
   * database's own master-password secret is normally declared on the spec via
   * `masterUserPassword`; this is a fallback/override used when present.
   */
  credsRef?: SecretRef;
  /** Allow destroy/replace of a deletion-protected instance (the "--force" path). */
  allowProtectedDestroy?: boolean;
  waitFor?: WaitForOptions;
}
