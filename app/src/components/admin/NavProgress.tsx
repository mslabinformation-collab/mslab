"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "./NavProgress.module.css";

/** The line shows only for a page that takes longer than this: a quick answer shows nothing (06.11 polish board 6). */
export const PROGRESS_AFTER_MS = 150;
/** A move that never arrives (a refused answer, a server action's redirect elsewhere) does not keep the line for ever. */
const GIVE_UP_MS = 15_000;

/**
 * Where a click on a link takes this admin, or null when it is not a move to another admin address this tab makes itself: another tab or a
 * download, a modifier key, a link away from /admin, the same address (a fragment of it too: the section map's links).
 */
export function movesTo(link: HTMLAnchorElement, e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, here: Location): string | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return null;
  let to: URL;
  try {
    to = new URL(link.href, here.href);
  } catch {
    return null;
  }
  if (to.origin !== here.origin || !to.pathname.startsWith("/admin")) return null;
  const address = to.pathname + to.search;
  return address === here.pathname + here.search ? null : address;
}

/**
 * The admin's answer to a click (06.11 polish board 6): a 2 px rose line along the top of the work area while the page or the drawer a link opens is on
 * its way. It starts with any click on a link to another admin address (a menu entry, a list row's name, which ListRows clicks for a tap on the row),
 * appears after 150 ms, grows slowly towards the right, and is gone the moment the address changes. Decoration only: hidden from a screen reader.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const route = `${pathname}?${search.toString()}`;
  const [shown, setShown] = useState(false);
  const timers = useRef<{ show?: ReturnType<typeof setTimeout>; stop?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => {
    const t = timers.current;
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      const link = e.target.closest("a");
      if (!link || movesTo(link, e, window.location) === null) return;
      clearTimeout(t.show);
      clearTimeout(t.stop);
      t.show = setTimeout(() => setShown(true), PROGRESS_AFTER_MS);
      t.stop = setTimeout(() => setShown(false), GIVE_UP_MS);
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      clearTimeout(t.show);
      clearTimeout(t.stop);
    };
  }, []);

  // the new address is in: the line goes at once
  useEffect(() => {
    const t = timers.current;
    clearTimeout(t.show);
    clearTimeout(t.stop);
    setShown(false);
  }, [route]);

  return shown ? <span className={styles.line} aria-hidden="true" data-nav-progress="" /> : null;
}
