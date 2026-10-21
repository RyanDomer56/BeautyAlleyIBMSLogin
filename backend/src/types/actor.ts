/**
 * The four roles the requirements document names, plus GUEST.
 *
 * GUEST is not a row in `public.profiles` - it is what the actor resolver
 * produces for an unauthenticated caller, so a handler never has to deal with
 * a null actor.
 *
 * `STAFF` is gone: migration 24 renamed the enum value to EMPLOYEE, which is
 * what the document calls the service floor, and split the front desk out into
 * CONCIERGE (migration 20). A stale `"STAFF"` string now fails to type-check
 * rather than silently matching nothing at runtime.
 */
export type Role = "GUEST" | "CLIENT" | "EMPLOYEE" | "CONCIERGE" | "ADMIN";

/**
 * The authenticated caller, resolved once per request.
 *
 * `role` comes from `public.profiles`, never from the token payload. A JWT can
 * carry a stale or forged role claim; the profile row is the authority, and it
 * is the same row the database's own policies consult.
 */
export interface Actor {
  id: string;
  email: string | null;
  role: Role;
  fullName: string | null;
  /** Set when this account is linked to a clients row. */
  clientId: string | null;
  /** Set when this account is linked to an employees row. */
  employeeId: string | null;
  isActive: boolean;
  accessToken: string;
}
