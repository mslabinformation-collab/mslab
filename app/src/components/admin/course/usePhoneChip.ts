"use client";

import { useSyncExternalStore } from "react";

// Below 900 px (README Q3: the phone top bar; Sidebar.tsx's WIDE) the page's SaveStatus chip stands under the H1 in its short form (strings.md D1:
// „✓ Mustand 14:02“). The server render and the first paint have the full one. (ProtocolScreen.tsx has the same reading of the width for its chip.)

const WIDE = "(min-width: 900px)";

/** Told when the window crosses 900 px. */
function onWidth(tell: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const wide = window.matchMedia(WIDE);
  // (iOS before 14 has only the older addListener)
  if (typeof wide.addEventListener === "function") {
    wide.addEventListener("change", tell);
    return () => wide.removeEventListener("change", tell);
  }
  wide.addListener(tell);
  return () => wide.removeListener(tell);
}
const narrowNow = (): boolean => typeof window.matchMedia === "function" && !window.matchMedia(WIDE).matches;
const wideOnServer = (): boolean => false;

/** True below 900 px. */
export const usePhoneChip = (): boolean => useSyncExternalStore(onWidth, narrowNow, wideOnServer);
