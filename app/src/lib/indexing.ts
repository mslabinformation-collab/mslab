// SEO G1: the one decision whether search engines may index the site. The next.config headers (at build), the middleware's
// redirects (at run time), the site layout's robots meta and app/robots.ts all ask it, so they can never disagree.
// Indexing is on only when the coming-soon gate is off AND this is Vercel's production environment: the gated site, a local
// run, the e2e run and every preview say noindex exactly as before. Relative imports only: next.config.ts imports this file,
// and its loader does not resolve "@/…" paths (tests/unit/next-config.test.ts checks the chain).

import { gateOn } from "./site-gate";

/** What every answer says to search engines while indexing is off, and what the private areas always say. */
export const NOINDEX = "noindex, nofollow";

/** The two settings the decision reads, as process.env has them (each caller names them in full, process.env.NAME). */
export type IndexingEnv = { SITE_GATE?: string; VERCEL_ENV?: string };

/** May search engines index the site now? The gate is off and this is Vercel production (VERCEL_ENV is exactly "production"). */
export function indexingOn(env: IndexingEnv): boolean {
  return !gateOn(env.SITE_GATE) && env.VERCEL_ENV?.trim() === "production";
}

/**
 * Is `host` (a Host header: any case, maybe with a port) the site's own address, SITE_URL's host? With indexing on only that host
 * is indexable: www.mslab.ee, the *.vercel.app addresses and previews never are. No host, or a SITE_URL that is no URL, is no.
 */
export function indexableHost(host: string | null | undefined, siteUrl: string): boolean {
  if (!host) return false;
  try {
    return host.trim().toLowerCase().replace(/:\d+$/, "") === new URL(siteUrl).hostname;
  } catch {
    return false;
  }
}

/**
 * The next.config `source` patterns that say noindex whatever the host, once indexing is on (G7): the admin area, the API, the
 * client account, the cart, the payment result, the pay page of the mailed link, the design-review hub and its prototypes, and
 * the coming-soon page. robots.txt keeps crawlers out of the same areas (app/robots.ts).
 */
export const PRIVATE_HEADER_SOURCES: string[] = [
  "/admin/:path*",
  "/api/:path*",
  "/konto/:path*",
  "/konto",
  "/ru/konto/:path*",
  "/ru/konto",
  "/ostukorv/:path*",
  "/ostukorv",
  "/ru/ostukorv/:path*",
  "/ru/ostukorv",
  "/makse",
  "/ru/makse",
  "/maksa/:token",
  "/guide/:path*",
  "/p/:path*",
  "/tulekul/:path*",
];

/** A regular-expression source for each private source (`:path*` is the rest of the path, `:token` one segment), built once from the list. */
const PRIVATE_PATTERNS = PRIVATE_HEADER_SOURCES.map((source) => {
  const body = source.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${body.replace(/\/:path\*$/, "(?:/.*)?").replace(/:token/, "[^/]+")}$`);
});

/**
 * Is `pathname` one of the private areas (PRIVATE_HEADER_SOURCES)? The middleware asks it for its own redirects, which next.config's
 * rules do not reach: a redirect of a private path keeps noindex even at the site's own host (SEO G7). Read as the redirect's
 * address is: extra leading slashes, a trailing slash and the /et prefix (all of which the middleware redirects away) do not hide a path.
 */
export function isPrivatePath(pathname: string): boolean {
  const path = pathname.replace(/^\/+/, "/").replace(/^\/et(?=\/|$)/, "").replace(/(?<=.)\/+$/, "") || "/";
  return PRIVATE_PATTERNS.some((pattern) => pattern.test(path));
}

/** The `value` of a next.config `host` condition for `host`: a regular expression that Next anchors itself (^…$), so only the dots need escaping. */
export function hostCondition(host: string): string {
  return host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
