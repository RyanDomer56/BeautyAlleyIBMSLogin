import { iso, isoOrNull } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import type { Actor } from "../../types/actor";
import { employeesRepository } from "../employees/employees.repository";
import { tasksRepository, type TaskRow } from "./tasks.repository";
import {
  NEXT_TASK_STATUS,
  type CreateTaskInput,
  type ListTasksQuery,
  type SetTaskStatusInput,
  type TaskStatus,
  type UpdateTaskInput,
} from "./tasks.schemas";

/** Row -> wire shape. Snake case stays in the database. */
export function toTaskDto(row: TaskRow) {
  const number = Number(row.number);
  return {
    id: row.id,
    /** The human-readable id the UI shows as "Task ID". */
    reference: `TASK-${String(number).padStart(4, "0")}`,
    number,
    title: row.title,
    description: row.description,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    assignedById: row.created_by,
    assignedBy: row.created_by_name ?? "The salon",
    priority: row.priority,
    status: row.status,
    dueAt: isoOrNull(row.due_at),
    instructions: row.instructions,
    completionNotes: row.completion_notes,
    completedAt: isoOrNull(row.completed_at),
    /** Late, and still open. Computed in SQL so both dashboards agree. */
    overdue: row.is_overdue,
    /** What this task may become next - mirrors the trigger in migration 30. */
    nextStatuses: NEXT_TASK_STATUS[row.status],
    assignedAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export type TaskDto = ReturnType<typeof toTaskDto>;

/** Re-read after a write, so the DTO always describes what is actually stored. */
async function reload(id: string): Promise<TaskDto> {
  const row = await tasksRepository.getById(id);
  if (!row) throw AppError.notFound(CODES.TASK_NOT_FOUND, "No such task");
  return toTaskDto(row);
}

/**
 * The employee filter a caller is allowed to use.
 *
 * An employee's task list is scoped to their own employee row here rather than
 * trusted from the query string, so dropping the filter cannot reveal a
 * colleague's tasks.
 */
function scopeFor(actor: Actor, requestedId?: string): string | undefined {
  if (actor.role === "EMPLOYEE") {
    if (!actor.employeeId) {
      throw AppError.forbidden(CODES.FORBIDDEN, "This account is not linked to an employee record");
    }
    if (requestedId && requestedId !== actor.employeeId) {
      throw AppError.forbidden(CODES.NOT_TASK_OWNER, "You can only see tasks assigned to you");
    }
    return actor.employeeId;
  }
  return requestedId;
}

/** An employee may only act on a task assigned to them. */
function assertOwnership(actor: Actor, row: TaskRow) {
  if (actor.role === "EMPLOYEE" && row.employee_id !== actor.employeeId) {
    // 404, not 403: confirming the task exists for someone else is itself
    // information the employee has no business having.
    throw AppError.notFound(CODES.TASK_NOT_FOUND, "No such task");
  }
}

/** Move a task's status, refusing an illegal transition before the trigger does. */
async function transition(id: string, row: TaskRow, next: TaskStatus, notes?: string | null) {
  if (next === row.status) {
    // Not an error - two taps on "Start" should be idempotent, not a 409.
    return reload(id);
  }
  if (!NEXT_TASK_STATUS[row.status].includes(next)) {
    throw AppError.conflict(
      CODES.TASK_STATUS_TRANSITION,
      `A ${row.status.toLowerCase().replace("_", " ")} task cannot become ${next
        .toLowerCase()
        .replace("_", " ")}.`,
      { from: row.status, to: next, allowed: NEXT_TASK_STATUS[row.status] },
    );
  }

  try {
    await tasksRepository.setStatus(id, next, notes);
  } catch (err) {
    // The trigger is the authority; this maps its refusal to the same 409 the
    // pre-check above produces, so the client sees one shape either way.
    if (/TASK_STATUS_TRANSITION/.test(String((err as { message?: string })?.message ?? ""))) {
      throw AppError.conflict(CODES.TASK_STATUS_TRANSITION, "That status change is not allowed.", {
        from: row.status,
        to: next,
      });
    }
    throw err;
  }
  return reload(id);
}

export const tasksService = {
  /**
   * A page of tasks. The desk sees everything; an employee sees only their own,
   * because `scopeFor` pins the filter to their employee row.
   */
  async list(actor: Actor, query: ListTasksQuery) {
    const employeeId = scopeFor(actor, query.employeeId);
    const { rows, total } = await tasksRepository.list({
      pagination: { page: query.page, limit: query.limit, sort: query.sort, order: query.order },
      filters: {
        employeeId,
        status: query.status,
        priority: query.priority,
        q: query.q,
        overdue: query.overdue,
      },
    });
    return paginated(rows.map(toTaskDto), total, query.page, query.limit);
  },

  /** The caller's own tasks. The employee dashboard's page. */
  async mine(actor: Actor, query: ListTasksQuery) {
    if (!actor.employeeId) {
      throw AppError.forbidden(CODES.FORBIDDEN, "This account is not linked to an employee record");
    }
    /*
     * `scopeFor` runs before the override below, so an explicit filter naming a
     * colleague is refused rather than quietly replaced with the caller's own
     * id. Same rule as `/attendance`: no filter means "mine", a wrong filter is
     * a bug worth surfacing.
     */
    scopeFor(actor, query.employeeId);
    return this.list(actor, { ...query, employeeId: actor.employeeId });
  },

  /** Tile counts. Scoped for an employee, whole-floor for the desk. */
  async counts(actor: Actor, employeeId?: string) {
    return tasksRepository.counts(scopeFor(actor, employeeId));
  },

  async getById(actor: Actor, id: string) {
    const row = await tasksRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.TASK_NOT_FOUND, "No such task");
    assertOwnership(actor, row);
    return toTaskDto(row);
  },

  /**
   * Assign a task. DESK only - the brief puts task creation on the concierge
   * dashboard, and an employee assigning work to a colleague is not a thing
   * this system is for.
   */
  async create(actor: Actor, input: CreateTaskInput) {
    const employee = await employeesRepository.getById(input.employeeId);
    if (!employee) throw AppError.notFound(CODES.EMPLOYEE_NOT_FOUND, "No such employee");
    if (!employee.is_active) {
      throw AppError.badRequest(
        CODES.VALIDATION_FAILED,
        "That employee is not active, so work cannot be assigned to them",
      );
    }

    // A double-submit produces two identical open tasks, which is never what
    // the concierge meant. Re-doing the same job next week is fine, so the
    // check only covers tasks that are still open.
    //
    // This lookup is the friendly path - it can name the task that already
    // exists. It cannot close the race on its own: two concurrent creates both
    // see nothing and both insert. Migration 34 adds a partial unique index for
    // that, and the catch below turns its violation into the same answer.
    const duplicateError = (found: Awaited<ReturnType<typeof tasksRepository.findOpenDuplicate>>) =>
      AppError.conflict(
        CODES.DUPLICATE_TASK,
        `${employee.full_name} already has an open task called "${input.title}".`,
        found
          ? { taskId: found.id, reference: `TASK-${String(Number(found.number)).padStart(4, "0")}` }
          : undefined
      );

    const duplicate = await tasksRepository.findOpenDuplicate(input.employeeId, input.title);
    if (duplicate) throw duplicateError(duplicate);

    let id: string;
    try {
      id = await tasksRepository.create(input, actor.id);
    } catch (err) {
      const pg = err as { code?: string; message?: string; details?: string };
      const onTheIndex = /tasks_open_title_per_employee_idx/.test(
        `${pg.message ?? ""} ${pg.details ?? ""}`
      );
      if (pg.code === "23505" && onTheIndex) {
        throw duplicateError(await tasksRepository.findOpenDuplicate(input.employeeId, input.title));
      }
      throw err;
    }
    return reload(id);
  },

  /** Edit, reassign, or cancel. DESK only. */
  async update(actor: Actor, id: string, patch: UpdateTaskInput) {
    const row = await tasksRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.TASK_NOT_FOUND, "No such task");

    if (patch.employeeId !== undefined && patch.employeeId !== row.employee_id) {
      const employee = await employeesRepository.getById(patch.employeeId);
      if (!employee) throw AppError.notFound(CODES.EMPLOYEE_NOT_FOUND, "No such employee");
      if (!employee.is_active) {
        throw AppError.badRequest(CODES.VALIDATION_FAILED, "That employee is not active");
      }
    }

    // A status change carries the same rules as the dedicated route, so the
    // two cannot disagree about what is legal.
    if (patch.status !== undefined && patch.status !== row.status) {
      if (!NEXT_TASK_STATUS[row.status].includes(patch.status)) {
        throw AppError.conflict(CODES.TASK_STATUS_TRANSITION, "That status change is not allowed.", {
          from: row.status,
          to: patch.status,
          allowed: NEXT_TASK_STATUS[row.status],
        });
      }
    }

    // A task cannot keep notes that describe a completion it no longer has.
    const nextStatus = patch.status ?? row.status;
    const cleared = nextStatus !== "COMPLETED" && patch.completionNotes === undefined;

    try {
      await tasksRepository.update(id, cleared ? { ...patch, completionNotes: null } : patch);
    } catch (err) {
      if (/TASK_STATUS_TRANSITION/.test(String((err as { message?: string })?.message ?? ""))) {
        throw AppError.conflict(CODES.TASK_STATUS_TRANSITION, "That status change is not allowed.", {
          from: row.status,
          to: patch.status,
        });
      }
      throw err;
    }
    return reload(id);
  },

  /**
   * The employee's own update: start it, finish it, or reopen it.
   *
   * Narrower than `update` on purpose. A stylist may move their own task and
   * say what they did; they may not rename it, change its priority, or hand it
   * to someone else.
   */
  async setStatus(actor: Actor, id: string, input: SetTaskStatusInput) {
    const row = await tasksRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.TASK_NOT_FOUND, "No such task");
    assertOwnership(actor, row);
    return transition(id, row, input.status, input.completionNotes ?? null);
  },

  /** Cancel. A soft end: the row stays, so the record of the work asked for survives. */
  async cancel(actor: Actor, id: string) {
    const row = await tasksRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.TASK_NOT_FOUND, "No such task");
    return transition(id, row, "CANCELLED");
  },
};
