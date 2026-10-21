/**
 * The service index, served at `GET /` and `GET /api/v1`.
 *
 * ## Why this exists
 *
 * This service has no HTML surface, so before this module the root was a dead
 * end: pointing a browser at the port returned
 *
 *     {"error":{"code":"NOT_FOUND","message":"No route matches GET /"}}
 *
 * which reads as "the service is broken" when in fact the service is fine and
 * simply has nothing to serve at that address. The index answers the first
 * three questions a caller has - is it up, where is the API, what can I call -
 * without anyone having to read the source or the README.
 *
 * ## Why JSON and not a page
 *
 * The brief for this service is explicit that it is backend-only, with no
 * frontend and no UI. Returning an HTML landing page would misrepresent it as
 * a website and would put a browser-facing surface in a service that is not
 * supposed to have one. A JSON index is service discovery, which is a backend
 * concern; it just happens to be readable in a browser.
 *
 * ## Why the list is hand-written
 *
 * It could be derived by walking the Express router stack, but then it could
 * not carry a description or an auth requirement per route - and "what does
 * this endpoint need?" is the question the index is for. A hand-written list
 * can drift, so `tests/unit/apiIndex.test.ts` asserts that every path below is
 * actually mounted: it issues the request and fails if the response is the
 * router-level `No route matches …` 404. Add a route without adding it here and
 * the index is merely incomplete; add one here that does not exist and the
 * test goes red.
 */

import { env } from "../config/env";

/**
 * Who a route will admit.
 *
 * `authenticated` means any signed-in account; the named groups mirror
 * `src/lib/roleGroups.ts`, so this index cannot describe a gate that no route
 * actually implements. "DESK" is the front desk (CONCIERGE + ADMIN) and
 * "OPERATIONS" is everyone who works at the branch (EMPLOYEE + CONCIERGE +
 * ADMIN).
 */
export type ApiAuth = "public" | "optional" | "authenticated" | "OPERATIONS" | "DESK" | "ADMIN";

export interface ApiEndpoint {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Absolute path, so it can be pasted straight into a client. */
  path: string;
  auth: ApiAuth;
  summary: string;
}

export interface ApiGroup {
  name: string;
  endpoints: ApiEndpoint[];
}

/**
 * `optional` means the route works with or without a token but behaves
 * differently: a signed-in client books against their own account, an
 * anonymous visitor books as a guest.
 */
export const API_GROUPS: ApiGroup[] = [
  {
    name: "health",
    endpoints: [
      {
        method: "GET",
        path: "/health",
        auth: "public",
        summary: "Liveness and readiness, including database reachability. Not under /api/v1, so an uptime monitor does not need to know the version.",
      },
    ],
  },
  {
    name: "auth",
    endpoints: [
      { method: "POST", path: "/api/v1/auth/register", auth: "public", summary: "Create a CLIENT account." },
      { method: "POST", path: "/api/v1/auth/login", auth: "public", summary: "Exchange credentials for a session. Rate-limited per address." },
      { method: "POST", path: "/api/v1/auth/refresh", auth: "public", summary: "Exchange a refresh token for a new session." },
      { method: "POST", path: "/api/v1/auth/logout", auth: "authenticated", summary: "Revoke the caller's session." },
      { method: "GET", path: "/api/v1/auth/me", auth: "authenticated", summary: "The caller's profile and role." },
    ],
  },
  {
    name: "services",
    endpoints: [
      { method: "GET", path: "/api/v1/services", auth: "public", summary: "The active catalogue. RLS-enforced, so inactive rows are invisible rather than filtered out." },
      { method: "GET", path: "/api/v1/services/search", auth: "public", summary: "Search the catalogue by name and category." },
      { method: "GET", path: "/api/v1/services/:id", auth: "public", summary: "One service." },
      { method: "POST", path: "/api/v1/services", auth: "ADMIN", summary: "Create a service." },
      { method: "PATCH", path: "/api/v1/services/:id", auth: "ADMIN", summary: "Update a service." },
      { method: "DELETE", path: "/api/v1/services/:id", auth: "ADMIN", summary: "Deactivate a service." },
    ],
  },
  {
    name: "employees",
    endpoints: [
      { method: "GET", path: "/api/v1/employees", auth: "public", summary: "The public 'meet the team' list. Working hours are omitted here." },
      { method: "GET", path: "/api/v1/employees/:id", auth: "public", summary: "One stylist." },
      { method: "POST", path: "/api/v1/employees", auth: "ADMIN", summary: "Create a stylist." },
      { method: "PATCH", path: "/api/v1/employees/:id", auth: "ADMIN", summary: "Update a stylist." },
      { method: "DELETE", path: "/api/v1/employees/:id", auth: "ADMIN", summary: "Deactivate a stylist." },
      { method: "PUT", path: "/api/v1/employees/:id/services", auth: "ADMIN", summary: "Set which services the stylist is qualified for." },
      { method: "PUT", path: "/api/v1/employees/:id/working-hours", auth: "ADMIN", summary: "Replace the weekly shift pattern." },
      { method: "GET", path: "/api/v1/employees/:id/time-off", auth: "OPERATIONS", summary: "Leave entries for a stylist." },
      { method: "POST", path: "/api/v1/employees/:id/time-off", auth: "ADMIN", summary: "Add a leave entry." },
      { method: "GET", path: "/api/v1/employees/:id/performance", auth: "ADMIN", summary: "Utilisation and revenue for a stylist over a window." },
      { method: "GET", path: "/api/v1/employees/:id/quota", auth: "OPERATIONS", summary: "One stylist's progress against the daily completed-clients quota. ?date=YYYY-MM-DD; defaults to today in the branch timezone." },
      { method: "GET", path: "/api/v1/employees/quotas", auth: "DESK", summary: "Every active stylist's quota progress for one day, in a single call. The front desk's board." },
    ],
  },
  {
    name: "availability",
    endpoints: [
      { method: "GET", path: "/api/v1/availability", auth: "public", summary: "Bookable slot grid for a service and date, via a security-definer function." },
    ],
  },
  {
    name: "bookings",
    endpoints: [
      { method: "POST", path: "/api/v1/bookings", auth: "optional", summary: "Create a booking. A guest supplies a name and phone; a signed-in client books against their account. A room is assigned automatically when the services need one; staff may pin one with roomId." },
      { method: "GET", path: "/api/v1/bookings", auth: "OPERATIONS", summary: "List bookings. The run sheet - the desk and the floor both read it." },
      { method: "GET", path: "/api/v1/bookings/:id", auth: "optional", summary: "One booking. A guest booking is readable by anyone holding its uuid - the uuid is the capability." },
      { method: "POST", path: "/api/v1/bookings/:id/cancel", auth: "optional", summary: "Cancel. Refused inside the 2-hour window unless forced by staff." },
      { method: "POST", path: "/api/v1/bookings/:id/reschedule", auth: "optional", summary: "Move to a new slot and issue a fresh pass. A room clash reports ROOM_TAKEN, not SLOT_TAKEN." },
      { method: "GET", path: "/api/v1/bookings/:id/qr", auth: "optional", summary: "Re-issue the signed check-in pass." },
      { method: "PATCH", path: "/api/v1/bookings/:id/status", auth: "OPERATIONS", summary: "Move a booking through the status machine. The desk checks in; the therapist starts and completes." },
      { method: "PATCH", path: "/api/v1/bookings/:id/room", auth: "DESK", summary: "Front-desk override of the treatment room. Rejects a room of the wrong type and one already in use." },
      { method: "GET", path: "/api/v1/bookings/:id/notes", auth: "optional", summary: "Aftercare notes. A client sees only the ones marked shareable; staff see all." },
      { method: "POST", path: "/api/v1/bookings/:id/notes", auth: "OPERATIONS", summary: "Write an aftercare note. visibleToClient defaults to true." },
      { method: "DELETE", path: "/api/v1/bookings/:id/notes/:noteId", auth: "OPERATIONS", summary: "Delete a note outright - notes are not soft-deleted." },
    ],
  },
  {
    name: "me",
    endpoints: [
      { method: "GET", path: "/api/v1/me/bookings", auth: "authenticated", summary: "The caller's own bookings." },
      { method: "GET", path: "/api/v1/me/loyalty", auth: "authenticated", summary: "The caller's own visit count and member standing. Scoped to the token, so there is no id to tamper with." },
    ],
  },
  {
    name: "qr",
    endpoints: [
      { method: "GET", path: "/api/v1/qr/enter", auth: "public", summary: "The walk-in door QR. Returns the branch, today's hours, the menu and the membership rules in one call. The only public route under /qr." },
      { method: "GET", path: "/api/v1/qr/door", auth: "ADMIN", summary: "The signed door-QR URL, for the page that prints the sticker. ADMIN-only: the artifact is permanent and unrevocable." },
      { method: "GET", path: "/api/v1/qr/branch", auth: "OPERATIONS", summary: "Branch descriptor for the scanner. Not a credential - holding it grants nothing." },
      { method: "POST", path: "/api/v1/qr/check-in", auth: "OPERATIONS", summary: "Redeem a pass at the desk. Refuses replays and forged signatures." },
    ],
  },
  {
    name: "rooms",
    endpoints: [
      { method: "GET", path: "/api/v1/rooms/public", auth: "public", summary: "Active rooms. The floor plan is not a secret, but notes and inactive rooms are withheld." },
      { method: "GET", path: "/api/v1/rooms", auth: "OPERATIONS", summary: "Full room list, including decommissioned ones." },
      { method: "GET", path: "/api/v1/rooms/available", auth: "OPERATIONS", summary: "Which rooms are free for a given window, and which are occupied. The override preview." },
      { method: "GET", path: "/api/v1/rooms/:id", auth: "OPERATIONS", summary: "One room." },
      { method: "POST", path: "/api/v1/rooms", auth: "ADMIN", summary: "Create a room." },
      { method: "PATCH", path: "/api/v1/rooms/:id", auth: "ADMIN", summary: "Update a room." },
      { method: "DELETE", path: "/api/v1/rooms/:id", auth: "ADMIN", summary: "Decommission a room. Refused while it still has upcoming bookings." },
    ],
  },
  {
    name: "catalogue",
    endpoints: [
      { method: "GET", path: "/api/v1/service-subcategories/menu", auth: "public", summary: "The catalogue grouped by category then subcategory - the booking page's menu." },
      { method: "GET", path: "/api/v1/service-subcategories", auth: "public", summary: "Subcategories, flat." },
      { method: "GET", path: "/api/v1/service-subcategories/:id", auth: "public", summary: "One subcategory, with how many services are filed under it." },
      { method: "POST", path: "/api/v1/service-subcategories", auth: "ADMIN", summary: "Add a classification, e.g. a new massage style. The slug is derived from the name when omitted." },
      { method: "PATCH", path: "/api/v1/service-subcategories/:id", auth: "ADMIN", summary: "Update a subcategory." },
      { method: "DELETE", path: "/api/v1/service-subcategories/:id", auth: "ADMIN", summary: "Deactivate a subcategory." },
    ],
  },
  {
    name: "loyalty",
    endpoints: [
      { method: "GET", path: "/api/v1/loyalty/clients", auth: "DESK", summary: "Clients with their derived visit count. ?eligibleOnly=true is the front desk's worklist." },
      { method: "GET", path: "/api/v1/loyalty/clients/:id", auth: "DESK", summary: "One client's loyalty standing." },
      { method: "POST", path: "/api/v1/loyalty/clients/:id/promote", auth: "DESK", summary: "Promote to member. Refused below the 3-visit threshold; the rate defaults to 10%." },
      { method: "DELETE", path: "/api/v1/loyalty/clients/:id/membership", auth: "DESK", summary: "Revoke membership. The visit history is untouched, so they can earn it again." },
    ],
  },
  {
    name: "attendance",
    endpoints: [
      { method: "GET", path: "/api/v1/attendance/me", auth: "OPERATIONS", summary: "The caller's own attendance standing: today's record, whether they are clocked in, and the next legal action. The employee dashboard's clock-in card." },
      { method: "GET", path: "/api/v1/attendance/summary", auth: "OPERATIONS", summary: "Totals for a date range - days present, leave, hours worked and a per-day breakdown. Scoped to the caller for an employee, whole-floor for the desk." },
      { method: "GET", path: "/api/v1/attendance", auth: "OPERATIONS", summary: "Attendance history. ?from=&to=&employeeId=&status=. An employee sees only their own records." },
      { method: "POST", path: "/api/v1/attendance/clock-in", auth: "OPERATIONS", summary: "Time in. The server writes the timestamp; a second time-in for the same day is a 409." },
      { method: "POST", path: "/api/v1/attendance/clock-out", auth: "OPERATIONS", summary: "Time out. Closes today's open session and derives the hours worked. Refused with no open session, or twice." },
      { method: "GET", path: "/api/v1/attendance/:id", auth: "OPERATIONS", summary: "One attendance record, with the hours worked and the rostered shift." },
      { method: "PATCH", path: "/api/v1/attendance/:id", auth: "DESK", summary: "Correct a record - a forgotten time-out, or a day of leave entered after the fact." },
    ],
  },
  {
    name: "tasks",
    endpoints: [
      { method: "GET", path: "/api/v1/tasks/mine", auth: "OPERATIONS", summary: "The caller's own assigned tasks. The employee's My Tasks page." },
      { method: "GET", path: "/api/v1/tasks/counts", auth: "OPERATIONS", summary: "Pending, in-progress, overdue and completed counts for the dashboard tiles." },
      { method: "GET", path: "/api/v1/tasks", auth: "OPERATIONS", summary: "Tasks. ?employeeId=&status=&priority=&q=&overdue=. The desk sees every task; an employee sees only their own." },
      { method: "POST", path: "/api/v1/tasks", auth: "DESK", summary: "Assign a task to an employee. An identical open task for the same person is refused as a double-submit." },
      { method: "GET", path: "/api/v1/tasks/:id", auth: "OPERATIONS", summary: "One task." },
      { method: "PATCH", path: "/api/v1/tasks/:id/status", auth: "OPERATIONS", summary: "Move the caller's own task to IN_PROGRESS, COMPLETED or PENDING, with optional completion notes. Transitions are enforced by a database trigger." },
      { method: "PATCH", path: "/api/v1/tasks/:id", auth: "DESK", summary: "Edit, reassign, or change the status of a task." },
      { method: "POST", path: "/api/v1/tasks/:id/cancel", auth: "DESK", summary: "Cancel a task. Soft - the record of the work asked for survives." },
    ],
  },
  {
    name: "promos",
    endpoints: [
      { method: "POST", path: "/api/v1/promos/validate", auth: "optional", summary: "Preview a code against a cart. An unknown code is a 200 with valid:false, not a 4xx." },
      { method: "GET", path: "/api/v1/promos", auth: "ADMIN", summary: "List promo codes." },
      { method: "GET", path: "/api/v1/promos/:id", auth: "ADMIN", summary: "One promo code." },
      { method: "POST", path: "/api/v1/promos", auth: "ADMIN", summary: "Create a promo code." },
      { method: "PATCH", path: "/api/v1/promos/:id", auth: "ADMIN", summary: "Update a promo code." },
      { method: "DELETE", path: "/api/v1/promos/:id", auth: "ADMIN", summary: "Deactivate a promo code." },
    ],
  },
  {
    name: "admin",
    endpoints: [
      { method: "POST", path: "/api/v1/admin/users/staff", auth: "ADMIN", summary: "Create an EMPLOYEE, CONCIERGE or ADMIN account. The retired 'STAFF' label is refused." },
      { method: "GET", path: "/api/v1/admin/dashboard", auth: "ADMIN", summary: "Totals for a date range." },
      { method: "GET", path: "/api/v1/admin/clients", auth: "ADMIN", summary: "Client list with lifetime value." },
      { method: "GET", path: "/api/v1/admin/clients/export.csv", auth: "ADMIN", summary: "The client list as a CSV attachment." },
      { method: "GET", path: "/api/v1/admin/clients/:id", auth: "ADMIN", summary: "One client." },
      { method: "PATCH", path: "/api/v1/admin/clients/:id", auth: "ADMIN", summary: "Update a client." },
      { method: "DELETE", path: "/api/v1/admin/clients/:id", auth: "ADMIN", summary: "Deactivate a client." },
      { method: "GET", path: "/api/v1/admin/bookings", auth: "ADMIN", summary: "Cross-employee booking list." },
      { method: "GET", path: "/api/v1/admin/employees", auth: "ADMIN", summary: "Employee list including inactive." },
      { method: "GET", path: "/api/v1/admin/promos", auth: "ADMIN", summary: "Promo list including inactive." },
      { method: "GET", path: "/api/v1/admin/audit-logs", auth: "ADMIN", summary: "The append-only audit trail." },
    ],
  },
];

export interface ApiIndex {
  service: string;
  version: string;
  env: string;
  /** Says plainly what this address is, so a browser visitor is not misled. */
  note: string;
  branchTimezone: string;
  health: string;
  baseUrl: string;
  auth: string;
  errors: string;
  endpointCount: number;
  groups: ApiGroup[];
}

export function buildApiIndex(): ApiIndex {
  return {
    service: "Beauty Alley Booking API",
    version: "1.0.0",
    env: env.nodeEnv,
    note:
      "This is a JSON API and has no HTML page at any address. " +
      "Everything below is called over HTTP and returns { data } on success or { error } on failure. " +
      "The salon web app is a separate front end and is not served from this port.",
    branchTimezone: env.branchTimezone,
    health: "/health",
    baseUrl: "/api/v1",
    auth:
      "Send a session token as `Authorization: Bearer <access_token>`. " +
      "'public' needs no token; 'optional' changes behaviour when one is present; " +
      "'authenticated' needs any signed-in account. The role gates are 'OPERATIONS' " +
      "(EMPLOYEE, CONCIERGE, ADMIN - everyone who works the floor), 'DESK' (CONCIERGE " +
      "and ADMIN - reception, payments, room assignment) and 'ADMIN' (the owner).",
    errors: "Every failure is { error: { code, message, details? } } for any status.",
    endpointCount: API_GROUPS.reduce((n, g) => n + g.endpoints.length, 0),
    groups: API_GROUPS,
  };
}
