// ET lives at "/", RU at "/ru"; internally both render app/[locale]/… The decisions are in lib/site-routing.ts (plain
// functions, tested without Next.js).
import { NextResponse, type NextRequest } from "next/server";
import { PREVIEW_COOKIE } from "@/lib/preview-cookie";
import { gateDecision, gateOn, type GateEnv } from "@/lib/site-gate";
import { routeSitePath } from "@/lib/site-routing";
import { gateEnv } from "@/server/env";
import { logNote } from "@/server/log";

export { canonicalPath, cartPage } from "@/lib/site-routing";

export const ROBOTS = "noindex, nofollow";

/** `req`'s URL with another path (and the same query). A plain URL: a NextURL keeps the original trailing slash. */
function withPath(req: NextRequest, pathname: string): URL {
  const url = new URL(req.url);
  url.pathname = pathname;
  return url;
}

/**
 * The design-review hub (public/guide, public/p/<dir>) must be opened with the trailing slash ("/guide/"): its pages
 * use relative asset URLs. In production the static assets answer these paths before the app; `next dev` serves public
 * files only by their file name, so the same is done here. next.config.ts turns off Next's own trailing-slash redirect
 * (it would send "/guide/" to "/guide"); this middleware makes that redirect for every other path instead.
 */
function hub(req: NextRequest, pathname: string): NextResponse {
  if (pathname.endsWith("/")) return NextResponse.rewrite(withPath(req, `${pathname}index.html`));
  // a folder without its slash: redirected as the static assets do (307)
  if (!pathname.slice(pathname.lastIndexOf("/") + 1).includes(".")) return NextResponse.redirect(withPath(req, `${pathname}/`), 307);
  return NextResponse.next(); // a file of the hub (image, script, style)
}

/**
 * With the coming-soon gate off (SITE_GATE unset: local development, the e2e run) this is the site's routing alone, answered
 * as it always was. With it on, the gate decides first (lib/site-gate.ts) and a request it lets through (an admin's preview
 * cookie, the admin area, the sign-in, the crons, the static files) gets the same routing.
 */
export function middleware(req: NextRequest): NextResponse | Promise<NextResponse> {
  // each setting named in full (process.env.NAME), the form every runtime and bundler of the middleware is sure to provide
  const env = gateEnv({ SITE_GATE: process.env.SITE_GATE, PREVIEW_SECRET: process.env.PREVIEW_SECRET });
  if (!gateOn(env.SITE_GATE)) return noindex(route(req));
  return gated(req, env);
}

/** "PREVIEW_SECRET is not set" is noted once per instance, not on every request. */
let notedNoSecret = false;

async function gated(req: NextRequest, env: GateEnv): Promise<NextResponse> {
  if (!env.PREVIEW_SECRET && !notedNoSecret) {
    notedNoSecret = true;
    logNote(
      "[gate] SITE_GATE is on but PREVIEW_SECRET is not set or shorter than 32 characters: no preview cookie is valid, so admins see the coming-soon page too; only /admin, /api/auth, /api/admin, /api/cron, /api/bunny/webhook, /api/payments/notify, /maksa/<token>, /api/newsletter, /_next, /media and the static files go through",
    );
  }
  const { pathname } = req.nextUrl;
  const gate = await gateDecision(
    {
      path: pathname,
      method: req.method,
      cookie: req.cookies.get(PREVIEW_COOKIE)?.value,
      fetchMode: req.headers.get("sec-fetch-mode"),
      accept: req.headers.get("accept"),
      action: req.headers.has("next-action"),
    },
    env,
  );
  if (gate.kind === "pass") return noindex(route(req));
  if (gate.json) {
    // a script's call to a gated /api address: no page, "not here", never kept, and noindex said here (an answer of the
    // middleware's own). A browser opening such an address (a mailed login link) gets the coming-soon page below.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store", "X-Robots-Tag": ROBOTS } });
  }
  // The coming-soon page, built once (static) and the same for every address: the visitor's address and query stay in the
  // address bar (the newsletter's confirm notice reads ?uudiskiri there), and next.config headers() add X-Robots-Tag.
  return NextResponse.rewrite(withPath(req, gate.page));
}

/**
 * The whole host stays out of search engines until launch. Every answer gets X-Robots-Tag from next.config headers();
 * a redirect made here also sets it here, so it carries the header wherever it is answered (and so does the gate's 404 for
 * an /api address, above). Only answers made here: setting it on a rewrite or a pass-through too could send the value twice.
 */
function noindex(res: NextResponse): NextResponse {
  if (res.status >= 300 && res.status < 400) res.headers.set("X-Robots-Tag", ROBOTS);
  return res;
}

/**
 * An account shell asked for with a query (any method: a scanner's HEAD, a stray POST): 303 to the same path with the parameters the
 * page knows in the fragment, which only the browser sees (LoginForm reads them there). Next.js keeps the address of the request that
 * renders a page, query included, in the page it caches for every later visitor, and nothing the middleware does to a request
 * (a rewrite) changes that address; so no request with a query may ever reach a shell. One exception the middleware cannot see:
 * Next.js strips `_rsc` before it runs, so `?_rsc=<text>` without an RSC header still renders a shell; the stored text is
 * percent-encoded, the router uses the real address, and no app link or browser makes such a request (checked live in Task 11). The answer is never kept (no-store). The
 * Location is made of the matched shell path and the fragment only, a path that starts with one slash (so it keeps the request's own
 * origin, whatever the request says); Next.js's adapter, which cannot take a relative Location from a middleware, wants it absolute
 * and sends it on as a relative path (the same host as the request).
 */
function shellRedirect(req: NextRequest, location: string): NextResponse {
  const res = NextResponse.redirect(new URL(location, req.url), 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

function route(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const to = routeSitePath(pathname, req.nextUrl.searchParams);
  switch (to.kind) {
    case "hub":
      return hub(req, pathname);
    case "redirect":
      return NextResponse.redirect(withPath(req, to.path), 308);
    case "shellRedirect":
      return shellRedirect(req, to.location);
    case "page": {
      if (!to.rewritten) return NextResponse.next(); // /ru/* renders app/[locale]=ru directly
      const url = req.nextUrl.clone();
      url.pathname = to.page;
      return NextResponse.rewrite(url);
    }
    default:
      return NextResponse.next(); // API, admin, media and static files untouched
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
