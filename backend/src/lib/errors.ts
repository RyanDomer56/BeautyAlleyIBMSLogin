/**
 * Error vocabulary.
 *
 * The database functions in migration 10 signal failures with
 * `raise exception 'CODE' using errcode = '<class>'`. This module is the one
 * place that translates those into HTTP. Keeping the mapping in a single table
 * means a new error code cannot be added to SQL without a matching status
 * here - and anything unmapped falls back to 500 rather than leaking a raw
 * Postgres message to the client.
 */

export const CODES = {
  // --- 400 bad request -----------------------------------------------------
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** A `?page=` past the last page. PostgREST's PGRST103/416, made legible. */
  PAGE_OUT_OF_RANGE: "PAGE_OUT_OF_RANGE",
  SERVICES_REQUIRED: "SERVICES_REQUIRED",
  SERVICES_INVALID: "SERVICES_INVALID",
  START_TIME_REQUIRED: "START_TIME_REQUIRED",
  START_TIME_IN_PAST: "START_TIME_IN_PAST",
  CLIENT_REQUIRED: "CLIENT_REQUIRED",
  OUTSIDE_WORKING_HOURS: "OUTSIDE_WORKING_HOURS",
  CANCELLATION_WINDOW_PASSED: "CANCELLATION_WINDOW_PASSED",
  QR_INVALID: "QR_INVALID",
  QR_EXPIRED: "QR_EXPIRED",
  QR_TOO_EARLY: "QR_TOO_EARLY",
  QR_TOO_LATE: "QR_TOO_LATE",
  ROOM_REQUIRED: "ROOM_REQUIRED",
  ROOM_TYPE_MISMATCH: "ROOM_TYPE_MISMATCH",
  NO_ACTIVE_SESSION: "NO_ACTIVE_SESSION",
  /** Migration 34. A shift that ends before it starts. */
  WORKING_HOURS_INVALID: "WORKING_HOURS_INVALID",

  // --- 401 / 403 -----------------------------------------------------------
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  FORBIDDEN: "FORBIDDEN",
  EMPLOYEE_NOT_QUALIFIED: "EMPLOYEE_NOT_QUALIFIED",
  INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE",
  NOT_TASK_OWNER: "NOT_TASK_OWNER",

  // --- 404 -----------------------------------------------------------------
  NOT_FOUND: "NOT_FOUND",
  BOOKING_NOT_FOUND: "BOOKING_NOT_FOUND",
  EMPLOYEE_NOT_FOUND: "EMPLOYEE_NOT_FOUND",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  CLIENT_NOT_FOUND: "CLIENT_NOT_FOUND",
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  ATTENDANCE_NOT_FOUND: "ATTENDANCE_NOT_FOUND",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",

  // --- 409 conflict --------------------------------------------------------
  SLOT_TAKEN: "SLOT_TAKEN",
  ROOM_TAKEN: "ROOM_TAKEN",
  NO_ROOM_AVAILABLE: "NO_ROOM_AVAILABLE",
  NOT_ELIGIBLE_FOR_MEMBERSHIP: "NOT_ELIGIBLE_FOR_MEMBERSHIP",
  ALREADY_CHECKED_IN: "ALREADY_CHECKED_IN",
  ALREADY_CANCELLED: "ALREADY_CANCELLED",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  BOOKING_IN_PROGRESS: "BOOKING_IN_PROGRESS",
  EMPLOYEE_UNAVAILABLE: "EMPLOYEE_UNAVAILABLE",
  USE_CANCEL_BOOKING: "USE_CANCEL_BOOKING",
  ALREADY_TIMED_IN: "ALREADY_TIMED_IN",
  ALREADY_TIMED_OUT: "ALREADY_TIMED_OUT",
  TASK_STATUS_TRANSITION: "TASK_STATUS_TRANSITION",
  DUPLICATE_TASK: "DUPLICATE_TASK",
  /** Migration 34. Raised by deactivate_room(); the message carries the count. */
  ROOM_STILL_BOOKED: "ROOM_STILL_BOOKED",
  CONFLICT: "CONFLICT",

  // --- 429 -----------------------------------------------------------------
  RATE_LIMITED: "RATE_LIMITED",

  // --- 503 -----------------------------------------------------------------
  CONFIG_ERROR: "CONFIG_ERROR",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",

  // --- 500 -----------------------------------------------------------------
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  /** Safe to serialise to the client. */
  readonly details?: unknown;
  /** Internal only - logged, never sent. */
  override readonly cause?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    cause?: string
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }

  // `code` is typed as `string` rather than `ErrorCode` on purpose: the
  // mapping tables in this file are the source of truth, and a caller passing
  // a code that is not in them should be a runtime 500, not a compile error
  // that pushes people to cast.
  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(code: string = CODES.UNAUTHENTICATED, message = "Authentication required") {
    return new AppError(401, code, message);
  }
  static forbidden(code: string = CODES.FORBIDDEN, message = "Not permitted") {
    return new AppError(403, code, message);
  }
  static notFound(code: string = CODES.NOT_FOUND, message = "Not found") {
    return new AppError(404, code, message);
  }
  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(409, code, message, details);
  }
  static config(message: string) {
    return new AppError(503, CODES.CONFIG_ERROR, message);
  }
  static internal(message = "Something went wrong") {
    return new AppError(500, CODES.INTERNAL, message);
  }
}

/**
 * Error codes raised by the PL/pgSQL functions, mapped to HTTP status.
 * Keep in step with the `raise exception` calls in 10_functions.sql.
 */
const PG_FUNCTION_ERRORS: Record<string, { status: number; code: string }> = {
  SLOT_TAKEN: { status: 409, code: CODES.SLOT_TAKEN },
  SERVICES_REQUIRED: { status: 400, code: CODES.SERVICES_REQUIRED },
  SERVICES_INVALID: { status: 400, code: CODES.SERVICES_INVALID },
  START_TIME_REQUIRED: { status: 400, code: CODES.START_TIME_REQUIRED },
  START_TIME_IN_PAST: { status: 400, code: CODES.START_TIME_IN_PAST },
  CLIENT_REQUIRED: { status: 400, code: CODES.CLIENT_REQUIRED },
  OUTSIDE_WORKING_HOURS: { status: 400, code: CODES.OUTSIDE_WORKING_HOURS },
  CANCELLATION_WINDOW_PASSED: { status: 400, code: CODES.CANCELLATION_WINDOW_PASSED },
  EMPLOYEE_NOT_QUALIFIED: { status: 403, code: CODES.EMPLOYEE_NOT_QUALIFIED },
  EMPLOYEE_NOT_FOUND: { status: 404, code: CODES.EMPLOYEE_NOT_FOUND },
  NO_EMPLOYEE_AVAILABLE: { status: 409, code: CODES.SLOT_TAKEN },
  BOOKING_NOT_FOUND: { status: 404, code: CODES.BOOKING_NOT_FOUND },
  ALREADY_CANCELLED: { status: 409, code: CODES.ALREADY_CANCELLED },
  ALREADY_CHECKED_IN: { status: 409, code: CODES.ALREADY_CHECKED_IN },
  INVALID_STATUS_TRANSITION: { status: 409, code: CODES.INVALID_STATUS_TRANSITION },
  QR_INVALID: { status: 400, code: CODES.QR_INVALID },
  QR_EXPIRED: { status: 400, code: CODES.QR_EXPIRED },
  QR_REVOKED: { status: 400, code: CODES.QR_INVALID },
  QR_TOO_EARLY: { status: 400, code: CODES.QR_TOO_EARLY },
  QR_TOO_LATE: { status: 400, code: CODES.QR_TOO_LATE },
  // --- migration 18: rooms and membership ----------------------------------
  ROOM_REQUIRED: { status: 400, code: CODES.ROOM_REQUIRED },
  ROOM_TYPE_MISMATCH: { status: 400, code: CODES.ROOM_TYPE_MISMATCH },
  ROOM_NOT_FOUND: { status: 404, code: CODES.ROOM_NOT_FOUND },
  ROOM_TAKEN: { status: 409, code: CODES.ROOM_TAKEN },
  NO_ROOM_AVAILABLE: { status: 409, code: CODES.NO_ROOM_AVAILABLE },
  CLIENT_NOT_FOUND: { status: 404, code: CODES.CLIENT_NOT_FOUND },
  NOT_ELIGIBLE_FOR_MEMBERSHIP: { status: 409, code: CODES.NOT_ELIGIBLE_FOR_MEMBERSHIP },
  // --- migration 30: tasks -------------------------------------------------
  TASK_STATUS_TRANSITION: { status: 409, code: CODES.TASK_STATUS_TRANSITION },
  // --- migration 32/33: booking correctness --------------------------------
  // The service was already under way, so its appointment time is a record
  // rather than a plan. 409, because the request is well formed and the
  // booking simply is not in a state that accepts it.
  BOOKING_IN_PROGRESS: { status: 409, code: CODES.BOOKING_IN_PROGRESS },
  // The named employee is on leave for that window.
  EMPLOYEE_UNAVAILABLE: { status: 409, code: CODES.EMPLOYEE_UNAVAILABLE },
  // set_booking_status refuses CANCELLED on purpose. Reaching this means the
  // service routed a cancellation past cancel_booking(), which is a bug.
  USE_CANCEL_BOOKING: { status: 409, code: CODES.USE_CANCEL_BOOKING },
  // --- migration 34: atomicity --------------------------------------------
  // A shift that ends before it starts. 400, and raised *before* the delete in
  // replace_working_hours, so the stylist keeps the hours they already had.
  WORKING_HOURS_INVALID: { status: 400, code: CODES.WORKING_HOURS_INVALID },
  ROOM_STILL_BOOKED: { status: 409, code: CODES.ROOM_STILL_BOOKED },
  PROFILE_NOT_FOUND: { status: 404, code: CODES.PROFILE_NOT_FOUND },
};

/** SQLSTATE classes we care about. */
const PG_SQLSTATE: Record<string, { status: number; code: string }> = {
  "23P01": { status: 409, code: CODES.SLOT_TAKEN }, // exclusion_violation
  "23505": { status: 409, code: CODES.CONFLICT }, // unique_violation
  "23503": { status: 400, code: CODES.VALIDATION_FAILED }, // foreign_key_violation
  "23514": { status: 400, code: CODES.VALIDATION_FAILED }, // check_violation
  "22P02": { status: 400, code: CODES.VALIDATION_FAILED }, // invalid_text_representation
  "42501": { status: 403, code: CODES.FORBIDDEN }, // insufficient_privilege
  PGRST116: { status: 404, code: CODES.NOT_FOUND }, // PostgREST: no rows
  // PostgREST answers a `range()` that starts past the last row with HTTP 416.
  // Unmapped, that surfaced as a 500 on every paginated endpoint - a stale
  // `?page=9` link, or one click past the end. The request is well formed and
  // the collection exists, so 400 with a precise code beats 500.
  PGRST103: { status: 400, code: CODES.PAGE_OUT_OF_RANGE }, // range not satisfiable
};

/** PROMO_* codes all carry the same status. */
function promoError(message: string): { status: number; code: string } | null {
  return message.startsWith("PROMO_")
    ? { status: 400, code: message }
    : null;
}

/**
 * The error code our own functions raise, read off the front of the message.
 *
 * Migrations raise either `'CODE'` or `'CODE: detail'` - the status-transition
 * trigger raises `INVALID_STATUS_TRANSITION: COMPLETED -> PENDING`, for
 * instance, so that the log says which transition was attempted. Matching the
 * whole message would miss those and report a 500, so the code is taken as the
 * text before the first colon.
 *
 * Anything else - Postgres's own messages, which can contain colons - is not in
 * the table and falls through to the 500 path, which is the safe direction: an
 * unrecognised message is never echoed to the client.
 */
function functionErrorCode(message: string): string | null {
  const head = message.trim().split(":", 1)[0].trim().toUpperCase();
  if (PG_FUNCTION_ERRORS[head] || head.startsWith("PROMO_")) return head;
  return null;
}

/**
 * Normalise anything thrown by supabase-js / pg into an AppError.
 *
 * Raw Postgres messages are never forwarded to the client: they can name
 * tables, columns and constraints, and occasionally echo row data. The
 * original is attached as `details.cause` for the logs only.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const anyErr = err as {
    message?: string;
    code?: string;
    details?: string;
    status?: number;
    statusCode?: number;
    type?: string;
  } | null;
  const message = typeof anyErr?.message === "string" ? anyErr.message : "";
  const code = typeof anyErr?.code === "string" ? anyErr.code : "";

  // 0. Errors raised by Express's own middleware.
  //
  // express.json() throws a SyntaxError carrying `status: 400` and
  // `type: 'entity.parse.failed'` when the body is not valid JSON. Without this
  // branch it falls through to the 500 fallback, and a client typo is reported
  // as a server fault - which then shows up in error dashboards as an outage.
  //
  // The discriminator is `type`, NOT `status`. supabase-js's AuthApiError also
  // carries `status: 400` (bad password, weak password, duplicate signup), and
  // matching on status alone reported a wrong password as VALIDATION_FAILED/400
  // instead of INVALID_CREDENTIALS/401 - the message checks further down never
  // ran. Only body-parser errors use the `entity.*` namespace.
  const bodyParserType = typeof anyErr?.type === "string" ? anyErr.type : "";
  if (bodyParserType === "entity.parse.failed") {
    return new AppError(400, CODES.VALIDATION_FAILED, "The request body is not valid JSON");
  }
  if (bodyParserType === "entity.too.large") {
    return new AppError(413, CODES.VALIDATION_FAILED, "The request body is too large");
  }
  if (bodyParserType.startsWith("entity.") || bodyParserType === "charset.unsupported") {
    const status = anyErr?.status ?? anyErr?.statusCode;
    return new AppError(
      typeof status === "number" && status >= 400 && status < 500 ? status : 400,
      CODES.VALIDATION_FAILED,
      "The request could not be processed"
    );
  }

  // 1. SQLSTATE - checked first, it is the most reliable signal.
  const byState = code ? PG_SQLSTATE[code] : undefined;
  if (byState) {
    // A unique violation on the booking reference is worth naming precisely.
    if (code === "23505" && /reference/i.test(anyErr?.details || message)) {
      return new AppError(409, CODES.CONFLICT, "Booking reference collision, please retry", undefined, message);
    }
    // Two different constraints raise 23P01 and they mean different things to
    // the person at the desk: the stylist is busy, or the room is. Postgres
    // names the constraint in the message, so the distinction is available -
    // reporting both as SLOT_TAKEN would send them looking for the wrong
    // problem. This is the path taken when the raw insert (not create_booking,
    // which discriminates for itself) is the one that trips.
    if (code === "23P01" && /bookings_room_no_overlap/.test(`${message} ${anyErr?.details ?? ""}`)) {
      return new AppError(409, CODES.ROOM_TAKEN, humanise(CODES.ROOM_TAKEN), undefined, message);
    }
    return new AppError(byState.status, byState.code, humanise(byState.code), undefined, message);
  }

  // 2. Raised by our own functions, which put the code at the front of the
  // message.
  const fnCode = functionErrorCode(message);
  if (fnCode) {
    const byFn = PG_FUNCTION_ERRORS[fnCode];
    if (byFn) {
      return new AppError(byFn.status, byFn.code, humanise(byFn.code), undefined, message);
    }

    const byPromo = promoError(fnCode);
    if (byPromo) {
      return new AppError(byPromo.status, byPromo.code, humanise(byPromo.code));
    }
  }

  // 3. Supabase Auth. `AuthApiError.code` is the stable machine-readable
  // signal; the message is a fallback for older GoTrue versions that omit it.
  const AUTH_CODES: Record<string, { status: number; code: string; message: string }> = {
    invalid_credentials: {
      status: 401,
      code: CODES.INVALID_CREDENTIALS,
      message: "Email or password is incorrect",
    },
    email_not_confirmed: {
      status: 403,
      code: CODES.FORBIDDEN,
      message: "Email address has not been confirmed",
    },
    user_already_exists: {
      status: 409,
      code: CODES.CONFLICT,
      message: "An account with that email already exists",
    },
    email_exists: {
      status: 409,
      code: CODES.CONFLICT,
      message: "An account with that email already exists",
    },
    weak_password: {
      status: 400,
      code: CODES.VALIDATION_FAILED,
      message: "That password is too weak",
    },
    over_email_send_rate_limit: {
      status: 429,
      code: CODES.RATE_LIMITED,
      message: "Too many emails sent. Please wait before trying again.",
    },
    over_request_rate_limit: {
      status: 429,
      code: CODES.RATE_LIMITED,
      message: "Too many requests. Please slow down.",
    },
    same_password: {
      status: 400,
      code: CODES.VALIDATION_FAILED,
      message: "The new password must differ from the current one",
    },
    user_banned: {
      status: 403,
      code: CODES.ACCOUNT_DISABLED,
      message: "This account has been disabled",
    },
  };

  const byAuthCode = code ? AUTH_CODES[code] : undefined;
  if (byAuthCode) {
    return new AppError(byAuthCode.status, byAuthCode.code, byAuthCode.message);
  }

  if (/invalid login credentials/i.test(message)) {
    return AppError.unauthorized(CODES.INVALID_CREDENTIALS, "Email or password is incorrect");
  }
  if (/email not confirmed/i.test(message)) {
    return AppError.forbidden(CODES.FORBIDDEN, "Email address has not been confirmed");
  }
  if (/user already registered|already been registered/i.test(message)) {
    return AppError.conflict(CODES.CONFLICT, "An account with that email already exists");
  }

  // Nothing matched. The client gets a generic 500 - but the original message
  // is carried on `cause` so the log has something to work with. Dropping it
  // here would mean every unmapped failure is undiagnosable.
  return new AppError(500, CODES.INTERNAL, "Something went wrong", undefined, message || undefined);
}

const MESSAGES: Record<string, string> = {
  [CODES.SLOT_TAKEN]: "That time slot has just been taken. Please pick another.",
  [CODES.SERVICES_REQUIRED]: "At least one service is required.",
  [CODES.SERVICES_INVALID]: "One or more services are unknown or inactive.",
  [CODES.START_TIME_REQUIRED]: "A start time is required.",
  [CODES.START_TIME_IN_PAST]: "The start time must be in the future.",
  [CODES.CLIENT_REQUIRED]: "Provide either a client id or a guest phone number.",
  [CODES.OUTSIDE_WORKING_HOURS]: "That time is outside the stylist's working hours.",
  [CODES.CANCELLATION_WINDOW_PASSED]:
    "This booking can no longer be cancelled online. Please call the salon.",
  [CODES.EMPLOYEE_NOT_QUALIFIED]: "That stylist does not deliver the selected service.",
  [CODES.EMPLOYEE_NOT_FOUND]: "No such employee.",
  [CODES.BOOKING_NOT_FOUND]: "No such booking.",
  [CODES.ALREADY_CANCELLED]: "This booking is already cancelled.",
  [CODES.ALREADY_CHECKED_IN]: "This booking has already been checked in.",
  [CODES.BOOKING_IN_PROGRESS]:
    "This appointment has already started, so its time can no longer be moved.",
  [CODES.EMPLOYEE_UNAVAILABLE]: "That stylist is on leave during that time.",
  [CODES.USE_CANCEL_BOOKING]: "Use the cancel endpoint to cancel a booking.",
  [CODES.INVALID_STATUS_TRANSITION]: "That status change is not allowed.",
  [CODES.QR_INVALID]: "That check-in code is not valid.",
  [CODES.QR_EXPIRED]: "That check-in code has expired.",
  [CODES.QR_TOO_EARLY]: "This pass is not active yet.",
  [CODES.QR_TOO_LATE]: "This appointment has already ended.",
  [CODES.ROOM_TAKEN]: "That room is already booked for that time.",
  [CODES.NO_ROOM_AVAILABLE]: "No room of the right type is free at that time.",
  [CODES.ROOM_REQUIRED]:
    "These services need more than one kind of room. Choose a room at the desk.",
  [CODES.ROOM_TYPE_MISMATCH]: "That room is not equipped for this service.",
  [CODES.ROOM_NOT_FOUND]: "No such room.",
  [CODES.NOT_ELIGIBLE_FOR_MEMBERSHIP]:
    "This client has not completed enough visits to become a member yet.",
  [CODES.CLIENT_NOT_FOUND]: "No such client.",
  [CODES.CONFLICT]: "That conflicts with an existing record.",
  [CODES.VALIDATION_FAILED]: "The request contained invalid data.",
  [CODES.PAGE_OUT_OF_RANGE]: "That page is past the end of the list.",
  [CODES.FORBIDDEN]: "You do not have access to that.",
  [CODES.ALREADY_TIMED_IN]: "You have already timed in today.",
  [CODES.ALREADY_TIMED_OUT]: "You have already timed out today.",
  [CODES.NO_ACTIVE_SESSION]: "There is no open session to time out of. Time in first.",
  [CODES.ATTENDANCE_NOT_FOUND]: "No attendance record for that day.",
  [CODES.TASK_NOT_FOUND]: "No such task.",
  [CODES.NOT_TASK_OWNER]: "That task is assigned to someone else.",
  [CODES.TASK_STATUS_TRANSITION]: "That status change is not allowed for this task.",
  [CODES.DUPLICATE_TASK]: "An open task with that title already exists for this employee.",
  [CODES.WORKING_HOURS_INVALID]: "Each shift must end after it starts.",
  [CODES.ROOM_STILL_BOOKED]:
    "That room still has bookings that have not finished. Move them before decommissioning it.",
  [CODES.PROFILE_NOT_FOUND]: "No profile for that account.",
};

function humanise(code: string): string {
  if (MESSAGES[code]) return MESSAGES[code];
  if (code.startsWith("PROMO_")) {
    const reason = code.slice("PROMO_".length);
    const reasons: Record<string, string> = {
      NOT_FOUND: "That promo code does not exist.",
      INACTIVE: "That promo code is no longer active.",
      NOT_STARTED: "That promo code is not active yet.",
      EXPIRED: "That promo code has expired.",
      MIN_SPEND_NOT_MET: "The booking total is below the minimum for that code.",
      NOT_APPLICABLE: "That promo code does not apply to the selected services.",
      LIMIT_REACHED: "That promo code has reached its redemption limit.",
    };
    return reasons[reason] || "That promo code cannot be applied.";
  }
  return "Something went wrong.";
}
