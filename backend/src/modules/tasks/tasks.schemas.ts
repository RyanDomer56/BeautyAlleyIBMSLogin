import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

/** Mirrors `public.task_priority` from migration 30. Order is the enum order. */
export const taskPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

/** Mirrors `public.task_status` from migration 30. */
export const taskStatusSchema = z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * The transitions the database trigger will accept.
 *
 * This is a mirror, not the authority - `enforce_task_status_transition` in
 * migration 30 is what actually refuses an illegal move. The copy exists so the
 * API can answer with a useful message and so the client can render the right
 * buttons, and `tests/integration/tasks.test.ts` asserts the two agree.
 */
export const NEXT_TASK_STATUS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["PENDING", "COMPLETED", "CANCELLED"],
  COMPLETED: ["PENDING"],
  CANCELLED: ["PENDING"],
};

const instantSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: "Expected an ISO-8601 timestamp",
});

export const TASK_SORT_COLUMNS = ["created_at", "due_at", "priority", "status", "title", "number"] as const;

export const listTasksSchema = paginationSchema.extend({
  sort: z.enum(TASK_SORT_COLUMNS).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  employeeId: z.string().uuid("Not a valid employee id").optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  /** Free-text match on the title and description. */
  q: z.string().trim().max(120).optional(),
  /**
   * `?overdue=true` / `?overdue=false`.
   *
   * Deliberately NOT `z.coerce.boolean()`: that runs `Boolean(value)`, and
   * `Boolean("false")` is `true`, so asking for the *not*-overdue list would
   * silently return only the overdue ones. Only the exact strings count.
   */
  overdue: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .optional(),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, "A task needs a title").max(160),
  description: z.string().trim().max(2000).optional(),
  employeeId: z.string().uuid("Choose who the task is for"),
  priority: taskPrioritySchema.default("MEDIUM"),
  /** Omit for a task with no deadline. */
  dueAt: instantSchema.optional(),
  instructions: z.string().trim().max(2000).optional(),
});

/**
 * An edit by the concierge.
 *
 * `status` is here as well as on `/status` because the concierge cancels and
 * reinstates tasks, and a cancel is a status change like any other. The
 * employee-facing route is narrower: it takes a status and completion notes
 * only, so a stylist cannot rename their own task or move it to a colleague.
 */
export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    employeeId: z.string().uuid("Not a valid employee id").optional(),
    priority: taskPrioritySchema.optional(),
    status: taskStatusSchema.optional(),
    dueAt: instantSchema.nullable().optional(),
    instructions: z.string().trim().max(2000).nullable().optional(),
    completionNotes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

/** What an employee may do to their own task: move it, and say what happened. */
export const setTaskStatusSchema = z.object({
  status: taskStatusSchema,
  completionNotes: z.string().trim().max(2000).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid id") });

export type ListTasksQuery = z.infer<typeof listTasksSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type SetTaskStatusInput = z.infer<typeof setTaskStatusSchema>;
