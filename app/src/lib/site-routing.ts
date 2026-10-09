// Where a request path goes: the decisions of src/middleware.ts as plain functions, without Next.js (tested on their own).
// ET lives at "/", RU at "/ru"; internally both render app/[locale]/…

import { ROOT_FILE_SOURCE } from "./root-files";
import { parseRowId } from "./row-id";
import { isSlug } from "./slug";

// Paths the app serves as they are (no "/et" rewrite). The hub (guide, p/…) and /api are handled before this list.
// Every entry ends at a path boundary or is one exact file: "/admin.php", "/administrator" or "/media.php" are unknown
// addresses (the cached 404 page), not the admin or /media. The static files are lib/root-files.ts's list, which the
// coming-soon gate shares. The pay page of a registration (/maksa/<token>, phase 2b) is a route handler at its own path: one segment after it,
// nothing deeper.
const PASS = new RegExp(`^\\/(ru(\\/|$)|admin(\\/|$)|media(\\/|$)|_next(\\/|$)|maksa\\/[^/]+$|${ROOT_FILE_SOURCE})`);

/** API routes answer at their own path: no trailing-slash or locale redirect (a POST must not be redirected). */
const API = /^\/api(\/|$)/;

/**
 * The design-review hub (public/guide, public/p/<dir>): static folders whose index.html pages use relative asset URLs,
 * so they must be opened with the trailing slash ("/guide/", "/p/d/"). Next.js serves public files only by their file
 * name, so the middleware redirects "/guide" to "/guide/" and serves guide/index.html there.
 */
const HUB = /^\/(guide(\/|$)|p\/)/;

/**
 * The canonical form of a site path: no trailing slash ("/koolitused/" → "/koolitused", Next's own redirect, which is off),
 * no "/et" prefix ("/et/x" → "/x"), and never two leading slashes or a slash and a backslash: Next.js sends a same-origin
 * redirect as a relative Location, and "//evil.example" or "/\evil.example" there would leave the site.
 */
export function canonicalPath(pathname: string): string {
  let path = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
  if (path.startsWith("/et/") || path === "/et") path = path.slice(3) || "/";
  return path.replace(/^[/\\]{2,}/, "/");
}

/**
 * The cart of one course ("/ostukorv?kursus=x", "/ru/ostukorv?kursus=x") is served from a page of its own,
 * "/<locale>/ostukorv/x": the public pages are cached by their path alone (incremental static regeneration), so a
 * page whose content depends on the query could not be. The address bar keeps the visitor's URL. null: not a cart
 * with a course.
 */
export function cartPage(pathname: string, search: URLSearchParams): string | null {
  const m = /^(\/ru)?\/ostukorv$/.exec(pathname);
  const course = search.get("kursus")?.trim();
  if (!m || !course) return null;
  return `/${m[1] ? "ru" : "et"}/ostukorv/${encodeURIComponent(course)}`;
}

/** The client account's shells (/konto…, /ru/konto…) as pages of the app, with their locale: "/et/konto/sisene", "/ru/konto/kursus/x", "/et/konto/kursus/x/12". */
const ACCOUNT_SHELL = /^\/(et|ru)\/konto(\/|$)/;

/**
 * The pages of app/[locale]/(site) without their locale (tests/unit/site-routing.test.ts checks them against the app),
 * with the client account's shells (/konto…, phase 2a: the login page, favourites and my details). The pages with a slug or an
 * id are the patterns below: a course, a news item, an e-course in the account and (phase 3a) one lesson of it, a course's cart.
 */
const STATIC_PAGES = new Set([
  "", "/kontakt", "/konto", "/konto/andmed", "/konto/lemmikud", "/konto/sisene", "/koolitaja", "/koolitused", "/koolituskalender", "/ostukorv",
  "/praktika", "/privaatsus", "/tingimused", "/uudised",
]);
/** Pages with a slug of ours (lowercase letters, digits, dashes), an e-course in the account too; the cart takes whatever ?kursus= says (its own 404). */
const SLUG_PAGE = /^\/(koolitused|uudised|konto\/kursus)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CART_PAGE = /^\/ostukorv\/[^/]+$/;
/**
 * One lesson of an e-course in the account (phase 3a): /konto/kursus/<slug>/<lesson id>. The slug is checked by isSlug (lib/slug.ts:
 * also at most 80 characters) and the id by parseRowId (lib/row-id.ts), the rules the page and the API read them with.
 */
const LESSON_PAGE = /^\/konto\/kursus\/([^/]+)\/([1-9][0-9]{0,9})$/;

/** Is `rest` (a page without its locale) one lesson's address: a slug of ours and an id the database can hold (≤ 2 147 483 647)? */
const isLessonPage = (rest: string): boolean => {
  const m = LESSON_PAGE.exec(rest);
  return m !== null && isSlug(m[1]) && parseRowId(m[2]) !== null;
};

/**
 * Every address without a page of its own is served from this one page per locale (app/[locale]/(site)/[...rest] →
 * not-found.tsx, status 404): rendered once and cached like any page, instead of a render per unknown address (a scan
 * of /wp-admin, /.env and the like would otherwise cost a render each, and could not fill the cache either).
 */
export const NOT_FOUND_SEGMENT = "leidmata";

/** Does `page` ("/et/koolitused/x") name a page of the site? false: it is served from the locale's 404 page. */
export function isKnownPage(page: string): boolean {
  const rest = page.replace(/^\/(et|ru)(?=\/|$)/, "");
  return STATIC_PAGES.has(rest) || SLUG_PAGE.test(rest) || CART_PAGE.test(rest) || isLessonPage(rest);
}

/** The 404 page of a locale ("/et/leidmata"). */
export const notFoundPage = (page: string): string => `/${page.startsWith("/ru") ? "ru" : "et"}/${NOT_FOUND_SEGMENT}`;

export const isNotFoundPage = (page: string): boolean => page === `/et/${NOT_FOUND_SEGMENT}` || page === `/ru/${NOT_FOUND_SEGMENT}`;

export type SiteRoute =
  /** the design-review hub (static files; the middleware serves its index pages under `next dev`) */
  | { kind: "hub" }
  /** /api/…: answered at its own path */
  | { kind: "api" }
  /** a permanent redirect to the canonical path (same query) */
  | { kind: "redirect"; path: string }
  /** a public page of app/[locale]: `page` is the path it renders ("/et/koolitused"); `rewritten` when it is not the
   *  visitor's own path (the ET rewrite, the cart) */
  | { kind: "page"; page: string; rewritten: boolean }
  /** an account shell asked for with a query: answered with a 303 to `location`, the same path with the parameters it knows in the fragment (accountShellTarget) */
  | { kind: "shellRedirect"; location: string }
  /** admin, /media, Next.js files and static files: served as they are */
  | { kind: "other" };

/** The parameters of the account's pages that travel in the fragment: the browser reads them there (LoginForm), and a fragment never reaches a server, a log or a cache. */
const FRAGMENT_PARAMS = ["viga", "korda", "email", "kood"] as const;
/** A longer value is no e-mail address or flag of ours: dropped. */
const FRAGMENT_VALUE_MAX = 254;

/**
 * Where a request for the account shell `path` (a clean, known path such as "/konto/sisene" or "/ru/konto/kursus/x") that carries a
 * query is sent instead: the same path, with the parameters the page knows (viga, korda, email, kood; the first of each, URL-encoded) moved
 * into the fragment, and everything else dropped. Next.js keeps the address of the request that renders a page (path and query) in
 * the page it caches, for every later visitor; so no request with a query may reach a shell. Built from `path` and the query only.
 */
export function accountShellTarget(path: string, search: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const name of FRAGMENT_PARAMS) {
    const value = search.get(name);
    if (value !== null && value.length <= FRAGMENT_VALUE_MAX) kept.set(name, value);
  }
  const fragment = kept.toString();
  return fragment ? `${path}#${fragment}` : path;
}

/** Does `search` carry a query at all (a bare "?" does not)? */
const hasQuery = (search: URLSearchParams): boolean => search.keys().next().done !== true;

/** What the middleware does with `pathname` (and its query, for the cart and the account's shells). */
export function routeSitePath(pathname: string, search: URLSearchParams): SiteRoute {
  if (HUB.test(pathname)) return { kind: "hub" };
  if (API.test(pathname)) return { kind: "api" };
  // The trailing-slash and "/et" redirects, in one permanent redirect.
  const path = canonicalPath(pathname);
  if (path !== pathname) return { kind: "redirect", path };
  const cart = cartPage(pathname, search);
  if (cart) return { kind: "page", page: cart, rewritten: true };
  if (/^\/ru(\/|$)/.test(pathname)) return known(pathname, false, pathname, search); // app/[locale]=ru directly
  if (PASS.test(pathname)) return { kind: "other" };
  return known("/et" + (pathname === "/" ? "" : pathname), true, pathname, search);
}

/**
 * A page of the site as it is, or else its locale's 404 page (the address bar keeps the visitor's URL). A known account shell asked
 * for with a query is not rendered at all, whatever the method: it is a shellRedirect to the same path (`path`, the visitor's own,
 * already checked to be this very page) with the parameters in the fragment.
 */
function known(page: string, rewritten: boolean, path: string, search: URLSearchParams): SiteRoute {
  if (!isKnownPage(page)) return { kind: "page", page: notFoundPage(page), rewritten: true };
  if (ACCOUNT_SHELL.test(page) && hasQuery(search)) return { kind: "shellRedirect", location: accountShellTarget(path, search) };
  return { kind: "page", page, rewritten };
}
