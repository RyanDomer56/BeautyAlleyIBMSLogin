"use client";

/**
 * Draggable Widget Grid
 *
 * A grid of widgets that can be rearranged by dragging. The layout is a
 * sequence plus a size per widget; an exact tiler turns the sequence into a
 * gap-free rectangle at any column count, and Motion animates every change.
 *
 * - Mouse and pen drag immediately. Touch uses a long press, so the page can
 *   still be scrolled.
 * - Keyboard: focus a widget, hold Alt and use the arrow keys.
 * - Styling uses theme tokens (`bg-card`, `ring-border`, `text-foreground`),
 *   so it follows light and dark themes.
 */

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { MotionConfig, motion, useDragControls } from "motion/react";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface WidgetItem {
  /** Stable, unique id. */
  id: string;
  /** Column span, clamped to the grid's column count. */
  w: number;
  /** Row span. */
  h: number;
  /** Accessible name for the widget. */
  label?: string;
}

export interface DraggableWidgetGridProps {
  /** Initial arrangement. The grid manages the order after mount. */
  items?: WidgetItem[];
  /** Called with the new order after a drop or a keyboard move. */
  onChange?: (items: WidgetItem[]) => void;
  /** Renders a widget's content. */
  renderItem?: (item: WidgetItem) => ReactNode;
  /** Enables dragging, keyboard moves and corner-handle resizing. */
  editable?: boolean;
  /** Allows the corner handle (and keyboard chord) to change a widget's span. */
  resizable?: boolean;
  /** Upper bound for the number of columns. */
  maxColumns?: number;
  /** Upper bound for a widget's row span when resizing. */
  maxRows?: number;
  /** Target cell width in px; the column count is derived from it. */
  cellSize?: number;
  /** Gap between widgets in px. */
  gap?: number;
  /** Corner radius of a widget in px. */
  radius?: number;
  className?: string;
}

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A human word for a span, used only for the accessible fallback label. */
function sizeLabel(w: number, h: number): string {
  if (w >= 2 && h >= 2) return "Large";
  if (w >= 2) return "Wide";
  if (h >= 2) return "Tall";
  return "Small";
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

interface Placement {
  id: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

interface Box {
  col: number;
  row: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) =>
  a.col < b.col + b.w &&
  b.col < a.col + a.w &&
  a.row < b.row + b.h &&
  b.row < a.row + a.h;

const contains = (outer: Box, inner: Box) =>
  inner.col >= outer.col &&
  inner.row >= outer.row &&
  inner.col + inner.w <= outer.col + outer.w &&
  inner.row + inner.h <= outer.row + outer.h;

function spanOf(item: WidgetItem, columns: number) {
  return {
    w: Math.max(1, Math.min(Math.floor(item.w) || 1, columns)),
    h: Math.max(1, Math.floor(item.h) || 1),
  };
}

function layout(items: WidgetItem[], columns: number): Placement[] {
  if (columns < 1 || items.length === 0) return [];
  return tile(items, columns) ?? pack(items, columns);
}

const TILING_BUDGET = 20000;

function tile(items: WidgetItem[], columns: number): Placement[] | null {
  const spans = items.map((item) => spanOf(item, columns));
  const area = spans.reduce((n, s) => n + s.w * s.h, 0);
  const rows = Math.ceil(area / columns);
  const grid: boolean[] = new Array(rows * columns).fill(false);
  const used: boolean[] = new Array(items.length).fill(false);
  const out: Placement[] = [];
  let budget = TILING_BUDGET;

  const fits = (w: number, h: number, r: number, c: number) => {
    if (c + w > columns || r + h > rows) return false;
    for (let y = r; y < r + h; y++)
      for (let x = c; x < c + w; x++) if (grid[y * columns + x]) return false;
    return true;
  };
  const mark = (w: number, h: number, r: number, c: number, v: boolean) => {
    for (let y = r; y < r + h; y++)
      for (let x = c; x < c + w; x++) grid[y * columns + x] = v;
  };

  const place = (count: number): boolean => {
    if (count === items.length) return true;
    if (--budget < 0) return false;
    const i = grid.indexOf(false);
    if (i < 0) return false;
    const r = Math.floor(i / columns);
    const c = i % columns;
    const tried = new Set<string>();
    for (let k = 0; k < items.length; k++) {
      if (used[k]) continue;
      const { w, h } = spans[k];
      const shape = `${w}x${h}`;
      if (tried.has(shape) || !fits(w, h, r, c)) continue;
      tried.add(shape);
      used[k] = true;
      mark(w, h, r, c, true);
      out.push({ id: items[k].id, col: c, row: r, w, h });
      if (place(count + 1)) return true;
      out.pop();
      mark(w, h, r, c, false);
      used[k] = false;
    }
    return false;
  };

  return place(0) ? out : null;
}

function pack(items: WidgetItem[], columns: number): Placement[] {
  const out: Placement[] = [];
  let row = 0;
  let queue = items.map((item) => ({ id: item.id, ...spanOf(item, columns) }));

  while (queue.length > 0) {
    const height = Math.max(...queue.slice(0, columns).map((q) => q.h));
    const cells: boolean[] = new Array(height * columns).fill(false);
    const band: Placement[] = [];
    const rest: typeof queue = [];

    for (const q of queue) {
      let spot = -1;
      for (let i = 0; i < cells.length && spot < 0; i++) {
        const r = Math.floor(i / columns);
        const c = i % columns;
        if (c + q.w > columns || r + q.h > height) continue;
        let free = true;
        for (let y = r; y < r + q.h && free; y++)
          for (let x = c; x < c + q.w && free; x++)
            if (cells[y * columns + x]) free = false;
        if (free) spot = i;
      }
      if (spot < 0 || rest.length > 0) {
        rest.push(q);
        continue;
      }
      const r = Math.floor(spot / columns);
      const c = spot % columns;
      for (let y = r; y < r + q.h; y++)
        for (let x = c; x < c + q.w; x++) cells[y * columns + x] = true;
      band.push({ id: q.id, col: c, row: r, w: q.w, h: q.h });
    }

    for (let i = 0; i < cells.length; i++) {
      if (cells[i]) continue;
      const r = Math.floor(i / columns);
      const c = i % columns;
      const left = band.find(
        (p) => p.col + p.w === c && p.row <= r && p.row + p.h > r && p.h === 1,
      );
      const above = band.find(
        (p) => p.row + p.h === r && p.col === c && p.w === 1,
      );
      const grow = left ?? above;
      if (!grow) continue;
      if (grow === left) grow.w += 1;
      else grow.h += 1;
      cells[i] = true;
    }

    out.push(...band.map((p) => ({ ...p, row: p.row + row })));
    row += height;
    queue = rest;
  }
  return out;
}

function canonical(items: WidgetItem[], columns: number): WidgetItem[] {
  const places = layout(items, columns);
  if (places.length !== items.length) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const sorted = [...places]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((p) => byId.get(p.id) as WidgetItem);
  if (sorted.every((item, i) => item === items[i])) return items;
  const at = new Map(places.map((p) => [p.id, p]));
  const same = layout(sorted, columns).every((p) => {
    const q = at.get(p.id);
    return q && q.col === p.col && q.row === p.row && q.w === p.w && q.h === p.h;
  });
  return same ? sorted : items;
}

function moveTo(items: WidgetItem[], id: string, index: number) {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0 || from === index || index < 0 || index >= items.length)
    return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(index, 0, moved);
  return next;
}

const sameOrder = (a: WidgetItem[], b: WidgetItem[]) =>
  a.length === b.length && a.every((item, i) => item.id === b[i].id);

/** The tile nearest to `id` in a direction, judged by grid-centre distance. */
function neighborOf(
  places: Placement[],
  id: string,
  dir: [number, number],
): string | null {
  const me = places.find((p) => p.id === id);
  if (!me) return null;
  const cx = me.col + me.w / 2;
  const cy = me.row + me.h / 2;
  const [dx, dy] = dir;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const p of places) {
    if (p.id === id) continue;
    const px = p.col + p.w / 2;
    const py = p.row + p.h / 2;
    const along = (px - cx) * dx + (py - cy) * dy;
    if (along <= 0.001) continue;
    const perp = Math.abs((px - cx) * -dy + (py - cy) * dx);
    const score = along + perp * 1.5;
    if (score < bestScore) {
      bestScore = score;
      best = p.id;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Drop target selection
 * ------------------------------------------------------------------ */

interface Slot {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Candidate {
  order: WidgetItem[];
  slot: Slot;
}

const ENTER = 0.18;

function choose(
  home: Slot,
  candidates: Candidate[],
  cx: number,
  cy: number,
): WidgetItem[] | null {
  const distance = (s: Slot, inset: number) => {
    const ix = (s.right - s.left) * inset;
    const iy = (s.bottom - s.top) * inset;
    const dx = Math.max(s.left + ix - cx, 0, cx - (s.right - ix));
    const dy = Math.max(s.top + iy - cy, 0, cy - (s.bottom - iy));
    return Math.hypot(dx, dy);
  };
  const toCentre = (s: Slot) =>
    Math.hypot((s.left + s.right) / 2 - cx, (s.top + s.bottom) / 2 - cy);

  let best = distance(home, 0);
  if (best === 0) return null;
  let pick: WidgetItem[] | null = null;
  let bestCentre = Infinity;
  for (const { order, slot } of candidates) {
    const d = distance(slot, ENTER);
    const c = toCentre(slot);
    if (d < best || (d === best && pick && c < bestCentre)) {
      best = d;
      bestCentre = c;
      pick = order;
    }
  }
  return pick;
}

function candidatesFor(
  items: WidgetItem[],
  id: string,
  columns: number,
  toSlot: (box: Box) => Slot,
): Candidate[] {
  const places = layout(items, columns);
  const me = places.find((p) => p.id === id);
  if (!me) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows = Math.max(...places.map((p) => p.row + p.h));
  const out: Candidate[] = [];

  for (let row = 0; row + me.h <= rows; row++) {
    for (let col = 0; col + me.w <= columns; col++) {
      const area = { col, row, w: me.w, h: me.h };
      if (overlaps(area, me)) continue;
      const group = places.filter((p) => overlaps(p, area));
      if (group.length < 2 || !group.every((p) => contains(area, p))) continue;
      const moved = places.map((p) =>
        p.id === id
          ? { ...p, col, row }
          : group.includes(p)
            ? { ...p, col: p.col - col + me.col, row: p.row - row + me.row }
            : p,
      );
      moved.sort((a, b) => a.row - b.row || a.col - b.col);
      out.push({
        order: moved.map((p) => byId.get(p.id) as WidgetItem),
        slot: toSlot(area),
      });
    }
  }

  const from = items.findIndex((item) => item.id === id);
  for (let i = 0; i < items.length; i++) {
    if (i === from) continue;
    const order = moveTo(items, id, i);
    const p = layout(order, columns).find((q) => q.id === id);
    if (p) out.push({ order, slot: toSlot(p) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

const SPRING = { type: "spring", visualDuration: 0.38, bounce: 0.16 } as const;
const LIFT = { type: "spring", visualDuration: 0.26, bounce: 0.32 } as const;
const LIFT_SCALE = 1.05;
const SETTLE_MS = 40;
const LANDED_MS = 620;
const LONG_PRESS_MS = 350;
const PRESS_SLOP = 8;
const SHADOW_REST =
  "0px 1px 2px 0px rgba(14,43,35,0.10), 0px 0px 0px 0px rgba(14,43,35,0)";
const SHADOW_LIFTED =
  "0px 28px 60px -16px rgba(14,43,35,0.38), 0px 10px 24px -8px rgba(14,43,35,0.24)";

/* ------------------------------------------------------------------ *
 * Widget
 * ------------------------------------------------------------------ */

interface Press {
  timer: number;
  pointerId: number;
  x: number;
  y: number;
}

type Phase = "idle" | "holding" | "lifted";

interface WidgetHandlers {
  start: (id: string) => void;
  drag: () => void;
  end: (id: string) => void;
  resizeStart: (id: string, x: number, y: number) => void;
  select: (id: string) => void;
  key: (e: ReactKeyboardEvent, id: string) => void;
  swallow: () => boolean;
  suppressClick: () => void;
}

const Widget = memo(function Widget({
  item,
  col,
  row,
  w,
  h,
  pxSize,
  columns,
  rows,
  editable,
  resizable,
  resizing,
  selected,
  sizeTransition,
  held,
  raised,
  landed,
  handlers,
  hintId,
  position,
  count,
  renderItem,
}: {
  item: WidgetItem;
  col: number;
  row: number;
  w: number;
  h: number;
  /** Exact pixel size to render at during a live resize (overrides the grid cell). */
  pxSize?: { w: number; h: number };
  columns: number;
  rows: number;
  editable: boolean;
  resizable: boolean;
  resizing: boolean;
  selected: boolean;
  /** Whether the explicit size should transition (keyboard resize animation). */
  sizeTransition: boolean;
  held: boolean;
  raised: boolean;
  landed: boolean;
  handlers: WidgetHandlers;
  hintId: string;
  position: number;
  count: number;
  renderItem?: (item: WidgetItem) => ReactNode;
}) {
  const controls = useDragControls();
  const node = useRef<HTMLDivElement | null>(null);
  const press = useRef<Press | null>(null);
  const lifted = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  const release = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    lifted.current = false;
    cleanup.current?.();
    cleanup.current = null;
    setPhase("idle");
  }, []);

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (lifted.current) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => {
      el.removeEventListener("touchmove", block);
      if (press.current) window.clearTimeout(press.current.timer);
      cleanup.current?.();
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!editable || e.button !== 0 || !e.isPrimary) return;
    handlers.select(item.id);
    // The resize handle owns its own gesture; never let it start a drag.
    if ((e.target as HTMLElement).closest("[data-resize-handle]")) return;
    if (e.pointerType !== "touch") {
      controls.start(e);
      return;
    }
    if (press.current || lifted.current) return;
    const origin = e.nativeEvent;
    const pointerId = e.pointerId;
    setPhase("holding");
    press.current = {
      pointerId,
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        lifted.current = true;
        setPhase("lifted");
        navigator.vibrate?.(10);
        controls.start(origin);
        const done = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          handlers.suppressClick();
          release();
        };
        window.addEventListener("pointerup", done);
        window.addEventListener("pointercancel", done);
        cleanup.current = () => {
          window.removeEventListener("pointerup", done);
          window.removeEventListener("pointercancel", done);
        };
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (
      p &&
      e.pointerId === p.pointerId &&
      Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP
    )
      release();
  };

  const onPointerEnd = (e: ReactPointerEvent) => {
    if (press.current?.pointerId === e.pointerId) release();
  };

  const delay = (col / Math.max(columns, 1) + row / Math.max(rows, 1)) * 0.26;

  return (
    <motion.div
      ref={node}
      role="listitem"
      data-slot="widget"
      data-widget-id={item.id}
      data-selected={selected || undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={item.label ?? `${sizeLabel(w, h)} widget`}
      aria-describedby={editable ? hintId : undefined}
      aria-posinset={position}
      aria-setsize={count}
      layout={resizing ? false : "position"}
      drag={editable}
      dragListener={false}
      dragControls={controls}
      dragSnapToOrigin
      dragMomentum={false}
      onDragStart={() => handlers.start(item.id)}
      onDrag={handlers.drag}
      onDragEnd={() => handlers.end(item.id)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={(e) => {
        if (phase !== "idle") e.preventDefault();
      }}
      onFocus={() => {
        if (editable) handlers.select(item.id);
      }}
      onClickCapture={(e) => {
        if (
          handlers.swallow() ||
          (editable && (e.target as HTMLElement).closest("a"))
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      animate={{
        scale:
          phase === "holding"
            ? 0.97
            : phase === "lifted"
              ? LIFT_SCALE
              : landed
                ? 1.02
                : 1,
        boxShadow: phase === "lifted" ? SHADOW_LIFTED : SHADOW_REST,
      }}
      whileDrag={{
        scale: LIFT_SCALE,
        boxShadow: SHADOW_LIFTED,
        transition: LIFT,
      }}
      transition={SPRING}
      // Two highlights, on two elements so they can coexist: the root keeps the
      // keyboard focus outline (`:focus-visible`), and the inner tile carries the
      // current-card ring driven by `selected` / `landed`. The tile ring is the
      // one that survives a pointer gesture, which a browser will not mark as
      // focus-visible.
      className={`relative min-w-0 rounded-[var(--widget-radius)] outline-none focus-visible:ring-2 focus-visible:ring-ring [&_a]:[-webkit-user-drag:none] [&_img]:[-webkit-user-drag:none] ${
        sizeTransition ? "transition-[width,height] duration-300 ease-out-quart " : ""
      }${
        editable
          ? "cursor-grab touch-pan-y touch-pinch-zoom select-none [-webkit-touch-callout:none] active:cursor-grabbing"
          : ""
      }`}
      style={{
        gridColumn: `${col + 1} / span ${w}`,
        gridRow: `${row + 1} / span ${h}`,
        zIndex: resizing ? 30 : held ? 20 : raised ? 10 : 0,
        ...(pxSize
          ? {
              width: pxSize.w,
              height: pxSize.h,
              justifySelf: "start",
              alignSelf: "start",
            }
          : null),
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", visualDuration: 0.6, bounce: 0.12, delay }}
        className={`relative isolate flex h-full w-full flex-col overflow-hidden rounded-[var(--widget-radius)] bg-card text-card-foreground ring-inset transition-shadow duration-300 [clip-path:inset(0_round_var(--widget-radius))] ${
          landed
            ? "ring-2 ring-primary"
            : selected
              ? "ring-2 ring-primary/70"
              : "ring-1 ring-border/80"
        }`}
      >
        {renderItem?.(item)}
      </motion.div>

      {/* Live resize outline — outside the clipped inner tile so it stays visible. */}
      {resizing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-30 rounded-[var(--widget-radius)] border-2 border-dashed border-primary/60"
        />
      )}

      {/* Corner resize handle. Sits outside the inner tile, which clips its own children. */}
      {editable && resizable && (
        <div
          data-resize-handle
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.select(item.id);
            handlers.resizeStart(item.id, e.clientX, e.clientY);
          }}
          className="absolute bottom-1.5 right-1.5 z-30 flex size-6 cursor-nwse-resize touch-none select-none items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/70 hover:text-foreground"
        >
          <svg
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M6 14 L14 6" />
            <path d="M11 14 L14 11" />
          </svg>
        </div>
      )}
    </motion.div>
  );
});

/* ------------------------------------------------------------------ *
 * Grid
 * ------------------------------------------------------------------ */

export function DraggableWidgetGrid({
  items: initialItems,
  onChange,
  renderItem,
  editable = true,
  resizable = true,
  maxColumns = 4,
  maxRows = 4,
  cellSize = 215,
  gap = 12,
  radius = 20,
  className = "",
}: DraggableWidgetGridProps) {
  const [items, setItems] = useState<WidgetItem[]>(() => initialItems ?? []);
  const grid = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
  const minColumns = Math.min(2, Math.max(1, maxColumns));

  const [metrics, setMetrics] = useState({ unit: 0, columns: 0 });
  useIsoLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width < 1) return;
      const columns = Math.max(
        minColumns,
        Math.min(maxColumns, Math.round(width / cellSize)),
      );
      const unit = (width - gap * (columns - 1)) / columns;
      setMetrics((was) =>
        was.columns === columns && Math.abs(was.unit - unit) < 0.5
          ? was
          : { unit, columns },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxColumns, minColumns, cellSize, gap]);

  // Live resize: the tile follows the pointer in pixels, while the layout is
  // re-tiled from its *snapped* span so neighbours reflow during the drag.
  const [resize, setResize] = useState<{
    id: string;
    w: number;
    h: number;
    pw: number;
    ph: number;
  } | null>(null);

  const columns = metrics.columns || Math.max(minColumns, maxColumns);
  const layoutItems = useMemo(
    () =>
      resize
        ? items.map((it) =>
            it.id === resize.id ? { ...it, w: resize.w, h: resize.h } : it,
          )
        : items,
    [items, resize],
  );
  const placements = useMemo(() => layout(layoutItems, columns), [layoutItems, columns]);
  const rows = placements.reduce((n, p) => Math.max(n, p.row + p.h), 0);

  const latest = useRef({ items, metrics, onChange });
  latest.current.metrics = metrics;
  latest.current.onChange = onChange;
  useIsoLayoutEffect(() => {
    latest.current.items = items;
  }, [items]);

  const commit = useCallback((next: WidgetItem[]) => {
    latest.current.items = next;
    setItems(next);
  }, []);

  const toSlot = useCallback(
    (box: Box): Slot => {
      const el = grid.current;
      const { unit } = latest.current.metrics;
      const rect = el?.getBoundingClientRect();
      const colStep = unit + gap;
      const rowStep = Math.round(unit) + gap;
      const left = (rect?.left ?? 0) + box.col * colStep;
      const top = (rect?.top ?? 0) + box.row * rowStep;
      return {
        left,
        top,
        right: left + box.w * colStep - gap,
        bottom: top + box.h * rowStep - gap,
      };
    },
    [gap],
  );

  const [held, setHeld] = useState<string | null>(null);
  const [raised, setRaised] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  // A short explicit-size animation played when a tile is resized by keyboard
  // (the grid span change alone can't be transitioned).
  const [sizeAnim, setSizeAnim] = useState<{ id: string; pw: number; ph: number } | null>(
    null,
  );
  const dragging = useRef<string | null>(null);
  const startOrder = useRef<WidgetItem[] | null>(null);
  const frame = useRef(0);
  const lastMove = useRef(0);
  const swallowUntil = useRef(0);
  const ring = useRef(0);
  const refocus = useRef<string | null>(null);
  const scrollTarget = useRef<string | null>(null);
  const sizeAnimTimer = useRef(0);

  const step = useCallback(
    (force = false) => {
      frame.current = 0;
      const id = dragging.current;
      const { items: current, metrics: m } = latest.current;
      const el = id
        ? (grid.current?.querySelector(
            `[data-widget-id="${CSS.escape(id)}"]`,
          ) as HTMLElement | null)
        : null;
      if (!id || !el || !m.columns) return;
      const now = performance.now();
      if (!force && now - lastMove.current < SETTLE_MS) {
        frame.current = requestAnimationFrame(() => step());
        return;
      }
      const me = layout(current, m.columns).find((p) => p.id === id);
      if (!me) return;
      const r = el.getBoundingClientRect();
      const order = choose(
        toSlot(me),
        candidatesFor(current, id, m.columns, toSlot),
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      if (!order) return;
      lastMove.current = now;
      commit(canonical(order, m.columns));
    },
    [toSlot, commit],
  );

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(ring.current);
      window.clearTimeout(sizeAnimTimer.current);
    },
    [],
  );

  useIsoLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const el = grid.current?.querySelector(
      `[data-widget-id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    el?.focus();
  }, [items]);

  // Keep the focused card in view as it moves up or down. The card's own rect is
  // mid-flight while the layout spring runs, so the target is read from its grid
  // slot — the settled position. Scroll only when the card would otherwise leave
  // the viewport, so a short move does not jolt the page.
  useIsoLayoutEffect(() => {
    const id = scrollTarget.current;
    if (!id) return;
    scrollTarget.current = null;
    const { columns, unit } = latest.current.metrics;
    if (!columns || !unit) return;
    const p = layout(latest.current.items, columns).find((q) => q.id === id);
    if (!p) return;
    const slot = toSlot(p);
    const headroom = 88; // clears the 68px sticky header
    const floor = window.innerHeight - 16; // keeps the focus ring off the fold
    let dx = 0;
    let dy = 0;
    if (slot.top < headroom) dy = slot.top - headroom;
    else if (slot.bottom > floor) dy = slot.bottom - floor;
    if (slot.left < 0) dx = slot.left;
    else if (slot.right > window.innerWidth) dx = slot.right - window.innerWidth;
    if (dx || dy) window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
  }, [items, selectedId, toSlot]);

  // The selected tile is the focus: whenever selection changes, make it the
  // active element so the focus ring and keyboard both point at the same card.
  useIsoLayoutEffect(() => {
    if (!editable || !selectedId) return;
    const el = grid.current?.querySelector(
      `[data-widget-id="${CSS.escape(selectedId)}"]`,
    ) as HTMLElement | null;
    if (el && document.activeElement !== el) el.focus();
  }, [selectedId, editable]);

  const handlers: WidgetHandlers = useMemo(
    () => ({
      start: (id) => {
        dragging.current = id;
        startOrder.current = latest.current.items;
        lastMove.current = 0;
        setHeld(id);
        setRaised(id);
        window.addEventListener(
          "pointerup",
          () => {
            swallowUntil.current = performance.now() + 300;
          },
          { once: true, capture: true },
        );
      },
      drag: () => {
        if (!frame.current) frame.current = requestAnimationFrame(() => step());
      },
      end: (id) => {
        cancelAnimationFrame(frame.current);
        step(true);
        frame.current = 0;
        dragging.current = null;
        setHeld(null);
        setLanded(id);
        window.clearTimeout(ring.current);
        ring.current = window.setTimeout(() => {
          setLanded(null);
          setRaised(null);
        }, LANDED_MS);
        const before = startOrder.current;
        startOrder.current = null;
        const after = latest.current.items;
        if (before && !sameOrder(before, after))
          latest.current.onChange?.(after);
      },
      select: (id) => {
        setSelectedId(id);
        const label = latest.current.items.find((it) => it.id === id)?.label ?? id;
        setAnnounce(`${label} selected`);
      },
      resizeStart: (id, x, y) => {
        const { items: current, metrics: m } = latest.current;
        const p = layout(current, m.columns).find((q) => q.id === id);
        if (!p || !m.columns) return;
        const colStep = m.unit + gap;
        const rowStep = Math.round(m.unit) + gap;
        const startPxW = p.w * colStep - gap;
        const startPxH = p.h * rowStep - gap;
        const g = {
          id,
          x,
          y,
          startW: p.w,
          startH: p.h,
          startCol: p.col,
          startPxW,
          startPxH,
          minPxW: colStep - gap,
          minPxH: rowStep - gap,
          maxPxW: (m.columns - p.col) * colStep - gap,
          maxPxH: maxRows * rowStep - gap,
          colStep,
          rowStep,
          columns: m.columns,
          w: p.w,
          h: p.h,
          pw: startPxW,
          ph: startPxH,
        };
        setResize({ id, w: p.w, h: p.h, pw: startPxW, ph: startPxH });

        function move(ev: PointerEvent) {
          const cols = latest.current.metrics.columns || g.columns;
          // Follow the pointer in pixels so the tile resizes continuously…
          const pw = Math.max(g.minPxW, Math.min(g.startPxW + (ev.clientX - g.x), g.maxPxW));
          const ph = Math.max(g.minPxH, Math.min(g.startPxH + (ev.clientY - g.y), g.maxPxH));
          // …while the committed span is the nearest whole unit.
          const w = Math.max(1, Math.min(Math.round((pw + gap) / g.colStep), cols - g.startCol));
          const h = Math.max(1, Math.min(Math.round((ph + gap) / g.rowStep), maxRows));
          g.pw = pw;
          g.ph = ph;
          g.w = w;
          g.h = h;
          setResize({ id: g.id, w, h, pw, ph });
        }
        function finish(commitIt: boolean) {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          setResize(null);
          if (!commitIt) return;
          const cols = latest.current.metrics.columns || g.columns;
          const next = latest.current.items.map((it) =>
            it.id === g.id ? { ...it, w: g.w, h: g.h } : it,
          );
          const ordered = canonical(next, cols);
          commit(ordered);
          // Unconditional: a resize can change spans without reordering ids, so
          // the drag-end path (which gates on id order) would drop it.
          latest.current.onChange?.(ordered);
          const label = ordered.find((it) => it.id === g.id)?.label ?? g.id;
          setAnnounce(`${label}: ${g.w} by ${g.h}`);
          refocus.current = g.id;
          setLanded(g.id);
          window.clearTimeout(ring.current);
          ring.current = window.setTimeout(() => {
            setLanded(null);
            setRaised(null);
          }, LANDED_MS);
        }
        function up() {
          finish(true);
        }
        function cancel() {
          finish(false);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
      },
      key: (e, id) => {
        if (!editable || !e.altKey) return;
        if (
          (e.target as HTMLElement).closest(
            "input, textarea, select, [contenteditable=true]",
          )
        )
          return;
        const { items: current, metrics: m } = latest.current;
        const cols = m.columns || maxColumns;
        const p = layout(current, cols).find((q) => q.id === id);
        if (!p) return;

        // Alt + Shift + Arrow moves the selection to the adjacent tile.
        if (e.shiftKey) {
          const dir =
            e.key === "ArrowRight"
              ? ([1, 0] as const)
              : e.key === "ArrowLeft"
                ? ([-1, 0] as const)
                : e.key === "ArrowDown"
                  ? ([0, 1] as const)
                  : e.key === "ArrowUp"
                    ? ([0, -1] as const)
                    : null;
          if (dir) {
            e.preventDefault();
            const target = neighborOf(layout(current, cols), id, [dir[0], dir[1]]);
            if (target) {
              scrollTarget.current = target;
              setSelectedId(target);
              const label = current.find((it) => it.id === target)?.label ?? target;
              setAnnounce(`${label} selected`);
            }
            return;
          }
          // Not an arrow — fall through to the width resize below.
        }

        // Alt + (+/-) resizes height; Alt + Shift + (+/-) resizes width.
        const plus = e.key === "+" || e.key === "=";
        const minus = e.key === "-" || e.key === "_";
        if (plus || minus) {
          e.preventDefault();
          const step = plus ? 1 : -1;
          const w = e.shiftKey
            ? Math.max(1, Math.min(p.w + step, cols - p.col))
            : p.w;
          const h = e.shiftKey
            ? p.h
            : Math.max(1, Math.min(p.h + step, maxRows));
          if (w === p.w && h === p.h) return;
          const next = canonical(
            current.map((it) => (it.id === id ? { ...it, w, h } : it)),
            cols,
          );
          const colStep = m.unit + gap;
          const rowStep = Math.round(m.unit) + gap;
          refocus.current = id;
          commit(next);
          latest.current.onChange?.(next);
          const label = next.find((it) => it.id === id)?.label ?? id;
          setAnnounce(`${label}: ${w} columns by ${h} rows`);
          // Play the size change: render at the old pixel size, then let a CSS
          // transition carry it to the new one.
          if (m.unit > 0) {
            setSizeAnim({ id, pw: p.w * colStep - gap, ph: p.h * rowStep - gap });
            window.clearTimeout(sizeAnimTimer.current);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                setSizeAnim({ id, pw: w * colStep - gap, ph: h * rowStep - gap });
                sizeAnimTimer.current = window.setTimeout(
                  () => setSizeAnim(null),
                  320,
                );
              }),
            );
          }
          return;
        }

        // Alt + Arrow moves the selected tile.
        const delta =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -1
              : 0;
        if (!delta) return;
        e.preventDefault();
        const from = current.findIndex((item) => item.id === id);
        for (let to = from + delta; to >= 0 && to < current.length; to += delta) {
          const next = canonical(moveTo(current, id, to), cols);
          if (sameOrder(next, current)) continue;
          refocus.current = id;
          scrollTarget.current = id;
          commit(next);
          latest.current.onChange?.(next);
          // Same landing emphasis a drag or a resize gets, so a card moved with
          // the keys is just as clearly the current one.
          setLanded(id);
          window.clearTimeout(ring.current);
          ring.current = window.setTimeout(() => {
            setLanded(null);
            setRaised(null);
          }, LANDED_MS);
          return;
        }
      },
      swallow: () => performance.now() < swallowUntil.current,
      suppressClick: () => {
        swallowUntil.current = performance.now() + 300;
      },
    }),
    [step, commit, editable, maxColumns, maxRows, gap],
  );

  // Keyboard drives the selected tile, whether or not it still holds focus.
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId || !e.altKey) return;
      handlers.key(e as unknown as ReactKeyboardEvent, selectedId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, handlers, selectedId]);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const domOrder = useRef(items.map((item) => item.id));
  for (const item of items)
    if (!domOrder.current.includes(item.id)) domOrder.current.push(item.id);
  const placementById = new Map(placements.map((p) => [p.id, p]));
  const visualIndex = new Map(
    [...placements]
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .map((p, i) => [p.id, i]),
  );

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`relative w-full ${className}`}
        style={{ "--widget-radius": `${radius}px` } as CSSProperties}
      >
        {editable && (
          <p id={hintId} className="sr-only">
            Click a tile to select it. Drag to rearrange, or drag a tile's
            bottom-right corner to resize it. On touch screens, press and hold
            first. With a keyboard, Alt and the arrow keys move the selected
            tile, Alt, Shift and the arrow keys move the selection to the
            neighbouring tile, Alt and the plus or minus keys resize the height,
            and Alt, Shift and the plus or minus keys resize the width.
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
        <div
          ref={grid}
          role="list"
          data-slot="widget-grid"
          className="grid w-full"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null);
          }}
          style={{
            gap,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridAutoRows: metrics.unit
              ? `${Math.round(metrics.unit)}px`
              : `minmax(${cellSize * 0.75}px, auto)`,
          }}
        >
          {domOrder.current.map((id) => {
            const item = byId.get(id);
            const p = placementById.get(id);
            if (!item || !p) return null;
            const rs = resize?.id === id ? resize : null;
            const as = sizeAnim?.id === id ? sizeAnim : null;
            return (
              <Widget
                key={id}
                position={(visualIndex.get(id) ?? 0) + 1}
                count={placements.length}
                item={item}
                col={p.col}
                row={p.row}
                w={p.w}
                h={p.h}
                pxSize={
                  rs
                    ? { w: rs.pw, h: rs.ph }
                    : as
                      ? { w: as.pw, h: as.ph }
                      : undefined
                }
                sizeTransition={as !== null}
                columns={columns}
                rows={rows}
                editable={editable}
                resizable={resizable}
                resizing={rs !== null}
                selected={editable && selectedId === id}
                held={held === p.id}
                raised={raised === p.id}
                landed={landed === p.id}
                handlers={handlers}
                hintId={hintId}
                renderItem={renderItem}
              />
            );
          })}
        </div>
      </div>
    </MotionConfig>
  );
}

export default DraggableWidgetGrid;
