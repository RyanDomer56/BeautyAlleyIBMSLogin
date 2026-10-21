"use client";

/**
 * The desk, inside the console.
 *
 * Two things happen here, and they are genuinely different:
 *
 *   1. **Redeem a pass.** The guest shows their QR; the front desk pastes or
 *      scans the `BA1.…` token and `POST /qr/check-in` decides. The signature
 *      is verified first and then the `qr_tokens` row is consulted, because a
 *      signature proves *we* issued a pass but says nothing about whether it
 *      has already been used or was revoked. The server is the authority on
 *      that; this page just relays the answer.
 *
 *   2. **The walk-in code.** `GET /qr/branch` returns the code mounted at
 *      reception, which simply points at the public booking page. Note the
 *      API is explicit that this code `authorises: false` — it is a shortcut to
 *      the booking form, not a credential. It is rendered as such.
 *
 * Today's arrivals come from the ordinary bookings list, bounded to the
 * branch's calendar day in `Asia/Manila`. The bounds are sent as plain
 * `YYYY-MM-DD` days and the API resolves them in the branch's zone — the same
 * contract the run sheet uses, so "today" means the same thing on both pages.
 */

import * as React from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  BadgeCheck,
  CalendarCheck,
  CheckCircle2,
  Clock3,
  Loader2,
  QrCode,
  ScanLine,
  Users,
} from "lucide-react";

import { branchLongDay, branchTime, branchToday, peso } from "@/lib/utils";
import { api, ApiError, NEXT_STATUS } from "@/lib/api";
import type { Booking, CheckInResult } from "@/lib/api-types";
import { useAsync } from "@/lib/useAsync";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  EmptyNote,
  ErrorNote,
  Loading,
  PersonAvatar,
  StatusBadge,
} from "@/components/app/api-bits";
import { Reveal } from "@/components/app/reveal";

/** `YYYY-MM-DD` at the branch -> the UTC instants that bracket it. */
const ARRIVED: Booking["status"][] = ["CHECKED_IN", "IN_SERVICE", "COMPLETED"];

/* ------------------------------------------------------------------ *
 * Redeem
 * ------------------------------------------------------------------ */

function Redeem() {
  const [pass, setPass] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [done, setDone] = React.useState<CheckInResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !pass.trim()) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await api.qr.checkIn(pass.trim()));
      setPass("");
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not check that in"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Redeem an arrival pass</CardTitle>
        <CardDescription>
          Scan the guest's code, or paste it. Each pass works once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative flex aspect-[16/9] items-center justify-center overflow-hidden rounded-xl border border-border/80 bg-sidebar">
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.14]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)",
              backgroundSize: "26px 26px",
            }}
          />
          {done ? (
            <div className="relative text-center">
              <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                <CheckCircle2 className="size-7" />
              </span>
              <p className="mt-4 font-display text-[22px] font-semibold text-primary-foreground">
                {done.reference}
              </p>
              <p className="mt-1 text-[12.5px] text-primary-foreground/65">
                Checked in at {branchTime(done.checkedInAt)}
              </p>
            </div>
          ) : (
            <div className="relative text-center">
              <ScanLine className="mx-auto size-8 text-champagne-400" />
              <p className="mt-4 text-[13.5px] text-primary-foreground/80">Ready to scan</p>
              <p className="mt-1 text-[11.5px] text-primary-foreground/45">
                Align the pass inside the frame
              </p>
            </div>
          )}
        </div>

        <form onSubmit={submit} className="space-y-3">
          <textarea
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
              setError(null);
            }}
            rows={2}
            placeholder="BA1.… or the URL the QR encodes"
            aria-label="Arrival pass"
            className="w-full resize-none rounded-lg border border-border bg-card px-3.5 py-3 font-mono text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
          <Button type="submit" disabled={busy || !pass.trim()}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Checking in…
              </>
            ) : (
              <>
                <BadgeCheck className="size-4" />
                Check in this guest
              </>
            )}
          </Button>
        </form>

        {error && <ErrorNote error={error} />}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Walk-in code
 * ------------------------------------------------------------------ */

function WalkInCode() {
  const branch = useAsync("qr:branch", () => api.qr.branch());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">The code at reception</CardTitle>
        <CardDescription>
          A walk-in scans this and lands on the booking desk — no account needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {branch.initial ? (
          <Loading label="Loading the branch code…" />
        ) : branch.error ? (
          <ErrorNote error={branch.error} onRetry={branch.reload} />
        ) : branch.data ? (
          <div className="flex flex-col items-center">
            <div className="rounded-2xl bg-white p-5 ring-1 ring-border">
              <QRCodeSVG
                value={branch.data.url}
                size={168}
                bgColor="#ffffff"
                fgColor="#1B4D3E"
                level="M"
              />
            </div>
            <p className="mt-4 text-center text-[13px] font-medium">{branch.data.label}</p>
            <p className="mt-1 break-all text-center text-[11.5px] text-muted-foreground">
              {branch.data.url}
            </p>
            <p className="mt-4 rounded-lg bg-muted/60 px-3.5 py-2.5 text-center text-[11.5px] leading-relaxed text-muted-foreground">
              Arrival passes stay valid for {branch.data.checkInWindowMinutes} minutes around the
              appointment. This code is a shortcut to the booking form — it grants no access
              {branch.data.authorises ? "" : ", and the API says so explicitly"}.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Today
 * ------------------------------------------------------------------ */

function Today() {
  const today = branchToday();
  // Midday at the branch: a label needs a safe instant inside the day, not its
  // first millisecond, or a timezone slip could name the wrong date.
  const todayLabel = branchLongDay(`${today}T12:00:00+08:00`);

  const list = useAsync(`checkin:today:${today}`, () =>
    api.bookings.list({
      from: today,
      to: today,
      limit: 100,
      sort: "start_time",
      order: "asc",
    }),
  );

  const [moving, setMoving] = React.useState<string | null>(null);
  const [moveError, setMoveError] = React.useState<ApiError | null>(null);

  async function advance(booking: Booking, status: Booking["status"]) {
    setMoving(booking.id);
    setMoveError(null);
    try {
      await api.bookings.setStatus(booking.id, status);
      list.reload();
    } catch (err) {
      setMoveError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not update"));
    } finally {
      setMoving(null);
    }
  }

  const rows = list.data?.data ?? [];
  const arrived = rows.filter((b) => ARRIVED.includes(b.status));
  const expected = rows.filter((b) => b.status === "PENDING" || b.status === "CONFIRMED");

  const stats = [
    { label: "Booked today", value: String(rows.length), icon: CalendarCheck, hint: todayLabel },
    { label: "Checked in", value: String(arrived.length), icon: BadgeCheck, hint: "arrived and seated" },
    { label: "Still to arrive", value: String(expected.length), icon: Clock3, hint: expected.length ? `next ${branchTime(expected[0].startTime)}` : "nobody outstanding" },
    {
      label: "Expected takings",
      value: peso(rows.reduce((sum, b) => sum + b.totalCents, 0)),
      icon: Users,
      hint: "booked value, before no-shows",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s, i) => (
          <Reveal key={s.label} delay={i * 60}>
            <Card>
              <CardContent className="flex items-start gap-4 p-5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/[0.07] text-primary">
                  <s.icon className="size-[18px]" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {s.label}
                  </p>
                  <p className="mt-2 font-display text-[28px] font-semibold leading-none tracking-tight tabular-nums">
                    {s.value}
                  </p>
                  <p className="mt-2 truncate text-[11.5px] text-muted-foreground">{s.hint}</p>
                </div>
              </CardContent>
            </Card>
          </Reveal>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-[17px]">Today's arrivals</CardTitle>
            <CardDescription>{todayLabel} · branch time</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={list.reload}>
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {moveError && <ErrorNote error={moveError} />}

          {list.initial ? (
            <Loading label="Loading today's book…" />
          ) : list.error ? (
            <ErrorNote error={list.error} onRetry={list.reload} />
          ) : rows.length === 0 ? (
            <EmptyNote
              icon={CalendarCheck}
              title="Nothing booked today"
              description="When a booking is made for today it will appear here, ready to check in."
            />
          ) : (
            <div className="scroll-slim max-h-[560px] space-y-1.5 overflow-y-auto">
              {rows.map((booking) => {
                const name =
                  booking.client?.fullName ?? booking.guest?.name ?? "Walk-in guest";
                const services = booking.items.map((i) => i.name).join(", ");
                const next = NEXT_STATUS[booking.status].filter((s) =>
                  s === "CHECKED_IN" || s === "COMPLETED" || s === "NO_SHOW",
                );
                return (
                  <div
                    key={booking.id}
                    className="flex items-center gap-3.5 rounded-lg border border-border/70 bg-background p-3"
                  >
                    <PersonAvatar name={name} className="size-9 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{name}</p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {branchTime(booking.startTime)} · {services || booking.reference}
                      </p>
                      <p className="truncate text-[10.5px] text-muted-foreground/80">
                        {booking.employee.fullName}
                        {booking.client ? "" : " · guest pass"}
                      </p>
                    </div>
                    <StatusBadge status={booking.status} />
                    {next.length > 0 && (
                      <div className="hidden shrink-0 gap-1.5 sm:flex">
                        {next.map((status) => (
                          <Button
                            key={status}
                            size="sm"
                            variant={status === "NO_SHOW" ? "ghost" : "outline"}
                            disabled={moving === booking.id}
                            onClick={() => void advance(booking, status)}
                          >
                            {moving === booking.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : status === "CHECKED_IN" ? (
                              "Arrived"
                            ) : status === "COMPLETED" ? (
                              "Done"
                            ) : (
                              "No-show"
                            )}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Separator className="my-5" />

          <div className="grid gap-5 sm:grid-cols-3">
            {[
              { icon: QrCode, title: "One code per booking", body: "A pass is bound to a single booking and expires on its own schedule, so a screenshot cannot be reused." },
              { icon: ScanLine, title: "Signature, then record", body: "The signature proves the salon issued the pass; the stored row decides whether it is still good." },
              { icon: BadgeCheck, title: "Only the desk arrives you", body: "Checking in is a staff action. A client cannot mark themselves as arrived." },
            ].map((f) => (
              <div key={f.title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/[0.07] text-primary">
                  <f.icon className="size-4" />
                </span>
                <div>
                  <p className="text-[13px] font-medium">{f.title}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function CheckIn() {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-8">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-champagne-600">
          QR check-in
        </p>
        <h1 className="mt-2 font-display text-[30px] font-semibold leading-tight tracking-tight">
          Arrivals, handled.
        </h1>
        <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground">
          Every booking carries its own pass. Scan it and the floor knows who is here,
          who is next and who is late.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Reveal>
          <Redeem />
        </Reveal>
        <Reveal delay={80}>
          <WalkInCode />
        </Reveal>
      </div>

      <Today />
    </div>
  );
}
