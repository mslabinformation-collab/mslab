"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import styles from "./DragList.module.css";

/** How far a finger or the mouse has to go before a press on the handle is a drag and not a tap, in px. */
const DRAG_START = 4;
/** How long a moved row waits for the page to put it in its new place before it gives up on the focus, in ms (a move that waits for the server). */
const FOCUS_WINDOW = 5000;

/** What moved a row, and so where the focus comes back to: the handle, an arrow, or the page's own trigger (`data-drag-tool="menu"`, see `DragRowTools`). */
type Tool = "handle" | "up" | "down" | "menu";
type Rect = { top: number; bottom: number };
/** One press on a handle, from `pointerdown` to its end. Kept in a ref, not in state: the handlers read it before React has drawn again. */
type Session = {
  from: number;
  to: number;
  pointerId: number;
  handle: HTMLElement;
  /** The dragged row's `li`: it carries --drag-dy, so that only it, not every row, is restyled as the pointer moves. */
  row: HTMLElement;
  /** false when the browser would not capture the pointer: no `pointerup` is then sure to reach the handle, so a new press may take over. */
  captured: boolean;
  startY: number;
  /** false until the pointer has gone DRAG_START px: a tap lifts nothing. */
  active: boolean;
  /** The middle of each row's place as the drag began. */
  centres: number[];
  minDy: number;
  maxDy: number;
};

/** What the page gets for a row besides its handle and arrows: a way to move it that is not a step of one (the phone's „↕“ menu: „Esimeseks“, „Viimaseks“). */
export type DragRowTools = {
  /**
   * Moves the row to the place `toIndex` (0 is the first) as the arrows do: one `onMove`, the announcement, and the focus coming back to the row's trigger once
   * the list has its new order. Mark that trigger `data-drag-tool="menu"` (a button, or a wrapper with a button in it). No move for the row's own place, a
   * place outside the list, or a `disabled` list.
   */
  moveTo: (toIndex: number) => void;
};

export type DragListProps<T> = {
  items: readonly T[];
  /** A key of the item that holds for as long as it is in the list: the focus finds the moved row by it. */
  keyOf: (item: T) => string;
  /** The item's name for the handle, the arrows and the announcement („Lohista: {nimi}“). An empty string: it has none, and its number says which row it is („Lohista rida {n}“). */
  label: (item: T, index: number) => string;
  /** Called once per move, with the place the item is taken from and the place it goes to (an item dropped where it was is no move). The page puts the list in the new order. */
  onMove: (fromIndex: number, toIndex: number) => void;
  /** The row's content. `handle` and `arrows` are what the page puts where its layout wants them; they are null while the list is `disabled`. `tools`: see DragRowTools. */
  renderRow: (item: T, index: number, handle: ReactNode, arrows: ReactNode, tools: DragRowTools) => ReactNode;
  /** No handles and no arrows (a filtered view, where the neighbours are not all in sight). */
  disabled?: boolean;
  /** For the list (an `ol`) and for each row (an `li`): the page's layout. */
  className?: string;
  rowClassName?: string;
};

/** One row's `li`. A component of its own so that the page's `renderRow` is called here, with `moveTo` as the prop it is, and not in DragList's render beside the refs. */
function Row<T>({
  item,
  index,
  rowKey,
  className,
  dragging,
  shift,
  handle,
  arrows,
  renderRow,
  onMoveTo,
}: {
  item: T;
  index: number;
  rowKey: string;
  className: string;
  dragging: boolean;
  shift: "up" | "down" | undefined;
  handle: ReactNode;
  arrows: ReactNode;
  renderRow: DragListProps<T>["renderRow"];
  onMoveTo: DragRowTools["moveTo"];
}) {
  return (
    <li className={className} data-drag-row={rowKey} data-dragging={dragging ? "" : undefined} data-shift={shift}>
      {renderRow(item, index, handle, arrows, { moveTo: onMoveTo })}
    </li>
  );
}

/**
 * The order control of the B screens (README B1 and B2; piece 3 texts S3-P3-m): a list of rows that each have a handle „⋮⋮“ to drag, and the arrows ↑ / ↓.
 * Four ways to move a row, all of which end in one `onMove(from, to)` and one announcement („{nimi}“ on nüüd {k}. kohal.) in a polite live region:
 *
 * - Dragging the handle, with a finger, a pen or the mouse: pointer events with the pointer captured by the handle (no HTML drag and drop, which an iPad
 *   before iPadOS 15 does not do with a finger). Only the handle has `touch-action: none`, so the rest of the row still scrolls the page. The row follows
 *   the pointer and the rows it passes make room, drawn by the stylesheet from `data-dragging` / `data-shift` and two custom properties (--drag-dy on the
 *   dragged row, --drag-step on the list); nothing is moved in the DOM until the drop, when `onMove` is called once. Esc and a cancelled pointer end the drag
 *   with no move.
 * - The ↑ / ↓ buttons. They are aria-disabled at the ends, never disabled (a disabled button would drop the focus).
 * - ArrowUp / ArrowDown on the handle, which says „lohistatav“ and so is expected to move (not with Ctrl, Cmd, Alt or Shift down: those chords are the
 *   browser's and the screen reader's).
 * - `tools.moveTo(index)`, for a control the page draws itself (the phone's „↕“ menu).
 *
 * The focus stays on what moved the row (the handle, the arrow, or the page's `data-drag-tool="menu"` trigger) even where the browser drops it as the row's
 * node moves; it is given back as soon as the page's list has the new order, unless the reader has put it elsewhere meanwhile (it is given back only when it
 * is on the page's body or still in the moved row). A page that waits for the server before it reorders gets the same, for a few seconds.
 */
export function DragList<T>({ items, keyOf, label, onMove, renderRow, disabled, className, rowClassName }: DragListProps<T>) {
  const t = adminEt.drag;
  const list = useRef<HTMLOListElement>(null);
  const session = useRef<Session | null>(null);
  /** The row being dragged and the place it would land in: what the stylesheet draws. */
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [said, setSaid] = useState({ id: 0, text: "" });
  /** The control that gets the focus when the list has its new order (`sig` is the order the move was made in). */
  const pending = useRef<{ key: string; tool: Tool; sig: string } | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const keys = items.map(keyOf);
  const sig = keys.join("\u0000");

  const rowsOf = (): HTMLElement[] => Array.from(list.current?.children ?? []) as HTMLElement[];

  /** Ends the press on a handle; `commit` drops the row where it is, else it snaps back. */
  const finish = (commit: boolean) => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.row.style.removeProperty("--drag-dy");
    list.current?.style.removeProperty("--drag-step");
    try {
      if (s.handle.hasPointerCapture?.(s.pointerId)) s.handle.releasePointerCapture(s.pointerId);
    } catch {
      /* (the pointer is gone already) */
    }
    setDrag(null);
    if (commit && s.active && s.to !== s.from) move(s.from, s.to, "handle");
  };

  /** One move, however it was made: announce it, keep the focus for it, tell the page. */
  const move = (from: number, to: number, tool: Tool) => {
    const item = items[from];
    const name = label(item, from);
    const text = name ? fill(t.moved, { name, k: to + 1 }) : fill(t.movedRow, { n: from + 1, k: to + 1 });
    setSaid((s) => ({ id: s.id + 1, text }));
    pending.current = { key: keys[from], tool, sig };
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => void (pending.current = null), FOCUS_WINDOW);
    onMove(from, to);
  };

  const step = (index: number, dir: -1 | 1, tool: Tool) => {
    const to = index + dir;
    if (to < 0 || to >= items.length) return;
    move(index, to, tool);
  };

  const moveTo = (index: number, to: number) => {
    if (disabled || to === index || to < 0 || to >= items.length) return;
    move(index, to, "menu");
  };

  const begin = (e: PointerEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // a press that is under way keeps the list (a second finger does not steer it); only one whose pointer was never captured, and so may never end, is taken over
    if (session.current) {
      if (session.current.captured) return;
      finish(false);
    }
    const rows = rowsOf();
    if (rows.length !== items.length) return;
    const rects: Rect[] = rows.map((row) => row.getBoundingClientRect());
    const own = rects[index];
    const last = rects[rects.length - 1];
    const neighbour = rects[index + 1] ? rects[index + 1].top - own.bottom : rects[index - 1] ? own.top - rects[index - 1].bottom : 0;
    session.current = {
      from: index,
      to: index,
      pointerId: e.pointerId,
      handle: e.currentTarget,
      row: rows[index],
      captured: false,
      startY: e.clientY,
      active: false,
      centres: rects.map((r) => (r.top + r.bottom) / 2),
      minDy: rects[0].top - own.top,
      maxDy: last.bottom - own.bottom,
    };
    list.current?.style.setProperty("--drag-step", `${own.bottom - own.top + Math.max(0, neighbour)}px`);
    // the pointer stays with the handle wherever the finger goes; the press is ours (no text selection, no mouse events after it), and the handle has the focus
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      if (session.current) session.current.captured = true;
    } catch {
      /* (an old browser, or a pointer that is gone: the move events still come while the pointer is over the handle) */
    }
    e.currentTarget.focus({ preventScroll: true });
  };

  const track = (e: PointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    const raw = e.clientY - s.startY;
    if (!s.active && Math.abs(raw) < DRAG_START) return;
    s.active = true;
    const dy = Math.min(s.maxDy, Math.max(s.minDy, raw));
    s.row.style.setProperty("--drag-dy", `${dy}px`);
    // the place whose middle is nearest to the dragged row's middle
    const middle = s.centres[s.from] + dy;
    let to = s.from;
    for (let j = 0; j < s.centres.length; j++) if (Math.abs(s.centres[j] - middle) < Math.abs(s.centres[to] - middle)) to = j;
    s.to = to;
    setDrag((now) => (now && now.from === s.from && now.to === to ? now : { from: s.from, to }));
  };

  const end = (e: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (session.current && e.pointerId === session.current.pointerId) finish(commit);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "Escape" && session.current) {
      // only the drag: a drawer around the list (a dialog closes on Esc) stays open
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !session.current) {
      // Ctrl, Cmd, Alt and Shift with an arrow are the browser's and the screen reader's chords, not a move
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      step(index, e.key === "ArrowUp" ? -1 : 1, "handle");
    }
  };

  // a press ends when the list is no longer the one it began in: the order changed under it, or the list was switched off
  useEffect(() => {
    if (session.current) finish(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `finish` reads refs and the latest props only; this runs on the two changes that matter
  }, [sig, disabled]);

  // the focus goes back to the control that moved the row once the list has its new order (a browser drops it when it moves the focused node)
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || p.sig === sig) return;
    pending.current = null;
    const row = rowsOf().find((li) => li.dataset.dragRow === p.key);
    if (!row) return;
    // only where the focus was dropped (it is on the body) or is still in the row: a reader who has gone on to a field elsewhere while the page was reordering stays there
    const now = document.activeElement;
    if (now && now !== document.body && !row.contains(now)) return;
    const trigger = row.querySelector<HTMLElement>(`[data-drag-tool="${p.tool}"]`);
    // (a page may mark the wrapper of its menu button: the button inside takes the focus)
    (trigger?.matches("button, a[href], input, select, textarea, [tabindex]") ? trigger : trigger?.querySelector<HTMLElement>("button, a[href], [tabindex]"))?.focus();
  });

  useEffect(
    () => () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );

  return (
    <>
      <ol ref={list} className={className ? `${styles.list} ${className}` : styles.list} data-drag-list="" data-dragging={drag ? "" : undefined}>
        {items.map((item, i) => {
          const name = label(item, i);
          const last = i === items.length - 1;
          // while a row is dragged, those between it and its place make room: up when it goes down, down when it goes up
          const shift = !drag || i === drag.from ? undefined : drag.from < drag.to ? (i > drag.from && i <= drag.to ? "up" : undefined) : i >= drag.to && i < drag.from ? "down" : undefined;
          const handle = disabled ? null : (
            <button
              type="button"
              className={styles.handle}
              data-drag-tool="handle"
              aria-roledescription={t.roleDescription}
              aria-label={name ? fill(t.handle, { name }) : fill(t.handleRow, { n: i + 1 })}
              onPointerDown={(e) => begin(e, i)}
              onPointerMove={track}
              onPointerUp={(e) => end(e, true)}
              onPointerCancel={(e) => end(e, false)}
              onLostPointerCapture={(e) => end(e, false)}
              onKeyDown={(e) => onKey(e, i)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span aria-hidden="true">⋮⋮</span>
            </button>
          );
          const arrows = disabled ? null : (
            <span className={styles.arrows}>
              <button
                type="button"
                className={styles.arrow}
                data-drag-tool="up"
                aria-label={name ? fill(t.up, { name }) : fill(t.upRow, { n: i + 1 })}
                aria-disabled={i === 0 || undefined}
                onClick={() => step(i, -1, "up")}
              >
                ↑
              </button>
              <button
                type="button"
                className={styles.arrow}
                data-drag-tool="down"
                aria-label={name ? fill(t.down, { name }) : fill(t.downRow, { n: i + 1 })}
                aria-disabled={last || undefined}
                onClick={() => step(i, 1, "down")}
              >
                ↓
              </button>
            </span>
          );
          return (
            <Row
              key={keys[i]}
              item={item}
              index={i}
              rowKey={keys[i]}
              className={rowClassName ? `${styles.row} ${rowClassName}` : styles.row}
              dragging={drag?.from === i}
              shift={shift}
              handle={handle}
              arrows={arrows}
              renderRow={renderRow}
              onMoveTo={(to) => moveTo(i, to)}
            />
          );
        })}
      </ol>
      {/* a new node for each announcement, so the same words twice are read twice */}
      <div className={styles.live} role="status" aria-live="polite" aria-atomic="true">
        {said.text !== "" && <span key={said.id}>{said.text}</span>}
      </div>
    </>
  );
}
