import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

/** Mirrors `public.attendance_status` from migration 29. */
export const attendanceStatusSchema = z.enum(["PRESENT", "HALF_DAY", "LEAVE", "ABSENT"]);
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

/** A plain calendar day, resolved in the branch timezone. Never an instant. */
const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD day");

/**
 * An ISO-8601 instant, checked by parsing rather than by a regex.
 *
 * `Date.parse` is the same test the rest of the app applies, so a value that
 * passes here is one the repository can hand to Postgres without a surprise.
 */
const instantSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: "Expected an ISO-8601 timestamp",
});

/** Columns a client may sort by. Anything else is rejected before it reaches SQL. */
export const ATTENDANCE_SORT_COLUMNS = ["work_date", "time_in", "time_out", "created_at"] as const;

export const listAttendanceSchema = paginationSchema.extend({
  sort: z.enum(ATTENDANCE_SORT_COLUMNS).default("work_date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  /** Inclusive range of branch-local days. */
  from: daySchema.optional(),
  to: daySchema.optional(),
  employeeId: z.string().uuid("Not a valid employee id").optional(),
  status: attendanceStatusSchema.optional(),
});

/**
 * Clock in / clock out.
 *
 * `employeeId` is optional and only honoured for the front desk. An employee
 * clocking themselves in has no say in whose record is written - the API uses
 * the employee row linked to their own token. Letting a stylist name a
 * colleague would make the attendance log worthless.
 */
export const clockInSchema = z.object({
  employeeId: z.string().uuid("Not a valid employee id").optional(),
  remarks: z.string().trim().max(1000).optional(),
});

export const clockOutSchema = z.object({
  employeeId: z.string().uuid("Not a valid employee id").optional(),
  remarks: z.string().trim().max(1000).optional(),
});

/**
 * An amendment. The desk corrects a forgotten time-out, or records a day of
 * leave. Deliberately separate from the clock endpoints: a clock stamp is
 * server-written evidence, and this is a human correction of it.
 */
export const amendAttendanceSchema = z
  .object({
    status: attendanceStatusSchema.optional(),
    remarks: z.string().trim().max(1000).nullable().optional(),
    timeIn: instantSchema.optional(),
    timeOut: instantSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid id") });

export type ListAttendanceQuery = z.infer<typeof listAttendanceSchema>;
export type ClockInInput = z.infer<typeof clockInSchema>;
export type ClockOutInput = z.infer<typeof clockOutSchema>;
export type AmendAttendanceInput = z.infer<typeof amendAttendanceSchema>;
