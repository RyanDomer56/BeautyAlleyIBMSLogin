"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Reveals its children once they scroll into view. Respects reduced-motion by
 * rendering everything immediately.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: React.ElementType;
}) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        // The arbitrary `duration-…` shorthand is ambiguous in Tailwind 3.4 (it
        // matches both transition-duration and animation-duration), and Tailwind
        // resolves that ambiguity by emitting nothing at all, so the reveal ran
        // at the 150ms default instead of 900ms. The explicit property form is
        // unambiguous. Note the class name is deliberately not spelled out here:
        // Tailwind scans raw file text, so writing it in a comment would make the
        // scanner pick it up again and re-emit the warning.
        "transition-[opacity,transform] [transition-duration:900ms] ease-out-quart",
        shown ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export default Reveal;
