import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The Beauty Alley brand marks.
 *
 * These are hand-built SVG interpretations of the salon's badge — a circular
 * seal, a high-contrast "BA" monogram and botanical line-art. They inherit
 * `currentColor`, so they read on ivory, emerald or photography.
 */

/* ------------------------------------------------------------------ *
 * Full circular badge — ring, curved wordmark, monogram.
 * ------------------------------------------------------------------ */

export function AlleyBadge({
  className,
  showText = true,
  ...props
}: React.SVGProps<SVGSVGElement> & { showText?: boolean }) {
  return (
    <svg
      viewBox="0 0 200 200"
      role="img"
      aria-label="The Beauty Alley"
      className={cn("h-24 w-24", className)}
      {...props}
    >
      <defs>
        <path id="alley-arc-bottom" d="M 16,100 A 84,84 0 0 0 184,100" />
      </defs>

      <circle
        cx="100"
        cy="100"
        r="96"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <circle
        cx="100"
        cy="100"
        r="70"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.55"
      />

      {showText && (
        <text
          fill="currentColor"
          fontFamily='"Cormorant Garamond", Georgia, serif'
          fontSize="15.5"
          fontWeight={600}
          letterSpacing="3.6"
        >
          <textPath
            href="#alley-arc-bottom"
            startOffset="50%"
            textAnchor="middle"
          >
            THE BEAUTY ALLEY
          </textPath>
        </text>
      )}

      {/* Monogram — the A's apex leans into the B, as in the original. */}
      <g fill="currentColor" fontFamily='"Cormorant Garamond", Georgia, serif'>
        <text x="74" y="122" fontSize="68" fontWeight={600} textAnchor="middle">
          B
        </text>
        <text
          x="116"
          y="130"
          fontSize="68"
          fontWeight={600}
          textAnchor="middle"
          opacity="0.98"
        >
          A
        </text>
      </g>

      {/* Botanical sprig — a quiet echo of the logo's flower. */}
      <g
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        opacity="0.85"
      >
        <path d="M100 46 C 92 54, 88 62, 88 70" />
        <path d="M100 46 C 108 54, 112 62, 112 70" />
        <path d="M88 70 C 94 74, 106 74, 112 70" />
        <path d="M100 40 C 100 46, 100 50, 100 56" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Compact monogram — for navigation and avatars.
 * ------------------------------------------------------------------ */

export function AlleyMark({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="The Beauty Alley monogram"
      className={cn("h-9 w-9", className)}
      {...props}
    >
      <circle cx="32" cy="32" r="31" fill="currentColor" opacity="0.1" />
      <circle
        cx="32"
        cy="32"
        r="30"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.6"
      />
      <g fill="currentColor" fontFamily='"Cormorant Garamond", Georgia, serif'>
        <text x="24" y="42" fontSize="27" fontWeight={600} textAnchor="middle">
          B
        </text>
        <text x="40" y="45" fontSize="27" fontWeight={600} textAnchor="middle">
          A
        </text>
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Wordmark — monogram + name, for headers and footers.
 * ------------------------------------------------------------------ */

export function LogoLockup({
  className,
  tone = "dark",
  compact = false,
}: {
  className?: string;
  tone?: "dark" | "light";
  compact?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <AlleyMark
        className={cn(
          compact ? "h-9 w-9" : "h-11 w-11",
          tone === "light" ? "text-primary-foreground" : "text-primary",
        )}
      />
      <span className="flex flex-col leading-none">
        <span
          className={cn(
            "font-display font-semibold tracking-tight",
            compact ? "text-lg" : "text-xl",
            tone === "light" ? "text-primary-foreground" : "text-foreground",
          )}
        >
          The Beauty Alley
        </span>
        {!compact && (
          <span
            className={cn(
              "mt-1 text-[10px] font-semibold uppercase tracking-[0.28em]",
              tone === "light"
                ? "text-primary-foreground/55"
                : "text-muted-foreground",
            )}
          >
            Salon Operating System
          </span>
        )}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Botanical flourish — used as a watermark and section divider.
 * ------------------------------------------------------------------ */

export function AlleySprig({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 240 320"
      aria-hidden="true"
      className={cn("h-64 w-48", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      {...props}
    >
      {/* stem */}
      <path d="M120 318 C 118 250, 108 200, 96 150 C 88 116, 84 84, 92 52" />
      {/* leaves along the stem */}
      <path d="M112 250 C 88 244, 66 228, 58 206 C 84 206, 106 220, 114 240" />
      <path d="M108 214 C 132 208, 156 192, 164 168 C 138 170, 116 186, 106 206" />
      <path d="M100 176 C 78 168, 60 150, 56 128 C 80 132, 98 148, 104 166" />
      <path d="M96 140 C 118 132, 138 116, 144 94 C 120 98, 102 112, 94 132" />
      {/* bloom */}
      <path d="M92 52 C 76 44, 66 28, 68 12 C 84 16, 94 32, 92 52 Z" />
      <path d="M92 52 C 104 40, 122 36, 136 42 C 126 56, 108 62, 92 52 Z" />
      <path d="M92 52 C 78 62, 60 64, 48 56 C 58 42, 78 40, 92 52 Z" />
      <path d="M92 52 C 96 34, 108 20, 124 16 C 124 34, 110 48, 92 52 Z" />
      <circle cx="92" cy="52" r="6" />
      {/* buds */}
      <path d="M120 300 C 138 296, 152 284, 156 268" />
      <circle cx="158" cy="264" r="5" />
      <path d="M132 296 C 150 296, 166 290, 176 278" />
      <circle cx="178" cy="274" r="4" />
    </svg>
  );
}

export default AlleyBadge;
