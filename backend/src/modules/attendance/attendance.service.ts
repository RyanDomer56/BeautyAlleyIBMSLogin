import { branchDay, iso, isoOrNull } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import type { Actor } from "../../types/actor";
import { employeesRepository } from "../employees/employees.repository";
import {
  attendanceRepository,
  type AttendanceRow,
  type AttendanceSummary,
} from "./attendance.repository";
import type {
  AmendAttendanceInput,
  ClockInInput,
  ClockOutInput,
  ListAttendanceQuery,
} from "./attendance.schemas";

/** Row -> wire shape. Snake case stays in the database. */
export function toAttendanceDto(row: AttendanceRow) {
  const minutes = row.minutes_worked === null ? null : Number(row.minutes_worked);
  const late = row.minutes_late === null ? null : Number(row.minutes_late);

  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    /** `YYYY-MM-DD`, in the branch timezone. Not an instant. */
    date: row.work_date,
    timeIn: iso(row.time_in),
    /** Null while the session is still open. */
    timeOut: isoOrNull(row.time_out),
    status: row.status,
    remarks: row.remarks,
    /** The shift rostered for that weekday, when one is configured. */
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    /** Null until the session closes - "not finished" is not "zero hours". */
    minutesWorked: minutes,
    hoursWorked: minutes === null ? null : Math.round((minutes / 60) * 100) / 100,
    /**
     * Minutes past the rostered start, or null when no shift is configured.
     *
     * This is an observation against a rule the business set, not a verdict
     * invented from nothing - which is what the brief means by not marking
     * anyone late without configured business rules.
     */
    minutesLate: late,
    late: late !== null && late > 0,
    /** True while the employee is clocked in and has not clocked out. */
    open: row.time_out === null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export type AttendanceDto = ReturnType<typeof toAttendanceDto>;

/* ------------------------------------------------------------------ *
 * Who the record is for
 * ------------------------------------------------------------------ */

/**
 * Resolve whose attendance a request is about.
 *
 * An employee may only ever act on their own record - any `employeeId` they
 * send is ignored, and a mismatched one is refused rather than silently
 * dropped, so a client bug surfaces instead of writing to the wrong person.
 * The front desk may name anyone, which is what lets reception clock in a
 * stylist whose hands are busy.
 */
async function resolveTarget(actor: Actor, requestedId?: string): Promise<string> {
  if (actor.role === "EMPLOYEE") {
    if (!actor.employeeId) {
      throw AppError.forbidden(
        CODES.FORBIDDEN,
        "This account is not linked to an employee record, so it has no attendance to record",
      );
    }
    if (requestedId && requestedId !== actor.employeeId) {
      throw AppError.forbidden(CODES.FORBIDDEN, "You can only record your own attendance");
    }
    return actor.employeeId;
  }

  const target = requestedId ?? actor.employeeId;
  if (!target) {
    throw AppError.badRequest(
      CODES.VALIDATION_FAILED,
      "Provide an employeeId - this account is not linked to an employee record of its own",
    );
  }

  const employee = await employeesRepository.getById(target);
  if (!employee) throw AppError.notFound(CODES.EMPLOYEE_NOT_FOUND, "No such employee");
  if (!employee.is_active) {
    throw AppError.conflict(CODES.CONFLICT, "That employee is not active, so attendance cannot be recorded");
  }
  return target;
}

/**
 * The employee filter a caller is allowed to see.
 *
 * An employee's own page must not be able to read the whole floor's clock-in
 * times by dropping the filter, so the scope is applied here rather than
 * trusted from the query string.
 */
function scopeFor(actor: Actor, requestedId?: string): string | undefined {
  if (actor.role === "EMPLOYEE") {
    if (!actor.employeeId) {
      throw AppError.forbidden(CODES.FORBIDDEN, "This account is not linked to an employee record");
    }
    /*
     * Naming a colleague is refused, not silently ignored.
     *
     * Scoping to self either way leaks nothing, but silently rewriting the
     * filter turns a client bug - a stale id left in the query string - into a
     * page that quietly shows the wrong person's hours. A 403 surfaces it.
     * Omitting the filter entirely is still fine and means "my records".
     */
    if (requestedId && requestedId !== actor.employeeId) {
      throw AppError.forbidden(CODES.FORBIDDEN, "You can only read your own attendance");
    }
    return actor.employeeId;
  }
  return requestedId;
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Aggregate -> wire shape.
 *
 * The counting and summing is done by `attendance_summary` (migration 36), so
 * what is left here is presentation: turning minutes into hours, and the mean
 * over the days that were actually closed. Deliberately not pushed into SQL -
 * a payroll screen wants hours, a roster wants minutes, and a rounding rule is
 * not something a database function should be pinned to.
 *
 * `totalMinutes` can arrive as a numeric string when PostgREST serialises a
 * `numeric`, hence the Number() rather than trusting the type.
 */
function summarise(
  agg: AttendanceSummary,
  from: string,
  to: string,
  employeeId: string | null,
) {
  const totalMinutes = Number(agg.totalMinutes);
  const closedDays = Number(agg.closedDays);

  return {
    from,
    to,
    employeeId,
    totals: {
      records: Number(agg.records),
      present: Number(agg.present),
      halfDay: Number(agg.halfDay),
      leave: Number(agg.leave),
      absent: Number(agg.absent),
      /** Sessions still open right now. */
      open: Number(agg.open),
      /** Only completed sessions contribute to the hours. */
      completedDays: closedDays,
      totalMinutes,
      totalHours: round2(totalMinutes / 60),
      /** Mean hours over the days that were actually closed. */
      averageHours: closedDays === 0 ? null : round2(totalMinutes / closedDays / 60),
    },
    byDay: (agg.byDay ?? []).map((d) => ({
      day: d.day,
      records: Number(d.records),
      minutes: Number(d.minutes),
      hours: round2(Number(d.minutes) / 60),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export const attendanceService = {
  /** A page of records, scoped to what the caller may see. */
  async list(actor: Actor, query: ListAttendanceQuery) {
    const employeeId = scopeFor(actor, query.employeeId);
    const { rows, total } = await attendanceRepository.list({
      pagination: { page: query.page, limit: query.limit, sort: query.sort, order: query.order },
      filters: { from: query.from, to: query.to, employeeId, status: query.status },
    });
    return paginated(rows.map(toAttendanceDto), total, query.page, query.limit);
  },

  /** Totals for the same filter, over the whole range rather than one page. */
  async summary(actor: Actor, query: ListAttendanceQuery) {
    const employeeId = scopeFor(actor, query.employeeId);
    const agg = await attendanceRepository.summary({
      from: query.from,
      to: query.to,
      employeeId,
      status: query.status,
    });

    // The range the summary actually covers: the caller's bounds where given,
    // otherwise the span of what came back, so the UI can label it honestly.
    const from = query.from ?? agg.firstDay ?? branchDay();
    const to = query.to ?? agg.lastDay ?? branchDay();

    return summarise(agg, from, to, employeeId ?? null);
  },

  /**
   * The caller's own standing right now: today's record, whether they are
   * clocked in, and what the next legal action is. One call, because the
   * attendance page needs all of it before it can render a button.
   */
  async me(actor: Actor) {
    if (!actor.employeeId) {
      return {
        employeeId: null,
        date: branchDay(),
        record: null,
        clockedIn: false,
        canClockIn: false,
        canClockOut: false,
        reason: "This account is not linked to an employee record.",
      };
    }

    const day = branchDay();
    const row = await attendanceRepository.getForDay(actor.employeeId, day);
    const clockedIn = Boolean(row && row.time_out === null);

    return {
      employeeId: actor.employeeId,
      date: day,
      record: row ? toAttendanceDto(row) : null,
      clockedIn,
      canClockIn: !row,
      canClockOut: clockedIn,
      reason: row
        ? row.time_out === null
          ? "You are clocked in."
          : "Your session for today is already closed."
        : "You have not clocked in yet today.",
    };
  },

  async clockIn(actor: Actor, input: ClockInInput) {
    const employeeId = await resolveTarget(actor, input.employeeId);
    const day = branchDay();

    // Read first so the common case gives a precise message, then let the
    // unique constraint catch the race - see the catch below.
    const existing = await attendanceRepository.getForDay(employeeId, day);
    if (existing) {
      throw AppError.conflict(
        CODES.ALREADY_TIMED_IN,
        existing.time_out === null
          ? "This employee is already clocked in."
          : "This employee has already completed a session today.",
        { date: day, timeIn: iso(existing.time_in) },
      );
    }

    try {
      const id = await attendanceRepository.clockIn(employeeId, {
        recordedBy: actor.id,
        remarks: input.remarks,
      });
      const row = await attendanceRepository.getById(id);
      if (!row) throw AppError.internal("The attendance record could not be read back");
      return toAttendanceDto(row);
    } catch (err) {
      // Two taps at once: the second insert loses the race on
      // `attendance_one_session_per_day`. That is the same outcome as the check
      // above, so it is reported the same way rather than as a raw 409 CONFLICT.
      if ((err as { code?: string })?.code === "23505") {
        throw AppError.conflict(CODES.ALREADY_TIMED_IN, "This employee is already clocked in.", {
          date: day,
        });
      }
      throw err;
    }
  },

  async clockOut(actor: Actor, input: ClockOutInput) {
    const employeeId = await resolveTarget(actor, input.employeeId);
    const day = branchDay();

    const existing = await attendanceRepository.getForDay(employeeId, day);
    if (!existing) {
      throw AppError.notFound(
        CODES.NO_ACTIVE_SESSION,
        "There is no session for today to close. Clock in first.",
      );
    }
    if (existing.time_out !== null) {
      throw AppError.conflict(CODES.ALREADY_TIMED_OUT, "This session has already been closed.", {
        date: day,
        timeOut: iso(existing.time_out),
      });
    }

    const closedId = await attendanceRepository.clockOut(employeeId, day, input.remarks);
    if (closedId === null) {
      // The predicate `time_out is null` matched nothing, so another request
      // closed it between the read and the write.
      throw AppError.conflict(CODES.ALREADY_TIMED_OUT, "This session has already been closed.", {
        date: day,
      });
    }

    const row = await attendanceRepository.getById(closedId);
    if (!row) throw AppError.internal("The attendance record could not be read back");
    return toAttendanceDto(row);
  },

  async getById(actor: Actor, id: string) {
    const row = await attendanceRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.ATTENDANCE_NOT_FOUND, "No such attendance record");

    if (actor.role === "EMPLOYEE" && row.employee_id !== actor.employeeId) {
      // 404 rather than 403: confirming that a record exists for someone else
      // is itself information an employee has no business having.
      throw AppError.notFound(CODES.ATTENDANCE_NOT_FOUND, "No such attendance record");
    }
    return toAttendanceDto(row);
  },

  /**
   * Correct a record. The desk's tool: a forgotten time-out, a day of leave
   * entered after the fact. Never available to the employee it describes -
   * amending your own hours is not a self-service action.
   */
  async amend(actor: Actor, id: string, patch: AmendAttendanceInput) {
    const row = await attendanceRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.ATTENDANCE_NOT_FOUND, "No such attendance record");

    const nextIn = patch.timeIn !== undefined ? patch.timeIn : row.time_in;
    const nextOut = patch.timeOut !== undefined ? patch.timeOut : row.time_out;

    // The table's own check constraint would catch this, but a 400 that names
    // the two fields is more useful at the desk than a generic violation.
    if (nextOut !== null && Date.parse(nextOut) <= Date.parse(nextIn)) {
      throw AppError.badRequest(
        CODES.VALIDATION_FAILED,
        "The time out must be after the time in",
        { timeIn: iso(nextIn), timeOut: isoOrNull(nextOut) },
      );
    }

    await attendanceRepository.amend(id, patch);
    return this.getById(actor, id);
  },
};
