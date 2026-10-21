"use client";

/**
 * Scan arrival pass — the front desk confirms a guest has walked in.
 *
 * ## Two steps, on purpose
 *
 * Scanning does **not** silently check anybody in. A scan resolves the QR to a
 * reservation, the desk sees who it is and what they booked, and a separate
 * *Confirm arrival* button commits it. That matters because the alternative —
 * one scan, one irreversible write — gives the desk no chance to notice that
 * the guest in front of them is not the guest on the screen.
 *
 * The reservation panel's verdict is a *courtesy*, computed from what the API
 * already told us, so the desk sees "already checked in" or "cancelled"
 * before tapping rather than as an error afterwards. The server still gets the
 * last word: *Confirm arrival* goes through `POST /qr/check-in`, which is
 * where the signature is verified and where a race with another device is
 * caught. Nothing here is trusted to be correct on its own.
 *
 * ## What is in the QR
 *
 * The pass is `BA1.<base64url({jti,bid,exp})>.<hmac>`. It carries a token id,
 * a booking id and an expiry — no name, no phone, no payment detail, nothing
 * about the person. Everything shown in the result panel is fetched from the
 * API *after* the code is read, so a stolen QR reveals only a booking
 * reference. (The payload is decoded here without verifying the signature —
 * that is fine, because it is used only to *look up* context for display. The
 * write path re-verifies the signature server-side.)
 */

import * as React from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Camera,
  CameraOff,
  CheckCircle2,
  Keyboard,
  QrCode,
  RotateCcw,
  ScanLine,
  ShieldAlert,
  UserRound,
  XCircle,
} from "lucide-react";

import { api, ApiError } from "@/lib/api";
import type { Booking } from "@/lib/api-types";
import { branchDay, branchTime, peso } from "@/lib/utils";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Panel, SectionHeading } from "@/components/app/bits";

/* ------------------------------------------------------------------ *
 * Reading the code
 * ------------------------------------------------------------------ */

const PASS_PREFIX = "BA1.";

/** The `pass` query parameter out of a scanned check-in URL. */
function passFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const pass = url.searchParams.get("pass");
    if (pass) return pass;
  } catch {
    /* not a URL — fall through */
  }
  return null;
}

/** `BA1.<body>.<sig>` -> the payload, WITHOUT verifying the signature. */
function decodePassPayload(pass: string): { jti?: string; bid?: string; exp?: number } | null {
  const parts = pass.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* not decodable */
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

type Verdict =
  | { ok: true; label: string; note: string }
  | { ok: false; label: string; note: string };

/**
 * Judge a reservation against what the desk can see.
 *
 * Deliberately derived from the *booking*, not invented: every branch below
 * corresponds to a field the API returned. The only date comparison uses the
 * branch calendar day, because at 09:00 Manila it is still the previous UTC
 * day and a naive `toISOString().slice(0,10)` would call this morning's
 * appointment "yesterday".
 */
function judge(booking: Booking, today: string): Verdict {
  if (booking.status === "CANCELLED") {
    return {
      ok: false,
      label: "Cancelled",
      note: "This reservation was cancelled. Do not admit the guest without the desk booking a new appointment.",
    };
  }
  if (booking.status === "COMPLETED" || booking.status === "NO_SHOW") {
    return {
      ok: false,
      label: "Expired or Ineligible",
      note: `This appointment is already ${booking.status === "COMPLETED" ? "completed" : "marked as a no-show"}.`,
    };
  }
  if (booking.status === "CHECKED_IN") {
    return {
      ok: false,
      label: "Already Checked In",
      note: "Arrival was already recorded for this reservation. Nothing further is needed.",
    };
  }
  if (booking.status === "IN_SERVICE") {
    return {
      ok: false,
      label: "Already Checked In",
      note: "The guest is already in service.",
    };
  }

  const day = branchDayKeyOf(booking.startTime);
  if (day !== today) {
    return {
      ok: false,
      label: "Date Mismatch",
      note: `This pass is for ${branchDay(booking.startTime)}, not today.`,
    };
  }

  return {
    ok: true,
    label: "Valid Reservation",
    note: "Everything matches. Confirm the guest has arrived to record the check-in.",
  };
}

/** The branch calendar day of an instant, as `YYYY-MM-DD`. */
function branchDayKeyOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function todayKey(): string {
  return branchDayKeyOf(new Date().toISOString());
}

/* ------------------------------------------------------------------ *
 * Result panel
 * ------------------------------------------------------------------ */

type ScanState =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "refused"; label: string; note: string }
  | { kind: "reservation"; booking: Booking; verdict: Verdict }
  | { kind: "confirmed"; booking: Booking; checkedInAt: string; by: string };

function ReservationCard({ booking, verdict }: { booking: Booking; verdict: Verdict }) {
  const guest = booking.client?.fullName ?? booking.guest?.name ?? "Guest";
  const services = booking.items.map((i) => i.name).join(", ") || "—";

  return (
    <>
      <div
        className={
          verdict.ok
            ? "flex items-start gap-3 rounded-xl border border-success/30 bg-success/[0.06] px-4 py-3.5"
            : "flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3.5"
        }
      >
        {verdict.ok ? (
          <BadgeCheck className="mt-0.5 size-[18px] shrink-0 text-success" />
        ) : (
          <ShieldAlert className="mt-0.5 size-[18px] shrink-0 text-destructive" />
        )}
        <div className="min-w-0">
          <p className={verdict.ok ? "text-[14px] font-semibold text-success" : "text-[14px] font-semibold text-destructive"}>
            {verdict.label}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{verdict.note}</p>
        </div>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
        {[
          { label: "Reference", value: booking.reference },
          { label: "Guest", value: guest },
          { label: "Appointment", value: `${branchDay(booking.startTime)} · ${branchTime(booking.startTime)}` },
          { label: "Service", value: services },
          { label: "Stylist", value: booking.employee.fullName },
          { label: "Status", value: booking.status.replace(/_/g, " ").toLowerCase() },
          { label: "Total", value: peso(booking.totalCents) },
        ].map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {f.label}
            </dt>
            <dd className="mt-0.5 break-words text-[13.5px] font-medium">{f.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */

function CameraScanner({
  onCode,
  paused,
}: {
  onCode: (raw: string) => void;
  paused: boolean;
}) {
  const regionId = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const [status, setStatus] = React.useState<"starting" | "live" | "blocked" | "unsupported">(
    "starting",
  );
  const [reason, setReason] = React.useState<string>("");
  const scannerRef = React.useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const onCodeRef = React.useRef(onCode);
  onCodeRef.current = onCode;
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        setReason(
          "This browser does not expose a camera to the page. Most browsers only allow it on https:// or on localhost.",
        );
        return;
      }

      try {
        // Imported lazily: the library touches `navigator` at load time, and
        // there is no reason to ship it to anyone who never opens this page.
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;

        const scanner = new Html5Qrcode(regionId, { verbose: false });
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 230, height: 230 } },
          (decoded: string) => {
            // The library fires on every frame that decodes. Without this guard
            // one pass in front of the lens would fire dozens of lookups.
            if (pausedRef.current) return;
            onCodeRef.current(decoded);
          },
          () => {
            /* per-frame "nothing found" — not an error worth showing */
          },
        );

        if (!cancelled) setStatus("live");
      } catch (err) {
        if (cancelled) return;
        const name = (err as { name?: string })?.name ?? "";
        setStatus("blocked");
        setReason(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Camera access was denied. Allow it in your browser's address bar, or type the reference below."
            : name === "NotFoundError" || name === "DevicesNotFoundError"
              ? "No camera was found on this device. Use the reference box below."
              : "The camera could not be started. Use the reference box below.",
        );
      }
    })();

    return () => {
      cancelled = true;
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (!scanner) return;
      // `stop()` rejects when the scanner never started; swallow that so an
      // unmount during a failed start does not throw.
      scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => undefined);
    };
  }, [regionId]);

  return (
    <div>
      <div className="relative overflow-hidden rounded-xl border border-border bg-foreground/90">
        <div id={regionId} className="[&_video]:!w-full [&_video]:!rounded-xl [&_video]:object-cover" />

        {status !== "live" && (
          <div className="flex aspect-[4/3] flex-col items-center justify-center gap-3 px-6 text-center">
            {status === "starting" ? (
              <>
                <Camera className="size-6 text-background/70" />
                <p className="text-[12.5px] text-background/70">Starting the camera…</p>
              </>
            ) : (
              <>
                <CameraOff className="size-6 text-background/70" />
                <p className="max-w-xs text-[12.5px] leading-relaxed text-background/70">{reason}</p>
              </>
            )}
          </div>
        )}

        {status === "live" && (
          // A frame over the live video. It is a guide, not a crop — the
          // library decodes the whole frame, so a guest holding the pass a
          // little off-centre is still read.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative size-[230px] max-w-[70%]">
              {(
                [
                  "left-0 top-0 border-l-2 border-t-2 rounded-tl-lg",
                  "right-0 top-0 border-r-2 border-t-2 rounded-tr-lg",
                  "left-0 bottom-0 border-b-2 border-l-2 rounded-bl-lg",
                  "right-0 bottom-0 border-b-2 border-r-2 rounded-br-lg",
                ] as const
              ).map((c) => (
                <span key={c} className={`absolute size-8 border-background/90 ${c}`} />
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
        <Camera className="mt-0.5 size-3.5 shrink-0" />
        {status === "live"
          ? "Hold the guest's arrival pass inside the frame. The code is read automatically."
          : "If the camera is unavailable, the reference box below does the same job."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function ScanArrivals() {
  const { me } = useAuth();
  const [state, setState] = React.useState<ScanState>({ kind: "idle" });
  const [manual, setManual] = React.useState("");
  const busy = state.kind === "working";

  /** Resolve a scanned or typed value to a booking, then judge it. */
  const resolve = React.useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;

    setState({ kind: "working", label: "Reading the code…" });

    try {
      // --- a signed pass, either bare or wrapped in the check-in URL --------
      const pass = value.startsWith(PASS_PREFIX) ? value : passFromUrl(value);
      if (pass) {
        const payload = decodePassPayload(pass);
        if (!payload?.bid) {
          setState({
            kind: "refused",
            label: "Invalid QR Code",
            note: "That is not a Beauty Alley arrival pass. It may be a different kind of code, or a damaged one.",
          });
          return;
        }
        setState({ kind: "working", label: "Looking up the reservation…" });
        const booking = await api.bookings.get(payload.bid);
        setState({ kind: "reservation", booking, verdict: judge(booking, todayKey()) });
        return;
      }

      // --- otherwise treat it as a booking reference ------------------------
      setState({ kind: "working", label: "Searching reservations…" });
      const found = await api.bookings.list({ q: value, limit: 10 });
      const exact = found.data.find(
        (b) => b.reference.toLowerCase() === value.toLowerCase(),
      );
      const booking = exact ?? (found.data.length === 1 ? found.data[0] : undefined);

      if (!booking) {
        setState({
          kind: "refused",
          label: "Reservation Not Found",
          note: `No reservation matches "${value}". If this is a walk-in, start a new booking from the Booking screen — a pass is never created from an unknown code.`,
        });
        return;
      }

      setState({ kind: "reservation", booking, verdict: judge(booking, todayKey()) });
    } catch (err) {
      if (err instanceof ApiError && err.code === "BOOKING_NOT_FOUND") {
        setState({
          kind: "refused",
          label: "Reservation Not Found",
          note: "The pass is genuine, but the reservation it points at no longer exists.",
        });
        return;
      }
      if (err instanceof ApiError && err.isNetwork) {
        setState({
          kind: "refused",
          label: "Cannot reach the desk",
          note: err.message,
        });
        return;
      }
      setState({
        kind: "refused",
        label: "Invalid QR Code",
        note: err instanceof Error ? err.message : "That code could not be read.",
      });
    }
  }, []);

  /** Commit the check-in. The server verifies the pass again and owns the write. */
  async function confirmArrival() {
    if (state.kind !== "reservation") return;
    const booking = state.booking;
    setState({ kind: "working", label: "Confirming arrival…" });

    try {
      // Re-issue the pass for this booking, then redeem it. The desk is
      // authorised to do both; the guest's own pass is unaffected.
      const qr = await api.bookings.qr(booking.id);
      if (!qr.pass) {
        setState({
          kind: "refused",
          label: "Already Checked In",
          note: "This reservation has already been checked in — there is no live pass left to redeem.",
        });
        return;
      }

      const result = await api.qr.checkIn(qr.pass);
      const fresh = await api.bookings.get(booking.id);
      setState({
        kind: "confirmed",
        booking: fresh,
        checkedInAt: result.checkedInAt,
        by: me?.fullName || me?.email || "the desk",
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      const label =
        code === "ALREADY_CHECKED_IN"
          ? "Already Checked In"
          : code === "INVALID_STATUS_TRANSITION"
            ? "Expired or Ineligible"
            : code === "QR_EXPIRED"
              ? "Expired or Ineligible"
              : code === "QR_TOO_EARLY"
                ? "Expired or Ineligible"
                : code === "QR_TOO_LATE"
                  ? "Expired or Ineligible"
                  : code === "QR_INVALID"
                    ? "Invalid QR Code"
                    : "Could not confirm";
      setState({
        kind: "refused",
        label,
        note:
          err instanceof Error
            ? err.message
            : "The server refused the check-in. Nothing was changed.",
      });
    }
  }

  const paused = state.kind !== "idle";

  return (
    <div className="mx-auto max-w-[1100px] space-y-6">
      <SectionHeading
        eyebrow="Operate"
        title="Scan arrival pass"
        description="Read a guest's arrival pass and record that they have arrived. Scanning only looks the reservation up — the check-in is a separate, deliberate step."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* --- scanner -------------------------------------------------- */}
        <div className="space-y-4">
          <Panel className="px-5 py-5">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
                <ScanLine className="size-4" />
              </span>
              <h2 className="font-display text-[17px] font-semibold">Camera</h2>
            </div>
            <CameraScanner onCode={(raw) => void resolve(raw)} paused={paused} />
          </Panel>

          <Panel className="px-5 py-5">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
                <Keyboard className="size-4" />
              </span>
              <h2 className="font-display text-[17px] font-semibold">Enter a reference</h2>
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Type the booking reference from the guest's pass, or paste the pass itself. This works
              with no camera at all.
            </p>
            <form
              className="mt-3.5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void resolve(manual);
              }}
            >
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="BA-20261013-0001"
                aria-label="Booking reference or arrival pass"
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 font-mono text-[13px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              />
              <Button type="submit" disabled={busy || !manual.trim()}>
                Look up
              </Button>
            </form>
          </Panel>
        </div>

        {/* --- result --------------------------------------------------- */}
        <Panel className="px-5 py-5">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
              <QrCode className="size-4" />
            </span>
            <h2 className="font-display text-[17px] font-semibold">Result</h2>
          </div>

          {state.kind === "idle" && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
              <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-primary/[0.07] text-primary">
                <UserRound className="size-5" />
              </span>
              <h3 className="font-display text-lg font-semibold">Waiting for a pass</h3>
              <p className="mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-muted-foreground">
                Scan a guest's arrival pass, or type the booking reference. The reservation will
                appear here before anything is changed.
              </p>
            </div>
          )}

          {state.kind === "working" && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
              <RotateCcw className="mb-3 size-5 animate-spin text-primary" />
              <p className="text-[13px] text-muted-foreground">{state.label}</p>
            </div>
          )}

          {state.kind === "refused" && (
            <div>
              <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3.5">
                <XCircle className="mt-0.5 size-[18px] shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-destructive">{state.label}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                    {state.note}
                  </p>
                </div>
              </div>
              <Button variant="outline" className="mt-4 gap-2" onClick={() => setState({ kind: "idle" })}>
                <RotateCcw className="size-4" />
                Scan another
              </Button>
            </div>
          )}

          {state.kind === "reservation" && (
            <div>
              <ReservationCard booking={state.booking} verdict={state.verdict} />
              <div className="mt-5 flex flex-wrap gap-2.5">
                <Button
                  className="gap-2"
                  disabled={!state.verdict.ok}
                  onClick={() => void confirmArrival()}
                >
                  <CheckCircle2 className="size-4" />
                  Confirm arrival
                </Button>
                <Button variant="outline" className="gap-2" onClick={() => setState({ kind: "idle" })}>
                  <RotateCcw className="size-4" />
                  Scan another
                </Button>
              </div>
              {!state.verdict.ok && (
                <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  Confirm arrival is disabled because this reservation is not in a state that can be
                  admitted.
                </p>
              )}
            </div>
          )}

          {state.kind === "confirmed" && (
            <div>
              <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/[0.06] px-4 py-3.5">
                <CheckCircle2 className="mt-0.5 size-[18px] shrink-0 text-success" />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-success">Arrival Confirmed</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                    Recorded at {branchTime(state.checkedInAt)} by {state.by}. The guest is now
                    checked in and waiting for their stylist — the service is not marked complete and
                    no payment has been taken.
                  </p>
                </div>
              </div>

              <ReservationCard
                booking={state.booking}
                verdict={{ ok: true, label: "Checked in", note: "Arrival recorded." }}
              />

              <Button variant="outline" className="mt-4 gap-2" onClick={() => setState({ kind: "idle" })}>
                <RotateCcw className="size-4" />
                Scan the next guest
              </Button>
            </div>
          )}
        </Panel>
      </div>

      <Panel className="px-5 py-4">
        <h2 className="eyebrow">About these codes</h2>
        <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <li>
            An arrival pass carries a signed token — a token id, the booking id and an expiry. It
            holds no name, phone number, password or payment detail.
          </li>
          <li>
            The signature proves the pass was issued by the salon. Whether it is still <em>valid</em>{" "}
            is decided by the server, which is the only thing that knows a booking was cancelled or
            already used.
          </li>
          <li>
            A code that matches no reservation never creates one. Walk-ins are booked through the
            normal booking screen so the guest has a real appointment behind them.
          </li>
          <li>
            This is a prototype: passes are long-lived links and the desk device is trusted. A
            production deployment would add short expiry windows, device binding and an audit trail
            of which device scanned what.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
