"use client";

/**
 * The frame for the public pages — the ones a visitor reaches without signing
 * in. Landing keeps its own bespoke chrome because it is a marketing page;
 * everything else shares this so the header does not have to be rewritten four
 * times and drift.
 *
 * The header is session-aware in one direction only now: a signed-in visitor
 * gets a way back into the console. An anonymous visitor gets no sign-in
 * prompt, because Sign In was removed from the public navigation — the only
 * remaining door into the console is the discreet staff link in the footer.
 */

import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutDashboard, LogOut, QrCode, Search, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AlleyMark, AlleySprig } from "@/components/brand/Logo";
import { PublicMobileNav, PublicNavLinks } from "@/components/app/PublicNav";
import { homeFor, ROLE_LABEL, useAuth } from "@/auth/AuthProvider";
import { CONSOLE_ORIGIN, consoleHref } from "@/lib/console";

export function PublicShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { status, me, role, logout } = useAuth();
  const navigate = useNavigate();
  const authed = status === "authenticated" && !!me;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-alley-900/10 bg-alley-900/95 backdrop-blur-md">
        <div className="container flex h-[70px] items-center gap-5">
          <Link to="/" className="flex shrink-0 items-center gap-3" aria-label="The Beauty Alley — home">
            <img
              src="/brand/logo-ivory.png"
              alt="The Beauty Alley"
              width={1912}
              height={1912}
              className="h-14 w-14 object-contain drop-shadow-[0_2px_12px_rgba(7,25,20,0.45)]"
            />
            <span className="hidden font-display text-[19px] font-semibold leading-none tracking-tight text-primary-foreground sm:block">
              The Beauty Alley
            </span>
          </Link>

          <PublicNavLinks className="ml-2 hidden md:flex" />

          <div className="ml-auto flex items-center gap-2">
            {authed ? (
              <>
                <span className="hidden items-center gap-2.5 rounded-full border border-white/15 py-1 pl-1 pr-3 lg:flex">
                  <span className="flex size-7 items-center justify-center rounded-full bg-champagne-400 text-[10.5px] font-semibold text-accent-foreground">
                    {(me.fullName ?? me.email ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex flex-col leading-none">
                    <span className="text-[11.5px] font-semibold text-primary-foreground">
                      {me.fullName ?? me.email}
                    </span>
                    <span className="text-[9.5px] text-primary-foreground/50">
                      {role ? ROLE_LABEL[role] : ""}
                    </span>
                  </span>
                </span>
                <Button asChild size="sm" variant="champagne" className="h-9">
                  {/*
                    A client's "console" is their own bookings, on this site.
                    Staff belong on the console's own origin — an absolute
                    link when `VITE_CONSOLE_URL` is set, a router link when
                    the two still share an origin.
                  */}
                  {role === "CLIENT" ? (
                    <Link to={homeFor(role)}>
                      <LayoutDashboard className="size-4" />
                      My bookings
                    </Link>
                  ) : CONSOLE_ORIGIN ? (
                    <a href={consoleHref(role ? homeFor(role) : "/app")}>
                      <LayoutDashboard className="size-4" />
                      Console
                    </a>
                  ) : (
                    <Link to={role ? homeFor(role) : "/app"}>
                      <LayoutDashboard className="size-4" />
                      Console
                    </Link>
                  )}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Sign out"
                  className="text-primary-foreground/70 hover:bg-white/10 hover:text-primary-foreground"
                  onClick={async () => {
                    await logout();
                    navigate("/");
                  }}
                >
                  <LogOut className="size-4" />
                </Button>
              </>
            ) : (
              <Button asChild size="sm" variant="champagne" className="h-9 px-5">
                <Link to="/book">Book now</Link>
              </Button>
            )}

            <PublicMobileNav triggerClassName="md:hidden" />
          </div>
        </div>
      </header>

      <main className={cn("flex-1", className)}>{children}</main>

      <footer className="border-t border-border/70 bg-sand-50">
        <div className="container grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-3">
              <AlleyMark className="h-10 w-10 text-primary" />
              <span className="font-display text-[19px] font-semibold tracking-tight">
                The Beauty Alley
              </span>
            </div>
            <p className="mt-4 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
              A downtown atelier for hair, skin, nails and body — run on one
              quietly exact system.
            </p>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Visit
            </h3>
            <ul className="mt-4 space-y-2.5 text-[13px]">
              <li>
                <Link to="/services" className="inline-flex items-center gap-1.5 text-foreground/75 transition-colors hover:text-primary">
                  <Search className="size-3.5" /> Services & pricing
                </Link>
              </li>
              <li>
                <Link to="/book" className="inline-flex items-center gap-1.5 text-foreground/75 transition-colors hover:text-primary">
                  <Sparkles className="size-3.5" /> Book an appointment
                </Link>
              </li>
              <li>
                <Link to="/scan" className="inline-flex items-center gap-1.5 text-foreground/75 transition-colors hover:text-primary">
                  <QrCode className="size-3.5" /> Arrive & scan
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Your account
            </h3>
            <ul className="mt-4 space-y-2.5 text-[13px]">
              <li>
                <Link to="/register" className="text-foreground/75 transition-colors hover:text-primary">
                  Create a client account
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border/70">
          <div className="container flex flex-wrap items-center justify-between gap-3 py-6 text-[12px] text-muted-foreground">
            <p>© 2026 The Beauty Alley. All rights reserved.</p>
            <p className="font-display text-[13px] italic">Crafted with care, downtown.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** The band a public page opens with. */
export function PageHead({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="grain relative overflow-hidden bg-alley-900 pb-14 pt-14 text-primary-foreground">
      <AlleySprig className="pointer-events-none absolute -right-20 -top-16 h-[380px] w-[300px] text-white/[0.05]" />
      <div className="container relative">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.24em] text-champagne-300">
          {eyebrow}
        </p>
        <h1 className="mt-4 font-display text-[clamp(2.1rem,4.6vw,3.2rem)] font-medium leading-[1.04] tracking-tight text-balance">
          {title}
        </h1>
        {lede && (
          <p className="mt-4 max-w-2xl text-[14.5px] leading-relaxed text-primary-foreground/65 text-pretty">
            {lede}
          </p>
        )}
        {children && <div className="mt-8">{children}</div>}
      </div>
    </section>
  );
}
