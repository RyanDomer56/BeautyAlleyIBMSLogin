import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, hasServiceRoleKey } from "../config/env";
import { AppError } from "../lib/errors";
import type { Database } from "../types/database";

const CLIENT_OPTS = {
  auth: {
    // This is a server. There is no browser session to persist or refresh -
    // each request carries its own token.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
} as const;

export type DbClient = SupabaseClient<Database>;

/**
 * Anonymous client. Row Level Security applies exactly as it would for a
 * browser. Used for sign-up / sign-in / refresh, where the publishable key is
 * the correct credential.
 */
export const supabasePublic: DbClient = createClient<Database>(
  env.supabaseUrl,
  env.supabaseAnonKey,
  CLIENT_OPTS
);

let serviceClient: DbClient | null = null;

/**
 * Service-role client. Bypasses Row Level Security entirely.
 *
 * Created lazily rather than at import time, so the process can boot and serve
 * the endpoints that do not need it (health, catalogue, availability) even when
 * the key has not been supplied yet. Callers that genuinely need it get a clear
 * 503 instead of an obscure failure.
 */
export function requireServiceRole(): DbClient {
  if (!hasServiceRoleKey) {
    throw AppError.config(
      "SUPABASE_SERVICE_ROLE_KEY is not configured, so this endpoint is unavailable. " +
        "Add it to backend/.env and restart."
    );
  }
  if (!serviceClient) {
    serviceClient = createClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, CLIENT_OPTS);
  }
  return serviceClient;
}

/**
 * A client that acts *as the calling user*: the access token is forwarded, so
 * Postgres sees `auth.uid()` and the RLS policies apply as that user rather
 * than as service_role. Use this whenever the request is on behalf of a client
 * and the database should be the thing enforcing access.
 *
 * Currently unused by the modules - the backend reads through service_role and
 * enforces access in the service layer, per DESIGN.md §3. It exists because
 * the integration tests need it to prove the RLS policies actually hold.
 */
export function supabaseAs(accessToken: string): DbClient {
  return createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
    ...CLIENT_OPTS,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
