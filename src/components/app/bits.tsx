"use client";

import * as React from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import type { AppointmentStatus, Tier } from "@/data/salon";
import { TIER_META } from "@/data/salon";

/* ------------------------------------------------------------------ *
 * Change indicator — a number against a previous period, in words too.
 * ------------------------------------------------------------------ */

export function Delta({
  value,
  against,
  goodWhen = "up",
  suffix,
  className,
}: {
  value: number;
  against: string;
  goodWhen?: "up" | "down";
  suffix?: string;
  className?: string;
}) {
  const up = value >= 0;
  const good = up === (goodWhen === "up");
  const Icon = up ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[12.5px] font-medium tabular-nums",
        // Semantic, not brand: a rise that is *good* is green in either palette.
        good ? "text-success" : "text-destructive",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {Math.abs(value)}%
      {suffix && (
        <span className="font-normal text-muted-foreground">{suffix}</span>
      )}
      <span className="sr-only"> {against}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Avatars — initials on a deterministic brand tint. No stock photos.
 * ------------------------------------------------------------------ */

/*
 * Tints are tokens, not brand literals, so an avatar is emerald on the public
 * site and rosewood/champagne inside the console without a second list.
 */
const TINTS = [
  "bg-primary text-primary-foreground",
  "bg-primary/75 text-primary-foreground",
  "bg-accent text-accent-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-muted-foreground text-background",
  "bg-accent/60 text-accent-foreground",
];

function tintFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

export function PersonAvatar({
  name,
  className,
  ring = false,
}: {
  name: string;
  className?: string;
  ring?: boolean;
}) {
  return (
    <Avatar
      className={cn(
        "size-9",
        ring && "ring-2 ring-background",
        className,
      )}
    >
      <AvatarFallback className={cn("text-[11px] font-semibold", tintFor(name))}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function AvatarStack({
  names,
  max = 3,
  className,
}: {
  names: string[];
  max?: number;
  className?: string;
}) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className={cn("flex items-center", className)}>
      {shown.map((n, i) => (
        <PersonAvatar
          key={n}
          name={n}
          ring
          className={cn("size-6", i > 0 && "-ml-2")}
        />
      ))}
      {rest > 0 && (
        <span className="-ml-2 flex size-6 items-center justify-center rounded-full bg-muted text-[9.5px] font-semibold text-muted-foreground ring-2 ring-background">
          +{rest}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Domain pills
 * ------------------------------------------------------------------ */

const STATUS_META: Record<
  AppointmentStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "success" | "warning" | "destructive" }
> = {
  confirmed: { label: "Confirmed", variant: "outline" },
  "checked-in": { label: "Checked in", variant: "warning" },
  "in-service": { label: "In service", variant: "default" },
  completed: { label: "Completed", variant: "success" },
  "no-show": { label: "No-show", variant: "destructive" },
};

export function StatusPill({ status }: { status: AppointmentStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="whitespace-nowrap">
      {meta.label}
    </Badge>
  );
}

export function TierBadge({ tier }: { tier: Tier }) {
  const meta = TIER_META[tier];
  return (
    <Badge variant={meta.variant} title={meta.blurb}>
      {tier}
    </Badge>
  );
}

/* ------------------------------------------------------------------ *
 * Section furniture
 * ------------------------------------------------------------------ */

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h2 className="font-display text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
          {title}
        </h2>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground text-pretty">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/80 bg-card shadow-soft",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/[0.07] text-primary">
        <Icon className="size-5" />
      </span>
      <h3 className="font-display text-xl font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px] text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** A quiet label/value pair for definition lists. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1.5 text-[13.5px] text-foreground">{children}</dd>
    </div>
  );
}
