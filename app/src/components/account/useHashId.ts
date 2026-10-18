"use client";

import { useEffect, useState } from "react";
import { isSlug } from "@/lib/slug";
import { parseRowId } from "@/lib/row-id";

// The course an account page is about, from the address's fragment (phase protocols; student reviews): an account page never has a query (the
// middleware moves ?id= into the fragment), so the protocol's and the feedback form's pages are /konto/protokoll#id=<n>, /konto/tagasiside#id=<n>,
// and an e-course's feedback form is /konto/tagasiside#kursus=<slug>.

/** The fragment's id (#id=<n>; the login mark may come first: #sisse&id=<n>), or null without one that can be a row id. */
export const hashId = (): number | null => parseRowId(new URLSearchParams(window.location.hash.slice(1)).get("id") ?? "");

/** The feedback form the fragment names: a contact course's registration (`#id=<n>`) or an e-course's slug (`#kursus=<slug>`). */
export type HashTarget = { id: number } | { kursus: string };

/** The fragment's form: exactly one of `id` (a row id) and `kursus` (a slug of ours, lib/slug.ts isSlug), else null (the form is not found). */
export const hashTarget = (): HashTarget | null => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.has("id") === params.has("kursus")) return null;
  if (params.has("id")) {
    const id = hashId();
    return id === null ? null : { id };
  }
  const kursus = params.get("kursus") ?? "";
  return isSlug(kursus) ? { kursus } : null;
};

/**
 * What `read` finds in the fragment once the page has mounted in the browser, and again when the fragment changes: undefined until then (the static
 * shell's server render, its hydration, and the first render after a <Link> to it). The address is read in an effect, never while rendering: Next's
 * HistoryUpdater puts the new address in at the commit of a <Link> navigation, after the new page's first render, so a read during that render still
 * sees the old address and would call the page "not found" for a frame. An effect runs after the commit, with the address in place.
 * `read` is one of this file's functions, never made while rendering.
 */
function useHash<T>(read: () => T): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    const sync = () => setValue(read());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [read]);
  return value;
}

/** The page's registration (the fragment's id): undefined until the page has mounted, null without one. */
export const useHashId = (): number | null | undefined => useHash(hashId);

/** The page's feedback form (the fragment's id or slug): undefined until the page has mounted, null without a usable one. */
export const useHashTarget = (): HashTarget | null | undefined => useHash(hashTarget);
