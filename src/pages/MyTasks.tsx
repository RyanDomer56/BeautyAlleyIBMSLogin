"use client";

/**
 * My tasks — the floor's own worklist.
 *
 * The counterpart to `Tasks.tsx`. The desk *assigns*; this page is where the
 * work is *done*. Both read the same rows — there is no second copy of a task
 * anywhere — and the API decides who may see which: `/tasks/mine` is scoped to
 * the caller's employee row, so this page cannot show a colleague's work even
 * if it asked to.
 *
 * An employee may move a task's status and say what happened. They may not
 * rename it, reassign it or cancel it — those are the desk's, and the API
 * refuses them with a 403 whatever this page renders.
 */

import * as React from "react";
import { CheckCircle2, CircleDashed, ClipboardList, Loader2, PlayCircle } from "lucide-react";

import { api } from "@/lib/api";
import type { Task, TaskPriority, TaskStatus } from "@/lib/api-types";
import { useAsync } from "@/lib/useAsync";
import { branchDay, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, Loading } from "@/components/app/api-bits";

/* ------------------------------------------------------------------ *
 * Shared vocabulary
 * ------------------------------------------------------------------ */

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

const PRIORITY_TONE: Record<TaskPriority, "secondary" | "outline" | "warning" | "destructive"> = {
  LOW: "secondary",
  MEDIUM: "outline",
  HIGH: "warning",
  URGENT: "destructive",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return <Badge variant={PRIORITY_TONE[priority]}>{PRIORITY_LABEL[priority]}</Badge>;
}

export function TaskStatusBadge({ status, overdue }: { status: TaskStatus; overdue?: boolean }) {
  if (overdue && status !== "COMPLETED" && status !== "CANCELLED") {
    return <Badge variant="destructive">Overdue</Badge>;
  }
  const tone: Record<TaskStatus, "default" | "success" | "secondary" | "outline"> = {
    PENDING: "outline",
    IN_PROGRESS: "default",
    COMPLETED: "success",
    CANCELLED: "secondary",
  };
  return <Badge variant={tone[status]}>{STATUS_LABEL[status]}</Badge>;
}

function Tile({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  tone?: "default" | "warning" | "destructive" | "success";
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Panel className="flex items-center gap-3.5 px-4 py-3.5">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          tone === "destructive" && "bg-destructive/10 text-destructive",
          tone === "warning" && "bg-accent/20 text-accent-foreground",
          tone === "success" && "bg-success/12 text-success",
          (!tone || tone === "default") && "bg-primary/[0.08] text-primary",
        )}
      >
        <Icon className="size-[17px]" />
      </span>
      <div className="min-w-0">
        <p className="eyebrow">{label}</p>
        <p className="tnum mt-0.5 text-[20px] font-semibold leading-none">{value}</p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * A task row
 * ------------------------------------------------------------------ */

function TaskCard({
  task,
  onChanged,
}: {
  task: Task;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState<TaskStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const terminal = task.status === "COMPLETED" || task.status === "CANCELLED";

  async function move(status: TaskStatus, completionNotes?: string) {
    setBusy(status);
    setError(null);
    try {
      await api.tasks.setStatus(task.id, status, completionNotes);
      setOpen(false);
      setNotes("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
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
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground text-pretty">
              {task.description}
            </p>
          )}
        </div>
      </div>

      <dl className="mt-3.5 grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Assigned by", value: task.assignedBy },
          { label: "Date assigned", value: branchDay(task.assignedAt) },
          {
            label: "Due",
            value: task.dueAt ? branchDay(task.dueAt) : "No deadline",
          },
          {
            label: "Completed",
            value: task.completedAt ? branchDay(task.completedAt) : "—",
          },
        ].map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {f.label}
            </dt>
            <dd className="mt-0.5 truncate text-[13px]">{f.value}</dd>
          </div>
        ))}
      </dl>

      {task.instructions && (
        <div className="mt-3.5 rounded-lg border border-border/70 bg-muted/40 px-3.5 py-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Instructions
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed">{task.instructions}</p>
        </div>
      )}

      {task.completionNotes && (
        <div className="mt-3 rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-success">
            What you reported
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed">{task.completionNotes}</p>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-[12.5px] text-destructive">
          {error}
        </p>
      )}

      {!terminal && (
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {task.status === "PENDING" && (
            <Button
              variant="outline"
              className="gap-2"
              disabled={busy !== null}
              onClick={() => void move("IN_PROGRESS")}
            >
              <PlayCircle className="size-4" />
              {busy === "IN_PROGRESS" ? "Starting…" : "Start"}
            </Button>
          )}
          {!open ? (
            <Button className="gap-2" disabled={busy !== null} onClick={() => setOpen(true)}>
              <CheckCircle2 className="size-4" />
              Mark complete
            </Button>
          ) : (
            <div className="w-full">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  What did you do? (optional)
                </span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Restocked the room and wiped the mirrors."
                  className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                />
              </label>
              <div className="mt-2.5 flex gap-2">
                <Button
                  className="gap-2"
                  disabled={busy !== null}
                  onClick={() => void move("COMPLETED", notes.trim() || undefined)}
                >
                  <CheckCircle2 className="size-4" />
                  {busy === "COMPLETED" ? "Saving…" : "Confirm complete"}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function MyTasks() {
  const [status, setStatus] = React.useState<TaskStatus | "">("");
  const [priority, setPriority] = React.useState<TaskPriority | "">("");
  const [nonce, setNonce] = React.useState(0);

  const counts = useAsync(`mytasks:counts:${nonce}`, () => api.tasks.counts());

  const list = useAsync(`mytasks:list:${status}:${priority}:${nonce}`, () =>
    api.tasks.mine({
      limit: 100,
      sort: "created_at",
      order: "desc",
      status: status || undefined,
      priority: priority || undefined,
    }),
  );

  const refresh = () => setNonce((n) => n + 1);

  const all = list.data?.data ?? [];
  // The filter is applied server-side; this split is only about presentation —
  // finished work belongs in its own section, not mixed into the to-do pile.
  const open = all.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS");
  const done = all.filter((t) => t.status === "COMPLETED" || t.status === "CANCELLED");
  const showHistoryOnly = status === "COMPLETED" || status === "CANCELLED";

  return (
    <div className="mx-auto max-w-[1100px] space-y-6">
      <SectionHeading
        eyebrow="Work"
        title="My tasks"
        description="What the desk has asked you to do. Starting a task and completing it are yours to record; renaming it or handing it to someone else is not."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Pending" value={counts.data?.pending ?? "—"} icon={CircleDashed} />
        <Tile label="In progress" value={counts.data?.inProgress ?? "—"} icon={Loader2} />
        <Tile
          label="Overdue"
          value={counts.data?.overdue ?? "—"}
          tone={counts.data?.overdue ? "destructive" : "default"}
          icon={ClipboardList}
        />
        <Tile label="Completed" value={counts.data?.completed ?? "—"} tone="success" icon={CheckCircle2} />
      </div>

      <Panel className="px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus | "")}
              className="mt-1.5 block h-10 min-w-[170px] rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
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
              className="mt-1.5 block h-10 min-w-[150px] rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            >
              <option value="">Any priority</option>
              {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline" className="h-10" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </Panel>

      {list.initial ? (
        <Loading label="Loading your tasks…" />
      ) : list.error ? (
        <ErrorNote error={list.error} onRetry={list.reload} />
      ) : all.length === 0 ? (
        <EmptyNote
          icon={ClipboardList}
          title="Nothing assigned"
          description={
            status || priority
              ? "No task matches these filters. Try clearing them."
              : "When the desk assigns you work it will appear here."
          }
        />
      ) : (
        <div className="space-y-6">
          {!showHistoryOnly && (
            <section className="space-y-3">
              <h2 className="eyebrow">Open · {open.length}</h2>
              {open.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-5 py-6 text-center text-[13px] text-muted-foreground">
                  Nothing open. Every task assigned to you is finished.
                </p>
              ) : (
                open.map((t) => <TaskCard key={t.id} task={t} onChanged={refresh} />)
              )}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="eyebrow">History · {done.length}</h2>
            {done.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-5 py-6 text-center text-[13px] text-muted-foreground">
                No completed work yet.
              </p>
            ) : (
              done.map((t) => <TaskCard key={t.id} task={t} onChanged={refresh} />)
            )}
          </section>
        </div>
      )}
    </div>
  );
}
