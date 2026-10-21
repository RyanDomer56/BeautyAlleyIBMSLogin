"use client";

/**
 * The door.
 *
 * Three jobs in one place, because at a real front desk they are the same
 * moment:
 *
 *   1. **Walk in.** A code mounted at reception that opens the booking page.
 *      A passer-by scans it and is choosing a treatment thirty seconds later.
 *   2. **Arrive.** Someone who has already booked needs their pass, and may
 *      have lost the link. They can paste it back in, or pick the booking off
 *      their account if they have one.
 *   3. **Redeem.** Staff scan the pass and the desk checks the guest in.
 *
 * Job 3 is staff-only, and that is enforced by the API rather than here — a
 * client redeeming their own pass would defeat the point of a desk check-in,
 * since it would mark them arrived without anyone having seen them.
 */

import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  DoorOpen,
  Info,
  KeyRound,
  Loader2,
  QrCode,
  ScanLine,
} from "lucide-react";

import { branchDay, branchTime } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { Button } from "@/components/ui/button";
import { EmptyNote, ErrorNote, Loading, StatusBadge } from "@/components/app/api-bits";
import { PageHead, PublicShell } from "@/components/app/PublicShell";
import { useAuth } from "@/auth/AuthProvider";

/** A v4 uuid, anywhere in the input — a bare id or a full pass URL both work. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default function Scan() {
  const navigate = useNavigate();
  const { status, me, isStaff } = useAuth();

  const [lookup, setLookup] = React.useState("");
  const [lookupError, setLookupError] = React.useState<string | null>(null);

  const [pass, setPass] = React.useState("");
  const [redeeming, setRedeeming] = React.useState(false);
  const [redeemError, setRedeemError] = React.useState<ApiError | null>(null);
  const [redeemed, setRedeemed] = React.useState<{ reference: string; status: string; checkedInAt: string } | null>(
    null,
  );

  const bookUrl = typeof window === "undefined" ? "/book" : `${window.location.origin}/book`;

  const mine = useAsync(`scan:mine:${me?.id ?? "anon"}`, async () => {
    if (status !== "authenticated") return null;
    const page = await api.bookings.mine({ limit: 20, upcoming: true });
    return page.data;
  });

  function openPass(raw: string) {
    const value = raw.trim();
    if (!value) return;

    // A signed pass (`BA1.…`) is not a booking id — it is redeemed at the desk,
    // not opened. Saying so is more useful than "not found".
    if (value.startsWith("BA1.")) {
      setLookupError(
        isStaff
          ? "That is an arrival pass. Paste it into the check-in box below to redeem it."
          : "That is an arrival pass — hand it to the desk and they will scan it in.",
      );
      return;
    }

    const match = value.match(UUID);
    if (!match) {
      setLookupError("That does not look like a booking link or reference.");
      return;
    }
    setLookupError(null);
    navigate(`/pass/${match[0]}`);
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    if (redeeming || !pass.trim()) return;
    setRedeeming(true);
    setRedeemError(null);
    setRedeemed(null);
    try {
      const result = await api.qr.checkIn(pass.trim());
      setRedeemed(result);
      setPass("");
    } catch (err) {
      setRedeemError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not check that pass in"),
      );
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <PublicShell>
      <PageHead
        eyebrow="Arrive"
        title={
          <>
            Scan, and you're
            <span className="italic text-champagne-300"> expected.</span>
          </>
        }
        lede="No clipboard, no queue at the desk. Scan the code at reception to book on the spot, or bring the pass you were given."
      />

      <div className="container pt-10">
        <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-sand-50 px-5 py-4">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Before you scan.</span> Point
            your phone's camera at the code mounted at reception to book on the spot, or
            paste the pass from your confirmation below to open it. Arrival passes are
            redeemed by the desk only — hand yours over when you arrive.
          </p>
        </div>
      </div>

      <div className="container grid gap-8 py-14 lg:grid-cols-2">
        {/* ------------------------------------------------------ walk in */}
        <section className="rounded-2xl border border-border/80 bg-card p-7 shadow-soft">
          <span className="flex size-11 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
            <DoorOpen className="size-5" />
          </span>
          <h2 className="mt-5 font-display text-[22px] font-semibold leading-tight tracking-tight">
            Walking in?
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
            This is the code mounted at reception. Scan it with your phone and
            you can book a treatment before you reach the counter.
          </p>

          <div className="mt-6 flex flex-col items-center">
            <div className="rounded-2xl bg-white p-5 ring-1 ring-border">
              <QRCodeSVG value={bookUrl} size={176} bgColor="#ffffff" fgColor="#1B4D3E" level="M" />
            </div>
            <p className="mt-4 text-center text-[12px] text-muted-foreground">
              Points at <span className="text-foreground">{bookUrl}</span>
            </p>
            <Button asChild className="mt-5">
              <Link to="/book">
                Open the booking desk
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </section>

        {/* ------------------------------------------------------- arrive */}
        <section className="space-y-8">
          <div className="rounded-2xl border border-border/80 bg-card p-7 shadow-soft">
            <span className="flex size-11 items-center justify-center rounded-full bg-champagne-300/25 text-champagne-600">
              <KeyRound className="size-5" />
            </span>
            <h2 className="mt-5 font-display text-[22px] font-semibold leading-tight tracking-tight">
              Already booked?
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              Paste the link from your confirmation, or the booking reference.
            </p>

            <form
              className="mt-5 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                openPass(lookup);
              }}
            >
              <input
                value={lookup}
                onChange={(e) => {
                  setLookup(e.target.value);
                  setLookupError(null);
                }}
                placeholder="https://…/pass/… or booking id"
                aria-label="Booking link or reference"
                className="h-11 flex-1 rounded-lg border border-border bg-card px-3.5 text-[13px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              />
              <Button type="submit" className="h-11 shrink-0">
                Open my pass
              </Button>
            </form>
            {lookupError && <p className="mt-2 text-[12.5px] text-clay">{lookupError}</p>}

            {status === "authenticated" && (
              <div className="mt-6 border-t border-border/70 pt-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Your upcoming appointments
                </p>
                {mine.initial ? (
                  <Loading label="Looking up your bookings…" className="mt-3" />
                ) : mine.error ? (
                  <ErrorNote error={mine.error} onRetry={mine.reload} className="mt-3" />
                ) : mine.data && mine.data.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {mine.data.map((booking) => (
                      <li key={booking.id}>
                        <Link
                          to={`/pass/${booking.id}`}
                          className="flex items-center gap-3 rounded-lg border border-border/70 bg-sand-50 px-4 py-3 transition-colors hover:border-primary/30 hover:bg-primary/[0.04]"
                        >
                          <CalendarDays className="size-4 shrink-0 text-primary/70" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium">
                              {booking.items.map((i) => i.name).join(", ") || booking.reference}
                            </span>
                            <span className="block truncate text-[11.5px] text-muted-foreground">
                              {branchDay(booking.startTime)} · {branchTime(booking.startTime)} ·{" "}
                              {booking.employee.fullName}
                            </span>
                          </span>
                          <StatusBadge status={booking.status} />
                          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote
                    icon={CalendarDays}
                    title="Nothing booked yet"
                    description="You have no upcoming appointments."
                    action={
                      <Button asChild variant="outline">
                        <Link to="/book">Book one</Link>
                      </Button>
                    }
                  />
                )}
              </div>
            )}
          </div>

          {/* ---------------------------------------------------- redeem */}
          {isStaff && (
            <div className="rounded-2xl border border-primary/25 bg-primary/[0.03] p-7">
              <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <ScanLine className="size-5" />
              </span>
              <h2 className="mt-5 font-display text-[22px] font-semibold leading-tight tracking-tight">
                Front desk
              </h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                Scan or paste a guest's arrival pass. The signature is checked
                first, then the booking — a pass cannot be redeemed twice, and a
                forged one never gets past the signature.
              </p>

              <form onSubmit={redeem} className="mt-5 space-y-3">
                <textarea
                  value={pass}
                  onChange={(e) => {
                    setPass(e.target.value);
                    setRedeemError(null);
                  }}
                  rows={2}
                  placeholder="BA1.… or the URL the QR encodes"
                  aria-label="Arrival pass"
                  className="w-full resize-none rounded-lg border border-border bg-card px-3.5 py-3 font-mono text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                />
                <Button type="submit" disabled={redeeming || !pass.trim()}>
                  {redeeming ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Checking in…
                    </>
                  ) : (
                    <>
                      <ClipboardCheck className="size-4" />
                      Check in this guest
                    </>
                  )}
                </Button>
              </form>

              {redeemError && <ErrorNote error={redeemError} className="mt-4" />}

              {redeemed && (
                <div className="mt-4 flex items-start gap-3 rounded-xl border border-alley-200 bg-alley-50 px-5 py-4">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-alley-700" />
                  <div>
                    <p className="text-[13.5px] font-medium text-alley-700">
                      {redeemed.reference} is checked in
                    </p>
                    <p className="mt-1 text-[12.5px] text-alley-700/80">
                      {branchTime(redeemed.checkedInAt)} · status {redeemed.status.toLowerCase()}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {status === "authenticated" && !isStaff && (
            <p className="text-center text-[12px] leading-relaxed text-muted-foreground">
              <QrCode className="mr-1 inline size-3.5" />
              Hand your pass to the desk — they will scan it in. Only the salon
              can mark you as arrived.
            </p>
          )}
        </section>
      </div>
    </PublicShell>
  );
}
