"use client";

/**
 * The arrival pass.
 *
 * This is the page the QR code points at, and it is also the page a guest
 * lands on immediately after booking. It is deliberately reachable without an
 * account: a guest has no way to authenticate, so the booking's uuid — 122
 * bits of CSPRNG output, returned only to the person who created the booking —
 * is the capability. The same trust model as a password-reset link.
 *
 * The API is what decides whether that uuid is enough. It allows the read only
 * when `client_id is null` (a guest booking) or when the caller is the owning
 * client or staff. A registered customer's booking is *not* readable from the
 * link alone, so a leaked URL cannot expose their name and phone number.
 */

import * as React from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  MapPin,
  Printer,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserRound,
} from "lucide-react";

import { branchDay, branchLongDay, branchTime, peso, relativeToNow } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { Button } from "@/components/ui/button";
import { ErrorNote, Loading, StatusBadge } from "@/components/app/api-bits";
import { PublicShell } from "@/components/app/PublicShell";

export default function Pass() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const fresh = Boolean((location.state as { fresh?: boolean } | null)?.fresh);

  const state = useAsync(`pass:${id}`, async () => {
    if (!id) throw new ApiError(400, "MISSING_ID", "No booking was specified in the link.");

    const booking = await api.bookings.get(id);

    // A cancelled or no-show booking has no live pass, and the API answers
    // with QR_INVALID rather than an empty object. That is a state this page
    // renders, not an error worth surfacing as one.
    let qr = null;
    try {
      qr = await api.bookings.qr(id);
    } catch (err) {
      if (err instanceof ApiError && (err.code === "QR_INVALID" || err.code === "QR_EXPIRED")) {
        qr = null;
      } else {
        throw err;
      }
    }

    return { booking, qr };
  });

  const [cancelling, setCancelling] = React.useState(false);
  const [cancelError, setCancelError] = React.useState<ApiError | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);

  async function cancel() {
    if (!id) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.bookings.cancel(id, { reason: "Cancelled from the arrival pass" });
      setConfirmCancel(false);
      state.reload();
    } catch (err) {
      setCancelError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not cancel the booking"),
      );
    } finally {
      setCancelling(false);
    }
  }

  if (state.error) {
    return (
      <PublicShell>
        <div className="container max-w-lg py-24">
          <div className="rounded-2xl border border-border/80 bg-card p-8 shadow-soft">
            <span className="flex size-12 items-center justify-center rounded-full bg-clay/10 text-clay">
              <TriangleAlert className="size-5" />
            </span>
            <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">
              {state.error.code === "BOOKING_NOT_FOUND"
                ? "We can't find that pass"
                : "Something went wrong"}
            </h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {state.error.code === "BOOKING_NOT_FOUND"
                ? "That link does not match a booking. Check the address, or look it up at the desk."
                : state.error.message}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/scan">Find a booking</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/book">Book instead</Link>
              </Button>
            </div>
          </div>
        </div>
      </PublicShell>
    );
  }

  if (state.initial || !state.data) {
    return (
      <PublicShell>
        <div className="container max-w-lg py-24">
          <Loading label="Fetching your pass…" />
        </div>
      </PublicShell>
    );
  }

  const { booking, qr } = state.data;
  const checkedIn = Boolean(qr?.used) || booking.status === "CHECKED_IN" || booking.status === "IN_SERVICE";
  const dead = booking.status === "CANCELLED" || booking.status === "NO_SHOW";
  const canCancel = !dead && booking.status !== "COMPLETED";

  return (
    <PublicShell>
      <div className="container max-w-2xl py-14">
        {fresh && (
          <div
            data-print="hide"
            className="mb-7 flex items-start gap-3 rounded-xl border border-alley-200 bg-alley-50 px-5 py-4"
          >
            <Sparkles className="mt-0.5 size-5 shrink-0 text-alley-700" />
            <div>
              <p className="text-[13.5px] font-medium text-alley-700">Your chair is reserved.</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-alley-700/80">
                Keep this page — the code below is your arrival pass. It also works
                from any device that opens the same link.
              </p>
            </div>
          </div>
        )}

        {/*
          * `data-print="pass"` is the hook the print stylesheet in `index.css`
          * keys on: everything else on the page (the public nav, the footer,
          * the action buttons) is noise on paper, and this card is the thing
          * worth handing to a guest.
          */}
        <div
          data-print="pass"
          className="rounded-2xl border border-border/80 bg-card p-7 shadow-lift sm:p-9"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Arrival pass</p>
              <h1 className="mt-2 font-display text-[clamp(1.6rem,3vw,2.1rem)] font-medium leading-tight tracking-tight">
                {booking.reference}
              </h1>
            </div>
            <StatusBadge status={booking.status} />
          </div>

          {/* ------------------------------------------------------- code */}
          <div className="mt-8 flex flex-col items-center">
            {dead ? (
              <div className="flex w-full flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
                <TriangleAlert className="size-6 text-clay" />
                <p className="mt-3 text-[14px] font-medium">
                  {booking.status === "CANCELLED" ? "This booking was cancelled" : "This booking was missed"}
                </p>
                <p className="mt-1.5 max-w-sm text-[12.5px] text-muted-foreground">
                  There is no longer a live pass for it. Book again and a fresh code
                  is issued straight away.
                </p>
                <Button asChild className="mt-5">
                  <Link to="/book">Book another appointment</Link>
                </Button>
              </div>
            ) : qr?.used ? (
              <div className="flex w-full flex-col items-center rounded-xl border border-alley-200 bg-alley-50 px-6 py-12 text-center">
                <ShieldCheck className="size-7 text-alley-700" />
                <p className="mt-3 text-[14px] font-medium text-alley-700">Already checked in</p>
                <p className="mt-1.5 text-[12.5px] text-alley-700/80">
                  {qr.checkedInAt
                    ? `Redeemed ${relativeToNow(qr.checkedInAt)} · ${branchTime(qr.checkedInAt)}`
                    : "This pass has been redeemed."}
                </p>
              </div>
            ) : qr?.url ? (
              <>
                <div className="rounded-2xl bg-white p-5 ring-1 ring-border">
                  <QRCodeSVG
                    value={qr.url}
                    size={200}
                    bgColor="#ffffff"
                    fgColor="#1B4D3E"
                    level="M"
                  />
                </div>
                <p className="mt-4 max-w-sm text-center text-[12.5px] leading-relaxed text-muted-foreground">
                  Show this at reception. The desk scans it once — it cannot be
                  used twice.
                </p>
                {qr.expiresAt && (
                  <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                    Valid until {branchDay(qr.expiresAt)} · {branchTime(qr.expiresAt)}
                  </p>
                )}
              </>
            ) : (
              <div className="flex w-full flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
                <TriangleAlert className="size-6 text-champagne-600" />
                <p className="mt-3 text-[14px] font-medium">No live pass right now</p>
                <p className="mt-1.5 max-w-sm text-[12.5px] text-muted-foreground">
                  The code becomes available closer to the appointment, and is
                  re-issued if the booking is moved.
                </p>
              </div>
            )}
          </div>

          {/* ----------------------------------------------------- details */}
          <dl className="mt-9 grid gap-x-8 gap-y-5 border-t border-border/70 pt-7 sm:grid-cols-2">
            <Detail icon={CalendarDays} label="When">
              {branchLongDay(booking.startTime)}
              <br />
              {branchTime(booking.startTime)} – {branchTime(booking.endTime)}
            </Detail>
            <Detail icon={UserRound} label="Stylist">
              {booking.employee.fullName}
            </Detail>
            <Detail icon={Sparkles} label="Treatment">
              {booking.items.map((item) => item.name).join(", ")}
            </Detail>
            <Detail icon={Clock3} label="Booked by">
              {booking.client ? (
                booking.client.fullName
              ) : booking.guest ? (
                <>
                  {booking.guest.name}
                  <span className="block text-[11.5px] text-muted-foreground">
                    Guest booking · {booking.guest.phone}
                  </span>
                </>
              ) : (
                "Guest"
              )}
            </Detail>
            <Detail icon={MapPin} label="Total">
              <span className="font-display text-[19px] font-semibold text-primary">
                {peso(booking.totalCents)}
              </span>
              {booking.discountCents > 0 && (
                <span className="ml-2 text-[12px] text-alley-600">
                  {peso(booking.discountCents)} off
                </span>
              )}
            </Detail>
            {checkedIn && qr?.checkedInAt && (
              <Detail icon={CheckCircle2} label="Checked in">
                {branchTime(qr.checkedInAt)}
              </Detail>
            )}
          </dl>

          {booking.notes && (
            <p className="mt-6 rounded-lg bg-sand-50 px-4 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Note: </span>
              {booking.notes}
            </p>
          )}

          {cancelError && <ErrorNote error={cancelError} className="mt-6" />}

          <div
            data-print="hide"
            className="mt-8 flex flex-wrap items-center gap-2 border-t border-border/70 pt-6"
          >
            <Button variant="outline" onClick={state.reload}>
              <RefreshCw className="size-4" />
              Refresh pass
            </Button>
            {!dead && (
              <Button variant="outline" className="gap-2" onClick={() => window.print()}>
                <Printer className="size-4" />
                Print pass
              </Button>
            )}
            {canCancel && !confirmCancel && (
              <Button variant="ghost" className="text-clay hover:bg-clay/10" onClick={() => setConfirmCancel(true)}>
                Cancel this booking
              </Button>
            )}
            {confirmCancel && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-muted-foreground">
                  Cancel {booking.reference}?
                </span>
                <Button variant="destructive" size="sm" onClick={cancel} disabled={cancelling}>
                  {cancelling ? "Cancelling…" : "Yes, cancel"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
                  Keep it
                </Button>
              </div>
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-[12px] leading-relaxed text-muted-foreground">
          Bookmark this link — it is your only copy of the pass. Cancelling is free
          up to two hours before the appointment.
        </p>
      </div>
    </PublicShell>
  );
}

function Detail({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary/70" />
      <div className="min-w-0">
        <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </dt>
        <dd className="mt-1 text-[13.5px] leading-relaxed text-foreground">{children}</dd>
      </div>
    </div>
  );
}
