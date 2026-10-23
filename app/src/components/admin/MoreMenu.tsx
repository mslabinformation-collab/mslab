"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { adminEt } from "@/i18n/dict/admin";
import styles from "./MoreMenu.module.css";

export type MoreMenuItem = {
  label: string;
  /** Called when the item is chosen (a button). */
  onSelect?: () => void;
  /** Where the item goes (a link); `onSelect` is still called. */
  href?: string;
  /** "danger": an action that cannot be taken back lightly („Lõpeta ligipääs“, „Tühista arve“); drawn in the admin's red. */
  tone?: "danger";
  /**
   * The item cannot be chosen now (the first row's „Üles“ in a list): it is aria-disabled and dimmed, still a menu item the arrows reach, and choosing it does
   * nothing (no `onSelect`, no link followed, the menu stays open).
   */
  disabled?: boolean;
};

/** The room a menu keeps from the viewport's edge, in px. */
const EDGE = 8;
type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Where the open list goes so that it stays inside the viewport: below the button when it fits there, else above it when there is more room above
 * (`up`); from the button's left edge when it fits to the right, else to the button's right edge (`right`) when that keeps its left edge inside. When it
 * fits neither way (a list wider than the room on either side of the button) it takes the side with more room — the stylesheet caps its width at the
 * screen's — and, the rooms being equal, stays left-aligned. Pure: the component measures, this decides.
 */
export function menuPlacement(button: Box, menu: { width: number; height: number }, view: { width: number; height: number }): { up: boolean; right: boolean } {
  const below = view.height - button.bottom - EDGE;
  const above = button.top - EDGE;
  const up = menu.height > below && above > below;
  const overRight = button.left + menu.width > view.width - EDGE;
  const fitsRight = button.right - menu.width >= EDGE;
  if (overRight && !fitsRight) return { up, right: button.right - EDGE > view.width - EDGE - button.left };
  return { up, right: overRight && fitsRight };
}

/**
 * A button that opens a short list of the rarer actions of a row or a card (the A screens, Task 1; the prototype's „Veel ▾“, and „Pikenda ▾“ when
 * the page names it, drawn as an outlined pill with `variant="pill"`): `role="menu"` with a `menuitem` for each item. `buttonLabel` is the
 * trigger's aria-label for a page that shows many of them („Veel: {nimi}“); without it the drawn text names the button.
 *
 * - Opens on a click (and so on Enter and Space, which a button turns into one) and on ArrowDown / ArrowUp, with the focus on the first (last)
 *   item. Enter is taken on the key itself, so it opens with no click after it.
 * - Inside the list the arrows move between the items (round the ends), Home and End go to the ends. Esc closes it and the focus is back on the
 *   button; so does choosing an item (its `onSelect` runs first). Tab closes it too and leaves the focus on the button for the Tab to move on from.
 *   A press outside closes it and takes the focus nowhere (the press decides where it goes). A link item is chosen by Enter and by Space.
 * - It keeps inside the viewport (menuPlacement): flips above the button when it does not fit below, aligns to the button's right edge when it
 *   does not fit to the right, and when it fits neither way takes the side with more room (`data-flip="up"`, `data-align="right"`, MoreMenu.module.css;
 *   the list is never wider than the screen less 16 px).
 * - `variant="icon"` is the round „↕“ of the phone's course list (Part 4 prototype): the label alone, with no ▾, in a 44 px circle; the page names it with
 *   `buttonLabel` („Liiguta: {nimi}“).
 * - `title`: a muted line over the items, as the prototype draws „Pikenda ligipääsu (praegu kuni …)“ over the choices. It is not an item (the focus and the
 *   arrows pass it by) and it is what the list is named by.
 * - Items are buttons (or links, with an `href`); a `tone: "danger"` item has data-tone="danger". The page that wants a question first (a
 *   ConfirmPanel) renders it in place of the menu's button from `onSelect`, and puts the focus back on its trigger afterwards.
 */
export function MoreMenu({
  label,
  title,
  buttonLabel,
  variant = "text",
  items,
}: {
  label?: string;
  /** A line over the items that says what the menu is about („Pikenda ligipääsu (praegu kuni 17.03.2027)“): not an item, and the menu's name instead of the button's. */
  title?: string;
  /** The trigger's accessible name when the drawn text is not enough: a page with a „Veel ▾“ on every row names each from words it shows already („Veel: Kati Kask“). Start it with the drawn text. */
  buttonLabel?: string;
  /** "text" (the default): the plain text button of „Veel ▾“. "pill": the 44 px outlined pill of „Pikenda ▾“ (README A5, Part 2 prototype). "icon": the label alone in a 44 px circle („↕“). */
  variant?: "text" | "pill" | "icon";
  items: MoreMenuItem[];
}) {
  const id = useId();
  const buttonId = `${id}-button`;
  const menuId = `${id}-menu`;
  const titleId = `${id}-title`;
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ up: false, right: false });
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // the item that gets the focus when the list has appeared
  const startAt = useRef<"first" | "last">("first");

  const itemsIn = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const measure = useCallback(() => {
    const b = button.current;
    const m = list.current;
    if (!b || !m) return;
    const view = document.documentElement;
    const next = menuPlacement(b.getBoundingClientRect(), m.getBoundingClientRect(), { width: view.clientWidth, height: view.clientHeight });
    setPlace((now) => (now.up === next.up && now.right === next.right ? now : next));
  }, []);

  // placed before it is painted, and again when the window changes size
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, measure]);

  // the focus goes into the list
  useEffect(() => {
    if (!open) return;
    const all = itemsIn();
    (startAt.current === "last" ? all[all.length - 1] : all[0])?.focus();
  }, [open]);

  // a press outside closes it (mouse and touch: an old iPad does not turn a tap on a bare area into a click on the document)
  useEffect(() => {
    if (!open) return;
    const onPress = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("touchstart", onPress);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("touchstart", onPress);
    };
  }, [open]);

  const show = (which: "first" | "last") => {
    startAt.current = which;
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (item: MoreMenuItem) => {
    if (item.disabled) return;
    item.onSelect?.();
    close(true);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show(e.key === "ArrowDown" ? "first" : "last");
    } else if (e.key === "Enter") {
      // taken here, not as the click after it: one way to open it in every browser
      e.preventDefault();
      if (open) close(false);
      else show("first");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = itemsIn();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at <= 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") {
      // only the menu: a drawer around it (a dialog closes on Esc) stays open
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(true);
    else if (e.key === " " && e.target instanceof HTMLAnchorElement) {
      // a link activates on Enter by itself, and Space would scroll the page (or the drawer): the menu pattern wants both. A button item needs
      // nothing: the browser clicks it on Space.
      e.preventDefault();
      e.target.click();
    }
  };

  return (
    <div className={styles.wrap} ref={wrap} data-more-menu="">
      <button
        ref={button}
        id={buttonId}
        type="button"
        className={styles.button}
        data-variant={variant}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show("first"))}
        onKeyDown={onButtonKey}
      >
        {variant === "icon" ? (
          <span aria-hidden="true">{label}</span>
        ) : (
          <>
            {label ?? adminEt.common.more}{" "}
            <span aria-hidden="true">▾</span>
          </>
        )}
      </button>
      {open && (
        <div
          ref={list}
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-labelledby={title ? titleId : buttonId}
          data-flip={place.up ? "up" : undefined}
          data-align={place.right ? "right" : undefined}
          onKeyDown={onListKey}
        >
          {title && (
            <div id={titleId} role="presentation" className={styles.title}>
              {title}
            </div>
          )}
          {items.map((item, i) =>
            item.href !== undefined ? (
              <ItemLink key={i} item={item} onChoose={() => choose(item)} />
            ) : (
              <button key={i} type="button" role="menuitem" tabIndex={-1} className={styles.item} data-tone={item.tone} aria-disabled={item.disabled || undefined} onClick={() => choose(item)}>
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** A link item: the app's own pages go through next/link (no reload), anything else (a mailto:, another site) is a plain link. A disabled one goes nowhere. */
function ItemLink({ item, onChoose }: { item: MoreMenuItem; onChoose: () => void }) {
  const href = item.href ?? "";
  const common = {
    role: "menuitem",
    tabIndex: -1,
    className: styles.item,
    "data-tone": item.tone,
    "aria-disabled": item.disabled || undefined,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (item.disabled) e.preventDefault();
      else onChoose();
    },
  };
  return href.startsWith("/") ? (
    <Link href={href} {...common}>
      {item.label}
    </Link>
  ) : (
    <a href={href} {...common}>
      {item.label}
    </a>
  );
}
