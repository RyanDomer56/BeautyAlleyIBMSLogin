"use client";

/**
 * Small presentational pieces shared by the API-backed pages.
 *
 * These are deliberately separate from `bits.tsx`: that file is built around
 * the original fixture types (lowercase `AppointmentStatus`, `Tier`), and
 * quietly widening it to serve two vocabularies at once is how a codebase ends
 * up with two spellings of every status. These deal only in the API's.
 */

import * as React from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { STATUS_LABEL, STATUS_TONE, type ApiError } from "@/lib/api";
import type { BookingStatus, ServiceCategory } from "@/lib/api-types";

/* ------------------------------------------------------------------ *
 * Status + category
 * ------------------------------------------------------------------ */

export function StatusBadge({ status, className }: { status: BookingStatus; className?: string }) {
  return (
    <Badge variant={STATUS_TONE[status]} className={cn("whitespace-nowrap", className)}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const CATEGORY_META: Record<ServiceCategory, { label: string; className: string }> = {
  SPA: { label: "Spa", className: "border-primary/25 bg-primary/10 text-primary" },
  SALON: { label: "Salon", className: "border-champagne-300/70 bg-champagne-300/20 text-champagne-600" },
  // `text-sand-700` used to be here, but the `sand` scale stops at 400 — so
  // Tailwind emitted nothing for it and the label inherited whatever it sat on.
  WELLNESS: { label: "Wellness", className: "border-border bg-muted text-muted-foreground" },
};

export function CategoryBadge({
  category,
  className,
}: {
  category: ServiceCategory;
  className?: string;
}) {
  const meta = CATEGORY_META[category];
  return (
    <Badge variant="outline" className={cn(meta.className, className)}>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ *
 * Loading / error / empty
 * ------------------------------------------------------------------ */

/**
 * The waiting state.
 *
 * It carries the mark rather than a bare spinner: a blank page with a rotating
 * arc reads as "something is broken and retrying", while the logo reads as
 * "the salon is opening". The ring spins so the page still looks alive; the
 * logo stays still, because a pulsing crest looks like a rendering fault.
 */
export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16 text-[13px] text-muted-foreground",
        className,
      )}
    >
      <span className="relative flex size-16 items-center justify-center">
        <span
          aria-hidden
          className="absolute inset-0 animate-spin rounded-full border-2 border-primary/15 border-t-primary/70"
        />
        <img
          src="/brand/logo-mark.png"
          alt=""
          className="size-11 object-contain"
          draggable={false}
        />
      </span>
      {label}
    </div>
  );
}

/**
 * Errors are shown with their `code`, because the code is the thing that is
 * actually actionable — "SLOT_TAKEN" tells you to pick another time, while the
 * message alone reads like a generic failure.
 */
export function ErrorNote({
  error,
  onRetry,
  className,
}: {
  error: ApiError;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-clay/25 bg-clay/[0.04] px-5 py-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-clay" />
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-foreground">{error.message}</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {error.code}
            {error.status ? ` · ${error.status}` : ""}
          </p>
        </div>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyNote({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-14 text-center",
        className,
      )}
    >
      <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-primary/[0.07] text-primary">
        <Icon className="size-5" />
      </span>
      <h3 className="font-display text-xl font-semibold">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * Re-exported so the API-backed pages have a single import site. `bits.tsx`
 * carries the original implementation, which is agnostic about where a name
 * came from — it only hashes it to pick a tint.
 */
export { PersonAvatar } from "./bits";

/* ------------------------------------------------------------------ *
 * Field
 * ------------------------------------------------------------------ */

export function FieldError({ children }: { children?: string }) {
  if (!children) return null;
  return <p className="mt-1.5 text-[12px] text-clay">{children}</p>;
}

/**
 * A labelled input. Wraps the raw control so every form in the app gets the
 * same label/error/hint rhythm without repeating three divs each time.
 */
export function TextField({
  label,
  hint,
  error,
  className,
  id,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const auto = React.useId();
  const inputId = id ?? auto;
  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={inputId}
        className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={inputId}
        className={cn(
          "mt-1.5 h-10 w-full rounded-lg border bg-card px-3 text-[13.5px] outline-none transition-colors",
          "placeholder:text-muted-foreground/60",
          "focus:border-primary/50 focus:ring-2 focus:ring-primary/15",
          error ? "border-clay/50" : "border-border",
        )}
        {...props}
      />
      {hint && !error && <p className="mt-1.5 text-[11.5px] text-muted-foreground">{hint}</p>}
      <FieldError>{error}</FieldError>
    </div>
  );
}
