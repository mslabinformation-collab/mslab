"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NEWSLETTER_SIGNED_KEY, POPUP_SEEN_KEY, popupDelay, popupDue } from "@/domain/campaign";
import { lockPageScroll, trapTab } from "@/lib/modal";
import { Icon } from "./Icon";
import modal from "@/components/ui/modal.module.css";
import styles from "./PopupDialog.module.css";

declare global {
  interface Window {
    /** e2e only (tests/e2e/test.ts): a shorter delay than the site's 8 s, in ms. */
    __mslabCampaignDelay?: number;
  }
}

/** How far a finger pulls the sheet down before letting go closes it. */
const SWIPE_CLOSE_PX = 80;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The popup was shown during this page load already. The module lives as long as the document, through client-side moves (home →
 * course → home remounts the popup), so this keeps "once" when localStorage is refused; a new page load starts over.
 */
let shownThisLoad = false;

const NEVER = () => false;

/** What this browser's storage says of the popup: when it was last shown, and a sign-up here; null when the browser refuses storage. */
function storedState(): { seen: string | null; signed: string | null } | null {
  try {
    return { seen: localStorage.getItem(POPUP_SEEN_KEY), signed: localStorage.getItem(NEWSLETTER_SIGNED_KEY) };
  } catch {
    return null;
  }
}

/**
 * When the home page's popup opens (admin UX pass piece 4b, ruling R-e; before it prototype D's 6 s, once per browser session): 8 s after the page
 * appears, once in 30 days per browser (localStorage "mslab-popup", the time it was shown, set when it is shown), never again in a browser that signed
 * up from it ("mslab-nl"; domain/campaign.ts popupDue); without storage at most once per page load, also across client-side moves back home. It waits
 * while another modal (the phone menu, a lightbox) is open, and fetches `image` meanwhile. `skip()` true: this page load does not get it at all (a
 * newsletter landing). `preview`: the signed-in admin's draft preview — at once, whatever the stamp says, and no stamp written; a sign-up here still
 * keeps it away. [open, close].
 */
export function usePopupOpen(image: string, o: { skip?: () => boolean; preview?: boolean } = {}): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  const skip = o.skip ?? NEVER;
  const preview = o.preview === true;
  useEffect(() => {
    if ((!preview && shownThisLoad) || skip()) return;
    // (no storage: this page load may still show it once)
    const stored = storedState();
    if (stored && !popupDue(stored, Date.now(), { preview })) return;
    // Fetch the picture while waiting, so the card opens with it.
    if (image) new Image().src = image;
    let timer = window.setTimeout(
      function show() {
        if (document.querySelector("dialog[open]")) {
          timer = window.setTimeout(show, 1000);
          return;
        }
        if (!preview) {
          shownThisLoad = true;
          try {
            localStorage.setItem(POPUP_SEEN_KEY, String(Date.now()));
          } catch {
            // shown anyway: shownThisLoad keeps it to once for this page load
          }
        }
        setOpen(true);
      },
      preview ? 0 : popupDelay(window.__mslabCampaignDelay),
    );
    return () => window.clearTimeout(timer);
  }, [image, skip, preview]);
  const close = useCallback(() => setOpen(false), []);
  return [open, close];
}

/**
 * The open popup: a modal <dialog> over a dimmed, blurred page (D .camp-bd) holding the card that `children` draws, with ✕ handed to
 * it for its corner. No "Mitte praegu" (M3). Focus moves to ✕, Tab stays inside, the page behind does not scroll; Esc, ✕ and the
 * backdrop close it and give the focus back; a link inside closes it on its way (the focus belongs to the next page then). Under
 * 640px it is D's bottom sheet, which also closes when pulled down; with reduced motion nothing slides. `name` marks its parts for
 * the tests (data-<name>-popup, -backdrop, -panel, -close; the newsletter popup's, the one popup since piece 4b). The card's own form has its status region.
 */
export function PopupDialog({
  name,
  titleId,
  closeLabel,
  onClose,
  children,
}: {
  name: "newsletter";
  titleId: string;
  closeLabel: string;
  onClose: () => void;
  children: (close: ReactNode) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(true);
  const mark = (part: string) => ({ [`data-${name}-${part}`]: "" });

  // Open as a modal, lock the page, focus ✕; on close unlock and give the focus back.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const unlock = lockPageScroll();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>(`[data-${name}-close]`)?.focus();
    // D: the backdrop fades in and the card rises (CSS transitions from the closed state; none with reduced motion)
    const frame = requestAnimationFrame(() => dialog.setAttribute("data-on", ""));
    return () => {
      cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      unlock();
      if (returnFocus.current && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [name]);

  // A downward swipe on the sheet closes it: the sheet follows the finger (not with reduced motion) and closes when let go far
  // enough down, otherwise it springs back. Only from the top of the sheet's own scroll and only downwards, so scrolling a tall card
  // still works. A non-passive listener, so the page does not scroll (or refresh) meanwhile.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let dy = 0;
    const reset = () => {
      panel.removeAttribute("data-dragging");
      panel.style.transform = "";
    };
    const onStart = (e: TouchEvent) => {
      start = e.touches.length === 1 && panel.scrollTop <= 0 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      dragging = false;
      dy = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const ddx = e.touches[0].clientX - start.x;
      const ddy = e.touches[0].clientY - start.y;
      if (!dragging) {
        if (ddy <= 0 || Math.abs(ddx) > ddy) {
          start = null; // up or sideways: the card's own scrolling
          return;
        }
        dragging = true;
        panel.setAttribute("data-dragging", "");
      }
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, ddy);
      if (!reducedMotion()) panel.style.transform = `translateY(${dy}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      const wasDragging = dragging;
      start = null;
      dragging = false;
      if (!wasDragging) return;
      if (e.type === "touchend" && dy >= SWIPE_CLOSE_PX) onClose();
      else reset();
    };
    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onEnd);
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={modal.dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      {...mark("popup")}
      onKeyDown={(e) => trapTab(e, ref.current)} // Tab stays inside
      // Esc fires "cancel": closing goes through onClose, so the popup's state stays the source of truth.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Closed by the browser itself: follow. The event comes a moment later, so a dialog opened again meanwhile (React's
      // development re-run of the effect) is not closed by an old close.
      onClose={(e) => {
        if (!e.currentTarget.open) onClose();
      }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.hasAttribute(`data-${name}-backdrop`)) onClose();
        else if (target.closest("a[href]")) {
          // A ctrl/cmd-, shift- or alt-click (or any but the main button) opens the link elsewhere: this page stays, and so do the
          // popup and its focus.
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          // on to the link: the focus belongs to the next page, not back to this one
          returnFocus.current = false;
          onClose();
        }
      }}
    >
      <div className={modal.backdrop} {...mark("backdrop")} aria-hidden="true" />
      <div ref={panelRef} className={`${modal.panel} ${styles.panel}`} {...mark("panel")} data-fab-avoid="">
        {children(
          <button type="button" className={`${modal.close} ${styles.close}`} aria-label={closeLabel} onClick={onClose} {...mark("close")}>
            <Icon name="close" size={20} />
          </button>,
        )}
      </div>
    </dialog>
  );
}
