"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adminEt } from "@/i18n/dict/admin";
import styles from "./UndoBar.module.css";

/** How long „Võta tagasi“ is on offer. The server purges a soft-deleted thing 10 s after the tap (README §1.7, B5), so this is shorter. */
const LASTS_MS = 8000;

export type UndoOffer = {
  /** What happened, as a sentence with its full stop: „Pilt eemaldatud.“ */
  text: string;
  /** Takes it back. true: done. false (or a throw): it did not go through, and the bar says so. */
  undo: () => Promise<boolean>;
};

type Api = { show(offer: UndoOffer): void };

// Without a provider (a component rendered alone, in a test) there is nobody to show the bar: show does nothing.
const Context = createContext<Api>({ show: () => {} });

/** `show` puts the bar up: one at a time, and a new one replaces the one on screen. */
export function useUndo(): Api {
  return useContext(Context);
}

type Bar = UndoOffer & { id: number; state: "ready" | "working" | "failed" };

/** The topmost open dialog (a drawer, the phone menu): while one is modal the rest of the page is inert, and a bar under it could not be pressed. */
function openDialog(): HTMLElement | null {
  const open = document.querySelectorAll<HTMLElement>("dialog[open]");
  return open.length > 0 ? open[open.length - 1] : null;
}

/**
 * The UndoBar (admin UX pass, README §1.7): „{Mis juhtus}.“ and „Võta tagasi“ for 8 s after a reversible one-tap action (a removed image, file or
 * list row, a hidden or published review, a request marked done). Bottom left, full width on a phone, `role="status"`.
 *
 * - One bar at a time: `show` again replaces it, and the 8 s start over.
 * - It never takes the focus (she is probably typing). Esc dismisses it while it is up, before anything else sees the key (a drawer under it stays
 *   open); with no bar up, Esc is left alone.
 * - „Võta tagasi“ runs `undo` once. true closes the bar; false (or a throw) shows `common.saveError` in it and it closes 8 s later; the button stays,
 *   so she can try again in that time.
 * - The status region is in the page from the start (a region that arrives with its text is not reliably announced). While a modal dialog is open
 *   the bar is put inside it, where it can be pressed, and it comes back to the page when the dialog closes.
 *
 * Mounted once, in the (panel) layout.
 */
export function UndoProvider({ children }: { children: React.ReactNode }) {
  const [bar, setBar] = useState<Bar | null>(null);
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  /** The bar as of now, for the handlers (a late answer must know whether its bar is still the one on screen). */
  const now = useRef<Bar | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ids = useRef(0);

  const put = useCallback((next: Bar | null) => {
    now.current = next;
    setBar(next);
  }, []);
  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const dismiss = useCallback(() => {
    stop();
    put(null);
  }, [stop, put]);
  /** (Re)start the 8 s. */
  const arm = useCallback(() => {
    stop();
    timer.current = setTimeout(dismiss, LASTS_MS);
  }, [stop, dismiss]);

  const show = useCallback(
    (offer: UndoOffer) => {
      put({ ...offer, id: ++ids.current, state: "ready" });
      setDialog(openDialog());
      arm();
    },
    [put, arm],
  );
  const api = useMemo<Api>(() => ({ show }), [show]);

  // leaving the admin with a bar up: nothing may fire after it
  useEffect(() => stop, [stop]);

  const shown = bar !== null;

  // Esc: the bar goes first, and the key goes no further. Capture on the window, so a drawer's own handling does not see it.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, dismiss]);

  // which dialog (if any) holds the bar: a drawer may open or close while it is up
  useEffect(() => {
    if (!shown) return;
    const watch = new MutationObserver(() => setDialog(openDialog()));
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => watch.disconnect();
  }, [shown]);

  const undo = async () => {
    const mine = now.current;
    if (!mine || mine.state === "working") return;
    // the 8 s do not run while the answer is on its way: the bar would close under it
    stop();
    put({ ...mine, state: "working" });
    let ok = false;
    try {
      ok = (await mine.undo()) !== false;
    } catch {
      ok = false;
    }
    // a newer bar (or Esc) came meanwhile: this answer is no longer for the screen
    if (now.current?.id !== mine.id) return;
    if (ok) {
      dismiss();
    } else {
      put({ ...mine, state: "failed" });
      arm();
    }
  };

  const view = bar && (
    <div className={styles.bar} data-undo-bar="">
      <p className={styles.text}>{bar.state === "failed" ? adminEt.common.saveError : bar.text}</p>
      <button type="button" className={styles.button} aria-disabled={bar.state === "working" || undefined} onClick={undo}>
        {adminEt.common.undo}
      </button>
    </div>
  );
  const host = bar ? dialog : null;

  return (
    <Context.Provider value={api}>
      {children}
      <div role="status" className={styles.region} data-undo-region="">
        {!host && view}
      </div>
      {host &&
        createPortal(
          <div role="status" className={styles.region} data-undo-region="">
            {view}
          </div>,
          host,
        )}
    </Context.Provider>
  );
}
