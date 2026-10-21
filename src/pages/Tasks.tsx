"use client";

/**
 * Task board — the desk assigns the work.
 *
 * The other half of `MyTasks.tsx`, over the *same* records: a task created here
 * appears on the assignee's "My tasks" page the moment it is saved, and a
 * status the employee moves it to shows up here. There is deliberately no
 * second store, no local copy and no optimistic duplicate — every write goes
 * to the API and the row is re-read from the database before it is rendered,
 * so the two dashboards can never disagree.
 *
 * Assignment, editing and cancelling are DESK actions. An employee hitting any
 * of them gets a 403 from the API regardless of what this page renders.
 */

import * as React from "react";
import { CalendarClock, ClipboardList, Plus, Search, XCircle } from "lucide-react";

import { api } from "@/lib/api";
import type { Employee, Task, TaskPriority, TaskStatus } from "@/lib/api-types";
import { useAsync } from "@/lib/useAsync";
import { branchDay } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel, SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, Loading, TextField } from "@/components/app/api-bits";
import { PriorityBadge, TaskStatusBadge } from "@/pages/MyTasks";

const STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

const selectClass =
  "mt-1.5 block h-10 w-full rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15";

/* ------------------------------------------------------------------ *
 * Assign form
 * ------------------------------------------------------------------ */

function AssignForm({
  employees,
  onCreated,
}: {
  employees: Employee[];
  onCreated: (message: string) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [priority, setPriority] = React.useState<TaskPriority>("MEDIUM");
  const [dueAt, setDueAt] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [duplicate, setDuplicate] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      const task = await api.tasks.create({
        title: title.trim(),
        description: description.trim() || undefined,
        employeeId,
        priority,
        // A date input gives `YYYY-MM-DD`; the API wants an instant. Noon at the
        // branch keeps the deadline on the intended calendar day in every zone
        // the row might be read from.
        dueAt: dueAt ? `${dueAt}T12:00:00+08:00` : undefined,
        instructions: instructions.trim() || undefined,
      });
      setTitle("");
      setDescription("");
      setDueAt("");
      setInstructions("");
      onCreated(`${task.reference} assigned to ${task.employeeName}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      // The API names the task that already covers this work — surface it so
      // the desk can look at it rather than retyping the same job.
      const details = (err as { details?: { reference?: string } })?.details;
      if (details?.reference) setDuplicate(`${details.reference} already covers this for that person.`);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="px-5 py-5">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
          <Plus className="size-4" />
        </span>
        <h2 className="font-display text-[17px] font-semibold">Assign a task</h2>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-3.5">
        <TextField
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Restock the treatment room"
          required
          maxLength={160}
        />

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="What the job is, in a sentence."
            className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </label>

        <div className="grid gap-3.5 sm:grid-cols-3">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Assign to
            </span>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              required
              className={selectClass}
            >
              <option value="">Choose an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Priority
            </span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className={selectClass}
            >
              {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Due date
            </span>
            <input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className={selectClass}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Instructions / remarks
          </span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Anything they need to know before they start."
            className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </label>

        {duplicate && (
          <p className="rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2.5 text-[12.5px] text-accent-foreground">
            {duplicate} Cancel it first if this is genuinely a new round of the same work.
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-[12.5px] text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || !title.trim() || !employeeId} className="gap-2">
          <Plus className="size-4" />
          {busy ? "Assigning…" : "Assign task"}
        </Button>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Board row
 * ------------------------------------------------------------------ */

function TaskRow({
  task,
  employees,
  onChanged,
}: {
  task: Task;
  employees: Employee[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [employeeId, setEmployeeId] = React.useState(task.employeeId);
  const [priority, setPriority] = React.useState<TaskPriority>(task.priority);
  const [dueAt, setDueAt] = React.useState(task.dueAt ? task.dueAt.slice(0, 10) : "");
  const [instructions, setInstructions] = React.useState(task.instructions ?? "");

  const terminal = task.status === "CANCELLED";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.tasks.update(task.id, {
        employeeId,
        priority,
        dueAt: dueAt ? `${dueAt}T12:00:00+08:00` : null,
        instructions: instructions.trim() || null,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.tasks.cancel(task.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tnum rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
              {task.reference}
            </span>
            <TaskStatusBadge status={task.status} overdue={task.overdue} />
            <PriorityBadge priority={task.priority} />
          </div>
          <h3 className="mt-2 font-display text-[16.5px] font-semibold leading-snug">{task.title}</h3>
          {task.description && (
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground text-pretty">
              {task.description}
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          {!terminal && (
            <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)} disabled={busy}>
              {editing ? "Close" : "Edit"}
            </Button>
          )}
          {task.status !== "CANCELLED" && task.status !== "COMPLETED" && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10"
              onClick={() => void cancel()}
              disabled={busy}
            >
              <XCircle className="size-3.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      <dl className="mt-3.5 grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Assigned to", value: task.employeeName },
          { label: "Assigned by", value: task.assignedBy },
          { label: "Date assigned", value: branchDay(task.assignedAt) },
          { label: "Due", value: task.dueAt ? branchDay(task.dueAt) : "No deadline" },
        ].map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {f.label}
            </dt>
            <dd className="mt-0.5 truncate text-[13px]">{f.value}</dd>
          </div>
        ))}
      </dl>

      {task.instructions && !editing && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Instructions: </span>
          {task.instructions}
        </p>
      )}

      {task.completionNotes && (
        <div className="mt-3 rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-success">
            Completion notes
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed">{task.completionNotes}</p>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-[12.5px] text-destructive">
          {error}
        </p>
      )}

      {editing && (
        <div className="mt-4 space-y-3.5 rounded-xl border border-border/70 bg-muted/30 px-4 py-4">
          <div className="grid gap-3.5 sm:grid-cols-3">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Assign to
              </span>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={selectClass}
              >
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Priority
              </span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className={selectClass}
              >
                {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Due date
              </span>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className={selectClass}
              />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Instructions / remarks
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            />
          </label>
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Tasks() {
  const [status, setStatus] = React.useState<TaskStatus | "">("");
  const [priority, setPriority] = React.useState<TaskPriority | "">("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [q, setQ] = React.useState("");
  const [overdue, setOverdue] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const [flash, setFlash] = React.useState<string | null>(null);

  const employees = useAsync("tasks:employees", () =>
    api.employees.list({ limit: 100, sort: "full_name", order: "asc" }),
  );

  const counts = useAsync(`tasks:counts:${nonce}`, () => api.tasks.counts());

  const list = useAsync(
    `tasks:list:${status}:${priority}:${employeeId}:${q}:${overdue}:${nonce}`,
    () =>
      api.tasks.list({
        limit: 100,
        sort: "created_at",
        order: "desc",
        status: status || undefined,
        priority: priority || undefined,
        employeeId: employeeId || undefined,
        q: q.trim() || undefined,
        overdue: overdue || undefined,
      }),
  );

  const refresh = () => setNonce((n) => n + 1);
  const rows = list.data?.data ?? [];

  return (
    <div className="mx-auto max-w-[1100px] space-y-6">
      <SectionHeading
        eyebrow="Work"
        title="Task board"
        description="Assign work to the floor and follow it through. What you create here appears on that employee's own My tasks page immediately — one set of records, two views."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Pending", value: counts.data?.pending, tone: "" },
          { label: "In progress", value: counts.data?.inProgress, tone: "" },
          { label: "Overdue", value: counts.data?.overdue, tone: "text-destructive" },
          { label: "Completed", value: counts.data?.completed, tone: "text-success" },
        ].map((t) => (
          <Panel key={t.label} className="px-4 py-3.5">
            <p className="eyebrow">{t.label}</p>
            <p className={`tnum mt-1.5 text-[22px] font-semibold leading-none ${t.tone}`}>
              {t.value ?? "—"}
            </p>
          </Panel>
        ))}
      </div>

      {flash && (
        <p className="rounded-lg border border-success/25 bg-success/[0.06] px-4 py-3 text-[13px] text-success">
          {flash}
        </p>
      )}

      <AssignForm
        employees={employees.data?.data ?? []}
        onCreated={(message) => {
          setFlash(message);
          refresh();
        }}
      />

      <Panel className="px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Search
            </span>
            <span className="relative mt-1.5 block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title or description…"
                className="h-10 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              />
            </span>
          </label>
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus | "")}
              className={selectClass}
            >
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Priority
            </span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority | "")}
              className={selectClass}
            >
              <option value="">Any priority</option>
              {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Employee
            </span>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className={selectClass}
            >
              <option value="">Everyone</option>
              {(employees.data?.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-10 items-center gap-2 whitespace-nowrap text-[13px]">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => setOverdue(e.target.checked)}
              className="size-4 rounded border-border accent-primary"
            />
            Overdue only
          </label>
          <Button variant="outline" className="h-10" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </Panel>

      {list.initial ? (
        <Loading label="Loading the board…" />
      ) : list.error ? (
        <ErrorNote error={list.error} onRetry={list.reload} />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={ClipboardList}
          title="No tasks match"
          description="Nothing on the board for these filters. Assign one above, or clear the filters."
        />
      ) : (
        <div className="space-y-3">
          <h2 className="eyebrow">
            <CalendarClock className="mr-1.5 inline size-3.5" />
            {rows.length} task{rows.length === 1 ? "" : "s"}
          </h2>
          {rows.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              employees={employees.data?.data ?? []}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
