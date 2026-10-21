"use client";

/**
 * Promo codes — the record, for administrators.
 *
 * Two things about this page are shaped by how the API behaves rather than by
 * how a CRUD screen usually looks.
 *
 * **Delete is deactivate.** `DELETE /promos/:id` sets `is_active = false`; it
 * does not remove the row. That is deliberate on the API's side: a hard delete
 * would cascade `promo_redemptions` away and take the revenue history with it.
 * So the button says "Retire", not "Delete", and retired codes stay visible
 * under the filter — they are history, not garbage.
 *
 * **Redemption counts are live, not a column.** The count is computed per
 * request. A code with `maxRedemptions` shows `used / cap`, and the cap is
 * global across every client.
 */

import * as React from "react";
import { Loader2, Plus, Tag, Ticket, X } from "lucide-react";

import { branchDay, cn, peso } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import type { Promo, PromoType } from "@/lib/api-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, FieldError, Loading, TextField } from "@/components/app/api-bits";

function promoValue(promo: Promo) {
  return promo.type === "PERCENT" ? `${promo.value}%` : peso(promo.value);
}

function windowLabel(promo: Promo) {
  if (!promo.startsAt && !promo.endsAt) return "Always on";
  const from = promo.startsAt ? branchDay(promo.startsAt) : "any time";
  const to = promo.endsAt ? branchDay(promo.endsAt) : "no end";
  return `${from} → ${to}`;
}

function PromoRow({ promo, onChanged }: { promo: Promo; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function retire() {
    setBusy(true);
    setError(null);
    try {
      await api.promos.deactivate(promo.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not retire that code"));
    } finally {
      setBusy(false);
    }
  }

  const used = promo.liveRedemptions;
  const capped = promo.maxRedemptions !== null;

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-3.5 pl-5 pr-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
            <Tag className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-mono text-[12.5px] font-semibold tracking-tight">
              {promo.code}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{windowLabel(promo)}</p>
          </div>
        </div>
      </td>

      <td className="px-3 py-3.5">
        <span className="font-display text-[16px] font-semibold text-primary">
          {promoValue(promo)}
        </span>
        <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          {promo.type}
        </span>
      </td>

      <td className="px-3 py-3.5 text-[12.5px] tabular-nums">
        {used === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : capped ? (
          <span>
            {used}
            <span className="text-muted-foreground"> / {promo.maxRedemptions}</span>
          </span>
        ) : (
          <span>
            {used}
            <span className="text-muted-foreground"> / ∞</span>
          </span>
        )}
      </td>

      <td className="px-3 py-3.5 text-[12.5px] tabular-nums text-muted-foreground">
        {promo.perClientLimit ?? "∞"}
      </td>

      <td className="px-3 py-3.5 text-[12.5px] tabular-nums text-muted-foreground">
        {promo.minSpendCents > 0 ? peso(promo.minSpendCents) : "—"}
      </td>

      <td className="px-3 py-3.5">
        <Badge variant={promo.isActive ? "success" : "secondary"}>
          {promo.isActive ? "Live" : "Retired"}
        </Badge>
      </td>

      <td className="py-3.5 pl-3 pr-5 text-right">
        {promo.isActive ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-clay hover:bg-clay/10"
            onClick={retire}
            disabled={busy}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Retire"}
          </Button>
        ) : (
          <span className="text-[11.5px] text-muted-foreground">—</span>
        )}
        {error && <p className="mt-1 text-[11px] text-clay">{error.message}</p>}
      </td>
    </tr>
  );
}

export default function Promos() {
  const [includeInactive, setIncludeInactive] = React.useState(true);
  const [term, setTerm] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const list = useAsync(`promos:${includeInactive}`, async () =>
    (await api.promos.list({ limit: 100, activeOnly: !includeInactive })).data,
  );

  const rows = React.useMemo(() => {
    const all = list.data ?? [];
    const needle = term.trim().toLowerCase();
    return needle ? all.filter((p) => p.code.toLowerCase().includes(needle)) : all;
  }, [list.data, term]);

  const liveCount = (list.data ?? []).filter((p) => p.isActive).length;

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-7">
      <SectionHeading
        eyebrow="Records"
        title="Promo codes"
        description="Every code the salon has issued, with how much of each has been spent. Retiring a code keeps its redemption history — it does not delete it."
        action={
          <Button onClick={() => setCreating((v) => !v)} variant={creating ? "secondary" : "default"}>
            {creating ? <X className="size-4" /> : <Plus className="size-4" />}
            {creating ? "Cancel" : "New code"}
          </Button>
        }
      />

      {creating && (
        <NewPromoForm
          onCreated={() => {
            setCreating(false);
            list.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Filter by code…"
            aria-label="Filter promo codes"
            className="h-9 w-full rounded-full border border-border bg-card px-4 font-mono text-[12.5px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </div>

        <button
          type="button"
          onClick={() => setIncludeInactive((v) => !v)}
          aria-pressed={includeInactive}
          className={cn(
            "rounded-full border px-3.5 py-1.5 text-[12.5px] font-medium transition-colors",
            includeInactive
              ? "border-primary/30 bg-primary/[0.06] text-primary"
              : "border-border text-muted-foreground hover:border-primary/30",
          )}
        >
          {includeInactive ? "Showing retired" : "Live only"}
        </button>

        <span className="ml-auto text-[12.5px] text-muted-foreground">
          {liveCount} live
          {list.data ? ` · ${list.data.length} total` : ""}
        </span>
      </div>

      {list.error ? (
        <ErrorNote error={list.error} onRetry={list.reload} />
      ) : list.initial ? (
        <Loading label="Fetching promo codes…" />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={Ticket}
          title={term ? "No code matches that" : "No promo codes yet"}
          description={
            term
              ? "Try a shorter prefix — codes are matched anywhere in the string."
              : "Issue a code and it becomes usable at the booking desk immediately."
          }
          action={
            !term ? <Button onClick={() => setCreating(true)}>Create the first one</Button> : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border/70 bg-sand-50">
                  {["Code", "Value", "Redeemed", "Per client", "Min spend", "State", ""].map(
                    (heading, i) => (
                      <th
                        key={heading || `col-${i}`}
                        className={cn(
                          "px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground",
                          i === 0 && "pl-5",
                          i === 6 && "pr-5 text-right",
                        )}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((promo) => (
                  <PromoRow key={promo.id} promo={promo} onChanged={list.reload} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

function NewPromoForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [code, setCode] = React.useState("");
  const [type, setType] = React.useState<PromoType>("PERCENT");
  const [value, setValue] = React.useState("10");
  const [maxRedemptions, setMaxRedemptions] = React.useState("");
  const [perClientLimit, setPerClientLimit] = React.useState("");
  const [minSpend, setMinSpend] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [localErrors, setLocalErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const numeric = Number(value);
    const next: Record<string, string> = {};

    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code.trim())) {
      next.code = "3–64 characters: letters, digits, hyphen and underscore only";
    }
    if (!Number.isFinite(numeric) || numeric <= 0) next.value = "Must be greater than zero";
    if (type === "PERCENT" && (numeric < 1 || numeric > 100)) {
      next.value = "A percentage must be between 1 and 100";
    }
    setLocalErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await api.promos.create({
        code: code.trim().toUpperCase(),
        type,
        // PERCENT is a whole number; FIXED is minor units, so pesos -> cents.
        value: type === "PERCENT" ? Math.round(numeric) : Math.round(numeric * 100),
        ...(maxRedemptions.trim() ? { maxRedemptions: Number(maxRedemptions) } : {}),
        ...(perClientLimit.trim() ? { perClientLimit: Number(perClientLimit) } : {}),
        ...(minSpend.trim() ? { minSpendCents: Math.round(Number(minSpend) * 100) } : {}),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not create that code"));
      setBusy(false);
    }
  }

  const fieldErrors = { ...error?.fieldErrors, ...localErrors };

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-primary/25 bg-primary/[0.03] p-6"
      noValidate
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-[19px] font-semibold tracking-tight">Issue a new code</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" />
          Close
        </Button>
      </div>

      {error && (
        <ErrorNote
          error={error}
          className="mt-4"
        />
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <TextField
          label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="SPRING25"
          error={fieldErrors.code}
          className="[&_input]:font-mono"
        />

        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Type
          </span>
          <div className="mt-1.5 flex gap-1.5">
            {(["PERCENT", "FIXED"] as PromoType[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setType(option)}
                aria-pressed={type === option}
                className={cn(
                  "h-10 flex-1 rounded-lg border text-[12.5px] font-medium transition-colors",
                  type === option
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:border-primary/30",
                )}
              >
                {option === "PERCENT" ? "Percent off" : "Fixed amount"}
              </button>
            ))}
          </div>
        </div>

        <TextField
          label={type === "PERCENT" ? "Percent (1–100)" : "Amount in pesos"}
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={fieldErrors.value}
          placeholder={type === "PERCENT" ? "10" : "500"}
        />

        <TextField
          label="Max redemptions"
          inputMode="numeric"
          value={maxRedemptions}
          onChange={(e) => setMaxRedemptions(e.target.value)}
          hint="Blank means unlimited."
          placeholder="100"
        />

        <TextField
          label="Per-client limit"
          inputMode="numeric"
          value={perClientLimit}
          onChange={(e) => setPerClientLimit(e.target.value)}
          hint="Blank means unlimited."
          placeholder="1"
        />

        <TextField
          label="Minimum spend (pesos)"
          inputMode="numeric"
          value={minSpend}
          onChange={(e) => setMinSpend(e.target.value)}
          hint="Blank means no minimum."
          placeholder="1000"
        />
      </div>

      <FieldError>{fieldErrors.applicableServiceIds}</FieldError>

      <div className="mt-5 flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Issuing…
            </>
          ) : (
            <>
              <Plus className="size-4" />
              Issue code
            </>
          )}
        </Button>
        <p className="text-[12px] text-muted-foreground">
          Codes are stored uppercase and matched case-insensitively at the desk.
        </p>
      </div>
    </form>
  );
}
