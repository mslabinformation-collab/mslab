# MS LAB main site — phase 1 design

> **Note (03.10.2026):** this describes the Cloudflare Workers setup, which is retired. The site runs on Vercel now (the design hub is static files in `app/public`); see [`docs/deploy.md`](../../deploy.md) for the current hosting.

Date: 2026-10-01 · Approved in chat by Dim (scope, stack, domain, RU, admin login, account ownership).
Inputs: Maria's comment-tool feedback 30.09–01.10 (bot export `ChatExport_2026-10-01`), her course-logic
overview of 01.10, earlier chat (`ChatExport_2026-09-29`), prototypes in `site/p/{a,b,c,d}`.

## 1. Goal and phases

Build the real MS LAB website and admin on one production codebase. Phase 1 makes the whole public
site real (final design, real data from a database, ET + RU) and gives Maria an admin where she edits
all content herself. Later phases add money and learning on the same codebase.

| Phase | Scope |
|---|---|
| **1 (this spec)** | Foundation, all public pages, content admin, working enquiry/registration forms, newsletter signup, migration of the review hub |
| 2 | Student accounts (single active session), e-course purchase (Montonio bank link), contact-course payment 100% / 50%, booking confirmation after ≥50% prepayment, student dashboard (my courses, favourites, terms acceptance), transactional e-mails |
| 3 | Learning: private video (Cloudflare Stream, signed), modules/lessons/progress, knowledge test, practical-work assessment (steps per course, 1–3 photo uploads per step, Maria comments + approves), certificate generator (name in certificate script font + date + number) |
| 4 | Invoice PDFs (100% / 50%) to dashboard + e-mail, student contracts with digital signature, moderated course reviews, end-of-course feedback form, instalments (Inbank/Holm), newsletter campaigns |

Phase 1 non-goals: taking payments, student login, video, certificates, invoices, contracts.

## 2. Decisions

- **Stack:** Next.js (App Router, TypeScript, React Server Components) on Cloudflare Workers via
  `@opennextjs/cloudflare`. Plain CSS with design tokens + CSS Modules (no Tailwind) so the B prototype's
  styling ports directly.
- **Database:** Postgres on **Railway** (Dim's account), reached from Workers through **Cloudflare
  Hyperdrive**. Drizzle ORM + `postgres` driver; migrations with drizzle-kit. Not Neon.
- **Files:** Cloudflare R2 bucket `mslab-media` for uploaded images (hero, courses, gallery, blog,
  campaign). Served through the app at `/media/<key>` (Worker reads R2), so no extra domain is needed.
- **E-mail:** Resend, sender on the already-verified `send.diipsolutions.eu` domain (to confirm at build).
- **Domain:** `mslab.diipsolutions.eu` root = main site. Review hub keeps working at `/guide` and
  `/p/*`; the comment widget stays on every page (main site included) during the build. Final domain
  `mslab.ee` later.
- **Languages:** Estonian default at `/`, Russian at `/ru/...` with the same path segments. Every UI
  string in a typed dictionary; every content field stored as `{ et, ru }`, RU optional (falls back to ET
  with a small "tõlge tulekul" marker only in admin, never on the public page).
- **Accounts:** everything on Dim's Railway + Cloudflare for now; transfer to Maria's business accounts
  before the mslab.ee launch.
- **No AI tool names** anywhere client-facing (memory rule).

## 3. Course model (Maria's 01.10 logic)

- A course is **either `e_learning` or `contact`**. There is no hybrid option on any course page.
  "Hübriidõpe" is only an explanation on the site: a student can combine e-learning and contact
  courses.
- Level: `basic` (Baaskoolitus) or `advanced` (Täiendkoolitus).
- **E-learning course**: price (one), access period (months), video count, module list (titles,
  shown locked), outcomes, language, "includes knowledge test + practical-work assessment +
  certificate", optional next-course discount text (e.g. "−10% järgmiselt koolituselt"), payment options
  `pay_now` (100% bank link) and `instalment` (shown as "Tulekul" until phase 4).
- **Contact course**: group price and individual price (either may be empty = not offered), duration
  (e.g. "8 ak"), "Koolitus sisaldab" list, outcomes, content/programme, language, models note
  ("Võid tulla oma modellidega; vajadusel aitame leida."), payment options 100% / 50% now + 50% on the
  day. Group participation picks a dated **session**; individual participation sends a request.
- Both types: title, slug, short + long description, gallery (main image + more, ordered), badge
  (label + colours), trainer (links to the trainer page), recommendations (auto: same type/level first,
  manual override list), published flag, sort order.
- **Rules (enforced in code, unit-tested):** a contact registration is created as `awaiting_prepayment`
  and becomes `confirmed` only when ≥50% of the chosen price is recorded paid (phase 2 records
  payments; phase 1 never confirms). Seats left = capacity − confirmed registrations; a session is
  "Viimased kohad" at ≤2 seats, "Täis" at 0 (waitlist form), "Tühistatud" when cancelled.

## 4. Public pages

Design base: **prototype B** (`site/p/b`), with Maria's per-section decisions. Fonts from A: **Jost**
(headings, numbers, prices) + **Manrope** (UI, body, menu, buttons, language switch).

| Route (ET; RU = `/ru` + same) | Content |
|---|---|
| `/` | B header (sticky, turns white on scroll, follows hero slide tone light/dark); B hero with the first slide image kept, the vertical "BROW & LASH ACADEMY" detail kept, **A's slide control** (`01 / 05` mono + segment bar + prev/next), primary "Leia oma koolitus" + secondary thin black outline pill "Vaata koolituskalendrit →"; D "Kuidas soovid õppida?" block (E-õpe / Kontaktõpe tabs with 01–05 steps; hybrid tab = text only, no steps); course cards; D statement line (smaller type); D trainer block; B practice block (see `/praktika`); D blog carousel; D FAQ; D contact block (working form); footer with B's lilac newsletter block ("Hea järgmine samm. Otse sinu postkasti.") moved inside it; campaign popup (D) |
| `/koolitused` | D colours/explainer; heading and intro smaller than D; format chips (Kõik / E-õpe / Kontaktõpe) and level chips (Kõik / Baas / Täiend) on **separate rows** (B); format explainer: e-learning + contact with steps — circles centred in the box, dotted line through circle centres; hybrid = description only; search |
| `/koolitused/[slug]` | B course page as base. Left: A's gallery — large main image + thumbnail **carousel**, thumbnails clickable, lightbox. Right: summary card (type, level, language, duration or modules + videos, access period, trainer → `/koolitaja`, next-course discount), price(s), actions. E-learning: "Osta kohe" (checkout preview; payment step says "Makse lisandub peagi" in phase 1), instalment shown disabled "Tulekul". Contact: Grupikoolitus (session list from calendar → registration form) / Individuaalkoolitus (request form: preferred period/date, message). Registration form fields: name, e-mail, phone, payment choice 100% / 50%, ☐ "Soovin koolituskeskuse abi modellide leidmisel", ☐ "Loo mulle kohe konto MS LAB keskkonda" (stored; account created in phase 2), terms ☐ required. Below: outcomes, "Koolitus sisaldab", module list (locked icons), "Jaga koolitust" (Web Share API → copy link fallback, B), ♡ favourite (stored in browser now; moves to the account in phase 2), "Sulle võiksid huvi pakkuda" recommendations |
| `/koolituskalender` | A calendar layout; per row **course name dominant** (largest), then date, city, venue, format, **language tag (ET / RU / ET+RU)**, status, action; city filter chips |
| `/praktika` | B block, refined: "Praktika" made the primary heading so the page reads as practice first; packages MINI / MAXI with **duration** (e.g. "8 ak", admin-editable), item lists (admin-editable), price in Jost and smaller than B; "Praktika toimub ainult Pärnus" shown clearly; Maria's practice text + praktikaprotokoll explanation; request form (name, e-mail, phone, package, completed course, preferred times) |
| `/koolitaja` | D page + **works gallery** carousel under the portrait (2–3 visible, swipe, lightbox), "Koolituskeskuse lugu" section, "Koolitaja teekond" section (both admin-editable rich text) |
| `/uudised`, `/uudised/[slug]` | D blog list and article |
| `/kontakt` | contact details + form |
| `/privaatsus`, `/tingimused` | legal text pages (admin-editable; placeholder text marked for Maria) |

Campaign popup: D version; remove "Mitte praegu"; CTA wording "Leia enda koolitus"; once per
session, home page only after 6 s, never on course checkout/admin; image chosen from uploads.

Responsiveness: verified at 390, 834, 1440 and 2560 px; no horizontal overflow; touch targets ≥44 px;
`prefers-reduced-motion` respected; WCAG AA contrast for text.

## 5. Admin (`/admin`)

Layout: **B admin** (left sidebar, "Tere, Maria." overview) refined. Server-side session check on every
admin route and admin API.

Login: e-mail magic link (Resend), 15-minute single-use token, allow-list exactly
Dim's address and Maria's address (the Worker secret `ADMIN_EMAILS`). Session cookie: HttpOnly, Secure, SameSite=Lax,
30 days, stored hashed in the DB (revocable).

**Amended (4c, 29.10) by the admin UX pass (spec 2026-10-21 §9, C8, B19, B20):**
- **B19, the way back.** An admin page opened signed out sends her to `/admin/login?tagasi=<the page>`; the form sends it with the request (with the page's `#fragment`), the mailed link carries it as `&tagasi=`, and the link lands her there. It is checked when the link is made and again when it is opened: a path of this site's admin (`/admin` or `/admin/…`, never the login page), no control character, nothing the coming-soon gate's pattern refuses (dot segments, encoded slashes or dots, a backslash, two slashes), at most 300 characters, rebuilt from the parsed URL. Anything else lands on `/admin` without a word. A dead link's notice keeps the way back.
- **B20, the honest limit.** Every typed address, allowed or not, gets 3 requests in 10 minutes (a key of the SHA-256 of the address in the KV store, so no address is stored there); the 4th answers „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“, the same for an allowed and an unknown address. The per-IP limit (5 in 10 minutes, „Liiga palju katseid. Proovi mõne minuti pärast.“) and the token cap (3 unused links per address) stay behind it.
- **The page.** The sent state names the address typed, for any address: „Link on teel“, „Saatsime lingi aadressile {email}. See kehtib 15 minutit.“; the address is remembered on the device after a sent link, with „Muu aadress“ to change it.

Sections in phase 1:
- **Ülevaade** — counts of new requests/registrations, upcoming sessions, quick links.
- **Koolitused** — list + editor: type, level, ET/RU texts, prices, duration/modules/videos/access,
  includes list, outcomes, programme, gallery upload & order, badge (D badge editor: presets, own
  text ≤18 chars, colour swatches, live preview), recommendations override, publish toggle.
- **Kalender** — group sessions per contact course: date, time, city, venue, language, capacity,
  status; registrations per session; waitlist (B "Liitu ootenimekirjaga").
- **Registreerimised ja päringud** — contact-course registrations (status `awaiting_prepayment` /
  `confirmed` / `cancelled`, manual status change with note), individual requests, practice requests,
  contact messages; filter **Kõik / E-õpe / Kontaktõpe** where relevant (Maria's request).
- **Praktika** — MINI/MAXI: name, models count, duration, price, item list (ET/RU).
- **Avaleht** — hero slides (image, tone light/dark, kicker, title, text, CTAs, order, on/off),
  statement, trainer teaser, FAQ items.
- **Koolitaja** — portrait, bio, works gallery, "Koolituskeskuse lugu", "Koolitaja teekond".
- **Uudised** — posts (cover, ET/RU title/body, date, category, publish).
- **Kampaania** — D editor + **image upload** (Maria's request).
- **Uudiskiri** — subscriber list with consent time; CSV export.
- **Seaded** — contact details, social links, legal pages, admin e-mails shown read-only.

Image upload: client resizes to ≤2400 px and strips metadata before upload; server validates type
(JPEG/PNG/WebP) and size (≤8 MB), stores to R2 under `img/<uuid>.<ext>`.

## 6. Forms and notifications (phase 1)

Contact message, individual-course request, practice request, group registration, waitlist, newsletter
signup. Each: Zod schema shared by client and server, honeypot field, per-IP rate limit (KV, e.g.
5/10 min), stored in Postgres, confirmation screen, e-mail to Maria (Resend) and a Telegram ping via
@MS_Lab_bot (reuse current bot + KV chat id). Newsletter: double opt-in e-mail; welcome code text is a
setting (default "−10%"), no automatic code issuing until phase 4. E-mail failures never lose the
record (storage first, then notify; failures logged).

## 7. Data model (Drizzle, Postgres)

`admins(email)`, `auth_tokens(hash, email, expires_at, used_at)`, `admin_sessions(id_hash, email,
expires_at)`; `courses(id, slug, type, level, title_i18n, summary_i18n, body_i18n, outcomes_i18n[],
includes_i18n[], modules_i18n[], language, price_group, price_individual, price, access_months,
video_count, duration_label, next_discount_i18n, badge jsonb, recommendation_ids int[], published,
sort)`; `course_images(course_id, key, alt_i18n, sort)`; `course_sessions(id, course_id, starts_at,
city, venue, language, capacity, status)`; `registrations(id, course_id, course_session_id?, kind
group|individual, name, email, phone, payment_choice full|half, wants_model_help, wants_account,
status, note, created_at)`; `requests(id, kind contact|individual|practice|waitlist, payload jsonb,
created_at, handled)`; `practice_packages(code, name, models, duration_label, price, items_i18n[])`;
`hero_slides`, `faq`, `posts`, `pages` (trainer story/journey, legal), `gallery_items`, `campaign`,
`subscribers(email, confirmed_at, token)`, `settings(key, value jsonb)`.
i18n columns are `jsonb {et, ru?}`. Seed script loads the current prototype content so the site is
complete on day one; Maria replaces texts and photos in admin.

## 8. Repository and deployment

```
MSLab/
  app/            Next.js app (src/app, src/components, src/lib, src/db, messages/{et,ru}.ts)
    public/guide, public/p, public/feedback.js   ← moved from site/ (hub keeps working)
  site/           kept until the migration is verified, then removed
  worker/         old guide Worker — retired after cut-over
  docs/, tools/, Assets/
```
- Worker name `mslab-web`, bindings: `HYPERDRIVE`, `MEDIA` (R2), `KV` (rate limits, Telegram chat id,
  existing comments `FEEDBACK` namespace re-bound), secrets `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`,
  `SESSION_SECRET`, `ADMIN_KEY` (comments list).
- Comment API `/api/feedback` ported to a Next route handler with the same KV data, so existing
  comments and links keep working.
- Cut-over: deploy `mslab-web` to a workers.dev URL, verify, then move the `mslab.diipsolutions.eu`
  custom domain from `mslab-guide` to `mslab-web`.
- `noindex` stays on the whole host until launch on mslab.ee.

## 9. Testing

- Unit (Vitest): registration status rules, seats/status computation, price display per type,
  i18n fallback, form schemas, rate limiter, token/session helpers.
- Integration: route handlers against a disposable Postgres (local Docker or Railway dev DB).
- E2E (Playwright): home → course → group registration; individual request; practice request;
  newsletter; admin login (magic link via test mailbox stub) → edit course → visible on site; image
  upload; RU route renders.
- Visual: screenshots at 390 / 834 / 1440 / 2560 for every public page; no overflow, no console errors.

## 10. Open items (do not block phase 1)

Real prices, dates, course list and texts (seeded with prototype sample data, marked in admin as
"näidis"); registry code and legal texts; original photos and an SVG logo; Railway plan cost
(~$5/month Hobby); Resend domain check; later DNS for mslab.ee.
