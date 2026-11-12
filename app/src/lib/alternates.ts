import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";

// SEO G3: the canonical address and the language links (hreflang) of a public page, as site paths. `metadataBase`
// (shareMetadata in the locale layout) makes them absolute on SITE_URL. Next replaces a parent's `alternates` wholesale,
// so every public page sets its own, with this.

/** The pages with a fixed address that the sitemap lists (SEO G4): the public pages, not the account, cart or payment pages. */
export const PUBLIC_SITEMAP_PATHS = ["/", "/koolitused", "/koolituskalender", "/praktika", "/koolitaja", "/kontakt", "/uudised", "/privaatsus", "/tingimused"] as const;

/** The language links of one page: its address in each language; Estonian is x-default. */
export function languageLinks(path: string): Record<"et" | "ru" | "x-default", string> {
  return { et: href("et", path), ru: href("ru", path), "x-default": href("et", path) };
}

/** `alternates` for the page at `path` (a site path without the locale prefix) shown in `locale`: itself as canonical, both languages as links. */
export function pageAlternates(locale: Locale, path: string): { canonical: string; languages: Record<"et" | "ru" | "x-default", string> } {
  return { canonical: href(locale, path), languages: languageLinks(path) };
}
