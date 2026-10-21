/**
 * The wire shapes the backend actually sends.
 *
 * These mirror the DTOs in the backend's module services (`…service.ts`)
 * field for field. They are hand-written rather than generated because the
 * backend has no OpenAPI document and the `supabase gen types` route needs the
 * CLI, which this environment cannot run.
 *
 * Two conventions worth knowing, because both are easy to get wrong:
 *
 *   - Every timestamp is a `Z`-suffixed UTC instant. The backend normalises
 *     PostgREST's `+00:00` spelling to `Z` in its DTO layer, so a string
 *     comparison is safe. Render them in the branch timezone, never raw.
 *   - Money is in minor units (cents) everywhere, as `…Cents`. Never divide
 *     until the moment of display.
 */

/**
 * The four roles, mirroring the `public.user_role` enum after migration 24.
 *
 * There is no `"STAFF"`. It was renamed to EMPLOYEE, and CONCIERGE was split
 * out of it so the front desk could be given reception duties without also
 * handing over the owner's settings. A stale `"STAFF"` in a comparison now
 * fails to type-check rather than silently matching nobody.
 */
export type Role = "ADMIN" | "CONCIERGE" | "EMPLOYEE" | "CLIENT";

export type ServiceCategory = "SPA" | "SALON" | "WELLNESS";

export const SERVICE_CATEGORIES: ServiceCategory[] = ["SPA", "SALON", "WELLNESS"];

export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_SERVICE"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

export type PromoType = "PERCENT" | "FIXED";

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

/** `{ error: { code, message, details? } }` — the shape of every failure. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface Health {
  status: "ok" | "degraded";
  env: string;
  checks: { serviceRoleKey: boolean; timezone: string; database: string };
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export interface AuthUser {
  id: string;
  email: string | null;
  role: Role;
  fullName?: string | null;
}

export interface LoginResult {
  user: AuthUser & { fullName: string | null };
  session: Session;
}

export interface RegisterResult {
  user: AuthUser | null;
  /** Null when email confirmation is switched on. */
  session: Session | null;
  requiresEmailConfirmation: boolean;
}

/** `GET /auth/me` — richer than the login payload; carries the row ids. */
export interface Me {
  id: string;
  email: string | null;
  role: Role;
  fullName: string | null;
  phone: string | null;
  clientId: string | null;
  employeeId: string | null;
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

/** The second catalogue level, e.g. "IV Drips". */
export interface ServiceSubcategory {
  id: string;
  slug: string;
  name: string;
  category: ServiceCategory;
}

export interface Service {
  id: string;
  name: string;
  category: ServiceCategory;
  description: string | null;
  priceCents: number;
  durationMinutes: number;
  /**
   * The catalogue group. `null` means the salon floor — a haircut, a colour —
   * which has no subcategory because it is the default rather than a
   * classification.
   */
  subcategory: ServiceSubcategory | null;
  subcategoryId?: string | null;
  /**
   * The formulation as a display string, e.g. "Glutathione, Vitamin C".
   *
   * `null` together with `ingredientsVerified: false` means the salon has not
   * confirmed it. The UI must say so rather than invent a list — see
   * `Services.tsx`.
   */
  ingredients: string | null;
  ingredientsVerified: boolean;
  requiredRoomType?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkingHour {
  id: string;
  weekday: number;
  /** `HH:MM`, branch local. A `time` column — no date, no zone. */
  startTime: string;
  endTime: string;
}

export interface Employee {
  id: string;
  profileId: string | null;
  fullName: string;
  title: string | null;
  bio: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  serviceIds?: string[];
  /** Present only on the admin view; omitted from the public "meet the team" shape. */
  workingHours?: WorkingHour[];
}

/**
 * Progress against the daily completed-clients quota.
 *
 * Derived on read from COMPLETED bookings, so it self-corrects when a booking
 * is cancelled or re-opened - there is no counter to drift. `date` is a plain
 * calendar day resolved in the branch timezone, not an instant.
 */
export interface QuotaProgress {
  employeeId: string;
  employeeName: string;
  /** `YYYY-MM-DD`, in the branch timezone. */
  date: string;
  timezone: string;
  /** The target for one day. */
  quota: number;
  /** Clients whose service was actually delivered. */
  completed: number;
  /** Still to come today: PENDING, CONFIRMED, CHECKED_IN or IN_SERVICE. */
  scheduled: number;
  /** `quota - completed`, floored at zero. */
  remaining: number;
  met: boolean;
}

export interface Slot {
  start: string;
  end: string;
}

export interface Availability {
  serviceId: string;
  date: string;
  intervalMinutes: number;
  totalSlots: number;
  employees: { employeeId: string; slots: Slot[] }[];
}

/* ------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------ */

export interface BookingItem {
  id: string;
  serviceId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

export interface QrPass {
  pass: string;
  url: string;
  expiresAt: string;
}

export interface Booking {
  id: string;
  reference: string;
  status: BookingStatus;
  startTime: string;
  endTime: string;
  employee: { id: string; fullName: string };
  client: { id: string; fullName: string } | null;
  guest: { name: string; phone: string } | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  /** Null when the treatment needs no room, and for pre-migration-17 bookings. */
  room: { id: string; name: string; type: string } | null;
  /** The member rate this booking was priced at. 0 for non-members. */
  memberDiscountPercent: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: BookingItem[];
  /**
   * The service ids on this booking, denormalised onto the detail view in
   * migration 32. `items` carries the same information but only when the API
   * has loaded them, and `items[].serviceId` is nullable for services that
   * were deleted after the booking was made — this array never is.
   */
  serviceIds: string[];
  /** Only returned by create/reschedule — the pass is re-issuable via `/qr`. */
  qr?: QrPass;
}

export interface CreateBookingInput {
  serviceIds: string[];
  employeeId?: string;
  startTime: string;
  clientId?: string;
  guest?: { name: string; phone: string };
  promoCode?: string;
  notes?: string;
}

/** `GET /bookings/:id/qr` — either a live pass or "already used". */
export interface QrState {
  used: boolean;
  pass: string | null;
  url: string | null;
  expiresAt?: string;
  checkedInAt?: string | null;
}

export interface CheckInResult {
  bookingId: string;
  reference: string;
  status: BookingStatus;
  checkedInAt: string;
  checkinId: string;
}

export interface BranchQr {
  label: string;
  url: string;
  checkInWindowMinutes: number;
  /** Always false — stated by the API so nobody mistakes it for a credential. */
  authorises: boolean;
}

/* ------------------------------------------------------------------ *
 * Promos
 * ------------------------------------------------------------------ */

export interface Promo {
  id: string;
  code: string;
  type: PromoType;
  /** PERCENT: 1–100. FIXED: minor units. */
  value: number;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  perClientLimit: number | null;
  minSpendCents: number;
  applicableServiceIds: string[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  liveRedemptions?: number;
}

export interface PromoValidation {
  valid: boolean;
  reason: string;
  message: string;
  discountCents: number;
  promoCodeId: string | null;
  code: string;
  type: PromoType | null;
  value: number | null;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

export interface DashboardTotals {
  bookings: number;
  completed: number;
  cancelled: number;
  noShow: number;
  checkedIn: number;
  revenueCents: number;
}

export interface Dashboard {
  from: string;
  to: string;
  totals: DashboardTotals;
  byDay: { day: string; bookings: number; revenue_cents: number }[];
  topServices: { name: string; bookings: number; revenue_cents: number }[];
}

export interface ClientRecord {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  totalBookings: number;
  completedBookings: number;
  noShowBookings: number;
  lifetimeValueCents: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
}

export interface ClientDetail extends ClientRecord {
  recentBookings: {
    id: string;
    reference: string;
    status: BookingStatus;
    startTime: string;
    endTime: string;
    employeeName: string;
    totalCents: number;
    discountCents: number;
  }[];
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  actorRole: Role | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Attendance
 * ------------------------------------------------------------------ */

/** Mirrors `public.attendance_status`. */
export type AttendanceStatus = "PRESENT" | "HALF_DAY" | "LEAVE" | "ABSENT";

export const ATTENDANCE_STATUSES: AttendanceStatus[] = ["PRESENT", "HALF_DAY", "LEAVE", "ABSENT"];

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  /** `YYYY-MM-DD` in the branch timezone. A calendar day, not an instant. */
  date: string;
  timeIn: string;
  /** Null while the session is still open. */
  timeOut: string | null;
  status: AttendanceStatus;
  remarks: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  /** Null until the session closes — "not finished" is not "zero hours". */
  minutesWorked: number | null;
  hoursWorked: number | null;
  /** Minutes past the rostered start, or null when no shift is configured. */
  minutesLate: number | null;
  late: boolean;
  /** True while clocked in and not yet clocked out. */
  open: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceTotals {
  present: number;
  halfDay: number;
  leave: number;
  absent: number;
  /** Sessions still open right now. */
  open: number;
  /** Only closed sessions contribute to the hours. */
  completedDays: number;
  totalMinutes: number;
  totalHours: number;
  averageHours: number | null;
}

export interface AttendanceSummary {
  from: string;
  to: string;
  employeeId: string | null;
  totals: AttendanceTotals;
  byDay: { day: string; records: number; minutes: number; hours: number }[];
}

/** The caller's own standing today, and which button should be live. */
export interface AttendanceToday {
  employeeId: string | null;
  date: string;
  record: AttendanceRecord | null;
  clockedIn: boolean;
  canClockIn: boolean;
  canClockOut: boolean;
  /** A sentence to show under the button, so the UI never has to guess. */
  reason: string;
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/** Mirrors `public.task_priority`. */
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export const TASK_PRIORITIES: TaskPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

/** Mirrors `public.task_status`. */
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export const TASK_STATUSES: TaskStatus[] = ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

export interface Task {
  id: string;
  /** The human-readable id the UI shows as "Task ID", e.g. `TASK-0007`. */
  reference: string;
  number: number;
  title: string;
  description: string | null;
  employeeId: string;
  employeeName: string;
  assignedById: string | null;
  assignedBy: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: string | null;
  instructions: string | null;
  completionNotes: string | null;
  completedAt: string | null;
  /** Late and still open. Computed in SQL so both dashboards agree. */
  overdue: boolean;
  /** What this task may become next — mirrors the DB trigger. */
  nextStatuses: TaskStatus[];
  assignedAt: string;
  updatedAt: string;
}

export interface TaskCounts {
  pending: number;
  inProgress: number;
  overdue: number;
  completed: number;
}
