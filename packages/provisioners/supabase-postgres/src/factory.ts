/**
 * Factory for the Supabase Postgres provisioner.
 *
 * Mirrors aws-dynamodb's `createDynamoDBProvisioner`, but instead of building
 * an SDK client it wires a tokenProvider (resolving the provider's access token
 * from a tokenRef POINTER) into a {@link SupabaseManagementClient}. The token
 * VALUE is resolved lazily per request and never logged.
 */
import { SupabaseManagementClient, resolveSecret } from "./client.js";
import { SupabasePostgresProvisioner } from "./provisioner.js";
import type { SupabasePostgresProvisionerFactoryOptions } from "./types.js";

export function createSupabasePostgresProvisioner(
  opts: SupabasePostgresProvisionerFactoryOptions,
): SupabasePostgresProvisioner {
  // The token is resolved lazily on each request (it may rotate / expire), so
  // a fresh Bearer is read per call. Failures (e.g. missing env var) surface as
  // SupabaseConfigError via resolveSecret — propagated by the client.
  const tokenProvider = (): Promise<string> => resolveSecret(opts.tokenRef, opts.secretResolver);

  const client = new SupabaseManagementClient({
    tokenProvider,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });

  return new SupabasePostgresProvisioner({
    client,
    ...(opts.secretResolver ? { secretResolver: opts.secretResolver } : {}),
    ...(opts.allowProtectedDestroy !== undefined
      ? { allowProtectedDestroy: opts.allowProtectedDestroy }
      : {}),
    ...(opts.waitFor ? { waitFor: opts.waitFor } : {}),
  });
}
