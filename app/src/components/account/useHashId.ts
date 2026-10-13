"use client";

import { useEffect, useState } from "react";
import { parseRowId } from "@/lib/row-id";

// The registration an account page is about, from the address's fragment (phase protocols): an account page never has a query (the
// middleware moves ?id= into the fragment), so the protocol's and the feedback form's pages are /konto/protokoll#id=<n>, /konto/tagasiside#id=<n>.

/** The fragment's id (#id=<n>; the login mark may come first: #sisse&id=<n>), or null without one that can be a row id. */
export const hashId = (): number | null => parseRowId(new URLSearchParams(window.location.hash.slice(1)).get("id") ?? "");

/**
 * The page's registration: undefined until the page has mounted in the browser (the static shell's server render, its hydration, and the
 * first render after a <Link> to it), null without one. The address is read in an effect, never while rendering: Next's HistoryUpdater puts
 * the new address in at the commit of a <Link> navigation, after the new page's first render, so a read during that render still sees the
 * old address and would call the page "not found" for a frame. An effect runs after the commit, with the address in place.
 */
export function useHashId(): number | null | undefined {
  const [id, setId] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setId(hashId());
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return id;
}
