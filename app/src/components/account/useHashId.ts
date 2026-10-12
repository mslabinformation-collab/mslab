"use client";

import { useSyncExternalStore } from "react";
import { parseRowId } from "@/lib/row-id";

// The registration an account page is about, from the address's fragment (phase protocols): an account page never has a query (the
// middleware moves ?id= into the fragment), so the protocol's and the feedback form's pages are /konto/protokoll#id=<n>, /konto/tagasiside#id=<n>.

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The fragment's id (#id=<n>; the login mark may come first: #sisse&id=<n>), or null without one that can be a row id. */
export const hashId = (): number | null => parseRowId(new URLSearchParams(window.location.hash.slice(1)).get("id") ?? "");

/** The page's registration: undefined while it is not known (the static shell's server render, and its hydration), null without one. */
export function useHashId(): number | null | undefined {
  return useSyncExternalStore(subscribe, hashId, () => undefined);
}
