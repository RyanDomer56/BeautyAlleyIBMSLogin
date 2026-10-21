"use client";

/**
 * The bookings record.
 *
 * This is the operational heart of the console and it serves every working
 * role from one page, because the API does: `GET /bookings` is `OPERATIONS`,
 * so a therapist, the concierge and the owner all read the same rows. What
 * differs is which of them can act on them, and that is enforced server-side
 * by `PATCH /bookings/:id/status`. Reassigning the room is narrower still —
 * `PATCH /bookings/:id/room` is `DESK`, so only the concierge and the owner
 * see that control.
 *
 * The status buttons are generated from `NEXT_STATUS`, which mirrors the
 * database trigger's state machine. Offering only legal transitions means the
 * UI cannot produce a request the database will reject — the alternative is a
 * row of buttons where most of them return `INVALID_STATUS_TRANSITION`.
 */

import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Filter,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";

import { branchDay, branchTime, branchToday, cn, peso, shiftDayKey } from "@/lib/utils";
import { api, ApiError, NEXT_STATUS, STATUS_LABEL } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import type { Booking, BookingStatus } from "@/lib/api-types";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, Loading, PersonAvatar, StatusBadge } from "@/components/app/api-bits";

const STATUSES: BookingStatus[] = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_SERVICE",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];

type Range = "today" | "upcoming" | "past" | "all";

const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Next 7 days" },
  { id: "past", label: "Last 7 days" },
  { id: "all", label: "All time" },
];

function rangeBounds(range: Range): { from?: string; to?: string } {
  const today = branchToday();
  switch (range) {
    case "today":
      return { from: today, to: today };
    case "upcoming":
      return { from: today, to: shiftDayKey(today, 7) };
    case "past":
      return { from: shiftDayKey(today, -7), to: today };
    default:
      return {};
  }
}

function useDebounced<T>(value: T, ms = 300) {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function Bookings() {
  /*
   * Seeded from the URL once, on mount, so another page can hand this one a
   * question instead of a bare page: `/app/bookings?range=all&q=BA-1A2B` opens
   * on that booking. Only the first read is taken — after that the controls own
   * the state, because a URL that keeps overwriting what you type is worse than
   * one that is a moment out of date.
   */
  const [params] = useSearchParams();
  const seedRange = params.get("range");
  const seedStatus = params.get("status");

  const [range, setRange] = React.useState<Range>(() =>
    RANGES.some((r) => r.id === seedRange) ? (seedRange as Range) : "upcoming",
  );
  const [status, setStatus] = React.useState<BookingStatus | "">(() =>
    STATUSES.includes(seedStatus as BookingStatus) ? (seedStatus as BookingStatus) : "",
  );
  const [term, setTerm] = React.useState(() => params.get("q") ?? "");
  const [page, setPage] = React.useState(1);
  const q = useDebounced(term);

  // Any filter change invalidates the current page number.
  React.useEffect(() => {
    setPage(1);
  }, [range, status, q]);

  const bounds = rangeBounds(range);

  const list = useAsync(
    `bookings:${range}:${status}:${q}:${page}`,
    () =>
      api.bookings.list({
        page,
        limit: 20,
        sort: "start_time",
        order: range === "past" ? "desc" : "asc",
        ...bounds,
        ...(status ? { status } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      }),
  );

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<ApiError | null>(null);

  async function advance(booking: Booking, next: BookingStatus) {
    setBusyId(booking.id);
    setActionError(null);
    try {
      await api.bookings.setStatus(booking.id, next);
      list.reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not move that booking"),
      );
    } finally {
      setBusyId(null);
    }
  }

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtersActive = Boolean(q.trim() || status);

  return (
    <div className="mx-auto w-full max-w-[1300px] space-y-7">
      <SectionHeading
        eyebrow="Records"
        title="Bookings"
        description="Every reservation, across every chair. Status changes here are the same ones the database enforces — only legal moves are offered."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={list.reload}>
              <RefreshCw className="size-4" />
            </Button>
            <Button asChild>
              <Link to="/book">
                <Plus className="size-4" />
                New booking
              </Link>
            </Button>
          </div>
        }
      />

      {/* ------------------------------------------------------- filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/80 bg-card p-4">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Client, guest, or reference…"
            aria-label="Search bookings"
            className="h-9 w-full rounded-full border border-border bg-background pl-10 pr-3 text-[13px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </div>

        <div className="flex rounded-full border border-border bg-background p-0.5">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setRange(option.id)}
              aria-pressed={range === option.id}
              className={cn(
                "rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
                range === option.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <Filter className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as BookingStatus | "")}
            aria-label="Filter by status"
            className="h-9 appearance-none rounded-full border border-border bg-background pl-8 pr-8 text-[12.5px] outline-none focus:border-primary/50"
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTerm("");
              setStatus("");
            }}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        )}

        <span className="ml-auto text-[12.5px] text-muted-foreground">
          {meta ? `${meta.total} result${meta.total === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      {actionError && <ErrorNote error={actionError} />}

      {/* --------------------------------------------------------- records */}
      {list.error ? (
        <ErrorNote error={list.error} onRetry={list.reload} />
      ) : list.initial ? (
        <Loading label="Fetching bookings…" />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={CalendarDays}
          title="No bookings match"
          description={
            filtersActive
              ? "Try a wider date range, or clear the filters."
              : "Nothing has been booked in this window yet."
          }
          action={
            filtersActive ? (
              <Button
                variant="outline"
                onClick={() => {
                  setTerm("");
                  setStatus("");
                  setRange("all");
                }}
              >
                Show everything
              </Button>
            ) : (
              <Button asChild>
                <Link to="/book">Create a booking</Link>
              </Button>
            )
          }
        />
      ) : (
        /*
         * Cards, not a table. The console's home page already reads as a stack
         * of appointment cards, and the same row is the right shape here: a
         * table forced six columns into 900px, which pushed the reference and
         * the treatment into each other on a laptop. The card wraps instead of
         * overflowing, and a row means the same thing on both pages.
         */
        <ol className="space-y-3">
          {rows.map((booking) => {
            const who = booking.client?.fullName ?? booking.guest?.name ?? "Guest booking";
            const next = NEXT_STATUS[booking.status];
            return (
              <li
                key={booking.id}
                className="flex flex-wrap items-center gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-soft"
              >
                <span className="flex min-w-[70px] flex-col rounded-lg bg-sand-50 px-3 py-2 text-center">
                  <span className="font-display text-[16px] font-semibold leading-none tabular-nums">
                    {branchTime(booking.startTime)}
                  </span>
                  <span className="mt-1 text-[10px] text-muted-foreground">
                    {branchDay(booking.startTime)}
                  </span>
                </span>

                <PersonAvatar name={who} className="size-10 shrink-0" />

                <div className="min-w-[190px] flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2.5">
                    <p className="font-display text-[17px] font-semibold leading-tight tracking-tight">
                      {who}
                    </p>
                    <span className="font-mono text-[10.5px] text-muted-foreground">
                      {booking.reference}
                    </span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Sparkles className="size-3" />
                      {booking.items.map((i) => i.name).join(", ") || "—"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="size-3" />
                      {booking.employee.fullName}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {booking.items.reduce((n, i) => n + i.durationMinutes, 0)} min
                    </span>
                  </p>
                  {booking.notes && (
                    <p className="mt-1.5 truncate text-[11.5px] text-champagne-600">
                      Note: {booking.notes}
                    </p>
                  )}
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-[13px] font-medium tabular-nums">
                    {peso(booking.totalCents)}
                  </p>
                  {booking.discountCents > 0 && (
                    <p className="text-[10.5px] text-primary">
                      −{peso(booking.discountCents)}
                    </p>
                  )}
                </div>

                <StatusBadge status={booking.status} />

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {next.length === 0 ? (
                    <span className="text-[11.5px] text-muted-foreground">Settled</span>
                  ) : (
                    next.slice(0, 2).map((s, index) => {
                      const destructive = s === "NO_SHOW" || s === "CANCELLED";
                      return (
                        <Button
                          key={s}
                          size="sm"
                          // The forward move is the loud one, as on the run
                          // sheet: two identical buttons make the desk read
                          // both before choosing, which is the cost this list
                          // exists to avoid.
                          variant={destructive ? "ghost" : index === 0 ? "default" : "outline"}
                          className={cn(destructive && "text-clay hover:bg-clay/10")}
                          disabled={busyId === booking.id}
                          onClick={() => advance(booking, s)}
                        >
                          {STATUS_LABEL[s]}
                        </Button>
                      );
                    })
                  )}
                  {booking.client === null && booking.status !== "CANCELLED" && (
                    <Button asChild size="sm" variant="ghost">
                      <Link to={`/pass/${booking.id}`}>Pass</Link>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/80 bg-card px-5 py-3.5 shadow-soft">
          <p className="text-[12px] text-muted-foreground">
            Page {meta.page} of {meta.totalPages} · {meta.total} bookings
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!meta.hasPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!meta.hasNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
