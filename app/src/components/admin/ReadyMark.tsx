"use client";

import { useEffect } from "react";

/** How long to look for the page's own content before marking anyway (a page with nothing React-made in it would never be found). */
const GIVE_UP_MS = 10_000;

/**
 * The page's first element in <main>: not the shell's top line, not the undo bar's status region (the layout's, hydrated with the shell, so
 * it would count as the page before the page's Suspense boundary has hydrated), not a script, style or link that streaming leaves between, and not the loading rows.
 */
function pageRoot(): Element | null {
  return document.querySelector("#main > :not([data-admin-top]):not([data-undo-region]):not(script):not(style):not(link):not(template):not([data-panel-loading])");
}

/** React puts its fiber on a DOM node when it hydrates (or renders) it, so a node without one is still the server's HTML. */
function takenOver(el: Element): boolean {
  return Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
}

/**
 * Marks <html data-admin-ready> once the admin page has hydrated. The e2e tests wait for it before typing into an editor: text typed
 * into a controlled field while React is still taking the page over can be overwritten by the field's server value.
 *
 * The shell lives in the (panel) layout and loading.tsx puts a Suspense boundary round the page, which React hydrates after the layout:
 * the layout's own effect would run before the page is taken over. So this waits for the page's first element to be React's, and marks
 * on its own after GIVE_UP_MS. Once set, the mark stays through client-side navigations (the layout is not mounted again): a test that
 * waits for the next page waits for something in it.
 */
export function ReadyMark() {
  useEffect(() => {
    const mark = () => {
      document.documentElement.dataset.adminReady = "1";
    };
    const page = pageRoot();
    if (page && takenOver(page)) return mark();
    const started = Date.now();
    const timer = window.setInterval(() => {
      const el = pageRoot();
      if ((el && takenOver(el)) || Date.now() - started > GIVE_UP_MS) {
        window.clearInterval(timer);
        mark();
      }
    }, 20);
    return () => window.clearInterval(timer);
  }, []);
  return null;
}
