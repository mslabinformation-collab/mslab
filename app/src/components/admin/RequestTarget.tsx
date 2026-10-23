"use client";

import { useEffect } from "react";

/** How long a card reached by its address stays marked (README A7: the highlight is on for 2 s). */
const FLASH_MS = 2000;

/**
 * The deep link of Päringud (README A7): an address that ends in `#p-{id}` (the Õpilased drawer's „Vaata päringutes“) is taken to that card. The card is
 * scrolled to and marked for 2 s (`data-flash`, which the stylesheet turns into the `#faf6f8` background); under `prefers-reduced-motion` it is reached but not
 * marked. A card inside the closed fold „Tehtud ({n})“ opens the fold first. The browser's own scroll to a fragment is not enough: the router changes the
 * address with pushState, which does not set `:target`, and a shut `<details>` is not opened by every browser.
 *
 * Draws nothing. It reads the address when the page appears and again when the fragment changes (Back, a link on the page); an address with no card
 * does nothing.
 */
export function RequestTarget() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let marked: Element | null = null;
    const unmark = () => {
      clearTimeout(timer);
      marked?.removeAttribute("data-flash");
      marked = null;
    };
    const reach = () => {
      const found = /^#p-(\d+)$/.exec(window.location.hash);
      const card = found ? document.getElementById(`p-${found[1]}`) : null;
      if (!card) return;
      unmark();
      const fold = card.closest("details");
      if (fold && !fold.open) fold.open = true;
      card.scrollIntoView({ block: "start" });
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      marked = card;
      card.setAttribute("data-flash", "");
      timer = setTimeout(unmark, FLASH_MS);
    };
    reach();
    window.addEventListener("hashchange", reach);
    return () => {
      window.removeEventListener("hashchange", reach);
      unmark();
    };
  }, []);
  return null;
}
