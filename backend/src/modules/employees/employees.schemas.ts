import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const EMPLOYEE_SORT_COLUMNS = ["full_name", "title", "created_at"] as const;

export const listEmployeesSchema = paginationSchema.extend({
  sort: z.enum(EMPLOYEE_SORT_COLUMNS).default("full_name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  includeInactive: z.coerce.boolean().default(false),
  /** Only employees qualified for this service. */
  serviceId: z.string().uuid().optional(),
});

export const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  title: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(2000).optional(),
  /** Link to an existing account so this person can sign in. */
  profileId: z.string().uuid().optional(),
  isActive: z.boolean().default(true),
  serviceIds: z.array(z.string().uuid()).default([]),
});

export const updateEmployeeSchema = createEmployeeSchema
  .omit({ serviceIds: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const setEmployeeServicesSchema = z.object({
  serviceIds: z.array(z.string().uuid()).max(100),
});

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const workingHourSchema = z
  .object({
    weekday: z.coerce.number().int().min(0).max(6),
    startTime: timeOfDay,
    endTime: timeOfDay,
  })
  .refine((v) => v.endTime > v.startTime, {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });

export const setWorkingHoursSchema = z.object({
  hours: z.array(workingHourSchema).max(21),
});

export const timeOffSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const availabilityQuerySchema = z.object({
  serviceId: z.string().uuid("serviceId is required"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    // Parsed in branch-local terms by the database function, so a plain date
    // string is the right input - sending an instant here would be a category
    // error and would break near midnight.
    ,
  employeeId: z.string().uuid().optional(),
  intervalMinutes: z.coerce.number().int().min(5).max(240).default(30),
});

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid id") });

export const performanceQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Which day the quota question is about.
 *
 * A plain `YYYY-MM-DD` rather than an instant, because "today" means the
 * branch's local day: the database resolves it against `branch_timezone()`.
 * Sending a timestamp here would be a category error and would give a
 * different answer either side of midnight.
 *
 * Omitted means today, so the common call needs no parameters at all.
 */
export const quotaQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

export type QuotaQuery = z.infer<typeof quotaQuerySchema>;

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesSchema>;
