"use client";

/**
 * The public treatment catalogue.
 *
 * ## Where the categories come from
 *
 * Not from a list in this file. A service carries a `subcategory` row — "IV
 * Drips", "Beauty Shots", "Add-ons" — and the salon floor services simply have
 * none, which is what puts them in "Haircut & Salon Services". So a treatment
 * the salon adds tomorrow lands in the right group with no code change, and
 * there is exactly one place a price or a formulation lives: the database.
 *
 * ## Why the ingredients are shown the way they are
 *
 * The API sends `ingredients` *and* `ingredientsVerified`. A null formulation
 * with `ingredientsVerified: false` means the salon has not confirmed it — so
 * this page says exactly that. It does not invent a plausible list, and it does
 * not quietly omit the section either, because both of those would read as
 * "this is what's in it".
 *
 * ## Search and the filter
 *
 * Two endpoints, two capabilities: `/services/search` matches a term but has
 * no category parameter; `/services` filters by category but has no term. A
 * term goes to `search` and the group filter is applied here. The alternative —
 * fetching both and intersecting — answers one question with two round trips.
 */

import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Clock3,
  Info,
  Search,
  ShieldAlert,
  Sparkles,
  Syringe,
  X,
} from "lucide-react";

import { cn, minutesToLabel, peso } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";
import type { Service } from "@/lib/api-types";
import { serviceImage } from "@/lib/service-images";
import { Button, buttonVariants } from "@/components/ui/button";
import { Modal, ModalContent } from "@/components/ui/modal";
import { EmptyNote, ErrorNote, Loading, PersonAvatar } from "@/components/app/api-bits";
import { PageHead, PublicShell } from "@/components/app/PublicShell";

/* ------------------------------------------------------------------ *
 * The catalogue's shape
 * ------------------------------------------------------------------ */

/**
 * The four groups, in the order they are presented.
 *
 * `slug: null` is the salon floor — the services that carry no subcategory.
 * Anything the salon adds with a new slug still renders, under its own name
 * and sort order (see `groupServices`), so this list is a *preference*, not a
 * whitelist.
 */
const GROUPS: { slug: string | null; name: string; blurb: string; sortOrder: number }[] = [
  {
    slug: null,
    name: "Haircut & Salon Services",
    blurb: "Cuts, colour and styling on the salon floor.",
    sortOrder: 0,
  },
  {
    slug: "iv-drips",
    name: "IV Drips",
    blurb: "Intravenous vitamin therapy, administered by our nurse.",
    sortOrder: 10,
  },
  {
    slug: "beauty-shots",
    name: "Beauty Shots",
    blurb: "Targeted injectables, given after a consultation.",
    sortOrder: 20,
  },
  {
    slug: "add-ons",
    name: "Add-on Services",
    blurb: "Added to any drip or shot to round out the session.",
    sortOrder: 30,
  },
];

/** Groups whose treatments need a consultation before they are given. */
const CONSULTATION_SLUGS = new Set(["iv-drips", "beauty-shots"]);

function needsConsultation(service: Service) {
  return service.subcategory ? CONSULTATION_SLUGS.has(service.subcategory.slug) : false;
}

interface Group {
  slug: string | null;
  name: string;
  blurb: string;
  sortOrder: number;
  services: Service[];
}

/**
 * Bucket services into their groups, keeping the declared order and appending
 * any group the salon has created that this file does not know about.
 */
function groupServices(services: Service[]): Group[] {
  const buckets = new Map<string, Group>();

  for (const service of services) {
    const slug = service.subcategory?.slug ?? null;
    const key = slug ?? "__floor__";
    if (buckets.has(key)) {
      buckets.get(key)!.services.push(service);
      continue;
    }
    const declared = GROUPS.find((g) => g.slug === slug);
    buckets.set(key, {
      slug,
      name: declared?.name ?? service.subcategory?.name ?? "Other treatments",
      blurb: declared?.blurb ?? "",
      sortOrder: declared?.sortOrder ?? 99,
      services: [service],
    });
  }

  return [...buckets.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

function ServiceCard({ service, onDetails }: { service: Service; onDetails: () => void }) {
  const consult = needsConsultation(service);

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-soft transition-[box-shadow,transform,border-color] duration-500 ease-out-quart hover:-translate-y-1 hover:border-primary/25 hover:shadow-lift">
      <div className="relative aspect-[4/3] overflow-hidden bg-sand-100">
        <img
          src={serviceImage(service)}
          alt={service.name}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-700 ease-out-quart group-hover:scale-[1.04]"
        />
        {service.subcategory && (
          <span className="absolute left-3 top-3 rounded-full bg-card/90 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-foreground backdrop-blur">
            {service.subcategory.name}
          </span>
        )}
        {consult && (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-foreground/85 px-2.5 py-1 text-[10.5px] font-semibold text-background backdrop-blur">
            <Syringe className="size-3" />
            Consultation
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-6">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Clock3 className="size-3.5" />
            {minutesToLabel(service.durationMinutes)}
          </span>
        </div>

        <h3 className="mt-3 font-display text-[21px] font-semibold leading-tight tracking-tight">
          {service.name}
        </h3>
        {service.description && (
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            {service.description}
          </p>
        )}

        {/* Ingredients, only when the salon has confirmed them. */}
        {service.ingredientsVerified && service.ingredients ? (
          <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span>
              <span className="font-medium text-foreground">Contains: </span>
              {service.ingredients}
            </span>
          </p>
        ) : service.subcategory ? (
          <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>Formulation being confirmed — ask us before booking.</span>
          </p>
        ) : null}

        <div className="mt-auto flex items-end justify-between gap-3 pt-6">
          <span className="font-display text-[25px] font-semibold tracking-tight text-primary">
            {peso(service.priceCents)}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {/*
             * Lifted above the overlay link so it stays a real, separate
             * target. `z-[2]` is the whole reason this works: without it the
             * overlay would swallow the click and "Details" would book instead
             * of explaining.
             */}
            <Button
              variant="ghost"
              size="sm"
              className="relative z-[2]"
              onClick={onDetails}
            >
              Details
            </Button>
            {/*
             * Visual only. The card-wide link below is the actual target, so
             * this is not a second thing competing for the same tap - it just
             * tells you what tapping the card will do.
             */}
            <span
              aria-hidden
              className={cn(buttonVariants({ size: "sm" }), "pointer-events-none")}
            >
              Book
              <ArrowRight className="size-3.5" />
            </span>
          </div>
        </div>
      </div>

      {/*
       * The whole card is the selection target. One tap anywhere books the
       * treatment; no aiming at a 32px-tall button on a phone. The accessible
       * name lives in the sr-only span so the link is not announced as "Book"
       * eight times in a row.
       */}
      <Link
        to={`/book?service=${service.id}`}
        className="absolute inset-0 z-[1] rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="sr-only">Book {service.name}</span>
      </Link>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * The detail modal
 * ------------------------------------------------------------------ */

function ServiceDetail({
  service,
  onClose,
}: {
  service: Service | null;
  onClose: () => void;
}) {
  const consult = service ? needsConsultation(service) : false;

  return (
    <Modal open={Boolean(service)} onOpenChange={(open) => !open && onClose()}>
      {service && (
        <ModalContent
          title={service.name}
          description={service.description ?? undefined}
          size="wide"
          className="p-0"
        >
          <div className="aspect-[16/9] w-full overflow-hidden bg-sand-100">
            <img
              src={serviceImage(service)}
              alt={service.name}
              className="h-full w-full object-cover"
            />
          </div>

          <div className="p-7 sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              {service.subcategory ? (
                <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {service.subcategory.name}
                </span>
              ) : (
                <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Salon floor
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Clock3 className="size-3.5" />
                {minutesToLabel(service.durationMinutes)}
              </span>
            </div>

            <h2 className="mt-4 font-display text-[clamp(1.5rem,2.6vw,2rem)] font-medium leading-tight tracking-tight">
              {service.name}
            </h2>
            {service.description && (
              <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-muted-foreground text-pretty">
                {service.description}
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-baseline gap-3">
              <span className="font-display text-[32px] font-semibold leading-none tracking-tight text-primary">
                {peso(service.priceCents)}
              </span>
              <span className="text-[12.5px] text-muted-foreground">
                {minutesToLabel(service.durationMinutes)} in the chair
              </span>
            </div>

            {/* --- formulation ------------------------------------------ */}
            <section className="mt-7 border-t border-border/70 pt-6">
              <h3 className="eyebrow">What's in it</h3>
              {service.ingredientsVerified && service.ingredients ? (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {service.ingredients.split(",").map((part) => (
                    <li
                      key={part}
                      className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/[0.07] px-3 py-1.5 text-[12.5px] text-foreground"
                    >
                      <Check className="size-3.5 text-success" />
                      {part.trim()}
                    </li>
                  ))}
                </ul>
              ) : service.subcategory ? (
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-accent/40 bg-accent/[0.09] px-4 py-3 text-[12.5px] leading-relaxed text-accent-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <span>
                    We are still confirming this formulation with the supplier, so we have not
                    published an ingredient list. Ask at the desk before booking and we will give
                    you the current product information.
                  </span>
                </p>
              ) : (
                <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
                  This is a salon service — ask your stylist about the products used.
                </p>
              )}
            </section>

            {/* --- eligibility ------------------------------------------ */}
            {consult && (
              <section className="mt-7 border-t border-border/70 pt-6">
                <h3 className="eyebrow">Before you book</h3>
                <div className="mt-3 flex items-start gap-3 rounded-xl border border-border/80 bg-muted/40 px-4 py-4">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 space-y-2 text-[12.5px] leading-relaxed text-muted-foreground">
                    <p>
                      This is an injectable treatment. It is given by our nurse only after a short
                      consultation, and it is <span className="font-medium text-foreground">not suitable for everyone</span>.
                    </p>
                    <ul className="space-y-1.5">
                      <li>
                        Tell us about any medication, allergy, pregnancy or breastfeeding, and any
                        kidney, liver or heart condition — some of these mean we will not treat you.
                      </li>
                      <li>
                        The consultation is free and carries no obligation. If it is not right for
                        you, we will say so and suggest something else.
                      </li>
                      <li>
                        Prices shown are for the treatment itself. Your nurse will confirm the plan,
                        the number of sessions and the total cost before anything begins.
                      </li>
                    </ul>
                    <p className="text-[12px]">
                      Nothing on this page is medical advice. If you are unsure, speak to your
                      doctor first.
                    </p>
                  </div>
                </div>
              </section>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-2.5 border-t border-border/70 pt-6">
              <Button asChild size="lg" className="h-11">
                <Link to={`/book?service=${service.id}`}>
                  Book this treatment
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </ModalContent>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

/** Keeps a keystroke from spending a request. */
function useDebounced<T>(value: T, ms = 280) {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function Services() {
  const [params, setParams] = useSearchParams();

  const [group, setGroup] = React.useState<string>(params.get("group") ?? "ALL");
  const [term, setTerm] = React.useState(params.get("q") ?? "");
  const [detail, setDetail] = React.useState<Service | null>(null);
  const q = useDebounced(term);

  /*
   * Search hits everything, then the group filter is applied here — see the
   * note at the top of the file. The category parameter the API understands is
   * the coarse SPA/SALON/WELLNESS one, which is not the grouping this page
   * shows, so it is not used.
   */
  const services = useAsync(`catalogue:${q}`, async () => {
    const needle = q.trim();
    if (needle) return api.services.search(needle, 60);
    return (await api.services.list({ limit: 100 })).data;
  });

  const team = useAsync("catalogue:team", async () => (await api.employees.list({ limit: 50 })).data);

  const all = services.data ?? [];
  const groups = groupServices(all);
  const visible = group === "ALL" ? groups : groups.filter((g) => (g.slug ?? "salon") === group);
  const count = visible.reduce((n, g) => n + g.services.length, 0);

  /*
   * Chips are built from the groups that actually hold treatments, not from
   * the GROUPS list - a category with nothing in it is a filter that can only
   * disappoint. The selected chip survives even when the current search empties
   * it, because otherwise the control that explains the empty grid disappears
   * along with the results.
   *
   * The counts are the point: you can see where the treatments are before you
   * click, instead of narrowing to an empty grid and narrowing back.
   */
  const filters: { slug: string; name: string; count: number }[] = [
    { slug: "ALL", name: "Everything", count: all.length },
    ...groups.map((g) => ({ slug: g.slug ?? "salon", name: g.name, count: g.services.length })),
  ];
  if (group !== "ALL" && !filters.some((f) => f.slug === group)) {
    const declared = GROUPS.find((g) => (g.slug ?? "salon") === group);
    filters.push({ slug: group, name: declared?.name ?? "Selected", count: 0 });
  }

  // Keep the URL shareable, as the old page did.
  React.useEffect(() => {
    const next = new URLSearchParams();
    if (q.trim()) next.set("q", q.trim());
    if (group !== "ALL") next.set("group", group);
    setParams(next, { replace: true });
  }, [q, group, setParams]);

  return (
    <PublicShell>
      <PageHead
        eyebrow="The Menu"
        title={
          <>
            Treatments, drips and shots —
            <span className="italic text-champagne-300"> priced plainly.</span>
          </>
        }
        lede="Search the full catalogue, or narrow it to one kind of treatment. Prices are final; no surprises at the desk."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-primary-foreground/50" />
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Drip, shot, collagen, haircut…"
              aria-label="Search treatments"
              className="h-12 w-full rounded-full border border-white/20 bg-white/[0.07] pl-11 pr-11 text-[14px] text-primary-foreground outline-none transition-colors placeholder:text-primary-foreground/45 focus:border-champagne-400/60 focus:bg-white/[0.1]"
            />
            {term && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setTerm("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-primary-foreground/60 transition-colors hover:bg-white/10 hover:text-primary-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {filters.map((option) => (
              <button
                key={option.slug}
                type="button"
                onClick={() => setGroup(option.slug)}
                aria-pressed={group === option.slug}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-[12.5px] font-medium transition-colors",
                  group === option.slug
                    ? "border-champagne-400 bg-champagne-400 text-accent-foreground"
                    : "border-white/20 text-primary-foreground/70 hover:border-white/40 hover:text-primary-foreground",
                )}
              >
                {option.name}
                <span
                  className={cn(
                    "tabular-nums",
                    group === option.slug
                      ? "text-accent-foreground/55"
                      : "text-primary-foreground/40",
                  )}
                >
                  {option.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </PageHead>

      <section className="container py-14">
        {services.error ? (
          <ErrorNote error={services.error} onRetry={services.reload} />
        ) : services.initial ? (
          <Loading label="Fetching the catalogue…" />
        ) : count > 0 ? (
          <>
            <p className="mb-8 text-[12.5px] text-muted-foreground">
              {count} treatment{count === 1 ? "" : "s"}
              {q.trim() && (
                <>
                  {" "}
                  matching <span className="text-foreground">“{q.trim()}”</span>
                </>
              )}
            </p>

            <div className="space-y-14">
              {visible.map((g) => (
                <div key={g.slug ?? "__floor__"}>
                  <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-border/70 pb-4">
                    <div className="min-w-0">
                      <h2 className="font-display text-[clamp(1.3rem,2.4vw,1.75rem)] font-medium leading-tight tracking-tight">
                        {g.name}
                      </h2>
                      {g.blurb && (
                        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                          {g.blurb}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {g.services.length} treatment{g.services.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {g.services.map((service) => (
                      <ServiceCard
                        key={service.id}
                        service={service}
                        onDetails={() => setDetail(service)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyNote
            icon={Search}
            title="Nothing matches that"
            description={
              q.trim()
                ? `No treatment matches “${q.trim()}”. Try a shorter word, or clear the filters.`
                : "The catalogue is empty for this filter."
            }
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setTerm("");
                  setGroup("ALL");
                }}
              >
                Clear filters
              </Button>
            }
          />
        )}
      </section>

      {/* ------------------------------------------------------------ team */}
      <section className="border-t border-border/70 bg-sand-50">
        <div className="container py-14">
          <p className="eyebrow">The floor</p>
          <h2 className="mt-3 font-display text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-tight tracking-tight">
            Who will be looking after you.
          </h2>

          {team.error ? (
            <ErrorNote error={team.error} onRetry={team.reload} className="mt-8" />
          ) : team.initial ? (
            <Loading label="Fetching the team…" className="mt-8" />
          ) : team.data && team.data.length > 0 ? (
            <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {team.data.map((person) => (
                <div
                  key={person.id}
                  className="flex items-start gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-soft"
                >
                  <PersonAvatar name={person.fullName} className="size-11 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-display text-[17px] font-semibold leading-tight tracking-tight">
                      {person.fullName}
                    </p>
                    {person.title && (
                      <p className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] text-primary">
                        <Sparkles className="size-3" />
                        {person.title}
                      </p>
                    )}
                    {person.bio && (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                        {person.bio}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote
              icon={Sparkles}
              title="No one on the roster yet"
              description="The team list is empty in the database."
              className="mt-8"
            />
          )}
        </div>
      </section>

      <section className="container py-14">
        <div className="flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-border/80 bg-card px-8 py-9 shadow-soft">
          <div className="max-w-lg">
            <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-medium leading-tight tracking-tight">
              Found something you like?
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              Pick a time and we'll hold the chair. You'll get an arrival pass
              straight away — no account needed.
            </p>
          </div>
          <Button asChild size="lg" className="h-12">
            <Link to="/book">
              Book an appointment
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      <ServiceDetail service={detail} onClose={() => setDetail(null)} />
    </PublicShell>
  );
}
