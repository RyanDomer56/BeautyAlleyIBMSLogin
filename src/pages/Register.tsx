"use client";

import * as React from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ArrowRight, Loader2, MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/auth/AuthProvider";
import { BootScreen } from "@/auth/guards";
import { AuthAlert, AuthField, AuthLayout } from "@/components/app/AuthLayout";

/**
 * Create a client account.
 *
 * Registering always produces a CLIENT. That is not a UI simplification — the
 * API's `/auth/register` has no role field at all, and the role is written by
 * a database trigger that ignores anything the caller supplies. Staff and
 * admin accounts are made from the console via `/admin/users/staff`, which is
 * the only path that can write `app_metadata`. So there is nothing here that
 * could be tampered with to self-promote, and nothing to explain about it.
 *
 * The form validates locally before it spends a request, because a password
 * mismatch is not something the server can see — the API has no confirmation
 * field to disagree with.
 */
export default function Register() {
  const navigate = useNavigate();
  const { status, register } = useAuth();

  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [localErrors, setLocalErrors] = React.useState<Record<string, string>>({});
  const [awaitingConfirmation, setAwaitingConfirmation] = React.useState(false);

  if (status === "loading") return <BootScreen label="Restoring your session…" />;
  if (status === "authenticated") return <Navigate to="/app/my-bookings" replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    // Local checks first — a mismatch costs a round trip otherwise, and the
    // server has no way to know the two fields were meant to agree.
    const next: Record<string, string> = {};
    if (!fullName.trim()) next.fullName = "Please tell us your name";
    if (password.length < 8) next.password = "At least 8 characters";
    if (password.length > 72) next.password = "At most 72 characters";
    if (password !== confirm) next.confirm = "The two passwords do not match";
    if (phone.trim() && !/^\+?[0-9 ()\-]{7,20}$/.test(phone.trim())) {
      next.phone = "Enter a valid phone number, or leave it blank";
    }
    setLocalErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await register({
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });

      if (result.requiresEmailConfirmation) {
        // The account exists but cannot sign in yet. Saying "welcome" here
        // would be a lie the next screen contradicts.
        setAwaitingConfirmation(true);
        setSubmitting(false);
        return;
      }
      // Straight into booking — a brand-new account has no history to look at,
      // and the reason they signed up is to reserve something.
      navigate("/book", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Something went wrong. Try again."),
      );
      setSubmitting(false);
    }
  }

  if (awaitingConfirmation) {
    return (
      <AuthLayout
        eyebrow="Almost there"
        title="Check your inbox."
        lede="Your account is created, but this project requires the address to be confirmed before you can sign in."
        footer={
          <Link to="/login" className="font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="flex items-start gap-3 rounded-xl border border-alley-200 bg-alley-50 px-5 py-4">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-alley-700" />
          <div>
            <p className="text-[13.5px] font-medium text-alley-700">
              Confirmation sent to {email}
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-alley-700/80">
              Follow the link in that email, then sign in. Nothing else is needed.
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  const fieldErrors = { ...error?.fieldErrors, ...localErrors };

  return (
    <AuthLayout
      eyebrow="Create account"
      title="Reserve your chair."
      lede="An account keeps your appointment history and re-issues your arrival pass if you lose it. You can also book as a guest without one."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error && (
          <AuthAlert
            title={
              error.code === "CONFLICT"
                ? "That email is already registered"
                : error.isNetwork
                  ? "Cannot reach the salon system"
                  : "That did not work"
            }
          >
            {error.code === "CONFLICT" ? (
              <>
                An account with that address already exists.{" "}
                <Link to="/login" className="font-medium underline">
                  Sign in instead
                </Link>
                .
              </>
            ) : (
              error.message
            )}
          </AuthAlert>
        )}

        <AuthField
          label="Full name"
          autoComplete="name"
          placeholder="Ada Cruz"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={fieldErrors.fullName}
          required
        />

        <AuthField
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          required
        />

        <AuthField
          label="Phone"
          type="tel"
          autoComplete="tel"
          placeholder="+63 917 000 0000"
          hint="Optional. Used to find your booking if you arrive without your pass."
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={fieldErrors.phone}
        />

        <AuthField
          label="Password"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          required
        />

        <AuthField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
          required
        />

        <Button type="submit" size="lg" className="h-11 w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Creating your account…
            </>
          ) : (
            <>
              Create account
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>

        <p className="text-center text-[11.5px] leading-relaxed text-muted-foreground">
          Accounts are created with client access. Stylist and administrator
          accounts are issued from the console.
        </p>
      </form>
    </AuthLayout>
  );
}
