"use client";

/**
 * The monitoring board.
 *
 * The layout engine is unchanged — it is a real tiling grid with pointer, touch
 * and keyboard dragging, and the arrangement is remembered per device. What
 * changed is where the numbers come from. Every tile used to read a fixture
 * array; now a single `GET /admin/dashboard` call feeds most of them, with
 * today's run sheet, the employee list and the top clients alongside.
 *
 * **Why one fetch and not one per tile.** Eight tiles asking the same question
 * eight times would put eight round trips on the wire to render one screen, and
 * they would disagree with each other while they resolved. The dashboard
 * endpoint already answers in one pass, so the page asks once and passes the
 * result down. A tile that needed a *different* question would get its own
 * fetch — none of them do.
 *
 * This board is ADMIN-only, and that is the API's doing rather than a choice:
 * `/admin/dashboard` and `/admin/clients` are both `requireRole("ADMIN")`, and
 * a tile showing revenue is not something to fake for staff. Staff get the run
 * sheet on Overview instead, which is the question they actually have.
 */

import * as React from "react";
import { Link } from "react-router-dom";
import {
  GripVertical,
  Lock,
  RotateCcw,
  Sparkles,
  Unlock,
} from "lucide-react";

import { branchTime, branchToday, cn, peso, shiftDayKey } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import type { Booking, ClientRecord, Dashboard, Employee } from "@/lib/api-types";
import { useAsync } from "@/lib/useAsync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DraggableWidgetGrid,
  type WidgetItem,
} from "@/components/ui/draggable-widget-grid";
import { SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, PersonAvatar } from "@/components/app/api-bits";
import { useAuth } from "@/auth/AuthProvider";

/* ------------------------------------------------------------------ *
 * Layout definition
 * ------------------------------------------------------------------ */

type Kind =
  | "revenue"
  | "bookings"
  | "completed"
  | "noshow"
  | "checkedin"
  | "flow"
  | "topservices"
  | "topclients"
  | "runsheet"
  | "floor"
  | "arrivals";

interface BoardWidget extends WidgetItem {
  kind: Kind;
}

const DEFAULT_BOARD: BoardWidget[] = [
  { id: "revenue", kind: "revenue", w: 2, h: 1, label: "Revenue" },
  { id: "bookings", kind: "bookings", w: 1, h: 1, label: "Bookings" },
  { id: "completed", kind: "completed", w: 1, h: 1, label: "Completion rate" },
  { id: "noshow", kind: "noshow", w: 1, h: 1, label: "No-shows" },
  { id: "checkedin", kind: "checkedin", w: 1, h: 1, label: "Arrived" },
  { id: "flow", kind: "flow", w: 2, h: 1, label: "Bookings per day" },
  { id: "topservices", kind: "topservices", w: 2, h: 1, label: "Top treatments" },
  { id: "topclients", kind: "topclients", w: 2, h: 1, label: "Best clients" },
  { id: "runsheet", kind: "runsheet", w: 2, h: 2, label: "Today's run sheet" },
  { id: "floor", kind: "floor", w: 1, h: 2, label: "The floor" },
  { id: "arrivals", kind: "arrivals", w: 1, h: 1, label: "Arrivals today" },
];

const STORAGE_KEY = "alley.board.v3";
const LEGACY_KEY = "alley.board.v2";
const MAX_COLUMNS = 4;
const MAX_ROWS = 4;

/** The four spans the previous `size` enum stood for. */
const SIZE_TO_SPAN: Record<string, { w: number; h: number }> = {
  sm: { w: 1, h: 1 },
  wide: { w: 2, h: 1 },
  tall: { w: 1, h: 2 },
  lg: { w: 2, h: 2 },
};

/**
 * Read a stored layout, accepting either the current `{w,h}` shape or the
 * legacy `{size}` shape. Returns null if anything is untrustworthy, so the
 * caller falls back to the defaults rather than rendering a broken board.
 */
function parseStored(raw: string | null, known: Set<string>): BoardWidget[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const out: BoardWidget[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") return null;
      const { id, kind, label } = entry as Partial<BoardWidget>;
      if (typeof id !== "string" || !known.has(id)) return null;
      let w: number;
      let h: number;
      if (typeof entry.w === "number" && typeof entry.h === "number") {
        w = entry.w;
        h = entry.h;
      } else if (typeof entry.size === "string" && SIZE_TO_SPAN[entry.size]) {
        ({ w, h } = SIZE_TO_SPAN[entry.size]);
      } else {
        return null;
      }
      out.push({
        id,
        kind: kind as Kind,
        label,
        w: Math.max(1, Math.min(Math.floor(w) || 1, MAX_COLUMNS)),
        h: Math.max(1, Math.min(Math.floor(h) || 1, MAX_ROWS)),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Everything the board reads, in one place
 * ------------------------------------------------------------------ */

interface BoardData {
  summary: Dashboard | null;
  today: Booking[];
  employees: Employee[];
  clients: ClientRecord[];
}

function useBoardData(days: number): {
  data: BoardData | null;
  error: ApiError | null;
  initial: boolean;
  reload: () => void;
} {
  const to = branchToday();
  const from = shiftDayKey(to, -(days - 1));

  const state = useAsync(`board:${from}:${to}`, async () => {
    // Independent reads, so they go out together rather than in a queue.
    const [summary, today, employees, clients] = await Promise.all([
      api.admin.dashboard(from, to),
      api.bookings.list({ from: to, to, limit: 100, sort: "start_time", order: "asc" }),
      api.employees.list({ limit: 100, includeInactive: true }),
      api.admin.clients({ limit: 6, sort: "lifetime_value_cents", order: "desc" }),
    ]);
    return {
      summary,
      today: today.data,
      employees: employees.data,
      clients: clients.data,
    } satisfies BoardData;
  });

  return {
    data: state.data,
    error: state.error,
    initial: state.initial,
    reload: state.reload,
  };
}

/* ------------------------------------------------------------------ *
 * Tiny chart primitives (lighter than a chart library per tile)
 * ------------------------------------------------------------------ */

function Spark({ data, className, area = false }: { data: number[]; className?: string; area?: boolean }) {
  const w = 100;
  const h = 40;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = data.length > 1 ? (i / (data.length - 1)) * w : w / 2;
    const y = h - ((v - min) / span) * (h - 8) - 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", className)}
      aria-hidden
    >
      {area && (
        <polygon points={`${pts.join(" ")} ${w},${h} 0,${h}`} fill="currentColor" opacity="0.12" />
      )}
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MiniBars({ data, className }: { data: number[]; className?: string }) {
  const max = Math.max(...data) || 1;
  const last = data.length - 1;
  return (
    <div className={cn("flex h-10 items-end gap-[3px]", className)} aria-hidden>
      {data.map((v, i) => (
        <span
          key={i}
          className={cn("flex-1 rounded-[2px]", i === last ? "bg-primary" : "bg-primary/20")}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="relative size-[86px]">
      <svg viewBox="0 0 72 72" className="size-full -rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" strokeWidth="6" className="stroke-primary/12" />
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          className="stroke-primary transition-[stroke-dasharray] duration-700 ease-out-quart"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-display text-[20px] font-semibold tabular-nums">
        {pct}%
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Widget shell
 * ------------------------------------------------------------------ */

function Shell({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="@container flex h-full flex-col gap-3 p-5">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h3 className="truncate text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {title}
        </h3>
        {meta && <span className="shrink-0 text-[11.5px] text-muted-foreground">{meta}</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

function Big({ children, unit }: { children: React.ReactNode; unit?: string }) {
  return (
    <p className="font-display text-[30px] font-semibold leading-none tracking-tight tabular-nums @[220px]:text-[34px]">
      {children}
      {unit && (
        <span className="ml-1.5 text-[12px] font-normal tracking-normal text-muted-foreground">
          {unit}
        </span>
      )}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * Widgets
 * ------------------------------------------------------------------ */

function WidgetBody({ kind, data }: { kind: Kind; data: BoardData }) {
  const totals = data.summary?.totals;
  const byDay = data.summary?.byDay ?? [];
  const bookedSeries = byDay.map((d) => d.bookings);
  const revenueSeries = byDay.map((d) => d.revenue_cents);

  switch (kind) {
    case "revenue":
      return (
        <Shell title="Revenue" meta="completed only">
          <Big>{peso(totals?.revenueCents ?? 0)}</Big>
          <div className="mt-4 flex min-h-[70px] flex-1 flex-col justify-end">
            {revenueSeries.length > 1 ? (
              <Spark data={revenueSeries} className="text-primary" area />
            ) : (
              <div className="h-10 rounded bg-primary/[0.06]" />
            )}
            <p className="mt-2.5 text-[11px] text-muted-foreground">
              {totals?.completed ?? 0} completed bookings in this period
            </p>
          </div>
        </Shell>
      );

    case "bookings":
      return (
        <Shell title="Bookings" meta={`${byDay.length}d`}>
          <Big>{totals?.bookings ?? 0}</Big>
          <div className="mt-4 flex min-h-[70px] flex-1 flex-col justify-end">
            {bookedSeries.length > 0 ? (
              <MiniBars data={bookedSeries} className="h-full" />
            ) : (
              <div className="h-10 rounded bg-primary/[0.06]" />
            )}
            <p className="mt-2.5 text-[11px] text-muted-foreground">
              {totals?.cancelled ?? 0} cancelled
            </p>
          </div>
        </Shell>
      );

    case "completed": {
      const rate =
        totals && totals.bookings > 0 ? (totals.completed / totals.bookings) * 100 : 0;
      return (
        <Shell title="Completion rate" meta="of all bookings">
          <div className="flex flex-1 items-center justify-center">
            <Gauge value={rate} />
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            {totals?.completed ?? 0} of {totals?.bookings ?? 0} seen through
          </p>
        </Shell>
      );
    }

    case "noshow": {
      const rate = totals && totals.bookings > 0 ? (totals.noShow / totals.bookings) * 100 : 0;
      return (
        <Shell title="No-shows" meta="this period">
          <Big>{rate.toFixed(1)}%</Big>
          <div className="mt-4 flex flex-1 flex-col justify-end gap-2">
            <p className="text-[11.5px] text-muted-foreground">
              {totals?.noShow ?? 0} of {totals?.bookings ?? 0} bookings
            </p>
            <Badge variant={rate > 10 ? "destructive" : "success"} className="w-fit">
              {rate > 10 ? "Worth watching" : "Under control"}
            </Badge>
          </div>
        </Shell>
      );
    }

    case "checkedin":
      return (
        <Shell title="Arrived" meta="checked in or beyond">
          <Big>{totals?.checkedIn ?? 0}</Big>
          <p className="mt-auto text-[11.5px] text-muted-foreground">
            {totals && totals.bookings > 0
              ? `${Math.round((totals.checkedIn / totals.bookings) * 100)}% of bookings reached the chair`
              : "Nothing booked in this period"}
          </p>
        </Shell>
      );

    case "flow":
      return (
        <Shell title="Bookings per day" meta={`${byDay.length} days`}>
          <div className="flex items-baseline gap-3">
            <Big>{totals?.bookings ?? 0}</Big>
            <span className="text-[11.5px] text-muted-foreground">booked in the period</span>
          </div>
          {byDay.length > 0 ? (
            <div className="mt-4 flex min-h-[80px] flex-1 items-end gap-1.5">
              {byDay.map((d) => {
                const max = Math.max(...bookedSeries) || 1;
                return (
                  <div
                    key={d.day}
                    className="flex h-full flex-1 flex-col items-center gap-1.5"
                    title={`${d.day} · ${d.bookings} bookings`}
                  >
                    <div className="flex w-full flex-1 items-end">
                      <span
                        className="w-full rounded-[2px] bg-primary"
                        style={{ height: `${Math.max(4, (d.bookings / max) * 100)}%` }}
                      />
                    </div>
                    <span className="text-[9.5px] text-muted-foreground">{d.day.slice(8, 10)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 flex flex-1 items-center">
              <EmptyNote title="No bookings" description="Nothing booked in this period yet." />
            </div>
          )}
        </Shell>
      );

    case "topservices": {
      const top = data.summary?.topServices ?? [];
      const max = top[0]?.revenue_cents || 1;
      return (
        <Shell title="Top treatments" meta="by revenue">
          {top.length === 0 ? (
            <div className="flex flex-1 items-center">
              <EmptyNote title="No completed bookings" description="Revenue appears once bookings complete." />
            </div>
          ) : (
            <ul className="mt-1 flex flex-1 flex-col justify-start gap-3.5">
              {top.slice(0, 5).map((service) => (
                <li key={service.name}>
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="truncate font-medium">{service.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {peso(service.revenue_cents)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${(service.revenue_cents / max) * 100}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right text-[10.5px] tabular-nums text-muted-foreground">
                      {service.bookings} booked
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Shell>
      );
    }

    case "topclients": {
      const clients = data.clients;
      return (
        <Shell
          title="Best clients"
          meta={
            <Link to="/app/clients" className="hover:text-primary">
              Open clients →
            </Link>
          }
        >
          {clients.length === 0 ? (
            <div className="flex flex-1 items-center">
              <EmptyNote title="No clients yet" description="Client records appear as bookings are made." />
            </div>
          ) : (
            <ul className="mt-1 space-y-2.5">
              {clients.map((client) => (
                <li key={client.id} className="flex items-center gap-2.5">
                  <PersonAvatar name={client.fullName} className="size-7 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">{client.fullName}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">
                      {client.completedBookings} visits
                      {client.noShowBookings > 0 ? ` · ${client.noShowBookings} no-show` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11.5px] font-medium tabular-nums">
                    {peso(client.lifetimeValueCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Shell>
      );
    }

    case "runsheet":
      return (
        <Shell
          title="Today's run sheet"
          meta={
            <Link to="/app/bookings" className="hover:text-primary">
              Open full schedule →
            </Link>
          }
        >
          {data.today.length === 0 ? (
            <div className="flex flex-1 items-center">
              <EmptyNote title="Nothing today" description="No appointments are booked for today." />
            </div>
          ) : (
            <ol className="grid gap-x-8 gap-y-2 @[520px]:grid-cols-2">
              {data.today.slice(0, 10).map((booking) => {
                const name = booking.client?.fullName ?? booking.guest?.name ?? "Walk-in guest";
                return (
                  <li key={booking.id} className="flex items-center gap-2.5 py-1">
                    <span className="w-14 shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
                      {branchTime(booking.startTime)}
                    </span>
                    <PersonAvatar name={name} className="size-6 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium">{name}</p>
                      <p className="truncate text-[10.5px] text-muted-foreground">
                        {booking.items.map((i) => i.name).join(", ") || booking.reference} ·{" "}
                        {booking.employee.fullName.split(" ")[0]}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Shell>
      );

    case "floor": {
      const bookingsToday = new Map<string, number>();
      for (const booking of data.today) {
        bookingsToday.set(
          booking.employee.id,
          (bookingsToday.get(booking.employee.id) ?? 0) + 1,
        );
      }
      const peak = Math.max(1, ...bookingsToday.values());
      return (
        <Shell title="The floor" meta={`${data.employees.length} on the books`}>
          {data.employees.length === 0 ? (
            <div className="flex flex-1 items-center">
              <EmptyNote title="No employees" description="Invite staff to see them here." />
            </div>
          ) : (
            <ul className="space-y-3">
              {data.employees.slice(0, 6).map((employee) => {
                const load = bookingsToday.get(employee.id) ?? 0;
                return (
                  <li key={employee.id} className="flex items-center gap-2.5">
                    <PersonAvatar name={employee.fullName} className="size-7 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium">
                        {employee.fullName}
                        {employee.isActive ? "" : " (inactive)"}
                      </p>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${(load / peak) * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                      {load} today
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-auto pt-3 text-[11px] text-muted-foreground">
            Bar shows bookings assigned today, relative to the busiest stylist.
          </p>
        </Shell>
      );
    }

    case "arrivals": {
      const arrived = data.today.filter((b) =>
        ["CHECKED_IN", "IN_SERVICE", "COMPLETED"].includes(b.status),
      ).length;
      const total = data.today.length;
      return (
        <Shell title="Arrivals today" meta="live">
          <Big>
            {arrived}
            <span className="text-[14px] font-normal text-muted-foreground">/{total}</span>
          </Big>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            checked in · {Math.max(0, total - arrived)} to come
          </p>
          <div className="mt-auto pt-4">
            <div className="flex h-1 overflow-hidden rounded-full bg-muted">
              <span
                className="rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${total > 0 ? (arrived / total) * 100 : 0}%` }}
              />
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Updated each time the desk scans a pass
            </p>
          </div>
        </Shell>
      );
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Board() {
  const { me } = useAuth();
  const [days, setDays] = React.useState(7);
  const [editable, setEditable] = React.useState(true);

  const board = useBoardData(days);

  const [items, setItems] = React.useState<BoardWidget[]>(() => {
    // Only trust a stored layout whose tiles still exist — a renamed kind
    // would otherwise render a permanently blank tile.
    const known = new Set(DEFAULT_BOARD.map((w) => w.id));
    try {
      const fresh = parseStored(localStorage.getItem(STORAGE_KEY), known);
      if (fresh) return fresh;
      // Migrate a v2 layout (discrete `size`) to v3 (`w`/`h`) once.
      const migrated = parseStored(localStorage.getItem(LEGACY_KEY), known);
      if (migrated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_KEY);
        return migrated;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_BOARD;
  });

  function update(next: WidgetItem[]) {
    setItems(next as BoardWidget[]);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  function reset() {
    setItems(DEFAULT_BOARD);
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }

  const firstName = me?.fullName?.split(" ")[0];

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-8">
      <SectionHeading
        eyebrow="Monitoring board"
        title="Arrange the room you think in."
        description={`Every tile is live — ${items.length} panels over the last ${days} days, read from the database. Drag to rearrange and drag a corner to resize; the layout is remembered on this device.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-full border border-border bg-card p-0.5">
              {[7, 14, 30].map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDays(option)}
                  aria-pressed={days === option}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors",
                    days === option
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option}d
                </button>
              ))}
            </div>
            <Button
              variant={editable ? "secondary" : "outline"}
              onClick={() => setEditable((v) => !v)}
            >
              {editable ? <Unlock className="size-4" /> : <Lock className="size-4" />}
              {editable ? "Editing" : "Locked"}
            </Button>
            <Button variant="outline" onClick={reset}>
              <RotateCcw className="size-4" />
              Reset layout
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border/70 bg-sand-50 px-5 py-3.5 text-[12.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <GripVertical className="size-4 text-primary" />
          {editable
            ? "Click a tile to select it, drag it to rearrange, or drag its bottom-right corner to resize. Keys: Alt+arrows move · Alt +/− height · Alt+Shift +/− width."
            : "Layout is locked. Unlock to rearrange."}
        </span>
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-champagne-500" />
          {firstName ? `Good day, ${firstName}` : "Signed in"} · {items.length} tiles
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={board.reload}>
          Refresh
        </Button>
      </div>

      {board.error ? (
        <ErrorNote error={board.error} onRetry={board.reload} />
      ) : board.initial || !board.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-[150px] animate-pulse rounded-2xl border border-border/70 bg-muted/40"
            />
          ))}
        </div>
      ) : (
        <DraggableWidgetGrid
          items={items}
          onChange={update}
          editable={editable}
          maxColumns={4}
          cellSize={252}
          gap={16}
          radius={14}
          renderItem={(item) => (
            <WidgetBody kind={(item as BoardWidget).kind} data={board.data!} />
          )}
        />
      )}

      <p className="text-center text-[12px] text-muted-foreground">
        Tip: revenue, the run sheet and arrivals are the three most people keep top-left.
      </p>
    </div>
  );
}
