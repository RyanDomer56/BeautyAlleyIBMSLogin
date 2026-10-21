"use client";

/**
 * Route guards.
 *
 * These are ergonomics, not enforcement — the API re-checks every role and RLS
 * re-checks every row underneath it. What they buy is that a client never
 * lands on a screen that will only 403, and never sees a flash of an empty
 * console before being bounced to the login form.
 */

import * as React from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AlleyMark } from "@/components/brand/Logo";
import { useAuth, type Area } from "./AuthProvider";

/** Shown while the stored session is being checked against `/auth/me`. */
export function BootScreen({ label = "Checking your session…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
      <AlleyMark className="h-12 w-12 text-primary" />
      <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </p>
    </div>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <BootScreen />;

  if (status === "anonymous") {
    // Remember where they were headed so login can return them there.
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return <>{children}</>;
}

/**
 * Gate a single area. Used inside the console so one shell can serve several
 * roles without every page re-deriving what it is allowed to show.
 */
export function RequireArea({ area, children }: { area: Area; children: React.ReactNode }) {
  const { can, role } = useAuth();

  if (can(area)) return <>{children}</>;

  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-4 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-clay/10 text-clay">
        <ShieldAlert className="size-5" />
      </span>
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Not your room</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
          {role
            ? `The ${role.toLowerCase()} role does not have access to this area.`
            : "You need to sign in to open this area."}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link to="/app">Back to the console</Link>
      </Button>
    </div>
  );
}
