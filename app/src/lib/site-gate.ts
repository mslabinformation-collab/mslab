// The coming-soon gate (hotfix 08.10): mslab.ee serves the new site while its content is still sample content, so with the
// setting SITE_GATE on, a visitor is answered with the coming-soon page (app/tulekul/[locale]) whatever the address,
// and only an admin's preview cookie (lib/preview-cookie.ts) lets the request through to the site as it is. Unset (local
// development, the e2e run) the site behaves exactly as without it; the launch removes SITE_GATE. The decision is a plain
// function (tested without Next.js); src/middleware.ts answers with it.

import { verifyPreview } from "./preview-cookie";
import { ROOT_FILE_SOURCE } from "./root-files";

/**
 * The coming-soon page of each language: what the middleware rewrites a gated page request to. Under its own root layout
 * (app/tulekul/[locale]), not the site's app/[locale]: built with the app and read from nothing. Not a page of the site:
 * asked for by its address (gate off, or an admin), lib/site-routing.ts answers with the 404 page.
 */
export const GATE_PAGES = { et: "/tulekul/et", ru: "/tulekul/ru" } as const;

export type GatePage = (typeof GATE_PAGES)[keyof typeof GATE_PAGES];

/** The two settings, as process.env has them (server/env.ts gateEnv). */
export type GateEnv = { SITE_GATE?: string; PREVIEW_SECRET?: string };

/**
 * What the gate reads of a request: the path, the method, the preview cookie, and (for an /api address) how the browser
 * asks: the Sec-Fetch-Mode and Accept headers (absent or null when the request has none), and `action`: it carries
 * Next.js's Next-Action header (a server action, posted to the address of the page it was sent from).
 */
export type GateRequest = {
  path: string;
  method: string;
  cookie: string | undefined;
  fetchMode?: string | null;
  accept?: string | null;
  action?: boolean;
};

export type GateDecision =
  /** answered as without the gate */
  | { kind: "pass" }
  /** answered with the coming-soon page of `page`'s language, or (`json`: an /api address a script calls) a 404 JSON */
  | { kind: "gate"; page: GatePage; json: boolean };

const PASS: GateDecision = { kind: "pass" };

/** Values of SITE_GATE that mean off. Unset or blank is off too; any other value is on, so a typo keeps the site closed. */
const OFF = new Set(["0", "false", "off", "no"]);

/** Is the gate on for this value of SITE_GATE? */
export function gateOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && !OFF.has(v);
}

/**
 * Addresses answered by the app itself, gate or not. Each ends at a path boundary or is one exact file, as in
 * lib/site-routing.ts ("/administrator" or "/admin.php" are gated):
 * - the admin area and its API, and signing in and out (api/auth: request, verify, logout);
 * - Vercel's daily cron, Bunny's webhook, Montonio's webhook (api/payments/notify, phase 2b: it must reach the app while the site is gated,
 *   and only that one address: the return and the rest of /api/payments stay gated), and the newsletter's links (api/newsletter: the unsubscribe link of the welcome mail, which opens its own page and
 *   sends the visitor on to "/" after the button, and the old confirm link, which sends the visitor on to "/"; there the coming-soon page shows the notice);
 * - Next.js's own files, the uploaded images (/media) and the static files at the root (lib/root-files.ts, the list the
 *   routing uses too: the logo, the icons, the link preview picture, robots.txt, the seed pictures, the review widget's
 *   script); tests/unit/site-gate.test.ts checks every entry of public/ against it. The design-review hub (public/guide,
 *   public/p) is gated: it shows the prototypes.
 * Fonts are Next.js's files (/_next/static/media). Not here, so gated: the client account and its API, /api/feedback,
 * the hub and every page of the site.
 */
const THROUGH = new RegExp(`^\\/(admin(\\/|$)|api\\/(auth|admin|cron|newsletter)(\\/|$)|api\\/bunny\\/webhook$|api\\/payments\\/notify$|_next\\/|media(\\/|$)|${ROOT_FILE_SOURCE})`);

/**
 * A path the router could read as another one: a dot segment ("/admin/../konto"), an encoded dot, slash or backslash, a
 * backslash, or two slashes in a row. A browser never sends one (the URL parser removes real dot segments before the
 * middleware sees the path); such a path never goes through, whatever its first segment.
 */
const UNCLEAN = /(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|\\|\/\//i;

/** Is `path` one of the addresses that always go through (see THROUGH)? */
export function alwaysThrough(path: string): boolean {
  return THROUGH.test(path) && !UNCLEAN.test(path);
}

/** RFC 9110's qvalue: 0 to 1 with at most three decimals ("0", "0.", "0.000", "0.8", "1", "1.000"). */
const QVALUE = /^q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/i;

/**
 * The q value of one Accept entry's parameters ("q=0.8" → 0.8). "q=0", "q=0.0" and "q=0.000" are 0: not acceptable. No q,
 * or one that is not a qvalue ("q=", "q=abc", "q=1.5", "q=0.1234"), is the default of 1 (RFC 9110): a malformed weight
 * is no weight, and never turns an acceptable range into an unacceptable one.
 */
function quality(params: string[]): number {
  const q = params.map((p) => QVALUE.exec(p.trim())).find(Boolean);
  return q ? Number(q[1]) : 1;
}

/**
 * Does an Accept header prefer HTML to JSON? text/html must be listed with a q above 0, and above application/json's
 * (or as high and listed first). "*" + "/*" alone (fetch's default) is no preference for HTML.
 */
export function prefersHtml(accept: string | null | undefined): boolean {
  let html = { q: 0, at: Infinity };
  let json = { q: 0, at: Infinity };
  (accept ?? "").split(",").forEach((entry, at) => {
    const [type, ...params] = entry.split(";");
    const t = type.trim().toLowerCase();
    const q = quality(params);
    if (t === "text/html" && q > html.q) html = { q, at };
    if (t === "application/json" && q > json.q) json = { q, at };
  });
  return html.q > 0 && (html.q > json.q || (html.q === json.q && html.at < json.at));
}

/**
 * Is the request a browser opening the address as a page (a GET or HEAD that is a navigation) rather than a script's fetch
 * or XHR? A link to an /api address (the account's login link in an e-mail) is opened so, and gets the coming-soon page
 * instead of raw JSON. So does that page's own server action (a POST with Next-Action, which goes to the address the page
 * was opened at): its newsletter form works there too. Any other request never does (a form POST stays an API call).
 * Sec-Fetch-Mode, when the request has it, decides alone: "navigate" is a page, any other value (cors, no-cors,
 * same-origin, …) is not, whatever Accept says (a script can send Accept: text/html, and a navigation can send an
 * Accept that names no HTML). Only a request without it (an older browser; a header with no value counts as none) is
 * judged by Accept. Only the kind of answer depends on it, never whether the gate opens.
 */
export function opensAsPage(req: Pick<GateRequest, "method" | "fetchMode" | "accept" | "action">): boolean {
  const method = req.method.toUpperCase();
  if (method === "POST") return req.action === true;
  if (method !== "GET" && method !== "HEAD") return false;
  const mode = req.fetchMode?.trim().toLowerCase();
  if (mode) return mode === "navigate";
  return prefersHtml(req.accept);
}

/** The coming-soon page for `path`: the Russian one for /ru…, the Estonian one for everything else. */
export function gatePage(path: string): GatePage {
  return /^\/ru(\/|$)/.test(path) ? GATE_PAGES.ru : GATE_PAGES.et;
}

/**
 * What the gate does with a request. Gate off: pass. Gate on: the always-through addresses pass, and so does every request
 * with a valid preview cookie; the rest is gated, whatever the method (a server action is a POST to the page's own
 * address: the coming-soon page's newsletter form is answered by the coming-soon page). A gated page is the coming-soon
 * page; a gated /api address is a 404 JSON for a script and the coming-soon page for a browser opening it (opensAsPage:
 * the method and the headers only choose the answer, never open the gate). Without a usable PREVIEW_SECRET no cookie is
 * valid (fail closed). `now` in ms, for the tests.
 */
export async function gateDecision(req: GateRequest, env: GateEnv, now: number = Date.now()): Promise<GateDecision> {
  if (!gateOn(env.SITE_GATE)) return PASS;
  if (alwaysThrough(req.path)) return PASS;
  if (await verifyPreview(req.cookie, env.PREVIEW_SECRET, now)) return PASS;
  return { kind: "gate", page: gatePage(req.path), json: /^\/api(\/|$)/.test(req.path) && !opensAsPage(req) };
}
