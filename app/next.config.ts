import { resolve } from "node:path";
import type { NextConfig } from "next";
import { MEDIA_CSP } from "./src/server/media";

/**
 * The e2e run's production build (E2E_PROD_BUILD=1, tests/e2e/target.ts) keeps its pages in Next.js's own file cache
 * through a thin wrapper that lets the tests mark every page stale after writing to the database directly
 * (tests/e2e/page-cache.cjs). Only when the e2e run builds and starts the app with E2E_PAGE_CACHE set, and never in a
 * Vercel build (VERCEL is set there), whatever the project's variables say.
 */
const e2ePageCache = process.env.E2E_PAGE_CACHE && !process.env.VERCEL ? { cacheHandler: resolve(process.cwd(), "tests/e2e/page-cache.cjs") } : {};

const nextConfig: NextConfig = {
  // Don't let `next dev` write AGENTS.md / CLAUDE.md into the project.
  agentRules: false,
  // No "X-Powered-By: Next.js" on responses (N12).
  poweredByHeader: false,
  // The design-review hub (public/guide, public/p/<dir>) must keep its trailing slash ("/guide/"): its pages use
  // relative asset URLs. Next's own "/x/" → "/x" redirect is off; src/middleware.ts makes it for every other path.
  skipTrailingSlashRedirect: true,
  experimental: {
    // How long the browser's client router keeps a cached page it has visited or prefetched (x-nextjs-stale-time) before
    // asking again: the public pages are served from the cache (incremental static regeneration), and an open tab should
    // see an admin's change on its next navigation within this time. 30 s is the least Next.js accepts (default 300).
    staleTimes: { dynamic: 0, static: 30 },
  },
  env: {
    // Review tools: Maria's comment widget (public/feedback.js) on every public page and (Dim 22.10) every admin page, posting to /api/feedback.
    // On ("1") for the review builds; switched off ("0") at the mslab.ee launch. Inlined at build time, not a secret.
    NEXT_PUBLIC_REVIEW_TOOLS: "1",
    // The test page (phase 4, piece 1, spec §6): the instant a "markedAt": "deploy" of src/data/testplan.json reads as when
    // tools/testplan-stamp.mjs was skipped, i.e. this build's time. Inlined at build time; not a secret and not a configured variable.
    TESTPLAN_BUILD_AT: new Date().toISOString(),
  },
  ...e2ePageCache,
  // The PDFs' fonts (the certificate, phase 3d; the invoices, phase 4; the contracts, phase 4 piece 3): server/certificate-pdf.ts reads
  // app/assets/fonts with fs on every download, and the invoice's and the contract's PDFs draw with its fonts, so `next build` must put the
  // folder into every function that renders a PDF:
  // - the certificate: the account API (/api/konto/[[...path]]) and Maria's download (/api/admin/tunnistus/[id]);
  // - an invoice: the same account API (the student's download), Maria's download (/api/admin/arve), the sample of Seaded
  //   (/api/admin/naidisarve), the payment routes and the cron's sweep (each settles a payment, whose paid mail carries its invoice) and
  //   the admin pages, whose actions send an invoice by mail (/admin/**);
  // - a contract: the same account API (the student's download, her „Kinnitan“) and payment routes (the paid e-course's mail), the admin
  //   pages (Maria's resend), Maria's download (/api/admin/leping) and Seaded's sample (/api/admin/naidisleping), and the public course page
  //   (/[locale]/koolitused/[slug]), whose registration form's action (server/actions/public.ts registerContact) mails the contract's PDF with
  //   the confirmation.
  // Turbopack matches these keys by glob against the route's name: "/**" works, the bracketed route names do not (checked with a
  // build on 15.10.2026), so each key names the route's folder, a bracketed folder as "*": the course page's key is "/*/koolitused/**".
  // The match is not anchored at the start (the route groups' folders, "(site)", stand between "/[locale]" and "/koolitused"): the key
  // reaches the catalogue page and Maria's course pages too, which carry the folder anyway. Checked with a build on 17.10.2026, a marker
  // file per key: "/*/koolitused/**" reached the course page's function; "/[locale]/koolitused/[slug]" and "/[[]locale]/koolitused/**"
  // reached nothing. Turbopack's own file trace had already put the folder there (the action's code reaches the fonts' read), but a key
  // does not hang on that.
  outputFileTracingIncludes: {
    "/api/konto/**": ["./assets/fonts/**"],
    "/api/admin/tunnistus/**": ["./assets/fonts/**"],
    "/api/admin/arve/**": ["./assets/fonts/**"],
    "/api/admin/naidisarve/**": ["./assets/fonts/**"],
    "/api/admin/leping/**": ["./assets/fonts/**"],
    "/api/admin/naidisleping/**": ["./assets/fonts/**"],
    "/api/payments/**": ["./assets/fonts/**"],
    "/api/cron/**": ["./assets/fonts/**"],
    "/admin/**": ["./assets/fonts/**"],
    "/*/koolitused/**": ["./assets/fonts/**"],
  },
  // Every answer (pages, API, /media and the static files of public/, the hub included):
  // - the whole host stays out of search engines until launch on mslab.ee;
  // - pages may be framed by this site's own pages only (the hub /guide/ shows the prototypes /p/<dir>/ in a
  //   same-origin frame);
  // - links to other sites carry the origin only.
  // A redirect made by src/middleware.ts sets its own X-Robots-Tag. The admin area and the login endpoints answer per
  // visitor and are never cached (by the browser or a CDN); the client account's API is private to the visitor too, and
  // its login link keeps its token out of the Referer, and so does a lesson file's redirect (the lesson's address). /_next/static files get Next.js's own year-long immutable
  // Cache-Control.
  // A header given here replaces the one a route sets itself, and of two rules for the same path and header the later
  // one wins: so the routes with a stricter value of their own get it here again, after the rule for every path.
  async headers() {
    const noStore = [{ key: "Cache-Control", value: "no-store" }];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      { source: "/admin/:path*", headers: noStore },
      { source: "/api/auth/:path*", headers: noStore },
      { source: "/api/admin/:path*", headers: noStore },
      // Maria's invoice and contract downloads (invoices Task 5; contracts Task 5): the PDF, the month's CSV and the samples are private as well as never kept
      // (the rule above would leave them at plain no-store: a header given here replaces the route's own); so is the campaign editor's preview (newsletter
      // campaigns Task 4), the mail of a campaign not yet saved
      ...["/api/admin/arve/:id", "/api/admin/arved", "/api/admin/naidisarve", "/api/admin/leping/:id", "/api/admin/naidisleping", "/api/admin/kampaania-eelvaade"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      })),
      // the client account's API: one visitor's data, never kept by a CDN or a shared cache (server/account-api.ts)
      { source: "/api/konto/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      // uploaded images: nothing in them may run (server/media.ts)
      { source: "/media/:path*", headers: [{ key: "Content-Security-Policy", value: MEDIA_CSP }] },
      // the login link: its token is in the address, so it is never sent on as a Referer (api/auth/verify/route.ts)
      { source: "/api/auth/verify", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // the client login link: its token is in the address, so it is never sent on as a Referer
      { source: "/api/konto/verify", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // the bank's way back (api/payments/return, phase 2b): the signed order token is in the address, so it is never sent on as a Referer; the
      // answer (a 303 to /makse) is never kept. Only this address: the webhook and the rest of /api/payments keep the site's defaults.
      { source: "/api/payments/return", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      // the unsubscribe page (api/newsletter/loobu): same-origin, so nothing goes to another site and its own form's POST keeps its Origin.
      // It must NEVER be no-referrer: a form posted from a document with that policy carries `Origin: null`, which the route's cross-site
      // check refuses, and the button would always answer 403. (The link's token is in the address, but the page has no link or resource that
      // leaves the site.)
      { source: "/api/newsletter/loobu", headers: [{ key: "Referrer-Policy", value: "same-origin" }] },
      // the pay page of the "Maksa" link (/maksa/<token>, phase 2b: server/pay-page.ts): never cached, and same-origin for the same reason as the
      // unsubscribe page — its button's POST must keep its Origin (never no-referrer: `Origin: null` is refused as cross-site). The page has no
      // link or resource that leaves the site, so the token in its address goes nowhere.
      { source: "/maksa/:token", headers: [{ key: "Referrer-Policy", value: "same-origin" }, { key: "Cache-Control", value: "no-store" }] },
      // a lesson file: the 302 to R2 (server/account-api.ts fileAnswer) must not pass the lesson's address on as a Referer
      { source: "/api/konto/kursus/:slug/:lesson/fail/:file", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // a practical work's photo (e-course completion, R5): the 302 to R2 (server/account-api.ts photoAnswer) must not pass the page's
      // address on as a Referer; the full photo and its thumbnail (…/pisi)
      { source: "/api/konto/praktiline/foto/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
