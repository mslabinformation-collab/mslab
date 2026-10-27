// What the site's modal dialogs share (the image lightbox, the campaign popup, the phone menu; the admin side menu):
// keeping Tab inside, and keeping the page behind still.

/**
 * The elements a modal moves the focus between: what Tab reaches — not a hidden input, nor anything taken out of the tab order (tabindex -1: the
 * newsletter form's honeypot field, which people never see or fill, in the home page's popup).
 */
export const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

type TabKey = { key: string; shiftKey: boolean; preventDefault(): void };

/**
 * Call from a modal's keydown: Tab and Shift+Tab move between the container's focusable elements and wrap around at
 * either end, so the focus never leaves it (a native modal <dialog> would otherwise let it go on to the browser's own
 * controls). From the container itself, Tab goes to the first element and Shift+Tab to the last. Other keys, and a
 * container with nothing focusable, are left to the browser.
 */
export function trapTab(e: TabKey, container: HTMLElement | null): void {
  if (e.key !== "Tab" || !container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) return;
  const at = items.indexOf(container.ownerDocument.activeElement as HTMLElement);
  const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
  e.preventDefault();
  items[next].focus();
}

/**
 * Keeps the page behind a modal from scrolling (prototype B: overflow hidden while a modal is open). Returns the undo,
 * which puts back what was there before, so locks taken one inside another unwind in order.
 */
export function lockPageScroll(): () => void {
  const root = document.documentElement;
  const before = root.style.overflow;
  root.style.overflow = "hidden";
  return () => {
    root.style.overflow = before;
  };
}
