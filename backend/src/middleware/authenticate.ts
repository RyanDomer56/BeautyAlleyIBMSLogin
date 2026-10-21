import type { NextFunction, Request, Response } from "express";
import { supabaseAs, supabasePublic } from "../db/supabase";
import { AppError, CODES } from "../lib/errors";
import type { Actor, Role } from "../types/actor";

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim() || null;
}

/**
 * Resolve a bearer token into an Actor.
 *
 * Two deliberate choices here.
 *
 * 1. The token is validated by asking GoTrue (`auth.getUser`) rather than by
 *    verifying the signature locally. Local verification needs the project's
 *    JWT secret, which is deliberately not exposed to this process. The round
 *    trip also means a revoked session is rejected immediately, instead of
 *    staying valid until the token expires.
 *
 * 2. The profile and the linked client/employee rows are read with the
 *    *caller's own* token, not the service role. So the read is subject to the
 *    same RLS policies a browser would face - `profiles_select_own`,
 *    `clients_select_own`, `employees_public_read`. If a policy is ever
 *    loosened, this code inherits that mistake instead of silently papering
 *    over it with BYPASSRLS.
 */
async function resolveActor(token: string): Promise<Actor | null> {
  const { data, error } = await supabasePublic.auth.getUser(token);
  if (error || !data?.user) return null;

  const user = data.user;
  const asUser = supabaseAs(token);

  const { data: profile, error: profileError } = await asUser
    .from("profiles")
    .select("id, role, full_name, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw profileError;

  // The `handle_new_auth_user` trigger creates this row on sign-up. If it is
  // missing, the account exists but has no application identity - treat that
  // as unauthenticated rather than inventing a role.
  if (!profile) return null;

  const [clientRow, employeeRow] = await Promise.all([
    asUser.from("clients").select("id").eq("profile_id", user.id).maybeSingle(),
    asUser.from("employees").select("id").eq("profile_id", user.id).maybeSingle(),
  ]);

  return {
    id: user.id,
    email: user.email ?? null,
    role: profile.role as Role,
    fullName: profile.full_name ?? null,
    clientId: clientRow.data?.id ?? null,
    employeeId: employeeRow.data?.id ?? null,
    isActive: profile.is_active !== false,
    accessToken: token,
  };
}

/** Requires a valid, active session. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    if (!token) return next(AppError.unauthorized());

    const actor = await resolveActor(token);
    if (!actor) return next(AppError.unauthorized());

    if (!actor.isActive) {
      return next(AppError.forbidden(CODES.ACCOUNT_DISABLED, "This account has been disabled"));
    }

    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Attaches an actor when a valid token is present, and does nothing when it is
 * not. For endpoints that serve both guests and signed-in clients - creating a
 * booking, validating a promo - where being logged in changes *who* the booking
 * belongs to but is not a requirement.
 */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    if (!token) return next();

    const actor = await resolveActor(token);
    if (actor && actor.isActive) req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}
