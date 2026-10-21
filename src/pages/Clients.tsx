"use client";

/**
 * The client record.
 *
 * The numbers here come from `v_client_history`, a view — so `totalBookings`,
 * `lifetimeValueCents` and `lastVisitAt` are derived in the database rather
 * than counted in the browser. That matters for the CSV export in particular:
 * the file and the screen are reading the same definition of "lifetime value",
 * so they cannot disagree.
 *
 * Deactivating is a soft delete, for the same reason retiring a promo is: a
 * hard delete would cascade the client's bookings into anonymous guest rows
 * and silently rewrite history.
 */

import * as React from "react";
import {
  CalendarDays,
  Download,
  Loader2,
  Mail,
  Phone,
  RefreshCw,
  Search,
  UserRound,
  Users,
  X,
} from "lucide-react";

import { branchDay, branchTime, cn, peso } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, Loading, PersonAvatar, StatusBadge } from "@/components/app/api-bits";

function useDebounced<T>(value: T, ms = 300) {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function Clients() {
  const [term, setTerm] = React.useState("");
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState<ApiError | null>(null);
  const q = useDebounced(term);

  const list = useAsync(`clients:${q}:${includeInactive}`, () =>
    api.admin.clients({
      limit: 100,
      sort: "lifetime_value_cents",
      order: "desc",
      includeInactive,
      ...(q.trim() ? { q: q.trim() } : {}),
    }),
  );

  const detail = useAsync(`client:${selected}`, async () => {
    if (!selected) return null;
    return api.admin.client(selected);
  });

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      await api.admin.downloadClientsCsv();
    } catch (err) {
      setExportError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not export the list"),
      );
    } finally {
      setExporting(false);
    }
  }

  const rows = list.data?.data ?? [];
  const totalLtv = rows.reduce((n, c) => n + c.lifetimeValueCents, 0);

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-7">
      <SectionHeading
        eyebrow="Records"
        title="Clients"
        description="Everyone with an account, ranked by lifetime value. The figures are computed by a database view, so the CSV and this table always agree."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={list.reload}>
              <RefreshCw className="size-4" />
            </Button>
            <Button onClick={exportCsv} disabled={exporting}>
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Export CSV
            </Button>
          </div>
        }
      />

      {exportError && <ErrorNote error={exportError} />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Name, phone or email…"
            aria-label="Search clients"
            className="h-9 w-full rounded-full border border-border bg-card pl-10 pr-3 text-[13px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
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
          {includeInactive ? "Showing deactivated" : "Active only"}
        </button>

        <div className="ml-auto flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Badge variant="outline">{rows.length} clients</Badge>
          <Badge variant="champagne">{peso(totalLtv)} combined</Badge>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.7fr_1fr]">
        {/* ------------------------------------------------------- list */}
        <div>
          {list.error ? (
            <ErrorNote error={list.error} onRetry={list.reload} />
          ) : list.initial ? (
            <Loading label="Fetching clients…" />
          ) : rows.length === 0 ? (
            <EmptyNote
              icon={Users}
              title={q.trim() ? "No client matches that" : "No clients yet"}
              description={
                q.trim()
                  ? "Search covers name, phone and email. Try a shorter fragment."
                  : "Clients appear here once they book or create an account."
              }
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-soft">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border/70 bg-sand-50">
                      {["Client", "Visits", "Lifetime", "Last visit", "State"].map((heading, i) => (
                        <th
                          key={heading}
                          className={cn(
                            "px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground",
                            i === 0 && "pl-5",
                          )}
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((client) => {
                      const active = selected === client.id;
                      return (
                        <tr
                          key={client.id}
                          onClick={() => setSelected(active ? null : client.id)}
                          className={cn(
                            "cursor-pointer border-b border-border/60 transition-colors last:border-0",
                            active ? "bg-primary/[0.05]" : "hover:bg-primary/[0.03]",
                          )}
                        >
                          <td className="py-3.5 pl-5 pr-3">
                            <div className="flex items-center gap-2.5">
                              <PersonAvatar name={client.fullName} className="size-8 shrink-0" />
                              <div className="min-w-0">
                                <p className="truncate text-[12.5px] font-medium">
                                  {client.fullName}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {client.phone ?? client.email ?? "no contact on file"}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3.5 text-[12.5px] tabular-nums">
                            {client.totalBookings}
                            <span className="block text-[10.5px] text-muted-foreground">
                              {client.completedBookings} completed
                              {client.noShowBookings > 0 && ` · ${client.noShowBookings} no-show`}
                            </span>
                          </td>
                          <td className="px-3 py-3.5 font-display text-[15px] font-semibold tabular-nums text-primary">
                            {peso(client.lifetimeValueCents)}
                          </td>
                          <td className="px-3 py-3.5 text-[12px] text-muted-foreground">
                            {client.lastVisitAt ? branchDay(client.lastVisitAt) : "never"}
                          </td>
                          <td className="px-3 py-3.5">
                            <Badge variant={client.isActive ? "success" : "secondary"}>
                              {client.isActive ? "Active" : "Inactive"}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ----------------------------------------------------- detail */}
        <aside className="xl:sticky xl:top-[92px] xl:h-fit">
          {!selected ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center">
              <UserRound className="mx-auto size-6 text-muted-foreground/60" />
              <p className="mt-3 text-[13px] text-muted-foreground">
                Select a client to see their visit history.
              </p>
            </div>
          ) : detail.error ? (
            <ErrorNote error={detail.error} onRetry={detail.reload} />
          ) : detail.initial || !detail.data ? (
            <Loading label="Loading the client…" />
          ) : (
            <ClientPanel client={detail.data} onClose={() => setSelected(null)} onChanged={detail.reload} />
          )}
        </aside>
      </div>
    </div>
  );
}

function ClientPanel({
  client,
  onClose,
  onChanged,
}: {
  client: Awaited<ReturnType<typeof api.admin.client>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      if (client.isActive) await api.admin.deactivateClient(client.id);
      else await api.admin.updateClient(client.id, { isActive: true });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not update the client"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border/80 bg-card p-6 shadow-soft">
      <div className="flex items-start gap-4">
        <PersonAvatar name={client.fullName} className="size-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[20px] font-semibold leading-tight tracking-tight">
            {client.fullName}
          </h2>
          <div className="mt-2 space-y-1 text-[12px] text-muted-foreground">
            {client.phone && (
              <p className="flex items-center gap-1.5">
                <Phone className="size-3" />
                {client.phone}
              </p>
            )}
            {client.email && (
              <p className="flex items-center gap-1.5 truncate">
                <Mail className="size-3" />
                {client.email}
              </p>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border/70 pt-5">
        <Metric label="Lifetime value" value={peso(client.lifetimeValueCents)} />
        <Metric label="Visits" value={String(client.totalBookings)} />
        <Metric label="Completed" value={String(client.completedBookings)} />
        <Metric label="No-shows" value={String(client.noShowBookings)} />
        <Metric
          label="First visit"
          value={client.firstVisitAt ? branchDay(client.firstVisitAt) : "—"}
        />
        <Metric
          label="Last visit"
          value={client.lastVisitAt ? branchDay(client.lastVisitAt) : "—"}
        />
      </dl>

      <div className="mt-6 border-t border-border/70 pt-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Recent bookings
        </p>
        {client.recentBookings.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            This client has no bookings on record.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {client.recentBookings.slice(0, 6).map((booking) => (
              <li
                key={booking.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-sand-50 px-3.5 py-2.5"
              >
                <CalendarDays className="size-3.5 shrink-0 text-primary/70" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">
                    {booking.employeeName}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {branchDay(booking.startTime)} · {branchTime(booking.startTime)}
                  </span>
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                  {peso(booking.totalCents)}
                </span>
                <StatusBadge status={booking.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <ErrorNote error={error} className="mt-5" />}

      <Button
        variant={client.isActive ? "ghost" : "outline"}
        className={cn("mt-6 w-full", client.isActive && "text-clay hover:bg-clay/10")}
        onClick={toggleActive}
        disabled={busy}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {client.isActive ? "Deactivate this client" : "Reactivate this client"}
      </Button>
      <p className="mt-2 text-center text-[11px] leading-relaxed text-muted-foreground">
        Deactivating hides the client from the list but keeps every booking they
        made — history is never rewritten.
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 font-display text-[17px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
