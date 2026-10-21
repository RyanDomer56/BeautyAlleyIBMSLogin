"use client";

/**
 * Attendance — time in, time out, hours worked.
 *
 * ## What this page is not
 *
 * It does not decide anything about a person's day. There is no "late" verdict
 * invented in the browser, no absent row conjured for a day nobody clocked in,
 * and no auto-filled time. Everything shown is either a stored fact (a
 * timestamp the server wrote) or an observation against a rule the business
 * configured — `minutesLate` is measured against that employee's rostered
 * shift from `working_hours`, and is `null` when no shift is configured. A day
 * with no record is a day with no record, which is a truthful thing to show.
 *
 * ## One page, two jobs
 *
 * An EMPLOYEE sees their own clock and their own history — the server pins the
 * scope to their token, so this page cannot widen it. The DESK (concierge and
 * admin) sees the same page with the floor's records and a picker to clock in
 * a stylist whose hands are busy. `useAuth().role` only chooses which controls
 * to *render*; the API is what actually enforces it.
 */

import * as React from "react";
import { CalendarClock, Clock, LogIn, LogOut, Timer, Users } from "lucide-react";

import { api } from "@/lib/api";
import type { AttendanceRecord, AttendanceStatus, Employee } from "@/lib/api-types";
import { useAsync } from "@/lib/useAsync";
import { useAuth } from "@/auth/AuthProvider";
import {
  branchDay,
  branchTime,
  branchToday,
  cn,
  minutesToLabel,
  shiftDayKey,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, Loading } from "@/components/app/api-bits";

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  HALF_DAY: "Half day",
  LEAVE: "Leave",
  ABSENT: "Absent",
};

const STATUS_TONE: Record<AttendanceStatus, "success" | "warning" | "secondary" | "destructive"> = {
  PRESENT: "success",
  HALF_DAY: "warning",
  LEAVE: "secondary",
  ABSENT: "destructive",
};

function StatusChip({ record }: { record: AttendanceRecord }) {
  // An open session is the more useful thing to say than "Present" — it is the
  // difference between "here" and "was here".
  if (record.open) {
    return (
      <Badge variant="default" className="gap-1.5">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
        On the clock
      </Badge>
    );
  }
  return <Badge variant={STATUS_TONE[record.status]}>{STATUS_LABEL[record.status]}</Badge>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Panel className="px-4 py-3.5">
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-1.5 text-[22px] font-semibold leading-none tracking-tight">{value}</p>
      {hint && <p className="mt-1.5 text-[11.5px] text-muted-foreground">{hint}</p>}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

function ClockCard({ onChanged }: { onChanged: () => void }) {
  const today = useAsync("attendance:me", () => api.attendance.me());
  const [busy, setBusy] = React.useState<"in" | "out" | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function punch(which: "in" | "out") {
    setBusy(which);
    setError(null);
    setNote(null);
    try {
      const record =
        which === "in" ? await api.attendance.clockIn() : await api.attendance.clockOut();
      setNote(
        which === "in"
          ? `Timed in at ${branchTime(record.timeIn)}.`
          : `Timed out at ${branchTime(record.timeOut ?? record.timeIn)} — ${minutesToLabel(
              record.minutesWorked ?? 0,
            )} on the clock.`,
      );
      today.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const state = today.data;
  const record = state?.record ?? null;

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-10 items-center justify-center rounded-full",
              record?.open ? "bg-success/12 text-success" : "bg-primary/[0.08] text-primary",
            )}
          >
            <Clock className="size-[18px]" />
          </span>
          <div>
            <p className="eyebrow">Today</p>
            <p className="text-[14.5px] font-semibold leading-tight">
              {state ? branchDay(new Date().toISOString()) : "—"}
            </p>
          </div>
        </div>
        {record ? <StatusChip record={record} /> : null}
      </div>

      <div className="px-5 py-5">
        {today.initial ? (
          <Loading label="Reading your clock…" className="border-0 py-6" />
        ) : today.error ? (
          <ErrorNote error={today.error} onRetry={today.reload} />
        ) : !state?.employeeId ? (
          <p className="text-[13.5px] text-muted-foreground">
            {state?.reason ?? "This account is not linked to an employee record."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div>
                <p className="eyebrow">Timed in</p>
                <p className="tnum mt-1 text-[19px] font-semibold leading-none">
                  {record ? branchTime(record.timeIn) : "—"}
                </p>
              </div>
              <div>
                <p className="eyebrow">Timed out</p>
                <p className="tnum mt-1 text-[19px] font-semibold leading-none">
                  {record?.timeOut ? branchTime(record.timeOut) : "—"}
                </p>
              </div>
              <div>
                <p className="eyebrow">Hours</p>
                <p className="tnum mt-1 text-[19px] font-semibold leading-none">
                  {record?.hoursWorked != null ? record.hoursWorked.toFixed(2) : "—"}
                </p>
              </div>
            </div>

            <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">{state.reason}</p>

            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <Button
                onClick={() => void punch("in")}
                disabled={!state.canClockIn || busy !== null}
                className="gap-2"
              >
                <LogIn className="size-4" />
                {busy === "in" ? "Timing in…" : "Time in"}
              </Button>
              <Button
                variant="outline"
                onClick={() => void punch("out")}
                disabled={!state.canClockOut || busy !== null}
                className="gap-2"
              >
                <LogOut className="size-4" />
                {busy === "out" ? "Timing out…" : "Time out"}
              </Button>
            </div>

            {note && (
              <p className="mt-4 rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-2.5 text-[12.5px] text-success">
                {note}
              </p>
            )}
            {error && (
              <p className="mt-4 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-[12.5px] text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * The desk's clock-in
 * ------------------------------------------------------------------ */

function DeskClock({
  employees,
  onChanged,
}: {
  employees: Employee[];
  onChanged: () => void;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [busy, setBusy] = React.useState<"in" | "out" | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function punch(which: "in" | "out") {
    if (!employeeId) return;
    setBusy(which);
    setError(null);
    setNote(null);
    try {
      const record =
        which === "in"
          ? await api.attendance.clockIn({ employeeId })
          : await api.attendance.clockOut({ employeeId });
      setNote(
        which === "in"
          ? `${record.employeeName} timed in at ${branchTime(record.timeIn)}.`
          : `${record.employeeName} timed out — ${minutesToLabel(record.minutesWorked ?? 0)} on the clock.`,
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel className="px-5 py-4">
      <p className="eyebrow">Desk</p>
      <p className="mt-1 text-[13.5px] font-semibold">Clock someone in or out</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        For a stylist whose hands are busy. The time recorded is now, on the branch clock.
      </p>

      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <select
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
        >
          <option value="">Choose an employee…</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <Button disabled={!employeeId || busy !== null} onClick={() => void punch("in")} className="gap-2">
            <LogIn className="size-4" />
            {busy === "in" ? "…" : "Time in"}
          </Button>
          <Button
            variant="outline"
            disabled={!employeeId || busy !== null}
            onClick={() => void punch("out")}
            className="gap-2"
          >
            <LogOut className="size-4" />
            {busy === "out" ? "…" : "Time out"}
          </Button>
        </div>
      </div>

      {note && (
        <p className="mt-3.5 rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-2.5 text-[12.5px] text-success">
          {note}
        </p>
      )}
      {error && (
        <p className="mt-3.5 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Attendance() {
  const { role, me } = useAuth();
  const isDesk = role === "ADMIN" || role === "CONCIERGE";

  const [from, setFrom] = React.useState(() => shiftDayKey(branchToday(), -13));
  const [to, setTo] = React.useState(() => branchToday());
  const [status, setStatus] = React.useState<AttendanceStatus | "">("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [nonce, setNonce] = React.useState(0);

  const employees = useAsync("attendance:employees", () =>
    api.employees.list({ limit: 100, sort: "full_name", order: "asc" }),
  );

  const key = `attendance:list:${from}:${to}:${status}:${employeeId}:${nonce}`;
  const history = useAsync(key, () =>
    api.attendance.list({
      from,
      to,
      limit: 100,
      sort: "work_date",
      order: "desc",
      status: status || undefined,
      employeeId: employeeId || undefined,
    }),
  );

  const summary = useAsync(`attendance:summary:${from}:${to}:${employeeId}:${nonce}`, () =>
    api.attendance.summary({ from, to, employeeId: employeeId || undefined }),
  );

  const refresh = () => setNonce((n) => n + 1);

  const rows = history.data?.data ?? [];
  const totals = summary.data?.totals;

  return (
    <div className="mx-auto max-w-[1180px] space-y-6">
      <SectionHeading
        eyebrow="Work"
        title="Attendance"
        description="Time in and out, and the hours that follow from them. Every timestamp here was written by the server — nothing is estimated, and a day with no record is left empty rather than filled in."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* An employee sees their own clock. The desk sees the same card only
            if their own account happens to be linked to an employee row. */}
        {!isDesk || me?.employeeId ? <ClockCard onChanged={refresh} /> : null}

        {isDesk && (
          <DeskClock employees={employees.data?.data ?? []} onChanged={refresh} />
        )}
      </div>

      {/* --- summary ------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Days present"
          value={totals ? String(totals.present) : "—"}
          hint={totals ? `${totals.completedDays} closed session${totals.completedDays === 1 ? "" : "s"}` : undefined}
        />
        <Stat
          label="Hours worked"
          value={totals ? totals.totalHours.toFixed(1) : "—"}
          hint={totals?.averageHours != null ? `${totals.averageHours.toFixed(1)}h average per day` : "No closed sessions yet"}
        />
        <Stat
          label="Leave"
          value={totals ? String(totals.leave) : "—"}
          hint={totals ? `${totals.halfDay} half day${totals.halfDay === 1 ? "" : "s"}` : undefined}
        />
        <Stat
          label="Still on the clock"
          value={totals ? String(totals.open) : "—"}
          hint="Sessions with no time-out yet"
        />
      </div>

      {/* --- filters ------------------------------------------------- */}
      <Panel className="px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              From
            </span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1.5 block h-10 rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            />
          </label>
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              To
            </span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1.5 block h-10 rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            />
          </label>
          <label className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AttendanceStatus | "")}
              className="mt-1.5 block h-10 rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            >
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABEL) as AttendanceStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {isDesk && (
            <label className="min-w-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Employee
              </span>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="mt-1.5 block h-10 min-w-[190px] rounded-lg border border-border bg-card px-3 text-[13.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              >
                <option value="">Everyone</option>
                {(employees.data?.data ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button variant="outline" onClick={refresh} className="h-10 gap-2">
            <Timer className="size-4" />
            Refresh
          </Button>
        </div>
      </Panel>

      {/* --- history -------------------------------------------------- */}
      {history.initial ? (
        <Loading label="Loading attendance…" />
      ) : history.error ? (
        <ErrorNote error={history.error} onRetry={history.reload} />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={CalendarClock}
          title="No attendance in this range"
          description="Nothing was recorded between these dates. Widen the range, or clear the filters."
        />
      ) : (
        <Panel className="overflow-hidden">
          <div className="scroll-slim overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border/70 bg-muted/40">
                  {["Date", "Employee", "Time in", "Time out", "Total hours", "Status", "Remarks"].map(
                    (h) => (
                      <th
                        key={h}
                        className="whitespace-nowrap px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-[13px] font-medium">
                      {branchDay(`${r.date}T00:00:00+08:00`)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[13px]">
                      {isDesk ? r.employeeName : "You"}
                    </td>
                    <td className="tnum whitespace-nowrap px-4 py-3 text-[13px]">{branchTime(r.timeIn)}</td>
                    <td className="tnum whitespace-nowrap px-4 py-3 text-[13px]">
                      {r.timeOut ? branchTime(r.timeOut) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="tnum whitespace-nowrap px-4 py-3 text-[13px]">
                      {r.hoursWorked != null ? (
                        r.hoursWorked.toFixed(2)
                      ) : (
                        <span className="text-muted-foreground">In progress</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusChip record={r} />
                    </td>
                    <td className="max-w-[240px] px-4 py-3 text-[12.5px] text-muted-foreground">
                      {r.remarks ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {history.data?.meta && (
            <p className="border-t border-border/70 px-4 py-3 text-[12px] text-muted-foreground">
              Showing {rows.length} of {history.data.meta.total} record
              {history.data.meta.total === 1 ? "" : "s"} · branch time (Asia/Manila)
            </p>
          )}
        </Panel>
      )}

      <p className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
        <Users className="mt-0.5 size-3.5 shrink-0" />
        {isDesk
          ? "You are seeing the whole floor. An employee opening this page sees only their own rows — the API pins that scope to their token, not to a filter this page sends."
          : "This is your own record. Days you did not clock in are left empty rather than marked absent, because absence is a business decision, not a fact the clock can know."}
      </p>
    </div>
  );
}
