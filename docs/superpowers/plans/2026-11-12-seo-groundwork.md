# SEO groundwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search-engine basics (one indexing switch, robots.txt, sitemap, canonical/hreflang, JSON-LD, old-address redirects) that stay inert while mslab.ee is gated and switch on with the launch, with no visible change to any public page.

**Architecture:** One pure decision (`src/lib/indexing.ts`) read by next.config headers (build), the middleware (runtime) and the site layout (render). Metadata routes `app/robots.ts` and `app/sitemap.ts`. Pure JSON-LD builders rendered by one `<JsonLd>` component. Old addresses from a JSON map checked in `routeSitePath` before the canonical redirect.

**Tech Stack:** Next.js 16.3.8 App Router (docs in `app/node_modules/next/dist/docs/`), Drizzle/Postgres, Vitest (unit, happy-dom DOM, PGlite db), Playwright e2e on the Docker DB `mslab-pg`.

**Spec:** `docs/superpowers/specs/2026-11-12-seo-groundwork-design.md`

## Global Constraints
- No visible change to any public page: only `<head>` tags, invisible `<script type="application/ld+json">`, headers, robots.txt, sitemap.xml and redirects. No new visible text, no CSS change.
- While `SITE_GATE` is on, or off Vercel production (`VERCEL_ENV !== "production"`: local, e2e, previews), every answer says exactly what it says today (`X-Robots-Tag: noindex, nofollow`, today's robots.txt text, `robots` meta noindex). The existing tests that pin this (`tests/unit/next-config.test.ts`, `tests/e2e/headers.spec.ts`, `tests/unit/site-gate.test.ts`, middleware tests) keep passing unchanged except where a task says so.
- Only `SITE_URL`'s host is ever indexable (www.mslab.ee, `*.vercel.app`, previews never).
- All work runs from `app/`. Commands: `npx vitest run <files>`, `npx tsc --noEmit -p .`; e2e: `E2E_PROD_BUILD=1 npx playwright test <files> --project=chromium --no-deps --workers=2 --reporter=line > <scratch log>` (Docker DB `mslab-pg` must be up). Never TaskStop a running e2e.
- Never read `app/.env.local`; never print DB URLs or secrets; no real e-mail addresses in tracked files (only `@example.test`).
- `Assets/mslab.WordPress.2026-09-22.xml` is never committed or quoted beyond the addresses listed in Task 4.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicit paths only.
- Comments in the codebase's style: full sentences saying why; cite the spec goal (`SEO G<n>`).

## Review Focus
1. Gate on + Vercel production: nothing indexable anywhere (header, meta, robots.txt), and `/sitemap.xml` shows the coming-soon page to a visitor without the preview cookie.
2. Gate off + production on `www.mslab.ee` or `mslab-flax.vercel.app`: `X-Robots-Tag: noindex` still on every answer.
3. A course title or summary containing `</script>` cannot break out of the JSON-LD script.
4. An old address with a trailing slash (`/product/kulmud-baaskoolitus/`) is ONE redirect, not two; a current page (`/koolitused/`) is not hijacked by the old-address map.
5. The private pages (`/konto…`, `/ostukorv…`, `/makse`) stay noindex after the switch flips.

---

### Task 1: The indexing switch (spec G1, G2, G7)

**Files:**
- Create: `app/src/lib/indexing.ts`, `app/src/app/robots.ts`, `app/tests/unit/indexing.test.ts`, `app/tests/unit/robots-route.test.ts`
- Delete: `app/public/robots.txt`
- Modify: `app/next.config.ts` (`headers()`), `app/src/middleware.ts` (`noindex`, the env it reads), `app/src/app/[locale]/layout.tsx` (`robots`), the account/cart/payment pages' `generateMetadata` (`app/src/app/[locale]/(site)/konto/**`, `ostukorv/**`, `makse/page.tsx`; find each with `generateMetadata`; the cart's shared `cartMetadata`), `app/src/lib/root-files.ts` and `app/tests/unit/site-gate.test.ts` only as far as robots.txt moving from `public/` to `app/robots.ts` needs (it must stay an always-through root file), `app/tests/unit/next-config.test.ts`, middleware unit tests.

**Interfaces (Produces):**
- `indexingOn(env: { SITE_GATE?: string; VERCEL_ENV?: string }): boolean` — `!gateOn(env.SITE_GATE) && env.VERCEL_ENV?.trim() === "production"` (`gateOn` from `lib/site-gate.ts`).
- `indexableHost(host: string | null | undefined, siteUrl: string): boolean` — the host without port, lowercased, equals `new URL(siteUrl).hostname`.
- `NOINDEX = "noindex, nofollow"`.
- `PRIVATE_HEADER_SOURCES: string[]` — next.config `source` patterns that are always noindex: `/admin/:path*`, `/api/:path*`, `/konto/:path*`, `/konto`, `/ru/konto/:path*`, `/ru/konto`, `/ostukorv/:path*`, `/ostukorv`, `/ru/ostukorv/:path*`, `/ru/ostukorv`, `/makse`, `/ru/makse`, `/maksa/:token`, `/guide/:path*`, `/p/:path*`, `/tulekul/:path*` (match today's path style; check with the existing `valueFor` helper of next-config.test).

- [ ] **Step 1: Failing tests.** `indexing.test.ts`: table — gate "1"/unset × VERCEL_ENV production/preview/unset → only (unset gate, production) is true; gate "off"/"0" count as off (gateOn's rules). `indexableHost("mslab.ee", "https://mslab.ee")` true; `"MSLAB.EE:443"` true; `"www.mslab.ee"`, `"mslab-flax.vercel.app"`, `null` false. `next-config.test.ts` new describe "indexing on (gate off, production)": with `SITE_GATE` deleted and `VERCEL_ENV=production` stubbed before loading the config (`vi.stubEnv` + `vi.resetModules` + dynamic import), the `X-Robots-Tag` rule for `/` carries `missing: [{ type: "host", value: "mslab.ee" }]` (so it applies to other hosts only), and `/admin/x`, `/api/feedback`, `/konto`, `/ru/ostukorv/x`, `/makse`, `/guide/` have an unconditional noindex rule; the existing describe (indexing off) is unchanged. `robots-route.test.ts`: off → the rules equal today's `public/robots.txt` (preview bots allowed, `*` disallow `/`); on → `*` allow `/`, disallow the spec G2 list, `sitemap` = `https://mslab.ee/sitemap.xml` (from SITE_URL). Middleware test: a 308 from the canonical redirect has `X-Robots-Tag` when indexing is off; none when on and the host is mslab.ee; present when on and the host is `www.mslab.ee`.
- [ ] **Step 2:** Run them; they fail (module missing / old behaviour).
- [ ] **Step 3: Implement.** `indexing.ts`; next.config `headers()` computes `indexingOn({ SITE_GATE: process.env.SITE_GATE, VERCEL_ENV: process.env.VERCEL_ENV })` and the site host from `process.env.SITE_URL ?? "https://mslab.ee"`: off → today's first rule unchanged; on → the X-Robots-Tag noindex rule gets `missing: [{ type: "host", value: <host> }]`, and a rule per `PRIVATE_HEADER_SOURCES` entry adds the unconditional noindex (placed after the first rule; keep every other rule and the comment block accurate). Middleware: read `VERCEL_ENV` and `SITE_URL` the same explicit way as `SITE_GATE`; `noindex(res, req)` sets the header on its redirects unless `indexingOn(...) && indexableHost(req.headers.get("host"), siteUrl)`. Layout: `robots` = `{ index: false, follow: false }` unless `indexingOn(process.env…)`, else omit. Private pages: each sets `robots: { index: false, follow: false }` in its own metadata always. `app/robots.ts` (`MetadataRoute.Robots`) returns the off/on rules; delete `public/robots.txt`; keep robots.txt an always-through root file for the gate and the routing (adjust `root-files.ts`' comment/list and the site-gate test that checks `public/` against the list, the way `icon.svg` from `app/` is handled).
- [ ] **Step 4:** Run the new tests + `tests/unit/next-config.test.ts tests/unit/site-gate.test.ts tests/unit/site-routing.test.ts tests/unit/middleware*.test.ts` + `npx tsc --noEmit -p .`: green.
- [ ] **Step 5:** e2e `tests/e2e/headers.spec.ts tests/e2e/gate.spec.ts` (chromium): green unchanged (robots.txt text identical while off).
- [ ] **Step 6: Commit** `feat(seo): one indexing switch, robots.txt by the switch`.

### Task 2: Canonical, hreflang and the sitemap (spec G3, G4)

**Files:**
- Create: `app/src/lib/alternates.ts`, `app/src/app/sitemap.ts`, `app/tests/unit/alternates.test.ts`, `app/tests/db/sitemap.test.ts`, `app/tests/e2e/seo.spec.ts`
- Modify: `generateMetadata` of `app/src/app/[locale]/(site)/page.tsx`, `koolitused/page.tsx`, `koolitused/[slug]/page.tsx`, `koolituskalender/page.tsx`, `praktika/page.tsx`, `koolitaja/page.tsx`, `kontakt/page.tsx`, `uudised/page.tsx`, `uudised/[slug]/page.tsx`, `privaatsus/page.tsx`, `tingimused/page.tsx`; `app/src/lib/site-routing.ts` (PASS `sitemap.xml`), `app/tests/unit/site-routing.test.ts`, `app/tests/unit/site-gate.test.ts`.

**Interfaces:**
- Consumes: `href(locale, path)` (`src/i18n/href.ts`), `listPublishedCourses(db)`, `listPosts(db)` (`src/db/queries/public.ts`), `siteBase()` (`src/server/share-meta.ts`).
- Produces: `pageAlternates(locale: Locale, path: string): { canonical: string; languages: Record<"et" | "ru" | "x-default", string> }` (relative paths; `metadataBase` makes them absolute). `PUBLIC_SITEMAP_PATHS = ["/", "/koolitused", "/koolituskalender", "/praktika", "/koolitaja", "/kontakt", "/uudised", "/privaatsus", "/tingimused"]`.

- [ ] **Step 1: Failing tests.** `alternates.test.ts`: `pageAlternates("ru", "/koolitused/x")` → canonical `/ru/koolitused/x`, languages `{ et: "/koolitused/x", ru: "/ru/koolitused/x", "x-default": "/koolitused/x" }`; `("et", "/")` → canonical `/`, ru `/ru`. A test that reads each listed page file and asserts its `generateMetadata` uses `pageAlternates` with the page's own path (source-level pin, like the repo's other file pins). `db/sitemap.test.ts` (PGlite, the repo's db-test setup): one published and one unpublished course, one published and one draft post → entries: every `PUBLIC_SITEMAP_PATHS` path in ET and RU (absolute on SITE_URL), the published course and post in both locales with `alternates.languages` et/ru/x-default, `lastModified` = course `updatedAt` / post `publishedAt`; the unpublished ones absent. `site-routing.test.ts`: `/sitemap.xml` → `{ kind: "other" }`. `site-gate.test.ts`: `/sitemap.xml` is NOT always-through (gated).
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3: Implement.** `alternates.ts`; spread `alternates: pageAlternates(locale, <path>)` into each listed page's metadata (keep everything else they return). `app/sitemap.ts` with `export const dynamic = "force-dynamic"` (no build-time database read; see the layout's note on that), using `getDb()` and the queries above. PASS `sitemap\.xml$` exactly in `site-routing.ts` (not in `ROOT_FILES`, so the gate keeps it).
- [ ] **Step 4:** Unit + db tests + tsc green.
- [ ] **Step 5:** e2e `seo.spec.ts` test "sitemap.xml lists the public pages in both languages and a course with its alternates; the home page links its Russian version" (GET `/sitemap.xml` 200 `application/xml`; contains `<loc>…/koolitused</loc>` and `…/ru/koolitused`, a seeded course in both locales with `xhtml:link hreflang="ru"`; home `<link rel="canonical">` and `<link rel="alternate" hreflang="ru" href="…/ru">`). Run it with headers.spec: green.
- [ ] **Step 6: Commit** `feat(seo): canonical and language links, sitemap.xml`.

### Task 3: Structured data (spec G5)

**Files:**
- Create: `app/src/lib/structured-data.ts`, `app/src/components/site/JsonLd.tsx`, `app/tests/unit/structured-data.test.ts`, `app/tests/unit/json-ld-dom.test.tsx` (or the repo's DOM-test naming)
- Modify: `app/src/app/[locale]/(site)/layout.tsx` (organization), `(site)/page.tsx` (website), `koolitused/[slug]/page.tsx` (course + breadcrumbs), `uudised/[slug]/page.tsx` (post + breadcrumbs), `app/tests/e2e/seo.spec.ts`.

**Interfaces:**
- Consumes: the layout's `settings.contact` (`{ email, phone, address, instagram, facebook }`), the course page's loaded course (title/summary/images/language/type/price/priceGroup/priceIndividual and its upcoming sessions: startsAt, city, venue, language, status), the post page's post, `pick`, `mediaUrl`, `siteBase()`, the dictionary's existing labels for home / courses / news (no new text).
- Produces: `organizationLd(base, name, contact)`, `websiteLd(base, name)`, `courseLd(base, locale, course, sessions)`, `postLd(base, locale, post)`, `breadcrumbLd(base, items: { name: string; path: string }[])` — plain objects with `@context: "https://schema.org"`; `<JsonLd data={…} />` renders `<script type="application/ld+json">` with `JSON.stringify(data).replace(/</g, "\\u003c")`.

- [ ] **Step 1: Failing tests.** Builders: organization has `@type: "EducationalOrganization"`, `@id: <base>/#organization`, logo `<base>/brand/logo.png`, `sameAs` only the set links, no `legalName`; a contact course with `priceGroup` 19000 and `priceIndividual` 25000 → two offers `price: "190.00"` and `"250.00"`, `priceCurrency: "EUR"` (an e-course: one offer from `price`; a null price: no offer); two scheduled sessions → two `onsite` instances with ISO `startDate` and `location.address` = city; a cancelled session absent; an e-course → one `online` instance; `inLanguage` from `"ET / RU"` → `["et", "ru"]`; post → `BlogPosting` with `datePublished` ISO and author/publisher `@id` of the organization; breadcrumbs positions 1..n with absolute `item`. DOM: `<JsonLd data={{ name: "</script><b>x" }} />` renders one script whose text has no `</script` and parses back to the same object; nothing else rendered.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3: Implement** the builders and component; place `<JsonLd>` inside the existing markup where it changes no layout (a script element is not rendered; do not add wrappers). The layout already loads `settings.contact`; the course and post pages already load their data (reuse the cached loaders).
- [ ] **Step 4:** Unit + DOM + tsc green.
- [ ] **Step 5:** e2e `seo.spec.ts`: "a course page carries Course and BreadcrumbList data, every page the organization, and the page looks as before" — on a seeded course page exactly one `Course` whose `name` equals the `<h1>` text, a `BreadcrumbList`, and one `EducationalOrganization` on `/` and `/kontakt`; `/` has a `WebSite`; a post page has `BlogPosting`. Run with headers.spec: green.
- [ ] **Step 6: Commit** `feat(seo): structured data for the organisation, courses and posts`.

### Task 4: Old WordPress addresses (spec G6)

**Files:**
- Create: `app/src/data/old-addresses.json`, `app/src/lib/old-addresses.ts`, `app/tests/unit/old-addresses.test.ts`, `app/tools/old-addresses-check.mjs`
- Modify: `app/src/lib/site-routing.ts` (`routeSitePath`), `app/tests/unit/site-routing.test.ts`, `app/tests/e2e/seo.spec.ts`.

**Interfaces:**
- Produces: `oldAddressTarget(path: string): string | null` — `path` is `canonicalPath(pathname)` lowercased; exact map first, then the first prefix rule whose prefix the path starts with; null otherwise.

The map (`old-addresses.json`, `{ "exact": { "<old>": "<new>" }, "prefixes": [{ "prefix": "<old>/", "to": "<new>" }] }`, keys without trailing slash):
- exact → `/koolitaja`: `/about`, `/meist`, `/koolitaja-1`
- exact → `/kontakt`: `/contact`, `/koostoo`, `/koostoo-2`
- exact → `/privaatsus`: `/privaatsuspoliitika`
- exact → `/koolitused`: `/shop`, `/kataloog`, `/kontaktkoolitused`, `/e-ope`, `/e-ope-2`, `/opiteed`, `/lisaks`, `/meie-best-seller-2in1-koolitus`, `/best-seller-2in1-koolitus`, `/cart`, `/cart-2`, `/checkout`, `/checkout-2`, `/product/kulmudisain-e-ope`, `/kursused/kulmudisain-e-ope`
- exact → `/koolituskalender`: `/event-directory`, `/koolitusele-registreerimine`
- exact → `/praktika`: `/praktika1`, `/mentorlusprogramm`, `/mentorlusprogramm-2`
- exact → `/konto`: `/customer-cabinet`, `/dashboard`, `/student-registration`, `/instructor-registration`
- exact → `/uudised`: `/hello-world`
- exact → `/koolitused/kulmumeistri-baaskoolitus`: `/kulmumeistri-baaskoolitus-2`, `/product/kulmud-baaskoolitus`, `/kursused/kulmud-baaskoolitus`
- exact → `/koolitused/kulmude-lami`: `/kulmude-lami-baaskoolitus`, `/product/kulmude-lami-baaskoolitus`, `/kursused/kulmude-lami-baaskoolitus`
- exact → `/koolitused/lash-lift-botox`: `/lash-lift-koolitus`, `/product/lash-lift-botox-baaskoolituse-e-ope`
- prefixes → `/koolitused`: `/product/`, `/product-category/`, `/kursused/`, `/courses/`, `/lesson/`, `/lessons/`, `/topics/`

- [ ] **Step 1: Failing tests.** `old-addresses.test.ts`: every exact key maps as listed; `/product/taiendkoolitus-9-horeda-kulmu-kujundamine` and `/kursused/kulmud-baaskoolitus/lessons/x` → `/koolitused`; `/wp-admin`, `/koolitused`, `/praktika`, `/koolitaja`, `/koolituskalender` → null; no exact key and no prefix is a page of the site (`isKnownPage("/et" + key)` false); every target is (`isKnownPage("/et" + target)` true). `site-routing.test.ts`: `/product/kulmud-baaskoolitus/` → one `{ kind: "redirect", path: "/koolitused/kulmumeistri-baaskoolitus" }`; `/Meist` → `/koolitaja`; `/koolitused/` → `/koolitused` (unchanged canonical redirect); `/ru/meist` → its RU 404 page as today (old addresses are ET-only).
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3: Implement.** In `routeSitePath`, after the HUB and API checks and before the canonical redirect: `const old = oldAddressTarget(canonicalPath(pathname).toLowerCase()); if (old) return { kind: "redirect", path: old };`. `tools/old-addresses-check.mjs <sitemap URL or file>`: reads the JSON, reads the sitemap once (fetch for an http(s) argument, else the file), prints every target path whose ET address is not a `<loc>` in it and exits 1 if any, else prints "all N targets are in the sitemap".
- [ ] **Step 4:** Unit tests + tsc green; run the tool on a small sitemap fixture written to the scratchpad: a missing target is named.
- [ ] **Step 5:** e2e `seo.spec.ts`: "an old address is one permanent redirect to its new page" — `request.get("/product/kulmud-baaskoolitus/", { maxRedirects: 0 })` → 308, `location` ends `/koolitused/kulmumeistri-baaskoolitus`; `/meist` → `/koolitaja`. Green.
- [ ] **Step 6: Commit** `feat(seo): the old site's addresses lead to the new pages`.

### Task 5: Launch notes and the test plan (spec G8)

**Files:** Modify `docs/deploy.md` (a new section "Search engines" at the end: the switch and where each piece lives, what to check at launch), `docs/launch-checklist.md` (§1 "Remove noindex" → "Indexing turns on by itself on production when SITE_GATE is removed; check `curl -sI https://mslab.ee/ | grep -i x-robots` shows none and `https://www.mslab.ee/` still shows noindex"; add under §1b: submit `https://mslab.ee/sitemap.xml` in Search Console; www.mslab.ee redirects to mslab.ee (Vercel → Domains); run `node app/tools/old-addresses-check.mjs https://mslab.ee/sitemap.xml` and point any missing target at a real page; Business Profile once the company is known), `app/src/data/testplan.json` (one new item).

- [ ] **Step 1:** Add the test plan item `avalik-vanad-aadressid` (area `avalik`, who `dim`, device `any`, risk `low`, writes false, `mark: "new"`, `markedAt: "deploy"`, href `/meist`), placed after `avalik-404`: steps (≤ 20 words a line, ≤ 8 lines) open `mslab.ee/meist`, `mslab.ee/product/kulmud-baaskoolitus/`, `mslab.ee/kursused/taiendkoolitus-1-keeruliste-ripsmete-lash-lift-meistriklass/` in the device signed in to the admin; expects: each opens a page of the new site (Koolitaja; the Kulmumeistri baaskoolitus page; the course list), and the address bar shows the new address. Estonian, plain words (Dim's rule 12.11). Edit by JSON round-trip.
- [ ] **Step 2:** `npx vitest run tests/unit/testplan-file.test.ts`: green.
- [ ] **Step 3:** The docs edits above (English; keep the files' style).
- [ ] **Step 4: Commit** `docs(seo): launch notes and a test-plan check for the old addresses`.
