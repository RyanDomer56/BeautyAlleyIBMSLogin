"use client";

/**
 * A centred modal.
 *
 * The console already has `Sheet` (a Radix dialog in a side panel). This is
 * the same primitive, anchored in the middle of the screen, for the case the
 * sheet is wrong for: reading something. A treatment's full detail, a booking's
 * history — content the guest should be able to look at without the page
 * moving out from under them.
 *
 * Radix does the work that is easy to get wrong by hand: focus trapping, focus
 * restore on close, `Escape`, scroll locking, and `aria-modal` wiring. Nothing
 * here reimplements that.
 *
 * It is theme-agnostic on purpose — every colour is a token, so the same modal
 * is emerald on the public site and blush inside the console.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Modal = DialogPrimitive.Root;
const ModalTrigger = DialogPrimitive.Trigger;
const ModalClose = DialogPrimitive.Close;

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Rendered as the dialog's accessible name. */
    title: string;
    description?: string;
    /** Widen for content-heavy dialogs. */
    size?: "default" | "wide";
  }
>(({ className, children, title, description, size = "default", ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-foreground/45 backdrop-blur-[2px]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2",
        "overflow-y-auto rounded-2xl border border-border/80 bg-card shadow-lift",
        "scroll-slim",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        size === "wide" ? "max-w-3xl" : "max-w-xl",
        className,
      )}
      {...props}
    >
      {/*
        * The title is required and always rendered — a dialog with no
        * accessible name is announced as "dialog" and nothing else. It is
        * visually hidden only when the caller supplies its own heading.
      */}
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description className="sr-only">
          {description}
        </DialogPrimitive.Description>
      ) : null}

      <DialogPrimitive.Close
        aria-label="Close"
        className={cn(
          "absolute right-4 top-4 z-10 flex size-8 items-center justify-center rounded-full",
          "bg-card/85 text-muted-foreground backdrop-blur transition-colors",
          "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <X className="size-4" />
      </DialogPrimitive.Close>

      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
ModalContent.displayName = "ModalContent";

export { Modal, ModalTrigger, ModalClose, ModalContent };
