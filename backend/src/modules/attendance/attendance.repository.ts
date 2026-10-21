import { requireServiceRole } from "../../db/supabase";
import { branchDay } from "../../lib/dates";
import { toRange, type Pagination } from "../../lib/pagination";
import type { Database } from "../../types/database";
import type { AmendAttendanceInput, ListAttendanceQuery } from "./attendance.schemas";

/**
 * A row of `public.v_attendance_detail` (migration 29).
 *
 * The view is the read path on purpose: hours worked, minutes late and the
 * rostered shift are derived once, in SQL, so the employee's own page and the
 * admin's report cannot disagree about how long someone worked.
 */
export interface AttendanceRow {
  id: string;
  employee_id: string;
  employee_name: string;
  work_date: string;
  time_in: string;
  time_out: string | null;
  status: "PRESENT" | "HALF_DAY" | "LEAVE" | "ABSENT";
  remarks: string | null;
  recorded_by: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  minutes_worked: number | null;
  minutes_late: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT =
  "id, employee_id, employee_name, work_date, time_in, time_out, status, remarks, recorded_by, scheduled_start, scheduled_end, minutes_worked, minutes_late, created_at, updated_at" as const;

/**
 * The shape `attendance_summary` returns (migration 36), already camelCased by
 * the SQL so the service does not have to translate a second set of names.
 */
export interface AttendanceSummary {
  records: number;
  present: number;
  halfDay: number;
  leave: number;
  absent: number;
  open: number;
  /** Sessions with a time-out, i.e. the ones that contribute hours. */
  closedDays: number;
  totalMinutes: number;
  /** Span the data actually covers - NULL when there is nothing to summarise. */
  firstDay: string | null;
  lastDay: string | null;
  byDay: { day: string; records: number; minutes: number }[];
}

type AttendanceUpdate = Database["public"]["Tables"]["attendance"]["Update"];

export const attendanceRepository = {
  async list(opts: {
    pagination: Pagination & { sort: string; order: "asc" | "desc" };
    filters: Pick<ListAttendanceQuery, "from" | "to" | "employeeId" | "status">;
  }): Promise<{ rows: AttendanceRow[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(opts.pagination);

    let query = db.from("v_attendance_detail").select(SELECT, { count: "exact" });
    if (opts.filters.employeeId) query = query.eq("employee_id", opts.filters.employeeId);
    if (opts.filters.status) query = query.eq("status", opts.filters.status);
    if (opts.filters.from) query = query.gte("work_date", opts.filters.from);
    if (opts.filters.to) query = query.lte("work_date", opts.filters.to);

    const { data, error, count } = await query
      .order(opts.pagination.sort, { ascending: opts.pagination.order === "asc" })
      .range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as AttendanceRow[], total: count ?? 0 };
  },

  /**
   * Totals and the per-day breakdown for a filter, over the whole range.
   *
   * Deliberately separate from `list`: the summary must describe the entire
   * range even when the caller is looking at page one of twenty, so it cannot
   * be computed from the page.
   *
   * Aggregated by `attendance_summary` in the database. This used to fetch up
   * to a thousand rows and add them up in Node, which under-reports silently
   * past the cap - see migration 36. Rows no longer leave the database, so
   * there is no cap left to under-report against.
   */
  async summary(filters: Pick<ListAttendanceQuery, "from" | "to" | "employeeId" | "status">): Promise<AttendanceSummary> {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("attendance_summary", {
      p_employee_id: filters.employeeId ?? null,
      p_status: filters.status ?? null,
      p_from: filters.from ?? null,
      p_to: filters.to ?? null,
    });
    if (error) throw error;
    // The union of every function's return type is too wide to narrow directly,
    // hence the double cast. The shape is fixed by migration 36's self-check.
    return data as unknown as AttendanceSummary;
  },

  async getById(id: string): Promise<AttendanceRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("v_attendance_detail")
      .select(SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as AttendanceRow) ?? null;
  },

  /** The employee's record for one branch-local day, if there is one. */
  async getForDay(employeeId: string, day: string): Promise<AttendanceRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("v_attendance_detail")
      .select(SELECT)
      .eq("employee_id", employeeId)
      .eq("work_date", day)
      .maybeSingle();
    if (error) throw error;
    return (data as AttendanceRow) ?? null;
  },

  /**
   * Open a session.
   *
   * `work_date` is left to the column default, which resolves it in the branch
   * timezone - the server decides what "today" is, not the caller.
   */
  async clockIn(employeeId: string, opts: { recordedBy: string | null; remarks?: string }) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("attendance")
      .insert({
        employee_id: employeeId,
        recorded_by: opts.recordedBy,
        remarks: opts.remarks ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  },

  /**
   * Close the open session, if there is one. Returns its id, or null.
   *
   * The `time_out is null` predicate is in the UPDATE, not in a preceding read.
   * Two taps arriving together then race on a single atomic statement: the
   * second one matches no row and is reported as "already timed out" instead of
   * overwriting the first stamp.
   *
   * The timestamp comes from `clock_out_attendance` (migration 37) rather than
   * from `new Date()`. `clockIn` lets the column default stamp `time_in` on the
   * *database* clock, while this used to stamp `time_out` on the *app* clock -
   * two clocks that measurably disagree (about half a second here, more the
   * further the app host is from the database). A time-out inside that window
   * was earlier than the stored time-in and tripped the `attendance_time_order`
   * check, which surfaced as an intermittent 400 on a double tap.
   */
  async clockOut(employeeId: string, day: string, remarks?: string): Promise<string | null> {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("clock_out_attendance", {
      p_employee_id: employeeId,
      p_day: day,
      p_remarks: remarks ?? null,
    });
    if (error) throw error;
    // A function returning a scalar arrives as the value itself, not an array.
    return (data as string | null) ?? null;
  },

  /** Today's branch-local day, resolved in the branch timezone. */
  async branchToday(): Promise<string> {
    return branchDay();
  },

  async amend(id: string, patch: AmendAttendanceInput): Promise<string | null> {
    const db = requireServiceRole();
    // Typed as the table's own Update shape, so a typo in a column name is a
    // compile error rather than a silent no-op.
    const row: AttendanceUpdate = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.remarks !== undefined) row.remarks = patch.remarks;
    if (patch.timeIn !== undefined) row.time_in = patch.timeIn;
    if (patch.timeOut !== undefined) row.time_out = patch.timeOut;

    const { data, error } = await db.from("attendance").update(row).eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  },
};
