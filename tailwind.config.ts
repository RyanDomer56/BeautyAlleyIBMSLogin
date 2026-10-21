import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import containerQueries from "@tailwindcss/container-queries";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1320px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        /*
         * A functional colour, not a brand one: "this number went the right
         * way" has to read as green in either palette. It was previously
         * hard-coded to `alley-600`, which would have turned a good trend
         * rosewood inside the console.
         */
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          ring: "hsl(var(--sidebar-ring))",
        },
        /* Brand scale — The Beauty Alley emerald */
        alley: {
          50: "#F1F6F3",
          100: "#DCE9E3",
          200: "#B9D3C8",
          300: "#8FB6A7",
          400: "#5F9382",
          500: "#3D7663",
          600: "#2A5D4D",
          700: "#1B4D3E",
          800: "#143C31",
          900: "#0E2B23",
          950: "#071914",
        },
        /* Warm neutrals + champagne accent */
        sand: {
          50: "#FBF9F4",
          100: "#F5F1E7",
          200: "#EDE7D8",
          300: "#E1D8C3",
          400: "#CFC2A6",
        },
        champagne: {
          300: "#E2CDA3",
          400: "#D3B884",
          500: "#C2A167",
          600: "#A8874C",
        },
        clay: "#B4472F",
      },
      /*
       * Both families resolve through CSS variables declared in `index.css`.
       *
       * That indirection is the whole trick behind the console re-skin: adding
       * `.console` to `document.body` overrides `--font-display` to the UI sans,
       * so every `font-display` in the dashboards changes family at once. A
       * literal here would have meant editing 24 files by hand and missing some.
       */
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 8px)",
        xl: "calc(var(--radius) + 6px)",
        "2xl": "calc(var(--radius) + 14px)",
      },
      /*
       * Shadow tint follows the palette via `--shadow-color`, so a card lift is
       * emerald-tinted on the public site and warm-neutral in the console
       * without either one hard-coding a colour.
       */
      boxShadow: {
        soft: "0 1px 2px rgb(var(--shadow-color) / 0.05), 0 8px 24px -12px rgb(var(--shadow-color) / 0.16)",
        lift: "0 2px 4px rgb(var(--shadow-color) / 0.06), 0 24px 48px -20px rgb(var(--shadow-color) / 0.3)",
      },
      /*
       * `ease-out-quart` is used across the app (button, sheet, sidebar, progress,
       * landing, board, reveal) but was never defined here, so Tailwind silently
       * emitted nothing for it and every one of those transitions fell back to the
       * default `cubic-bezier(0.4, 0, 0.2, 1)`. The intended easing is the
       * standard easeOutQuart curve — fast out of the gate, long calm settle,
       * which is what makes the motion feel unhurried rather than snappy.
       */
      transitionTimingFunction: {
        "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slow-drift": {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(0,-2.5%,0) scale(1.04)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-up": "fade-up 0.7s cubic-bezier(0.16,1,0.3,1) both",
        "slow-drift": "slow-drift 16s ease-in-out infinite",
        shimmer: "shimmer 2.4s infinite",
      },
    },
  },
  plugins: [animate, containerQueries],
};

export default config;
