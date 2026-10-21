"use client";

import * as React from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { homeFor, useAuth } from "@/auth/AuthProvider";
import { BootScreen } from "@/auth/guards";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/auth/demo";
import { AuthAlert, AuthField, AuthLayout } from "@/components/app/AuthLayout";

/**
 * Sign in.
 *
 * The error handling is the interesting part. The API distinguishes four
 * failure modes that a user experiences completely differently, and collapsing
 * them into "login failed" would be a real usability loss:
 *
 *   INVALID_CREDENTIALS  a typo — stay on the form, keep the email
 *   ACCOUNT_LOCKED       wait it out — the message carries the minutes
 *   ACCOUNT_DISABLED     talk to the owner — retrying will never work
 *   VALIDATION_FAILED    the form itself is wrong
 *
 * So the code is branched on, and the API's own message is preferred over
 * anything invented here — it knows the lockout window.
 */
export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, login } = useAuth();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  // Where to land afterwards. A guard that bounced us here leaves the intended
  // path in `state`, so a deep link survives the login round trip.
  const from = (location.state as { from?: string } | null)?.from;

  if (status === "loading") return <BootScreen label="Restoring your session…" />;
  if (status === "authenticated") return <Navigate to={from ?? "/app"} replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const profile = await login(email.trim(), password);
      navigate(from ?? homeFor(profile.role), { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Something went wrong. Try again."),
      );
      setSubmitting(false);
    }
  }

  const fieldErrors = error?.fieldErrors ?? {};

  return (
    <AuthLayout
      eyebrow="Sign in"
      title="Welcome back."
      lede="Your chair, your clients, today's run sheet — or your own appointments, if you're here for one."
      footer={
        <>
          No account yet?{" "}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create one
          </Link>{" "}
          — it takes a moment and it is free.
        </>
      }
      aside={
        // Development only. `auth/demo.ts` exports empty values in a production
        // build, so rendering this panel there would show an empty card - and
        // the credentials it fills must never reach a public bundle at all.
        import.meta.env.DEV ? (
        <div className="rounded-xl border border-border/80 bg-sand-50 p-4">
          <p className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <Sparkles className="size-3.5 text-champagne-500" />
            Demo accounts
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            Three roles, three views of the same salon. Tap one to fill the form —
            the password is <code className="rounded bg-card px-1 py-0.5 text-[11px]">{DEMO_PASSWORD}</code>.
          </p>
          <div className="mt-3 grid gap-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => {
                  setEmail(account.email);
                  setPassword(DEMO_PASSWORD);
                  setError(null);
                }}
                className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.04]"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/[0.09] text-[10px] font-semibold text-primary">
                  {account.role[0]}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium">
                    {account.fullName}
                    <span className="ml-2 text-[10.5px] font-normal uppercase tracking-wide text-muted-foreground">
                      {account.role}
                    </span>
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {account.email}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
        ) : undefined
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error && (
          <AuthAlert
            tone={error.code === "ACCOUNT_LOCKED" ? "info" : "error"}
            title={
              error.code === "ACCOUNT_LOCKED"
                ? "Too many attempts"
                : error.code === "ACCOUNT_DISABLED"
                  ? "This account is not available"
                  : error.isNetwork
                    ? "Cannot reach the salon system"
                    : "That did not work"
            }
          >
            {error.message}
          </AuthAlert>
        )}

        <AuthField
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@beautyalley.ph"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          required
        />

        <AuthField
          label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          required
        />

        <Button type="submit" size="lg" className="h-11 w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Signing in…
            </>
          ) : (
            <>
              Sign in
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
