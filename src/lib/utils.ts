import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1234 -> "1,234" */
export const fmt = (n: number) => n.toLocaleString("en-US");

/** Money, always with cents unless whole. */
export function money(n: number, opts?: { cents?: boolean }) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts?.cents ? 2 : 0,
    maximumFractionDigits: opts?.cents ? 2 : 0,
  }).format(n);
}

export function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** "2026-10-09" -> "Fri 9 Oct" */
export function shortDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function minutesToLabel(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/* ------------------------------------------------------------------ *
 * Branch time
 * ------------------------------------------------------------------ */

/**
 * The salon's timezone, matching `BRANCH_TIMEZONE` in the backend.
 *
 * The API speaks UTC (`Z`-suffixed) for every instant, because an instant has
 * no timezone. "10:00 AM" is a *local* reading of that instant, so the
 * conversion has to happen at the point of display — and it has to happen
 * against a named zone, not the viewer's. A stylist checking the run sheet
 * from another country must still see the chair's clock.
 */
export const BRANCH_TZ = "Asia/Manila";

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BRANCH_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const dayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BRANCH_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
});

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BRANCH_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const longFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BRANCH_TZ,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** An ISO instant -> "2:00 PM" in branch time. */
export function branchTime(iso: string) {
  return timeFmt.format(new Date(iso));
}

/** An ISO instant -> "Fri 9 Oct" in branch time. */
export function branchDay(iso: string) {
  return dayFmt.format(new Date(iso));
}

/** An ISO instant -> "2026-10-09", the branch's calendar day. */
export function branchDayKey(iso: string) {
  return dayKeyFmt.format(new Date(iso));
}

/** An ISO instant -> "Friday, 9 October 2026" in branch time. */
export function branchLongDay(iso: string) {
  return longFmt.format(new Date(iso));
}

/** Today's calendar day at the branch, as `YYYY-MM-DD`. */
export function branchToday() {
  return dayKeyFmt.format(new Date());
}

/** `YYYY-MM-DD` shifted by whole days, staying in the string domain. */
export function shiftDayKey(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * Minor units -> "₱2,500".
 *
 * The API is in cents throughout so that no rounding happens in transit. This
 * is the only place the division occurs.
 */
export function peso(cents: number, opts?: { cents?: boolean }) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: opts?.cents ? 2 : 0,
    maximumFractionDigits: opts?.cents ? 2 : 0,
  }).format((cents ?? 0) / 100);
}

/** A relative "in 2 days" / "3 hours ago" for booking rows. */
export function relativeToNow(iso: string) {
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  const suffix = diffMs >= 0 ? "from now" : "ago";

  if (mins < 60) return `${mins} min ${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ${suffix}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ${suffix}`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ${suffix}`;
}

/** 840 -> "2:00 PM" */
export function clock(mins: number) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
