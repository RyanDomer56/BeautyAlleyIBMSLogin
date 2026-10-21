"use client";

/**
 * The frame both auth pages sit in.
 *
 * A split screen rather than a centred card: the left panel is the only place
 * in the app where the brand gets to make an argument, and the right panel
 * stays narrow so the form is the only thing competing for attention.
 */

import * as React from "react";
import { Link } from "react-router-dom";

import { AlleySprig } from "@/components/brand/Logo";

export function AuthLayout({
  eyebrow,
  title,
  lede,
  children,
  aside,
  footer,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  children: React.ReactNode;
  /** Rendered under the form — the demo-account quick fill, usually. */
  aside?: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* ---------------------------------------------------- brand panel */}
      <aside className="grain relative hidden flex-col justify-between overflow-hidden bg-alley-900 p-12 text-primary-foreground lg:flex">
        <AlleySprig className="pointer-events-none absolute -left-24 top-16 h-[520px] w-[390px] text-white/[0.05]" />
        <AlleySprig className="pointer-events-none absolute -right-24 bottom-[-140px] h-[480px] w-[360px] rotate-[22deg] text-white/[0.04]" />

        <Link to="/" className="relative flex items-center gap-3">
          <img
            src="/brand/logo-ivory.png"
            alt="The Beauty Alley"
            width={1912}
            height={1912}
            className="h-14 w-14 object-contain drop-shadow-[0_2px_12px_rgba(7,25,20,0.45)]"
          />
          <span className="font-display text-[19px] font-semibold leading-none tracking-tight">
            The Beauty Alley
          </span>
        </Link>

        <div className="relative max-w-md">
          <h2 className="font-display text-[clamp(2.2rem,3.4vw,3rem)] font-medium leading-[1.04] tracking-tight text-balance">
            One desk.
            <span className="block italic text-champagne-300">Three points of view.</span>
          </h2>
          <p className="mt-5 text-[14px] leading-relaxed text-primary-foreground/65">
            The same system serves the owner, the stylist and the client — each
            sees exactly their own room and nothing else.
          </p>

          <dl className="mt-10 space-y-5">
            {[
              ["Administrator", "Bookings, clients, promo codes and the team record"],
              ["Stylist", "Today's run sheet and the door — arrivals, not revenue"],
              ["Client", "Your appointments, and the pass that checks you in"],
            ].map(([role, blurb]) => (
              <div key={role} className="flex gap-4 border-l border-white/15 pl-4">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-champagne-300">
                    {role}
                  </dt>
                  <dd className="mt-1 text-[13px] leading-relaxed text-primary-foreground/60">
                    {blurb}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-[11.5px] text-primary-foreground/35">
          Access is enforced by the API on every request — this screen only decides
          what is worth showing you.
        </p>
      </aside>

      {/* --------------------------------------------------------- form */}
      <main className="flex flex-col justify-center bg-background px-6 py-14 sm:px-12">
        <div className="mx-auto w-full max-w-[400px]">
          <Link to="/" className="mb-10 inline-flex items-center gap-2.5 lg:hidden">
            <img
              src="/brand/logo-emerald.png"
              alt="The Beauty Alley"
              width={1912}
              height={1912}
              className="h-14 w-14 object-contain"
            />
            <span className="font-display text-[19px] font-semibold tracking-tight">
              The Beauty Alley
            </span>
          </Link>

          <p className="eyebrow">{eyebrow}</p>
          <h1 className="mt-3 font-display text-[clamp(1.9rem,3.2vw,2.4rem)] font-medium leading-tight tracking-tight">
            {title}
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">{lede}</p>

          <div className="mt-9">{children}</div>

          {aside && <div className="mt-9">{aside}</div>}

          <div className="mt-8 border-t border-border/70 pt-6 text-[13px] text-muted-foreground">
            {footer}
          </div>
        </div>
      </main>
    </div>
  );
}

/** A labelled input for the auth forms. */
export function AuthField({
  label,
  error,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = React.useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        className={
          "mt-1.5 h-11 w-full rounded-lg border bg-card px-3.5 text-[14px] outline-none transition-colors placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary/15 " +
          (error ? "border-clay/50 focus:border-clay/60" : "border-border focus:border-primary/50")
        }
        {...props}
      />
      {hint && !error && <p className="mt-1.5 text-[11.5px] text-muted-foreground">{hint}</p>}
      {error && <p className="mt-1.5 text-[12px] text-clay">{error}</p>}
    </div>
  );
}

/** The banner shown for a whole-form failure. */
export function AuthAlert({
  tone = "error",
  title,
  children,
}: {
  tone?: "error" | "info" | "success";
  title: string;
  children?: React.ReactNode;
}) {
  const styles = {
    error: "border-clay/25 bg-clay/[0.05] text-clay",
    info: "border-border bg-sand-50 text-foreground",
    success: "border-alley-200 bg-alley-50 text-alley-700",
  }[tone];

  return (
    <div className={"rounded-lg border px-4 py-3 " + styles}>
      <p className="text-[13px] font-medium">{title}</p>
      {children && <div className="mt-1 text-[12.5px] leading-relaxed opacity-90">{children}</div>}
    </div>
  );
}
