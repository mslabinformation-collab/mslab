"use client";

import { useCallback } from "react";

// A bar at the foot of the screen and the UndoBar (admin UX pass piece 3a, Task 8 review M-2): the UndoBar stands bottom left, the whole width on
// a phone (README §1.7), and the phone's PublishBar (README §1.8, Part 4) and a letter's send buttons (piece 3b) stand at the bottom too — the
// UndoBar must never cover their buttons for its 8 s. While such a bar stands at the foot (fixed or sticky to the bottom: its
// stylesheet decides that per width), it sets the page's --admin-foot to its height (the tallest, when there are two), and the UndoBar's region
// stands 16 px above it (UndoBar.module.css). A variable, not :has(): iOS 15.0–15.3 has none. ResizeObserver is iOS 13.4+.

/** The page's CSS variable the UndoBar's region stands on. */
export const FOOT_VAR = "--admin-foot";

/** The bars at the foot now, with their heights. */
const bars = new Map<HTMLElement, number>();

function apply(): void {
  const tallest = Math.max(0, ...bars.values());
  const style = document.documentElement.style;
  if (tallest > 0) style.setProperty(FOOT_VAR, `${tallest}px`);
  else style.removeProperty(FOOT_VAR);
}

/** Does it stand at the foot of the screen now: fixed or sticky to the bottom? */
function atFoot(el: HTMLElement): boolean {
  const s = window.getComputedStyle(el);
  return (s.position === "fixed" || s.position === "sticky") && s.bottom === "0px";
}

/** A ref for a bar that may stand at the foot of the screen: while it is there (and on the page), --admin-foot is its height, measured again as it changes. */
export function useFootBar(): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    const measure = () => {
      if (atFoot(el)) bars.set(el, Math.ceil(el.getBoundingClientRect().height));
      else bars.delete(el);
      apply();
    };
    measure();
    window.addEventListener("resize", measure);
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    watch?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      watch?.disconnect();
      bars.delete(el);
      apply();
    };
  }, []);
}
