import { env } from "../../config/env";
import { AppError, CODES } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { authRepository } from "./auth.repository";
import type { CreateStaffInput, LoginInput, RegisterInput } from "./auth.schemas";
import type { Actor } from "../../types/actor";

/**
 * Auth service.
 *
 * A note on the brute-force lockout, because the placement is deliberate.
 *
 * The in-process rate limiter (see middleware/rateLimit.ts) counts requests
 * per IP. That is the wrong axis for this control: an attacker with a pool of
 * addresses spreads attempts across them and never trips it, while a shared
 * office IP trips it for everyone. Worse, the counter dies with the process,
 * so a restart resets it.
 *
 * So the real lockout is counted in `public.login_attempts`, keyed by the
 * email being attacked, in the database. It survives restarts and is not
 * evaded by rotating IPs. The IP limiter stays as a cheap first line.
 */
export const authService = {
  async register(input: RegisterInput, ip: string | null) {
    const data = await authRepository.signUp(
      input.email,
      input.password,
      input.fullName,
      input.phone
    );

    // Supabase obfuscates "this email is taken" by returning a user with an
    // empty identities array rather than an error. Detecting it here lets us
    // give an honest 409 instead of a confusing success with no session.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw AppError.conflict(CODES.CONFLICT, "An account with that email already exists");
    }

    logger.info("auth.register", { email: input.email, ip });

    return {
      user: data.user
        ? { id: data.user.id, email: data.user.email ?? null, role: "CLIENT" as const }
        : null,
      // Null when email confirmation is switched on - the account exists but
      // cannot sign in until the address is verified.
      session: data.session
        ? {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresAt: data.session.expires_at,
          }
        : null,
      requiresEmailConfirmation: !data.session,
    };
  },

  async login(input: LoginInput, ip: string | null) {
    const failures = await authRepository.countRecentFailures(input.email);
    if (failures >= env.loginMaxAttempts) {
      logger.warn("auth.locked_out", { email: input.email, failures, ip });
      throw AppError.forbidden(
        CODES.ACCOUNT_LOCKED,
        `Too many failed attempts. Try again in ${env.loginLockoutMinutes} minutes.`
      );
    }

    let session;
    try {
      session = await authRepository.signIn(input.email, input.password);
    } catch (err) {
      await authRepository.recordAttempt(input.email, false, ip);
      throw err;
    }

    const user = session.user;
    if (!user) throw AppError.unauthorized(CODES.INVALID_CREDENTIALS, "Email or password is incorrect");

    const profile = await authRepository.getProfile(user.id);
    if (!profile) {
      // The account exists but the profile row is missing, so there is no role
      // to act with. Refuse rather than defaulting to something.
      throw AppError.forbidden(CODES.ACCOUNT_DISABLED, "This account is not fully set up");
    }
    if (!profile.is_active) {
      throw AppError.forbidden(CODES.ACCOUNT_DISABLED, "This account has been disabled");
    }

    await authRepository.clearFailures(input.email);
    await authRepository.recordAttempt(input.email, true, ip);

    logger.info("auth.login", { userId: user.id, role: profile.role, ip });

    return {
      user: {
        id: user.id,
        email: user.email ?? null,
        role: profile.role,
        fullName: profile.full_name,
      },
      session: {
        accessToken: session.session!.access_token,
        refreshToken: session.session!.refresh_token,
        expiresAt: session.session!.expires_at,
      },
    };
  },

  async refresh(refreshToken: string) {
    const data = await authRepository.refresh(refreshToken);
    if (!data.session || !data.user) {
      throw AppError.unauthorized(CODES.UNAUTHENTICATED, "Session could not be refreshed");
    }
    return {
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      },
    };
  },

  async logout(accessToken: string) {
    await authRepository.signOut(accessToken);
  },

  async me(actor: Actor) {
    const profile = await authRepository.getProfile(actor.id);
    if (!profile) throw AppError.notFound(CODES.NOT_FOUND, "Profile not found");
    return {
      id: profile.id,
      email: actor.email,
      role: profile.role,
      fullName: profile.full_name,
      phone: profile.phone,
      clientId: actor.clientId,
      employeeId: actor.employeeId,
    };
  },

  /**
   * Create a staff or admin account. The role is set through the admin API,
   * which is the only path that can write `app_metadata` - so this cannot be
   * reached by a user promoting themselves.
   */
  async createStaff(input: CreateStaffInput, actor: Actor) {
    const userId = await authRepository.adminCreateUser(
      input.email,
      input.password,
      input.fullName,
      input.role
    );
    logger.info("auth.staff_created", { userId, role: input.role, by: actor.id });
    return { id: userId, email: input.email, role: input.role, fullName: input.fullName };
  },
};
