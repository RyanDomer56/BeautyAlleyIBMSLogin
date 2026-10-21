"use client";

/**
 * The booking desk.
 *
 * ## Why one service per booking
 *
 * The API accepts up to ten service ids on a booking, but availability is
 * computed by `get_available_slots(p_service_id, p_date, …)` — a single
 * service, whose duration is what determines how long the slot must be. A
 * multi-service booking would need the *summed* duration to be checked against
 * the stylist's shift, and there is no endpoint that answers that question. So
 * the UI books one service at a time rather than letting a visitor assemble a
 * cart that the slot grid cannot honour. The API's capability is not the same
 * thing as a promise the availability endpoint can keep.
 *
 * ## Why guest details are only asked for when there is no account
 *
 * A signed-in client books against their own record — the API ignores a
 * `guest` payload from them entirely, and ignores a `clientId` from anyone
 * else. So the form shows the fields that will actually be used, rather than
 * asking for a name it is going to discard.
 *
 * ## Why the client does not choose a stylist
 *
 * Who delivers a treatment is the front desk's decision: a visitor has no way
 * to know who is qualified for it, who is on leave, or whose shift covers the
 * time. The page therefore offers only times that *someone* can cover, sends
 * no `employeeId`, and lets `create_booking` assign a qualified, rostered,
 * free stylist at random. The concierge sees the booking on their dashboard
 * and can move it to someone else before it is confirmed.
 */

import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  Printer,
  Sparkles,
  Tag,
  UserRound,
  X,
} from "lucide-react";

import {
  branchDay,
  branchLongDay,
  branchTime,
  branchToday,
  cn,
  minutesToLabel,
  peso,
  relativeToNow,
  shiftDayKey,
} from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import type { Booking, PromoValidation, Service } from "@/lib/api-types";
import { Button } from "@/components/ui/button";
import {
  EmptyNote,
  ErrorNote,
  FieldError,
  Loading,
  PersonAvatar,
  StatusBadge,
  TextField,
} from "@/components/app/api-bits";
import { PageHead, PublicShell } from "@/components/app/PublicShell";
import { useAuth } from "@/auth/AuthProvider";

/** How many days ahead the picker offers. */
const DAYS_AHEAD = 14;

const DAY_OPTIONS = Array.from({ length: DAYS_AHEAD }, (_, i) => shiftDayKey(branchToday(), i));

/** One phone rule, used by the step indicator and the submit guard alike. */
const PHONE_RE = /^\+?[0-9 ()\-]{7,20}$/;

type StepState = "todo" | "active" | "done";

/**
 * A step marker that says where you are, not just what the step is called.
 *
 * The old version drew a filled "1" beside all three headings no matter what,
 * so the page gave no sense of progress at all — three stacked forms rather
 * than a flow. Now a finished step shows a tick, the current one is filled, and
 * one you cannot reach yet is greyed out.
 */
function StepHeading({
  n,
  title,
  hint,
  state = "todo",
}: {
  n: number;
  title: string;
  hint?: string;
  state?: StepState;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-300",
          state === "done"
            ? "bg-primary/10 text-primary ring-1 ring-primary/30"
            : state === "active"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground ring-1 ring-border",
        )}
      >
        {state === "done" ? <Check className="size-3.5" /> : n}
      </span>
      <div>
        <h2
          className={cn(
            "font-display text-[20px] font-semibold leading-tight tracking-tight transition-colors duration-300",
            state === "todo" && "text-muted-foreground",
          )}
        >
          {title}
        </h2>
        {hint && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * An em dash that reads as "nothing chosen yet" rather than "data missing".
 *
 * The summary used a bare `—` at full contrast, which looked like a value that
 * had failed to load next to real values that had not.
 */
function Unset() {
  return <span className="font-normal text-muted-foreground/50">—</span>;
}

export default function Book() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { status, me } = useAuth();

  const [serviceId, setServiceId] = React.useState(params.get("service") ?? "");
  const [date, setDate] = React.useState(DAY_OPTIONS[0]);
  const [startTime, setStartTime] = React.useState("");

  const [guestName, setGuestName] = React.useState("");
  const [guestPhone, setGuestPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const [promoInput, setPromoInput] = React.useState("");
  const [promo, setPromo] = React.useState<PromoValidation | null>(null);
  const [promoBusy, setPromoBusy] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [localErrors, setLocalErrors] = React.useState<Record<string, string>>({});

  /**
   * The booking the desk just made, held here so the pass can be shown on this
   * page instead of sending the concierge off to /pass/:id. A staff member is
   * at the counter with the guest in front of them; making them follow a link
   * (and keep it) is a detour around a screen they already have open.
   */
  const [created, setCreated] = React.useState<Booking | null>(null);

  const signedInClient = status === "authenticated" && me?.role === "CLIENT";

  /**
   * Only staff get the in-place pass. A guest on the public site still needs
   * the /pass URL — it is the capability that lets them reopen the booking on
   * their own phone — so their flow is unchanged.
   */
  const bookingAtDesk = status === "authenticated" && me?.role !== "CLIENT";

  const catalogue = useAsync("book:services", async () =>
    (await api.services.list({ limit: 100 })).data,
  );

  const slots = useAsync(
    `book:slots:${serviceId}:${date}`,
    async () => {
      if (!serviceId) return null;
      return api.availability({
        serviceId,
        date,
        intervalMinutes: 30,
      });
    },
  );

  const service: Service | undefined = catalogue.data?.find((s) => s.id === serviceId);

  /*
   * One grid of times, not one grid per stylist.
   *
   * `get_available_slots` answers per employee, which is the right shape for a
   * page that asks you to pick one. This page does not: a time is bookable if
   * any qualified stylist is free for it, so the groups collapse into a set of
   * start times. The count is kept only to show how much slack a slot has —
   * useful to the desk, invisible to the client as a name.
   */
  const times = React.useMemo(() => {
    const byStart = new Map<string, number>();
    for (const group of slots.data?.employees ?? []) {
      for (const slot of group.slots) {
        byStart.set(slot.start, (byStart.get(slot.start) ?? 0) + 1);
      }
    }
    return [...byStart.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([start, stylists]) => ({ start, stylists }));
  }, [slots.data]);

  /* --- narrowing step 1 ---------------------------------------------------
   *
   * Fourteen treatments in two columns is seven rows of scrolling before step 2
   * is even on screen — and every card repeated its category badge, even though
   * the category is the one thing you would use to narrow the list. So the
   * category becomes a filter instead of a label, and the badge comes off the
   * card. Same grouping the catalogue page uses, so the two agree.
   */
  const [group, setGroup] = React.useState("ALL");

  const filters = React.useMemo(() => {
    const rows = catalogue.data ?? [];
    const byGroup = new Map<string, { key: string; label: string; count: number }>();
    byGroup.set("ALL", { key: "ALL", label: "Everything", count: rows.length });
    for (const row of rows) {
      const key = row.subcategory?.slug ?? "salon";
      const found = byGroup.get(key);
      if (found) found.count += 1;
      else byGroup.set(key, { key, label: row.subcategory?.name ?? "Salon floor", count: 1 });
    }
    return [...byGroup.values()];
  }, [catalogue.data]);

  const options = React.useMemo(() => {
    const rows = catalogue.data ?? [];
    return group === "ALL"
      ? rows
      : rows.filter((row) => (row.subcategory?.slug ?? "salon") === group);
  }, [catalogue.data, group]);

  /* --- where you are in the flow ------------------------------------------ */
  const phoneOk = PHONE_RE.test(guestPhone.trim());
  const whoReady = signedInClient || (guestName.trim().length > 0 && phoneOk);
  const stepState: StepState[] = [
    serviceId ? "done" : "active",
    !serviceId ? "todo" : startTime ? "done" : "active",
    !startTime ? "todo" : whoReady ? "done" : "active",
  ];
  const doneCount = stepState.filter((state) => state === "done").length;

  // Changing the service or the day invalidates the chosen slot — the slot was
  // picked against a different duration or a different day's grid.
  React.useEffect(() => {
    setStartTime("");
  }, [serviceId, date]);

  async function checkPromo() {
    const code = promoInput.trim();
    if (!code || !service) return;
    setPromoBusy(true);
    setPromo(null);
    try {
      // Always 200 — an unknown code is a normal answer, not an error. So this
      // only needs to render the verdict, not handle a failure case.
      setPromo(
        await api.promos.validate({
          code,
          serviceIds: [service.id],
          subtotalCents: service.priceCents,
          ...(guestPhone.trim() ? { guestPhone: guestPhone.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not check that code"));
    } finally {
      setPromoBusy(false);
    }
  }

  const subtotalCents = service?.priceCents ?? 0;
  const discountCents = promo?.valid ? promo.discountCents : 0;
  const totalCents = Math.max(0, subtotalCents - discountCents);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !service) return;

    const next: Record<string, string> = {};
    if (!startTime) next.startTime = "Choose a time";
    if (!signedInClient) {
      if (!guestName.trim()) next.guestName = "We need a name for the booking";
      if (!PHONE_RE.test(guestPhone.trim())) {
        next.guestPhone = "A phone number lets us reach you if anything changes";
      }
    }
    setLocalErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    setError(null);

    try {
      const booking = await api.bookings.create({
        serviceIds: [service.id],
        startTime,
        ...(signedInClient
          ? {}
          : { guest: { name: guestName.trim(), phone: guestPhone.trim() } }),
        ...(promo?.valid && promo.code ? { promoCode: promo.code } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });

      if (bookingAtDesk) {
        // The create response already carries the freshly signed pass, so the
        // confirmation needs no second round trip — and no URL to keep.
        setCreated(booking);
        setSubmitting(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      // The booking id is the capability for a guest — it is what the pass URL
      // carries, and it is the only thing that proves the booking is theirs.
      navigate(`/pass/${booking.id}`, { replace: true, state: { fresh: true } });
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not complete the booking"),
      );
      setSubmitting(false);
    }
  }

  const dayHasSlots = (slots.data?.totalSlots ?? 0) > 0;

  /** Back to an empty form, for the next guest in the queue. */
  function startAnother() {
    setCreated(null);
    setServiceId("");
    setStartTime("");
    setGuestName("");
    setGuestPhone("");
    setNotes("");
    setPromoInput("");
    setPromo(null);
    setLocalErrors({});
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (created) {
    return <DeskPass booking={created} onAnother={startAnother} />;
  }

  return (
    <PublicShell>
      <PageHead
        eyebrow="Reserve a chair"
        title={
          <>
            Three steps, and it's
            <span className="italic text-champagne-300"> yours.</span>
          </>
        }
        lede="Pick a treatment, choose a time that suits, and leave us a name. You'll get an arrival pass the moment it's confirmed."
      />

      <form onSubmit={onSubmit} className="container grid gap-10 py-14 lg:grid-cols-[1.5fr_1fr]">
        {/* ------------------------------------------------------- steps */}
        {/*
          `min-w-0` is load-bearing. A grid item defaults to `min-width: auto`,
          so this column refuses to shrink below the min-content width of the
          fourteen-day strip (~1140px) — which widened the whole grid past the
          container and pushed the "Your appointment" panel off the right edge,
          and blew the page out to 1165px on a 390px phone. Zeroing the floor
          lets the column take its `1.5fr` share and the day strip scroll on its
          own, which is what `overflow-x-auto` on it was always meant to do.
        */}
        <div className="min-w-0 space-y-12">
          {/* 1 — service */}
          <section>
            <StepHeading
              n={1}
              title="Choose a treatment"
              hint="One treatment per appointment."
              state={stepState[0]}
            />
            <div className="mt-5">
              {catalogue.error ? (
                <ErrorNote error={catalogue.error} onRetry={catalogue.reload} />
              ) : catalogue.initial ? (
                <Loading label="Fetching the menu…" />
              ) : catalogue.data && catalogue.data.length > 0 ? (
                <>
                  {/* Narrow first, then choose. The counts mean you can see
                      where the treatments are without opening each group. */}
                  <div className="flex flex-wrap gap-1.5">
                    {filters.map((option) => {
                      const on = option.key === group;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => setGroup(option.key)}
                          aria-pressed={on}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors duration-300",
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                          )}
                        >
                          {option.label}
                          <span
                            className={cn(
                              "tabular-nums",
                              on ? "text-primary-foreground/60" : "text-muted-foreground/60",
                            )}
                          >
                            {option.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {options.map((option) => {
                      const selected = option.id === serviceId;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setServiceId(option.id)}
                          aria-pressed={selected}
                          className={cn(
                            "group relative flex flex-col justify-between gap-2 rounded-xl border p-3.5 text-left transition-[border-color,box-shadow,background-color] duration-300 ease-out-quart",
                            selected
                              ? "border-primary bg-primary/[0.05] shadow-soft"
                              : "border-border/80 bg-card hover:border-primary/35 hover:bg-primary/[0.025]",
                          )}
                        >
                          <span className="pr-6 font-display text-[15.5px] font-semibold leading-snug tracking-tight">
                            {option.name}
                          </span>
                          {/* Duration left, price right — so prices line up
                              down the column and can be compared at a glance. */}
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                              <Clock3 className="size-3" />
                              {minutesToLabel(option.durationMinutes)}
                            </span>
                            <span className="text-[13px] font-semibold tabular-nums text-primary">
                              {peso(option.priceCents)}
                            </span>
                          </span>
                          {selected && (
                            <CheckCircle2 className="absolute right-2.5 top-2.5 size-4 text-primary" />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {options.length === 0 && (
                    <p className="mt-4 rounded-xl border border-dashed border-border py-8 text-center text-[12.5px] text-muted-foreground">
                      Nothing in this group.
                    </p>
                  )}
                </>
              ) : (
                <EmptyNote
                  icon={Sparkles}
                  title="No services published"
                  description="The catalogue is empty, so there is nothing to book yet."
                />
              )}
            </div>
          </section>

          {/* 2 — time */}
          <section className={cn(!serviceId && "pointer-events-none opacity-45")}>
            <StepHeading
              n={2}
              title="Pick a day and a time"
              hint={
                serviceId
                  ? "Your stylist is assigned by the front desk."
                  : "Choose a treatment first."
              }
              state={stepState[1]}
            />

            <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
              {DAY_OPTIONS.map((day) => {
                const selected = day === date;
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setDate(day)}
                    aria-pressed={selected}
                    className={cn(
                      "flex min-w-[74px] shrink-0 flex-col items-center rounded-xl border px-3 py-2.5 transition-colors",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/80 bg-card hover:border-primary/30",
                    )}
                  >
                    <span className="text-[11px] uppercase tracking-wide opacity-70">
                      {branchDay(`${day}T12:00:00Z`).split(" ")[0]}
                    </span>
                    <span className="mt-0.5 font-display text-[17px] font-semibold leading-none">
                      {Number(day.slice(8, 10))}
                    </span>
                    <span className="mt-1 text-[10px] opacity-70">
                      {branchDay(`${day}T12:00:00Z`).split(" ").slice(1).join(" ")}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-6">
              {slots.error ? (
                <ErrorNote error={slots.error} onRetry={slots.reload} />
              ) : !serviceId ? (
                <p className="rounded-xl border border-dashed border-border py-10 text-center text-[13px] text-muted-foreground">
                  Times appear once a treatment is chosen.
                </p>
              ) : slots.initial ? (
                <Loading label="Checking the diary…" />
              ) : !dayHasSlots ? (
                <EmptyNote
                  icon={CalendarDays}
                  title="Nothing free that day"
                  description="The salon is closed, or every qualified stylist is fully booked. Try another day."
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {times.map(({ start }) => {
                    const selected = start === startTime;
                    return (
                      <button
                        key={start}
                        type="button"
                        onClick={() => setStartTime(start)}
                        aria-pressed={selected}
                        className={cn(
                          // 36px tall rather than 30: the slot grid is
                          // the one thing on this page a thumb has to hit
                          // repeatedly, often on a phone, often in a hurry.
                          "rounded-full border px-4 py-2 text-[12.5px] tabular-nums transition-colors",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/80 bg-card hover:border-primary/40 hover:bg-primary/[0.05]",
                        )}
                      >
                        {branchTime(start)}
                      </button>
                    );
                  })}
                </div>
              )}
              <FieldError>{localErrors.startTime}</FieldError>
            </div>
          </section>

          {/* 3 — who */}
          <section className={cn(!startTime && "pointer-events-none opacity-45")}>
            <StepHeading
              n={3}
              title="Who is it for?"
              hint={
                signedInClient
                  ? `Booking onto your account, ${me?.fullName ?? me?.email}.`
                  : "No account needed — just a name and a number."
              }
              state={stepState[2]}
            />

            <div className="mt-5 space-y-4">
              {signedInClient ? (
                <div className="flex items-start gap-3 rounded-xl border border-alley-200 bg-alley-50 px-5 py-4">
                  <BadgeCheck className="mt-0.5 size-5 shrink-0 text-alley-700" />
                  <p className="text-[13px] leading-relaxed text-alley-700">
                    This appointment will be saved to your account, so it appears
                    under <span className="font-medium">My bookings</span> and the
                    pass can be re-issued if you lose it.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      label="Your name"
                      placeholder="Ada Cruz"
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                      error={localErrors.guestName}
                      autoComplete="name"
                    />
                    <TextField
                      label="Phone"
                      type="tel"
                      placeholder="+63 917 000 0000"
                      value={guestPhone}
                      onChange={(e) => setGuestPhone(e.target.value)}
                      error={localErrors.guestPhone}
                      autoComplete="tel"
                    />
                  </div>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    Booking as a guest?{" "}
                    <Link to="/register" className="font-medium text-primary hover:underline">
                      Create an account
                    </Link>{" "}
                    instead and keep a history of your visits.
                  </p>
                </>
              )}

              <TextField
                label="Notes for your stylist"
                placeholder="Anything we should know — allergies, preferences, running late."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </section>
        </div>

        {/* ----------------------------------------------------- summary */}
        <aside className="min-w-0 lg:sticky lg:top-[92px] lg:h-fit">
          <div className="rounded-2xl border border-border/80 bg-card p-6 shadow-lift">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-display text-[19px] font-semibold tracking-tight">
                Your appointment
              </h2>
              <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {doneCount === 3 ? "Ready" : `Step ${doneCount + 1} of 3`}
              </span>
            </div>

            {/* Three segments, not a percentage: this is a sequence of
                decisions, not a quantity of work. A segment fills only when its
                step is genuinely answered, so the bar cannot claim more progress
                than the form has made. */}
            <div className="mt-3 flex gap-1" aria-hidden>
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-500",
                    n <= doneCount ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>

            <dl className="mt-5 space-y-3.5 text-[13px]">
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">Treatment</dt>
                <dd className="text-right font-medium">{service?.name ?? <Unset />}</dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">Stylist</dt>
                <dd className="text-right font-medium text-muted-foreground">
                  Assigned by the front desk
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">When</dt>
                <dd className="text-right font-medium">
                  {startTime ? (
                    <>
                      {branchDay(startTime)}
                      <br />
                      {branchTime(startTime)}
                    </>
                  ) : (
                    <Unset />
                  )}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">For</dt>
                <dd className="text-right font-medium">
                  {signedInClient ? me?.fullName ?? me?.email : guestName.trim() || <Unset />}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">Duration</dt>
                <dd className="text-right font-medium">
                  {service ? minutesToLabel(service.durationMinutes) : <Unset />}
                </dd>
              </div>
            </dl>

            {/* promo */}
            <div className="mt-6 border-t border-border/70 pt-5">
              <label
                htmlFor="promo"
                className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Promo code
              </label>
              <div className="mt-2 flex gap-2">
                <div className="relative flex-1">
                  <Tag className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                  <input
                    id="promo"
                    value={promoInput}
                    onChange={(e) => {
                      setPromoInput(e.target.value.toUpperCase());
                      setPromo(null);
                    }}
                    placeholder="SAVE10"
                    className="h-10 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-[13px] uppercase outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={checkPromo}
                  disabled={promoBusy || !promoInput.trim() || !service}
                >
                  {promoBusy ? <Loader2 className="size-4 animate-spin" /> : "Apply"}
                </Button>
              </div>
              {promo && (
                <p
                  className={cn(
                    "mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed",
                    promo.valid ? "text-alley-600" : "text-clay",
                  )}
                >
                  {promo.valid ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <X className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  {promo.message}
                </p>
              )}
            </div>

            {/* totals */}
            <dl className="mt-6 space-y-2.5 border-t border-border/70 pt-5 text-[13px]">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular-nums">{peso(subtotalCents)}</dd>
              </div>
              {discountCents > 0 && (
                <div className="flex items-center justify-between text-alley-600">
                  <dt>Discount</dt>
                  <dd className="tabular-nums">−{peso(discountCents)}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t border-border/70 pt-3">
                <dt className="font-medium">Total</dt>
                <dd className="font-display text-[22px] font-semibold tabular-nums text-primary">
                  {peso(totalCents)}
                </dd>
              </div>
            </dl>

            {error && (
              <ErrorNote
                error={error}
                className="mt-5"
                onRetry={error.code === "SLOT_TAKEN" ? slots.reload : undefined}
              />
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-6 h-12 w-full"
              disabled={submitting || !service || !startTime}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Reserving…
                </>
              ) : (
                <>
                  Confirm booking
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>

            <p className="mt-3 text-center text-[11.5px] leading-relaxed text-muted-foreground">
              No payment now. You can cancel free of charge up to two hours before.
            </p>
          </div>

          {status !== "authenticated" && (
            <p className="mt-4 text-center text-[12px] text-muted-foreground">
              <UserRound className="mr-1 inline size-3.5" />
              Already booked?{" "}
              <Link to="/scan" className="font-medium text-primary hover:underline">
                Find your pass
              </Link>
            </p>
          )}
        </aside>
      </form>
    </PublicShell>
  );
}


/**
 * The arrival pass, rendered where the booking was made.
 *
 * The public flow hands a guest the /pass URL because that link *is* their
 * capability — a guest has no account, so the URL is the only way back to the
 * booking. The desk has no such problem: the concierge is standing at the
 * screen with the guest, and the pass they need to hand over is already in the
 * create response (`booking.qr`). Sending them to another page to fetch it
 * makes them keep a link they never needed. So the same card the pass page
 * draws is drawn here, inline, and "New booking" clears it for the next guest.
 *
 * The row is the Overview row: sand time block, avatar, display name, icon
 * meta, status badge. Same card, same palette — only the QR and the details
 * below are new.
 */
function DeskPass({ booking, onAnother }: { booking: Booking; onAnother: () => void }) {
  const guest = booking.client?.fullName ?? booking.guest?.name ?? "Guest booking";
  const duration = booking.items.reduce((total, item) => total + item.durationMinutes, 0);
  const qr = booking.qr;

  return (
    <PublicShell>
      <PageHead
        eyebrow={`Booked · ${booking.reference}`}
        title={
          <>
            The chair is
            <span className="italic text-champagne-300"> held.</span>
          </>
        }
        lede="The pass is right here — print it, or show the code at reception. There is no link to wait for."
      />

      <div className="container max-w-2xl pb-16 pt-12">
        <div
          data-print="pass"
          className="rounded-2xl border border-border/80 bg-card p-6 shadow-lift sm:p-8"
        >
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex min-w-[70px] flex-col rounded-lg bg-sand-50 px-3 py-2 text-center">
              <span className="font-display text-[16px] font-semibold leading-none tabular-nums">
                {branchTime(booking.startTime)}
              </span>
              <span className="mt-1 text-[10px] text-muted-foreground">
                {relativeToNow(booking.startTime)}
              </span>
            </span>

            <PersonAvatar name={guest} className="size-10 shrink-0" />

            <div className="min-w-[170px] flex-1">
              <p className="font-display text-[18px] font-semibold leading-tight tracking-tight">
                {guest}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Sparkles className="size-3" />
                  {booking.items.map((item) => item.name).join(", ") || "—"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <UserRound className="size-3" />
                  {booking.employee.fullName}
                </span>
                {duration > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="size-3" />
                    {minutesToLabel(duration)}
                  </span>
                )}
              </p>
            </div>

            <StatusBadge status={booking.status} />
          </div>

          <div className="mt-7 flex flex-col items-center border-t border-border/70 pt-7">
            {qr?.url ? (
              <>
                <div className="rounded-2xl bg-white p-4 ring-1 ring-border">
                  <QRCodeSVG
                    value={qr.url}
                    size={188}
                    bgColor="#ffffff"
                    fgColor="#1B4D3E"
                    level="M"
                  />
                </div>
                <p className="mt-3 max-w-sm text-center text-[12px] leading-relaxed text-muted-foreground">
                  Scanned once at reception. Valid until {branchDay(qr.expiresAt)} ·{" "}
                  {branchTime(qr.expiresAt)}.
                </p>
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-6 py-8 text-center text-[12.5px] text-muted-foreground">
                This booking has no live pass — the code is issued closer to the
                appointment, and re-issued if the booking is moved.
              </p>
            )}
          </div>

          <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-border/70 pt-6 sm:grid-cols-2">
            <Fact icon={CalendarDays} label="When">
              {branchLongDay(booking.startTime)}
              <br />
              {branchTime(booking.startTime)} – {branchTime(booking.endTime)}
            </Fact>
            <Fact icon={UserRound} label="Stylist">
              {booking.employee.fullName}
            </Fact>
            <Fact icon={Sparkles} label="Treatment">
              {booking.items.map((item) => item.name).join(", ") || "—"}
            </Fact>
            <Fact icon={BadgeCheck} label="Reference">
              {booking.reference}
            </Fact>
            <Fact icon={Clock3} label="Booked by">
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
            </Fact>
            <Fact icon={Tag} label="Total">
              <span className="font-display text-[19px] font-semibold text-primary">
                {peso(booking.totalCents)}
              </span>
              {booking.discountCents > 0 && (
                <span className="ml-2 text-[12px] text-alley-600">
                  {peso(booking.discountCents)} off
                </span>
              )}
            </Fact>
          </dl>
        </div>

        <div data-print="hide" className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" />
            Print pass
          </Button>
          <Button onClick={onAnother}>
            <CalendarDays className="size-4" />
            New booking
          </Button>
          <span className="ml-auto text-[12px] text-muted-foreground">
            Ref {booking.reference}
          </span>
        </div>
      </div>
    </PublicShell>
  );
}

/** One labelled fact in the pass, matching the pass page's detail grid. */
function Fact({
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
