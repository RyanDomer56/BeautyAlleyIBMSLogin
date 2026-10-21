"use client";

/**
 * The public front door.
 *
 * Two things changed from the fixture version. The CTAs used to point into the
 * console (`/app/bookings`), which was wrong on two counts: a stranger landing
 * here has no account, and the console is now behind a login. They point at the
 * public flow instead — `/services`, `/book`, `/scan`.
 *
 * The header menu is the shared public navigation (Home, Scan & Check In,
 * Services). Sign In is no longer offered here: the public site should not
 * advertise a door to the console, so the only entry point left is the discreet
 * staff link in the footer.
 *
 * And the menu is read live. A marketing page that advertises prices the salon
 * no longer charges is worse than no menu at all, so the services grid is a real
 * `GET /services` call. It is public and RLS-limited to active rows, so it works
 * for a signed-out visitor.
 */

import * as React from "react";
import { Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowRight,
  CalendarCheck,
  Clock3,
  MapPin,
  QrCode,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { cn, minutesToLabel, peso } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import { serviceImage } from "@/lib/service-images";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlleyBadge, AlleySprig, AlleyMark } from "@/components/brand/Logo";
import { CategoryBadge, ErrorNote, Loading } from "@/components/app/api-bits";
import { PublicMobileNav, PublicNavLinks } from "@/components/app/PublicNav";
import { Reveal } from "@/components/app/reveal";

/* ------------------------------------------------------------------ *
 * Copy local to the marketing page
 * ------------------------------------------------------------------ */

const STEPS = [
  {
    icon: CalendarCheck,
    title: "Book in seconds",
    body: "Pick a treatment, a day and a stylist. You'll get a confirmation and an arrival pass instantly — no account required.",
  },
  {
    icon: QrCode,
    title: "Scan at the door",
    body: "Show your pass at reception. The desk checks you in and the floor knows you've arrived.",
  },
  {
    icon: Sparkles,
    title: "Sit back",
    body: "Your stylist already has the details. Rebook before you leave — same chair, same time.",
  },
];

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Landing() {
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Six is a taste, not the whole menu — the full catalogue lives at /services.
  const menu = useAsync("landing:services", async () =>
    (await api.services.list({ limit: 6, sort: "price_cents", order: "asc" })).data,
  );

  return (
    <div className="min-h-screen bg-background">
      {/* ---------------------------------------------------------- nav */}
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-40 transition-[background-color,box-shadow,backdrop-filter] duration-500 ease-out-quart",
          scrolled
            ? "border-b border-alley-900/10 bg-alley-900/95 backdrop-blur-md"
            : "bg-transparent",
        )}
      >
        <div className="container flex h-[74px] items-center gap-6">
          <Link to="/" className="flex items-center gap-3" aria-label="The Beauty Alley — home">
            <img
              src="/brand/logo-ivory.png"
              alt="The Beauty Alley"
              width={1912}
              height={1912}
              className="h-14 w-14 object-contain drop-shadow-[0_2px_12px_rgba(7,25,20,0.45)]"
            />
            <span className="hidden font-display text-[19px] font-semibold leading-none tracking-tight text-primary-foreground drop-shadow-[0_1px_10px_rgba(7,25,20,0.45)] sm:block">
              The Beauty Alley
            </span>
          </Link>

          <PublicNavLinks className="ml-auto hidden lg:flex" />

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            {/*
             * The home page is the booking site and nothing else. The console
             * is published on its own origin (see `lib/console.ts`), so there
             * is no staff door here to advertise — a visitor's only move is to
             * book.
             */}
            <Button asChild size="sm" variant="champagne" className="h-9 px-5">
              <Link to="/book">
                Book now
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <PublicMobileNav triggerClassName="lg:hidden" />
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------- hero */}
      {/*
        The hero is a full-viewport video, the way thespa.com.ph opens: one
        looping clip filling the screen with the nav floating on top of it.

        `muted` + `playsInline` are what actually let it autoplay — a browser
        will refuse otherwise.

        The still frame is a SEPARATE <img> sitting under the video rather than
        the `poster` attribute. That matters: a poster belongs to the video
        element, so anything that hides the video hides the still with it — and
        the hero then collapses to a bare green rectangle with no imagery. As a
        sibling layer the still survives every case where the clip cannot paint:
        before the first bytes arrive, when autoplay is refused (data saver, low
        power mode), when the codec is unavailable, and for anyone whose system
        asks for reduced motion.
      */}
      <section className="relative flex min-h-[100svh] items-center overflow-hidden bg-alley-950 text-primary-foreground">
        <img
          src="/assets/massage.jpg"
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
        <video
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden
        >
          <source src="/assets/beatyalley.mp4" type="video/mp4" />
        </video>

        {/* Legibility scrim — darkest under the nav and under the copy, lightest
            in the middle so the footage still reads. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-alley-950/80 via-alley-950/40 to-alley-950/85"
        />

        <div className="container relative z-10 pb-24 pt-[120px]">
          <div className="max-w-2xl animate-fade-up">
            <span className="inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-white/[0.07] px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-foreground/80 backdrop-blur-sm">
              <span className="size-1.5 rounded-full bg-champagne-400" />
              Est. 2019 · Hair, skin, nails & body
            </span>

            <h1 className="mt-7 font-display text-[clamp(2.9rem,7.5vw,5.2rem)] font-medium leading-[0.98] tracking-[-0.02em] text-balance drop-shadow-[0_2px_24px_rgba(7,25,20,0.5)]">
              Beauty, kept
              <span className="block italic text-champagne-300">impeccably</span>
              in order.
            </h1>

            <p className="mt-7 max-w-xl text-[15.5px] leading-relaxed text-primary-foreground/80 text-pretty drop-shadow-[0_1px_12px_rgba(7,25,20,0.5)]">
              Book a treatment, arrive with a pass, and let the chair do the rest.
              Behind it all, one quietly exact system runs the floor.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" variant="champagne" className="h-12">
                <Link to="/book">
                  Reserve your chair
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 border-white/30 text-primary-foreground hover:border-white/60 hover:bg-white/10"
              >
                <Link to="/services">See the menu</Link>
              </Button>
            </div>

            <p className="mt-6 text-[12.5px] text-primary-foreground/60">
              No account needed to book —{" "}
              <Link to="/register" className="underline decoration-white/30 underline-offset-4 hover:text-primary-foreground/90">
                create one
              </Link>{" "}
              to keep your history and passes together.
            </p>
          </div>
        </div>

        {/* Scroll cue, so the hero reads as a screen you move past. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-7 flex justify-center">
          <span className="flex h-9 w-[22px] items-start justify-center rounded-full border border-white/35 p-1">
            <span className="size-1.5 animate-bounce rounded-full bg-white/70" />
          </span>
        </div>
      </section>

      {/* ----------------------------------------------------- services */}
      <section id="services" className="scroll-mt-24 border-y border-border/70 bg-sand-50">
        <div className="container py-24">
          <Reveal className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <p className="eyebrow">The menu</p>
              <h2 className="mt-3 font-display text-[clamp(2rem,4.4vw,3.1rem)] font-medium leading-[1.05] tracking-tight">
                Services, priced plainly.
              </h2>
              <p className="mt-4 text-[14.5px] leading-relaxed text-muted-foreground">
                Read live from the salon's own catalogue — what you see is what the
                desk charges.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link to="/services">
                Browse every service
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </Reveal>

          {menu.error ? (
            <ErrorNote error={menu.error} onRetry={menu.reload} className="mt-12" />
          ) : menu.initial ? (
            <Loading label="Reading the menu…" className="mt-12" />
          ) : (
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(menu.data ?? []).map((s, i) => (
                <Reveal key={s.id} delay={(i % 3) * 60}>
                  <Link
                    to="/services"
                    className="group flex h-full flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-soft transition-[box-shadow,transform,border-color] duration-500 ease-out-quart hover:-translate-y-1 hover:border-primary/25 hover:shadow-lift"
                  >
                    <div className="aspect-[4/3] overflow-hidden bg-sand-100">
                      <img
                        src={serviceImage(s)}
                        alt={s.name}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-700 ease-out-quart group-hover:scale-[1.04]"
                      />
                    </div>
                    <div className="flex flex-1 flex-col p-6">
                      <div className="flex items-center justify-between gap-3">
                        <CategoryBadge category={s.category} />
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <Clock3 className="size-3.5" />
                          {minutesToLabel(s.durationMinutes)}
                        </span>
                      </div>
                      <h3 className="mt-5 font-display text-[21px] font-semibold leading-tight tracking-tight">
                        {s.name}
                      </h3>
                      <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                        {s.description}
                      </p>
                      <div className="mt-auto flex items-end justify-between gap-4 pt-6">
                        <span className="font-display text-[26px] font-semibold tracking-tight text-primary">
                          {peso(s.priceCents)}
                        </span>
                        <ArrowRight className="size-4 text-muted-foreground transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-primary" />
                      </div>
                    </div>
                  </Link>
                </Reveal>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ checkin */}
      <section id="checkin" className="container scroll-mt-24 py-24">
        <div className="grid items-center gap-16 lg:grid-cols-[0.95fr_1.05fr]">
          <Reveal>
            <p className="eyebrow">Check-in</p>
            <h2 className="mt-3 font-display text-[clamp(2rem,4.4vw,3.1rem)] font-medium leading-[1.05] tracking-tight text-balance">
              Arrive, scan, and you're expected.
            </h2>
            <p className="mt-5 text-[14.5px] leading-relaxed text-muted-foreground text-pretty">
              No clipboard, no queue at the desk. Your appointment carries its own
              pass — the floor knows the moment you walk in.
            </p>

            <ol className="mt-10 space-y-7">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-5">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card text-primary shadow-soft">
                    <s.icon className="size-5" />
                  </span>
                  <div className="pt-0.5">
                    <h3 className="font-display text-[19px] font-semibold tracking-tight">
                      {i + 1}. {s.title}
                    </h3>
                    <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
                      {s.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-9 flex flex-wrap gap-3">
              <Button asChild>
                <Link to="/scan">
                  <QrCode className="size-4" />
                  Walk in & scan
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/scan">I already have a pass</Link>
              </Button>
            </div>
          </Reveal>

          {/* Illustrative pass — the real one is issued per booking at /book. */}
          <Reveal delay={120} className="flex justify-center lg:justify-end">
            <div className="relative w-full max-w-[400px]">
              <div className="rounded-2xl border border-border/80 bg-card p-7 shadow-lift">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Arrival pass</span>
                  <Badge variant="secondary">Example</Badge>
                </div>

                <div className="mt-6 flex flex-col items-center">
                  <div className="rounded-xl bg-white p-4 ring-1 ring-border">
                    <QRCodeSVG
                      value="https://thebeauty-alley.app/scan"
                      size={168}
                      bgColor="#ffffff"
                      fgColor="#1B4D3E"
                      level="M"
                    />
                  </div>
                  <p className="mt-4 text-center text-[12px] text-muted-foreground">
                    Every booking gets its own pass. This one is a sample.
                  </p>
                </div>

                <dl className="mt-7 space-y-3.5 border-t border-border/70 pt-6 text-[13px]">
                  {[
                    ["Where", "118 Alameda Row, Suite 4"],
                    ["Book at", "/book"],
                    ["Bring", "This pass, on your phone"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium text-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-7 flex items-center gap-2.5 rounded-lg bg-alley-50 px-3.5 py-3 text-[12px] text-alley-700">
                  <ShieldCheck className="size-4 shrink-0" />
                  Passes are signed, single-use, and redeemed by the desk only.
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* --------------------------------------------------- closing band */}
      <section className="relative overflow-hidden bg-alley-900 text-primary-foreground">
        <AlleySprig className="pointer-events-none absolute -right-16 top-1/2 h-[420px] w-[320px] -translate-y-1/2 text-white/[0.05]" />
        <div className="container relative flex flex-wrap items-center justify-between gap-8 py-20">
          <div className="max-w-2xl">
            <AlleyBadge className="mb-7 h-20 w-20 text-champagne-300" showText={false} />
            <h2 className="font-display text-[clamp(2rem,4.6vw,3.2rem)] font-medium leading-[1.05] tracking-tight text-balance">
              Your chair is waiting.
            </h2>
            <p className="mt-4 max-w-lg text-[14.5px] leading-relaxed text-primary-foreground/65">
              Book in under a minute — or browse the full menu first.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg" variant="champagne" className="h-12">
              <Link to="/book">
                Book an appointment
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 border-white/20 text-primary-foreground hover:border-white/40 hover:bg-white/10"
            >
              <Link to="/services">Explore services</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- footer */}
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
              A downtown atelier for hair, skin, nails and body — run on one quietly
              exact system.
            </p>
            <p className="mt-5 inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <MapPin className="size-3.5" />
              118 Alameda Row, Suite 4 · Open 9:00 – 19:00
            </p>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Visit
            </h3>
            <ul className="mt-4 space-y-2.5 text-[13px]">
              <li>
                <Link to="/book" className="text-foreground/75 transition-colors hover:text-primary">
                  Book an appointment
                </Link>
              </li>
              <li>
                <Link to="/services" className="text-foreground/75 transition-colors hover:text-primary">
                  Services & pricing
                </Link>
              </li>
              <li>
                <Link to="/scan" className="text-foreground/75 transition-colors hover:text-primary">
                  QR check-in
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
