# SEO groundwork while the site is gated — design (12.11.2026)

## Intent
mslab.ee is gated (coming-soon page) until the business goes live, planned January–February 2027. Dim (12.11): "For Launch
proceed with what is recommended … currently we can already do some SEO stuff upfront … Important is that the design that the
front pages currently have would not be changed." So: build the search-engine basics now, keep them inert while the gate is on,
and let them switch on by themselves with the launch. Nothing a visitor sees on a public page changes.

Not now (Dim): a business Google account and a Google Business Profile wait until the company Maria starts with is known. The
Search Console property exists (Dim created it).

## Goals
- **G1 One indexing decision.** `indexingOn` = the gate is off (`SITE_GATE` unset or off) AND `VERCEL_ENV === "production"`. On top
  of it a host check: only `SITE_URL`'s host (mslab.ee) is indexable; www.mslab.ee, the `*.vercel.app` addresses and previews never.
  Everything below follows this one decision: the `X-Robots-Tag` header (next.config.ts), the redirects' header (middleware), the
  pages' robots meta (layout), robots.txt. Today (gate on) and on every machine that is not Vercel production: exactly today's
  noindex behaviour.
- **G2 robots.txt** made by `app/robots.ts` (replaces `public/robots.txt`). Indexing off: today's text (link-preview bots allowed,
  everything else disallowed). Indexing on: allow all, disallow `/admin`, `/api/`, `/maksa/`, `/guide`, `/p/`
  (not the account, cart and payment-result pages: they are noindex always, and a crawler barred from them would never read it;
  final review M1), and `Sitemap: <SITE_URL>/sitemap.xml`.
- **G3 sitemap.xml** (`app/sitemap.ts`, rendered per request, no build-time database read): the public pages in ET and RU
  (`/`, `/koolitused`, `/koolituskalender`, `/praktika`, `/koolitaja`, `/kontakt`, `/uudised`, `/privaatsus`, `/tingimused`), every
  published course and post, each entry with its ET/RU/x-default alternates; `lastModified` = a course's `updatedAt`, a post's
  `publishedAt`. Behind the gate like a page (an admin's preview cookie sees it), not one of the always-through files.
- **G4 canonical + hreflang** on every public page listed in G3 and on each course and post: `alternates.canonical` = the page's
  own address in its locale; `alternates.languages` = `et`, `ru`, `x-default` (= ET). Absolute through the existing
  `metadataBase` (SITE_URL).
- **G5 Structured data (JSON-LD)**, invisible, from data the site already has:
  - every public page (site layout): `EducationalOrganization` — `@id <base>/#organization`, name (the dictionary's site name),
    url, logo (`/brand/logo.png`), and from Seaded → contact: email, telephone, address (as text), `sameAs` Instagram/Facebook when set.
    No legal company name or registry code (the company is not decided).
  - home page: `WebSite` (`@id <base>/#website`, name, url, `inLanguage` et+ru, publisher → the organization).
  - course page: `Course` (name, description = summary, url, image, `inLanguage` from the course's language, provider → the
    organization, offers in EUR: an e-course's price; a contact course's group and individual price) with `hasCourseInstance`:
    an e-course one `online` instance; a contact course one `onsite` instance per upcoming scheduled session (startDate,
    location = Place with venue/city, the session's language). Plus `BreadcrumbList` (home → courses → course).
  - post page: `BlogPosting` (headline, description = excerpt, image = cover, datePublished, author and publisher → the
    organization, `inLanguage`, mainEntityOfPage) plus `BreadcrumbList` (home → news → post).
  - The JSON is escaped (`<` → `<`) and rendered in a `<script type="application/ld+json">`, never visible.
- **G6 Old WordPress addresses.** The old site (gone since 08.10) had 87 published pages plus Tutor LMS courses and lessons.
  A request for an old address gets ONE permanent redirect (308, the codebase's) to the nearest new page, trailing slash or not:
  exact pages (about/meist/koolitaja-1 → /koolitaja, contact/koostoo → /kontakt, privaatsuspoliitika → /privaatsus, …), the four
  base courses to today's course pages, and prefixes (`/product/…`, `/kursused/…` including lessons, `/product-category/…`,
  `/courses/…`, `/lesson/…`, `/topics/…`) to the course catalogue `/koolitused`. An old address that is a page of the new site
  (`/koolitused`, `/praktika`, `/koolitaja`, `/koolituskalender`) is never in the list. The redirect happens after the gate like
  any routing.
- **G7 Private pages always noindex**: the account pages, the cart and the payment result get `robots: noindex` in their own
  metadata, whatever G1 says; the X-Robots-Tag header keeps noindex on `/admin`, `/api`, `/konto`, `/ru/konto`, `/ostukorv`,
  `/ru/ostukorv`, `/makse`, `/ru/makse`, `/maksa/…`, `/guide`, `/p/…` and the coming-soon page.
- **G8 Launch notes**: `docs/deploy.md` gets a section on search engines; `docs/launch-checklist.md`'s "Remove noindex" item becomes
  "automatic with the gate; check the headers", plus: submit the sitemap in Search Console, check www → apex, re-check the old
  addresses' course targets against the live sitemap (`tools/old-addresses-check.mjs`, one request), Business Profile once the
  company is known. The test plan gets one check for the old addresses.

## Non-goals
Any visible change to a public page (no breadcrumb bar, no new text, no layout change); new admin fields (SEO titles or
descriptions); FAQ markup; Event markup (Google's event results are not offered in Estonia); counting on Google's course rich
results (retired by Google in 2025 — the Course markup stays, other engines and AI search read it); analytics; Business Profile.

## Anti-goals
- The front pages' design changes in any way.
- Anything becomes indexable while the gate is on, or on a host other than mslab.ee.
- The prototype's sample content is indexed before the clean-up (the gate holds it back).

## Calls made here (Claude's, for Dim to check)
- Indexing turns on by itself when `SITE_GATE` is removed on production (no second switch to forget).
- Old addresses without a matching new course go to `/koolitused`; the 45 advanced courses („täiendkoolitused“) and the 2in1
  pages have no new page yet. The map is a code file; when Maria adds those courses, their entries can point to them.
- 308 rather than 301 (both are permanent for search engines; the codebase uses 308).

## Left to the builder
File layout, helper names, test shapes, the exact old-address list (from `Assets/mslab.WordPress.2026-09-22.xml`, never published).
