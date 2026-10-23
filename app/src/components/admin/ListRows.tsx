"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./list-table.module.css";

/** What a click on is the control's own, never the row's: a link, a button, a field, a label, or anything marked as one. */
const CONTROL = "a, button, input, select, textarea, label, summary, [role=button], [role=link], [contenteditable]";

/** A row of a table, or of a DragList (the Koolitused list is a list of rows, `ol > li`, with the columns drawn by a grid: B1). */
const ROW = "tbody tr, li[data-drag-row]";

/**
 * The table of an admin list, with its rows made links as a whole (admin UX pass, README §1.10; list-table.module.css). The row's name is a real
 * Link (the one target of the keyboard and the screen reader); a plain click on the row anywhere else is forwarded to it with `.click()`, so
 * Next's Link navigates as it always does (the drawer opens, the scroll stays). One delegated handler for the whole table:
 *
 * - only the primary button, with no modifier key (Ctrl/Cmd/Shift/Alt-click is the browser's own: the name Link itself still opens a new tab);
 * - not on or inside a control of the row (its e-mail and phone links, a download, a button, a field, a label): the control gets its click;
 * - not while text is selected: dragging over a cell to copy an e-mail address or a Montonio id ends in a click on the cell, and is not a tap on the row;
 * - a row with no name link (a payer with no account) does nothing.
 *
 * Wrap the `<table>` (or a DragList, whose rows are `li[data-drag-row]`) in it, inside the list's card. It is a plain block; its one class (list-table.module.css `.rows`) only switches off the
 * grey tap flash that iOS Safari paints over the element holding a click listener, which is the whole table (the row tints itself when pressed).
 */
export function ListRows({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);

  // a native listener, not an onClick prop: the row is not a control (the Link is), so there is nothing here for the keyboard to do
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!(e.target instanceof Element)) return;
      const row = e.target.closest(ROW);
      if (!row || !el.contains(row)) return;
      const control = e.target.closest(CONTROL);
      if (control && row.contains(control)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      row.querySelector<HTMLElement>(`a.${styles.name}`)?.click();
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    <div ref={box} className={styles.rows}>
      {children}
    </div>
  );
}
