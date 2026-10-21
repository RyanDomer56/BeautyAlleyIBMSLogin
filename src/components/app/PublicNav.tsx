"use client";

/**
 * The public navigation, defined once and shared by both public headers.
 *
 * The visitor-facing menu is exactly three destinations — Home, Scan & Check In
 * and Services. Staff sign-in is not one of them, and not anywhere else on the
 * public site either: the console is published on its own origin (see
 * `lib/console.ts`), so this site has no staff door to offer.
 *
 * Both headers are dark (the Landing header is transparent over its hero and
 * turns to `alley-900` on scroll; `PublicShell` is `alley-900` throughout), so
 * one light-on-dark treatment serves both without a tone prop.
 */

import * as React from "react";
import { NavLink } from "react-router-dom";
import { Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export interface PublicNavItem {
  to: string;
  label: string;
  /** `end` keeps "/" from matching every route. */
  end?: boolean;
}

/** The three sections of the public site, in order. */
export const PUBLIC_NAV: PublicNavItem[] = [
  { to: "/", label: "Home", end: true },
  { to: "/scan", label: "Scan & Check In" },
  { to: "/services", label: "Services" },
];

/** Inline links for wide screens, with the active section highlighted. */
export function PublicNavLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Main" className={cn("items-center gap-1", className)}>
      {PUBLIC_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "rounded-full px-3.5 py-2 text-[13px] transition-colors",
              isActive
                ? "bg-white/10 text-primary-foreground"
                : "text-primary-foreground/65 hover:bg-white/[0.06] hover:text-primary-foreground",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The small-screen menu. A hamburger that slides a sheet in from the right, so
 * the three sections stay reachable on phones and tablets where the inline
 * links are hidden. `triggerClassName` carries the breakpoint, because the two
 * headers reveal their inline nav at different widths.
 */
export function PublicMobileNav({ triggerClassName }: { triggerClassName?: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open navigation menu"
          className={cn(
            "inline-flex size-10 items-center justify-center rounded-full text-primary-foreground/80 transition-colors hover:bg-white/10 hover:text-primary-foreground",
            triggerClassName,
          )}
        >
          <Menu className="size-5" />
        </button>
      </SheetTrigger>

      <SheetContent side="right" className="w-[290px]">
        <SheetHeader>
          <SheetTitle className="font-display text-[20px]">Menu</SheetTitle>
        </SheetHeader>

        <nav aria-label="Main" className="mt-6 flex flex-col gap-1">
          {PUBLIC_NAV.map((item) => (
            <SheetClose asChild key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-lg px-4 py-3 text-[15px] transition-colors",
                    isActive
                      ? "bg-primary/[0.08] font-medium text-primary"
                      : "text-foreground/75 hover:bg-muted hover:text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            </SheetClose>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
