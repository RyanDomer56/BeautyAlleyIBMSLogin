"use client";

/**
 * The employee record.
 *
 * Two things worth stating, because the screen could easily imply otherwise.
 *
 * **Working hours are not shown, because the API does not expose them.**
 * `GET /employees/:id` always passes `publicView = true`, so the response
 * carries `serviceIds` but no `workingHours` — those are an internal
 * scheduling detail with no RLS policy for a browser. Showing an empty shift
 * table would look like a data problem; omitting it and saying so does not.
 *
 * **Issuing a login is the only way to create a team account.** The role is
 * written to `app_metadata`, which only the service role can set, so this goes
 * through `POST /admin/users/staff` rather than through public registration.
 * That is why the form is here and not on the sign-up page. The endpoint name
 * is a leftover — it now issues EMPLOYEE, CONCIERGE and ADMIN accounts, and
 * refuses the retired 'STAFF' label.
 */

import * as React from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Loader2, RefreshCw, Scissors, Sparkles, UserPlus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import type { Employee } from "@/lib/api-types";
import { ROLE_LABEL } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/app/bits";
import { EmptyNote, ErrorNote, Loading, PersonAvatar, TextField } from "@/components/app/api-bits";

export default function Team() {
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);

  const roster = useAsync(`team:${includeInactive}`, () =>
    api.admin.employees({ limit: 100, includeInactive, sort: "full_name", order: "asc" }),
  );

  // Only needed to turn a service uuid into a readable name.
  const catalogue = useAsync("team:services", async () => (await api.services.list({ limit: 100 })).data);

  const detail = useAsync(`team:detail:${expanded}`, async () => {
    if (!expanded) return null;
    return api.employees.get(expanded);
  });

  const serviceName = (id: string) =>
    catalogue.data?.find((s) => s.id === id)?.name ?? "Unknown service";

  const rows = roster.data?.data ?? [];

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-7">
      <SectionHeading
        eyebrow="Records"
        title="Team"
        description="Who works the floor, and what each of them is qualified to do. Qualifications are what the booking engine consults before offering a slot."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={roster.reload}>
              <RefreshCw className="size-4" />
            </Button>
            <Button
              variant={inviting ? "secondary" : "default"}
              onClick={() => setInviting((v) => !v)}
            >
              {inviting ? <X className="size-4" /> : <UserPlus className="size-4" />}
              {inviting ? "Cancel" : "Issue staff login"}
            </Button>
          </div>
        }
      />

      {inviting && <InviteStaffForm onDone={() => setInviting(false)} onCancel={() => setInviting(false)} />}

      <div className="flex items-center gap-3">
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
        <span className="ml-auto text-[12.5px] text-muted-foreground">
          {rows.length} on the roster
        </span>
      </div>

      {roster.error ? (
        <ErrorNote error={roster.error} onRetry={roster.reload} />
      ) : roster.initial ? (
        <Loading label="Fetching the team…" />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={Scissors}
          title="No employees on the roster"
          description="Nobody is set up to take bookings yet."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((person) => (
            <EmployeeCard
              key={person.id}
              person={person}
              open={expanded === person.id}
              onToggle={() => setExpanded(expanded === person.id ? null : person.id)}
              detail={expanded === person.id ? detail : null}
              serviceName={serviceName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmployeeCard({
  person,
  open,
  onToggle,
  detail,
  serviceName,
}: {
  person: Employee;
  open: boolean;
  onToggle: () => void;
  detail: { data: Employee | null; error: ApiError | null; initial: boolean } | null;
  serviceName: (id: string) => string;
}) {
  return (
    <article
      className={cn(
        "flex flex-col rounded-xl border bg-card p-5 shadow-soft transition-colors",
        open ? "border-primary/40" : "border-border/80",
      )}
    >
      <div className="flex items-start gap-4">
        <PersonAvatar name={person.fullName} className="size-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[18px] font-semibold leading-tight tracking-tight">
            {person.fullName}
          </p>
          {person.title && (
            <p className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] text-primary">
              <Sparkles className="size-3" />
              {person.title}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={person.isActive ? "success" : "secondary"}>
              {person.isActive ? "Active" : "Inactive"}
            </Badge>
            {person.profileId && (
              <Badge variant="outline" title="Linked to a sign-in account">
                <BadgeCheck className="size-3" />
                Has login
              </Badge>
            )}
          </div>
        </div>
      </div>

      {person.bio && (
        <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">{person.bio}</p>
      )}

      {open && (
        <div className="mt-4 border-t border-border/70 pt-4">
          {detail?.error ? (
            <ErrorNote error={detail.error} />
          ) : detail?.initial ? (
            <Loading label="Loading qualifications…" className="py-6" />
          ) : detail?.data ? (
            <>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Qualified for
              </p>
              {detail.data.serviceIds && detail.data.serviceIds.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.data.serviceIds.map((id) => (
                    <Badge key={id} variant="outline">
                      {serviceName(id)}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  No qualifications recorded — this stylist cannot be booked for
                  anything yet.
                </p>
              )}
              <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                Shift patterns are not exposed by the API; they are an internal
                scheduling detail.
              </p>
            </>
          ) : null}
        </div>
      )}

      <Button variant="ghost" size="sm" className="mt-4 w-full" onClick={onToggle}>
        {open ? "Hide details" : "Show qualifications"}
      </Button>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Issue a staff login
 * ------------------------------------------------------------------ */

function InviteStaffForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<"EMPLOYEE" | "CONCIERGE" | "ADMIN">("EMPLOYEE");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [localErrors, setLocalErrors] = React.useState<Record<string, string>>({});
  const [created, setCreated] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!fullName.trim()) next.fullName = "A name is required";
    if (password.length < 8) next.password = "At least 8 characters";
    if (password.length > 72) next.password = "At most 72 characters";
    setLocalErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await api.admin.createStaff({
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        role,
      });
      setCreated(email.trim());
      setFullName("");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Could not create the account"));
    } finally {
      setBusy(false);
    }
  }

  const fieldErrors = { ...error?.fieldErrors, ...localErrors };

  return (
    <form onSubmit={submit} className="rounded-xl border border-primary/25 bg-primary/[0.03] p-6" noValidate>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-[19px] font-semibold tracking-tight">
            Issue a team login
          </h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            The role is written to the account's app metadata by the server — the
            person cannot promote themselves later.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" />
          Close
        </Button>
      </div>

      {created && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-alley-200 bg-alley-50 px-4 py-3">
          <BadgeCheck className="mt-0.5 size-4 shrink-0 text-alley-700" />
          <p className="text-[12.5px] text-alley-700">
            <span className="font-medium">{created}</span> now has a{" "}
            {ROLE_LABEL[role].toLowerCase()} account.{" "}
            {role === "EMPLOYEE"
              ? "Link it to an employee row to attribute check-ins to them."
              : "No employee row is needed — a concierge works the desk, not the floor."}
          </p>
        </div>
      )}

      {error && <ErrorNote error={error} className="mt-4" />}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Ana Reyes"
          error={fieldErrors.fullName}
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ana@beautyalley.ph"
          error={fieldErrors.email}
        />
        <TextField
          label="Temporary password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 8 characters"
          error={fieldErrors.password}
        />
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Role
          </span>
          <div className="mt-1.5 flex gap-1.5">
            {(["EMPLOYEE", "CONCIERGE", "ADMIN"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRole(option)}
                aria-pressed={role === option}
                className={cn(
                  "h-10 flex-1 rounded-lg border text-[12.5px] font-medium transition-colors",
                  role === option
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:border-primary/30",
                )}
              >
                {ROLE_LABEL[option]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Creating…
            </>
          ) : (
            <>
              <UserPlus className="size-4" />
              Create account
            </>
          )}
        </Button>
        <p className="text-[12px] text-muted-foreground">
          They can sign in immediately at{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            the sign-in page
          </Link>
          .
        </p>
      </div>
    </form>
  );
}
