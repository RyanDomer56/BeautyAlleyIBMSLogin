import { requireServiceRole } from "../../db/supabase";
import { toRange, type Pagination } from "../../lib/pagination";
import type { Database } from "../../types/database";
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from "./tasks.schemas";

/**
 * A row of `public.v_task_detail` (migration 30).
 *
 * `number` is the small human-readable id; `is_overdue` is computed in SQL so
 * the employee's list and the concierge's board agree on which tasks are late.
 */
export interface TaskRow {
  id: string;
  number: number;
  title: string;
  description: string | null;
  employee_id: string;
  employee_name: string;
  created_by: string | null;
  created_by_name: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  due_at: string | null;
  instructions: string | null;
  completion_notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  is_overdue: boolean;
}

const SELECT =
  "id, number, title, description, employee_id, employee_name, created_by, created_by_name, priority, status, due_at, instructions, completion_notes, completed_at, created_at, updated_at, is_overdue" as const;

type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];

export const tasksRepository = {
  async list(opts: {
    pagination: Pagination & { sort: string; order: "asc" | "desc" };
    filters: Pick<ListTasksQuery, "employeeId" | "status" | "priority" | "q" | "overdue">;
  }): Promise<{ rows: TaskRow[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(opts.pagination);

    let query = db.from("v_task_detail").select(SELECT, { count: "exact" });
    if (opts.filters.employeeId) query = query.eq("employee_id", opts.filters.employeeId);
    if (opts.filters.status) query = query.eq("status", opts.filters.status);
    if (opts.filters.priority) query = query.eq("priority", opts.filters.priority);
    if (opts.filters.overdue) query = query.eq("is_overdue", true);
    if (opts.filters.q) {
      // Escape the LIKE wildcards so a search for "100%" is a literal search
      // rather than a match on everything.
      const safe = opts.filters.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
    }

    const { data, error, count } = await query
      .order(opts.pagination.sort, { ascending: opts.pagination.order === "asc" })
      .range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as TaskRow[], total: count ?? 0 };
  },

  async getById(id: string): Promise<TaskRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db.from("v_task_detail").select(SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as TaskRow) ?? null;
  },

  /**
   * An open task with the same title for the same person.
   *
   * The brief asks to prevent duplicate tasks. Two identical open tasks is
   * almost always a double-submit rather than a genuine pair, so creating one
   * is refused - but only while the first is still open, because doing the same
   * job again next week is normal.
   */
  async findOpenDuplicate(employeeId: string, title: string): Promise<TaskRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("v_task_detail")
      .select(SELECT)
      .eq("employee_id", employeeId)
      .in("status", ["PENDING", "IN_PROGRESS"])
      .ilike("title", title)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as TaskRow) ?? null;
  },

  async create(input: CreateTaskInput, createdBy: string | null): Promise<string> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("tasks")
      .insert({
        title: input.title,
        description: input.description ?? null,
        employee_id: input.employeeId,
        priority: input.priority,
        due_at: input.dueAt ?? null,
        instructions: input.instructions ?? null,
        created_by: createdBy,
      })
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  },

  async update(id: string, patch: UpdateTaskInput): Promise<string | null> {
    const db = requireServiceRole();
    // Typed as the table's own Update shape, so a typo in a column name is a
    // compile error rather than a silent no-op.
    const row: TaskUpdate = {};
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.employeeId !== undefined) row.employee_id = patch.employeeId;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.dueAt !== undefined) row.due_at = patch.dueAt;
    if (patch.instructions !== undefined) row.instructions = patch.instructions;
    if (patch.completionNotes !== undefined) row.completion_notes = patch.completionNotes;

    const { data, error } = await db.from("tasks").update(row).eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  },

  /** Move a task's status, optionally recording what the employee did. */
  async setStatus(id: string, status: TaskRow["status"], completionNotes?: string | null) {
    const db = requireServiceRole();
    const row: TaskUpdate = { status };
    if (completionNotes !== undefined) row.completion_notes = completionNotes;

    const { data, error } = await db.from("tasks").update(row).eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  },

  /** Counts for the dashboard tiles: open, in progress, overdue, done. */
  async counts(employeeId?: string) {
    const db = requireServiceRole();

    // Four small head-only counts, written out. A shared builder helper would
    // need a cast to satisfy supabase-js's generics, and the cast would be the
    // only thing standing between a typo and a silent zero.
    const pending = db.from("v_task_detail").select("id", { count: "exact", head: true }).eq("status", "PENDING");
    const inProgress = db.from("v_task_detail").select("id", { count: "exact", head: true }).eq("status", "IN_PROGRESS");
    const overdue = db.from("v_task_detail").select("id", { count: "exact", head: true }).eq("is_overdue", true);
    const completed = db.from("v_task_detail").select("id", { count: "exact", head: true }).eq("status", "COMPLETED");

    const scoped = employeeId
      ? [pending.eq("employee_id", employeeId), inProgress.eq("employee_id", employeeId), overdue.eq("employee_id", employeeId), completed.eq("employee_id", employeeId)]
      : [pending, inProgress, overdue, completed];

    const results = await Promise.all(scoped);
    for (const res of results) {
      if (res.error) throw res.error;
    }

    return {
      pending: results[0].count ?? 0,
      inProgress: results[1].count ?? 0,
      overdue: results[2].count ?? 0,
      completed: results[3].count ?? 0,
    };
  },
};
