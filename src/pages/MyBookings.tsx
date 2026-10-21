"use client";

/**
 * A client's own appointments.
 *
 * Reads `/me/bookings`, which resolves the caller's `clientId` from their
 * profile — so there is no client id in the request and nothing to tamper
 * with. An account with no linked client row gets an empty list rather than an
 * error, which is the correct answer: they have no bookings.
 */

import * as React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarPlus, Clock3, QrCode, UserRound } from "lucide-react";

import { branchDay, branchLongDay, branchTime, cn, peso, relativeToNow } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { Button } from "@/components/ui/button";
import { EmptyNote, ErrorNote, Loading, StatusBadge } from "@/components/app/api-bits";
import { SectionHeading } from "@/components/app/bits";
import type { BookingStatus } from "@/lib/api-types";

type Tab = "upcoming" | "past" | "all";

const TABS: { id: Tab; label: string }[] = [
  { id: "upcoming", label: "Upcoming" },
  { id: "past", label: "History" },
  { id: "all", label: "Everything" },
];

/** Which bookings are still ahead of us. */
const LIVE: BookingStatus[] = ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_SERVICE"];

export default function MyBookings() {
  const [tab, setTab] = React.useState<Tab>("upcoming");

  const list = useAsync(`mine:${tab}`, async () => {
    const page = await api.bookings.mine({
      limit: 100,
      ...(tab === "upcoming" ? { upcoming: true } : {}),
    });
    if (tab === "all") return page.data;
    const now = Date.now();
    return page.data.filter((b) => {
      const ahead = new Date(b.startTime).getTime() >= now;
      return tab === "upcoming" ? ahead || LIVE.includes(b.status) : !ahead;
    });
  });

  const rows = list.data ?? [];

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-7">
      <SectionHeading
        eyebrow="Your account"
        title="My bookings"
        description="Every appointment on your record, with the arrival pass for each. Passes can be re-opened at any time — the code is re-issued, never reused."
        action={
          <Button asChild>
            <Link to="/book">
              <CalendarPlus className="size-4" />
              Book a service
            </Link>
          </Button>
        }
      />

      <div className="flex gap-1.5">
        {TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setTab(option.id)}
            aria-pressed={tab === option.id}
            className={cn(
              "rounded-full border px-4 py-2 text-[12.5px] font-medium transition-colors",
              tab === option.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {list.error ? (
        <ErrorNote error={list.error} onRetry={list.reload} />
      ) : list.initial ? (
        <Loading label="Fetching your appointments…" />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={CalendarPlus}
          title={tab === "past" ? "No past visits yet" : "Nothing booked"}
          description={
            tab === "past"
              ? "Once you've been in, your visit history appears here."
              : "You have no upcoming appointments. Pick a treatment and we'll hold a chair."
          }
          action={
            <Button asChild>
              <Link to="/book">Browse services</Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((booking) => {
            const live = LIVE.includes(booking.status);
            return (
              <li
                key={booking.id}
                className="flex flex-wrap items-center gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-soft"
              >
                <div className="flex min-w-[86px] flex-col rounded-lg bg-sand-50 px-3.5 py-2.5 text-center">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {branchDay(booking.startTime)}
                  </span>
                  <span className="mt-0.5 font-display text-[17px] font-semibold leading-none">
                    {branchTime(booking.startTime)}
                  </span>
                </div>

                <div className="min-w-[180px] flex-1">
                  <p className="font-display text-[17px] font-semibold leading-tight tracking-tight">
                    {booking.items.map((item) => item.name).join(", ") || booking.reference}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="size-3" />
                      {booking.employee.fullName}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {relativeToNow(booking.startTime)}
                    </span>
                    <span className="font-mono text-[11px]">{booking.reference}</span>
                  </p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    {branchLongDay(booking.startTime)}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-right">
                    <span className="block font-display text-[18px] font-semibold text-primary">
                      {peso(booking.totalCents)}
                    </span>
                    {booking.discountCents > 0 && (
                      <span className="block text-[11px] text-primary">
                        {peso(booking.discountCents)} off
                      </span>
                    )}
                  </span>
                  <StatusBadge status={booking.status} />
                  {live && (
                    <Button asChild variant="outline" size="sm">
                      <Link to={`/pass/${booking.id}`}>
                        <QrCode className="size-3.5" />
                        Pass
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rounded-xl border border-border/80 bg-sand-50 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Cancelling is free up to two hours before your appointment.{" "}
          <Link to="/scan" className="font-medium text-primary hover:underline">
            Lost your pass? Look it up here
          </Link>
          .
        </p>
      </div>

      <p className="text-center text-[12px] text-muted-foreground">
        <ArrowRight className="mr-1 inline size-3.5" />
        Looking for something new?{" "}
        <Link to="/services" className="font-medium text-primary hover:underline">
          Browse the full menu
        </Link>
      </p>
    </div>
  );
}
