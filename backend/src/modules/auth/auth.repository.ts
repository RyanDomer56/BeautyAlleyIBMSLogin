import { supabasePublic, requireServiceRole } from "../../db/supabase";
import { env } from "../../config/env";
import { AppError, CODES } from "../../lib/errors";
import type { Role } from "../../types/actor";

/**
 * Auth data access. Everything that touches GoTrue or the two tables that
 * back brute-force protection lives here; the service layer above it deals
 * only in domain terms.
 */

export interface ProfileRow {
  id: string;
  role: Role;
  full_name: string | null;
  phone: string | null;
  is_active: boolean;
}

export const authRepository = {
  async signUp(email: string, password: string, fullName: string, phone?: string) {
    // `data` lands in raw_user_meta_data, which the handle_new_auth_user
    // trigger reads to populate the profile. It is user-controlled, so the
    // trigger only takes full_name and phone from it - never the role.
    const { data, error } = await supabasePublic.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, ...(phone ? { phone } : {}) } },
    });
    if (error) throw error;
    return data;
  },

  async signIn(email: string, password: string) {
    const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async refresh(refreshToken: string) {
    const { data, error } = await supabasePublic.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return data;
  },

  /**
   * Revoke a session.
   *
   * This process is stateless - it holds no session - so the plain
   * `auth.signOut()` would revoke nothing. Revoking the *refresh token* is the
   * part that matters: without it a stolen refresh token stays usable until it
   * expires. Scope is "global" so every session for the account dies, which is
   * the right default on a shared front-desk terminal.
   */
  async signOut(accessToken: string) {
    const db = requireServiceRole();
    const { error } = await db.auth.admin.signOut(accessToken, "global");
    if (error) throw error;
  },

  async getProfile(id: string): Promise<ProfileRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("profiles")
      .select("id, role, full_name, phone, is_active")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as ProfileRow) ?? null;
  },

  async updateProfile(id: string, patch: { full_name?: string; phone?: string }) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("profiles")
      .update(patch)
      .eq("id", id)
      .select("id, role, full_name, phone, is_active")
      .single();
    if (error) throw error;
    return data as ProfileRow;
  },

  /**
   * Create an account with a role already set.
   *
   * The role is written to `app_metadata`, which only the service role can
   * set - a user signing themselves up cannot reach it. That is the whole
   * reason staff accounts are created through this path rather than by
   * registering and then promoting: promotion via a user-writable field would
   * be a privilege-escalation hole.
   */
  async adminCreateUser(
    email: string,
    password: string,
    fullName: string,
    role: Role
  ): Promise<string> {
    const db = requireServiceRole();
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role },
      user_metadata: { full_name: fullName },
    });
    if (error) throw error;
    if (!data.user) throw AppError.internal("User creation returned no user");
    return data.user.id;
  },

  /** Count failed sign-ins for an email inside the lockout window. */
  async countRecentFailures(email: string): Promise<number> {
    const db = requireServiceRole();
    const since = new Date(Date.now() - env.loginLockoutMinutes * 60_000).toISOString();
    const { count, error } = await db
      .from("login_attempts")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .eq("succeeded", false)
      .gte("created_at", since);
    if (error) throw error;
    return count ?? 0;
  },

  async recordAttempt(email: string, succeeded: boolean, ip: string | null) {
    const db = requireServiceRole();
    // Best-effort: a failure to write the audit row must not turn a successful
    // login into an error for the user.
    const { error } = await db
      .from("login_attempts")
      .insert({ email, succeeded, ip: ip || null });
    if (error) return;
  },

  /** Clear failures after a success, so a legitimate user is not locked out by their own typo history. */
  async clearFailures(email: string) {
    const db = requireServiceRole();
    await db.from("login_attempts").delete().eq("email", email).eq("succeeded", false);
  },
};

export { CODES };
