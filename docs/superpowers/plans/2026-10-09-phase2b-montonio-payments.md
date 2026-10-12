# MS LAB Phase 2b — Online Payments with Montonio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Students pay online through Montonio (bank links, and cards / Apple Pay / Google Pay when Maria turns them on in her store): a group registration's 100 % or 50 % prepayment right after "Registreeru", a "Maksa" button in the mail and in Minu koolitused for paying later and for the rest after 50 %, and "Osta kohe" for an e-course, which opens the course and mails a login link. Maria gets a notice for every payment and an admin page "Maksed". No keys means today's behaviour.

**Architecture:**
- **Data.** One additive migration `0006_phase2b_payments.sql`: a `payments` table (one row per attempt, `merchantReference` = `MSLAB-M{id}`), `registrations.seat_hold_until` and `registrations.pay_token` (filled for existing rows by the column's own default). One SQL expression (`db/queries/seats.ts takesSeat`) is the only seat count: confirmed, or unpaid with a hold that has not ended.
- **Montonio.** `server/payments/jwt.ts` (HS256 on `node:crypto`), `montonio.ts` (create, fetch, verify, the status map, euro↔cent), `start.ts` (every way a payment starts; a start while the same attempt is still open re-sends it instead of making a second order), `settle.ts` (`settlePayment`, the one door every paid path goes through: webhook, return, daily check), `routes.ts` (the webhook and the return without Next.js). A test-only fake Montonio server (`tests/e2e/fake-montonio.ts`) answers the real client in the e2e run; the app reaches it only with `PAYMENT_PROVIDER=mock`, never on Vercel, never silently.
- **Pages.** `/maksa/<pay_token>` is a standalone HTML page (GET shows, a same-origin POST starts) like the unsubscribe page. `/makse` is a static page that reads its result from the fragment. Minu koolitused gets "Maksa {summa}" through `POST /api/konto/maksa`. The cart gets a purchase form when payments are on.
- **Admin.** "Maksed" after "Registreerimised", the payments under "Tasutud" in a registration's drawer and a "Maksed" list in the Õpilased drawer. Estonian only.

**Tech Stack:**
- Next.js 16.3.8 (pinned exactly — do not upgrade), React 19, TypeScript.
- Drizzle 0.45 + postgres.js 3.4 (Railway); PGlite for DB tests.
- Vitest (+ happy-dom for DOM tests), Playwright (dev, `E2E_PROD_BUILD=1`, and `playwright.gate.config.ts`).
- `node:crypto` HMAC-SHA256 for Montonio's JWTs (no new dependency); Resend for mail.
- Hosting: Vercel project `mslab` in Maria's team `ms-lab`, Hobby plan, region `fra1` (`docs/deploy.md`).

**Spec:** `docs/superpowers/specs/2026-10-09-phase2b-montonio-payments-design.md` (decisions D1–D7). Read all of it before starting; the section your task names is binding. The reference integration is Rempire's (`rempire-web/src/lib/payments/*`): its logic is ported here, not its file layout, and Rempire's comments are Russian while MS LAB's are English.

## Global Constraints

### Platform limits

- **Vercel Hobby only** (no paid plans). The limits that bind 2b:
  - **1M function invocations a month.** 2b adds no polling. A payment costs a few calls: the start, Montonio's webhook (retried up to 13 times over 48 hours only when we fail), the return.
  - **Cron jobs at most daily**: 2b adds no cron; the daily check of pending payments runs inside the existing `/api/cron/sweep` with its own deadline.
  - **`maxDuration`**: a Montonio call has 15 s (`REQUEST_TIMEOUT_MS`); every route that calls Montonio sets `maxDuration = 30`.
- **Never call the real Montonio, the real Bunny or the real Resend from a test.** Unit and DB tests stub `fetch` (`tests/fakes.ts stubFetch`). The e2e run's server talks to the fake Montonio (`tests/e2e/fake-montonio.ts`) through `PAYMENT_PROVIDER=mock` + `MONTONIO_FAKE_URL`.

### Payments (spec 4, 6, 7)

- **Payments are optional: no keys means today's behaviour.** `paymentsConfigured()` is true only with both `MONTONIO_ACCESS_KEY` and `MONTONIO_SECRET_KEY` (a blank value counts as not set). Without it the "Maksa" buttons are hidden, the registration answer and the mail are today's, the cart keeps the purchase-interest form, no seat is held, and `/api/payments/*` answer 404.
- **`merchantReference` is `MSLAB-M{id}`** (the payment row's id; `domain/payments.ts orderReference`). Every new payment attempt is a new row and so a new reference; a changed amount is a new row.
- **No second order while one is open (the double-payment rule, pre-flight fix).** A start ("Proovi uuesti", "Maksa" on the card, the `/maksa` button, the cart's "Maksa" again) for the same registration and kind — or the same e-course and address — with the same amount, while a `pending` row exists whose order is younger than Montonio's 30-minute window (`updated_at`: the row's insert or its last re-send), **re-sends that row**: `POST /orders` again with the same `merchantReference`, which overwrites the unpaid order at Montonio and answers a new `paymentUrl`. The row takes Montonio's uuid of it (`provider_uuid`, a new one replacing the old) and its window starts again. Only without such a row, or with another amount, is a new row (and reference) made. A token of the replaced order is confirmed with Montonio (spec 7.4, `settle.ts settleToken`): its PAID counts, its failure does not end the row.
- **Amounts are cents internally and euros only at the Montonio edge** (`toEuros` when an order is created, `toCents` when a token or an order is read).
- **`payment.method` is `paymentInitiation` with no `preferredProvider`**, `methodOptions.paymentDescription` = `MS LAB <reference>`, and **we never send `paymentReference`**.
- **One door:** every paid path (the webhook, the return, the daily check) ends in `settlePayment` (`server/payments/settle.ts`). Only the winner of the conditional `pending → paid` UPDATE does the once-only work. **`paid` is a floor**: a later `failed`/`ABANDONED` never undoes it; a `VOIDED` after `paid` is stored as `failed` and alerts Maria; `refunded` only updates the row and alerts Maria.
- **The amount check:** `grandTotal` in cents must equal `amount_cents` exactly and the currency must be `EUR`, else the row becomes `held` and nothing is confirmed or opened.
- **The mock is test-only and never a fallback** (Rempire's audit rule): it is reached only by the exact `PAYMENT_PROVIDER=mock`, never on Vercel, and in a production build only with `PAYMENT_MOCK_IN_PRODUCTION=1`. Any other `PAYMENT_PROVIDER` value turns payments off, it never falls back to the mock.
- **`MONTONIO_ENV`:** only the exact `live` means production; anything else is the sandbox.

### Static shells, caches and the account API

- **The account pages (`/konto…`), the cart (`/ostukorv…`) and `/makse` are static.** They read only `params`. No `cookies()`, `headers()`, `connection()` or `searchParams`. Per-user data comes only from `/api/konto/*` JSON with `Cache-Control: private, no-store`. The return lands on `/makse#…`: the result is in the fragment, which never reaches a server or a cache.
- Every `/api/konto/*` endpoint behind a session starts with `requireClient(request, deps)` and answers through `clientResponse(session, …)`; `tests/unit/account-guards.test.ts` lists them all. A non-GET request is same-origin only.
- `/maksa/<token>` and `/api/payments/*` are route handlers: `Cache-Control: no-store`, never cached.
- **A short stale "Täis" is accepted** (spec 5.3): a cached calendar can say "Täis" up to 30 minutes after an unpaid hold ended. The registration form checks live; a payment, a registration or the daily sweep revalidates `seats`.

### Simplicity and design

- **Each screen has one plain next-step sentence and at most one primary button** (phase 2a spec 2.1 rule 5). Where 2b needs a second way (the bank transfer under "Maksa", the change request next to "Maksa ülejäänud"), it is a text button in the site's link style, never a second filled button.
- **Design rules (Dim): simple in steps and words, not a new look.** Use the site's components, fonts (Jost/Manrope), colour tokens (`src/styles/tokens.css` only), `ui.btn`, `ui.btnOutline`, `ui.link`, `Icon`, `Notice`. The admin uses its `ui.module.css`, `StatusPill`, `Pager`, `Drawer`.
- **Touch targets ≥ 44 px. Widths 390 / 834 / 1440 without horizontal overflow. Respect `prefers-reduced-motion`** (2b adds no animation). Every new account or site CSS file goes into `tests/unit/colour-tokens.test.ts`'s list.

### Admin and text rules

- **The admin is Estonian only**: its strings are in `src/i18n/dict/admin.ts`; Maria's mail and Telegram texts are Estonian in `src/server/messages.ts`.
- **Dictionaries.** Every student or visitor string goes in `src/i18n/dict/et.ts` **and** `ru.ts` (the parity, placeholder and Cyrillic tests stay green).
- **Russian typography: a no-break space (` `) after the one-letter prepositions в, с, к, о, у**, as everywhere. The Russian texts are drafts for the native-speaker check (`docs/launch-checklist.md` §10, Task 11).
- **The spec's texts (§9) are used verbatim** (Russian with the no-break space rule applied): "Maksa {summa}", "Maksa ülejäänud {summa}", "või tasu pangaülekandega", "Koolituse eest tasumine", "Selle registreeringu eest pole praegu midagi tasuda.", "See koolitus on täis. Võta ühendust Mariaga.", "Makse õnnestus. Saatsime sulle kinnituse e-postiga.", "Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.", "Makse jäi tegemata.", "Proovi uuesti", "Koht on kinnitatud — {kursus}", "Makse on kätte saadud — {kursus}", "E-koolitus on avatud — {kursus}", "Uus makse: {nimi}, {mis}, {summa}", "Makse laekus, aga koolitus on täis", "Kontrolli Montonios", "Ülejäänud {summa} tasud koolituspäeval või Minu koolitused lehel", the admin's "Maksed", "Kõik / Makstud / Pooleli / Ebaõnnestunud / Tagastatud / Ootel kontrollil", "Ettemaks / Ülejäänud / E-koolitus". The dictionaries write the spec's `{summa}`, `{kursus}`, `{nimi}`, `{mis}` as the code's `{amount}`, `{title}`, `{name}`, `{what}`.

### The repository is PUBLIC

- **No real address in any tracked file.** `tests/unit/test-addresses.test.ts` scans `app/`, `tools/` and `docs/`, this plan included. Tests use `@example.test`, or `@example.com` where a mail must really be built and "sent" to a stubbed Resend.
- **Sample addresses (`@example.test`, and the e2e run's `e2e-…@example.com`, `e2e-client-…@example.test`) are never mailed**: the payer mails skip `isSampleAddress`, and the e2e servers have no `RESEND_API_KEY`.
- **No secrets anywhere**: no key, token, webhook secret or database URL in code, docs, tests or commit messages. The e2e run's Montonio keys are made-up test values in `tests/e2e/montonio-values.ts`; the unit tests' are made-up strings.
- **No address, token, key or `pay_token` in a log line.** Log lines carry the payment id and its status only (`logFailure` / `logNote` / `console.info` with fixed text). Montonio's own error text may be logged (it names no person).
- **Never commit `.env*`** (the one exception is the tracked placeholder file `app/.env.example`, which gets the variables' names as comments, no values: Task 2). Montonio's sandbox keys live only in the git-ignored `app/.env.local` as `MONTONIO_ENV` / `MONTONIO_ACCESS_KEY` / `MONTONIO_SECRET_KEY`. On Vercel they are plain variables by the owner's choice (`docs/deploy.md` §2), never in the repository.

### The database

- **Migration `0006_phase2b_payments.sql` is additive only.** The drop of `courses.modules`, planned as 0006, becomes **0007** and stays "code first, then the migration" (Task 1 updates the texts that say 0006).
- **No Railway writes, no deploys and no push before Task 12** (the controller). Migration 0006 is applied **locally only** in Task 1 (`npm run db:migrate` against `localhost`); the e2e run refuses non-local databases (`tests/e2e/local-db.ts`). Merging into `main` deploys production, so 2b stays on `feat/phase2b-payments`, local and unpushed, until Task 12.

### The accounts (since 08.10.2026)

| Part | Where |
|---|---|
| Site | **https://mslab.ee** behind the coming-soon gate (`SITE_GATE=1`). |
| Hosting | Vercel team `ms-lab`, project `mslab` (Hobby, Root Directory `app`, `fra1`). |
| Deploy | A push to `main` of GitHub `mslabinformation-collab/mslab`. |
| Database | Maria's Railway project `mslab` (Postgres 18, EU West). |
| Mail | Maria's Resend, domain `send.mslab.ee`, from `info` + `@send.mslab.ee`. |
| Payments | Maria's Montonio store: sandbox keys first (Task 12), live keys before the public launch (`docs/launch-checklist.md` §10). |

### Commits and dependencies

- **Commits:** Conventional Commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The repo-local `git user.email` stays the GitHub noreply address.
- **No new dependency.** HS256 comes from `node:crypto`; the fake Montonio is `node:http`.

### Commands (from `app/`)

- Unit and DB tests: `npx vitest run <file>`; all: `npx vitest run`.
- Types and lint: `npx tsc --noEmit`, then `npx eslint .`.
- E2E against `next dev`: `npx playwright test <spec>`; the production build: `E2E_PROD_BUILD=1 npx playwright test <spec>`; the coming-soon gate: `npx playwright test -c playwright.gate.config.ts`.
  - A dev server you started yourself is reused by the e2e run (`reuseExistingServer`); stop it first, or it talks to your own `.env.local` (the real sandbox) instead of the fake Montonio.
- **Each task ends green on its own:** the whole `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`, the e2e specs the task names (dev, and `E2E_PROD_BUILD=1` where it says so), and the gate run when the gate changes.

---

## File Structure

```
app/
  drizzle/0006_phase2b_payments.sql              generated: payments, enums, seat_hold_until, pay_token (Task 1)
  src/db/schema.ts                               payKind, payStatus, payments, registrations.seatHoldUntil/payToken (Task 1)
  src/db/queries/seats.ts                        takesSeat, seatsTaken, hasFreeSeat: the one seat count (Task 1)
  src/db/queries/public.ts, admin.ts             the counts use it: SessionWithSeats.taken, AdminSessionRow.taken (Task 1); addRegistrationPayment (Task 3)
  src/db/queries/payments.ts                     insertPayment, attachOrder, failPayment, releaseHold … (Task 3); the check's queries (Task 8); the admin lists (Task 9)
  src/domain/sessions.ts                         SEAT_HOLD_MS, holdUntil, holdsSeat (Task 1)
  src/domain/payments.ts                         orderReference (Task 3); amountDue (Task 4); the return fragment (Task 6); needsCheck (Task 9)
  src/server/env.ts                              the MONTONIO_* and mock settings, paymentsEnv (Task 2)
  src/server/payments/jwt.ts                     HS256 sign and verify (Task 2)
  src/server/payments/montonio.ts                config, createOrder, fetchOrder, verifyOrderToken, the status map, euro↔cent (Task 2)
  src/server/payments/settle.ts                  settleToken, settlePayment: the one door; mails and Maria's notice (Task 3); the e-course grant (Task 7)
  src/server/payments/routes.ts                  handleNotify (Task 3), handleReturn (Task 6)
  src/server/payments/start.ts                   startRegistrationPayment (Task 4), startEcoursePayment (Task 7)
  src/server/payments/grant.ts                   grantPurchase: client, access, by "payment" (Task 7)
  src/server/payments/check.ts                   checkPendingPayments: the daily check (Task 8)
  src/server/pay-page.ts                         loadPayView, payPage, handlePayPage: /maksa/<token> (Task 5)
  src/server/messages.ts                         paymentSummary, paymentAlertSummary for Maria (Task 3)
  src/server/account-mail.ts                     registrationPaidMail (Task 3), the "Maksa" button in the confirmation (Task 4), ecourseOpenMail (Task 7)
  src/server/submit.ts, forms.ts, actions/public.ts   the registration starts a payment (Task 4); the e-course purchase (Task 7)
  src/server/account-api.ts, account-input.ts    POST /api/konto/maksa, payOnline on the dashboard (Task 5)
  src/app/api/payments/notify/route.ts           the webhook (Task 3)
  src/app/api/payments/return/route.ts           the return (Task 6)
  src/app/maksa/[token]/route.ts                 the pay page (Task 5)
  src/app/[locale]/(site)/makse/page.tsx         the result page (Task 6)
  src/app/api/cron/sweep/route.ts                the daily check (Task 8)
  src/app/admin/(panel)/maksed/page.tsx          the admin's "Maksed" (Task 9)
  src/components/account/AccountCourseCard.tsx (+css)   "Maksa {summa}" / "Maksa ülejäänud {summa}" (Task 5)
  src/components/site/ContactRegister.tsx        the redirect to the payment (Task 4)
  src/components/site/EcoursePurchase.tsx        the cart's purchase form (Task 7)
  src/components/site/PaymentResult.tsx          /makse's content (Task 6)
  src/components/admin/ClientDrawer.tsx, sections.ts, Sidebar's icons   the admin parts (Task 9)
  src/lib/site-gate.ts, site-routing.ts, next.config.ts   the webhook and /maksa through the gate; /makse a page (Tasks 3, 5, 6)
  src/i18n/dict/et.ts, ru.ts, admin.ts           `payment` (Task 3); the admin's `payments` (Task 9)
  tests/e2e/fake-montonio.ts, montonio-values.ts the e2e run's Montonio (Task 2)
  tests/e2e/payments.spec.ts                     every flow end to end (Task 10)
docs/deploy.md, docs/launch-checklist.md         0007 (Task 1); the variables and the go-live list (Task 11)
```

---
### Task 1: Migration 0006 — `payments`, the seat hold and the "Maksa" token; one seat count for every counter

Spec sections 5 and 5.3 (D2). Columns, a table and one shared seat expression; nothing creates a payment or a hold before Task 4, so every counter still sees what it saw (no registration has a hold yet). The drop of `courses.modules` becomes 0007.

**Where the seat helper lives (spec 14).** The rule is SQL (`db/queries/seats.ts takesSeat`), because three of the four counters count in the database (submit's full check, the public calendar and course page, the admin's calendar and overview). `domain/sessions.ts` keeps the pure side: `holdsSeat` for one row in memory, and `seatsLeft` / `seatState`, which now take the seats **taken** (confirmed plus live holds). A test pins that `takesSeat` and `holdsSeat` agree.

**`pay_token` for existing rows (spec 5.2).** The column's default is computed in SQL from two `gen_random_uuid()` (built into Postgres 13+ and PGlite; 244 random bits), base64url without padding: 43 characters, the shape of `newToken()`. `ADD COLUMN … DEFAULT <volatile> NOT NULL` evaluates the default once per existing row, so the migration fills every row with its own token, and any SQL insert that names no token (the e2e fixtures) still gets one. The app's own insert (`createRegistration`) passes `newToken()`.

**Files:**
- Modify: `app/src/db/schema.ts`
- Create: `app/drizzle/0006_phase2b_payments.sql` (+ `app/drizzle/meta/0006_snapshot.json` and the `_journal.json` entry, from drizzle-kit)
- Create: `app/src/db/queries/seats.ts`
- Modify: `app/src/domain/sessions.ts`, `app/src/db/queries/public.ts`, `app/src/db/queries/admin.ts`, `app/src/server/submit.ts`
- Modify (the counts' readers): `app/src/app/[locale]/(site)/koolitused/[slug]/page.tsx`, `app/src/app/[locale]/(site)/koolituskalender/page.tsx`, `app/src/app/admin/(panel)/kalender/page.tsx`, `app/src/app/admin/(panel)/page.tsx`
- Modify (the 0007 texts): `app/drizzle/0003_lessons.sql` (comment line only), `app/tests/db/migration-0003.test.ts` (comment), `docs/launch-checklist.md` §8, `docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md`
- Test: `app/tests/db/migration-0006.test.ts` (new), `app/tests/db/seats.test.ts` (new), `app/tests/unit/domain.test.ts` (extend)
- Update: `app/tests/db/queries.test.ts`, `app/tests/db/demo-data.test.ts`, `app/tests/db/seed.test.ts` (`.confirmed` → `.taken`)

**Interfaces:**
- Produces, from `src/db/schema.ts`:
  - `payKind = pgEnum("payment_kind", ["prepayment", "balance", "ecourse"])`, `payStatus = pgEnum("payment_status", ["pending", "paid", "failed", "refunded", "held"])`;
  - `registrations.seatHoldUntil: Date | null`, `registrations.payToken: string` (unique index `registrations_pay_token`);
  - the table `payments` (columns of spec 5.1: `id, reference, kind, registrationId, courseId, clientId, email, name, locale, amountCents, status, providerUuid, method, bank, newsletter, createdAt, paidAt, updatedAt`);
  - `type Payment = typeof payments.$inferSelect`, `type PaymentKind = Payment["kind"]`, `type PaymentStatus = Payment["status"]`.
- Produces, from `src/domain/sessions.ts`: `SEAT_HOLD_MS = 30 * 60_000`; `holdUntil(now: Date): Date`; `holdsSeat(r: { status: RegStatus; seatHoldUntil: Date | null }, now: Date): boolean`; `seatsLeft(capacity: number, taken: number): number`; `seatState(s, taken: number): SeatState`.
- Produces, from `src/db/queries/seats.ts`: `takesSeat(now: Date): SQL`; `seatsTaken(q: Q, sessionIds: number[], now?: Date, opts?: { except?: number }): Promise<Map<number, number>>`; `hasFreeSeat(q: Q, session: { id: number; capacity: number }, now: Date, except?: number): Promise<boolean>`.
- Produces, from `src/db/queries/public.ts`: `SessionWithSeats = CourseSession & { taken: number }` (was `confirmed`).
- Produces, from `src/db/queries/admin.ts`: `AdminSessionRow.taken: number`; `listAdminSessions(db, opts, now: Date = new Date())`.

- [ ] **Step 1: Write the failing migration test** `tests/db/migration-0006.test.ts`:

```ts
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses, courseSessions, payments, registrations } from "@/db/schema";
import { isTokenShape } from "@/server/token";
import { migrationsThrough } from "./helpers";

// Migration 0006 (phase 2b) as the Railway database goes through it: 0000–0005 applied, three registrations written by the live code (which
// knows no pay_token), then 0006. Each of them gets its own "Maksa" token in the shape of newToken(), no seat hold, and the payments table is
// there, empty, with its rules: a positive amount, a unique reference, and a payment kept (unlinked) when its registration is deleted.

test("0006 gives every registration its own pay token, no hold, and adds the payments table with its rules", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0005_phase2c");
  const [course] = await db
    .insert(courses)
    .values({ slug: "k", type: "contact", level: "basic", title: { et: "K" }, summary: { et: "" }, body: { et: "" }, priceGroup: 35000 })
    .returning();
  const [session] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" }).returning();
  // the live code's insert: it knows no pay_token or seat_hold_until (raw SQL: drizzle would name the new columns)
  for (const email of ["a@example.test", "b@example.test", "c@example.test"])
    await db.execute(sql`insert into registrations (course_id, course_session_id, kind, name, email, payment_choice) values (${course.id}, ${session.id}, 'group', 'X', ${email}, 'half')`);

  await through("0006_phase2b_payments");

  const rows = await db.select({ token: registrations.payToken, hold: registrations.seatHoldUntil }).from(registrations);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.token)).size).toBe(3);
  for (const r of rows) {
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isTokenShape(r.token)).toBe(true);
    expect(r.hold).toBeNull();
  }
  // an insert that names no token (the e2e fixtures' SQL) still gets one, a different one
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) values (${course.id}, 'individual', 'Y', 'y@example.test', 'full')`);
  expect(new Set((await db.select({ token: registrations.payToken }).from(registrations)).map((r) => r.token)).size).toBe(4);

  // payments: the amount is positive, the reference unique, and a deleted registration leaves its payment (unlinked) for the books
  const [reg] = await db.select({ id: registrations.id }).from(registrations).where(eq(registrations.email, "a@example.test"));
  const base = { kind: "prepayment" as const, registrationId: reg.id, courseId: course.id, email: "a@example.test", name: "A", amountCents: 17500 };
  expect(await db.select().from(payments)).toEqual([]);
  await expect(db.insert(payments).values({ ...base, reference: "MSLAB-M0", amountCents: 0 })).rejects.toThrow();
  const [p] = await db.insert(payments).values({ ...base, reference: "MSLAB-M1" }).returning();
  expect(p).toMatchObject({ status: "pending", locale: "et", method: "", bank: "", newsletter: false, providerUuid: null, paidAt: null, clientId: null });
  await expect(db.insert(payments).values({ ...base, reference: "MSLAB-M1" })).rejects.toThrow();
  await db.delete(registrations).where(eq(registrations.id, reg.id));
  expect((await db.select().from(payments))[0]).toMatchObject({ reference: "MSLAB-M1", registrationId: null, courseId: course.id, email: "a@example.test" });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `cd app && npx vitest run tests/db/migration-0006.test.ts` fails: `payments`, `payToken` and `seatHoldUntil` do not exist (vitest reports the TypeScript errors as a failed transform, or `migrationsThrough("0006_phase2b_payments")` fails its own `expect(at).toBeGreaterThanOrEqual(0)`).

- [ ] **Step 3: Change the schema** (`src/db/schema.ts`).
  1. Add `check` to the `drizzle-orm/pg-core` import.
  2. After `export const requestKind = …`, add:

```ts
/** An online payment (phase 2b): a registration's prepayment, its rest after the prepayment, or an e-course purchase. */
export const payKind = pgEnum("payment_kind", ["prepayment", "balance", "ecourse"]);
/** pending: started; paid; failed (ended unpaid, or voided by the bank after paid); refunded; held: paid, but the amount or currency did not match. */
export const payStatus = pgEnum("payment_status", ["pending", "paid", "failed", "refunded", "held"]);
```

  3. In `registrations`, after `clientId`, add:

```ts
  /**
   * The seat hold of an unpaid registration (phase 2b, D2): until this moment an `awaiting_prepayment` registration takes a seat
   * (db/queries/seats.ts takesSeat). Set to now + 30 minutes when its prepayment starts (server/payments/start.ts); null without one.
   */
  seatHoldUntil: timestamp("seat_hold_until", { withTimezone: true }),
  /**
   * The "Maksa" link's token (phase 2b, /maksa/<payToken>): 32 random bytes in base64url (server/token.ts newToken). A row written
   * without one (the migration's existing rows, the e2e fixtures' SQL) gets one from the default: two gen_random_uuid()s, 244 random bits,
   * in the same 43-character shape. It reveals nothing and is never logged.
   */
  payToken: text("pay_token")
    .notNull()
    .default(sql`translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_')`),
```

     and in its index list add `uniqueIndex("registrations_pay_token").on(t.payToken),`.
  4. After `export const mailQuota = …`, add:

```ts
// ---------- phase 2b: online payments (Montonio) ----------

/**
 * One online payment attempt (phase 2b, spec 5.1). `reference` is Montonio's merchantReference, `MSLAB-M<id>` (domain/payments.ts
 * orderReference), written in the insert's own transaction (db/queries/payments.ts insertPayment): every attempt is a new order.
 * `email` and `name` are the payer's as entered, kept for the books when the account or the registration is deleted (the links are set
 * null). `held`: Montonio said paid, but the amount or the currency did not match (server/payments/settle.ts). `paidAt` stays set when
 * the bank voids a paid payment (status failed), which the admin shows as "Kontrolli Montonios".
 */
export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    reference: text("reference").notNull(),
    kind: payKind("kind").notNull(),
    registrationId: integer("registration_id").references(() => registrations.id, { onDelete: "set null" }),
    courseId: integer("course_id").references(() => courses.id, { onDelete: "set null" }),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    locale: text("locale").$type<"et" | "ru">().notNull().default("et"),
    amountCents: integer("amount_cents").notNull(),
    status: payStatus("status").notNull().default("pending"),
    providerUuid: text("provider_uuid"),
    method: text("method").notNull().default(""),
    bank: text("bank").notNull().default(""),
    /** E-course: "Soovin MS LABi uudiseid ja pakkumisi" was ticked in the cart; acted on when paid. */
    newsletter: boolean("newsletter").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_reference").on(t.reference),
    uniqueIndex("payments_provider_uuid").on(t.providerUuid),
    index("payments_registration").on(t.registrationId),
    index("payments_client").on(t.clientId),
    index("payments_status_created").on(t.status, t.createdAt),
    check("payments_amount_positive", sql`${t.amountCents} > 0`),
  ],
);
```

  5. At the end of the type list, add:

```ts
export type Payment = typeof payments.$inferSelect;
export type PaymentKind = Payment["kind"];
export type PaymentStatus = Payment["status"];
```

  6. The comment above `courses.modules` becomes `… Migration 0007 drops it after the 3a deploy (code first).`

- [ ] **Step 4: Generate the migration.** Run `cd app && npx drizzle-kit generate --name phase2b_payments`. Open `drizzle/0006_phase2b_payments.sql`. It must hold these statements (in drizzle-kit's order and formatting) and **nothing** that drops or rewrites:
  - `CREATE TYPE "public"."payment_kind" AS ENUM('prepayment', 'balance', 'ecourse');`
  - `CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded', 'held');`
  - `CREATE TABLE "payments" (…)` with the eighteen columns of step 3.4 and `CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0)`;
  - `ALTER TABLE "registrations" ADD COLUMN "seat_hold_until" timestamp with time zone;`
  - `ALTER TABLE "registrations" ADD COLUMN "pay_token" text DEFAULT translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_') NOT NULL;`
  - the three `ALTER TABLE "payments" ADD CONSTRAINT … FOREIGN KEY … ON DELETE set null` lines (registrations, courses, clients);
  - `CREATE UNIQUE INDEX "payments_reference" …`, `CREATE UNIQUE INDEX "payments_provider_uuid" …`, `CREATE INDEX "payments_registration" …`, `CREATE INDEX "payments_client" …`, `CREATE INDEX "payments_status_created" …`, `CREATE UNIQUE INDEX "registrations_pay_token" ON "registrations" USING btree ("pay_token");`.
  - The unique index on `pay_token` must come **after** the `ADD COLUMN` (drizzle-kit writes indexes last). No data step: the default fills the rows.

- [ ] **Step 5: Run** `npx vitest run tests/db/migration-0006.test.ts` — expect PASS.

- [ ] **Step 6: Write the failing seat tests.**
  1. **`tests/unit/domain.test.ts`.** Add `holdsSeat, holdUntil, SEAT_HOLD_MS` to its `@/domain/sessions` import and append:

```ts
describe("the seat hold (phase 2b, D2)", () => {
  const NOW = new Date("2026-10-09T10:00:00Z");
  test("a hold lasts Montonio's payment window, 30 minutes", () => {
    expect(SEAT_HOLD_MS).toBe(30 * 60_000);
    expect(holdUntil(NOW)).toEqual(new Date("2026-10-09T10:30:00Z"));
  });
  test("confirmed takes a seat; awaiting only while its hold has not ended; cancelled never", () => {
    const later = new Date(NOW.getTime() + 1);
    expect(holdsSeat({ status: "confirmed", seatHoldUntil: null }, NOW)).toBe(true);
    expect(holdsSeat({ status: "awaiting_prepayment", seatHoldUntil: later }, NOW)).toBe(true);
    expect(holdsSeat({ status: "awaiting_prepayment", seatHoldUntil: NOW }, NOW)).toBe(false); // ends at that moment
    expect(holdsSeat({ status: "awaiting_prepayment", seatHoldUntil: null }, NOW)).toBe(false);
    expect(holdsSeat({ status: "cancelled", seatHoldUntil: later }, NOW)).toBe(false);
  });
});
```

  2. **`tests/db/seats.test.ts`** (new):

```ts
import { expect, test } from "vitest";
import type { Db } from "@/db/client";
import { listAdminSessions } from "@/db/queries/admin";
import { getCourseBySlug, listUpcomingSessions } from "@/db/queries/public";
import { hasFreeSeat, seatsTaken } from "@/db/queries/seats";
import { courses, courseSessions, registrations } from "@/db/schema";
import { holdsSeat } from "@/domain/sessions";
import type { Env } from "@/server/notify";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { makeTestDb } from "./helpers";

// One seat count (phase 2b, spec 5.3, D2): a registration takes a seat when it is confirmed, or awaiting its prepayment with a hold that has
// not ended. The registration form's full check, the public calendar and course page, and the admin's calendar count with it.

const MIN = 60_000;
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

/** A published contact course with one session of `capacity`, starting in 30 days from the real clock (the public queries read it). */
async function course(db: Db, capacity: number) {
  const [c] = await db.insert(courses).values({ ...base, slug: "kulmud", type: "contact", title: { et: "Kulmud" }, published: true, priceGroup: 35000 }).returning();
  const [s] = await db.insert(courseSessions).values({ courseId: c.id, startsAt: new Date(Date.now() + 30 * 86_400_000), city: "Pärnu", capacity }).returning();
  return { c, s };
}

const reg = (courseId: number, sessionId: number, n: string, status: "confirmed" | "awaiting_prepayment" | "cancelled", seatHoldUntil: Date | null = null) => ({
  courseId,
  courseSessionId: sessionId,
  kind: "group" as const,
  name: n,
  email: `${n}@example.test`,
  paymentChoice: "half" as const,
  status,
  seatHoldUntil,
});

test("seatsTaken counts confirmed and live holds; an ended hold, no hold and cancelled do not; `except` leaves one row out", async () => {
  const db = await makeTestDb();
  const { c, s } = await course(db, 4);
  const now = new Date("2026-10-09T10:00:00Z");
  const rows = await db
    .insert(registrations)
    .values([
      reg(c.id, s.id, "a", "confirmed"),
      reg(c.id, s.id, "b", "awaiting_prepayment", new Date(now.getTime() + 10 * MIN)),
      reg(c.id, s.id, "c", "awaiting_prepayment", new Date(now.getTime() - MIN)),
      reg(c.id, s.id, "d", "awaiting_prepayment"),
      reg(c.id, s.id, "e", "cancelled", new Date(now.getTime() + 10 * MIN)),
    ])
    .returning();
  expect((await seatsTaken(db, [s.id], now)).get(s.id)).toBe(2);
  // the SQL and the pure rule agree, row by row
  expect(rows.filter((r) => holdsSeat(r, now)).map((r) => r.name)).toEqual(["a", "b"]);
  // 11 minutes later b's hold has ended too
  expect((await seatsTaken(db, [s.id], new Date(now.getTime() + 11 * MIN))).get(s.id)).toBe(1);
  expect((await seatsTaken(db, [s.id], now, { except: rows[1].id })).get(s.id)).toBe(1);
  expect(await seatsTaken(db, [], now)).toEqual(new Map());
  expect(await hasFreeSeat(db, s, now)).toBe(true);
  expect(await hasFreeSeat(db, { id: s.id, capacity: 2 }, now)).toBe(false);
  expect(await hasFreeSeat(db, { id: s.id, capacity: 2 }, now, rows[1].id)).toBe(true); // her own hold is not in her way
});

test("the public calendar and course page, and the admin's calendar, count a live hold as taken", async () => {
  const db = await makeTestDb();
  const { c, s } = await course(db, 4);
  await db.insert(registrations).values([reg(c.id, s.id, "a", "confirmed"), reg(c.id, s.id, "b", "awaiting_prepayment", new Date(Date.now() + 10 * MIN)), reg(c.id, s.id, "c", "awaiting_prepayment")]);
  expect((await getCourseBySlug(db, "kulmud"))!.sessions[0].taken).toBe(2);
  expect((await listUpcomingSessions(db, new Date()))[0].taken).toBe(2);
  const [admin] = await listAdminSessions(db, { ids: [s.id] });
  expect([admin.confirmed, admin.awaiting, admin.taken]).toEqual([1, 2, 2]);
  // an hour later the hold has ended
  const [later] = await listAdminSessions(db, { ids: [s.id] }, new Date(Date.now() + 60 * MIN));
  expect(later.taken).toBe(1);
});

test("the registration form's full check counts a live hold: the last seat is taken until the hold ends", async () => {
  const db = await makeTestDb();
  const { c, s } = await course(db, 1);
  const now = new Date();
  await db.insert(registrations).values(reg(c.id, s.id, "a", "awaiting_prepayment", new Date(now.getTime() + 10 * MIN)));
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: "https://mslab.example" };
  const deps = (at: Date): Deps => ({ db, env, ip: "203.0.113.5", siteUrl: "https://mslab.example", now: at, later: () => {} });
  const form = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ course: "kulmud", session: String(s.id), name: "Kati", email: "kati@example.test", phone: "+372 5555 5555", payment: "half", terms: "on", locale: "et" })) fd.set(k, v);
    return fd;
  };
  expect(await handleRegistration(deps(now), form())).toEqual({ ok: false, errors: { session: "full" } });
  expect(await handleRegistration(deps(new Date(now.getTime() + 11 * MIN)), form())).toEqual({ ok: true });
});
```

- [ ] **Step 7: Run them — expect FAIL**: `npx vitest run tests/unit/domain.test.ts tests/db/seats.test.ts` (`holdsSeat`, `db/queries/seats` and `.taken` do not exist).

- [ ] **Step 8: The pure rule** — replace `src/domain/sessions.ts` with:

```ts
import type { RegStatus } from "./registration";

export type SeatState = "open" | "few" | "full" | "cancelled";

/** How long an unpaid registration holds its seat (phase 2b, D2): Montonio's payment window, 30 minutes. */
export const SEAT_HOLD_MS = 30 * 60_000;

/** The end of a hold that starts `now`. */
export const holdUntil = (now: Date): Date => new Date(now.getTime() + SEAT_HOLD_MS);

/**
 * Does a registration take a seat at `now` (phase 2b, spec 5.3)? Confirmed, or awaiting its prepayment with a hold that has not ended.
 * The database counts with the same rule (db/queries/seats.ts takesSeat); tests/db/seats.test.ts checks that the two agree.
 */
export function holdsSeat(r: { status: RegStatus; seatHoldUntil: Date | null }, now: Date): boolean {
  if (r.status === "confirmed") return true;
  return r.status === "awaiting_prepayment" && r.seatHoldUntil !== null && r.seatHoldUntil.getTime() > now.getTime();
}

/** Seats left when `taken` are taken (confirmed registrations and live holds). */
export function seatsLeft(capacity: number, taken: number): number {
  return Math.max(0, capacity - taken);
}

export function seatState(s: { status: "scheduled" | "cancelled"; capacity: number }, taken: number): SeatState {
  if (s.status === "cancelled") return "cancelled";
  const left = seatsLeft(s.capacity, taken);
  return left === 0 ? "full" : left <= 2 ? "few" : "open";
}
```

- [ ] **Step 9: The SQL rule** — create `src/db/queries/seats.ts`:

```ts
import { and, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Q } from "../client";
import { registrations } from "../schema";

// The one seat count (phase 2b, spec 5.3, D2): a registration takes a seat when it is confirmed, or when it is awaiting its prepayment and
// its hold (seat_hold_until, set when the prepayment starts) has not ended. Every counter uses this expression: the registration form's full
// check (server/submit.ts), the public calendar and course page (db/queries/public.ts), the admin's calendar and overview
// (db/queries/admin.ts), and the payment's own checks (server/payments). domain/sessions.ts holdsSeat is the same rule for one row in memory.

/** The condition "this registration takes a seat at `now`", for a query on `registrations`. */
export function takesSeat(now: Date): SQL {
  return sql`(${registrations.status} = 'confirmed' or (${registrations.status} = 'awaiting_prepayment' and ${registrations.seatHoldUntil} > ${now.toISOString()}::timestamptz))`;
}

/**
 * The seats taken at `now` per session id; sessions with none are absent. `except`: leave this registration out (a payment checks the seats
 * of the others: her own hold, live or ended, is not in her way).
 */
export async function seatsTaken(q: Q, sessionIds: number[], now: Date = new Date(), opts: { except?: number } = {}): Promise<Map<number, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await q
    .select({ sessionId: registrations.courseSessionId, taken: sql<number>`count(*) filter (where ${takesSeat(now)})`.mapWith(Number) })
    .from(registrations)
    .where(and(inArray(registrations.courseSessionId, sessionIds), opts.except === undefined ? undefined : ne(registrations.id, opts.except)))
    .groupBy(registrations.courseSessionId);
  return new Map(rows.flatMap((r) => (r.sessionId == null ? [] : [[r.sessionId, r.taken] as const])));
}

/** Is a seat free in `session` at `now`, counting everybody but `except`? */
export async function hasFreeSeat(q: Q, session: { id: number; capacity: number }, now: Date, except?: number): Promise<boolean> {
  const taken = (await seatsTaken(q, [session.id], now, { except })).get(session.id) ?? 0;
  return taken < session.capacity;
}
```

- [ ] **Step 10: The counters use it.**
  1. **`src/db/queries/public.ts`.**
     - The import from `drizzle-orm` loses `sql`; the import from `../schema` loses `registrations`; add `import { seatsTaken } from "./seats";`.
     - `export type SessionWithSeats = CourseSession & { confirmed: number };` becomes:

```ts
/** A session with the seats taken now (confirmed and live holds, db/queries/seats.ts). */
export type SessionWithSeats = CourseSession & { taken: number };
```

     - Delete the function `confirmedBySession` (and its doc comment).
     - In `getCourseBySlug`: `confirmedBySession(db, course.sessions.map((s) => s.id))` becomes `seatsTaken(db, course.sessions.map((s) => s.id))`, and `confirmed: counts.get(s.id) ?? 0` becomes `taken: counts.get(s.id) ?? 0`.
     - In `listUpcomingSessions`: `const counts = await seatsTaken(db, rows.map((r) => r.session.id));` and `taken: counts.get(r.session.id) ?? 0`.
  2. **`src/db/queries/admin.ts`.** Add `import { takesSeat } from "./seats";`. In `AdminSessionRow`, after `awaiting: number;`, add:

```ts
  /** Seats taken now: the confirmed ones and the live holds of unpaid ones (phase 2b, db/queries/seats.ts). What "vabu" counts against. */
  taken: number;
```

     `listAdminSessions`'s signature becomes `(db: Db, opts: { from: Date; upcoming: boolean } | { ids: number[] }, now: Date = new Date())`; in its `regs` select add `taken: sql<number>\`count(*) filter (where ${takesSeat(now)})\`.mapWith(Number),` after `awaiting`; in the returned rows add `taken: reg.get(r.session.id)?.taken ?? 0,` after `awaiting`.
  3. **`src/server/submit.ts`.**
     - The `drizzle-orm` import loses `sql`; add `import { seatsTaken } from "@/db/queries/seats";` and `import { newToken, sha256 } from "./token";` stays as it is.
     - Replace `sessionWithSeats` with:

```ts
/** A session with the seats taken at `now` (confirmed and live holds, db/queries/seats.ts), counted now: the page the visitor saw may be out of date. */
async function sessionWithSeats(db: Db, id: number, now: Date): Promise<(CourseSession & { taken: number }) | null> {
  const [session] = await db.select().from(courseSessions).where(eq(courseSessions.id, id)).limit(1);
  if (!session) return null;
  return { ...session, taken: (await seatsTaken(db, [id], now)).get(id) ?? 0 };
}
```

     - In `handleRegistration`: `await sessionWithSeats(deps.db, courseSessionId, deps.now)` and `seatState(session, session.taken)`.
     - In `createRegistration`'s `.values({ … })`, after `paidCents: 0,` add `payToken: newToken(),` and in its doc comment add the sentence "Its "Maksa" token is a fresh newToken() (phase 2b)."
  4. **The readers.**
     - `src/app/[locale]/(site)/koolitused/[slug]/page.tsx`: `seatState(s, s.confirmed)` → `seatState(s, s.taken)`; `seatsLeft(s.capacity, s.confirmed)` → `seatsLeft(s.capacity, s.taken)`.
     - `src/app/[locale]/(site)/koolituskalender/page.tsx`: the same two replacements.
     - `src/app/admin/(panel)/kalender/page.tsx`: both `seatsLeft(s.capacity, s.confirmed)` (in `stateTag` and in the table's "left") → `seatsLeft(s.capacity, s.taken)`. The label `fill(t.seats, { confirmed: s.confirmed, … })` stays (it counts the confirmed people).
     - `src/app/admin/(panel)/page.tsx`: `seatsLeft(s.capacity, s.confirmed)` → `seatsLeft(s.capacity, s.taken)`.
  5. **The tests that read the old name.**
     - `tests/db/queries.test.ts`: the three `.confirmed` of sessions (`c?.sessions[0].confirmed`, `list[0].confirmed`, `list[1].confirmed`) become `.taken`; the test titles "counts only confirmed registrations per session" → "counts the seats taken per session (confirmed; live holds since phase 2b)" and "… with course and confirmed count" → "… with course and seats taken".
     - `tests/db/demo-data.test.ts`: `seatState(s, s.confirmed)` → `seatState(s, s.taken)`.
     - `tests/db/seed.test.ts` (the seed's upcoming sessions): `expect(sessions.every((s) => s.confirmed === 0)).toBe(true);` → `expect(sessions.every((s) => s.taken === 0)).toBe(true);` (with `.confirmed` gone the old line compares `undefined` and fails).

- [ ] **Step 11: Run** `npx vitest run tests/unit/domain.test.ts tests/db/seats.test.ts tests/db/queries.test.ts tests/db/demo-data.test.ts tests/db/seed.test.ts tests/db/admin-content.test.ts tests/db/actions.test.ts` — expect PASS.

- [ ] **Step 12: Migration 0007 everywhere the texts said 0006** (the drop of `courses.modules`).
  - **`app/drizzle/0003_lessons.sql`.** In the data step's comment, `(migration 0006 drops it after the 3a deploy)` → `(migration 0007 drops it after the 3a deploy)`. The comment only: drizzle's migrator compares the journal's time stamps, not the file's text.
  - **`app/tests/db/migration-0003.test.ts`.** In the comment, `migration 0006 drops the column` → `migration 0007 drops the column`.
  - **`docs/launch-checklist.md` §8.** "Migration 0006 (drops `courses.modules`) …" → "Migration 0007 (drops `courses.modules`) …"; the rest of the line stays.
  - **`docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md`.** Every `0006` in it is the drop (lines 82, 192, 307, 461, 4500, 5204, 5221, 5227, 5300, 5310): replace each with `0007`. Line 5301 `  - (Phase 2c took 0005 for its own additive migration; the drop is 0006.)` becomes `  - (Phase 2c took 0005 and phase 2b 0006 for their own additive migrations; the drop is 0007.)`. In step 11.5, "the migrations count is 7" → "the migrations count is 8".
  - Check: `grep -rn "0006" app/src app/drizzle/0003_lessons.sql app/tests/db/migration-0003.test.ts docs/launch-checklist.md docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md` lists nothing about `courses.modules`.

- [ ] **Step 13: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - Apply locally only: `npm run db:migrate` (the local URL). Then `psql postgres://postgres:postgres@localhost:5432/mslab -c "select count(*) filter (where pay_token is null) as missing, count(distinct pay_token) = count(*) as distinct from registrations"` shows `0 | t`.
  - The e2e specs that show seats: `npx playwright test catalogue course cache` (the counts are unchanged: no row has a hold yet).

- [ ] **Step 14: Commit.**

```bash
git add app/src/db/schema.ts app/drizzle app/src/db/queries/seats.ts app/src/db/queries/public.ts app/src/db/queries/admin.ts app/src/domain/sessions.ts app/src/server/submit.ts "app/src/app/[locale]/(site)/koolitused/[slug]/page.tsx" "app/src/app/[locale]/(site)/koolituskalender/page.tsx" "app/src/app/admin/(panel)/kalender/page.tsx" "app/src/app/admin/(panel)/page.tsx" app/tests docs/launch-checklist.md docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md
git commit -m "feat(db): migration 0006 — payments, seat holds and pay tokens; one seat count; the drop of courses.modules becomes 0007

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Montonio module — HS256, the client, the configuration, and the e2e run's fake Montonio

Spec sections 4, 7.1, 7.2, 7.3 and 12 (unit, docs payloads, the mock). Nothing calls the module yet. Ported from Rempire's `jwt.ts` and `montonio.ts` (the logic, not the layout): HS256 only with `alg` pinned and `timingSafeEqual`, 60 s clock tolerance, the status map, euro↔cent, the base URLs, a 15 s timeout, Montonio's own error text kept.

**Two differences from Rempire, on purpose:**
- `verifyHs256` does not throw on an expired token: it says `expired: true`. Spec 7.4 confirms such a token (Montonio's late retries) with `GET /orders/:uuid` instead of refusing it. A bad signature, a malformed token or another `alg` still throws (`JwtError`): those are the only "unverifiable" tokens (the webhook's 400).
- **The mock is a fake Montonio server, not a second provider class.** `PAYMENT_PROVIDER=mock` only points the real client at `MONTONIO_FAKE_URL` (the e2e run's `tests/e2e/fake-montonio.ts`, like the fake Bunny), so the e2e run exercises the real signing, the real order request and the real token check. It is refused on Vercel, refused in a production build without `PAYMENT_MOCK_IN_PRODUCTION=1`, and any other `PAYMENT_PROVIDER` value turns payments off: there is no silent fallback to it (Rempire's audit C1).

**Files:**
- Modify: `app/src/server/env.ts`, `app/.env.example` (the six names as comments: `tests/unit/env.test.ts` ".env.example documents every variable serverEnv() reads")
- Create: `app/src/server/payments/jwt.ts`, `app/src/server/payments/montonio.ts`
- Create: `app/tests/e2e/montonio-values.ts`, `app/tests/e2e/fake-montonio.ts`
- Modify: `app/tests/e2e/server.ts`, `app/tests/local-secrets.ts`, `app/tests/e2e/prod-build.ts`
- Test: `app/tests/unit/montonio-jwt.test.ts`, `app/tests/unit/montonio.test.ts`, `app/tests/unit/montonio-docs-payloads.test.ts`, `app/tests/unit/montonio-fake.test.ts` (new); `app/tests/unit/env.test.ts`, `app/tests/unit/e2e-local-secrets.test.ts` (extend)

**Interfaces:**
- Produces, from `src/server/env.ts`: `ServerEnv` gains the optional `MONTONIO_ENV`, `MONTONIO_ACCESS_KEY`, `MONTONIO_SECRET_KEY`, `PAYMENT_PROVIDER`, `MONTONIO_FAKE_URL`, `PAYMENT_MOCK_IN_PRODUCTION`; `type PaymentsEnv`; `paymentsEnv(source = process.env): PaymentsEnv` (trimmed, blank = unset, needs none of the required variables).
- Produces, from `src/server/payments/jwt.ts`: `class JwtError` (`code: "malformed" | "alg" | "signature" | "payload"`); `signHs256(payload: Record<string, unknown>, secret: string, opts?: { expiresInSeconds?: number; nowSec?: number }): string`; `verifyHs256<T>(token: string, secret: string, opts?: { toleranceSec?: number; nowSec?: number }): { claims: T; expired: boolean }`.
- Produces, from `src/server/payments/montonio.ts`:
  - `LIVE_BASE`, `SANDBOX_BASE`, `REQUEST_TIMEOUT_MS = 15_000`;
  - `type MontonioStatus = "paid" | "pending" | "failed" | "refunded"`; `mapMontonioStatus(raw: unknown): MontonioStatus`;
  - `toCents(euros: unknown): number | null`; `toEuros(cents: number): number`;
  - `type Runtime = { production: boolean; onVercel: boolean }`; `currentRuntime(): Runtime`;
  - `type MontonioConfig = { accessKey: string; secretKey: string; baseUrl: string; live: boolean; mock: boolean }`;
  - `montonioConfig(env?: PaymentsEnv, runtime?: Runtime): MontonioConfig | null`; `paymentsConfigured(env?: PaymentsEnv, runtime?: Runtime): boolean`;
  - `class MontonioError` (`op: "create" | "fetch"`, `code: "unreachable" | "rejected" | "bad_response"`, `detail: string`); `montonioErrorText(status: number, body: string): string`;
  - `type OrderRequest = { reference: string; amountCents: number; locale: "et" | "ru"; returnUrl: string; notificationUrl: string }`;
  - `type OrderToken = { uuid: string; accessKey: string | null; reference: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string; bank: string; expired: boolean }`;
  - `type OrderSnapshot = { uuid: string; reference: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string }`;
  - `type Montonio = { readonly accessKey: string; createOrder(order: OrderRequest): Promise<{ uuid: string; paymentUrl: string }>; fetchOrder(uuid: string): Promise<OrderSnapshot | null>; verifyOrderToken(token: string): OrderToken }`;
  - `montonioClient(config: MontonioConfig, fetchImpl?: typeof fetch, clock?: () => number): Montonio`; `paymentProvider(env?: PaymentsEnv, runtime?: Runtime): Montonio | null`.
- Produces, for the e2e run: `E2E_MONTONIO` (`port` 3997 or `E2E_MONTONIO_PORT`, `url`, `accessKey`, `secretKey`) from `tests/e2e/montonio-values.ts`; `createFakeMontonio(keys?): Server` from `tests/e2e/fake-montonio.ts`; `LOCAL_ENV` gains `MONTONIO_ENV`, `MONTONIO_ACCESS_KEY`, `MONTONIO_SECRET_KEY`, `PAYMENT_PROVIDER: "mock"`, `MONTONIO_FAKE_URL`; `PROD_ENV` gains `PAYMENT_MOCK_IN_PRODUCTION: "1"`.

- [ ] **Step 1: Write the failing JWT tests** `tests/unit/montonio-jwt.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { JwtError, signHs256, verifyHs256 } from "@/server/payments/jwt";

// HS256 on node:crypto (phase 2b, spec 7.1): what Montonio signs every request and every answer with. Only HS256 is accepted, the signature is
// compared in constant time, and an expired token is reported (spec 7.4 confirms it with Montonio) rather than refused.

const SECRET = "test-secret-key-0123456789abcdef";
const NOW = 1_791_500_000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signed = (header: unknown, payload: unknown, secret = SECRET) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof JwtError ? e.code : "other";
  }
  return "none";
};

describe("signHs256 and verifyHs256", () => {
  test("a round trip keeps the claims and stamps iat (and exp when asked)", () => {
    const token = signHs256({ merchantReference: "MSLAB-M1", grandTotal: 175.5 }, SECRET, { expiresInSeconds: 600, nowSec: NOW });
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(verifyHs256(token, SECRET, { nowSec: NOW })).toEqual({ claims: { merchantReference: "MSLAB-M1", grandTotal: 175.5, iat: NOW, exp: NOW + 600 }, expired: false });
    expect(verifyHs256(signHs256({ a: 1 }, SECRET, { nowSec: NOW }), SECRET).claims).toEqual({ a: 1, iat: NOW });
  });

  test("another secret, a changed payload or a cut signature: 'signature'", () => {
    const token = signHs256({ grandTotal: 175 }, SECRET, { nowSec: NOW });
    expect(code(() => verifyHs256(token, "another-secret-0123456789abcdef"))).toBe("signature");
    const [h, , s] = token.split(".");
    expect(code(() => verifyHs256(`${h}.${b64({ grandTotal: 1 })}.${s}`, SECRET))).toBe("signature");
    expect(code(() => verifyHs256(`${h}.${token.split(".")[1]}.${s.slice(1)}`, SECRET))).toBe("signature");
    expect(code(() => signHs256({}, ""))).toBe("signature");
    expect(code(() => verifyHs256(token, ""))).toBe("signature");
  });

  test("alg 'none' or any other algorithm is refused before the signature is looked at: 'alg'", () => {
    expect(code(() => verifyHs256(`${b64({ alg: "none", typ: "JWT" })}.${b64({ paymentStatus: "PAID" })}.`, SECRET))).toBe("alg");
    expect(code(() => verifyHs256(signed({ alg: "RS256", typ: "JWT" }, { paymentStatus: "PAID" }), SECRET))).toBe("alg");
    expect(code(() => verifyHs256(signed(null, { paymentStatus: "PAID" }), SECRET))).toBe("alg");
  });

  test("not three parts, a header or a payload that is no JSON: 'malformed'; a payload that is no object: 'payload'", () => {
    for (const bad of ["", "a.b", "a.b.c.d", "!!.e30.x"]) expect(code(() => verifyHs256(bad, SECRET)), bad).toBe("malformed");
    expect(code(() => verifyHs256(123 as unknown as string, SECRET))).toBe("malformed");
    const head = b64({ alg: "HS256", typ: "JWT" });
    const notJson = Buffer.from("{not json").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(`${head}.${notJson}`).digest("base64url");
    expect(code(() => verifyHs256(`${head}.${notJson}.${sig}`, SECRET))).toBe("malformed");
    expect(code(() => verifyHs256(signed({ alg: "HS256", typ: "JWT" }, [1, 2]), SECRET))).toBe("payload");
    expect(code(() => verifyHs256(signed({ alg: "HS256", typ: "JWT" }, "PAID"), SECRET))).toBe("payload");
  });

  test("expired: only past exp plus the 60 s tolerance, and reported, not thrown; no exp never expires", () => {
    const token = signHs256({ paymentStatus: "PAID" }, SECRET, { expiresInSeconds: 600, nowSec: NOW });
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 600 + 60 }).expired).toBe(false);
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 600 + 61 }).expired).toBe(true);
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 600 + 61 }).claims.paymentStatus).toBe("PAID");
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 700, toleranceSec: 120 }).expired).toBe(false);
    expect(verifyHs256(signHs256({ a: 1 }, SECRET, { nowSec: 0 }), SECRET).expired).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/unit/montonio-jwt.test.ts` (`@/server/payments/jwt` does not exist).

- [ ] **Step 3: Write `src/server/payments/jwt.ts`:**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

// HS256 JSON Web Tokens on node:crypto (phase 2b, spec 7.1). Montonio signs every request with the store's secret key and every answer the
// same way; its own examples reach for a package for two functions, and these are those two (ported from Rempire's integration). HS256 only:
// a token whose header names any other algorithm ("none", RS256 with the HMAC key as its public key) is refused before its signature is even
// looked at. The signature is compared in constant time. An expired token is reported, not refused: the caller confirms it with Montonio
// (server/payments/settle.ts). Nothing here logs: a token is never logged.

export type JwtErrorCode = "malformed" | "alg" | "signature" | "payload";

/** A token that cannot be trusted, and so never a paid order. `code` may be logged; the token never is. */
export class JwtError extends Error {
  constructor(readonly code: JwtErrorCode) {
    super(`jwt ${code}`);
    this.name = "JwtError";
  }
}

type Claims = Record<string, unknown>;

const json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const parse = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const sign = (input: string, secret: string): string => createHmac("sha256", secret).update(input).digest("base64url");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Signs `payload` with `secret`: `iat` is stamped, and `exp` = iat + `expiresInSeconds` when asked and not given. */
export function signHs256(payload: Claims, secret: string, opts: { expiresInSeconds?: number; nowSec?: number } = {}): string {
  if (!secret) throw new JwtError("signature");
  const now = opts.nowSec ?? nowSeconds();
  const body: Claims = { ...payload, iat: now };
  if (opts.expiresInSeconds !== undefined && body.exp === undefined) body.exp = now + opts.expiresInSeconds;
  const input = `${json({ alg: "HS256", typ: "JWT" })}.${json(body)}`;
  return `${input}.${sign(input, secret)}`;
}

/**
 * The claims of a token signed with `secret`, and whether it is past its `exp` by more than `toleranceSec` (default 60). Throws a JwtError
 * for anything that cannot be trusted: not three parts, a header or payload that is no JSON ("malformed"), an algorithm other than HS256
 * ("alg"), a signature that does not match ("signature"), a payload that is not an object ("payload").
 */
export function verifyHs256<T extends Claims = Claims>(token: string, secret: string, opts: { toleranceSec?: number; nowSec?: number } = {}): { claims: T; expired: boolean } {
  if (!secret) throw new JwtError("signature");
  if (typeof token !== "string") throw new JwtError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed");
  const [head, body, signature] = parts;
  let header: unknown;
  try {
    header = parse(head);
  } catch {
    throw new JwtError("malformed");
  }
  if (typeof header !== "object" || header === null || (header as Claims).alg !== "HS256") throw new JwtError("alg");
  const expected = Buffer.from(sign(`${head}.${body}`, secret));
  const given = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which is a mismatch too
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError("signature");
  let claims: unknown;
  try {
    claims = parse(body);
  } catch {
    throw new JwtError("malformed");
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new JwtError("payload");
  const exp = (claims as Claims).exp;
  const expired = typeof exp === "number" && (opts.nowSec ?? nowSeconds()) > exp + (opts.toleranceSec ?? 60);
  return { claims: claims as T, expired };
}
```

- [ ] **Step 4: Run** `npx vitest run tests/unit/montonio-jwt.test.ts` — expect PASS.

- [ ] **Step 5: The settings** (`src/server/env.ts`).
  1. In `ServerEnv`, after `PREVIEW_SECRET?: string;`, add:

```ts
  /** Montonio (phase 2b, docs/deploy.md section 2): only the exact "live" is production; anything else is the sandbox. */
  MONTONIO_ENV?: string;
  /** The Montonio store's access key and secret key, per store and environment. Both, or no online payments. */
  MONTONIO_ACCESS_KEY?: string;
  MONTONIO_SECRET_KEY?: string;
  /** "mock": the e2e run's fake Montonio at MONTONIO_FAKE_URL (tests/e2e/fake-montonio.ts). Refused on Vercel; in a production build only with PAYMENT_MOCK_IN_PRODUCTION=1. */
  PAYMENT_PROVIDER?: string;
  MONTONIO_FAKE_URL?: string;
  PAYMENT_MOCK_IN_PRODUCTION?: string;
```

  2. Add the six names, in that order, at the end of `OPTIONAL`.
  3. After `gateEnv`, add:

```ts
/** The payment settings (server/payments/montonio.ts montonioConfig). */
export type PaymentsEnv = Partial<
  Pick<ServerEnv, "MONTONIO_ENV" | "MONTONIO_ACCESS_KEY" | "MONTONIO_SECRET_KEY" | "PAYMENT_PROVIDER" | "MONTONIO_FAKE_URL" | "PAYMENT_MOCK_IN_PRODUCTION">
>;

const PAYMENT_NAMES = ["MONTONIO_ENV", "MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER", "MONTONIO_FAKE_URL", "PAYMENT_MOCK_IN_PRODUCTION"] as const;

/**
 * The payment settings alone, trimmed, blank as not set (phase 2b). Not serverEnv(): the static cart page reads them while it renders, and a
 * build or a render must not depend on the six required variables for that.
 */
export function paymentsEnv(source: Source = process.env): PaymentsEnv {
  const out: PaymentsEnv = {};
  for (const name of PAYMENT_NAMES) out[name] = source[name]?.trim() || undefined;
  return out;
}
```

  4. **`tests/unit/env.test.ts`.** In the two lists of optional names (the "every optional one is undefined" test and the full-values test), append `"MONTONIO_ENV", "MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER", "MONTONIO_FAKE_URL", "PAYMENT_MOCK_IN_PRODUCTION"`; in the full source and its `toMatchObject` add `MONTONIO_ENV: "sandbox", MONTONIO_ACCESS_KEY: "access", MONTONIO_SECRET_KEY: "secret", PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997", PAYMENT_MOCK_IN_PRODUCTION: "1"`. Add `paymentsEnv` to the `@/server/env` import and append:

```ts
describe("paymentsEnv (phase 2b)", () => {
  test("the six payment settings, trimmed, blank as not set, without the required ones even in production", () => {
    expect(paymentsEnv({})).toEqual({ MONTONIO_ENV: undefined, MONTONIO_ACCESS_KEY: undefined, MONTONIO_SECRET_KEY: undefined, PAYMENT_PROVIDER: undefined, MONTONIO_FAKE_URL: undefined, PAYMENT_MOCK_IN_PRODUCTION: undefined });
    expect(paymentsEnv({ MONTONIO_ENV: " live ", MONTONIO_ACCESS_KEY: "a\n", MONTONIO_SECRET_KEY: "  ", PAYMENT_PROVIDER: "" })).toMatchObject({ MONTONIO_ENV: "live", MONTONIO_ACCESS_KEY: "a", MONTONIO_SECRET_KEY: undefined, PAYMENT_PROVIDER: undefined });
  });
});
```

  5. **`app/.env.example`.** The existing test ".env.example documents every variable serverEnv() reads, the optional ones as comments" (`tests/unit/env.test.ts`) reads `Object.keys(serverEnv({}, false))`, which now holds the six names: without them in the example it fails. After the `# PREVIEW_SECRET=` line, append (comments only, no value: the example stays a complete production configuration without payments):

```
# Online payments (phase 2b, docs/deploy.md section 11): Maria's Montonio store. Both keys or none: without them there are no online
# payments and the site behaves as before. MONTONIO_ENV: only the exact "live" is Montonio's production, anything else its sandbox.
# For trying payments under `next dev`, the SANDBOX keys go in .env.local (git-ignored); the e2e run overrides them with its fake's.
# The secret key is sensitive: Vercel or .env.local only, never in a tracked file
# MONTONIO_ENV=
# MONTONIO_ACCESS_KEY=
# MONTONIO_SECRET_KEY=
# the e2e run's fake Montonio (tests/local-secrets.ts and tests/e2e/prod-build.ts set them for the servers it starts): "mock" points the
# payments at MONTONIO_FAKE_URL; refused on Vercel, and in a production build without PAYMENT_MOCK_IN_PRODUCTION=1. Never on Vercel
# PAYMENT_PROVIDER=
# MONTONIO_FAKE_URL=
# PAYMENT_MOCK_IN_PRODUCTION=
```

- [ ] **Step 6: Write the failing client tests** `tests/unit/montonio.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { signHs256, verifyHs256 } from "@/server/payments/jwt";
import {
  LIVE_BASE, MontonioError, SANDBOX_BASE, mapMontonioStatus, montonioClient, montonioConfig, paymentsConfigured, toCents, toEuros, type MontonioConfig,
} from "@/server/payments/montonio";
import { stubFetch } from "../fakes";

// The Montonio client (phase 2b, spec 4, 7.1–7.3): which store and which address the settings give, the status map, euro↔cent, the order
// request exactly as spec 4 asks (and nothing it forbids), GET /orders/:uuid, and the order token. Montonio is a stubbed fetch here.

const KEYS = { MONTONIO_ACCESS_KEY: "test-access-key", MONTONIO_SECRET_KEY: "test-secret-key-0123456789abcdef" };
const LOCAL = { production: false, onVercel: false };
const CONFIG: MontonioConfig = { accessKey: KEYS.MONTONIO_ACCESS_KEY, secretKey: KEYS.MONTONIO_SECRET_KEY, baseUrl: SANDBOX_BASE, live: false, mock: false };
const ORDER = { reference: "MSLAB-M7", amountCents: 17550, locale: "ru" as const, returnUrl: "https://mslab.example/api/payments/return", notificationUrl: "https://mslab.example/api/payments/notify" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("montonioConfig: which store, which address", () => {
  test("both keys or nothing: payments are optional", () => {
    expect(montonioConfig({}, LOCAL)).toBeNull();
    expect(montonioConfig({ MONTONIO_ACCESS_KEY: "a" }, LOCAL)).toBeNull();
    expect(montonioConfig({ MONTONIO_SECRET_KEY: "s" }, LOCAL)).toBeNull();
    expect(paymentsConfigured({}, LOCAL)).toBe(false);
    expect(paymentsConfigured(KEYS, LOCAL)).toBe(true);
  });

  test("only the exact 'live' is production; anything else is the sandbox", () => {
    expect(montonioConfig({ ...KEYS, MONTONIO_ENV: "live" }, LOCAL)).toEqual({ accessKey: "test-access-key", secretKey: KEYS.MONTONIO_SECRET_KEY, baseUrl: LIVE_BASE, live: true, mock: false });
    for (const env of [undefined, "sandbox", "Live", "LIVE", "production", "prod"])
      expect(montonioConfig({ ...KEYS, MONTONIO_ENV: env }, LOCAL), String(env)).toMatchObject({ baseUrl: SANDBOX_BASE, live: false, mock: false });
    expect(LIVE_BASE).toBe("https://stargate.montonio.com/api");
    expect(SANDBOX_BASE).toBe("https://sandbox-stargate.montonio.com/api");
    expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: "montonio" }, LOCAL)).toMatchObject({ baseUrl: SANDBOX_BASE, mock: false });
  });

  test("the mock: only PAYMENT_PROVIDER=mock with MONTONIO_FAKE_URL; never on Vercel; in production only with the explicit flag; never a fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = { ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997/" };
    expect(montonioConfig(mock, LOCAL)).toEqual({ accessKey: "test-access-key", secretKey: KEYS.MONTONIO_SECRET_KEY, baseUrl: "http://localhost:3997", live: false, mock: true });
    expect(montonioConfig(mock, { production: false, onVercel: true })).toBeNull();
    expect(montonioConfig({ ...mock, PAYMENT_MOCK_IN_PRODUCTION: "1" }, { production: true, onVercel: true })).toBeNull();
    expect(montonioConfig(mock, { production: true, onVercel: false })).toBeNull();
    expect(montonioConfig({ ...mock, PAYMENT_MOCK_IN_PRODUCTION: "yes" }, { production: true, onVercel: false })).toBeNull();
    expect(montonioConfig({ ...mock, PAYMENT_MOCK_IN_PRODUCTION: "1" }, { production: true, onVercel: false })).toMatchObject({ mock: true });
    expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: "mock" }, LOCAL)).toBeNull(); // no fake address: off, not the real store
    for (const other of ["Mock", "fake", "stripe"]) expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: other, MONTONIO_FAKE_URL: "http://localhost:3997" }, LOCAL), other).toBeNull();
  });
});

describe("the status map (spec 7.3) and euro↔cent", () => {
  test("PAID is paid; PENDING, AUTHORIZED and anything unknown change nothing; ABANDONED, VOIDED, CANCELLED, FAILED fail; the refunds are refunded", () => {
    expect(mapMontonioStatus("PAID")).toBe("paid");
    expect(mapMontonioStatus("paid")).toBe("paid");
    for (const s of ["PENDING", "AUTHORIZED", "", "SOMETHING_NEW", undefined, null, 42]) expect(mapMontonioStatus(s), String(s)).toBe("pending");
    for (const s of ["ABANDONED", "VOIDED", "CANCELLED", "FAILED"]) expect(mapMontonioStatus(s), s).toBe("failed");
    for (const s of ["REFUNDED", "PARTIALLY_REFUNDED"]) expect(mapMontonioStatus(s), s).toBe("refunded");
  });

  test("cents ↔ euros: a number or GET /orders' string; anything else is no amount, a third decimal included (exact in cents, spec 7.4)", () => {
    expect([toCents(175), toCents(175.5), toCents(99.99), toCents(175.01), toCents("100.00"), toCents("0.10"), toCents(0)]).toEqual([17500, 17550, 9999, 17501, 10000, 10, 0]);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "", "1,50", "abc", "1.234", 175.504, 174.999, 0.001, null, undefined, {}]) expect(toCents(bad), String(bad)).toBeNull();
    expect([toEuros(17500), toEuros(17550), toEuros(9999), toEuros(1)]).toEqual([175, 175.5, 99.99, 0.01]);
  });
});

describe("createOrder", () => {
  test("POST /orders { data: <jwt> }: the order of spec 4 (paymentInitiation, no preferredProvider, no paymentReference), signed for 10 minutes", async () => {
    const f = stubFetch(() => Response.json({ uuid: "uuid-1", paymentStatus: "PENDING", merchantReference: "MSLAB-M7", paymentUrl: "https://sandbox-stargate.montonio.com/uuid-1" }));
    expect(await montonioClient(CONFIG).createOrder(ORDER)).toEqual({ uuid: "uuid-1", paymentUrl: "https://sandbox-stargate.montonio.com/uuid-1" });
    expect(f.calls).toHaveLength(1);
    expect([f.calls[0].url, f.calls[0].method]).toEqual([`${SANDBOX_BASE}/orders`, "POST"]);
    const { data } = f.calls[0].body as { data: string };
    const { claims } = verifyHs256(data, CONFIG.secretKey);
    expect(claims).toEqual({
      accessKey: "test-access-key",
      merchantReference: "MSLAB-M7",
      returnUrl: ORDER.returnUrl,
      notificationUrl: ORDER.notificationUrl,
      currency: "EUR",
      grandTotal: 175.5,
      locale: "ru",
      payment: { method: "paymentInitiation", amount: 175.5, currency: "EUR", methodOptions: { paymentDescription: "MS LAB MSLAB-M7" } },
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
  });

  test("Montonio's refusal keeps its own text; no answer is 'unreachable'; a body without uuid or an https paymentUrl is 'bad_response'", async () => {
    const fail = async (respond: () => Response | Promise<Response>, config = CONFIG) => {
      stubFetch(respond);
      try {
        await montonioClient(config).createOrder(ORDER);
      } catch (e) {
        return e instanceof MontonioError ? [e.op, e.code, e.detail] : ["other"];
      }
      return ["none"];
    };
    expect(await fail(() => Response.json({ message: "STORE_NOT_FOUND - double check your access key" }, { status: 401 }))).toEqual(["create", "rejected", "HTTP 401 · STORE_NOT_FOUND - double check your access key"]);
    expect(await fail(() => new Response("Bad gateway", { status: 502 }))).toEqual(["create", "rejected", "HTTP 502 · Bad gateway"]);
    expect(await fail(() => Promise.reject(new TypeError("fetch failed")))).toEqual(["create", "unreachable", ""]);
    expect(await fail(() => new Response("not json"))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json({ paymentUrl: "https://x.example/1" }))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json({ uuid: "u", paymentUrl: "http://x.example/1" }))).toEqual(["create", "bad_response", ""]);
    // the e2e run's fake answers on plain http: only a mock config takes that
    expect(await fail(() => Response.json({ uuid: "u", paymentUrl: "http://localhost:3997/pay/u" }), { ...CONFIG, mock: true, baseUrl: "http://localhost:3997" })).toEqual(["none"]);
  });

  test("an amount that is no positive whole number of cents is a programming error, not an order", async () => {
    stubFetch(() => Response.json({}));
    for (const amountCents of [0, -1, 1.5]) await expect(montonioClient(CONFIG).createOrder({ ...ORDER, amountCents })).rejects.toThrow(RangeError);
  });
});

describe("fetchOrder (GET /orders/:uuid)", () => {
  test("a Bearer token of { accessKey } for an hour; the status, the amount from a string, the reference", async () => {
    const f = stubFetch(() => Response.json({ uuid: "uuid-1", paymentStatus: "PAID", merchantReference: "MSLAB-M7", grandTotal: "175.50", currency: "EUR", paymentMethodType: "paymentInitiation" }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toEqual({ uuid: "uuid-1", reference: "MSLAB-M7", status: "paid", rawStatus: "PAID", amountCents: 17550, currency: "EUR", method: "paymentInitiation" });
    expect([f.calls[0].url, f.calls[0].method]).toEqual([`${SANDBOX_BASE}/orders/uuid-1`, "GET"]);
    const bearer = /^Bearer (.+)$/.exec(f.calls[0].headers.get("authorization") ?? "")![1];
    const { claims } = verifyHs256(bearer, CONFIG.secretKey);
    expect(claims.accessKey).toBe("test-access-key");
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
  });

  test("no answer, a refusal, a body that is no order, or an id that cannot be one: null (never a throw)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    stubFetch(() => Response.json({ message: "Order not found" }, { status: 404 }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    stubFetch(() => new Response("[]"));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    const f = stubFetch(() => Response.json({}));
    expect(await montonioClient(CONFIG).fetchOrder("../stores")).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

describe("verifyOrderToken", () => {
  const token = (claims: Record<string, unknown>, secret = CONFIG.secretKey, nowSec?: number) =>
    signHs256({ uuid: "uuid-1", accessKey: "test-access-key", merchantReference: "MSLAB-M7", paymentStatus: "PAID", paymentMethod: "paymentInitiation", grandTotal: 175.5, currency: "EUR", paymentProviderName: "Swedbank", ...claims }, secret, { expiresInSeconds: 600, nowSec });

  test("what the token says, read; the access key is reported, not judged (settle.ts asks Montonio on a mismatch)", () => {
    const client = montonioClient(CONFIG);
    expect(client.verifyOrderToken(token({}))).toEqual({ uuid: "uuid-1", accessKey: "test-access-key", reference: "MSLAB-M7", status: "paid", rawStatus: "PAID", amountCents: 17550, currency: "EUR", method: "paymentInitiation", bank: "Swedbank", expired: false });
    expect(client.verifyOrderToken(token({ accessKey: "someone-else", paymentStatus: "ABANDONED", grandTotal: "x" }))).toMatchObject({ accessKey: "someone-else", status: "failed", rawStatus: "ABANDONED", amountCents: null });
    expect(client.verifyOrderToken(token({ accessKey: undefined, paymentProviderName: null }))).toMatchObject({ accessKey: null, bank: "" });
    expect(client.accessKey).toBe("test-access-key");
  });

  test("another secret throws (unverifiable); no merchantReference throws; an old token is read, and says expired", () => {
    const client = montonioClient(CONFIG);
    expect(() => client.verifyOrderToken(token({}, "another-secret-0123456789abcdef"))).toThrow(/jwt signature/);
    expect(() => client.verifyOrderToken(token({ merchantReference: "" }))).toThrow(/jwt payload/);
    const old = token({}, CONFIG.secretKey, Math.floor(Date.now() / 1000) - 3600);
    expect(client.verifyOrderToken(old)).toMatchObject({ status: "paid", expired: true });
  });
});
```

- [ ] **Step 7: Run it — expect FAIL**: `npx vitest run tests/unit/montonio.test.ts` (`@/server/payments/montonio` does not exist).

- [ ] **Step 8: Write `src/server/payments/montonio.ts`:**

```ts
import { paymentsEnv, type PaymentsEnv } from "../env";
import { logFailure, logNote } from "../log";
import { JwtError, signHs256, verifyHs256 } from "./jwt";

// Montonio's Stargate API (phase 2b, spec 4 and 7.1–7.3; docs.montonio.com checked 09.10.2026), ported from Rempire's integration:
// - every request is a JWT, HS256 with the store's secret key, with `accessKey`, `iat` and `exp` (10 minutes for a POST, an hour for a GET);
//   a POST body is { "data": "<jwt>" }, a GET carries "Authorization: Bearer <jwt>";
// - POST /orders creates an order: merchantReference (ours, MSLAB-M<id>, a new one for every attempt), returnUrl, notificationUrl, grandTotal
//   and payment.amount in euros (a number with at most two decimals; cents everywhere else in this app), currency EUR, locale et/ru, and
//   payment.method "paymentInitiation" with NO preferredProvider, so Montonio's own page lists every bank and every method the store has on
//   (D4), and methodOptions.paymentDescription "MS LAB <reference>". We never send paymentReference: banks check it strictly and a bad one
//   fails the payment. The window is Montonio's default 30 minutes (domain/sessions.ts SEAT_HOLD_MS holds the seat as long);
// - the webhook (POST notificationUrl { orderToken }) and the return (returnUrl?order-token=…) carry the same signed order token, in any
//   order; GET /orders/:uuid answers what Montonio itself believes (its grandTotal is a string there).
// Without both keys there are no online payments (paymentsConfigured). PAYMENT_PROVIDER=mock points this same client at the e2e run's fake
// Montonio (tests/e2e/fake-montonio.ts) and is refused on Vercel and, without PAYMENT_MOCK_IN_PRODUCTION=1, in a production build: the mock
// is never a fallback. Logs carry no key, no token and no address; Montonio's own error text is kept (it names no person).

export const LIVE_BASE = "https://stargate.montonio.com/api";
export const SANDBOX_BASE = "https://sandbox-stargate.montonio.com/api";
/** Montonio has 15 s to answer, headers and body together. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The lifetime of a POST's token (10 minutes) and of a GET's Bearer token (an hour), as Montonio's reference asks. */
const POST_TOKEN_SEC = 600;
const GET_TOKEN_SEC = 3600;
/** How far past its `exp` an order token is still taken as it is (spec 7.1); an older one is confirmed with GET /orders/:uuid (spec 7.4). */
const CLOCK_TOLERANCE_SEC = 60;

export type MontonioStatus = "paid" | "pending" | "failed" | "refunded";

/**
 * Montonio's paymentStatus in our words (spec 7.3): PAID is paid; PENDING, AUTHORIZED and any status this code has not been taught change
 * nothing; ABANDONED (unpaid after the window), VOIDED (a bank reversal), CANCELLED and FAILED are failed; REFUNDED and PARTIALLY_REFUNDED
 * are refunded. settle.ts keeps paid as a floor.
 */
export function mapMontonioStatus(raw: unknown): MontonioStatus {
  switch (String(raw ?? "").trim().toUpperCase()) {
    case "PAID":
      return "paid";
    case "ABANDONED":
    case "VOIDED":
    case "CANCELLED":
    case "FAILED":
      return "failed";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "refunded";
    default:
      return "pending";
  }
}

/**
 * Euros as Montonio writes them — a number (99.99) or, in GET /orders, a string ("100.00") — in cents; null when it is no amount. Exact: a
 * number with a third decimal (175.504) is no amount either, never rounded into one that would pass the check (spec 7.4: exact in cents).
 */
export function toCents(euros: unknown): number | null {
  const n = typeof euros === "number" ? euros : typeof euros === "string" && /^\d+(\.\d{1,2})?$/.test(euros.trim()) ? Number(euros) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  // 99.99 * 100 is 9998.999…: a float's own error is far below a millionth of a cent; a third decimal is not
  return Math.abs(n * 100 - cents) < 1e-6 ? cents : null;
}

/** Cents as the euros Montonio takes: a number with at most two decimals (17550 → 175.5). */
export const toEuros = (cents: number): number => Math.round(cents) / 100;

export type Runtime = { production: boolean; onVercel: boolean };

/** This process: a production build (`next start`, Vercel) or not, and on Vercel or not (VERCEL is set there, build and run time). */
export const currentRuntime = (): Runtime => ({ production: process.env.NODE_ENV === "production", onVercel: Boolean(process.env.VERCEL) });

export type MontonioConfig = { accessKey: string; secretKey: string; baseUrl: string; live: boolean; mock: boolean };

/** "payments are off" is noted once per instance, not on every request. */
let notedOff = false;
function off(why: string): null {
  if (!notedOff) {
    notedOff = true;
    logNote(`[payments] ${why}: online payments are off`);
  }
  return null;
}

/**
 * The store and the address, or null: no online payments. Both keys are needed (a blank one counts as not set: paymentsEnv). MONTONIO_ENV
 * "live" (exactly) is production, anything else the sandbox. PAYMENT_PROVIDER unset or "montonio" is Montonio; "mock" is the fake at
 * MONTONIO_FAKE_URL, refused on Vercel and in a production build without PAYMENT_MOCK_IN_PRODUCTION=1; any other value turns payments off.
 */
export function montonioConfig(env: PaymentsEnv = paymentsEnv(), runtime: Runtime = currentRuntime()): MontonioConfig | null {
  const accessKey = env.MONTONIO_ACCESS_KEY;
  const secretKey = env.MONTONIO_SECRET_KEY;
  if (!accessKey || !secretKey) return null;
  const provider = env.PAYMENT_PROVIDER;
  if (provider === undefined || provider === "montonio") {
    const live = env.MONTONIO_ENV === "live";
    return { accessKey, secretKey, baseUrl: live ? LIVE_BASE : SANDBOX_BASE, live, mock: false };
  }
  if (provider !== "mock") return off("PAYMENT_PROVIDER is neither montonio nor mock");
  if (runtime.onVercel) return off("PAYMENT_PROVIDER=mock is refused on Vercel");
  if (runtime.production && env.PAYMENT_MOCK_IN_PRODUCTION !== "1") return off("PAYMENT_PROVIDER=mock is refused in a production build without PAYMENT_MOCK_IN_PRODUCTION=1");
  if (!env.MONTONIO_FAKE_URL) return off("PAYMENT_PROVIDER=mock needs MONTONIO_FAKE_URL");
  return { accessKey, secretKey, baseUrl: env.MONTONIO_FAKE_URL.replace(/\/+$/, ""), live: false, mock: true };
}

/** Are online payments on (spec 7.2)? Without them the "Maksa" buttons are hidden, the cart keeps its interest form and /api/payments/* are 404. */
export const paymentsConfigured = (env?: PaymentsEnv, runtime?: Runtime): boolean => montonioConfig(env, runtime) !== null;

/** Montonio said no (`rejected`, with its own text in `detail`), could not be reached, or answered something that is no order. */
export class MontonioError extends Error {
  constructor(
    readonly op: "create" | "fetch",
    readonly code: "unreachable" | "rejected" | "bad_response",
    readonly detail = "",
  ) {
    super(`Montonio ${op} ${code}`);
    this.name = "MontonioError";
  }
}

/**
 * What Montonio said when it refused: the HTTP status and its own message, one short line ("HTTP 401 · STORE_NOT_FOUND - double check your
 * access key"). Its error bodies are not of one shape, so the usual keys are tried and the raw text is the fallback (Rempire's lesson: a bare
 * code hid the reason for weeks).
 */
export function montonioErrorText(status: number, body: string): string {
  const raw = String(body ?? "").trim();
  let message = "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ["message", "error", "detail", "description"]) {
        const v = parsed[key];
        if (typeof v === "string" && v.trim()) {
          message = v.trim();
          break;
        }
        if (Array.isArray(v) && typeof v[0] === "string") {
          message = v.join("; ");
          break;
        }
      }
    } catch {
      // not JSON after all: the raw text below is all there is
    }
  }
  if (!message) message = raw;
  return `HTTP ${status}${message ? ` · ${message.slice(0, 300)}` : ""}`;
}

export type OrderRequest = { reference: string; amountCents: number; locale: "et" | "ru"; returnUrl: string; notificationUrl: string };

/** An order token's facts (the webhook's `orderToken`, the return's `order-token`). `accessKey` null: the token carries none. */
export type OrderToken = {
  uuid: string;
  accessKey: string | null;
  reference: string;
  status: MontonioStatus;
  rawStatus: string;
  amountCents: number | null;
  currency: string | null;
  method: string;
  bank: string;
  /** Past its exp by more than the tolerance (a late webhook retry): settle.ts confirms it with GET /orders/:uuid. */
  expired: boolean;
};

/** What GET /orders/:uuid says about an order. */
export type OrderSnapshot = { uuid: string; reference: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string };

export type Montonio = {
  /** The store's access key: an order token must name it (settle.ts). */
  readonly accessKey: string;
  /** POST /orders: the order's Montonio uuid and the page to send the payer to. Throws a MontonioError. */
  createOrder(order: OrderRequest): Promise<{ uuid: string; paymentUrl: string }>;
  /** GET /orders/:uuid, or null on anything at all (no answer, a refusal, no order): never a throw. */
  fetchOrder(uuid: string): Promise<OrderSnapshot | null>;
  /** The facts of an order token. Throws a JwtError when it cannot be trusted (the webhook's 400). */
  verifyOrderToken(token: string): OrderToken;
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const UUID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * The client of one store. `fetchImpl` is the platform's fetch, looked up at each call (tests stub it); `clock` is the time the tokens are
 * signed and checked against (ms). Every call carries a 15 s signal and refuses redirects: an API call that redirects is not Montonio's.
 */
export function montonioClient(config: MontonioConfig, fetchImpl: typeof fetch = (input, init) => fetch(input, init), clock: () => number = () => Date.now()): Montonio {
  const nowSec = () => Math.floor(clock() / 1000);

  async function call(op: "create" | "fetch", url: string, init: RequestInit): Promise<{ status: number; body: string }> {
    try {
      const res = await fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { status: res.status, body: await res.text() };
    } catch {
      throw new MontonioError(op, "unreachable");
    }
  }

  return {
    accessKey: config.accessKey,

    async createOrder(order) {
      if (!Number.isInteger(order.amountCents) || order.amountCents <= 0) throw new RangeError("amountCents must be a positive whole number");
      const amount = toEuros(order.amountCents);
      const data = signHs256(
        {
          accessKey: config.accessKey,
          merchantReference: order.reference,
          returnUrl: order.returnUrl,
          notificationUrl: order.notificationUrl,
          currency: "EUR",
          grandTotal: amount,
          locale: order.locale,
          payment: { method: "paymentInitiation", amount, currency: "EUR", methodOptions: { paymentDescription: `MS LAB ${order.reference}` } },
        },
        config.secretKey,
        { expiresInSeconds: POST_TOKEN_SEC, nowSec: nowSec() },
      );
      const res = await call("create", `${config.baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ data }),
      });
      if (res.status < 200 || res.status >= 300) throw new MontonioError("create", "rejected", montonioErrorText(res.status, res.body));
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(res.body);
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        throw new MontonioError("create", "bad_response");
      }
      const uuid = text(body.uuid);
      const paymentUrl = text(body.paymentUrl);
      // the payer is sent there: https only (the e2e run's fake answers on plain http on this machine)
      const fine = paymentUrl.startsWith("https://") || (config.mock && paymentUrl.startsWith("http://"));
      if (!uuid || !fine) throw new MontonioError("create", "bad_response");
      return { uuid, paymentUrl };
    },

    async fetchOrder(uuid) {
      const id = uuid.trim();
      if (!UUID.test(id)) return null;
      const bearer = signHs256({ accessKey: config.accessKey }, config.secretKey, { expiresInSeconds: GET_TOKEN_SEC, nowSec: nowSec() });
      let res: { status: number; body: string };
      try {
        res = await call("fetch", `${config.baseUrl}/orders/${encodeURIComponent(id)}`, { headers: { accept: "application/json", authorization: `Bearer ${bearer}` } });
      } catch (e) {
        logFailure("[payments] GET /orders: no answer", e);
        return null;
      }
      if (res.status !== 200) {
        logNote(`[payments] GET /orders: ${montonioErrorText(res.status, res.body)}`);
        return null;
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(res.body);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        body = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
      const raw = text(body.paymentStatus).toUpperCase();
      return { uuid: text(body.uuid) || id, reference: text(body.merchantReference), status: mapMontonioStatus(raw), rawStatus: raw, amountCents: toCents(body.grandTotal), currency: text(body.currency) || null, method: text(body.paymentMethodType) };
    },

    verifyOrderToken(token) {
      const { claims, expired } = verifyHs256<Record<string, unknown>>(token, config.secretKey, { toleranceSec: CLOCK_TOLERANCE_SEC, nowSec: nowSec() });
      const reference = text(claims.merchantReference);
      if (!reference) throw new JwtError("payload");
      const raw = text(claims.paymentStatus).toUpperCase();
      return {
        uuid: text(claims.uuid),
        accessKey: text(claims.accessKey) || null,
        reference,
        status: mapMontonioStatus(raw),
        rawStatus: raw,
        amountCents: toCents(claims.grandTotal),
        currency: text(claims.currency) || null,
        method: text(claims.paymentMethod),
        bank: text(claims.paymentProviderName),
        expired,
      };
    },
  };
}

/** The app's Montonio (the settings of this process), or null: no online payments. */
export function paymentProvider(env: PaymentsEnv = paymentsEnv(), runtime: Runtime = currentRuntime()): Montonio | null {
  const config = montonioConfig(env, runtime);
  return config ? montonioClient(config) : null;
}
```

- [ ] **Step 9: Run** `npx vitest run tests/unit/montonio.test.ts tests/unit/env.test.ts` — expect PASS.

- [ ] **Step 10: The documentation's own payloads** — `tests/unit/montonio-docs-payloads.test.ts` (it passes at once: it pins the parsing against what Montonio's pages print, not against what the code produces):

```ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { signHs256 } from "@/server/payments/jwt";
import { LIVE_BASE, montonioClient, type MontonioConfig } from "@/server/payments/montonio";
import { stubFetch } from "../fakes";

// The payloads below are copied from Montonio's own pages (read 09.10.2026), never derived from what this code produces: Rempire's shipping
// webhook was broken for months because its fixture was built flat to match the code while the real payload nested everything (its
// docs/montonio-shipping-audit.md § 1.1). Sources: docs.montonio.com/api/stargate/guides/orders (the decoded order token, the POST /orders
// answer, the webhook body) and the API reference "Get Order by UUID".

const config: MontonioConfig = { accessKey: "MY_ACCESS_KEY", secretKey: "docs-test-secret-0123456789abcdef", baseUrl: LIVE_BASE, live: true, mock: false };

/** Orders guide, "Validating the returned order token": the decoded payload, its deprecated snake_case twins included. */
const ORDER_TOKEN_PAYLOAD = {
  uuid: "the-montonio-order-uuid",
  accessKey: "MY_ACCESS_KEY",
  merchantReference: "MY-ORDER-ID-123",
  merchantReferenceDisplay: "MY-ORDER-ID-123",
  paymentStatus: "PAID",
  paymentMethod: "paymentInitiation",
  grandTotal: 99.99,
  currency: "EUR",
  senderIban: "EE471000001020145685",
  senderName: "John Doe",
  paymentProviderName: "New Wave Bank Group",
  merchant_reference: "MY-ORDER-ID-123",
  merchant_reference_display: "MY-ORDER-ID-123",
  payment_status: "PAID",
  iat: 1632967333,
  exp: 1632967333,
};

/** Orders guide, the answer of POST /orders (its first fields). */
const ORDER_CREATED = {
  uuid: "12228dce-2f7c-4db5-8d28-5d82a19aa3b6",
  paymentStatus: "PENDING",
  merchantReference: "MY-ORDER-ID-123",
  paymentUrl: "https://stargate.montonio.com/e694c95b-0335-493d-a713-af95720f885d",
};

/** API reference, "Get Order by UUID": money as strings. */
const ORDER_BODY = {
  uuid: "0ac2124d-9f8e-4a29-816d-7eef5b9bb0fd",
  paymentStatus: "PARTIALLY_REFUNDED",
  locale: "et",
  merchantReference: "MY-ORDER-ID-123",
  merchantReferenceDisplay: "MY-ORDER-ID-123",
  merchantReturnUrl: "https://mystore.com/payment/return",
  merchantNotificationUrl: "https://mystore.com/payment/notify",
  grandTotal: "100.00",
  currency: "EUR",
  paymentMethodType: "cardPayments",
  paymentIntents: [
    { uuid: "293513c0-66b1-401a-8afa-75e1f5714516", paymentMethodType: "cardPayments", paymentMethodMetadata: {}, amount: "100.00", currency: "EUR", status: "PAID", serviceFee: "3.15", serviceFeeCurrency: "EUR", createdAt: "2023-05-23T08:22:53.899Z" },
  ],
  refunds: [{ uuid: "92b11684-319a-4cce-92f5-56d348aa986a", amount: "25", status: "SUCCESSFUL", currency: "EUR", createdAt: "2023-05-23T08:37:55.534Z", type: "PARTIAL_REFUND" }],
  availableForRefund: 50,
  isRefundableType: false,
  lineItems: [{ name: "Hoverboard", quantity: 1, finalPrice: 100 }],
  expiresAt: null,
  createdAt: "2023-05-23T08:22:53.879Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Montonio's documented payloads", () => {
  test("the decoded order token: the reference, PAID, 99.99 € as 9999 cents, the method and the bank; expired only past exp + 60 s", () => {
    const token = signHs256(ORDER_TOKEN_PAYLOAD, config.secretKey, { nowSec: ORDER_TOKEN_PAYLOAD.iat });
    const atIssue = montonioClient(config, undefined, () => ORDER_TOKEN_PAYLOAD.iat * 1000);
    expect(atIssue.verifyOrderToken(token)).toEqual({
      uuid: "the-montonio-order-uuid",
      accessKey: "MY_ACCESS_KEY",
      reference: "MY-ORDER-ID-123",
      status: "paid",
      rawStatus: "PAID",
      amountCents: 9999,
      currency: "EUR",
      method: "paymentInitiation",
      bank: "New Wave Bank Group",
      expired: false,
    });
    const late = montonioClient(config, undefined, () => (ORDER_TOKEN_PAYLOAD.exp + 61) * 1000);
    expect(late.verifyOrderToken(token).expired).toBe(true);
  });

  test("the POST /orders answer: its uuid and paymentUrl", async () => {
    stubFetch(() => Response.json(ORDER_CREATED));
    const order = { reference: "MY-ORDER-ID-123", amountCents: 9999, locale: "et" as const, returnUrl: "https://mystore.com/payment/return", notificationUrl: "https://mystore.com/payment/notify" };
    expect(await montonioClient(config).createOrder(order)).toEqual({ uuid: ORDER_CREATED.uuid, paymentUrl: ORDER_CREATED.paymentUrl });
  });

  test("GET /orders/:uuid: PARTIALLY_REFUNDED is refunded, '100.00' is 10000 cents, the method is its paymentMethodType", async () => {
    stubFetch(() => Response.json(ORDER_BODY));
    expect(await montonioClient(config).fetchOrder(ORDER_BODY.uuid)).toEqual({
      uuid: ORDER_BODY.uuid,
      reference: "MY-ORDER-ID-123",
      status: "refunded",
      rawStatus: "PARTIALLY_REFUNDED",
      amountCents: 10000,
      currency: "EUR",
      method: "cardPayments",
    });
  });
});
```

- [ ] **Step 11: The e2e run's Montonio.**
  1. Create `tests/e2e/montonio-values.ts`:

```ts
/**
 * The port of the e2e run's fake Montonio: 3997, or E2E_MONTONIO_PORT when that one is taken on this machine (a whole number from 1024 to
 * 65535). Playwright, the app's server and the fake itself all read it from here, so they always agree.
 */
function fakePort(value: string | undefined): number {
  if (!value?.trim()) return 3997;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("e2e: E2E_MONTONIO_PORT must be a port number from 1024 to 65535");
  return port;
}

const port = fakePort(process.env.E2E_MONTONIO_PORT);

/** The e2e run's Montonio: a fake on this machine (fake-montonio.ts) with made-up keys; the app's server is started with these. Not secrets. */
export const E2E_MONTONIO = {
  port,
  url: `http://localhost:${port}`,
  accessKey: "e2e-montonio-access-key",
  secretKey: "e2e-montonio-secret-key-not-a-real-one-0123456789",
} as const;
```

  2. Create `tests/e2e/fake-montonio.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { signHs256, verifyHs256 } from "../../src/server/payments/jwt";
import { E2E_MONTONIO } from "./montonio-values";

// A stand-in for Montonio's Stargate API in the e2e run (phase 2b): the app's server gets PAYMENT_PROVIDER=mock and MONTONIO_FAKE_URL = this
// address (tests/local-secrets.ts, server/payments/montonio.ts), and the app's own client talks to it as it would to Montonio. It checks what
// Montonio checks, and spec 4's rules the app must keep:
// - POST /orders { data: <jwt> }: the HS256 signature with the store's secret and its accessKey (else 401 STORE_NOT_FOUND, as Montonio);
//   merchantReference, returnUrl, notificationUrl, currency EUR, grandTotal > 0 with at most two decimals, locale et/ru, and payment
//   { method "paymentInitiation", amount = grandTotal, currency EUR, methodOptions.paymentDescription } with no preferredProvider and no
//   paymentReference (else 400). A reference reused for an unpaid order replaces it; for a paid one it is a 400, as at Montonio. Answers
//   { uuid, paymentStatus: "PENDING", merchantReference, paymentUrl } (the paymentUrl on this server's own address).
// - GET /orders/<uuid> with "Authorization: Bearer <jwt>" ({ accessKey }): the order as Montonio's reference prints it, grandTotal a string.
// - The bank: GET /pay/<uuid> is a page with three buttons, "Makstud" (PAID), "Pooleli" (PENDING) and "Katkesta" (ABANDONED). The form posts
//   back here: a status other than PENDING is sent to the app's notificationUrl as Montonio's webhook ({ orderToken }, signed for 10 minutes)
//   and awaited, then the browser gets a 303 to returnUrl?order-token=<the same token>.
// - For the tests: GET /_fake/orders/<reference> (the order, or 404); POST /_fake/settle/<uuid> { status } (the bank decides later: the
//   status and the webhook, without the browser); GET /health.
// Run: npx tsx tests/e2e/fake-montonio.ts (Playwright starts it: tests/e2e/server.ts), on E2E_MONTONIO.port. The keys are E2E_MONTONIO's.

type Order = { uuid: string; reference: string; grandTotal: number; currency: string; locale: string; returnUrl: string; notificationUrl: string; status: string };
type Keys = { accessKey: string; secretKey: string };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const html = typeof body === "string";
  res.writeHead(status, { "cache-control": "no-store", "content-type": html ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(html ? body : JSON.stringify(body));
}

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The bank's page: the order and its three outcomes (44 px buttons, so the e2e run's phone project can press them). */
const bankPage = (o: Order) =>
  [
    '<!doctype html><html lang="et"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Testpank</title></head>',
    '<body style="margin:24px;font:16px/1.5 system-ui,sans-serif">',
    `<h1>Testpank</h1><p data-fake-order="${esc(o.reference)}">${esc(o.reference)} · ${o.grandTotal.toFixed(2)} ${esc(o.currency)}</p>`,
    `<form method="post" action="/pay/${o.uuid}">`,
    ...[["PAID", "Makstud"], ["PENDING", "Pooleli"], ["ABANDONED", "Katkesta"]].map(([value, label]) => `<button name="status" value="${value}" style="min-height:44px;margin:4px">${label}</button>`),
    "</form></body></html>",
  ].join("");

/** The order token Montonio signs: the decoded payload of its orders guide, with this order's values. */
const orderToken = (o: Order, keys: Keys) =>
  signHs256(
    {
      uuid: o.uuid,
      accessKey: keys.accessKey,
      merchantReference: o.reference,
      merchantReferenceDisplay: o.reference,
      paymentStatus: o.status,
      paymentMethod: "paymentInitiation",
      grandTotal: o.grandTotal,
      currency: o.currency,
      senderIban: null,
      senderName: null,
      paymentProviderName: "Testpank",
    },
    keys.secretKey,
    { expiresInSeconds: 600 },
  );

/** Montonio's webhook: POST { orderToken } to the order's notificationUrl, awaited; a failure is only noted (Montonio would retry). */
async function notify(o: Order, keys: Keys): Promise<void> {
  try {
    await fetch(o.notificationUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderToken: orderToken(o, keys) }), redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    console.error("[fake-montonio] the webhook did not reach the app");
  }
}

/** What is wrong with an order request (Montonio's own checks and spec 4's rules); null when nothing is. */
function orderProblem(c: Record<string, unknown>): string | null {
  const payment = (c.payment ?? {}) as Record<string, unknown>;
  const options = (payment.methodOptions ?? {}) as Record<string, unknown>;
  const euros = (n: unknown) => typeof n === "number" && n > 0 && Math.round(n * 100) / 100 === n;
  if (typeof c.merchantReference !== "string" || !c.merchantReference) return "merchantReference";
  if (typeof c.returnUrl !== "string" || typeof c.notificationUrl !== "string") return "returnUrl/notificationUrl";
  if (c.currency !== "EUR" || payment.currency !== "EUR") return "currency";
  if (!euros(c.grandTotal) || payment.amount !== c.grandTotal) return "grandTotal/amount";
  if (c.locale !== "et" && c.locale !== "ru") return "locale";
  if (payment.method !== "paymentInitiation") return "payment.method";
  if (typeof options.paymentDescription !== "string" || !options.paymentDescription) return "paymentDescription";
  if ("preferredProvider" in options || "paymentReference" in options || "paymentReference" in c) return "preferredProvider/paymentReference";
  return null;
}

/** The fake on `keys` (E2E_MONTONIO's by default): a server to listen on any port. */
export function createFakeMontonio(keys: Keys = { accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey }): Server {
  const orders = new Map<string, Order>();
  const byReference = (reference: string) => [...orders.values()].find((o) => o.reference === reference);
  const trusted = (token: string): Record<string, unknown> | null => {
    try {
      const { claims, expired } = verifyHs256(token, keys.secretKey);
      return !expired && claims.accessKey === keys.accessKey ? claims : null;
    } catch {
      return null;
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    if (path === "/health") return send(res, 200, { ok: true });

    if (path === "/orders" && req.method === "POST") {
      let data = "";
      try {
        data = String((JSON.parse(await read(req)) as { data?: unknown }).data ?? "");
      } catch {
        // not JSON: no token
      }
      const c = trusted(data);
      if (!c) return send(res, 401, { message: "STORE_NOT_FOUND - double check your access key" });
      const problem = orderProblem(c);
      if (problem) return send(res, 400, { message: `Invalid order: ${problem}` });
      const reference = c.merchantReference as string;
      const old = byReference(reference);
      if (old?.status === "PAID") return send(res, 400, { message: `The order ${reference} is already paid` });
      if (old) orders.delete(old.uuid);
      const o: Order = { uuid: randomUUID(), reference, grandTotal: c.grandTotal as number, currency: "EUR", locale: c.locale as string, returnUrl: c.returnUrl as string, notificationUrl: c.notificationUrl as string, status: "PENDING" };
      orders.set(o.uuid, o);
      return send(res, 200, { uuid: o.uuid, paymentStatus: "PENDING", merchantReference: reference, paymentUrl: `http://${req.headers.host}/pay/${o.uuid}` });
    }

    const get = /^\/orders\/([^/]+)$/.exec(path);
    if (get && req.method === "GET") {
      if (!trusted(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "")) return send(res, 401, { message: "INVALID_TOKEN - double check your secret key" });
      const o = orders.get(get[1]);
      if (!o) return send(res, 404, { message: "Order not found" });
      return send(res, 200, { uuid: o.uuid, paymentStatus: o.status, locale: o.locale, merchantReference: o.reference, merchantReferenceDisplay: o.reference, grandTotal: o.grandTotal.toFixed(2), currency: o.currency, paymentMethodType: "paymentInitiation" });
    }

    const pay = /^\/pay\/([^/]+)$/.exec(path);
    const order = pay ? orders.get(pay[1]) : undefined;
    if (pay && !order) return send(res, 404, "<!doctype html><title>Testpank</title><p>Tellimust ei leitud.</p>");
    if (order && req.method === "GET") return send(res, 200, bankPage(order));
    if (order && req.method === "POST") {
      const status = new URLSearchParams(await read(req)).get("status");
      if (status !== "PAID" && status !== "PENDING" && status !== "ABANDONED") return send(res, 400, "status");
      order.status = status;
      if (status !== "PENDING") await notify(order, keys);
      const back = new URL(order.returnUrl);
      back.searchParams.set("order-token", orderToken(order, keys));
      return send(res, 303, "", { location: back.toString() });
    }

    const find = /^\/_fake\/orders\/([^/]+)$/.exec(path);
    if (find && req.method === "GET") {
      const o = byReference(decodeURIComponent(find[1]));
      return o ? send(res, 200, o) : send(res, 404, { message: "no order" });
    }
    const later = /^\/_fake\/settle\/([^/]+)$/.exec(path);
    if (later && req.method === "POST") {
      const o = orders.get(later[1]);
      let status: unknown;
      try {
        status = (JSON.parse(await read(req)) as { status?: unknown }).status;
      } catch {
        status = undefined;
      }
      if (!o || typeof status !== "string") return send(res, 404, { message: "no order" });
      o.status = status;
      await notify(o, keys);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { message: "not found" });
  }

  return createServer((req, res) => void handle(req, res).catch(() => send(res, 500, { message: "fake error" })));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/e2e/fake-montonio.ts")) createFakeMontonio().listen(E2E_MONTONIO.port);
```

  3. **`tests/e2e/server.ts`.** Import `E2E_MONTONIO` from `./montonio-values`. In `e2eWebServer`, after the `bunny` entry, add `const montonio = { command: "npx tsx tests/e2e/fake-montonio.ts", url: \`${E2E_MONTONIO.url}/health\`, reuseExistingServer: !process.env.CI, timeout: 30_000 };` and add `montonio` after `bunny` in both returned arrays. In the doc comment, after the sentence about the fake Bunny, add: "Both local modes also start the fake Montonio (fake-montonio.ts) on E2E_MONTONIO.port (3997, or E2E_MONTONIO_PORT), which the local settings point the payments at (PAYMENT_PROVIDER=mock)."
  4. **`tests/local-secrets.ts`.** Import `E2E_MONTONIO` from `./e2e/montonio-values`. In `LOCAL_ENV`, after `BUNNY_FAKE_URL`, add:

```ts
  MONTONIO_ENV: "sandbox",
  MONTONIO_ACCESS_KEY: E2E_MONTONIO.accessKey,
  MONTONIO_SECRET_KEY: E2E_MONTONIO.secretKey,
  PAYMENT_PROVIDER: "mock",
  MONTONIO_FAKE_URL: E2E_MONTONIO.url,
```

     and to `LOCAL_ENV`'s doc comment add: "The payments go to the fake Montonio on this machine (tests/e2e/fake-montonio.ts, PAYMENT_PROVIDER=mock) with made-up keys: these win over the sandbox keys of your own .env.local, so a run never reaches the real sandbox."
  5. **`tests/e2e/prod-build.ts`.** In `PROD_ENV`, after `ADMIN_KEY`, add `PAYMENT_MOCK_IN_PRODUCTION: "1",` and to its doc comment: "and the fake Montonio, which a production build takes only with this explicit flag (server/payments/montonio.ts)".
  6. **`tests/unit/e2e-local-secrets.test.ts`.** Import `E2E_MONTONIO` from `../e2e/montonio-values`, `PROD_ENV` from `../e2e/prod-build`, `paymentsEnv` from `@/server/env` and `montonioConfig` from `@/server/payments/montonio`; in the describe "the dev server's environment (LOCAL_ENV)" append:

```ts
  test("the payments go to the fake Montonio on this machine, never the sandbox; the production build needs its explicit flag (phase 2b)", () => {
    expect(montonioConfig(paymentsEnv(LOCAL_ENV), { production: false, onVercel: false })).toEqual({
      accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: E2E_MONTONIO.url, live: false, mock: true,
    });
    expect(montonioConfig(paymentsEnv(LOCAL_ENV), { production: true, onVercel: false })).toBeNull();
    expect(montonioConfig(paymentsEnv({ ...LOCAL_ENV, ...PROD_ENV }), { production: true, onVercel: false })).toMatchObject({ mock: true, baseUrl: E2E_MONTONIO.url });
    if (!process.env.E2E_MONTONIO_PORT) expect(LOCAL_ENV.MONTONIO_FAKE_URL).toBe("http://localhost:3997");
  });
```

- [ ] **Step 12: The fake against the real client** — `tests/unit/montonio-fake.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { signHs256 } from "@/server/payments/jwt";
import { montonioClient, type MontonioConfig } from "@/server/payments/montonio";
import { createFakeMontonio } from "../e2e/fake-montonio";
import { E2E_MONTONIO } from "../e2e/montonio-values";

// The e2e run's fake Montonio (tests/e2e/fake-montonio.ts) answers the app's real client: an order, the bank's "Makstud", the webhook it
// sends, the return's token and GET /orders all read back as Montonio's would. And it refuses what Montonio refuses, and what spec 4 forbids.

const servers: Server[] = [];
const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

test("an order, the bank's 'Makstud': the webhook and the return carry the same PAID token; GET /orders says PAID", async () => {
  const base = await listen(createFakeMontonio());
  const hooks: string[] = [];
  const hook = await listen(createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hooks.push(body);
      res.end("{}");
    });
  }));
  const config: MontonioConfig = { accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true };
  const client = montonioClient(config);
  const order = await client.createOrder({ reference: "MSLAB-M9", amountCents: 17550, locale: "et", returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify` });
  expect(order.paymentUrl).toBe(`${base}/pay/${order.uuid}`);
  expect(await (await fetch(order.paymentUrl)).text()).toContain("MSLAB-M9 · 175.50 EUR");

  const paid = await fetch(order.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "PAID" }), redirect: "manual" });
  expect(paid.status).toBe(303);
  const back = new URL(paid.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe("https://mslab.example/api/payments/return");
  const fromReturn = client.verifyOrderToken(back.searchParams.get("order-token")!);
  expect(fromReturn).toMatchObject({ uuid: order.uuid, reference: "MSLAB-M9", status: "paid", amountCents: 17550, currency: "EUR", bank: "Testpank", expired: false });
  expect(hooks).toHaveLength(1);
  expect(client.verifyOrderToken((JSON.parse(hooks[0]) as { orderToken: string }).orderToken)).toEqual(fromReturn);
  expect(await client.fetchOrder(order.uuid)).toEqual({ uuid: order.uuid, reference: "MSLAB-M9", status: "paid", rawStatus: "PAID", amountCents: 17550, currency: "EUR", method: "paymentInitiation" });
  // a paid reference cannot be ordered again
  await expect(client.createOrder({ reference: "MSLAB-M9", amountCents: 17550, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: `${hook}/n` })).rejects.toThrow(/rejected/);
});

test("'Pooleli' sends no webhook; the test hook settles it later and sends one; 'Katkesta' is ABANDONED", async () => {
  const base = await listen(createFakeMontonio());
  const hooks: string[] = [];
  const hook = await listen(createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hooks.push(body);
      res.end("{}");
    });
  }));
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true });
  const urls = { returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify` };
  const a = await client.createOrder({ reference: "MSLAB-M10", amountCents: 1000, locale: "ru", ...urls });
  const pending = await fetch(a.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "PENDING" }), redirect: "manual" });
  expect(client.verifyOrderToken(new URL(pending.headers.get("location")!).searchParams.get("order-token")!).status).toBe("pending");
  expect(hooks).toHaveLength(0);
  expect((await (await fetch(`${base}/_fake/orders/MSLAB-M10`)).json()).uuid).toBe(a.uuid);
  expect((await fetch(`${base}/_fake/settle/${a.uuid}`, { method: "POST", body: JSON.stringify({ status: "PAID" }) })).status).toBe(200);
  expect(hooks).toHaveLength(1);
  const b = await client.createOrder({ reference: "MSLAB-M11", amountCents: 1000, locale: "et", ...urls });
  const cancelled = await fetch(b.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "ABANDONED" }), redirect: "manual" });
  expect(client.verifyOrderToken(new URL(cancelled.headers.get("location")!).searchParams.get("order-token")!)).toMatchObject({ status: "failed", rawStatus: "ABANDONED" });
});

test("it refuses what Montonio refuses (another store's key) and what spec 4 forbids (preferredProvider, paymentReference, another method)", async () => {
  const base = await listen(createFakeMontonio());
  const post = (claims: Record<string, unknown>, secret: string = E2E_MONTONIO.secretKey) =>
    fetch(`${base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: signHs256(claims, secret, { expiresInSeconds: 600 }) }) });
  const good = {
    accessKey: E2E_MONTONIO.accessKey, merchantReference: "MSLAB-M12", returnUrl: "https://mslab.example/r", notificationUrl: "https://mslab.example/n", currency: "EUR", grandTotal: 10, locale: "et",
    payment: { method: "paymentInitiation", amount: 10, currency: "EUR", methodOptions: { paymentDescription: "MS LAB MSLAB-M12" } },
  };
  expect((await post(good)).status).toBe(200);
  expect((await post(good, "another-secret-0123456789abcdef")).status).toBe(401);
  expect((await post({ ...good, accessKey: "someone-else" })).status).toBe(401);
  expect((await post({ ...good, payment: { ...good.payment, methodOptions: { paymentDescription: "x", preferredProvider: "HABAEE2X" } } })).status).toBe(400);
  expect((await post({ ...good, payment: { ...good.payment, methodOptions: { paymentDescription: "x", paymentReference: "123" } } })).status).toBe(400);
  expect((await post({ ...good, payment: { ...good.payment, method: "cardPayments" } })).status).toBe(400);
  expect((await post({ ...good, grandTotal: 10.001, payment: { ...good.payment, amount: 10.001 } })).status).toBe(400);
});
```

- [ ] **Step 13: Run everything.**
  - `npx vitest run` — all green (the four new files included).
  - `npx tsc --noEmit`, then `npx eslint .`.
  - The e2e servers start with the fake: `npx playwright test home` (dev) passes, and `curl -s http://localhost:3997/health` answers `{"ok":true}` while it runs.

- [ ] **Step 14: Commit.**

```bash
git add app/src/server/env.ts app/.env.example app/src/server/payments app/tests/e2e/montonio-values.ts app/tests/e2e/fake-montonio.ts app/tests/e2e/server.ts app/tests/local-secrets.ts app/tests/e2e/prod-build.ts app/tests/unit
git commit -m "feat(payments): Montonio client — HS256, orders, the order token, the status map; the e2e run's fake Montonio (test-only mock)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `settlePayment`, the one door — the webhook, the payer's mail and Maria's notice

Spec sections 6.2 (registrations; the e-course's part is Task 7), 6.2.4–6.2.6, 7.3, 7.4, 9 (the payment texts), 10 (the webhook through the gate). The paid mails and Maria's notice fold in here (the breakdown's item 8): they are the once-only work of the door, and testing the door without them would test half of it.

**The door.** `settleToken` (the webhook and, in Task 6, the return) and the daily check (Task 8) all end in `settlePayment(deps, row, facts)`:
- **PAID** with the exact amount in EUR → one conditional UPDATE `pending|failed → paid` (with `paid_at is null`, so a voided row never comes back). Only its winner adds the amount to the registration (`addRegistrationPayment`, under the row's lock, in the same transaction), revalidates `seats`, and queues the mails. A second webhook, the return or the daily check finds it paid and does nothing.
- **PAID with another amount or currency** → `held`, nothing confirmed, Maria alerted ("Kontrolli Montonios").
- **failed** on a pending row → `failed`, and a prepayment's hold ends (unless another payment of the registration is still pending): the seat is free again at once. On a paid row: nothing, except **VOIDED** → `failed` (paid_at kept) and an alert; the confirmation stays.
- **refunded** → `refunded` and an alert; `paidCents`, the status and access stay.
- **pending** → nothing.

**A token in doubt** (another `accessKey` or none, a `uuid` that is not the row's, or expired beyond the tolerance) is confirmed with `GET /orders/:uuid` about **the order the token names** (the row's own order when the token names none), and Montonio's answer is used (Rempire's `token-guard`, without its journal); no answer → `unconfirmed` → the webhook answers 503 and Montonio retries. **An order the row has since replaced** (Task 4: a retry while the attempt is open re-sends the same `merchantReference`, and Montonio may answer a new uuid, which the row then carries) moves the row only with money: its PAID settles it (the amount checked, and the row then carries that order's uuid, the one Maria finds in Montonio), its ABANDONED or any other failure changes nothing (the row follows its newer order; its hold stays). This is the pre-flight's double-payment fix, read against spec 7.4: "accept tokens for either uuid", confirmed with Montonio.

**Releasing a hold on a failure** (resolved here, not in the spec's words): D2's hold is "30 minutes from Registreeru, then freed". A payment that has definitely failed (ABANDONED, or an order Montonio refused) frees it at once: the seat is not held for a payment that cannot come any more.

**Files:**
- Create: `app/src/domain/payments.ts`, `app/src/db/queries/payments.ts`, `app/src/server/payments/settle.ts`, `app/src/server/payments/routes.ts`, `app/src/app/api/payments/notify/route.ts`
- Modify: `app/src/db/queries/admin.ts` (`addRegistrationPayment`), `app/src/server/messages.ts`, `app/src/server/account-mail.ts`, `app/src/i18n/dict/et.ts`, `app/src/i18n/dict/ru.ts`, `app/src/lib/site-gate.ts`, `app/src/middleware.ts` (its note), `app/playwright.gate.config.ts`
- Test: `app/tests/db/payments-fixtures.ts` (new helper), `app/tests/db/payments-settle.test.ts`, `app/tests/db/payments-notify.test.ts`, `app/tests/unit/payment-texts.test.ts`, `app/tests/unit/payment-messages.test.ts` (new); `app/tests/unit/site-gate.test.ts`, `app/tests/unit/site-routing.test.ts` (extend); `app/tests/e2e/gate.spec.ts` (one case)

**Interfaces:**
- Consumes: `payments`, `Payment`, `PaymentKind`, `registrations.seatHoldUntil` (Task 1); `hasFreeSeat` (Task 1); `Montonio`, `OrderToken`, `OrderSnapshot`, `MontonioStatus`, `JwtError`, `paymentProvider` (Task 2).
- Produces, from `src/domain/payments.ts`: `ORDER_REFERENCE_PREFIX = "MSLAB-M"`; `orderReference(paymentId: number): string`.
- Produces, from `src/db/queries/payments.ts`:
  - `type NewPayment = { kind: PaymentKind; registrationId: number | null; courseId: number; clientId: number | null; email: string; name: string; locale: "et" | "ru"; amountCents: number; newsletter?: boolean }`;
  - `insertPayment(q: Q, input: NewPayment, now: Date): Promise<Payment>`; `paymentByReference(q: Q, reference: string): Promise<Payment | null>`;
  - `attachOrder(db: Db, id: number, providerUuid: string, now: Date): Promise<void>`;
  - `releaseHold(q: Q, registrationId: number, exceptPaymentId: number, now: Date): Promise<boolean>`;
  - `failPayment(db: Db, id: number, now: Date): Promise<{ payment: Payment; released: boolean } | null>`;
  - `type PaymentContext = { course: { title: I18n; slug: string } | null; session: { startsAt: Date; city: string; venue: string } | null; payToken: string | null }`; `paymentContext(q: Q, paymentId: number): Promise<PaymentContext>`.
- Produces, from `src/db/queries/admin.ts`: `type RegistrationPaid = { registration: Registration; course: Course; session: CourseSession | null; wasConfirmed: boolean; full: boolean }`; `addRegistrationPayment(tx: Tx, registrationId: number, cents: number, now: Date): Promise<RegistrationPaid | null>` (in the caller's transaction).
- Produces, from `src/server/payments/settle.ts`: `type SettleDeps = { db; env: Env; now; siteUrl; later; changed?; montonio: Montonio }`; `type Facts`; `type SettleResult = { kind: "unknown" } | { kind: "unconfirmed"; payment: Payment } | { kind: "done"; payment: Payment }`; `factsOf(s: OrderSnapshot, bank?: string): Facts`; `settleToken(deps: SettleDeps, token: OrderToken): Promise<SettleResult>`; `settlePayment(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment>`.
- Produces, from `src/server/payments/routes.ts`: `type PaymentRouteDeps = Omit<SettleDeps, "montonio"> & { montonio: Montonio | null }`; `handleNotify(request: Request, deps: PaymentRouteDeps): Promise<Response>`; `MAX_NOTIFY_BODY = 8 * 1024`.
- Produces, from `src/server/messages.ts`: `type PaymentNotice`, `paymentSummary(p: PaymentNotice, adminUrl: string): Summary`; `type PaymentAlert`, `paymentAlertSummary(a: PaymentAlert, adminUrl: string): Summary`.
- Produces, from `src/server/account-mail.ts`: `type RegistrationPaidInput`; `registrationPaidMail(input: RegistrationPaidInput): Mail`.
- Produces, in the dictionaries: the section `payment` (`pay`, `payRest`, `transfer`, `starting`, `page.{heading, nothing, full}`, `result.{title, paid, pending, cancelled, retry, openCourse}`, `mail.{subjectConfirmed, subjectReceived, subjectEcourse, leadConfirmed, leadReceived, leadEcourse, paid, rest, allPaid, full, notConfirmed, access}`). Every later task uses these keys.
- Produces, for the tests (`tests/db/payments-fixtures.ts`): `TEST_MONTONIO`, `SITE`, `orderToken(payment, over?, opts?)`, `stubMontonio()` (`{ state: { down, snapshots, orders, gets }, montonio, mails(), pings() }`), `settleDeps(db, montonio, now)` (`{ deps, changes, flush }`), `contactCourse(db, opts?)`, `registrationOn(db, c, over?)`, `pendingPayment(db, r, over?, now?)`.

- [ ] **Step 1: The texts first — write the failing text test** `tests/unit/payment-texts.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The visitor-facing texts of online payments (phase 2b, spec 9), pinned as the spec gives them. {amount} and {title} are the spec's
// {summa} and {kursus}. The Russian ones are drafts for the native-speaker check (docs/launch-checklist.md §10), with the account's typography
// rule: a no-break space after the one-letter words в, с, к, о, у.

describe("spec 9, verbatim", () => {
  test("Estonian", () => {
    expect([et.payment.pay, et.payment.payRest, et.payment.transfer]).toEqual(["Maksa {amount}", "Maksa ülejäänud {amount}", "või tasu pangaülekandega"]);
    expect(et.payment.page).toEqual({ heading: "Koolituse eest tasumine", nothing: "Selle registreeringu eest pole praegu midagi tasuda.", full: "See koolitus on täis. Võta ühendust Mariaga." });
    expect([et.payment.result.paid, et.payment.result.pending, et.payment.result.cancelled, et.payment.result.retry]).toEqual([
      "Makse õnnestus. Saatsime sulle kinnituse e-postiga.",
      "Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.",
      "Makse jäi tegemata.",
      "Proovi uuesti",
    ]);
    expect([et.payment.mail.subjectConfirmed, et.payment.mail.subjectReceived, et.payment.mail.subjectEcourse]).toEqual(["Koht on kinnitatud — {title}", "Makse on kätte saadud — {title}", "E-koolitus on avatud — {title}"]);
    expect(et.payment.mail.rest).toBe("Ülejäänud {amount} tasud koolituspäeval või Minu koolitused lehel.");
  });

  test("Russian (with the no-break spaces)", () => {
    expect([ru.payment.pay, ru.payment.payRest, ru.payment.transfer]).toEqual(["Оплатить {amount}", "Оплатить остаток {amount}", "или оплатите банковским переводом"]);
    expect(ru.payment.page).toEqual({ heading: "Оплата обучения", nothing: "По этой регистрации сейчас ничего оплачивать не нужно.", full: "Эта группа заполнена. Свяжитесь с Марией." });
    expect([ru.payment.result.paid, ru.payment.result.pending, ru.payment.result.cancelled, ru.payment.result.retry]).toEqual([
      "Оплата прошла. Мы отправили вам подтверждение по e-mail.",
      "Платёж в обработке. Когда банк его подтвердит, мы пришлём подтверждение.",
      "Оплата не прошла.",
      "Попробовать снова",
    ]);
    expect([ru.payment.mail.subjectConfirmed, ru.payment.mail.subjectReceived, ru.payment.mail.subjectEcourse]).toEqual(["Место подтверждено — {title}", "Платёж получен — {title}", "Онлайн-курс открыт — {title}"]);
  });
});

describe("Russian typography in every payment string", () => {
  const strings = (value: unknown, path: string): [string, string][] =>
    typeof value === "string" ? [[path, value]] : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, `${path}.${k}`));

  test("no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    const all = strings(ru.payment, "payment");
    expect(all.length).toBeGreaterThan(20);
    for (const [key, text] of all) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/unit/payment-texts.test.ts` (`et.payment` does not exist).

- [ ] **Step 3: The dictionaries.**
  1. **`src/i18n/dict/et.ts`**, after the `cart` section:

```ts
  // Online payments (phase 2b, spec 9). {amount} is euros ("175 €"), {title} the course, {date} the last day of an e-course's access. The
  // buttons are the card's (components/account/AccountCourseCard.tsx), the mail's, the /maksa page's (server/pay-page.ts) and the cart's.
  payment: {
    pay: "Maksa {amount}",
    payRest: "Maksa ülejäänud {amount}",
    transfer: "või tasu pangaülekandega",
    // the button while the payment page is being opened
    starting: "Avan makse…",
    // the page behind the mail's "Maksa" link (/maksa/<token>)
    page: {
      heading: "Koolituse eest tasumine",
      nothing: "Selle registreeringu eest pole praegu midagi tasuda.",
      full: "See koolitus on täis. Võta ühendust Mariaga.",
    },
    // the page the bank sends the payer back to (/makse#tulemus=…, components/site/PaymentResult.tsx)
    result: {
      title: "Makse",
      paid: "Makse õnnestus. Saatsime sulle kinnituse e-postiga.",
      pending: "Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.",
      cancelled: "Makse jäi tegemata.",
      retry: "Proovi uuesti",
      openCourse: "Ava e-koolitus",
    },
    // the mails after a payment (server/account-mail.ts registrationPaidMail, ecourseOpenMail)
    mail: {
      subjectConfirmed: "Koht on kinnitatud — {title}",
      subjectReceived: "Makse on kätte saadud — {title}",
      subjectEcourse: "E-koolitus on avatud — {title}",
      leadConfirmed: "Makse on kätte saadud. Sinu koht on kinnitatud.",
      leadReceived: "Makse on kätte saadud. Aitäh!",
      leadEcourse: "Makse on kätte saadud. E-koolitus on sinu jaoks avatud.",
      paid: "Tasutud",
      rest: "Ülejäänud {amount} tasud koolituspäeval või Minu koolitused lehel.",
      allPaid: "Kogu summa on tasutud.",
      full: "Koolitus on vahepeal täitunud, nii et koht jäi kinnitamata. Maria võtab sinuga ühendust.",
      notConfirmed: "Maria võtab sinuga ühendust.",
      access: "Ligipääs kuni {date}.",
    },
  },
```

  2. **`src/i18n/dict/ru.ts`**, after its `cart` section:

```ts
  payment: {
    pay: "Оплатить {amount}",
    payRest: "Оплатить остаток {amount}",
    transfer: "или оплатите банковским переводом",
    starting: "Открываем оплату…",
    page: {
      heading: "Оплата обучения",
      nothing: "По этой регистрации сейчас ничего оплачивать не нужно.",
      full: "Эта группа заполнена. Свяжитесь с Марией.",
    },
    result: {
      title: "Оплата",
      paid: "Оплата прошла. Мы отправили вам подтверждение по e-mail.",
      pending: "Платёж в обработке. Когда банк его подтвердит, мы пришлём подтверждение.",
      cancelled: "Оплата не прошла.",
      retry: "Попробовать снова",
      openCourse: "Открыть онлайн-курс",
    },
    mail: {
      subjectConfirmed: "Место подтверждено — {title}",
      subjectReceived: "Платёж получен — {title}",
      subjectEcourse: "Онлайн-курс открыт — {title}",
      leadConfirmed: "Платёж получен. Ваше место подтверждено.",
      leadReceived: "Платёж получен. Спасибо!",
      leadEcourse: "Платёж получен. Онлайн-курс для вас открыт.",
      paid: "Оплачено",
      rest: "Остаток {amount} оплатите в день обучения или на странице «Мои курсы».",
      allPaid: "Вся сумма оплачена.",
      full: "Группа тем временем заполнилась, поэтому место не подтверждено. Мария свяжется с вами.",
      notConfirmed: "Мария свяжется с вами.",
      access: "Доступ до {date}.",
    },
  },
```

- [ ] **Step 4: Run** `npx vitest run tests/unit/payment-texts.test.ts tests/unit/i18n.test.ts` — expect PASS.

- [ ] **Step 5: Write the failing message and mail tests** `tests/unit/payment-messages.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { registrationPaidMail } from "@/server/account-mail";
import { paymentAlertSummary, paymentSummary, type PaymentNotice } from "@/server/messages";

// Phase 2b (spec 6.2.4–6.2.5, 9): Maria's notice of every payment ("Uus makse: {nimi}, {mis}, {summa}"), her alerts ("Kontrolli Montonios"),
// and the payer's mail after a paid registration in the confirmation mails' frame.

const NOTICE: PaymentNotice = {
  kind: "prepayment",
  name: "Kati Tamm",
  email: "kati@example.test",
  amountCents: 17500,
  course: "Kulmumeistri baaskoolitus",
  startsAt: new Date("2026-11-14T08:00:00Z"),
  method: "paymentInitiation",
  bank: "Swedbank",
  reference: "MSLAB-M7",
  providerUuid: "uuid-7",
  outcome: "confirmed",
  restCents: 17500,
};

describe("Maria's notice of a payment", () => {
  test("'Uus makse: {nimi}, {mis}, {summa}': the payment, what it is for, the payer, the method and Montonio's id; what it did", () => {
    const s = paymentSummary(NOTICE, "https://mslab.example/admin");
    expect(s.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(s.short).toBe(s.subject);
    for (const line of ["Makse: Ettemaks", "Summa: 175 €", "Koolitus: Kulmumeistri baaskoolitus, 14.11.2026", "Maksja: Kati Tamm", "E-post: kati@example.test", "Viis: paymentInitiation · Swedbank", "Viide: MSLAB-M7", "Montonio: uuid-7"])
      expect(s.text).toContain(line);
    expect(s.text).toContain("Registreering on kinnitatud. Ülejäänud 175 € tasub ta koolituspäeval või Minu koolitustes.");
    expect(s.text).toContain("Admin: https://mslab.example/admin");
  });

  test("the outcomes: fully paid, the money only recorded, the course full (D2), an e-course opened, or not", () => {
    const note = (over: Partial<PaymentNotice>) => paymentSummary({ ...NOTICE, ...over }, "https://mslab.example/admin");
    expect(note({ kind: "balance", restCents: 0 }).text).toContain("Registreering on kinnitatud ja täielikult tasutud.");
    expect(note({ kind: "balance", restCents: 0 }).text).toContain("Makse: Ülejäänud");
    expect(note({ outcome: "received" }).text).toContain("Makse on registreeringule kirja pandud.");
    const full = note({ outcome: "full" });
    expect(full.subject).toBe("Makse laekus, aga koolitus on täis: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(full.text).toContain("Koolitus on täis: koht jäi kinnitamata");
    const ecourse = note({ kind: "ecourse", course: "Kulmumeistri e-koolitus", startsAt: null, outcome: "opened", amountCents: 19000 });
    expect(ecourse.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus, 190 €");
    expect(ecourse.text).toContain("Makse: E-koolitus");
    expect(ecourse.text).toContain("E-koolitus on avatud.");
    expect(note({ kind: "ecourse", outcome: "notOpened" }).text).toContain("E-koolitust ei avatud");
  });
});

describe("Maria's alerts: 'Kontrolli Montonios'", () => {
  const alert = (a: "held" | "voided" | "refunded") =>
    paymentAlertSummary(
      { alert: a, kind: "prepayment", name: "Kati Tamm", email: "kati@example.test", amountCents: 17500, course: "Kulmumeistri baaskoolitus", startsAt: new Date("2026-11-14T08:00:00Z"), reference: "MSLAB-M7", providerUuid: "uuid-7", rawStatus: a === "voided" ? "VOIDED" : a === "refunded" ? "PARTIALLY_REFUNDED" : "PAID", paidCents: 100, currency: "EUR" },
      "https://mslab.example/admin",
    );
  test("the subject names her, the course and the amount; the text says what happened and that nothing changed by itself", () => {
    expect(alert("held").subject).toBe("Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(alert("held").text).toContain("summa või valuuta ei klapi (Montonio: 1 € EUR)");
    expect(alert("held").text).toContain("Ootel kontrollil");
    expect(alert("voided").text).toContain("VOIDED");
    expect(alert("voided").text).toContain("Kinnitus ja ligipääs jäid alles");
    expect(alert("refunded").text).toContain("PARTIALLY_REFUNDED");
    expect(alert("refunded").text).toContain("jäid muutmata");
  });
});

describe("the payer's mail after a paid registration", () => {
  const input = {
    siteUrl: "https://mslab.example",
    email: "kati@example.test",
    name: "Kati Tamm",
    locale: "et" as const,
    course: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" },
    session: { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" },
    paidCents: 17500,
    restCents: 17500,
    confirmed: true,
    full: false,
  };

  test("confirmed: 'Koht on kinnitatud — …', the course, its date and place, what was paid and what is left; one button, Ava minu konto", () => {
    const mail = registrationPaidMail(input);
    expect([mail.to, mail.subject]).toEqual(["kati@example.test", "Koht on kinnitatud — Kulmumeistri baaskoolitus"]);
    for (const line of ["Tere, Kati!", "Makse on kätte saadud. Sinu koht on kinnitatud.", "Kulmumeistri baaskoolitus", "14.11.2026 · 10:00", "Pärnu, MS LAB stuudio", "Tasutud: 175 €", "Ülejäänud 175 € tasud koolituspäeval või Minu koolitused lehel.", "Ava minu konto:"])
      expect(mail.text).toContain(line);
    expect(mail.html!.match(/bgcolor="#222222"/g)).toHaveLength(1);
    expect(registrationPaidMail({ ...input, restCents: 0 }).text).toContain("Kogu summa on tasutud.");
  });

  test("not confirmed (the course was full): 'Makse on kätte saadud — …' and Maria will be in touch; no rest line", () => {
    const mail = registrationPaidMail({ ...input, confirmed: false, full: true });
    expect(mail.subject).toBe("Makse on kätte saadud — Kulmumeistri baaskoolitus");
    expect(mail.text).toContain("Koolitus on vahepeal täitunud, nii et koht jäi kinnitamata. Maria võtab sinuga ühendust.");
    expect(mail.text).not.toContain("Ülejäänud");
  });

  test("Russian", () => {
    const mail = registrationPaidMail({ ...input, locale: "ru" });
    expect(mail.subject).toBe("Место подтверждено — Базовый курс бровиста");
    expect(mail.text).toContain("Остаток 175 € оплатите в день обучения или на странице «Мои курсы».");
  });
});
```

- [ ] **Step 6: Run it — expect FAIL**: `npx vitest run tests/unit/payment-messages.test.ts`.

- [ ] **Step 7: Maria's texts** — in `src/server/messages.ts`:
  1. At the top (the file has no imports yet), add:

```ts
import type { PaymentKind } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { formatDate } from "@/i18n/format";
```

  2. At the end, add:

```ts
// ---------- payments (phase 2b, spec 6.2.5, 7.3, 7.4) ----------

const PAYMENT_KIND: Record<PaymentKind, string> = { prepayment: "Ettemaks", balance: "Ülejäänud", ecourse: "E-koolitus" };

/** What a payment was for: "Kulmumeistri baaskoolitus, 14.11.2026" (a registration's session day), or the e-course's title alone. */
const paidFor = (course: string, startsAt: Date | null): string => (startsAt ? `${course}, ${formatDate(startsAt, "et")}` : course);

/** A paid payment, for Maria's notice. `outcome`: what it did (settle.ts). `restCents`: left to pay on the registration afterwards. */
export type PaymentNotice = {
  kind: PaymentKind;
  name: string;
  email: string;
  amountCents: number;
  course: string;
  startsAt: Date | null;
  method: string;
  bank: string;
  reference: string;
  providerUuid: string | null;
  outcome: "confirmed" | "received" | "full" | "opened" | "notOpened";
  restCents?: number;
};

/** "Uus makse: {nimi}, {mis}, {summa}" (spec 9), or "Makse laekus, aga koolitus on täis: …" when the course was full (D2). */
export function paymentSummary(p: PaymentNotice, adminUrl: string): Summary {
  const amount = formatEUR(p.amountCents, "et");
  const what = paidFor(p.course, p.startsAt);
  const subject = `${p.outcome === "full" ? "Makse laekus, aga koolitus on täis" : "Uus makse"}: ${p.name}, ${what}, ${amount}`;
  const rest = p.restCents ?? 0;
  const notes: Record<PaymentNotice["outcome"], string> = {
    confirmed: rest > 0 ? `Registreering on kinnitatud. Ülejäänud ${formatEUR(rest, "et")} tasub ta koolituspäeval või Minu koolitustes.` : "Registreering on kinnitatud ja täielikult tasutud.",
    received: "Makse on registreeringule kirja pandud.",
    full: "Koolitus on täis: koht jäi kinnitamata, makse on registreeringule kirja pandud. Võta õpilasega ühendust (Registreerimised).",
    opened: "E-koolitus on avatud.",
    notOpened: "E-koolitust ei avatud: kursust ei leitud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.",
  };
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[p.kind]],
        ["Summa", amount],
        ["Koolitus", what],
        ["Maksja", p.name],
        ["E-post", p.email],
        ["Viis", [p.method, p.bank].filter(Boolean).join(" · ")],
        ["Viide", p.reference],
        ["Montonio", p.providerUuid ?? undefined],
      ],
      adminUrl,
      notes[p.outcome],
    ),
    short: subject,
  };
}

/** A payment Maria must look at in Montonio's own dashboard (spec 7.3, 7.4, 8). `paidCents` and `currency`: what Montonio said. */
export type PaymentAlert = {
  alert: "held" | "voided" | "refunded";
  kind: PaymentKind;
  name: string;
  email: string;
  amountCents: number;
  course: string;
  startsAt: Date | null;
  reference: string;
  providerUuid: string | null;
  rawStatus: string;
  paidCents: number | null;
  currency: string | null;
};

/** "Kontrolli Montonios: {nimi}, {mis}, {summa}": nothing was changed by itself; Maria decides. */
export function paymentAlertSummary(a: PaymentAlert, adminUrl: string): Summary {
  const subject = `Kontrolli Montonios: ${a.name}, ${paidFor(a.course, a.startsAt)}, ${formatEUR(a.amountCents, "et")}`;
  const said = `${a.paidCents === null ? "summa puudub" : formatEUR(a.paidCents, "et")} ${a.currency ?? ""}`.trim();
  const notes = {
    held: `Montonio ütleb makstud, aga summa või valuuta ei klapi (Montonio: ${said}). Midagi ei kinnitatud ega avatud: makse on lehel Maksed "Ootel kontrollil".`,
    voided: "Pank tühistas juba laekunud makse (VOIDED). Kinnitus ja ligipääs jäid alles: otsusta, kas need tühistada (Registreerimised, Õpilased).",
    refunded: `Montonio teatab tagastusest (${a.rawStatus}). Tasutud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja.`,
  } as const;
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[a.kind]],
        ["Summa", formatEUR(a.amountCents, "et")],
        ["Maksja", a.name],
        ["E-post", a.email],
        ["Viide", a.reference],
        ["Montonio", a.providerUuid ?? undefined],
      ],
      adminUrl,
      notes[a.alert],
    ),
    short: subject,
  };
}
```

- [ ] **Step 8: The payer's mail** — in `src/server/account-mail.ts`:
  1. After `registrationConfirmationMail`, add:

```ts
export type RegistrationPaidInput = {
  siteUrl: string;
  email: string;
  name: string;
  locale: Locale;
  course: I18n;
  session: SessionInfo | null;
  /** This payment, cents. */
  paidCents: number;
  /** What is left to pay on the registration after it (its price − its paidCents), cents. */
  restCents: number;
  /** The registration is confirmed now. */
  confirmed: boolean;
  /** Paid, but the course was full: the place stayed unconfirmed (D2). */
  full: boolean;
};

/**
 * The mail after an online payment of a registration (phase 2b, spec 6.2.4): "Koht on kinnitatud — {title}" when the place is confirmed now,
 * else "Makse on kätte saadud — {title}"; the course with its date and place, what was paid, and what is left ("Ülejäänud {amount} tasud
 * koolituspäeval või Minu koolitused lehel.") or "Kogu summa on tasutud."; a place left unconfirmed says why. One button: "Ava minu konto".
 * settle.ts never sends it to a sample address and does not count it in the daily caps (it follows a real payment).
 */
export function registrationPaidMail(input: RegistrationPaidInput): Mail {
  const m = getDict(input.locale).payment.mail;
  const title = pick(input.course, input.locale);
  const sections: Section[] = [{ fields: [[m.paid, formatEUR(input.paidCents, input.locale)]] }];
  if (input.full) sections.push({ text: m.full });
  else if (!input.confirmed) sections.push({ text: m.notConfirmed });
  else sections.push({ text: input.restCents > 0 ? fill(m.rest, { amount: formatEUR(input.restCents, input.locale) }) : m.allPaid });
  return confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(input.confirmed ? m.subjectConfirmed : m.subjectReceived, { title })),
    lead: input.confirmed ? m.leadConfirmed : m.leadReceived,
    box: { title, lines: input.session ? sessionLines(input.session, input.locale) : [] },
    sections,
    login: null,
  });
}
```

  2. In the file's top comment, after the sentence about the confirmation e-mails, add: "After an online payment (phase 2b) the same card says what was paid (registrationPaidMail) or that an e-course is open (ecourseOpenMail)."

- [ ] **Step 9: Run** `npx vitest run tests/unit/payment-messages.test.ts` — expect PASS.

- [ ] **Step 10: The reference and the payment rows.**
  1. Create `src/domain/payments.ts`:

```ts
// Online payments' pure rules (phase 2b): the reference Montonio knows a payment by. No database, no React.

/** The prefix of every merchantReference (spec 4): MSLAB-M<the payment row's id>. */
export const ORDER_REFERENCE_PREFIX = "MSLAB-M";

/** Montonio's merchantReference of a payment row: unique per store, and a new one for every attempt (a new row). */
export const orderReference = (paymentId: number): string => `${ORDER_REFERENCE_PREFIX}${paymentId}`;
```

  2. Create `src/db/queries/payments.ts`:

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { orderReference } from "@/domain/payments";
import type { I18n } from "@/i18n/field";
import type { Db, Q } from "../client";
import * as schema from "../schema";
import { courses, courseSessions, payments, registrations, type Payment, type PaymentKind } from "../schema";

// The payments table (phase 2b, spec 5.1): one row per online payment attempt. The rows are written here and by server/payments/settle.ts
// (the status changes, each a conditional UPDATE). Nothing here logs.

/** A payment about to start: the payer as entered, what it is for and how much. */
export type NewPayment = {
  kind: PaymentKind;
  registrationId: number | null;
  courseId: number;
  clientId: number | null;
  email: string;
  name: string;
  locale: "et" | "ru";
  amountCents: number;
  newsletter?: boolean;
};

/**
 * A new pending payment row with its reference MSLAB-M<id> (spec 5.1: written right after the insert, in the same transaction; a
 * savepoint inside the caller's when `q` is one). The insert's own placeholder reference is never seen outside it.
 */
export async function insertPayment(q: Q, input: NewPayment, now: Date): Promise<Payment> {
  return (q as Db).transaction(async (tx) => {
    const [row] = await tx
      .insert(payments)
      .values({ ...input, newsletter: input.newsletter ?? false, reference: `new-${crypto.randomUUID()}`, status: "pending", createdAt: now, updatedAt: now })
      .returning();
    const [named] = await tx.update(payments).set({ reference: orderReference(row.id) }).where(eq(payments.id, row.id)).returning();
    return named;
  });
}

/** The payment Montonio knows by `reference` (its merchantReference), or null. */
export async function paymentByReference(q: Q, reference: string): Promise<Payment | null> {
  const [row] = await q.select().from(payments).where(eq(payments.reference, reference)).limit(1);
  return row ?? null;
}

/** Montonio's uuid of a payment's order, once it is created (never replacing one the row has). */
export async function attachOrder(db: Db, id: number, providerUuid: string, now: Date): Promise<void> {
  await db.update(payments).set({ providerUuid, updatedAt: now }).where(and(eq(payments.id, id), isNull(payments.providerUuid)));
}

/**
 * Ends the seat hold of an unpaid registration when no other payment of it is still pending (phase 2b): its prepayment failed, so the seat
 * is free again at once instead of after its 30 minutes. True when a live hold was ended.
 */
export async function releaseHold(q: Q, registrationId: number, exceptPaymentId: number, now: Date): Promise<boolean> {
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const rows = await (q as unknown as PostgresJsDatabase<typeof schema>)
    .update(registrations)
    .set({ seatHoldUntil: null })
    .where(
      and(
        eq(registrations.id, registrationId),
        eq(registrations.status, "awaiting_prepayment"),
        sql`${registrations.seatHoldUntil} > ${now.toISOString()}::timestamptz`,
        sql`not exists (select 1 from payments p where p.registration_id = ${registrationId} and p.status = 'pending' and p.id <> ${exceptPaymentId})`,
      ),
    )
    .returning({ id: registrations.id });
  return rows.length > 0;
}

/**
 * A pending payment that will not be paid (its order was refused, or Montonio said ABANDONED/FAILED): `failed`, and a prepayment's hold ends
 * (releaseHold), in one transaction. Null when it was not pending (paid is a floor: settle.ts).
 */
export async function failPayment(db: Db, id: number, now: Date): Promise<{ payment: Payment; released: boolean } | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.update(payments).set({ status: "failed", updatedAt: now }).where(and(eq(payments.id, id), eq(payments.status, "pending"))).returning();
    if (!payment) return null;
    const released = payment.kind === "prepayment" && payment.registrationId !== null ? await releaseHold(tx, payment.registrationId, payment.id, now) : false;
    return { payment, released };
  });
}

/** What a payment was for: the course, the session of its registration, and that registration's "Maksa" token (the return's "Proovi uuesti"). */
export type PaymentContext = {
  course: { title: I18n; slug: string } | null;
  session: { startsAt: Date; city: string; venue: string } | null;
  payToken: string | null;
};

export async function paymentContext(q: Q, paymentId: number): Promise<PaymentContext> {
  const [row] = await q
    .select({ title: courses.title, slug: courses.slug, startsAt: courseSessions.startsAt, city: courseSessions.city, venue: courseSessions.venue, payToken: registrations.payToken })
    .from(payments)
    .leftJoin(courses, eq(payments.courseId, courses.id))
    .leftJoin(registrations, eq(payments.registrationId, registrations.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(payments.id, paymentId))
    .limit(1);
  return {
    course: row?.title && row.slug ? { title: row.title, slug: row.slug } : null,
    session: row?.startsAt ? { startsAt: row.startsAt, city: row.city ?? "", venue: row.venue ?? "" } : null,
    payToken: row?.payToken ?? null,
  };
}
```

  3. **`src/db/queries/admin.ts`.** Add `hasFreeSeat` to the `./seats` import and `Tx` to the `../client` type import (`import type { Db, Q, Tx } from "../client";`); after `recordRegistrationPayment`, add:

```ts
/** What an online payment did to a registration (server/payments/settle.ts). `full`: paid, but kept unconfirmed for want of a seat (D2). */
export type RegistrationPaid = { registration: Registration; course: Course; session: CourseSession | null; wasConfirmed: boolean; full: boolean };

/**
 * An online payment of `cents` arrived for a registration (phase 2b, spec 6.2.2): `paidCents` becomes the current value + `cents` — an
 * absolute value written under the row's lock (FOR UPDATE), as recordRegistrationPayment writes Maria's — and the status follows the same
 * rule (confirmed from 50 %). One exception (D2): a registration that is not confirmed yet stays awaiting_prepayment when its session has
 * no free seat for it, counting the others' seats, confirmed or held, but not her own row (her hold may have ended): `full` says so. A
 * confirmed registration, or one kept for want of a seat, has no hold any more. Runs in the caller's transaction; null: the row is gone.
 */
export async function addRegistrationPayment(tx: Tx, registrationId: number, cents: number, now: Date): Promise<RegistrationPaid | null> {
  const [current] = await tx
    .select({ registration: registrations, course: courses, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(registrations.id, registrationId))
    .for("update", { of: registrations });
  if (!current) return null;
  const { registration: r, course, session } = current;
  const paidCents = r.paidCents + cents;
  const total = registrationPrice(course, r.kind);
  let status = total == null ? r.status : registrationStatusAfterPayment({ status: r.status, paidCents }, total);
  const wasConfirmed = r.status === "confirmed";
  let full = false;
  if (!wasConfirmed && status === "confirmed" && session && !(await hasFreeSeat(tx, session, now, r.id))) {
    status = r.status;
    full = true;
  }
  const endHold = full || status === "confirmed";
  const [row] = await tx
    .update(registrations)
    .set({ paidCents, status, ...(endHold ? { seatHoldUntil: null } : {}) })
    .where(eq(registrations.id, registrationId))
    .returning();
  return { registration: row, course, session, wasConfirmed, full };
}
```

- [ ] **Step 11: The test helpers** — create `tests/db/payments-fixtures.ts`:

```ts
import type { Db } from "@/db/client";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { courses, courseSessions, registrations, type Course, type CourseSession, type Payment, type Registration } from "@/db/schema";
import type { PublicChange } from "@/server/cache-targets";
import type { Env } from "@/server/notify";
import { signHs256, verifyHs256 } from "@/server/payments/jwt";
import { montonioClient, SANDBOX_BASE, type MontonioConfig } from "@/server/payments/montonio";
import type { SettleDeps } from "@/server/payments/settle";
import { fakeKv, stubFetch } from "../fakes";

// The payment DB tests' common parts (phase 2b): a store with made-up keys, Montonio + Resend + Telegram behind one stubbed fetch, order
// tokens as Montonio signs them, the settlement's dependencies, and a contact course with a registration and a pending payment.

export const TEST_MONTONIO: MontonioConfig = { accessKey: "test-access-key", secretKey: "test-secret-key-0123456789abcdef", baseUrl: SANDBOX_BASE, live: false, mock: false };
export const SITE = "https://mslab.example";

/** An order token as Montonio signs it (its orders guide's decoded payload) for `payment`: PAID, its amount, Swedbank; `over` replaces fields. */
export function orderToken(payment: Pick<Payment, "reference" | "amountCents" | "providerUuid">, over: Record<string, unknown> = {}, opts: { secret?: string; nowSec?: number } = {}): string {
  return signHs256(
    {
      uuid: payment.providerUuid ?? "uuid-unknown",
      accessKey: TEST_MONTONIO.accessKey,
      merchantReference: payment.reference,
      merchantReferenceDisplay: payment.reference,
      paymentStatus: "PAID",
      paymentMethod: "paymentInitiation",
      grandTotal: payment.amountCents / 100,
      currency: "EUR",
      senderIban: null,
      senderName: null,
      paymentProviderName: "Swedbank",
      ...over,
    },
    opts.secret ?? TEST_MONTONIO.secretKey,
    { expiresInSeconds: 600, nowSec: opts.nowSec },
  );
}

/**
 * Montonio, Resend and Telegram behind one stubbed fetch. POST /orders checks the order token and answers a new uuid and a paymentUrl (a 503
 * while `state.down`), and keeps the token's claims in `state.orders`; GET /orders/<uuid> answers `state.snapshots.get(uuid)` (none: a 503, "no
 * answer") and keeps the uuid in `state.gets`. `mails()`: the Resend calls' bodies; `pings()`: the Telegram texts.
 */
export function stubMontonio() {
  const state = { down: false, snapshots: new Map<string, Record<string, unknown>>(), orders: [] as Record<string, unknown>[], gets: [] as string[] };
  let n = 0;
  const f = stubFetch((url, init) => {
    if (url.includes("resend")) return Response.json({ id: "email_1" });
    if (url.includes("telegram")) return Response.json({ ok: true });
    if (url === `${SANDBOX_BASE}/orders` && init?.method === "POST") {
      if (state.down) return Response.json({ message: "Service unavailable" }, { status: 503 });
      const { claims } = verifyHs256<Record<string, unknown>>((JSON.parse(String(init.body)) as { data: string }).data, TEST_MONTONIO.secretKey);
      state.orders.push(claims);
      const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      return Response.json({ uuid, paymentStatus: "PENDING", merchantReference: claims.merchantReference, paymentUrl: `https://sandbox-stargate.montonio.com/${uuid}` });
    }
    const get = /\/orders\/([^/]+)$/.exec(url);
    if (get) {
      state.gets.push(get[1]);
      const snapshot = state.snapshots.get(get[1]);
      return snapshot ? Response.json(snapshot) : new Response("Service unavailable", { status: 503 });
    }
    return Response.json({});
  });
  return {
    state,
    montonio: montonioClient(TEST_MONTONIO),
    mails: () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string; text: string; html?: string }),
    pings: () => f.calls.filter((c) => c.url.includes("telegram")).map((c) => (c.body as { text: string }).text),
  };
}

/**
 * The settlement's dependencies on `db` at `now`, Resend and Telegram set up. `flush()` runs the work after the response, one task after the
 * other in the order it was queued (so the mails' order is fixed); `changes`: the revalidations.
 */
export function settleDeps(db: Db, montonio: SettleDeps["montonio"], now: Date) {
  const tasks: (() => Promise<unknown>)[] = [];
  const changes: PublicChange[] = [];
  const env: Env = { KV: fakeKv({ "tg:chat": "42" }), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc" };
  const deps: SettleDeps = { db, env, now, siteUrl: SITE, later: (task) => void tasks.push(task), changed: (change) => void changes.push(change), montonio };
  const flush = async () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
  };
  return { deps, changes, flush };
}

/** A published contact course, Kulmumeistri baaskoolitus (350 €), with one session of `capacity` (4) on 14.11.2026 at 10:00 in Pärnu. */
export async function contactCourse(db: Db, opts: { capacity?: number; startsAt?: Date } = {}): Promise<{ course: Course; session: CourseSession }> {
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-baaskoolitus", type: "contact", level: "basic", title: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 35000 })
    .returning();
  const [session] = await db
    .insert(courseSessions)
    .values({ courseId: course.id, startsAt: opts.startsAt ?? new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", capacity: opts.capacity ?? 4 })
    .returning();
  return { course, session };
}

/** A group registration on `c`'s session: Kati Tamm, half, awaiting and unpaid unless `over` says otherwise. */
export async function registrationOn(db: Db, c: { course: Course; session: CourseSession }, over: Partial<typeof registrations.$inferInsert> = {}): Promise<Registration> {
  const [row] = await db
    .insert(registrations)
    .values({ courseId: c.course.id, courseSessionId: c.session.id, kind: "group", name: "Kati Tamm", email: "kati@example.com", phone: "+372 5555 0101", paymentChoice: "half", status: "awaiting_prepayment", paidCents: 0, ...over })
    .returning();
  return row;
}

/** A pending payment of `r` (its prepayment of 175 € by default) whose order exists at Montonio with `providerUuid` (a fixed uuid by default). */
export async function pendingPayment(
  db: Db,
  r: Registration,
  over: { kind?: "prepayment" | "balance"; amountCents?: number; providerUuid?: string | null } = {},
  now: Date = new Date("2026-10-09T09:55:00Z"),
): Promise<Payment> {
  const row = await insertPayment(db, { kind: over.kind ?? "prepayment", registrationId: r.id, courseId: r.courseId, clientId: r.clientId, email: r.email, name: r.name, locale: r.locale === "ru" ? "ru" : "et", amountCents: over.amountCents ?? 17500 }, now);
  const uuid = over.providerUuid === undefined ? `uuid-${row.id}` : over.providerUuid;
  if (uuid === null) return row;
  await attachOrder(db, row.id, uuid, now);
  return { ...row, providerUuid: uuid };
}
```

- [ ] **Step 12: Write the failing settlement tests** `tests/db/payments-settle.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations } from "@/db/schema";
import { settlePayment, settleToken } from "@/server/payments/settle";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// settlePayment, the one door (phase 2b, spec 6.2, 7.3, 7.4): the winner of pending → paid does the once-only work, the amount must match, paid
// is a floor, a token in doubt is asked about, and the payer's mail and Maria's notice follow (after the response).

const NOW = new Date("2026-10-09T10:00:00Z");
const MIN = 60_000;
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];
const payment = async (id: number) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
const subjects = (m: ReturnType<typeof stubMontonio>) => m.mails().map((x) => [x.to, x.subject]);

describe("PAID", () => {
  test("the webhook twice: pending → paid once; 50 % confirms, the hold ends, one mail to her and one notice to Maria, the seats revalidated", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "paid", paidAt: NOW, method: "paymentInitiation", bank: "Swedbank" } });
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "paid" } });
    await flush();
    const after = await registration(r.id);
    expect([after.status, after.paidCents, after.seatHoldUntil]).toEqual(["confirmed", 17500, null]);
    expect(subjects(m)).toEqual([
      ["kati@example.com", "Koht on kinnitatud — Kulmumeistri baaskoolitus"],
      ["maria@example.test", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
    ]);
    expect(m.mails()[0].text).toContain("Ülejäänud 175 € tasud koolituspäeval või Minu koolitused lehel.");
    expect(m.pings()).toEqual([expect.stringContaining("Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €")]);
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
    expect(m.state.gets).toEqual([]); // nothing was in doubt
  });

  test("the return and the webhook at once: one winner, the amount counted once", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    await Promise.all([settleToken(deps, token), settleToken(deps, token)]);
    await flush();
    expect((await registration(r.id)).paidCents).toBe(17500);
    expect(m.mails()).toHaveLength(2);
  });

  test("the rest after 50 %: a balance payment makes it fully paid; the mail says nothing is left", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { status: "confirmed", paidCents: 17500 });
    const p = await pendingPayment(db, r, { kind: "balance" });
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 35000]);
    expect(m.mails()[0].subject).toBe("Koht on kinnitatud — Kulmumeistri baaskoolitus");
    expect(m.mails()[0].text).toContain("Kogu summa on tasutud.");
    expect(m.mails()[1].text).toContain("Registreering on kinnitatud ja täielikult tasutud.");
  });

  test("paid when the course is full (D2): the money is recorded, the place stays unconfirmed, 'Makse laekus, aga koolitus on täis'", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    await registrationOn(db, c, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() - MIN) }); // her hold has ended
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    const after = await registration(r.id);
    expect([after.status, after.paidCents, after.seatHoldUntil]).toEqual(["awaiting_prepayment", 17500, null]);
    expect(subjects(m)).toEqual([
      ["kati@example.com", "Makse on kätte saadud — Kulmumeistri baaskoolitus"],
      ["maria@example.test", "Makse laekus, aga koolitus on täis: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
    ]);
    expect(m.mails()[0].text).toContain("Koolitus on vahepeal täitunud");
  });

  test("her own live hold is no obstacle on a full session: the hold is hers", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect((await registration(r.id)).status).toBe("confirmed");
  });

  test("the amount or the currency does not match: held, nothing confirmed, Maria alerted; held stays held", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal: 1 })))).toMatchObject({ kind: "done", payment: { status: "held", paidAt: null } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "held" } });
    const other = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(other, { currency: "USD" })))).toMatchObject({ payment: { status: "held" } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["awaiting_prepayment", 0]);
    expect(subjects(m)).toEqual([
      ["maria@example.test", "Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
      ["maria@example.test", "Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
    ]);
    expect(m.mails()[0].text).toContain("summa või valuuta ei klapi (Montonio: 1 € EUR)");
  });

  test("a sample address (@example.test) gets no mail; Maria is still told", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db), { email: "kati@example.test" }));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(subjects(m).map(([to]) => to)).toEqual(["maria@example.test"]);
  });
});

describe("after paid: paid is a floor", () => {
  test("a late ABANDONED changes nothing; VOIDED is stored as failed (paid_at kept) and alerts Maria; the place stays confirmed", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })))).toMatchObject({ payment: { status: "paid" } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "VOIDED" })))).toMatchObject({ payment: { status: "failed", paidAt: NOW } });
    // a retried PAID after the void never runs the once-only work again
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "failed" } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(m.mails().map((x) => x.subject)).toEqual([
      "Koht on kinnitatud — Kulmumeistri baaskoolitus",
      "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €",
      "Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €",
    ]);
    expect(m.mails()[2].text).toContain("VOIDED");
  });

  test("REFUNDED: refunded and an alert; paidCents and the confirmation stay (Maria adjusts in the admin)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "PARTIALLY_REFUNDED" })))).toMatchObject({ payment: { status: "refunded" } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(m.mails().at(-1)!.text).toContain("PARTIALLY_REFUNDED");
  });
});

describe("failed and pending", () => {
  test("ABANDONED on a pending prepayment: failed, the hold ends (the seat is free again), the seats revalidated; nothing mailed", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })))).toMatchObject({ payment: { status: "failed", paidAt: null } });
    await flush();
    expect((await registration(r.id)).seatHoldUntil).toBeNull();
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
    expect(m.mails()).toEqual([]);
  });

  test("a failed attempt keeps the hold while another payment of the registration is still pending", async () => {
    const m = stubMontonio();
    const hold = new Date(NOW.getTime() + 10 * MIN);
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: hold });
    const first = await pendingPayment(db, r);
    await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(first, { paymentStatus: "ABANDONED" })));
    expect((await registration(r.id)).seatHoldUntil).toEqual(hold);
  });

  test("PENDING and AUTHORIZED change nothing; a paid payment later still wins", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    for (const s of ["PENDING", "AUTHORIZED"]) expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: s })))).toMatchObject({ payment: { status: "pending" } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid" } });
  });

  test("an unknown reference: 'unknown', nothing changes", async () => {
    const m = stubMontonio();
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "x" })))).toEqual({ kind: "unknown" });
  });
});

describe("a token in doubt is asked about (spec 7.4)", () => {
  const snapshot = (uuid: string, reference: string, paymentStatus: string, grandTotal = "175.00") => ({ uuid, paymentStatus, merchantReference: reference, grandTotal, currency: "EUR", paymentMethodType: "paymentInitiation" });

  test("another store's key: no answer is 'unconfirmed' (nothing changes); Montonio's PAID settles it, with the token's bank", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p, { accessKey: "someone-else" }));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "unconfirmed", payment: { status: "pending" } });
    expect(m.state.gets).toEqual([p.providerUuid]);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID"));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "paid", bank: "Swedbank" } });
  });

  test("a token of another order: that order is asked about, and one of another reference changes nothing; a token naming no order: the row's own is asked about, and its ABANDONED fails the payment", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    m.state.snapshots.set("someone-elses-uuid", snapshot("someone-elses-uuid", "MSLAB-M999", "PAID"));
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "ABANDONED"));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { uuid: "someone-elses-uuid" })))).toMatchObject({ kind: "done", payment: { status: "pending" } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { uuid: undefined })))).toMatchObject({ kind: "done", payment: { status: "failed" } });
    expect(m.state.gets).toEqual(["someone-elses-uuid", p.providerUuid]);
  });

  test("an order the payment has since replaced (a retry re-sent its reference, Task 4): its ABANDONED changes nothing, the hold stays; its PAID settles it under that order's uuid", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r); // its first order: p.providerUuid
    await db.update(payments).set({ providerUuid: "uuid-resent" }).where(eq(payments.id, p.id)); // the retry's re-sent order
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "ABANDONED"));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })))).toMatchObject({ kind: "done", payment: { status: "pending", providerUuid: "uuid-resent" } });
    expect((await registration(r.id)).seatHoldUntil).not.toBeNull();
    // paid at the first order's bank page in the moment before the retry replaced it: the money counts, once
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID"));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ kind: "done", payment: { status: "paid", providerUuid: p.providerUuid } });
    expect(m.state.gets).toEqual([p.providerUuid, p.providerUuid]);
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
  });

  test("a token expired beyond the tolerance (a late retry) is asked about; an order of another reference changes nothing", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, "MSLAB-M999", "PAID"));
    const old = m.montonio.verifyOrderToken(orderToken(p, {}, { nowSec: Math.floor(Date.now() / 1000) - 3600 }));
    expect(old.expired).toBe(true);
    expect(await settleToken(deps, old)).toMatchObject({ kind: "done", payment: { status: "pending" } });
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID", "1.00"));
    expect(await settleToken(deps, old)).toMatchObject({ payment: { status: "held" } }); // Montonio's own amount is checked too
  });
});

test("settlePayment is the door the daily check uses too: the same facts, the same once-only work", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const p = await pendingPayment(db, r);
  const { deps } = settleDeps(db, m.montonio, NOW);
  const facts = { uuid: p.providerUuid!, status: "paid" as const, rawStatus: "PAID", amountCents: 17500, currency: "EUR", method: "paymentInitiation", bank: "" };
  expect((await settlePayment(deps, p, facts)).status).toBe("paid");
  expect((await settlePayment(deps, await payment(p.id), facts)).status).toBe("paid");
  expect((await registration(r.id)).paidCents).toBe(17500);
});
```

- [ ] **Step 13: Run it — expect FAIL**: `npx vitest run tests/db/payments-settle.test.ts` (`@/server/payments/settle` does not exist).

- [ ] **Step 14: Write `src/server/payments/settle.ts`:**

```ts
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { addRegistrationPayment, type RegistrationPaid } from "@/db/queries/admin";
import { failPayment, paymentByReference, paymentContext, type PaymentContext } from "@/db/queries/payments";
import { payments, type Payment } from "@/db/schema";
import { isSampleAddress } from "@/domain/email";
import { registrationPrice } from "@/domain/registration";
import { pick } from "@/i18n/field";
import { registrationPaidMail } from "../account-mail";
import type { PublicChange } from "../cache-targets";
import { logFailure, logNote } from "../log";
import { paymentAlertSummary, paymentSummary, type PaymentNotice } from "../messages";
import { adminUrl, mailConfigured, notifyMaria, sendMail, type Env } from "../notify";
import type { Montonio, MontonioStatus, OrderSnapshot, OrderToken } from "./montonio";

// The one door of every paid path (phase 2b, spec 6.2, 7.3, 7.4; Rempire's settle/apply/token-guard, ported). The webhook and the return
// (routes.ts) bring an order token, the daily check (check.ts) Montonio's own answer; all of them end in settlePayment:
// - PAID with the row's exact amount in EUR moves the row pending|failed → paid in ONE conditional UPDATE (paid_at null: a payment voided
//   after paid never comes back). Only the winner of that update does the once-only work, in the same transaction: the amount is added to
//   the registration (db/queries/admin.ts addRegistrationPayment: confirmed from 50 %, unless the course is full, D2). After it: the seats
//   are revalidated, and the payer's mail and Maria's notice go out after the response. Every other caller finds the row paid and does nothing.
// - PAID with another amount or currency: held. Nothing is confirmed or opened; Maria is alerted.
// - failed: a pending row fails, and a prepayment's hold ends (the seat is free again). paid is a floor: a later ABANDONED or FAILED changes
//   nothing; a VOIDED (the bank took a paid payment back) is stored as failed with its paid_at and alerts Maria, who decides.
// - refunded: stored and alerted; paidCents, the status and access stay (Maria refunds in Montonio's dashboard and adjusts in the admin).
// - pending: nothing.
// A token in doubt — another accessKey or none, a uuid that is not the row's, or expired beyond the tolerance — is confirmed with
// GET /orders/:uuid about the order the token names (the row's own when it names none), and Montonio's answer is used; no answer:
// "unconfirmed" (the webhook's 503: Montonio retries). That order may be one the row has since replaced: a retry while the attempt is open
// re-sends its merchantReference (start.ts) and Montonio may answer a new uuid, which the row then carries. A replaced order moves the row
// only with money (paid, and the row takes that order's uuid), never with its end: the row follows its newer order.
// These mails follow real payments only: they are not counted in the daily caps, and a sample address is never mailed. Logs carry the payment
// id and its status only.

export type SettleDeps = {
  db: Db;
  /** The settings and the KV store (Telegram's chat id), for the mails and Maria's notice. */
  env: Env;
  now: Date;
  /** The base of the links in the mails: SITE_URL for the webhook and the daily check, the request's own origin for the return. */
  siteUrl: string;
  /** Runs work after the response: the mails and Maria's notice (next/server after(); collected and awaited in the tests). */
  later: (task: () => Promise<unknown>) => void;
  /** Told when a payment changed the seats, so the calendar and the course page render again (server/public-cache.ts). */
  changed?: (change: PublicChange) => Promise<void> | void;
  montonio: Montonio;
};

/** What Montonio says about a payment: from a token, or from GET /orders/:uuid (factsOf). */
export type Facts = { uuid: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string; bank: string };

/** unknown: no row has this reference (logged, the webhook's 200); unconfirmed: in doubt and Montonio did not answer (the webhook's 503). */
export type SettleResult = { kind: "unknown" } | { kind: "unconfirmed"; payment: Payment } | { kind: "done"; payment: Payment };

/** GET /orders/:uuid's answer as facts. The bank's name is only in a token: `bank` keeps the one a token gave. */
export const factsOf = (s: OrderSnapshot, bank = ""): Facts => ({ uuid: s.uuid, status: s.status, rawStatus: s.rawStatus, amountCents: s.amountCents, currency: s.currency, method: s.method, bank });

/** The once-only work's outcome: the paid row, and what it did to its registration. */
type Won = { payment: Payment; registration: RegistrationPaid | null };

/** The door of an order token (the webhook, the return). */
export async function settleToken(deps: SettleDeps, token: OrderToken): Promise<SettleResult> {
  const row = await paymentByReference(deps.db, token.reference);
  if (!row) {
    logNote("[payments] an order token for an unknown reference: nothing to settle");
    return { kind: "unknown" };
  }
  const facts: Facts = { uuid: token.uuid, status: token.status, rawStatus: token.rawStatus, amountCents: token.amountCents, currency: token.currency, method: token.method, bank: token.bank };
  const doubt = token.accessKey !== deps.montonio.accessKey || (row.providerUuid !== null && token.uuid !== row.providerUuid) || token.expired;
  // a pending token moves nothing, so there is nothing to ask about
  if (!doubt || token.status === "pending") return { kind: "done", payment: await settlePayment(deps, row, facts) };
  // the order the token names (it may be one this row has replaced since: start.ts re-sends an open attempt); none named: the row's own
  const snapshot = await deps.montonio.fetchOrder(token.uuid || row.providerUuid || "");
  if (!snapshot) {
    logNote(`[payments] payment ${row.id}: a token in doubt, and Montonio did not answer`);
    return { kind: "unconfirmed", payment: row };
  }
  if (snapshot.reference !== row.reference) {
    logNote(`[payments] payment ${row.id}: Montonio's order is not this payment's; nothing changes`);
    return { kind: "done", payment: row };
  }
  // an order the row has replaced counts only with its money: its end (ABANDONED, …) is not the end of the row's newer order
  if (row.providerUuid !== null && snapshot.uuid !== row.providerUuid && snapshot.status !== "paid") {
    logNote(`[payments] payment ${row.id}: an order it has replaced says ${snapshot.status}; nothing changes`);
    return { kind: "done", payment: row };
  }
  return { kind: "done", payment: await settlePayment(deps, row, factsOf(snapshot, token.bank)) };
}

/** The door itself: `facts` applied to `row` (see the top of the file). Answers the row as it is afterwards. */
export async function settlePayment(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  switch (facts.status) {
    case "paid":
      return paid(deps, row, facts);
    case "failed":
      return failed(deps, row, facts);
    case "refunded":
      return refunded(deps, row, facts);
    default:
      return row;
  }
}

/** The row as the database has it now (after a conditional update another caller won). */
const current = async (deps: SettleDeps, row: Payment): Promise<Payment> => (await paymentByReference(deps.db, row.reference)) ?? row;

async function paid(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  if (facts.amountCents !== row.amountCents || facts.currency !== "EUR") return held(deps, row, facts);
  const won = await deps.db.transaction(async (tx): Promise<Won | null> => {
    // the uuid of the order that was paid (it differs from the row's only when a retry had replaced that order: settleToken)
    const [payment] = await tx
      .update(payments)
      .set({ status: "paid", paidAt: deps.now, updatedAt: deps.now, providerUuid: sql`coalesce(${facts.uuid || null}, ${payments.providerUuid})`, method: facts.method, bank: facts.bank })
      .where(and(eq(payments.id, row.id), inArray(payments.status, ["pending", "failed"]), isNull(payments.paidAt)))
      .returning();
    if (!payment) return null;
    const registration = payment.kind !== "ecourse" && payment.registrationId !== null ? await addRegistrationPayment(tx, payment.registrationId, payment.amountCents, deps.now) : null;
    return { payment, registration };
  });
  if (!won) return current(deps, row);
  console.info(`[payments] payment ${won.payment.id}: paid`);
  if (won.registration) await deps.changed?.({ kind: "seats", course: won.registration.course.slug });
  deps.later(async () => {
    const ctx = await paymentContext(deps.db, won.payment.id);
    if (won.registration) await mailRegistrationPaid(deps, won.payment, won.registration);
    await tellMaria(deps, won.payment, ctx, outcomeOf(won));
  });
  return won.payment;
}

/** What the payment did, for Maria's notice. */
function outcomeOf(won: Won): Pick<PaymentNotice, "outcome" | "restCents"> {
  const r = won.registration;
  if (!r) return { outcome: "received" };
  if (r.full) return { outcome: "full" };
  if (r.registration.status !== "confirmed") return { outcome: "received" };
  const total = registrationPrice(r.course, r.registration.kind);
  return { outcome: "confirmed", restCents: total === null ? 0 : Math.max(0, total - r.registration.paidCents) };
}

async function held(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  const [payment] = await deps.db
    .update(payments)
    .set({ status: "held", updatedAt: deps.now, providerUuid: sql`coalesce(${facts.uuid || null}, ${payments.providerUuid})`, method: facts.method, bank: facts.bank })
    .where(and(eq(payments.id, row.id), inArray(payments.status, ["pending", "failed"]), isNull(payments.paidAt)))
    .returning();
  if (!payment) return current(deps, row);
  alert(deps, payment, "held", facts);
  return payment;
}

async function failed(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  if (row.status === "paid") {
    if (facts.rawStatus !== "VOIDED") return row; // paid is a floor
    const [voided] = await deps.db.update(payments).set({ status: "failed", updatedAt: deps.now }).where(and(eq(payments.id, row.id), eq(payments.status, "paid"))).returning();
    if (!voided) return current(deps, row);
    alert(deps, voided, "voided", facts);
    return voided;
  }
  const done = await failPayment(deps.db, row.id, deps.now);
  if (!done) return current(deps, row);
  console.info(`[payments] payment ${row.id}: failed`);
  if (done.released) {
    const ctx = await paymentContext(deps.db, row.id);
    if (ctx.course) await deps.changed?.({ kind: "seats", course: ctx.course.slug });
  }
  return done.payment;
}

async function refunded(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  const [payment] = await deps.db.update(payments).set({ status: "refunded", updatedAt: deps.now }).where(and(eq(payments.id, row.id), ne(payments.status, "refunded"))).returning();
  if (!payment) return current(deps, row);
  alert(deps, payment, "refunded", facts);
  return payment;
}

/** The course's Estonian title for Maria ("—" when the course is gone). */
const courseName = (ctx: PaymentContext): string => (ctx.course ? pick(ctx.course.title, "et") : "—");

/** Maria's "Kontrolli Montonios", after the response. */
function alert(deps: SettleDeps, p: Payment, kind: "held" | "voided" | "refunded", facts: Facts): void {
  logNote(`[payments] payment ${p.id}: ${kind}, Maria is alerted`);
  deps.later(async () => {
    const ctx = await paymentContext(deps.db, p.id);
    const s = paymentAlertSummary(
      { alert: kind, kind: p.kind, name: p.name, email: p.email, amountCents: p.amountCents, course: courseName(ctx), startsAt: ctx.session?.startsAt ?? null, reference: p.reference, providerUuid: p.providerUuid, rawStatus: facts.rawStatus, paidCents: facts.amountCents, currency: facts.currency },
      adminUrl(deps.siteUrl),
    );
    await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: p.email, siteUrl: deps.siteUrl });
  });
}

/** Maria's "Uus makse: …" (mail and Telegram). */
async function tellMaria(deps: SettleDeps, p: Payment, ctx: PaymentContext, outcome: Pick<PaymentNotice, "outcome" | "restCents">): Promise<void> {
  const s = paymentSummary(
    { kind: p.kind, name: p.name, email: p.email, amountCents: p.amountCents, course: courseName(ctx), startsAt: ctx.session?.startsAt ?? null, method: p.method, bank: p.bank, reference: p.reference, providerUuid: p.providerUuid, ...outcome },
    adminUrl(deps.siteUrl),
  );
  const r = await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: p.email, siteUrl: deps.siteUrl });
  console.info(`[payments] payment ${p.id}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
}

/** The payer's mail after a paid registration: never to a sample address, not counted in the daily caps (it follows a real payment). */
async function mailRegistrationPaid(deps: SettleDeps, p: Payment, r: RegistrationPaid): Promise<void> {
  if (isSampleAddress(p.email) || !mailConfigured(deps.env)) return;
  try {
    const total = registrationPrice(r.course, r.registration.kind);
    const sent = await sendMail(
      deps.env,
      registrationPaidMail({
        siteUrl: deps.siteUrl,
        email: p.email,
        name: p.name,
        locale: p.locale,
        course: r.course.title,
        session: r.session ? { startsAt: r.session.startsAt, city: r.session.city, venue: r.session.venue } : null,
        paidCents: p.amountCents,
        restCents: total === null ? 0 : Math.max(0, total - r.registration.paidCents),
        confirmed: r.registration.status === "confirmed",
        full: r.full,
      }),
    );
    console.info(`[payments] payment ${p.id}: the payer's mail sent: ${sent}`);
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the payer's mail failed`, e);
  }
}
```

- [ ] **Step 15: Run** `npx vitest run tests/db/payments-settle.test.ts` — expect PASS.

- [ ] **Step 16: The webhook.**
  1. **Write the failing route tests** `tests/db/payments-notify.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { signHs256 } from "@/server/payments/jwt";
import { handleNotify, MAX_NOTIFY_BODY } from "@/server/payments/routes";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, SITE, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// POST /api/payments/notify, Montonio's webhook (phase 2b, spec 4, 7.4): 400 only for a token it cannot verify, 200 for everything it
// understands (an unknown reference and a refund webhook too), 503 when the database fails or a token in doubt cannot be confirmed (Montonio
// retries 13 times over 48 hours). 404 without payments. The body is at most 8 KB.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (body: unknown) => new Request(`${SITE}/api/payments/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const answer = async (res: Response) => [res.status, await res.json(), res.headers.get("cache-control")];

test("without payments: 404", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ orderToken: "x" }), { ...deps, montonio: null }))).toEqual([404, { ok: false }, "no-store"]);
});

test("a token it cannot verify is 400: none, not JSON, another secret, alg none, no merchantReference, a body over 8 KB", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"merchantReference":"MSLAB-M1","paymentStatus":"PAID"}').toString("base64url")}.`;
  for (const body of [{}, "not json", { orderToken: 42 }, { orderToken: "a.b.c" }, { orderToken: none },
    { orderToken: orderToken({ reference: "MSLAB-M1", amountCents: 100, providerUuid: "u" }, {}, { secret: "another-secret-0123456789abcdef" }) },
    { orderToken: signHs256({ paymentStatus: "PAID" }, TEST_MONTONIO.secretKey, { expiresInSeconds: 600 }) },
    { orderToken: "x".repeat(MAX_NOTIFY_BODY + 1) }])
    expect((await handleNotify(post(body), deps)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
});

test("a refund webhook ({ refundToken }) is understood and not used: 200", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ refundToken: "anything" }), deps))).toEqual([200, { ok: true }, "no-store"]);
});

test("a good token: 200 and settled; again: 200 and nothing new; an unknown reference: 200", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ orderToken: orderToken(p) }), deps))).toEqual([200, { ok: true }, "no-store"]);
  expect((await handleNotify(post({ orderToken: orderToken(p) }), deps)).status).toBe(200);
  await flush();
  expect(m.mails()).toHaveLength(2); // her mail and Maria's, once
  expect((await handleNotify(post({ orderToken: orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "u" }) }), deps)).status).toBe(200);
});

test("a token in doubt that Montonio cannot confirm: 503 (Montonio retries)", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ orderToken: orderToken(p, { accessKey: "someone-else" }) }), deps))).toEqual([503, { ok: false }, "no-store"]);
});

test("a database failure: 503, logged without details", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = { select: () => { throw Object.assign(new Error("connect ECONNREFUSED db.example.com"), { code: "ECONNREFUSED" }); } } as unknown as Db;
  const res = await handleNotify(post({ orderToken: orderToken({ reference: "MSLAB-M1", amountCents: 100, providerUuid: "u" }) }), { ...deps, db: broken });
  expect(res.status).toBe(503);
  expect(log.mock.calls.map((c) => c[0])).toEqual(["[payments] webhook: not settled: Error (code ECONNREFUSED)"]);
});
```

  2. **Run it — expect FAIL** (`@/server/payments/routes` does not exist).
  3. Create `src/server/payments/routes.ts`:

```ts
import { logFailure, logNote } from "../log";
import { JwtError } from "./jwt";
import type { Montonio, OrderToken } from "./montonio";
import { settleToken, type SettleDeps } from "./settle";

// Montonio's two ways back to the app (phase 2b, spec 6.5, 7.4), without Next.js: app/api/payments/notify/route.ts (and, from Task 6,
// return/route.ts) build the dependencies; the tests call these with PGlite and a stubbed Montonio. Without payments both are 404.

export type PaymentRouteDeps = Omit<SettleDeps, "montonio"> & { montonio: Montonio | null };

/** Montonio's webhook bodies are a few hundred bytes (spec 10: at most 8 KB). */
export const MAX_NOTIFY_BODY = 8 * 1024;

const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The body's `orderToken` and whether it is a refund webhook ({ refundToken }); null for a body over the limit or not JSON. */
async function readNotification(request: Request): Promise<{ orderToken: string; refund: boolean } | null> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_NOTIFY_BODY) return null;
  try {
    const raw = await request.text();
    if (raw.length > MAX_NOTIFY_BODY) return null;
    const body = JSON.parse(raw) as { orderToken?: unknown; refundToken?: unknown } | null;
    return { orderToken: typeof body?.orderToken === "string" ? body.orderToken : "", refund: typeof body?.refundToken === "string" };
  } catch {
    return null;
  }
}

/**
 * POST /api/payments/notify `{ orderToken }`: Montonio's webhook, sent on every status change and retried 13 times over 48 hours unless the
 * answer is 200/201. 400 only for a token that cannot be verified (or a body that is none); 200 for everything understood — a settled
 * payment, one settled before, an unknown reference (logged), a refund webhook ({ refundToken }: REFUNDED also comes as the order's own
 * status, so it is not read); 503 when the database fails or a token in doubt cannot be confirmed with Montonio. No token, no address is
 * logged. 404 without payments.
 */
export async function handleNotify(request: Request, deps: PaymentRouteDeps): Promise<Response> {
  const montonio = deps.montonio;
  if (!montonio) return json(404, { ok: false });
  const body = await readNotification(request);
  if (body?.refund && !body.orderToken) return json(200, { ok: true });
  let token: OrderToken;
  try {
    token = montonio.verifyOrderToken(body?.orderToken ?? "");
  } catch (e) {
    logNote(`[payments] webhook: a token that cannot be verified (${e instanceof JwtError ? e.code : "error"})`);
    return json(400, { ok: false });
  }
  try {
    const result = await settleToken({ ...deps, montonio }, token);
    return result.kind === "unconfirmed" ? json(503, { ok: false }) : json(200, { ok: true });
  } catch (e) {
    logFailure("[payments] webhook: not settled", e);
    return json(503, { ok: false });
  }
}
```

  4. Create `src/app/api/payments/notify/route.ts`:

```ts
import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { paymentProvider } from "@/server/payments/montonio";
import { handleNotify } from "@/server/payments/routes";
import { revalidatePublic } from "@/server/public-cache";

export const dynamic = "force-dynamic";
/** A token in doubt asks Montonio (15 s at most): the function must not hang for the plan's default 300 s. */
export const maxDuration = 30;

/**
 * POST /api/payments/notify — Montonio's webhook (server/payments/routes.ts handleNotify). POST only (any other method is Next.js's 405); it
 * goes through the coming-soon gate (lib/site-gate.ts) and is never redirected (an /api address: lib/site-routing.ts). The mail links use
 * SITE_URL: the request comes from Montonio, not from a visitor. A missing setting is a 503, so Montonio tries again.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const env = { ...serverEnv(), KV: serverKv() };
    return await handleNotify(request, {
      db: getDb(),
      env,
      now: new Date(),
      siteUrl: env.SITE_URL,
      later: (task) => after(() => task().catch((e) => logFailure("[payments] background task failed", e))),
      changed: revalidatePublic,
      montonio: paymentProvider(),
    });
  } catch (e) {
    logFailure("[payments] webhook failed", e);
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
```

  5. Run `npx vitest run tests/db/payments-notify.test.ts` — expect PASS.

- [ ] **Step 17: Through the gate, never redirected.**
  1. **`tests/unit/site-gate.test.ts`.** Add `"/api/payments/notify", // Montonio's webhook (phase 2b)` to `THROUGH`, and to `GATED`: `"/api/payments", "/api/payments/notify/", "/api/payments/notifyx", "/api/payments/notify/x", "/api/payments/return",`. In the test "the method never opens the gate … and never closes it", add `"/api/payments/notify"` to the second list (the addresses that pass for every method).
  2. **`tests/unit/site-routing.test.ts`.** In "redirects, the hub, the API and everything served as it is", add:

```ts
    // Montonio's webhook is answered at its own path, with or without a trailing slash: a POST is never redirected (phase 2b, spec 10)
    for (const p of ["/api/payments/notify", "/api/payments/notify/"]) expect(route(p), p).toEqual({ kind: "api" });
```

  3. Run `npx vitest run tests/unit/site-gate.test.ts tests/unit/site-routing.test.ts` — the gate test FAILS (`/api/payments/notify` is gated).
  4. **`src/lib/site-gate.ts`.** `THROUGH` becomes:

```ts
const THROUGH = new RegExp(`^\\/(admin(\\/|$)|api\\/(auth|admin|cron|newsletter)(\\/|$)|api\\/bunny\\/webhook$|api\\/payments\\/notify$|_next\\/|media(\\/|$)|${ROOT_FILE_SOURCE})`);
```

     and in its doc comment, after "Vercel's daily cron, Bunny's webhook,", add "Montonio's webhook (api/payments/notify, phase 2b: it must reach the app while the site is gated),".
  5. Run the two tests again — PASS. Update the middleware's note in `src/middleware.ts` (`logNote("[gate] SITE_GATE is on … only /admin, /api/auth, /api/admin, /api/cron, /api/bunny/webhook, …`): add `/api/payments/notify` after `/api/bunny/webhook`.
  6. **The gate's own run.** In `playwright.gate.config.ts`'s `webServer.env`, after `TELEGRAM_BOT_TOKEN: ""`, add `PAYMENT_MOCK_IN_PRODUCTION: "1", // payments on (the fake Montonio's keys of LOCAL_ENV): the payment routes answer as the app's, not 404` and in the file's top comment add "Payments are on with the e2e run's made-up Montonio keys (no fake server is started: the gate tests never create an order)." Then append to `tests/e2e/gate.spec.ts`, inside `test.describe("a visitor", …)`:

```ts
  test("Montonio's webhook goes through: a POST is answered by the app (400 for a token it cannot verify), not the gate, and is never redirected (phase 2b)", async ({ request }) => {
    const res = await request.post("/api/payments/notify", { data: { orderToken: "not-a-token" }, maxRedirects: 0 });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ ok: false });
  });
```

- [ ] **Step 18: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - `npx playwright test -c playwright.gate.config.ts` — green, the new case included.

- [ ] **Step 19: Commit.**

```bash
git add app/src/domain/payments.ts app/src/db/queries/payments.ts app/src/db/queries/admin.ts app/src/server/payments app/src/server/messages.ts app/src/server/account-mail.ts app/src/i18n/dict/et.ts app/src/i18n/dict/ru.ts app/src/app/api/payments app/src/lib/site-gate.ts app/src/middleware.ts app/playwright.gate.config.ts app/tests
git commit -m "feat(payments): settlePayment, the one door — Montonio's webhook, held and voided alerts, the paid mail and Maria's notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: "Registreeru" starts the prepayment — the hold, the order, the redirect; "Maksa" in the confirmation mail

Spec sections 6.1 (D1, D2, D6) and 7.2. `handleRegistration` runs as today and then starts the prepayment: a 30-minute hold, a `payments` row (`prepayment`, `prepaymentDue`), Montonio's order, and `{ ok: true, paymentUrl }`; the form sends the browser there. Without keys, or when Montonio says no, the registration stands, the answer is today's, the row is `failed` and its hold ends (Task 3's `failPayment`). The confirmation mail gets "Maksa {summa}" (`/maksa/<pay_token>`) with the IBAN block under "või tasu pangaülekandega".

**The one-button rule in the mail.** The confirmation mail had one button, "Ava minu konto". With "Maksa {summa}" as the pay section's button, "Ava minu konto" becomes a small text link under it (one primary button). A mail that carries a login code keeps its code and "Logi sisse" as today: that block is the login's own (see the owner's questions).

**A retry re-sends an open attempt, never a second order (the pre-flight's double-payment fix; Global Constraints).** `startRegistrationPayment` first looks for the live attempt of what is due: a `pending` row of the same registration and kind with the same amount, whose order is younger than Montonio's 30-minute window (`updated_at` is its insert or its last re-send). When there is one, it is re-sent: its window starts again (`updated_at` = now, and a prepayment's hold is refreshed as for a new one), `POST /orders` goes out again with the same `merchantReference` (Montonio overwrites the unpaid order and answers a new `paymentUrl`), and the row takes the uuid Montonio answers (a token of the replaced order is Task 3's doubt case). A re-send is no new attempt: it is not counted in `STARTS_PER_HOUR` (the per-IP limit of the page and the API still counts it). Only without a live attempt, or for another amount or kind, is a new row made. When the re-send fails, the row fails as a new one would (`failPayment`; a late PAID of it still settles: paid is reachable from failed). Task 7 does the same for an e-course: the same course and address.

**Rule of the amount due (`domain/payments.ts amountDue`, spec 6.3).** Not confirmed: `prepaymentDue − paidCents`, while the session has not begun. Confirmed: `price − paidCents` (the rest), until the training day (the start of its day in Tallinn, D5: paying on the day is Maria's, by hand). Cancelled, a cancelled session, no price or no session (an individual registration, §11): nothing.

**Files:**
- Modify: `app/src/domain/payments.ts` (`amountDue`)
- Create: `app/src/server/payments/start.ts`
- Create: `app/src/lib/navigate.ts`
- Modify: `app/src/server/submit.ts`, `app/src/server/actions/public.ts`, `app/src/server/account-mail.ts`, `app/src/components/site/ContactRegister.tsx`
- Test: `app/tests/unit/payments-due.test.ts`, `app/tests/db/payments-start.test.ts` (new); `app/tests/unit/account-mail.test.ts` (extend)
- E2E: `app/tests/e2e/fixtures.ts` (the payment rows of the test addresses), `app/tests/e2e/course.spec.ts`, `app/tests/e2e/cache.spec.ts`

**Interfaces:**
- Consumes: `holdUntil`, `SEAT_HOLD_MS` (Task 1); `hasFreeSeat` (Task 1); `insertPayment`, `attachOrder`, `failPayment` (Task 3); `Montonio`, `MontonioError` (Task 2); `payment.pay`, `payment.transfer` (Task 3's dictionary).
- Produces, from `src/domain/payments.ts`: `type DueInput = { status: RegStatus; paymentChoice: "full" | "half"; priceCents: number | null; paidCents: number; startsAt: Date | null; sessionCancelled: boolean }`; `type Due = { kind: "prepayment" | "balance"; cents: number } | { kind: "none" }`; `amountDue(r: DueInput, now: Date): Due`.
- Produces, from `src/server/payments/start.ts`:
  - `type StartDeps = { db: Db; now: Date; siteUrl: string; montonio: Montonio | null }`;
  - `type StartResult = { kind: "started"; paymentUrl: string } | { kind: "off" } | { kind: "failed" } | { kind: "nothing" } | { kind: "full" } | { kind: "rate" } | { kind: "notFound" }`;
  - `STARTS_PER_HOUR = 5`; `paymentUrls(siteUrl: string): { returnUrl: string; notificationUrl: string }`;
  - `startRegistrationPayment(deps: StartDeps, target: { registrationId: number; clientId?: number } | { payToken: string }): Promise<StartResult>`;
  - private to the file (Task 7 uses them): `liveAttempt(q: Q, of: { registrationId: number; kind: "prepayment" | "balance" } | { courseId: number; email: string }, amountCents: number, now: Date): Promise<Payment | null>` and `order(deps, payment, again = false)` (`again`: a re-send of a live attempt).
- Produces, from `src/server/submit.ts`: `ActionResult = { ok: true; paymentUrl?: string } | { ok: false; errors: Record<string, string> }`; `Deps.montonio?: Montonio | null`.
- Produces, from `src/server/account-mail.ts`: `payLinkUrl(siteUrl: string, payToken: string): string`; `RegistrationConfirmationInput.payLink?: string | null`.
- Produces, from `src/lib/navigate.ts`: `navigate(url: string): void` (a full page load to Montonio's page; the DOM tests mock it).
- Produces, for the e2e run (`tests/e2e/fixtures.ts`): `storedPayments(email: string): Promise<{ kind: string; status: string; amountCents: number }[]>`; `storedHold(email: string): Promise<boolean>` (a live hold).

- [ ] **Step 1: Write the failing rule test** `tests/unit/payments-due.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { amountDue, type DueInput } from "@/domain/payments";

// What a registration can pay online now (phase 2b, spec 6.3, D5): the prepayment still due while it is not confirmed and the session has not
// begun; the rest once it is confirmed, until the training day (in Tallinn); nothing for a cancelled one, a called-off session, no price or no
// session (an individual registration: Maria sends an invoice, spec 11).

const NOW = new Date("2026-10-09T10:00:00Z");
// 14.11.2026 at 10:00 in Tallinn (UTC+2 in November): the training day starts at 2026-11-13T22:00:00Z
const START = new Date("2026-11-14T08:00:00Z");
const base: DueInput = { status: "awaiting_prepayment", paymentChoice: "half", priceCents: 35000, paidCents: 0, startsAt: START, sessionCancelled: false };
const due = (over: Partial<DueInput>, now = NOW) => amountDue({ ...base, ...over }, now);

describe("amountDue", () => {
  test("not confirmed: the prepayment minus what is paid (half 175 €, full 350 €); paid enough: nothing", () => {
    expect(due({})).toEqual({ kind: "prepayment", cents: 17500 });
    expect(due({ paymentChoice: "full" })).toEqual({ kind: "prepayment", cents: 35000 });
    expect(due({ paidCents: 10000 })).toEqual({ kind: "prepayment", cents: 7500 });
    expect(due({ paidCents: 17500 })).toEqual({ kind: "none" });
    expect(due({ priceCents: 35001 })).toEqual({ kind: "prepayment", cents: 17501 }); // ceil(price / 2)
  });

  test("confirmed: the rest; fully paid: nothing", () => {
    expect(due({ status: "confirmed", paidCents: 17500 })).toEqual({ kind: "balance", cents: 17500 });
    expect(due({ status: "confirmed", paidCents: 35000 })).toEqual({ kind: "none" });
  });

  test("cancelled, a called-off session, no price, no session: nothing", () => {
    for (const over of [{ status: "cancelled" as const }, { sessionCancelled: true }, { priceCents: null }, { startsAt: null }]) expect(due(over), JSON.stringify(over)).toEqual({ kind: "none" });
  });

  test("the prepayment until the session begins; the rest until its day begins in Tallinn", () => {
    expect(due({}, new Date(START.getTime() - 1))).toEqual({ kind: "prepayment", cents: 17500 });
    expect(due({}, START)).toEqual({ kind: "none" });
    const rest = { status: "confirmed" as const, paidCents: 17500 };
    expect(due(rest, new Date("2026-11-13T21:59:59Z"))).toEqual({ kind: "balance", cents: 17500 });
    expect(due(rest, new Date("2026-11-13T22:00:00Z"))).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/unit/payments-due.test.ts`.

- [ ] **Step 3: Add to `src/domain/payments.ts`:**

```ts
import { startOfDayTallinn, upcomingFrom } from "./calendar";
import { prepaymentDue, type RegStatus } from "./registration";

/** What amountDue reads of a registration: its status and payment choice, its price and what is paid, and its session. */
export type DueInput = {
  status: RegStatus;
  paymentChoice: "full" | "half";
  /** The registration's price (domain/registration.ts registrationPrice), cents; null without one. */
  priceCents: number | null;
  paidCents: number;
  /** The session's start; null for a registration without one (an individual course). */
  startsAt: Date | null;
  sessionCancelled: boolean;
};

/** What can be paid online now: the prepayment still due, or the rest after it (cents), or nothing. */
export type Due = { kind: "prepayment" | "balance"; cents: number } | { kind: "none" };

const NONE: Due = { kind: "none" };

/**
 * The amount a registration can pay online now (phase 2b, spec 6.3, D5). Not confirmed: the prepayment (domain/registration.ts
 * prepaymentDue) minus what is paid, while the session has not begun (calendar.ts upcomingFrom, the booking's own "upcoming"). Confirmed:
 * the price minus what is paid, until the training day begins in Tallinn (paying on the day is Maria's, by hand). Nothing for a cancelled
 * registration, a called-off session, no price or no session. The /maksa page, Minu koolitused and the start itself all ask this.
 */
export function amountDue(r: DueInput, now: Date): Due {
  if (r.status === "cancelled" || r.sessionCancelled || r.priceCents === null || r.startsAt === null) return NONE;
  if (r.status === "awaiting_prepayment") {
    const cents = prepaymentDue(r.priceCents, r.paymentChoice) - r.paidCents;
    return cents > 0 && r.startsAt >= upcomingFrom(now) ? { kind: "prepayment", cents } : NONE;
  }
  const cents = r.priceCents - r.paidCents;
  return cents > 0 && now < startOfDayTallinn(r.startsAt) ? { kind: "balance", cents } : NONE;
}
```

  (The two imports go at the top of the file, above the existing reference constants.)

- [ ] **Step 4: Run** `npx vitest run tests/unit/payments-due.test.ts` — expect PASS.

- [ ] **Step 5: Write the failing confirmation-mail tests** — append to `tests/unit/account-mail.test.ts` (add `payLinkUrl` to its `@/server/account-mail` import):

```ts
describe("registration confirmation with online payments (phase 2b)", () => {
  const LINK = `${BASE}/maksa/${TOKEN}`;
  test("payLinkUrl: the registration's own page, /maksa/<pay_token>", () => {
    expect(payLinkUrl(`${BASE}/`, TOKEN)).toBe(LINK);
  });

  test("'Maksa 195 €' is the one button, then 'või tasu pangaülekandega' and the transfer rows; 'Ava minu konto' becomes a text link", () => {
    const mail = registrationConfirmationMail(registration({ payLink: LINK }));
    expect(mail.text).toContain(["Koha kinnitamiseks tasu ettemaks 195 €.", "", `Maksa 195 €: ${LINK}`, "", "või tasu pangaülekandega", "", "Saaja: MS LAB Koolituskeskus OÜ"].join("\n"));
    expect(mail.text).toContain("Selgitus: MSLAB-42");
    expect(mail.text).toContain("Ava minu konto:");
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${esc(LINK)}"`);
    expect(mail.html).toMatch(/<a href="[^"]*konto\/sisene#email=[^"]*" style="color:#222222;text-decoration:underline;">Ava minu konto<\/a>/);
  });

  test("without the transfer instructions: the button alone (no 'Maria saadab sulle arve'); paid enough: today's mail", () => {
    const noIban = registrationConfirmationMail(registration({ payLink: LINK, prepayment: null }));
    expect(noIban.text).toContain(`Maksa 195 €: ${LINK}`);
    expect(noIban.text).not.toContain("või tasu pangaülekandega");
    expect(noIban.text).not.toContain(getDict("et").account.next.invoice);
    expect(registrationConfirmationMail(registration({ payLink: LINK, priceCents: null })).text).not.toContain("Maksa");
  });

  test("with a login code the code block stays as it is (its own 'Logi sisse')", () => {
    const mail = registrationConfirmationMail(registration({ payLink: LINK, login: { token: TOKEN, code: "123456" } }));
    expect(buttons(mail.html!)).toBe(2);
    expect(mail.text).toContain("123456");
  });

  test("Russian", () => {
    const mail = registrationConfirmationMail(registration({ locale: "ru", payLink: LINK }));
    expect(mail.text).toContain(`Оплатить 195 €: ${LINK}`);
    expect(mail.text).toContain("или оплатите банковским переводом");
  });

  test("without payments (no payLink) the mail is today's", () => {
    expect(registrationConfirmationMail(registration({ payLink: null }))).toEqual(registrationConfirmationMail(registration()));
  });
});
```

- [ ] **Step 6: Run it — expect FAIL**: `npx vitest run tests/unit/account-mail.test.ts` (`payLinkUrl` does not exist).

- [ ] **Step 7: The mail** (`src/server/account-mail.ts`).
  1. After `accountLink`, add:

```ts
/** The "Maksa" link of a registration (phase 2b, spec 6.3): its own page, /maksa/<pay_token>, which shows the amount and starts the payment with a button. */
export const payLinkUrl = (siteUrl: string, payToken: string): string => `${siteUrl.replace(/\/+$/, "")}/maksa/${encodeURIComponent(payToken)}`;
```

  2. `type Section` becomes:

```ts
/** What the layout shows, in the order of the page: the lead, the course box, then paragraphs, rows of fields and (phase 2b) a pay button. */
type Section = { text: string } | { fields: [label: string, value: string][] } | { button: { href: string; label: string } };
```

  3. In `confirmationText`'s loop:

```ts
  for (const section of c.sections) {
    if ("text" in section) lines.push(section.text, "");
    else if ("button" in section) lines.push(`${section.button.label}: ${section.button.href}`, "");
    else lines.push(...section.fields.map(([label, value]) => `${label}: ${value}`), "");
  }
```

  4. In `confirmationHtml`, the sections' loop becomes:

```ts
  for (const section of c.sections) {
    if ("text" in section) rows.push(paragraphRow(section.text));
    else if ("button" in section) rows.push(buttonRow(section.button.href, section.button.label));
    else
      rows.push(
        boxRow(
          section.fields
            .map(
              ([label, value], i) =>
                `<div style="${textStyle(13, i ? "padding-top:8px;" : "")}">${esc(label)}</div><div style="font:600 16px/1.4 ${FONT};color:${INK};word-break:break-word;">${esc(value)}</div>`,
            )
            .join(""),
          12,
        ),
      );
  }
```

     and the account part at the end becomes:

```ts
  // One button: "Ava minu konto", or with a live login the code and "Logi sisse" (and the link written out, as in the login e-mail),
  // the 30 minutes, the ignore line, and a small text link (no button) to type the code on the login page if the button fails. When the
  // mail has a pay button (phase 2b), "Ava minu konto" is a text link under it: the mail keeps one primary button.
  const payButton = c.sections.some((s) => "button" in s);
  if (c.login)
    rows.push(
      paragraphRow(mail.codeIntro, 24),
      codeRow(c.login.code),
      buttonRow(links.main, mail.button),
      linkRow(links.main),
      row(`padding:24px 28px 0;${textStyle(14)}`, esc(mail.valid)),
      row(`padding:4px 28px 0;${textStyle(14)}`, esc(mail.ignore)),
      row(`padding:12px 28px 0;${textStyle(14)}`, `${esc(mail.confirm.codeHere)} <a href="${esc(links.code)}" style="color:${INK};text-decoration:underline;">${esc(mail.confirm.codeLink)}</a>`),
    );
  else if (payButton) rows.push(row(`padding:20px 28px 0;text-align:center;${textStyle(14)}`, `<a href="${esc(links.main)}" style="color:${INK};text-decoration:underline;">${esc(mail.confirm.open)}</a>`));
  else rows.push(buttonRow(links.main, mail.confirm.open));
```

  5. `RegistrationConfirmationInput` gains, after `prepayment`:

```ts
  /** The registration's "Maksa" link (payLinkUrl) when online payments are on (phase 2b); null or absent: today's mail. */
  payLink?: string | null;
```

  6. In `registrationConfirmationMail`, replace the block from `const pay = …` to the end of the `if (pay) … else …` with:

```ts
  const transfer = hasPrepayment(input.prepayment) && due > 0 ? input.prepayment : null;
  const sections: Section[] = [];
  const amount = formatEUR(due, input.locale);
  const transferRows = (pay: PrepaymentInfo): Section => {
    const labels = dict.account.dashboard.payment;
    return {
      fields: ([
        [labels.receiver, pay.receiver],
        [labels.iban, groupIban(pay.iban)],
        [labels.bank, pay.bank],
        [labels.amount, amount],
        [labels.reference, paymentReference(pay, input.registrationId)],
      ] as [string, string][]).filter(([, value]) => value.trim() !== ""),
    };
  };
  if (input.payLink && due > 0) {
    // phase 2b (spec 6.1.4): "Maksa {summa}" first, the bank transfer as the second way under it (D6)
    sections.push({ text: fill(dict.account.next.pay, { amount }) }, { button: { href: input.payLink, label: fill(dict.payment.pay, { amount }) } });
    if (transfer) sections.push({ text: dict.payment.transfer }, transferRows(transfer));
  } else if (transfer) {
    sections.push({ text: fill(dict.account.next.pay, { amount }) }, transferRows(transfer));
  } else {
    sections.push({ text: dict.account.next.invoice });
  }
```

     (`sections.push({ text: dict.course.confirmAfterPrepayment });` and the `return confirmationMail(…)` stay.) Update the function's doc comment: "… the next step (the prepayment amount with "Maksa {summa}" when online payments are on, and where to pay it by transfer, or "Maria saadab sulle arve …") and one button."
- [ ] **Step 8: Run** `npx vitest run tests/unit/account-mail.test.ts` — expect PASS.

- [ ] **Step 9: Write the failing start tests** `tests/db/payments-start.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations, settings } from "@/db/schema";
import type { PublicChange } from "@/server/cache-targets";
import type { Env } from "@/server/notify";
import { startRegistrationPayment, STARTS_PER_HOUR } from "@/server/payments/start";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { contactCourse, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// "Registreeru" starts the prepayment (phase 2b, spec 6.1): a 30-minute hold, a pending row MSLAB-M<id>, Montonio's order and { ok, paymentUrl }.
// Without payments, or with Montonio down, the registration stands and the answer is today's. startRegistrationPayment's own checks.

const NOW = new Date("2026-10-09T10:00:00Z");
const MIN = 60_000;
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deps(montonio: Deps["montonio"], opts: { mail?: boolean } = {}) {
  const tasks: (() => Promise<unknown>)[] = [];
  const changes: PublicChange[] = [];
  const env: Env = { KV: fakeKv({ "tg:chat": "42" }), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, ...(opts.mail ? { RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc" } : {}) };
  const d: Deps = { db, env, ip: "203.0.113.9", siteUrl: SITE, now: NOW, later: (t) => void tasks.push(t), changed: (c) => void changes.push(c), montonio };
  return { d, changes, flush: async () => { for (let t = tasks.shift(); t; t = tasks.shift()) await t(); } };
}

const form = (sessionId: number, over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ course: "kulmumeistri-baaskoolitus", session: String(sessionId), name: "Kati Tamm", email: "kati@example.com", phone: "+372 5555 0101", payment: "half", terms: "on", locale: "ru", ...over })) fd.set(k, v);
  return fd;
};
const rows = () => db.select().from(payments);
const reg = async () => (await db.select().from(registrations))[0];

describe("Registreeru with payments", () => {
  test("the hold for 30 minutes, a pending row MSLAB-M<id> of 175 €, Montonio's order for it, and the payment page in the answer", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { d, changes } = deps(m.montonio);
    const result = await handleRegistration(d, form(c.session.id));
    const [p] = await rows();
    expect(result).toEqual({ ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` });
    expect(p).toMatchObject({ reference: `MSLAB-M${p.id}`, kind: "prepayment", status: "pending", amountCents: 17500, email: "kati@example.com", name: "Kati Tamm", locale: "ru", courseId: c.course.id });
    const r = await reg();
    expect([p.registrationId, r.seatHoldUntil]).toEqual([r.id, new Date(NOW.getTime() + 30 * MIN)]);
    expect(m.state.orders).toEqual([expect.objectContaining({ merchantReference: p.reference, grandTotal: 175, locale: "ru", returnUrl: `${SITE}/api/payments/return`, notificationUrl: `${SITE}/api/payments/notify` })]);
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
  });

  test("Montonio down: the registration is stored, today's answer; the row is failed and holds nothing", async () => {
    const m = stubMontonio();
    m.state.down = true;
    const c = await contactCourse(db);
    const { d } = deps(m.montonio);
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    expect((await rows()).map((p) => p.status)).toEqual(["failed"]);
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test("without payments: today's behaviour — no row, no hold", async () => {
    const c = await contactCourse(db);
    const { d } = deps(null);
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test("the confirmation mail carries 'Maksa 175 €' (/maksa/<pay_token>) and, under it, the transfer; without payments today's mail", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await db.insert(settings).values({ key: "prepayment", value: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" } });
    const { d, flush } = deps(m.montonio, { mail: true });
    await handleRegistration(d, form(c.session.id, { locale: "et" }));
    await flush();
    const r = await reg();
    const mine = m.mails().find((x) => x.to === "kati@example.com")!;
    expect(mine.text).toContain(`Maksa 175 €: ${SITE}/maksa/${r.payToken}`);
    expect(mine.text).toContain("või tasu pangaülekandega");
    const off = deps(null, { mail: true });
    await db.delete(payments);
    await db.delete(registrations);
    await handleRegistration(off.d, form(c.session.id, { locale: "et", email: "teine@example.com" }));
    await off.flush();
    expect(m.mails().find((x) => x.to === "teine@example.com")!.text).not.toContain("Maksa");
  });
});

describe("startRegistrationPayment's checks", () => {
  const start = (montonio: Deps["montonio"], target: Parameters<typeof startRegistrationPayment>[1], now = NOW) => startRegistrationPayment({ db, now, siteUrl: SITE, montonio: montonio ?? null }, target);

  test("off without Montonio; notFound for another client's registration or an unknown token; nothing when enough is paid or it is cancelled", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    expect(await start(null, { registrationId: r.id })).toEqual({ kind: "off" });
    expect(await start(m.montonio, { registrationId: r.id, clientId: 999 })).toEqual({ kind: "notFound" });
    expect(await start(m.montonio, { payToken: "x".repeat(43) })).toEqual({ kind: "notFound" });
    const paid = await registrationOn(db, c, { email: "a@example.com", paidCents: 17500 });
    const cancelled = await registrationOn(db, c, { email: "b@example.com", status: "cancelled" });
    expect(await start(m.montonio, { registrationId: paid.id })).toEqual({ kind: "nothing" });
    expect(await start(m.montonio, { payToken: cancelled.payToken })).toEqual({ kind: "nothing" });
    expect(await rows()).toEqual([]);
  });

  test("a prepayment needs a free seat (the others' holds count, her own does not); the rest needs none and holds nothing", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    const hers = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 5 * MIN) });
    expect(await start(m.montonio, { registrationId: hers.id })).toMatchObject({ kind: "started" });
    const other = await registrationOn(db, c, { email: "teine@example.com" });
    expect(await start(m.montonio, { registrationId: other.id })).toEqual({ kind: "full" });
    // later her hold has ended: the other one may start, and takes the hold
    expect(await start(m.montonio, { registrationId: other.id }, new Date(NOW.getTime() + 31 * MIN))).toMatchObject({ kind: "started" });
    const confirmed = await registrationOn(db, c, { email: "kolmas@example.com", status: "confirmed", paidCents: 17500 });
    expect(await start(m.montonio, { registrationId: confirmed.id })).toMatchObject({ kind: "started" });
    const balance = (await rows()).find((p) => p.registrationId === confirmed.id)!;
    expect([balance.kind, balance.amountCents]).toEqual(["balance", 17500]);
    expect((await db.select().from(registrations).where(eq(registrations.id, confirmed.id)))[0].seatHoldUntil).toBeNull();
  });

  test(`at most ${STARTS_PER_HOUR} new attempts a registration an hour; an hour later again`, async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    // each attempt ends unpaid before the next (Montonio's ABANDONED), so the next start is a new attempt, not a re-send of an open one
    const abandon = () => db.update(payments).set({ status: "failed" }).where(eq(payments.status, "pending"));
    for (let i = 0; i < STARTS_PER_HOUR; i++) {
      expect(await start(m.montonio, { payToken: r.payToken })).toMatchObject({ kind: "started" });
      await abandon();
    }
    expect(await start(m.montonio, { payToken: r.payToken })).toEqual({ kind: "rate" });
    expect(await start(m.montonio, { payToken: r.payToken }, new Date(NOW.getTime() + 61 * MIN))).toMatchObject({ kind: "started" });
    // every new attempt is a new order with a new reference
    expect(new Set(m.state.orders.map((o) => o.merchantReference)).size).toBe(STARTS_PER_HOUR + 1);
  });

  test("a retry while the attempt is open re-sends it — the same row and reference, Montonio's new uuid, the hold refreshed — never a second order to pay; after its window, or for another amount, a new attempt (the double-payment fix)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const ordered = () => db.select().from(payments).orderBy(payments.id);
    expect(await start(m.montonio, { payToken: r.payToken })).toMatchObject({ kind: "started" });
    const [first] = await ordered();
    // "Proovi uuesti" 20 minutes on, the first order still open: re-sent, not doubled (and not counted as a new attempt)
    const later = new Date(NOW.getTime() + 20 * MIN);
    for (let i = 0; i < STARTS_PER_HOUR + 1; i++) expect(await start(m.montonio, { payToken: r.payToken }, later)).toMatchObject({ kind: "started" });
    const [again, ...none] = await ordered();
    expect(none).toEqual([]);
    expect([again.id, again.reference, again.status, again.updatedAt]).toEqual([first.id, first.reference, "pending", later]);
    expect(again.providerUuid).not.toBe(first.providerUuid); // the stub answers every POST with a new uuid: the row follows the newest
    expect(new Set(m.state.orders.map((o) => o.merchantReference))).toEqual(new Set([first.reference]));
    expect((await reg()).seatHoldUntil).toEqual(new Date(later.getTime() + 30 * MIN));
    // 31 minutes after the last re-send its window is over: a new attempt with a new reference
    expect(await start(m.montonio, { payToken: r.payToken }, new Date(later.getTime() + 31 * MIN))).toMatchObject({ kind: "started" });
    // another amount (Maria recorded a transfer meanwhile): a new attempt too, even with an open one
    await db.update(registrations).set({ paidCents: 5000 }).where(eq(registrations.id, r.id));
    expect(await start(m.montonio, { payToken: r.payToken }, new Date(later.getTime() + 32 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.reference, p.amountCents])).toEqual([
      [first.reference, 17500],
      [`MSLAB-M${first.id + 1}`, 17500],
      [`MSLAB-M${first.id + 2}`, 12500],
    ]);
  });
});
```

- [ ] **Step 10: Run it — expect FAIL**: `npx vitest run tests/db/payments-start.test.ts`.

- [ ] **Step 11: Write `src/server/payments/start.ts`:**

```ts
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { attachOrder, failPayment, insertPayment } from "@/db/queries/payments";
import { hasFreeSeat } from "@/db/queries/seats";
import { courses, courseSessions, payments, registrations, type Payment } from "@/db/schema";
import { amountDue } from "@/domain/payments";
import { registrationPrice } from "@/domain/registration";
import { holdUntil, SEAT_HOLD_MS } from "@/domain/sessions";
import { logNote } from "../log";
import { MontonioError, type Montonio } from "./montonio";

// Every way an online payment starts (phase 2b, spec 6.1, 6.3, 6.4): a pending payment row (a new MSLAB-M<id> for each new attempt), then
// Montonio's order outside any transaction (a 15 s call must not hold a row lock), then the page to send the payer to. When Montonio says no
// or cannot be reached, the row is failed and a prepayment's hold ends (db/queries/payments.ts failPayment): nothing breaks, the registration
// stands. A start while the same attempt is still open (the same registration and kind, or the same e-course and address, the same amount,
// its order inside Montonio's 30-minute window) re-sends that attempt instead of making a second order (the double-payment rule): POST /orders
// with the same merchantReference overwrites the unpaid order at Montonio (spec 4), so the payer never has two orders open to pay.

export type StartDeps = { db: Db; now: Date; siteUrl: string; montonio: Montonio | null };

/**
 * started: send the payer to `paymentUrl`. off: no online payments. failed: Montonio said no or did not answer. nothing: nothing to pay now
 * (paid enough, cancelled, past, no price). full: an unconfirmed registration's session has no free seat (D2). rate: STARTS_PER_HOUR starts
 * of this registration in the last hour. notFound: no such registration (or not this client's).
 */
export type StartResult =
  | { kind: "started"; paymentUrl: string }
  | { kind: "off" }
  | { kind: "failed" }
  | { kind: "nothing" }
  | { kind: "full" }
  | { kind: "rate" }
  | { kind: "notFound" };

/**
 * New payment attempts of one registration per hour (spec 10): each one is an order at Montonio and, for a prepayment, a seat hold. A re-send
 * of the open attempt is not a new one (no new row, no second order): the per-IP limit of the /maksa page and the account API counts it.
 */
export const STARTS_PER_HOUR = 5;

/** Montonio's way back: the return (Task 6) and the webhook, on the site's address. */
export function paymentUrls(siteUrl: string): { returnUrl: string; notificationUrl: string } {
  const base = siteUrl.replace(/\/+$/, "");
  return { returnUrl: `${base}/api/payments/return`, notificationUrl: `${base}/api/payments/notify` };
}

/**
 * The open attempt of what is being paid now (the double-payment rule): the newest `pending` row of the same registration and kind — or the
 * same e-course and address — with this amount, whose order is still inside Montonio's 30-minute window (SEAT_HOLD_MS; `updated_at` is the
 * row's insert or its last re-send: nothing else touches a pending row). null: there is none, and the start is a new attempt.
 */
async function liveAttempt(
  q: Q,
  of: { registrationId: number; kind: "prepayment" | "balance" } | { courseId: number; email: string },
  amountCents: number,
  now: Date,
): Promise<Payment | null> {
  const which =
    "registrationId" in of
      ? and(eq(payments.registrationId, of.registrationId), eq(payments.kind, of.kind))
      : and(eq(payments.kind, "ecourse"), isNull(payments.registrationId), eq(payments.courseId, of.courseId), eq(payments.email, of.email));
  const [row] = await q
    .select()
    .from(payments)
    .where(and(which, eq(payments.status, "pending"), eq(payments.amountCents, amountCents), gt(payments.updatedAt, new Date(now.getTime() - SEAT_HOLD_MS))))
    .orderBy(desc(payments.id))
    .limit(1);
  return row ?? null;
}

/**
 * Montonio's order for a stored pending row; the row fails (and its hold ends) when there is none. `again`: the row is an open attempt sent
 * again (same reference): Montonio overwrites the unpaid order and may answer a new uuid, which the row takes (only while it is pending; a
 * token of the replaced order is settle.ts's doubt case).
 */
async function order(deps: StartDeps & { montonio: Montonio }, payment: Payment, again = false): Promise<StartResult> {
  try {
    const created = await deps.montonio.createOrder({ reference: payment.reference, amountCents: payment.amountCents, locale: payment.locale, ...paymentUrls(deps.siteUrl) });
    if (again)
      await deps.db.update(payments).set({ providerUuid: created.uuid, updatedAt: deps.now }).where(and(eq(payments.id, payment.id), eq(payments.status, "pending")));
    else await attachOrder(deps.db, payment.id, created.uuid, deps.now);
    console.info(`[payments] payment ${payment.id}: ${again ? "sent again" : "started"}`);
    return { kind: "started", paymentUrl: created.paymentUrl };
  } catch (e) {
    logNote(`[payments] payment ${payment.id}: no order (${e instanceof MontonioError ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : "error"})`);
    await failPayment(deps.db, payment.id, deps.now);
    return { kind: "failed" };
  }
}

/**
 * Starts the online payment of a registration (spec 6.1 "Registreeru", 6.3 /maksa and Minu koolitused): what is due now (domain/payments.ts
 * amountDue: the prepayment, or the rest after it), checked under the registration's lock. A prepayment needs a free seat — the others'
 * seats counted, confirmed or held, hers not — and holds it for 30 minutes from now (D2); the rest needs none and holds nothing. The open
 * attempt of the same amount, when there is one, is sent again instead of a new one (liveAttempt; not counted in STARTS_PER_HOUR). `target`:
 * the registration (with `clientId`: only when it is that client's) or its "Maksa" token.
 */
export async function startRegistrationPayment(deps: StartDeps, target: { registrationId: number; clientId?: number } | { payToken: string }): Promise<StartResult> {
  const montonio = deps.montonio;
  if (!montonio) return { kind: "off" };
  const which =
    "payToken" in target
      ? eq(registrations.payToken, target.payToken)
      : and(eq(registrations.id, target.registrationId), target.clientId === undefined ? undefined : eq(registrations.clientId, target.clientId));
  const ready = await deps.db.transaction(async (tx): Promise<StartResult | { kind: "ready"; payment: Payment; again: boolean }> => {
    const [row] = await tx
      .select({ registration: registrations, course: courses, session: courseSessions })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .where(which)
      .for("update", { of: registrations });
    if (!row) return { kind: "notFound" };
    const { registration: r, course, session } = row;
    const due = amountDue(
      { status: r.status, paymentChoice: r.paymentChoice, priceCents: registrationPrice(course, r.kind), paidCents: r.paidCents, startsAt: session?.startsAt ?? null, sessionCancelled: session?.status === "cancelled" },
      deps.now,
    );
    if (due.kind === "none") return { kind: "nothing" };
    // the open attempt of this amount is sent again, not doubled; it is no new attempt, so it is not counted here
    const live = await liveAttempt(tx, { registrationId: r.id, kind: due.kind }, due.cents, deps.now);
    if (!live) {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(payments)
        .where(and(eq(payments.registrationId, r.id), gt(payments.createdAt, new Date(deps.now.getTime() - 60 * 60_000))));
      if (Number(n) >= STARTS_PER_HOUR) return { kind: "rate" };
    }
    if (due.kind === "prepayment") {
      if (session && !(await hasFreeSeat(tx, session, deps.now, r.id))) return { kind: "full" };
      await tx.update(registrations).set({ seatHoldUntil: holdUntil(deps.now) }).where(eq(registrations.id, r.id));
    }
    if (live) {
      // its window starts again now (and a start at the same moment, waiting for this row lock, finds it open)
      await tx.update(payments).set({ updatedAt: deps.now }).where(eq(payments.id, live.id));
      return { kind: "ready", payment: { ...live, updatedAt: deps.now }, again: true };
    }
    const payment = await insertPayment(
      tx,
      { kind: due.kind, registrationId: r.id, courseId: course.id, clientId: r.clientId, email: r.email, name: r.name, locale: r.locale === "ru" ? "ru" : "et", amountCents: due.cents },
      deps.now,
    );
    return { kind: "ready", payment, again: false };
  });
  if (ready.kind !== "ready") return ready;
  return order({ ...deps, montonio }, ready.payment, ready.again);
}
```

- [ ] **Step 12: The registration starts it** (`src/server/submit.ts`).
  1. `ActionResult` becomes:

```ts
/** `paymentUrl` (phase 2b): a group registration's prepayment has started; the form sends the browser there. */
export type ActionResult = { ok: true; paymentUrl?: string } | { ok: false; errors: Record<string, string> };
```

  2. `Deps` gains, after `changed`:

```ts
  /** Online payments (phase 2b, server/payments/montonio.ts paymentProvider); absent or null: the forms of today. */
  montonio?: Montonio | null;
```

  3. Imports: `import type { Montonio } from "./payments/montonio";`, `import { startRegistrationPayment } from "./payments/start";`, and add `payLinkUrl` to the `./account-mail` import.
  4. In `handleRegistration`, replace the two lines from `const registration = await createRegistration(…)` to `await deps.changed?.(…)` with:

```ts
    const registration = await createRegistration(deps.db, { ...data, courseId: course.id, courseSessionId: session.id, kind: "group", preferredPeriod: "" });
    // Phase 2b (spec 6.1): the prepayment starts at once — a 30-minute hold, a payment row, Montonio's order. Without payments, or when it does
    // not start, the registration stands and the answer is today's ("Maksa" is offered later, in the mail and Minu koolitused). A failure here
    // never fails the stored registration: it is logged and the answer is today's.
    let paymentUrl: string | undefined;
    if (deps.montonio) {
      try {
        const started = await startRegistrationPayment({ db: deps.db, now: deps.now, siteUrl: deps.siteUrl, montonio: deps.montonio }, { registrationId: registration.id });
        if (started.kind === "started") paymentUrl = started.paymentUrl;
      } catch (e) {
        logFailure("[forms] register: the payment did not start", e);
      }
    }
    await deps.changed?.({ kind: "seats", course: course.slug });
```

  5. In the `registrationConfirmationMail({ … })` call, after `prepayment,` add `payLink: deps.montonio ? payLinkUrl(deps.siteUrl, registration.payToken) : null,`.
  6. The handler's `return` becomes `return { result: paymentUrl ? { ok: true, paymentUrl } : OK, notify: { ...summary, replyTo: data.email }, confirm, subscribe: wantsNewsletter ? { email: data.email, locale: data.locale } : undefined };` and its doc comment gains: "With online payments (phase 2b) the prepayment starts at once and the answer carries its page (`paymentUrl`)."
- [ ] **Step 13: The action and the form.**
  1. **`src/server/actions/public.ts`.** Import `paymentProvider` from `../payments/montonio`; in `run`'s deps add `montonio: paymentProvider(),` after `changed`, with the comment `// online payments (phase 2b): null without the keys, and the forms are today's`. In `registerContact`'s doc comment add: "With online payments the answer is `{ ok: true, paymentUrl }`: the prepayment has started (phase 2b)." And in the file's top comment, `Result: { ok: true } | …` becomes `Result: { ok: true, paymentUrl? } | …`.
  2. Create `src/lib/navigate.ts` (the card and the cart use it too, Tasks 5 and 7):

```ts
/**
 * Sends the browser to another site's page with a full page load, never through the client router (phase 2b: Montonio's payment page). One
 * function, so the DOM tests can stand in for it (vi.mock("@/lib/navigate")).
 */
export function navigate(url: string): void {
  window.location.assign(url);
}
```

  3. **`src/components/site/ContactRegister.tsx`.** Import `navigate` from `@/lib/navigate`. In the action, `if (result.ok) return { status: "sent", kind: k };` becomes:

```tsx
      if (result.ok) {
        // phase 2b (spec 6.1): the prepayment's page at Montonio (the bank or the card is chosen there); the answer shows meanwhile
        if (k === "group" && result.paymentUrl) navigate(result.paymentUrl);
        return { status: "sent", kind: k };
      }
```

     and in the component's doc comment, after "The form never confirms a place: …", add "With online payments the browser goes on to the prepayment's page (phase 2b)."
- [ ] **Step 14: Run** `npx vitest run tests/db/payments-start.test.ts tests/db/actions.test.ts tests/db/seats.test.ts` — expect PASS.

- [ ] **Step 15: The e2e run.** Every e2e registration now goes on to the fake Montonio's bank (`PAYMENT_PROVIDER=mock`, Task 2) and holds a seat for 30 minutes: the tests that register press "Katkesta" there, which ends the hold at once (the webhook), so no seat stays taken for the other tests.
  1. **`tests/e2e/fixtures.ts`.**
     - In `removeFormRows`, before the count, add `await sql\`delete from payments where email like ${TEST_EMAIL_PATTERN}\`;` and add `+ (select count(*) from payments where email like ${TEST_EMAIL_PATTERN})` to the sum.
     - In `removeClientRows`, before the count, add `await sql\`delete from payments where email like ${match}\`;` and add `+ (select count(*) from payments where email like ${match})` to the sum.
     - After `storedSubscriber`, add:

```ts
/** The online payments of one test address (phase 2b), oldest first. */
export async function storedPayments(email: string): Promise<{ kind: string; status: string; amountCents: number }[]> {
  const sql = connect(false);
  try {
    return await sql<{ kind: string; status: string; amountCents: number }[]>`select kind, status, amount_cents as "amountCents" from payments where email = ${email} order by id`;
  } finally {
    await sql.end();
  }
}

/** Does a registration of this test address hold a seat right now (a live seat_hold_until, phase 2b)? */
export async function storedHold(email: string): Promise<boolean> {
  const sql = connect(false);
  try {
    const [{ held }] = await sql<{ held: boolean }[]>`select exists (select 1 from registrations where email = ${email} and seat_hold_until > now()) as held`;
    return held;
  } finally {
    await sql.end();
  }
}
```

  2. **`tests/e2e/course.spec.ts`.** Import `storedHold, storedPayments` from `./fixtures` and `E2E_MONTONIO` from `./montonio-values`.
     - The test "contact course group registration stays awaiting prepayment" is renamed "contact course group registration: the prepayment starts at once at the bank; cancelled there, the registration stays awaiting and the seat is free again (phase 2b)", and its two lines after `await page.getByRole("button", { name: "Registreeru" }).click();` become:

```ts
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await expect(page.locator("[data-fake-order]")).toContainText("175.00 EUR");
  await page.getByRole("button", { name: "Katkesta" }).click();
  if (LOCAL_FIXTURES) {
    expect(await storedRegistrations(addr)).toEqual([
      { kind: "group", status: "awaiting_prepayment", paidCents: 0, paymentChoice: "half", wantsModelHelp: true, locale: "et", course: "kulmumeistri-baaskoolitus", sessionId: session },
    ]);
    await expect.poll(() => storedPayments(addr)).toEqual([{ kind: "prepayment", status: "failed", amountCents: 17500 }]);
    expect(await storedHold(addr)).toBe(false);
  }
```

     - In the newsletter-consent test, `await expect(page.getByText(/koht kinnitub pärast ettemaksu/)).toBeVisible();` becomes `await page.waitForURL(\`${E2E_MONTONIO.url}/pay/**\`);` and, after the subscriber's poll, add `await page.getByRole("button", { name: "Katkesta" }).click();` and `await expect.poll(() => storedHold(addr)).toBe(false);`.
  3. **`tests/e2e/cache.spec.ts`.** Import `E2E_MONTONIO` from `./montonio-values`. In "a registration makes the course page and the calendar render again …", `await expect(page.getByText(/koht kinnitub pärast ettemaksu/)).toBeVisible();` becomes `await page.waitForURL(\`${E2E_MONTONIO.url}/pay/**\`);`, and after the last `for` loop (the HIT checks) add `await page.getByRole("button", { name: "Katkesta" }).click(); // ends the hold (the webhook), after the cache checks: it revalidates the pages again`.
- [ ] **Step 16: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - `npx playwright test course cache forms catalogue` and `E2E_PROD_BUILD=1 npx playwright test course cache`.

- [ ] **Step 17: Commit.**

```bash
git add app/src/domain/payments.ts app/src/server/payments/start.ts app/src/server/submit.ts app/src/server/actions/public.ts app/src/server/account-mail.ts app/src/lib/navigate.ts app/src/components/site/ContactRegister.tsx app/tests
git commit -m "feat(payments): Registreeru starts the prepayment — a 30-minute hold, the order, the redirect; Maksa in the confirmation mail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Paying later — `/maksa/<pay_token>`, `POST /api/konto/maksa` and the cards' "Maksa {summa}" / "Maksa ülejäänud {summa}"

Spec sections 6.3 (D1, D5, D6) and 10 (the gate, same-origin, the Referrer-Policy pin, the rate limits).
- **`/maksa/<pay_token>`** is a standalone HTML page like the unsubscribe page: `no-store`, `noindex`, no script. **GET has no side effect** (mail scanners open links): the course, the date, the amount due, "Maksa {summa}" (or "Maksa ülejäänud {summa}") and the bank transfer as the second way. **POST** (the button, same-origin only) re-checks, starts the payment (`startRegistrationPayment`) and answers 303 to Montonio. A full session, nothing due, too many starts, or Montonio down: the page again, with a line. The page's `Referrer-Policy: same-origin` is pinned in `next.config.ts` (a strict policy makes the form post `Origin: null`).
- **Minu koolitused:** with payments on, the dashboard says `payOnline: true`. An unpaid card's one main button is "Maksa {summa}", with "või tasu pangaülekandega" + "Vaata juhiseid" (the IBAN block) as a text button under it; a confirmed card with a rest gets "Maksa ülejäänud {summa}", with "Tühista või muuda aega" as the text button. Without the transfer instructions an unpaid card still says what is due and offers "Maksa" (not "Maria saadab sulle arve"). The button posts `POST /api/konto/maksa { registrationId }`, which answers `{ paymentUrl }`.
- **Rate limits:** 5 starts per IP in 10 minutes (as the forms; the page and the API share the counter `rl:pay:<ip>`), and 5 starts a registration an hour (Task 4).

**Files:**
- Create: `app/src/server/pay-page.ts`, `app/src/app/maksa/[token]/route.ts`
- Modify: `app/src/server/auth.ts` (`crossSiteFormPost`, moved from the unsubscribe route), `app/src/app/api/newsletter/loobu/route.ts`, `app/src/server/payments/start.ts` (`PAY_STARTS_PER_IP`)
- Modify: `app/src/lib/site-routing.ts`, `app/src/lib/site-gate.ts`, `app/src/middleware.ts` (its note), `app/next.config.ts`
- Modify: `app/src/server/account-input.ts`, `app/src/server/account-api.ts`, `app/src/app/api/konto/[[...path]]/route.ts`, `app/src/server/client-data.ts` (`Dashboard.payOnline`)
- Modify: `app/src/domain/account-cards.ts` (`nextStep`'s `online`), `app/src/components/account/AccountCourseCard.tsx`, `AccountCourseCard.module.css`, `CoursesTab.tsx`, `texts.ts`
- Test: `app/tests/db/pay-page.test.ts`, `app/tests/db/account-pay.test.ts`, `app/tests/unit/account-pay-dom.test.ts` (new); `app/tests/unit/account-guards.test.ts`, `account-api.test.ts`, `account-cards.test.ts`, `next-config.test.ts`, `site-gate.test.ts`, `site-routing.test.ts` (extend)
- E2E: `app/tests/e2e/test.ts` (the standalone page has no ready mark), `app/tests/e2e/fixtures.ts` (`storedPayToken`), `app/tests/e2e/pay-page.spec.ts` (new), `app/tests/e2e/account-dashboard.spec.ts`, `app/tests/e2e/gate.spec.ts`

**Interfaces:**
- Consumes: `startRegistrationPayment`, `StartResult`, `STARTS_PER_HOUR` (Task 4); `amountDue`, `Due` (Task 4); `navigate` (Task 4); `payment.*` texts (Task 3); `paymentProvider`, `Montonio` (Task 2); `registrations.payToken` (Task 1).
- Produces, from `src/server/payments/start.ts`: `PAY_STARTS_PER_IP = 5` (in `RATE_WINDOW_SEC`, 10 minutes).
- Produces, from `src/server/auth.ts`: `crossSiteFormPost(request: Request): boolean`.
- Produces, from `src/server/pay-page.ts`: `type PayView = { token: string; locale: Locale; registrationId: number; course: I18n; session: { startsAt: Date; city: string; venue: string } | null; due: Due; transfer: PrepaymentInfo | null }`; `loadPayView(db: Db, token: string, now: Date): Promise<PayView | null>`; `type PayNotice = "full" | "failed" | "rate"`; `payPage(view: PayView | null, opts: { online: boolean; notice?: PayNotice }): string`; `type PayPageDeps = { db: Db; kv: TextKv; now: Date; siteUrl: string; montonio: Montonio | null; ip: string | null }`; `handlePayPage(request: Request, token: string, deps: PayPageDeps): Promise<Response>`.
- Produces, from `src/server/account-input.ts`: `parsePayStart(body: unknown): Input<{ registrationId: number }>`.
- Produces, from `src/server/account-api.ts`: `AccountDeps.montonio?: Montonio | null`; `POST /maksa { registrationId }` → 200 `{ ok: true, paymentUrl }`, 400 `{ error: "registrationId" }`, 404 `{ error: "registration" }`, 409 `{ error: "nothing" | "full" }`, 429 `{ error: "rate" }`, 503 `{ error: "unavailable" }`; the dashboard (`GET /`) gains `payOnline: true` when payments are on.
- Produces, from `src/server/client-data.ts`: `Dashboard.payOnline?: boolean`.
- Produces, from `src/domain/account-cards.ts`: `nextStep(card, now, pay, locale = "et", online = false)`.
- Produces, from `src/components/account/texts.ts`: `type PayTexts = { pay: string; payRest: string; transfer: string; starting: string; full: string; nothing: string; rate: string; failed: string }`; `payTexts(d: Dict): PayTexts`; `CoursesTexts.online: PayTexts`.
- Produces, from `src/components/account/AccountCourseCard.tsx`: `CardProps.payOnline?: boolean`; the main pay button `[data-card-action="pay-online"]`, the second way `[data-card-transfer]` / `[data-card-change]`, the refusal line `[data-card-pay-error]`.
- Produces, for the e2e run: `storedPayToken(registrationId: number): Promise<string>` (`tests/e2e/fixtures.ts`).

- [ ] **Step 1: Write the failing page tests** `tests/db/pay-page.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations, settings } from "@/db/schema";
import { handlePayPage, loadPayView, payPage, type PayPageDeps } from "@/server/pay-page";
import { STARTS_PER_HOUR } from "@/server/payments/start";
import { fakeKv } from "../fakes";
import { contactCourse, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// /maksa/<pay_token> (phase 2b, spec 6.3): the mail's "Maksa" link. GET shows the course, the date, what is due, the button and the bank
// transfer, and changes nothing (mail scanners open links); a same-origin POST starts the payment and answers 303 to Montonio; a cross-site
// POST is 403. A full session, nothing due, too many starts or Montonio down: the page again, with its line.

const NOW = new Date("2026-10-09T10:00:00Z");
const PAY = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deps = (montonio: PayPageDeps["montonio"], over: Partial<PayPageDeps> = {}): PayPageDeps => ({ db, kv: fakeKv(), now: NOW, siteUrl: SITE, montonio, ip: "203.0.113.9", ...over });
const get = (token: string) => new Request(`${SITE}/maksa/${token}`);
const post = (token: string, headers: Record<string, string> = { origin: SITE }) => new Request(`${SITE}/maksa/${token}`, { method: "POST", headers });
const text = async (res: Response) => res.text();

describe("GET: the page, and nothing else", () => {
  test("the course, its date and place, the amount, 'Maksa 175 €', and the transfer under 'või tasu pangaülekandega'; no row, no hold", async () => {
    const m = stubMontonio();
    await db.insert(settings).values({ key: "prepayment", value: PAY });
    const r = await registrationOn(db, await contactCourse(db));
    const res = await handlePayPage(get(r.payToken), r.payToken, deps(m.montonio));
    expect([res.status, res.headers.get("cache-control"), res.headers.get("content-type")]).toEqual([200, "no-store", "text/html; charset=utf-8"]);
    const html = await text(res);
    for (const part of ["<h1>Koolituse eest tasumine</h1>", "Kulmumeistri baaskoolitus", "14.11.2026 · 10:00, Pärnu, MS LAB stuudio", "Summa: 175 €", "Maksa 175 €", "või tasu pangaülekandega", "EE38 2200 2210 2014 5685", `MSLAB-${r.id}`, '<meta name="robots" content="noindex">'])
      expect(html).toContain(part);
    expect(html).toContain(`<form method="post" action="/maksa/${r.payToken}">`);
    expect(html).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3\.org)/);
    expect(await db.select().from(payments)).toEqual([]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toBeNull();
    expect(m.state.orders).toEqual([]);
  });

  test("a confirmed registration with a rest: 'Maksa ülejäänud 175 €'; nothing due, cancelled or an unknown token: the one sentence, no button", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const rest = await registrationOn(db, c, { status: "confirmed", paidCents: 17500 });
    expect(await text(await handlePayPage(get(rest.payToken), rest.payToken, deps(m.montonio)))).toContain("Maksa ülejäänud 175 €");
    const paid = await registrationOn(db, c, { email: "a@example.com", status: "confirmed", paidCents: 35000 });
    const cancelled = await registrationOn(db, c, { email: "b@example.com", status: "cancelled" });
    for (const token of [paid.payToken, cancelled.payToken, "x".repeat(43), "short"]) {
      const html = await text(await handlePayPage(get(token), token, deps(m.montonio)));
      expect(html, token).toContain("Selle registreeringu eest pole praegu midagi tasuda.");
      expect(html, token).not.toContain("<form");
    }
  });

  test("Russian for a Russian registration; without payments the transfer alone (no button, no 'või')", async () => {
    const m = stubMontonio();
    await db.insert(settings).values({ key: "prepayment", value: PAY });
    const r = await registrationOn(db, await contactCourse(db), { locale: "ru" });
    const ru = await text(await handlePayPage(get(r.payToken), r.payToken, deps(m.montonio)));
    for (const part of ['<html lang="ru">', "Оплата обучения", "Базовый курс бровиста", "Оплатить 175 €", "или оплатите банковским переводом"]) expect(ru).toContain(part);
    const off = await text(await handlePayPage(get(r.payToken), r.payToken, deps(null)));
    expect(off).not.toContain("<form");
    expect(off).not.toContain("или оплатите");
    expect(off).toContain("EE38 2200 2210 2014 5685");
  });

  test("payPage escapes what it shows", () => {
    const html = payPage(
      { token: "tok", locale: "et", registrationId: 1, course: { et: '<b>"Kulmud"</b>' }, session: null, due: { kind: "prepayment", cents: 100 }, transfer: null },
      { online: true },
    );
    expect(html).toContain("&lt;b&gt;&quot;Kulmud&quot;&lt;/b&gt;");
    expect(html).not.toContain('<b>"Kulmud"</b>');
  });
});

describe("POST: the button", () => {
  test("same-origin: the payment starts — a pending row, the hold — and a 303 to Montonio's page (Origin: null with Sec-Fetch-Site: same-origin too)", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    const [p] = await db.select().from(payments);
    expect([res.status, res.headers.get("location"), res.headers.get("cache-control")]).toEqual([303, `https://sandbox-stargate.montonio.com/${p.providerUuid}`, "no-store"]);
    expect([p.kind, p.status, p.amountCents]).toEqual(["prepayment", "pending", 17500]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * 60_000));
    const other = await registrationOn(db, c, { email: "teine@example.com" });
    expect((await handlePayPage(post(other.payToken, { origin: "null", "sec-fetch-site": "same-origin" }), other.payToken, deps(m.montonio))).status).toBe(303);
  });

  test("cross-site: 403, nothing started", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    // (typed: the literals' union has an optional "sec-fetch-site" that tsc will not pass as Record<string, string>)
    const crossSite: Record<string, string>[] = [{ origin: "https://elsewhere.example" }, { origin: "null" }, { origin: "https://elsewhere.example", "sec-fetch-site": "same-origin" }];
    for (const headers of crossSite)
      expect((await handlePayPage(post(r.payToken, headers), r.payToken, deps(m.montonio))).status, JSON.stringify(headers)).toBe(403);
    expect(await db.select().from(payments)).toEqual([]);
  });

  test("the session is full: 409 and the page says so, without the button", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    await registrationOn(db, c, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    const r = await registrationOn(db, c);
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    const html = await text(res);
    expect(res.status).toBe(409);
    expect(html).toContain("See koolitus on täis. Võta ühendust Mariaga.");
    expect(html).not.toContain("<form");
  });

  test("Montonio down: 503 and 'Midagi läks valesti'; the row is failed, no hold stays", async () => {
    const m = stubMontonio();
    m.state.down = true;
    const r = await registrationOn(db, await contactCourse(db));
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    expect(res.status).toBe(503);
    expect(await text(res)).toContain("Midagi läks valesti. Proovi uuesti.");
    expect((await db.select().from(payments)).map((p) => p.status)).toEqual(["failed"]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toBeNull();
  });

  test("5 starts per IP in 10 minutes, and 5 a registration an hour: then 429 'Liiga palju katseid'", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 20 });
    const kv = fakeKv();
    for (let i = 0; i < 5; i++) {
      const r = await registrationOn(db, c, { email: `k${i}@example.com` });
      expect((await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio, { kv }))).status).toBe(303);
    }
    const sixth = await registrationOn(db, c, { email: "k5@example.com" });
    const limited = await handlePayPage(post(sixth.payToken), sixth.payToken, deps(m.montonio, { kv }));
    expect(limited.status).toBe(429);
    expect(await text(limited)).toContain("Liiga palju katseid. Proovi mõne minuti pärast.");
    // five new attempts of one registration, each ended unpaid (Montonio's ABANDONED) before the next: an open one would only be re-sent (Task 4)
    for (let i = 0; i < STARTS_PER_HOUR; i++) {
      expect((await handlePayPage(post(sixth.payToken), sixth.payToken, deps(m.montonio, { ip: `198.51.100.${i}` }))).status).toBe(303);
      await db.update(payments).set({ status: "failed" }).where(eq(payments.registrationId, sixth.id));
    }
    expect((await handlePayPage(post(sixth.payToken), sixth.payToken, deps(m.montonio, { ip: "198.51.100.99" }))).status).toBe(429);
  });

  test("nothing due by now: the page with its sentence, no payment", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { paidCents: 17500 });
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    expect(res.status).toBe(200);
    expect(await text(res)).toContain("Selle registreeringu eest pole praegu midagi tasuda.");
    expect(await db.select().from(payments)).toEqual([]);
  });
});

test("loadPayView: what the page shows, read with the token only", async () => {
  const r = await registrationOn(db, await contactCourse(db));
  expect(await loadPayView(db, r.payToken, NOW)).toMatchObject({ token: r.payToken, locale: "et", registrationId: r.id, due: { kind: "prepayment", cents: 17500 }, transfer: null });
  expect(await loadPayView(db, "short", NOW)).toBeNull();
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/db/pay-page.test.ts` (`@/server/pay-page` does not exist).

- [ ] **Step 3: The same-origin check, shared.**
  1. **`src/server/auth.ts`.** After `isCrossSite`, add:

```ts
/**
 * Is this form POST from another site? isCrossSite (the Origin header), except that `Origin: null` with `Sec-Fetch-Site: same-origin` is this
 * site's own page: the browser sends that pair when the page's referrer policy is strict, and only a browser can say it (the header is
 * forbidden to scripts). A named foreign site is cross-site whatever Sec-Fetch-Site says. The standalone pages' buttons use it: the
 * unsubscribe page (api/newsletter/loobu) and the pay page (/maksa/<token>, phase 2b).
 */
export function crossSiteFormPost(request: Request): boolean {
  if (request.headers.get("origin") === "null" && request.headers.get("sec-fetch-site") === "same-origin") return false;
  return isCrossSite(request);
}
```

  2. **`src/app/api/newsletter/loobu/route.ts`.** Delete its own `crossSitePost` function (with its doc comment), import `crossSiteFormPost` from `@/server/auth` (next to `isCrossSite`, which it then no longer needs: drop that import), and `if (crossSitePost(request))` becomes `if (crossSiteFormPost(request))`. `npx vitest run tests/db/newsletter-unsubscribe-route.test.ts` stays green.
  3. **`src/server/payments/start.ts`.** After `STARTS_PER_HOUR`, add:

```ts
/** Payment starts per visitor IP in RATE_WINDOW_SEC (10 minutes), as the forms (spec 10): the /maksa page and POST /api/konto/maksa share the counter. */
export const PAY_STARTS_PER_IP = 5;
```

- [ ] **Step 4: Write `src/server/pay-page.ts`:**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { courses, courseSessions, registrations } from "@/db/schema";
import { groupIban, hasPrepayment, parsePrepayment, paymentReference, PREPAYMENT_KEY, type PrepaymentInfo } from "@/domain/account-cards";
import { formatEUR } from "@/domain/money";
import { amountDue, type Due } from "@/domain/payments";
import { registrationPrice } from "@/domain/registration";
import { pick, type I18n } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { getDict, type Locale } from "@/i18n/locales";
import { esc } from "./account-mail";
import { crossSiteFormPost } from "./auth";
import { logFailure, logNote } from "./log";
import type { Montonio } from "./payments/montonio";
import { PAY_STARTS_PER_IP, startRegistrationPayment, type StartResult } from "./payments/start";
import { RATE_WINDOW_SEC, rateKey, rateLimit, type TextKv } from "./ratelimit";
import { isTokenShape } from "./token";

// The page behind the "Maksa" link of the registration mail (phase 2b, spec 6.3): /maksa/<pay_token>. Opening the link only shows it (a mail
// gateway that fetches every link must neither create an order nor hold a seat); its button posts back, and that POST starts the payment.
// Standalone HTML built here, as the unsubscribe page is (server/unsubscribe-page.ts): no React, no script, no external resource, the site's
// colour tokens, its fonts only named. The page's language is the registration's. The token is never logged.

/** What the page shows: the registration's course and session, what is due now, and the bank transfer when Maria's instructions can be followed. */
export type PayView = {
  token: string;
  locale: Locale;
  registrationId: number;
  course: I18n;
  session: { startsAt: Date; city: string; venue: string } | null;
  due: Due;
  transfer: PrepaymentInfo | null;
};

/** The view of a "Maksa" token, or null: a token that cannot be one, or no registration has it. Reads only. */
export async function loadPayView(db: Db, token: string, now: Date): Promise<PayView | null> {
  if (!isTokenShape(token)) return null;
  const [row] = await db
    .select({ registration: registrations, course: courses, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(registrations.payToken, token))
    .limit(1);
  if (!row) return null;
  const { registration: r, course, session } = row;
  const pay = parsePrepayment(await readSetting(db, PREPAYMENT_KEY));
  return {
    token,
    locale: r.locale === "ru" ? "ru" : "et",
    registrationId: r.id,
    course: course.title,
    session: session ? { startsAt: session.startsAt, city: session.city, venue: session.venue } : null,
    due: amountDue(
      { status: r.status, paymentChoice: r.paymentChoice, priceCents: registrationPrice(course, r.kind), paidCents: r.paidCents, startsAt: session?.startsAt ?? null, sessionCancelled: session?.status === "cancelled" },
      now,
    ),
    transfer: hasPrepayment(pay) ? pay : null,
  };
}

/** The line a POST leaves on the page: the session is full, too many starts, or the payment did not start. */
export type PayNotice = "full" | "failed" | "rate";

const CSS = [
  ":root{--ink:#222222;--paper:#ffffff;--canvas:#f6f4f5;--line:#e6e1e3}",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--canvas);color:var(--ink);font:400 16px/1.5 Manrope,system-ui,sans-serif}",
  "main{width:100%;max-width:480px;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:32px 24px}",
  ".brand{margin:0 0 24px;font:600 14px/1 Jost,system-ui,sans-serif;letter-spacing:.14em}",
  "h1{margin:0 0 16px;font:600 24px/1.3 Jost,system-ui,sans-serif}",
  "p{margin:0 0 16px}",
  ".course{margin:0 0 4px;font:600 18px/1.4 Jost,system-ui,sans-serif}",
  ".when{font-size:14px}",
  ".amount{font:600 20px/1.3 Jost,system-ui,sans-serif}",
  ".notice{padding:12px 14px;border:1px solid var(--line);border-radius:12px}",
  "form{margin:0 0 8px}",
  "button{display:block;width:100%;min-height:48px;padding:0 32px;border:0;border-radius:99px;background:var(--ink);color:var(--paper);font:600 16px/1 Jost,system-ui,sans-serif;cursor:pointer}",
  "button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}",
  ".or{margin:24px 0 8px;font:600 14px/1.4 Jost,system-ui,sans-serif}",
  "dl{display:grid;gap:10px;margin:0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--canvas)}",
  "dt{font-size:13px}",
  "dd{margin:0;font-weight:600;word-break:break-word}",
  "@media (min-width:480px){main{padding:40px 36px}button{width:auto}}",
].join("");

/**
 * The page. `online`: payments are on (the button). With something due: the amount, a notice line when a POST left one, "Maksa {summa}" /
 * "Maksa ülejäänud {summa}" (not when the session is full), and the bank transfer's rows — under "või tasu pangaülekandega" when the button
 * is there. Nothing due, or an unknown token: "Selle registreeringu eest pole praegu midagi tasuda." Every value is escaped.
 */
export function payPage(view: PayView | null, opts: { online: boolean; notice?: PayNotice }): string {
  const locale: Locale = view?.locale ?? "et";
  const d = getDict(locale);
  const t = d.payment;
  const labels = d.account.dashboard.payment;
  const parts = [`<p class="brand">MS LAB</p><h1>${esc(t.page.heading)}</h1>`];
  if (view) {
    parts.push(`<p class="course">${esc(pick(view.course, locale))}</p>`);
    if (view.session) {
      const s = view.session;
      const when = [`${formatDate(s.startsAt, locale)} · ${formatTime(s.startsAt, locale)}`, s.city, s.venue].filter(Boolean).join(", ");
      parts.push(`<p class="when">${esc(when)}</p>`);
    }
  }
  const notice = opts.notice === "full" ? t.page.full : opts.notice === "rate" ? d.forms.errorTooMany : opts.notice === "failed" ? d.forms.errorGeneric : null;
  if (notice) parts.push(`<p class="notice" role="alert" data-pay-notice="${opts.notice}">${esc(notice)}</p>`);
  const due = view && view.due.kind !== "none" ? view.due : null;
  if (!view || !due) {
    if (!notice) parts.push(`<p data-pay-nothing="">${esc(t.page.nothing)}</p>`);
  } else {
    const amount = formatEUR(due.cents, locale);
    parts.push(`<p class="amount">${esc(labels.amount)}: ${esc(amount)}</p>`);
    const button = opts.online && opts.notice !== "full";
    if (button) parts.push(`<form method="post" action="/maksa/${esc(view.token)}"><button type="submit">${esc(fill(due.kind === "balance" ? t.payRest : t.pay, { amount }))}</button></form>`);
    if (view.transfer) {
      const pay = view.transfer;
      const rows = ([
        [labels.receiver, pay.receiver],
        [labels.iban, groupIban(pay.iban)],
        [labels.bank, pay.bank],
        [labels.amount, amount],
        [labels.reference, paymentReference(pay, view.registrationId)],
      ] as [string, string][]).filter(([, value]) => value.trim() !== "");
      if (button) parts.push(`<p class="or">${esc(t.transfer)}</p>`);
      parts.push(`<dl data-pay-transfer="">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`);
    }
  }
  return [
    "<!doctype html>",
    `<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">`,
    `<title>${esc(t.page.heading)} – MS LAB</title><style>${CSS}</style></head>`,
    `<body><main>${parts.join("")}</main></body></html>`,
  ].join("");
}

export type PayPageDeps = {
  db: Db;
  /** The rate limits' store (Postgres kv_entries). */
  kv: TextKv;
  now: Date;
  /** The base of Montonio's way back (the return, the webhook): this request's own origin when it is one of ours, else SITE_URL. */
  siteUrl: string;
  montonio: Montonio | null;
  /** The visitor's address (the per-IP limit); null: not limited (never on Vercel). */
  ip: string | null;
};

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** The per-IP limit of payment starts (fails open, as the forms' limits). */
async function withinPayLimit(deps: PayPageDeps): Promise<boolean> {
  if (deps.ip === null) return true;
  try {
    return await rateLimit(deps.kv, rateKey("pay", deps.ip), PAY_STARTS_PER_IP, RATE_WINDOW_SEC);
  } catch (e) {
    logFailure("[payments] rate limit unavailable, allowing", e);
    return true;
  }
}

/**
 * GET /maksa/<token>: the page, nothing else. POST (its button): a cross-site POST is 403; else what is due is checked again and the payment
 * starts (server/payments/start.ts): 303 to Montonio's page. Nothing due by now: the page (its sentence). The session full: 409 with its line;
 * 5 starts from this IP in 10 minutes or 5 of this registration in an hour: 429; Montonio down or no payments: 503 "Midagi läks valesti".
 */
export async function handlePayPage(request: Request, token: string, deps: PayPageDeps): Promise<Response> {
  const online = deps.montonio !== null;
  if (request.method === "POST" && crossSiteFormPost(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  let view: PayView | null;
  try {
    view = await loadPayView(deps.db, token, deps.now);
  } catch (e) {
    logFailure("[payments] the pay page could not be read", e);
    return html(payPage(null, { online, notice: "failed" }), 503);
  }
  if (request.method !== "POST" || !view || view.due.kind === "none") return html(payPage(view, { online }));
  if (!(await withinPayLimit(deps))) {
    logNote("[payments] pay page: starts rate limited");
    return html(payPage(view, { online, notice: "rate" }), 429);
  }
  let result: StartResult;
  try {
    result = await startRegistrationPayment({ db: deps.db, now: deps.now, siteUrl: deps.siteUrl, montonio: deps.montonio }, { payToken: token });
  } catch (e) {
    logFailure("[payments] pay page: the payment did not start", e);
    result = { kind: "failed" };
  }
  switch (result.kind) {
    case "started":
      return new Response(null, { status: 303, headers: { location: result.paymentUrl, "cache-control": "no-store" } });
    case "full":
      return html(payPage(view, { online, notice: "full" }), 409);
    case "rate":
      return html(payPage(view, { online, notice: "rate" }), 429);
    case "nothing":
    case "notFound":
      return html(payPage(await loadPayView(deps.db, token, deps.now), { online }));
    default:
      return html(payPage(view, { online, notice: "failed" }), 503);
  }
}
```

- [ ] **Step 5: The route** — create `src/app/maksa/[token]/route.ts`:

```ts
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { handlePayPage } from "@/server/pay-page";
import { paymentProvider } from "@/server/payments/montonio";
import { clientIp } from "@/server/ratelimit";
import { hostOrigin, linkBase } from "@/server/site";

export const dynamic = "force-dynamic";
/** The button's POST asks Montonio for an order (15 s at most). */
export const maxDuration = 30;

type Ctx = { params: Promise<{ token: string }> };

/**
 * /maksa/<pay_token> — the "Maksa" link of the registration mail (phase 2b, server/pay-page.ts). GET shows the page; its button's POST starts
 * the payment. It goes through the coming-soon gate (lib/site-gate.ts) and is served as it is by the routing (lib/site-routing.ts). Its
 * headers besides the type and the cache are next.config.ts's: noindex, and Referrer-Policy same-origin — never no-referrer, or the
 * button's POST carries `Origin: null` and is refused.
 */
async function answer(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  try {
    const h = request.headers;
    return await handlePayPage(request, token, {
      db: getDb(),
      kv: serverKv(),
      now: new Date(),
      siteUrl: linkBase(hostOrigin(h), serverEnv().SITE_URL),
      montonio: paymentProvider(),
      // without x-forwarded-for (never on Vercel) `next dev` uses one local bucket
      ip: clientIp(h) ?? (process.env.NODE_ENV === "development" ? "local" : null),
    });
  } catch (e) {
    logFailure("[payments] pay page failed", e); // never the message: the token is in the address
    return new Response("", { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const GET = answer;
export const POST = answer;

/** Mail scanners and link previews often send HEAD first; Next would run GET for it. Nothing happens here. */
export function HEAD(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
```

- [ ] **Step 6: Run** `npx vitest run tests/db/pay-page.test.ts tests/db/newsletter-unsubscribe-route.test.ts` — expect PASS.

- [ ] **Step 7: The routing, the gate and the header pin.**
  1. **Failing tests first.**
     - `tests/unit/site-routing.test.ts`, in "redirects, the hub, the API and everything served as it is", add: `expect(route("/maksa/AbC_d-0123456789012345678901234567890")).toEqual({ kind: "other" }); // the pay page (phase 2b): a route handler, served as it is`; in "names that only begin like admin …", add `"/maksa", "/maksax/a", "/maksa/a/b"` to the list that becomes the 404 page.
     - `tests/unit/site-gate.test.ts`: add `"/maksa/AbC_d-0123456789012345678901234567890", // the mail's Maksa link (phase 2b)` to `THROUGH`, and `"/maksa", "/maksa/a/b", "/maksax/a", "/ru/maksa/a", "/maksa/..%2fkonto",` to `GATED`; in "the method never opens the gate … and never closes it", add `"/maksa/AbC_d-0123456789012345678901234567890"` to the list that passes for every method.
     - `tests/unit/next-config.test.ts`, append inside the describe:

```ts
  test("the pay page's button POST keeps its Origin: /maksa/<token> is same-origin, never no-referrer; nothing else changes (phase 2b)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    expect(valueFor(rules, "/maksa/abc", "referrer-policy")).toBe("same-origin");
    expect(valueFor(rules, "/maksa/abc", "cache-control")).toBe("no-store");
    expect(valueFor(rules, "/maksa/abc", "x-robots-tag")).toBe("noindex, nofollow");
    for (const path of ["/maksa", "/maksa/abc/x", "/makse"]) expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
  });
```

     Run `npx vitest run tests/unit/site-routing.test.ts tests/unit/site-gate.test.ts tests/unit/next-config.test.ts` — FAIL.
  2. **`src/lib/site-routing.ts`.** `PASS` becomes:

```ts
const PASS = new RegExp(`^\\/(ru(\\/|$)|admin(\\/|$)|media(\\/|$)|_next(\\/|$)|maksa\\/[^/]+$|${ROOT_FILE_SOURCE})`);
```

     and the comment above it gains: "The pay page of a registration (/maksa/<token>, phase 2b) is a route handler at its own path: one segment after it, nothing deeper."
  3. **`src/lib/site-gate.ts`.** `THROUGH` becomes:

```ts
const THROUGH = new RegExp(`^\\/(admin(\\/|$)|api\\/(auth|admin|cron|newsletter)(\\/|$)|api\\/bunny\\/webhook$|api\\/payments\\/notify$|maksa\\/[^/]+$|_next\\/|media(\\/|$)|${ROOT_FILE_SOURCE})`);
```

     and in its doc comment, after Montonio's webhook, add "the pay page of the registration mail's "Maksa" link (/maksa/<token>, its GET and its POST; phase 2b: a mail sent before the launch must open it),". In `src/middleware.ts`'s note add `/maksa/<token>` after `/api/payments/notify`.
  4. **`next.config.ts`.** After the rule for `/api/newsletter/loobu`, add:

```ts
      // the pay page of the "Maksa" link (/maksa/<token>, phase 2b: server/pay-page.ts): never cached, and same-origin for the same reason as the
      // unsubscribe page — its button's POST must keep its Origin (never no-referrer: `Origin: null` is refused as cross-site). The page has no
      // link or resource that leaves the site, so the token in its address goes nowhere.
      { source: "/maksa/:token", headers: [{ key: "Referrer-Policy", value: "same-origin" }, { key: "Cache-Control", value: "no-store" }] },
```

  5. Run the three tests again — PASS.

- [ ] **Step 8: The account API's failing tests.**
  1. **`tests/unit/account-guards.test.ts`.** In both handler lists insert `"payRegistration"` after `"changeRequest"`; in the router's expected cases insert `"POST /maksa payRegistration"` after `"POST /muutmine changeRequest"`.
  2. **`tests/unit/account-api.test.ts`.** In "the data endpoints without a session", add `["POST", "/maksa", { registrationId: 1 }],` to `endpoints`.
  3. **`tests/db/account-pay.test.ts`** (new):

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, payments, registrations } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { contactCourse, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// POST /api/konto/maksa (phase 2b, spec 6.3): the card's "Maksa {summa}" / "Maksa ülejäänud {summa}" for one of the client's own registrations,
// with the /maksa page's checks; and the dashboard says payOnline when payments are on.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deps = (montonio: AccountDeps["montonio"], kv = fakeKv()): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
  montonio,
});

async function signedIn(email = "kati@example.com") {
  const [client] = await db.insert(clients).values({ email }).returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { client, cookie: `__Host-mslab_client=${raw}` };
}

const call = async (d: AccountDeps, cookie: string, body: unknown, opts: { ip?: string; origin?: string } = {}) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto/maksa`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-forwarded-for": opts.ip ?? "203.0.113.9", ...(opts.origin ? { origin: opts.origin } : {}) },
      body: JSON.stringify(body),
    }),
    d,
  ))!;
const answer = async (res: Response) => [res.status, await res.json()];

test("her own unpaid registration: 200 with Montonio's page; a pending prepayment and the hold", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const r = await registrationOn(db, await contactCourse(db), { clientId: client.id });
  const res = await call(deps(m.montonio), cookie, { registrationId: r.id });
  const [p] = await db.select().from(payments);
  expect(await answer(res)).toEqual([200, { ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` }]);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect([p.kind, p.clientId, p.amountCents]).toEqual(["prepayment", client.id, 17500]);
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).not.toBeNull();
});

test("the rest of a confirmed one; not hers 404; paid in full or full 409; no payments 503; no body 400; cross-site 403", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db, { capacity: 1 });
  const rest = await registrationOn(db, c, { clientId: client.id, status: "confirmed", paidCents: 17500 });
  expect((await call(deps(m.montonio), cookie, { registrationId: rest.id })).status).toBe(200);
  expect((await db.select().from(payments).where(eq(payments.registrationId, rest.id)))[0].kind).toBe("balance");
  const other = await signedIn("teine@example.com");
  const theirs = await registrationOn(db, c, { email: "teine@example.com", clientId: other.client.id });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: theirs.id }))).toEqual([404, { ok: false, error: "registration" }]);
  const paid = await registrationOn(db, c, { clientId: client.id, status: "confirmed", paidCents: 35000 });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: paid.id }))).toEqual([409, { ok: false, error: "nothing" }]);
  const waiting = await registrationOn(db, c, { clientId: client.id });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: waiting.id }))).toEqual([409, { ok: false, error: "full" }]);
  expect(await answer(await call(deps(null), cookie, { registrationId: waiting.id }))).toEqual([503, { ok: false, error: "unavailable" }]);
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: "7" }))).toEqual([400, { ok: false, error: "registrationId" }]);
  expect((await call(deps(m.montonio), cookie, { registrationId: waiting.id }, { origin: "https://elsewhere.example" })).status).toBe(403);
});

test("5 starts per IP in 10 minutes (shared with the /maksa page): then 429 rate", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db, { capacity: 20 });
  const kv = fakeKv();
  for (let i = 0; i < 5; i++) {
    const r = await registrationOn(db, c, { clientId: client.id, email: `k${i}@example.com` });
    expect((await call(deps(m.montonio, kv), cookie, { registrationId: r.id })).status).toBe(200);
  }
  const sixth = await registrationOn(db, c, { clientId: client.id, email: "k5@example.com" });
  expect(await answer(await call(deps(m.montonio, kv), cookie, { registrationId: sixth.id }))).toEqual([429, { ok: false, error: "rate" }]);
  expect(kv.store.get("rl:pay:203.0.113.9")).toBe("5");
});

test("the dashboard says payOnline when payments are on, and nothing when they are off", async () => {
  const m = stubMontonio();
  const { cookie } = await signedIn();
  const dash = async (montonio: AccountDeps["montonio"]) =>
    (await (await handleAccountApi(new Request(`${SITE}/api/konto`, { headers: { cookie } }), deps(montonio)))!.json()) as Record<string, unknown>;
  expect((await dash(m.montonio)).payOnline).toBe(true);
  expect("payOnline" in (await dash(null))).toBe(false);
});
```

  4. Run `npx vitest run tests/unit/account-guards.test.ts tests/unit/account-api.test.ts tests/db/account-pay.test.ts` — FAIL.

- [ ] **Step 9: The endpoint** (`src/server/account-input.ts`, `src/server/account-api.ts`, the route, `client-data.ts`).
  1. **`account-input.ts`.** After `const password = …`, add `const payStart = z.object({ registrationId: rowId });`; after `parsePassword`, add `export const parsePayStart = (body: unknown) => parse(payStart, body);`.
  2. **`client-data.ts`.** In `Dashboard`, after `resume`, add:

```ts
  /**
   * Online payments are on (phase 2b): the cards offer "Maksa {summa}" / "Maksa ülejäänud {summa}". Set by the account API (account-api.ts
   * dashboard), never by loadDashboard: the admin's read-only view shows the cards without it.
   */
  payOnline?: boolean;
```

  3. **`account-api.ts`.**
     - Imports: add `parsePayStart` to the `./account-input` import; add `import type { Montonio } from "./payments/montonio";` and `import { PAY_STARTS_PER_IP, startRegistrationPayment } from "./payments/start";`.
     - `AccountDeps` gains, after `bunny`:

```ts
  /** Online payments (phase 2b, payments/montonio.ts paymentProvider); absent or null: no "Maksa" on the cards, and POST /maksa is 503. */
  montonio?: Montonio | null;
```

     - In the file's top comment, add to the list of endpoints behind a session: "POST /maksa an online payment of one of her registrations (phase 2b: the prepayment due, or the rest)".
     - `dashboard`'s last line becomes:

```ts
  // the client was deleted since the session was checked; with online payments the cards offer "Maksa" (phase 2b)
  return data ? clientResponse(session, deps.montonio ? { ...data, payOnline: true } : data) : unauthorized("none");
```

     - After the `changeRequest` handler (inside the data section), add:

```ts
/**
 * POST /maksa `{ registrationId }` (phase 2b, spec 6.3): starts the online payment of one of the client's own registrations — the prepayment
 * still due, or the rest after it — with the /maksa page's checks (server/payments/start.ts). 200 `{ ok: true, paymentUrl }` (the card sends
 * the browser there); 404 `{ error: "registration" }` (not hers, or none); 409 `{ error: "nothing" }` (nothing to pay now) or `"full"` (no
 * free seat, D2); 429 `{ error: "rate" }` (5 starts from this IP in 10 minutes, shared with the /maksa page, or 5 of this registration in an
 * hour); 503 `{ error: "unavailable" }` without online payments or when Montonio says no.
 */
async function payRegistration(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parsePayStart(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  if (!(await withinRateLimit(request, deps, "pay", PAY_STARTS_PER_IP))) {
    logNote("[account] payment starts rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await startRegistrationPayment({ db: deps.db, now: deps.now, siteUrl: deps.siteUrl, montonio: deps.montonio ?? null }, { registrationId: input.data.registrationId, clientId: session.clientId });
  switch (result.kind) {
    case "started":
      return clientResponse(session, { ok: true, paymentUrl: result.paymentUrl });
    case "notFound":
      return clientResponse(session, { ok: false, error: "registration" }, 404);
    case "nothing":
    case "full":
      return clientResponse(session, { ok: false, error: result.kind }, 409);
    case "rate":
      return clientResponse(session, { ok: false, error: "rate" }, 429);
    default:
      return clientResponse(session, { ok: false, error: "unavailable" }, 503);
  }
}
```

     - In `dataRoute`'s switch, after `case "POST /muutmine": …`, add `case "POST /maksa": return payRegistration(request, deps);`.
  4. **`src/app/api/konto/[[...path]]/route.ts`.** Import `paymentProvider` from `@/server/payments/montonio`; in `deps`, after `bunny: bunnyConfig(env),`, add `// online payments (phase 2b): null without the keys` and `montonio: paymentProvider(),`.
  5. Run the four tests of step 8 — PASS.

- [ ] **Step 10: The card — failing tests.**
  1. **`tests/unit/account-cards.test.ts`**, append inside the describe "nextStep: …":

```ts
  test("with online payments (phase 2b) an unpaid card is 'pay' even without the transfer instructions; without them, and offline, Maria's invoice", () => {
    const unpaid = contact({ paymentChoice: "half" });
    expect(nextStep(unpaid, NOW, null).key).toBe("invoice");
    expect(nextStep(unpaid, NOW, null, "et", true)).toEqual({ key: "pay", vars: { amount: "175 €" }, action: { kind: "pay", registrationId: 7 } });
    expect(nextStep(unpaid, NOW, PAY, "et", true).key).toBe("pay");
  });
```

  2. **`tests/unit/account-pay-dom.test.ts`** (new):

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { coursesTexts } from "@/components/account/texts";
import type { AccountCard, ContactCard, PrepaymentInfo } from "@/domain/account-cards";
import { getDict } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The cards' "Maksa" (phase 2b, spec 6.3): with online payments an unpaid card's one main button is "Maksa {summa}" (the transfer's "Vaata
// juhiseid" under it as a text button), a confirmed card with a rest has "Maksa ülejäänud {summa}" (the change request under it). The button
// posts /api/konto/maksa and the page goes to Montonio; a refusal says why under the button. Without online payments the cards are today's.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ navigate: vi.fn<(url: string) => void>() }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));

const NOW = "2026-10-09T10:00:00.000Z";
const FUTURE = "2026-11-14T08:00:00.000Z";
const PAY: PrepaymentInfo = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } };
const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
  kind: "contact", registrationId, course, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: false },
  status: "awaiting_prepayment", paymentChoice: "half", priceCents: 35000, paidCents: 0, createdAt: NOW, ...over,
});
const dashboard = (cards: AccountCard[], over: Partial<Dashboard> = {}): Dashboard => ({
  client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
  cards,
  favourites: [],
  prepayment: PAY,
  resume: null,
  payOnline: true,
  ...over,
});

const t = coursesTexts(getDict("et"));
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (data: Dashboard, readOnly = false) => {
  await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, data, readOnly, now: NOW })));
};
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

beforeEach(() => {
  fetchMock.mockReset();
  mocks.navigate.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("with online payments", () => {
  test("an unpaid card: 'Maksa 175 €' is its one main button; 'või tasu pangaülekandega' and 'Vaata juhiseid' under it; pressing it goes to Montonio", async () => {
    await render(dashboard([contact(7)]));
    expect($$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent])).toEqual([["pay-online", "Maksa 175 €"]]);
    expect($("[data-card='registration-7']")!.textContent).toContain("või tasu pangaülekandega");
    await click($("[data-card-transfer]"));
    expect($("[data-prepayment]")).not.toBeNull();
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" }));
    await click($("[data-card-action='pay-online']"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init?.method, JSON.parse(String(init?.body))]).toEqual(["/api/konto/maksa", "POST", { registrationId: 7 }]);
    expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-1");
  });

  test("a refusal says why under the button: full, nothing to pay, too many, anything else", async () => {
    await render(dashboard([contact(7)]));
    for (const [answer, line] of [
      [json(409, { ok: false, error: "full" }), "See koolitus on täis. Võta ühendust Mariaga."],
      [json(409, { ok: false, error: "nothing" }), "Selle registreeringu eest pole praegu midagi tasuda."],
      [json(429, { ok: false, error: "rate" }), "Liiga palju katseid. Proovi mõne minuti pärast."],
      [json(503, { ok: false, error: "unavailable" }), "Midagi läks valesti. Proovi uuesti."],
    ] as const) {
      fetchMock.mockResolvedValueOnce(answer);
      await click($("[data-card-action='pay-online']"));
      expect($("[data-card-pay-error]")?.textContent).toBe(line);
    }
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test("a confirmed card with a rest: 'Maksa ülejäänud 175 €', the change request under it; without the transfer instructions 'Maksa' alone", async () => {
    await render(dashboard([contact(8, { status: "confirmed", paidCents: 17500 })]));
    expect($$("[data-card-action]").map((b) => b.textContent)).toEqual(["Maksa ülejäänud 175 €"]);
    expect($("[data-card-change]")?.textContent).toBe("Tühista või muuda aega");
    await render(dashboard([contact(9)], { prepayment: null }));
    expect($("[data-next-step]")?.textContent).toBe("Koha kinnitamiseks tasu ettemaks 175 €.");
    expect($$("[data-card='registration-9'] button").map((b) => b.textContent)).toEqual(["Maksa 175 €"]);
  });

  test("read-only (the admin's view): the button is there and does nothing", async () => {
    await render(dashboard([contact(7)]), true);
    await click($("[data-card-action='pay-online']"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

test("without online payments the cards are today's: 'Vaata juhiseid' is the one button; no 'Maksa'", async () => {
  await render(dashboard([contact(7), contact(8, { status: "confirmed", paidCents: 17500 })], { payOnline: undefined }));
  expect($$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent])).toEqual([["pay", "Vaata juhiseid"], ["change", "Tühista või muuda aega"]]);
  expect(container.textContent).not.toContain("Maksa");
});
```

  3. Run `npx vitest run tests/unit/account-cards.test.ts tests/unit/account-pay-dom.test.ts` — FAIL.

- [ ] **Step 11: The card.**
  1. **`src/domain/account-cards.ts`.** `contactStep(card, now, pay, locale)` gains a fifth parameter `online: boolean`, and its line `return hasPrepayment(pay) ? step("pay", …) : step("invoice");` becomes:

```ts
    // phase 2b: with online payments the amount can be paid by "Maksa" even when Maria has no transfer instructions in Seaded
    return hasPrepayment(pay) || online ? step("pay", { amount: formatEUR(due, locale) }, { kind: "pay", registrationId: card.registrationId }) : step("invoice");
```

     `nextStep`'s signature becomes `nextStep(card: AccountCard, now: Date, pay: PrepaymentInfo | null, locale: Locale = "et", online = false): NextStep`, it passes `online` to `contactStep`, and its doc comment gains: "`online`: online payments are on (phase 2b, Dashboard.payOnline): an unpaid card is "pay" (its "Maksa {summa}") even without the transfer instructions."
  2. **`src/components/account/texts.ts`.** After `LessonTexts`, add:

```ts
/** The cards' pay button (phase 2b): "Maksa {amount}", "Maksa ülejäänud {amount}", the transfer line, the button while it opens, and why a start was refused. */
export type PayTexts = { pay: string; payRest: string; transfer: string; starting: string; full: string; nothing: string; rate: string; failed: string };

export const payTexts = (d: Dict): PayTexts => ({
  pay: d.payment.pay,
  payRest: d.payment.payRest,
  transfer: d.payment.transfer,
  starting: d.payment.starting,
  full: d.payment.page.full,
  nothing: d.payment.page.nothing,
  rate: d.forms.errorTooMany,
  failed: d.forms.errorGeneric,
});
```

     `CoursesTexts` gains the field below (named `online`: the dashboard's own `payment` already holds the transfer labels that PrepaymentInfo reads), and `coursesTexts` becomes `(d: Dict): CoursesTexts => ({ ...d.account.dashboard, next: d.account.next, loader: loaderTexts(d), online: payTexts(d) })`:

```ts
  /** The pay button's texts (phase 2b). */
  online: PayTexts;
```

  3. **`src/components/account/CoursesTab.tsx`.** In the `<AccountCourseCard … />` element, after `pay={data.prepayment}`, add `payOnline={data.payOnline === true}`.
  4. **`src/components/account/AccountCourseCard.module.css`.** After `.foot { … }`, add:

```css
/* the second way next to "Maksa" (phase 2b): the transfer's instructions, or the change request — a text button in the site's link style,
   44 px tall, never a second filled button */
.secondRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 10px;
  margin-top: 6px;
}

.or {
  margin: 0;
  color: var(--muted-2);
  font: 400 13px/1.5 var(--font-body);
}

.second {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 8px 0;
  border: 0;
  border-bottom: 1px solid var(--muted);
  border-radius: 0;
  background: none;
  color: var(--ink);
  font: 500 13px/1.2 var(--font-body);
  cursor: pointer;
}

.second:hover {
  border-bottom-color: var(--ink);
}

.second:focus-visible {
  outline: 2px solid var(--rose);
  outline-offset: 4px;
}

.second[aria-disabled="true"] {
  cursor: default;
}

/* why a payment did not start (phase 2b) */
.payError {
  margin: 10px 0 0;
  color: var(--bad);
  font: 400 13px/1.45 var(--font-body);
}
```

  5. **`src/components/account/AccountCourseCard.tsx`** — replace the whole file with:

```tsx
"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import {
  cardKey, cardTag, cardTitle, cardWhen, hasPrepayment, isPastCard, nextStep, type AccountCard, type ContactCard, type PrepaymentInfo as PaySettings,
} from "@/domain/account-cards";
import { formatEUR } from "@/domain/money";
import { amountDue, type Due } from "@/domain/payments";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { navigate } from "@/lib/navigate";
import { NextStepLine } from "./NextStepLine";
import { PrepaymentInfo } from "./PrepaymentInfo";
import { ProgressBar } from "./ProgressBar";
import type { CoursesTexts } from "./texts";
import styles from "./AccountCourseCard.module.css";

export type CardProps = {
  card: AccountCard;
  now: Date;
  locale: Locale;
  t: CoursesTexts;
  pay: PaySettings | null;
  readOnly: boolean;
  /** A change request was sent for this registration from this tab: the card says so instead of offering the button. */
  sent: boolean;
  /** It was sent just now: "Saadetud …" takes the focus the dialog gives back. */
  focusSent?: boolean;
  /** "Tühista või muuda aega": opens the dialog (the button is handed over, for the focus to return to it). */
  onChangeRequest(card: ContactCard, opener: HTMLElement): void;
  /** Online payments are on (phase 2b, Dashboard.payOnline): the pay steps get "Maksa {summa}" / "Maksa ülejäänud {summa}". */
  payOnline?: boolean;
};

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** What a contact card can pay online now (phase 2b, domain/payments.ts amountDue): the prepayment still due, the rest, or nothing. */
function onlineDue(card: AccountCard, now: Date): Due {
  if (card.kind !== "contact") return { kind: "none" };
  return amountDue(
    { status: card.status, paymentChoice: card.paymentChoice, priceCents: card.priceCents, paidCents: card.paidCents, startsAt: new Date(card.session.startsAt), sessionCancelled: card.session.cancelled },
    now,
  );
}

/**
 * One course card of "Minu koolitused" (prototype B's dashboard .card): the type tag, the course, when and where, the one
 * next-step sentence and at most one main button (spec 2.1 rule 5):
 * - pay → "Vaata juhiseid" opens the prepayment instructions in place; with online payments (phase 2b) the main button is "Maksa {summa}"
 *   and "Vaata juhiseid" is a text button under it, after "või tasu pangaülekandega";
 * - changeRequest → "Tühista või muuda aega" opens the dialog (after sending: "Saadetud. Maria võtab sinuga ühendust."); with online
 *   payments a confirmed card with a rest has "Maksa ülejäänud {summa}" as its main button and the change request as the text button;
 * - openCourse → "Ava koolitus" → /konto/kursus/{slug}.
 * "Maksa" posts /api/konto/maksa and the page goes on to Montonio; a refusal says why under the button.
 * An open e-course with lessons shows '{done} / {total}' with the e-course page's bar, or 'Läbitud ✓' (phase 2c).
 * `readOnly`: the buttons are there but aria-disabled, and do nothing.
 */
export function AccountCourseCard({ card, now, locale, t, pay, readOnly, sent, focusSent, onChangeRequest, payOnline = false }: CardProps) {
  const step = nextStep(card, now, pay, locale, payOnline);
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const titleId = useId();
  const panelId = useId();
  const when = cardWhen(card, locale);
  const action = step.action;
  const progress = card.kind === "ecourse" && !isPastCard(card, now) ? (card.progress ?? null) : null;
  const due = payOnline ? onlineDue(card, now) : ({ kind: "none" } as const);
  // the main button is "Maksa …" when the step is a payment and an amount can be paid online now
  const online = due.kind !== "none" && (action.kind === "pay" || step.key === "confirmedRest") ? due : null;

  async function payNow(registrationId: number) {
    if (readOnly || paying.busy) return;
    setPaying({ busy: true, error: null });
    const answer = await sendJson("/api/konto/maksa", { registrationId });
    const url = answer.data.paymentUrl;
    if (isDone(answer) && typeof url === "string") return navigate(url);
    const error = answer.data.error === "full" ? t.online.full : answer.data.error === "nothing" ? t.online.nothing : answer.status === 429 ? t.online.rate : t.online.failed;
    setPaying({ busy: false, error });
  }

  const payButton =
    online && card.kind === "contact" ? (
      <button
        type="button"
        className={`${ui.btn} ${styles.action}`}
        aria-disabled={readOnly || paying.busy || undefined}
        onClick={() => void payNow(card.registrationId)}
        data-card-action="pay-online"
      >
        {paying.busy ? t.online.starting : fill(online.kind === "balance" ? t.online.payRest : t.online.pay, { amount: formatEUR(online.cents, locale) })}
      </button>
    ) : null;

  /** "Vaata juhiseid" / "Peida juhised": the main button without online payments, the text button with them. */
  const instructions = (main: boolean) => (
    <button
      type="button"
      className={main ? `${ui.btn} ${styles.action}` : styles.second}
      aria-expanded={readOnly ? undefined : open}
      aria-controls={readOnly || !open ? undefined : panelId}
      aria-disabled={readOnly || undefined}
      onClick={() => !readOnly && setOpen((v) => !v)}
      {...(main ? { "data-card-action": "pay" } : { "data-card-transfer": "" })}
    >
      {open ? t.payHide : t.pay}
    </button>
  );

  /** "Tühista või muuda aega" (or, once sent, the line that says so): the main outline button, or the text button next to "Maksa ülejäänud". */
  const changeRequest = (main: boolean) =>
    sent ? (
      <p ref={focusSent ? focusOnMount : undefined} className={styles.sent} role="status" tabIndex={-1} data-card-sent="">
        <Icon name="check" size={18} />
        {t.request.sent}
      </p>
    ) : (
      <button
        type="button"
        className={main ? `${ui.btnOutline} ${styles.action}` : styles.second}
        aria-haspopup="dialog"
        aria-disabled={readOnly || undefined}
        onClick={(e) => !readOnly && card.kind === "contact" && onChangeRequest(card, e.currentTarget)}
        {...(main ? { "data-card-action": "change" } : { "data-card-change": "" })}
      >
        {t.change}
      </button>
    );

  let button: React.ReactNode = null;
  let second: React.ReactNode = null;
  if (action.kind === "pay") {
    if (payButton) {
      button = payButton;
      if (hasPrepayment(pay))
        second = (
          <>
            <p className={styles.or}>{t.online.transfer}</p>
            {instructions(false)}
          </>
        );
    } else button = instructions(true);
  } else if (action.kind === "changeRequest") {
    if (payButton) {
      button = payButton;
      second = changeRequest(false);
    } else button = changeRequest(true);
  } else if (action.kind === "openCourse") {
    button = readOnly ? (
      <a className={`${ui.btn} ${styles.action}`} role="link" aria-disabled="true" data-card-action="open">
        {t.open}
        <Icon name="arrow" />
      </a>
    ) : (
      <Link className={`${ui.btn} ${styles.action}`} href={href(locale, `/konto/kursus/${action.slug}`)} data-card-action="open">
        {t.open}
        <Icon name="arrow" />
      </Link>
    );
  }

  return (
    <article
      className={styles.card}
      aria-labelledby={titleId}
      data-card={cardKey(card)}
      data-step={step.key}
      data-past={isPastCard(card, now) || undefined}
    >
      <span className={styles.tag}>{t.tag[cardTag(card)]}</span>
      {/* tabIndex -1: the dashboard puts the focus here after the card has changed under the student (a refused request) */}
      <h2 id={titleId} className={styles.title} tabIndex={-1}>
        {cardTitle(card, locale, t.untitled)}
      </h2>
      {when && (
        <p className={styles.when}>
          <span>{when.time}</span>
          {when.place && <span className={styles.place}>{when.place}</span>}
        </p>
      )}
      <NextStepLine className={styles.next} step={step} texts={t.next} />
      {progress && (
        <div className={styles.progress} data-card-progress="">
          {progress.done === progress.total ? (
            <p className={styles.finished} data-card-finished="">
              {t.finished}
            </p>
          ) : (
            <>
              <p className={styles.count} aria-hidden="true">
                {fill(t.lessonCount, { done: progress.done, total: progress.total })}
              </p>
              <ProgressBar done={progress.done} total={progress.total} label={fill(t.resumeProgress, { done: progress.done, total: progress.total })} />
            </>
          )}
        </div>
      )}
      {button && <div className={styles.foot}>{button}</div>}
      {paying.error && (
        <p className={styles.payError} role="alert" data-card-pay-error="">
          {paying.error}
        </p>
      )}
      {second && <div className={styles.secondRow}>{second}</div>}
      {action.kind === "pay" && open && !readOnly && pay && (
        <PrepaymentInfo id={panelId} pay={pay} registrationId={action.registrationId} amount={step.vars.amount} t={t.payment} />
      )}
    </article>
  );
}
```

- [ ] **Step 12: Run** `npx vitest run tests/unit/account-cards.test.ts tests/unit/account-pay-dom.test.ts tests/unit/account-dashboard.test.ts tests/unit/account-dashboard-dom.test.ts tests/unit/account-readonly.test.ts tests/unit/account-types.test.ts tests/unit/colour-tokens.test.ts` — expect PASS.

- [ ] **Step 13: The e2e run.**
  1. **`tests/e2e/test.ts`.** The standalone pay page carries no ready mark: in `SITE_PAGE`, add `maksa\/|` to the negative lookahead: `/^\/(?!admin(\/|$)|api\/|media\/|maksa\/|guide(\/|$)|p\/|_next\/)/`, and to its comment "(the pay page /maksa/<token> is standalone HTML: no ready mark either)".
  2. **`tests/e2e/fixtures.ts`.** After `storedHold`, add:

```ts
/** A registration's "Maksa" token (phase 2b): the mail's /maksa/<token> link. */
export async function storedPayToken(registrationId: number): Promise<string> {
  const sql = connect(false);
  try {
    const [row] = await sql<{ token: string }[]>`select pay_token as token from registrations where id = ${registrationId}`;
    return row.token;
  } finally {
    await sql.end();
  }
}
```

  3. **`tests/e2e/pay-page.spec.ts`** (new):

```ts
import { clientEmail, insertAccountFixtures } from "./account";
import { removeClientRows, storedPayments, storedPayToken } from "./fixtures";
import { E2E_MONTONIO } from "./montonio-values";
import { submitsForms, test, expect } from "./test";

// The mail's "Maksa" link (phase 2b, spec 6.3): /maksa/<token> shows the course, the amount and "Maksa 175 €" and changes nothing; the button
// goes to the bank. The registration is a sample client's on the test's own unpublished course (tests/e2e/account.ts), so no public seat moves.

test("/maksa/<token>: the page at 390, 834 and 1440 (no overflow, a 44 px button), opening it starts nothing; the button goes to the bank", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("maksa", info.project.name);
  await removeClientRows(email);
  try {
    const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
    const token = await storedPayToken(f.registrations.awaiting!);
    for (const width of [390, 834, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const res = await page.goto(`/maksa/${token}`);
      expect(res?.status()).toBe(200);
      expect(res?.headers()["cache-control"]).toBe("no-store");
      expect(res?.headers()["referrer-policy"]).toBe("same-origin");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolituse eest tasumine");
      await expect(page.getByText("Kulmude lamineerimine")).toBeVisible();
      await expect(page.getByText("Summa: 175 €")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), String(width)).toBe(true);
      expect((await page.getByRole("button", { name: "Maksa 175 €" }).boundingBox())!.height, String(width)).toBeGreaterThanOrEqual(44);
    }
    expect(await storedPayments(email)).toEqual([]);
    await page.getByRole("button", { name: "Maksa 175 €" }).click();
    await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
    await page.getByRole("button", { name: "Katkesta" }).click();
    await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "failed", amountCents: 17500 }]);
  } finally {
    await removeClientRows(email);
  }
});
```

  4. **`tests/e2e/account-dashboard.spec.ts`.** Import `storedPayments` from `./fixtures` and `E2E_MONTONIO` from `./montonio-values`. The e2e server has online payments (the fake Montonio), so:
     - The first test's title "every card says what to do next, with at most one button; …" becomes "every card says what to do next, with at most one main button; …". Its `expected` table becomes `[string, string, string, string[]][]` with the buttons as a list — `["Maksa 175 €", "Vaata juhiseid"]` for the awaiting card, `["Tühista või muuda aega"]`, `[]`, `[]`, `[]`, `["Ava koolitus"]` for the others — and the loop's two button lines become:

```ts
      if (buttons.length) await expect(actions(c), key).toHaveText(buttons);
      else await expect(actions(c), key).toHaveCount(0);
      await expect(c.locator("[data-card-action]"), key).toHaveCount(buttons.length ? 1 : 0); // one main button at most
```

     - Its last block ("no instructions stored …") becomes:

```ts
    // no instructions stored: with online payments the card still says what is due, and "Maksa 175 €" is its one button (phase 2b)
    await setPrepayment(null);
    await page.reload();
    await expect(card(page, `registration-${reg.awaiting}`).locator("[data-next-step]")).toHaveText("Koha kinnitamiseks tasu ettemaks 175 €.");
    await expect(actions(card(page, `registration-${reg.awaiting}`))).toHaveText(["Maksa 175 €"]);
```

     - Append:

```ts
test("'Maksa 175 €' goes to the bank; paid there, the place is confirmed and 'Maksa ülejäänud 175 €' offers the rest (phase 2b)", async ({ page }, info) => {
  submitsForms();
  const f = await signedInWith(page, "pay", info.project.name, { cards: ["awaiting"] });
  const c = card(page, `registration-${f.registrations.awaiting}`);
  await c.getByRole("button", { name: "Maksa 175 €" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await page.getByRole("button", { name: "Makstud" }).click();
  await expect.poll(() => storedPayments(f.email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
  await page.goto("/konto");
  await expect(c.locator("[data-next-step]")).toHaveText("Koht on kinnitatud. Ülejäänud 175 € tasud koolituspäeval.");
  await expect(actions(c)).toHaveText(["Maksa ülejäänud 175 €", "Tühista või muuda aega"]);
  await expect(c.locator("[data-card-action]")).toHaveCount(1);
  await c.getByRole("button", { name: "Maksa ülejäänud 175 €" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await page.getByRole("button", { name: "Katkesta" }).click();
  await expect.poll(() => storedPayments(f.email)).toEqual([
    { kind: "prepayment", status: "paid", amountCents: 17500 },
    { kind: "balance", status: "failed", amountCents: 17500 },
  ]);
});
```

  5. **`tests/e2e/gate.spec.ts`**, inside `test.describe("a visitor", …)`:

```ts
  test("the mail's Maksa link goes through: /maksa/<token> is the app's page (an unknown token: nothing to pay), and its button refuses a cross-site POST (phase 2b)", async ({ page, request }) => {
    const path = "/maksa/unknown-token-00000000000000000000000000000000";
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    expect(res?.headers()["referrer-policy"]).toBe("same-origin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolituse eest tasumine");
    await expect(page.getByText("Selle registreeringu eest pole praegu midagi tasuda.")).toBeVisible();
    expect((await request.post(path, { headers: { origin: "https://elsewhere.example" }, maxRedirects: 0 })).status()).toBe(403);
  });
```

- [ ] **Step 14: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - `npx playwright test pay-page account-dashboard admin-clients headers` (`admin-clients`: the admin's read-only "view as the student", which renders the same cards without `payOnline`; there is no `account-readonly` e2e spec, only the unit test of step 12) and `E2E_PROD_BUILD=1 npx playwright test pay-page account-dashboard`.
  - `npx playwright test -c playwright.gate.config.ts`.

- [ ] **Step 15: Commit.**

```bash
git add app/src/server/pay-page.ts "app/src/app/maksa/[token]/route.ts" app/src/server/auth.ts app/src/app/api/newsletter/loobu/route.ts app/src/server/payments/start.ts app/src/lib/site-routing.ts app/src/lib/site-gate.ts app/src/middleware.ts app/next.config.ts app/src/server/account-input.ts app/src/server/account-api.ts "app/src/app/api/konto/[[...path]]/route.ts" app/src/server/client-data.ts app/src/domain/account-cards.ts app/src/components/account app/tests
git commit -m "feat(payments): pay later — the /maksa page, POST /api/konto/maksa, and Maksa / Maksa ülejäänud on the cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The way back — `/api/payments/return` and the static `/makse` page

Spec section 6.5 (and 10: the return and `/makse` stay behind the gate). Montonio's `returnUrl` is `/api/payments/return?order-token=…`. The route verifies the token, runs `settleToken` (racing the webhook is safe: Task 3's door) and answers 303 to `/{locale}/makse#tulemus=<makstud|pooleli|katkestatud>&liik=<registreering|ekoolitus>[&maksa=<pay_token>][&kursus=<slug>]`. The fragment never reaches a server or a cache; `/makse` is static and reads it in the browser. A token that fails verification: `/makse#tulemus=katkestatud`, never an error page.

**Two readings made binding here:**
- **"Proovi uuesti" on "pooleli" too.** Montonio returns with `PENDING` when the payer presses "cancel" at the bank (the order is still open until its window ends; Rempire's acceptance run landed exactly there with nothing to press). So the retry is offered on `katkestatud` and on a `pooleli` whose row is still `pending`; never on a `held` one (the money is at Montonio: a retry could charge her twice). For a registration the retry is `/maksa/<pay_token>`, for an e-course the cart. A retry of a `pending` row inside its 30-minute window re-sends that same order (Task 4, the double-payment rule): it can never leave her two orders to pay.
- **`kursus=<slug>` for an e-course** (the spec names only `maksa`): the page needs the course for "Ava e-koolitus" after a paid purchase and for the cart's retry. It is in the fragment only when one of the two is shown.

**Files:**
- Modify: `app/src/domain/payments.ts` (the fragment), `app/src/server/payments/routes.ts` (`handleReturn`), `app/src/lib/site-routing.ts` (`/makse` is a page), `app/next.config.ts`
- Create: `app/src/app/api/payments/return/route.ts`, `app/src/app/[locale]/(site)/makse/page.tsx`, `app/src/components/site/PaymentResult.tsx`
- Test: `app/tests/db/payments-return.test.ts`, `app/tests/unit/payment-result.test.ts` (new); `app/tests/unit/site-routing.test.ts`, `site-gate.test.ts`, `next-config.test.ts` (extend)
- E2E: `app/tests/e2e/course.spec.ts`, `app/tests/e2e/pay-page.spec.ts`, `app/tests/e2e/account-dashboard.spec.ts` (they now land on `/makse`), `app/tests/e2e/gate.spec.ts`

**Interfaces:**
- Consumes: `settleToken`, `PaymentRouteDeps`, `paymentContext` (Task 3); `JwtError`, `OrderToken` (Task 2); `payment.result.*` (Task 3's dictionary).
- Produces, from `src/domain/payments.ts`: `type PaymentOutcome = "makstud" | "pooleli" | "katkestatud"`; `type ResultView = { outcome: PaymentOutcome; kind: "registreering" | "ekoolitus" | null; payToken: string | null; course: string | null }`; `resultFragment(v: ResultView): string`; `parseResultFragment(hash: string): ResultView | null`.
- Produces, from `src/server/payments/routes.ts`: `returnTarget(locale: "et" | "ru", view: ResultView): string`; `handleReturn(request: Request, deps: PaymentRouteDeps): Promise<Response>`.
- Produces, from `src/components/site/PaymentResult.tsx`: `type PaymentResultTexts = { title: string; paid: string; pending: string; cancelled: string; retry: string; openCourse: string; account: string }`; `PaymentResult({ locale, t })`.

- [ ] **Step 1: Write the failing fragment and page tests** `tests/unit/payment-result.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PaymentResult, type PaymentResultTexts } from "@/components/site/PaymentResult";
import { parseResultFragment, resultFragment } from "@/domain/payments";
import { getDict } from "@/i18n/locales";

// /makse (phase 2b, spec 6.5): where the bank sends the payer back. The result is in the fragment (#tulemus=…&liik=…[&maksa=…][&kursus=…]),
// which no server or cache sees; the static page reads it in the browser and says what happened, with "Proovi uuesti" or the way on.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "AbC_d-0123456789012345678901234567890123";

describe("the fragment", () => {
  test("written and read back; what cannot be ours is dropped", () => {
    const view = { outcome: "katkestatud" as const, kind: "registreering" as const, payToken: TOKEN, course: null };
    expect(resultFragment(view)).toBe(`tulemus=katkestatud&liik=registreering&maksa=${TOKEN}`);
    expect(parseResultFragment(`#${resultFragment(view)}`)).toEqual(view);
    expect(parseResultFragment("#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus")).toEqual({ outcome: "makstud", kind: "ekoolitus", payToken: null, course: "kulmumeistri-e-koolitus" });
    expect(parseResultFragment("tulemus=pooleli")).toEqual({ outcome: "pooleli", kind: null, payToken: null, course: null });
    expect(parseResultFragment("#tulemus=makstud&liik=x&maksa=%3Cscript%3E&kursus=Not%20A%20Slug")).toEqual({ outcome: "makstud", kind: null, payToken: null, course: null });
    for (const hash of ["", "#", "#main", "#tulemus=paid", "#liik=registreering"]) expect(parseResultFragment(hash), hash).toBeNull();
  });
});

describe("the page", () => {
  const d = getDict("et");
  const t: PaymentResultTexts = { ...d.payment.result, account: d.account.shell.courses };
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.location.hash = "";
  });
  const show = async (hash: string, locale: "et" | "ru" = "et", texts = t) => {
    window.location.hash = hash;
    await act(async () => root.render(createElement(PaymentResult, { locale, t: texts })));
  };
  const links = () => [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

  test("makstud: 'Makse õnnestus. …' and Minu koolitused; an e-course: 'Ava e-koolitus'", async () => {
    await show("#tulemus=makstud&liik=registreering");
    expect(container.querySelector("h1")?.textContent).toBe("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    await show("#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus");
    expect(links()).toEqual([["Ava e-koolitus", "/konto/kursus/kulmumeistri-e-koolitus"]]);
  });

  test("katkestatud and pooleli: the sentence, 'Proovi uuesti' (the /maksa page, or the cart) and Minu koolitused", async () => {
    await show(`#tulemus=katkestatud&liik=registreering&maksa=${TOKEN}`);
    expect(container.querySelector("h1")?.textContent).toBe("Makse jäi tegemata.");
    expect(links()).toEqual([["Proovi uuesti", `/maksa/${TOKEN}`], ["Minu koolitused", "/konto"]]);
    await show("#tulemus=pooleli&liik=ekoolitus&kursus=kulmumeistri-e-koolitus");
    expect(container.querySelector("h1")?.textContent).toBe("Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.");
    expect(links()).toEqual([["Proovi uuesti", "/ostukorv?kursus=kulmumeistri-e-koolitus"], ["Minu koolitused", "/konto"]]);
    await show("#tulemus=katkestatud");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
  });

  test("no result in the address: the page's title and Minu koolitused; Russian links under /ru", async () => {
    await show("");
    expect(container.querySelector("h1")?.textContent).toBe("Makse");
    const ru = getDict("ru");
    await show("#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus", "ru", { ...ru.payment.result, account: ru.account.shell.courses });
    expect(container.querySelector("h1")?.textContent).toBe("Оплата прошла. Мы отправили вам подтверждение по e-mail.");
    expect(links()).toEqual([["Открыть онлайн-курс", "/ru/konto/kursus/kulmumeistri-e-koolitus"]]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/unit/payment-result.test.ts`.

- [ ] **Step 3: The fragment** — append to `src/domain/payments.ts`:

```ts
/** What the bank's way back says (spec 6.5): paid, still pending, or not paid. */
export type PaymentOutcome = "makstud" | "pooleli" | "katkestatud";

/**
 * What /makse shows: the outcome, what was paid for, and the way on — the registration's "Maksa" token for "Proovi uuesti", or the e-course's
 * slug ("Ava e-koolitus" after a purchase, the cart for a retry). null where there is none.
 */
export type ResultView = { outcome: PaymentOutcome; kind: "registreering" | "ekoolitus" | null; payToken: string | null; course: string | null };

/** /makse's fragment: tulemus, liik, and maksa or kursus when they are given. */
export function resultFragment(v: ResultView): string {
  const q = new URLSearchParams({ tulemus: v.outcome });
  if (v.kind) q.set("liik", v.kind);
  if (v.payToken) q.set("maksa", v.payToken);
  if (v.course) q.set("kursus", v.course);
  return q.toString();
}

const OUTCOMES: readonly string[] = ["makstud", "pooleli", "katkestatud"];

/** /makse's fragment read back, or null when it carries no result. A value that cannot be ours (not a token, not a slug) is dropped. */
export function parseResultFragment(hash: string): ResultView | null {
  const q = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const outcome = q.get("tulemus");
  if (!outcome || !OUTCOMES.includes(outcome)) return null;
  const kind = q.get("liik");
  const token = q.get("maksa");
  const course = q.get("kursus");
  return {
    outcome: outcome as PaymentOutcome,
    kind: kind === "registreering" || kind === "ekoolitus" ? kind : null,
    payToken: token && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null,
    course: course && course.length <= 120 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(course) ? course : null,
  };
}
```

- [ ] **Step 4: The page's content** — create `src/components/site/PaymentResult.tsx`:

```tsx
"use client";

import { useSyncExternalStore } from "react";
import { parseResultFragment } from "@/domain/payments";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { Icon } from "./Icon";
import { Notice } from "./Notice";
import ui from "./ui.module.css";

/** The result's texts (payment.result) and the account's "Minu koolitused". */
export type PaymentResultTexts = { title: string; paid: string; pending: string; cancelled: string; retry: string; openCourse: string; account: string };

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/**
 * /makse (phase 2b, spec 6.5): the bank's way back. The page is static and the same for everyone; the result is in the fragment the return
 * route wrote (domain/payments.ts resultFragment), read here after hydration. makstud: "Makse õnnestus. …" and Minu koolitused (an e-course:
 * "Ava e-koolitus"); pooleli and katkestatud: their sentence, "Proovi uuesti" when the fragment gives the way (the /maksa page of the
 * registration, or the cart of the e-course; full page loads: /maksa is a route handler) and Minu koolitused. No result: the title alone.
 */
export function PaymentResult({ locale, t }: { locale: Locale; t: PaymentResultTexts }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  const view = parseResultFragment(hash);
  const to = (path: string) => href(locale, path);
  const account = { href: to("/konto"), label: t.account };
  if (!view) {
    return (
      <div data-payment-result="">
        <Notice title={t.title} links={[account]} />
      </div>
    );
  }
  const text = view.outcome === "makstud" ? t.paid : view.outcome === "pooleli" ? t.pending : t.cancelled;
  const retryHref =
    view.outcome === "makstud" ? null : view.kind === "registreering" && view.payToken ? `/maksa/${view.payToken}` : view.kind === "ekoolitus" && view.course ? to(`/ostukorv?kursus=${view.course}`) : null;
  const links = view.outcome === "makstud" && view.kind === "ekoolitus" && view.course ? [{ href: to(`/konto/kursus/${view.course}`), label: t.openCourse }] : [account];
  return (
    <div data-payment-result={view.outcome}>
      <Notice title={text} links={links}>
        {retryHref && (
          <a className={ui.btn} href={retryHref} data-payment-retry="">
            {t.retry}
            <Icon name="arrow" />
          </a>
        )}
      </Notice>
    </div>
  );
}
```

- [ ] **Step 5: Run** `npx vitest run tests/unit/payment-result.test.ts` — expect PASS.

- [ ] **Step 6: Write the failing return tests** `tests/db/payments-return.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { insertPayment, attachOrder } from "@/db/queries/payments";
import { courses } from "@/db/schema";
import { handleReturn } from "@/server/payments/routes";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// GET /api/payments/return?order-token=… (phase 2b, spec 6.5): the token verified, the payment settled through the one door, and a 303 to the
// static /makse page of the payment's language with the result in the fragment. A token that cannot be verified: katkestatud, no way on.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const back = (token: string) => new Request(`${SITE}/api/payments/return?order-token=${encodeURIComponent(token)}`);
const target = (res: Response) => [res.status, res.headers.get("location"), res.headers.get("cache-control"), res.headers.get("referrer-policy")];

test("without payments: 404", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect((await handleReturn(back("x"), { ...deps, montonio: null })).status).toBe(404);
});

test("PAID: settled (the webhook may come later or never) and 303 to /makse#tulemus=makstud; Russian to /ru/makse", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const p = await pendingPayment(db, await registrationOn(db, c));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(target(await handleReturn(back(orderToken(p)), deps))).toEqual([303, `${SITE}/makse#tulemus=makstud&liik=registreering`, "no-store", "no-referrer"]);
  const ru = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com", locale: "ru" }));
  expect((await handleReturn(back(orderToken(ru)), deps)).headers.get("location")).toBe(`${SITE}/ru/makse#tulemus=makstud&liik=registreering`);
});

test("ABANDONED: katkestatud with the registration's 'Maksa' token; PENDING (a cancel at the bank): pooleli with it too; held: pooleli without", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c);
  const { deps } = settleDeps(db, m.montonio, NOW);
  const a = await pendingPayment(db, r);
  expect((await handleReturn(back(orderToken(a, { paymentStatus: "ABANDONED" })), deps)).headers.get("location")).toBe(`${SITE}/makse#tulemus=katkestatud&liik=registreering&maksa=${r.payToken}`);
  const b = await pendingPayment(db, r);
  expect((await handleReturn(back(orderToken(b, { paymentStatus: "PENDING" })), deps)).headers.get("location")).toBe(`${SITE}/makse#tulemus=pooleli&liik=registreering&maksa=${r.payToken}`);
  const held = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }));
  expect((await handleReturn(back(orderToken(held, { grandTotal: 1 })), deps)).headers.get("location")).toBe(`${SITE}/makse#tulemus=pooleli&liik=registreering`);
});

test("an e-course: makstud with its slug ('Ava e-koolitus'); katkestatud with its slug (the cart's retry)", async () => {
  const m = stubMontonio();
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000 })
    .returning();
  const { deps } = settleDeps(db, m.montonio, NOW);
  const buy = async (email: string) => {
    const p = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email, name: "Kati Tamm", locale: "et", amountCents: 19000 }, NOW);
    await attachOrder(db, p.id, `uuid-${p.id}`, NOW);
    return { ...p, providerUuid: `uuid-${p.id}` };
  };
  expect((await handleReturn(back(orderToken(await buy("kati@example.test"))), deps)).headers.get("location")).toBe(`${SITE}/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus`);
  expect((await handleReturn(back(orderToken(await buy("mari@example.test"), { paymentStatus: "ABANDONED" })), deps)).headers.get("location")).toBe(`${SITE}/makse#tulemus=katkestatud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus`);
});

test("a token that cannot be verified, none, or an unknown reference: /makse#tulemus=katkestatud, nothing else", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  for (const req of [back("not-a-token"), new Request(`${SITE}/api/payments/return`), back(orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "u" }))])
    expect(target(await handleReturn(req, deps))).toEqual([303, `${SITE}/makse#tulemus=katkestatud`, "no-store", "no-referrer"]);
});

test("a token in doubt that Montonio cannot confirm, or a database failure: pooleli (the webhook and the daily check settle it later)", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect((await handleReturn(back(orderToken(p, { accessKey: "someone-else" })), deps)).headers.get("location")).toBe(`${SITE}/makse#tulemus=pooleli&liik=registreering`);
  const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
  expect((await handleReturn(back(orderToken(p)), { ...deps, db: broken })).headers.get("location")).toBe(`${SITE}/makse#tulemus=pooleli`);
});
```

- [ ] **Step 7: Run it — expect FAIL**: `npx vitest run tests/db/payments-return.test.ts` (`handleReturn` does not exist).

- [ ] **Step 8: The return** — in `src/server/payments/routes.ts`:
  1. Imports: add `import { paymentContext } from "@/db/queries/payments";` and `import { resultFragment, type PaymentOutcome, type ResultView } from "@/domain/payments";`.
  2. Append:

```ts
/** Where the return sends the payer: /makse (Estonian) or /ru/makse, the result in the fragment (spec 6.5: no server or cache sees it). */
export const returnTarget = (locale: "et" | "ru", view: ResultView): string => `${locale === "ru" ? "/ru" : ""}/makse#${resultFragment(view)}`;

const NOTHING: Omit<ResultView, "outcome"> = { kind: null, payToken: null, course: null };

/** A 303 to `target` on this request's own origin; never cached, and the token in this address is passed on as no Referer. */
const seeOther = (request: Request, target: string): Response =>
  new Response(null, { status: 303, headers: { location: new URL(target, new URL(request.url).origin).toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });

/**
 * GET /api/payments/return?order-token=… — Montonio sends the payer back here, paid or not (also after a cancel at the bank). The token is
 * verified and settled through the one door (settle.ts; the webhook may come before, after or never). Then a 303 to /makse of the payment's
 * language: makstud (paid); pooleli (pending, held, or a token in doubt that Montonio could not confirm); katkestatud (failed or refunded).
 * "Proovi uuesti" is offered (`maksa`, or an e-course's `kursus`) on katkestatud and on a pooleli whose row is still pending — Montonio
 * answers a cancel at the bank with PENDING — never on a held one. A token that cannot be verified, an unknown reference: katkestatud with
 * nothing more; a database failure: pooleli. Never an error page. 404 without payments.
 */
export async function handleReturn(request: Request, deps: PaymentRouteDeps): Promise<Response> {
  const montonio = deps.montonio;
  if (!montonio) return json(404, { ok: false });
  const params = new URL(request.url).searchParams;
  // the documented name is `order-token`; the snake_case twin is taken too (some of Montonio's plugins send it)
  const raw = params.get("order-token") ?? params.get("order_token") ?? "";
  let token: OrderToken;
  try {
    token = montonio.verifyOrderToken(raw);
  } catch (e) {
    logNote(`[payments] return: a token that cannot be verified (${e instanceof JwtError ? e.code : "error"})`);
    return seeOther(request, returnTarget("et", { outcome: "katkestatud", ...NOTHING }));
  }
  try {
    const result = await settleToken({ ...deps, montonio }, token);
    if (result.kind === "unknown") return seeOther(request, returnTarget("et", { outcome: "katkestatud", ...NOTHING }));
    const p = result.payment;
    const outcome: PaymentOutcome =
      result.kind === "unconfirmed" ? "pooleli" : p.status === "paid" ? "makstud" : p.status === "pending" || p.status === "held" ? "pooleli" : "katkestatud";
    const retry = outcome === "katkestatud" || (result.kind === "done" && p.status === "pending");
    const ecourse = p.kind === "ecourse";
    const ctx = await paymentContext(deps.db, p.id);
    return seeOther(
      request,
      returnTarget(p.locale, {
        outcome,
        kind: ecourse ? "ekoolitus" : "registreering",
        payToken: !ecourse && retry ? ctx.payToken : null,
        course: ecourse && (outcome === "makstud" || retry) ? (ctx.course?.slug ?? null) : null,
      }),
    );
  } catch (e) {
    logFailure("[payments] return: not settled", e);
    return seeOther(request, returnTarget("et", { outcome: "pooleli", ...NOTHING }));
  }
}
```

  3. Create `src/app/api/payments/return/route.ts`:

```ts
import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { paymentProvider } from "@/server/payments/montonio";
import { handleReturn } from "@/server/payments/routes";
import { revalidatePublic } from "@/server/public-cache";
import { hostOrigin, linkBase } from "@/server/site";

export const dynamic = "force-dynamic";
/** A token in doubt asks Montonio (15 s at most). */
export const maxDuration = 30;

/**
 * GET /api/payments/return?order-token=… — Montonio's returnUrl (server/payments/routes.ts handleReturn). Behind the coming-soon gate like the
 * rest of the site (spec 10: an admin with the preview cookie only, before the launch). The mail links use the request's own origin when it
 * is one of ours. Whatever fails here, the payer lands on /makse ("pooleli"): never an error page.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const env = { ...serverEnv(), KV: serverKv() };
    return await handleReturn(request, {
      db: getDb(),
      env,
      now: new Date(),
      siteUrl: linkBase(hostOrigin(request.headers), env.SITE_URL),
      later: (task) => after(() => task().catch((e) => logFailure("[payments] background task failed", e))),
      changed: revalidatePublic,
      montonio: paymentProvider(),
    });
  } catch (e) {
    logFailure("[payments] return failed", e);
    return new Response(null, { status: 303, headers: { location: new URL("/makse#tulemus=pooleli", request.url).toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
}
```

- [ ] **Step 9: Run** `npx vitest run tests/db/payments-return.test.ts` — expect PASS.

- [ ] **Step 10: The page `/makse`.**
  1. Create `src/app/[locale]/(site)/makse/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaymentResult } from "@/components/site/PaymentResult";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.payment.result.title} — ${d.common.siteName}` };
}

/**
 * /makse (phase 2b, spec 6.5): where the bank sends the payer back (api/payments/return). A static page like every public page, the same for
 * everyone and cached: it reads only `params`; the result is in the address's fragment, read in the browser (components/site/PaymentResult.tsx).
 */
export default async function PaymentResultPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return <PaymentResult locale={locale} t={{ ...d.payment.result, account: d.account.shell.courses }} />;
}
```

  2. **`src/lib/site-routing.ts`.** Add `"/makse"` to `STATIC_PAGES` (after `"/koolituskalender"`), and to the comment above it "the payment's result page (/makse, phase 2b)".
  3. **`tests/unit/site-routing.test.ts`.** In "the known pages are exactly the pages of app/[locale]/(site)", add `"/makse"` to the expected list; in "public pages: …", add `expect(route("/makse")).toEqual({ kind: "page", page: "/et/makse", rewritten: true });` and `expect(route("/ru/makse")).toEqual({ kind: "page", page: "/ru/makse", rewritten: false });`.
  4. **`tests/unit/site-gate.test.ts`.** Add `"/makse", "/ru/makse",` to `GATED` (the result page is the site's: an admin's preview cookie only, before the launch).
  5. **`next.config.ts`** — after the rule for `/api/konto/verify`, add:

```ts
      // the bank's way back (api/payments/return, phase 2b): the signed order token is in the address, so it is never sent on as a Referer
      { source: "/api/payments/return", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
```

     and in `tests/unit/next-config.test.ts`'s phase 2b test add `expect(valueFor(rules, "/api/payments/return", "referrer-policy")).toBe("no-referrer");` and `expect(valueFor(rules, "/api/payments/notify", "referrer-policy")).toBe("strict-origin-when-cross-origin");`.
  6. Run `npx vitest run tests/unit/site-routing.test.ts tests/unit/site-gate.test.ts tests/unit/next-config.test.ts` — PASS.

- [ ] **Step 11: The e2e run lands on `/makse` now.**
  1. **`tests/e2e/course.spec.ts`**, in the group registration test, after `await page.getByRole("button", { name: "Katkesta" }).click();` add:

```ts
  await page.waitForURL(/\/makse#tulemus=katkestatud&liik=registreering&maksa=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse jäi tegemata.");
  await expect(page.getByRole("link", { name: "Proovi uuesti" })).toHaveAttribute("href", /^\/maksa\/[A-Za-z0-9_-]{43}$/);
```

  2. **`tests/e2e/pay-page.spec.ts`**, after the "Katkesta" click, add `await page.waitForURL(/\/makse#tulemus=katkestatud/);` and `await expect(page.getByRole("link", { name: "Proovi uuesti" })).toHaveAttribute("href", \`/maksa/${token}\`);`.
  3. **`tests/e2e/account-dashboard.spec.ts`**, in the "'Maksa 175 €' goes to the bank" test, after the "Makstud" click add `await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering/);` and `await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");`.
  4. **`tests/e2e/gate.spec.ts`**, inside `test.describe("a visitor", …)`:

```ts
  test("the bank's way back and the result page are the site's: gated for a visitor (phase 2b)", async ({ page, request }) => {
    const res = await request.get("/api/payments/return?order-token=x", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    expect((await page.goto("/makse"))?.status()).toBe(200);
    await expectComingSoon(page);
  });
```

- [ ] **Step 12: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - `npx playwright test course pay-page account-dashboard pages shell` and `E2E_PROD_BUILD=1 npx playwright test course pay-page account-dashboard`.
  - `npx playwright test -c playwright.gate.config.ts`.
  - `next build` lists `/[locale]/makse` as prerendered or static (● / ○), never ƒ.

- [ ] **Step 13: Commit.**

```bash
git add app/src/domain/payments.ts app/src/server/payments/routes.ts app/src/app/api/payments/return "app/src/app/[locale]/(site)/makse" app/src/components/site/PaymentResult.tsx app/src/lib/site-routing.ts app/next.config.ts app/tests
git commit -m "feat(payments): the way back — /api/payments/return settles and lands on the static /makse page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The e-course purchase — the cart's form, and access with a login link when it is paid

Spec sections 6.4 (D3, D4), 6.2.3 and 6.2.4 (the e-course's mail).
- **The cart** (static, one cached page per course) replaces "Makse lisandub peagi" and the purchase-interest form with a form when payments are on: name and e-mail (filled from the account when this browser is signed in, read in the browser from `/api/konto/me`), the terms box (required, "Õppetingimused", as on the registration form), the newsletter box (unticked), "Maksa {hind}". Without payments the cart is today's; when Montonio is down at the moment of buying, the form gives way to today's purchase-interest form, so nothing is lost.
- **The server action** (`buyEcourse`) runs the forms' pipeline (honeypot, validation, 5 per 10 minutes per IP), checks a published e-course with a price, and creates a `payments` row (`ecourse`, the price, the newsletter wish; its time is the terms' acceptance) and Montonio's order. No account, no access and no mail before the payment.
- **Paid** (Task 3's door, in the paid row's own transaction): the client of the e-mail is found or created (`addClient`: the address lock, her earlier records linked); a new client gets the payer's name and the payment's language, an existing one gets the name only when she has none; access as "Ava ligipääs" gives it (`grantAccess`, `by: "payment"`, until the end of today + the course's access months; a renewal moves the expiry); the payment row is linked to her. After the response: "E-koolitus on avatud — {kursus}" with a live login code (`issueClientLogin`; "Logi sisse" opens `verifyLink`), Maria's notice, and the newsletter sign-up when the box was ticked (the one-step path, `subscribeLater`).

**Files:**
- Modify: `app/src/server/forms.ts`, `app/src/server/submit.ts`, `app/src/server/actions/public.ts`, `app/src/server/payments/start.ts`, `app/src/server/payments/settle.ts`, `app/src/server/account-mail.ts`, `app/src/app/[locale]/(site)/ostukorv/cart.tsx`
- Create: `app/src/server/payments/grant.ts`, `app/src/components/site/EcoursePurchase.tsx`
- Test: `app/tests/db/payments-ecourse.test.ts`, `app/tests/unit/ecourse-purchase-dom.test.ts` (new); `app/tests/unit/forms.test.ts` (extend)
- E2E: `app/tests/e2e/course.spec.ts` (the cart), `app/tests/e2e/forms.spec.ts` (the rate-limit test moves to the contact form: the cart's interest form is gone while payments are on)

**Interfaces:**
- Consumes: `insertPayment` (Task 3); `order` (with `again`), `liveAttempt`, `StartDeps`, `StartResult` (Task 4, the same file); `settlePayment`'s `paid` (Task 3); `navigate` (Task 4); `payment.pay`, `payment.starting`, `payment.mail.*` (Task 3); `addClient`, `grantAccess` (`server/admin-clients.ts`), `defaultExpiryDate` (`domain/client-access.ts`), `issueClientLogin` (`server/client-auth.ts`).
- Produces, from `src/server/forms.ts`: `ecoursePurchaseSchema`; `parseEcoursePurchase(fd: FormData): Parsed<{ course: string; name: string; email: string; terms: "on"; wantsNewsletter: boolean; locale: "et" | "ru" }>`.
- Produces, from `src/server/submit.ts`: `FormName` gains `"ecourse"`; `handleEcoursePurchase(deps: Deps, formData: FormData): Promise<ActionResult>`; `subscribeLater` is exported: `subscribeLater(deps: Deps, form: FormName, wish: { email: string; locale: "et" | "ru" }): Promise<void>`.
- Produces, from `src/server/actions/public.ts`: `buyEcourse(formData: FormData): Promise<ActionResult>`.
- Produces, from `src/server/payments/start.ts`: `startEcoursePayment(deps: StartDeps, input: { courseId: number; amountCents: number; email: string; name: string; locale: "et" | "ru"; newsletter: boolean }): Promise<StartResult>`.
- Produces, from `src/server/payments/grant.ts`: `type Grant = { clientId: number; created: boolean; courseSlug: string; courseTitle: I18n; expiresAt: Date }`; `grantPurchase(tx: Tx, payment: Payment, now: Date): Promise<Grant | null>`.
- Produces, from `src/server/account-mail.ts`: `type EcourseOpenInput = { siteUrl: string; email: string; name: string; locale: Locale; course: I18n; expiresAt: Date; login: LoginCode | null }`; `ecourseOpenMail(input: EcourseOpenInput): Mail`.
- Produces, from `src/components/site/EcoursePurchase.tsx`: `type EcoursePurchaseTexts`; `EcoursePurchase({ course, locale, t, fallback })` (`[data-ecourse-form]`).

- [ ] **Step 1: Write the failing tests.**
  1. **`tests/unit/forms.test.ts`.** Import `parseEcoursePurchase` and append:

```ts
describe("the e-course purchase (phase 2b, D3)", () => {
  const fd = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  test("name, e-mail, the terms box (required) and the newsletter box; the course is a slug", () => {
    expect(parseEcoursePurchase(fd({ course: "kulmumeistri-e-koolitus", name: "  Kati   Tamm ", email: " Kati@Example.com ", terms: "on", newsletter: "on", locale: "ru" }))).toEqual({
      ok: true,
      data: { course: "kulmumeistri-e-koolitus", name: "Kati Tamm", email: "kati@example.com", terms: "on", wantsNewsletter: true, locale: "ru" },
    });
    const missing = parseEcoursePurchase(fd({ course: "Not a slug", name: "", email: "x" }));
    expect(missing).toEqual({ ok: false, errors: { form: "invalid", name: "required", email: "invalid", terms: "required" } });
    expect(parseEcoursePurchase(fd({ course: "k", name: "K", email: "k@example.com", terms: "on" }))).toMatchObject({ ok: true, data: { wantsNewsletter: false, locale: "et" } });
  });
});
```

  2. **`tests/db/payments-ecourse.test.ts`** (new):

```ts
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clientLoginTokens, clients, courseAccess, courses, payments, subscribers } from "@/db/schema";
import { formatDate } from "@/i18n/format";
import type { PublicChange } from "@/server/cache-targets";
import type { Env } from "@/server/notify";
import { settleToken } from "@/server/payments/settle";
import { handleEcoursePurchase, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { orderToken, settleDeps, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The e-course purchase (phase 2b, spec 6.4, 6.2.3): the cart's action creates only a pending payment and Montonio's order; when it is paid,
// the client is found or created, the course opens for her (by "payment"), the newsletter follows when ticked, and she gets "E-koolitus on
// avatud" with a login code. Nothing happens before the payment.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
let ecourseId: number;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  const [c] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
    .returning();
  ecourseId = c.id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function formDeps(montonio: Deps["montonio"]) {
  const changes: PublicChange[] = [];
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE };
  const d: Deps = { db, env, ip: "203.0.113.9", siteUrl: SITE, now: NOW, later: () => {}, changed: (c) => void changes.push(c), montonio };
  return d;
}
const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ course: "kulmumeistri-e-koolitus", name: "Kati Tamm", email: "kati@example.com", terms: "on", locale: "et", ...over })) fd.set(k, v);
  return fd;
};

/** Buys the e-course as `email` and settles its PAID token; the settlement's deps (flush, the mails). */
async function buyAndPay(m: ReturnType<typeof stubMontonio>, over: Record<string, string> = {}) {
  expect(await handleEcoursePurchase(formDeps(m.montonio), form(over))).toMatchObject({ ok: true });
  const [p] = await db.select().from(payments).orderBy(desc(payments.id)).limit(1);
  const s = settleDeps(db, m.montonio, NOW);
  await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
  await s.flush();
  return { p, ...s };
}

describe("the purchase (before the payment)", () => {
  test("a pending ecourse row of 190 € with the payer as entered and her newsletter wish; Montonio's order; nothing else", async () => {
    const m = stubMontonio();
    const result = await handleEcoursePurchase(formDeps(m.montonio), form({ newsletter: "on", locale: "ru" }));
    const [p] = await db.select().from(payments);
    expect(result).toEqual({ ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` });
    expect(p).toMatchObject({ kind: "ecourse", status: "pending", amountCents: 19000, courseId: ecourseId, registrationId: null, clientId: null, email: "kati@example.com", name: "Kati Tamm", locale: "ru", newsletter: true });
    expect(m.state.orders).toEqual([expect.objectContaining({ merchantReference: p.reference, grandTotal: 190, locale: "ru" })]);
    expect([await db.select().from(clients), await db.select().from(courseAccess), await db.select().from(subscribers)]).toEqual([[], [], []]);
    expect(m.mails()).toEqual([]);
  });

  test("not a published e-course with a price: form invalid; no payments or Montonio down: form unavailable", async () => {
    const m = stubMontonio();
    await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "K" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 100 });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ course: "kontakt" }))).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ course: "olematu" }))).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(await handleEcoursePurchase(formDeps(null), form())).toEqual({ ok: false, errors: { form: "unavailable" } });
    m.state.down = true;
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toEqual({ ok: false, errors: { form: "unavailable" } });
    expect((await db.select().from(payments)).map((p) => p.status)).toEqual(["failed"]);
  });

  test("'Maksa' again while the purchase's order is open re-sends it: one row, one reference, the latest name and box; another address is another purchase (the double-payment fix)", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ name: "Kati Kask", newsletter: "on" }))).toMatchObject({ ok: true });
    const [p, ...none] = await db.select().from(payments);
    expect(none).toEqual([]);
    expect(p).toMatchObject({ status: "pending", name: "Kati Kask", newsletter: true, amountCents: 19000 });
    expect(m.state.orders.map((o) => o.merchantReference)).toEqual([p.reference, p.reference]);
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ email: "mari@example.com" }))).toMatchObject({ ok: true });
    expect(await db.select().from(payments)).toHaveLength(2);
  });
});

describe("paid", () => {
  test("a new client with her name and language, the course open until the end of today + 6 months (by payment), the row linked; the mail carries a login code", async () => {
    const m = stubMontonio();
    const { p } = await buyAndPay(m, { locale: "ru" });
    const [client] = await db.select().from(clients);
    expect([client.email, client.name, client.locale]).toEqual(["kati@example.com", "Kati Tamm", "ru"]);
    const [access] = await db.select().from(courseAccess);
    expect([access.clientId, access.courseId, access.grantedBy, access.revokedAt, formatDate(access.expiresAt, "et")]).toEqual([client.id, ecourseId, "payment", null, "09.04.2027"]);
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0]).toMatchObject({ status: "paid", clientId: client.id });
    const [mine, maria] = m.mails();
    expect([mine.to, mine.subject]).toEqual(["kati@example.com", "Онлайн-курс открыт — Онлайн-курс бровиста"]);
    expect(mine.text).toContain("Доступ до 09.04.2027.");
    expect(mine.text).toMatch(/\n\d{6}\n/); // the live login code
    expect(await db.select().from(clientLoginTokens)).toHaveLength(1);
    expect(maria.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus, 190 €");
    expect(maria.text).toContain("E-koolitus on avatud.");
  });

  test("an existing client keeps her name and language; her open access is renewed (the expiry moved, by payment)", async () => {
    const m = stubMontonio();
    const [client] = await db.insert(clients).values({ email: "kati@example.com", name: "Katrin", locale: "et" }).returning();
    await db.insert(courseAccess).values({ clientId: client.id, courseId: ecourseId, grantedBy: "admin@example.test", expiresAt: new Date("2026-12-01T21:59:59.999Z") });
    await buyAndPay(m, { name: "Kati Tamm", locale: "ru" });
    const [after] = await db.select().from(clients);
    expect([after.id, after.name, after.locale]).toEqual([client.id, "Katrin", "et"]);
    const [access] = await db.select().from(courseAccess);
    expect([access.grantedBy, formatDate(access.expiresAt, "et")]).toEqual(["payment", "09.04.2027"]);
    expect(await db.select().from(courseAccess)).toHaveLength(1);
  });

  test("the newsletter box: subscribed when paid (one step), not before; unticked: no subscriber", async () => {
    const m = stubMontonio();
    await buyAndPay(m, { newsletter: "on" });
    expect((await db.select().from(subscribers)).map((s) => [s.email, s.confirmedAt !== null])).toEqual([["kati@example.com", true]]);
    await buyAndPay(m, { email: "mari@example.com" });
    expect(await db.select().from(subscribers)).toHaveLength(1);
  });

  test("a sample address: the course opens, no mail and no login code; Maria is told", async () => {
    const m = stubMontonio();
    await buyAndPay(m, { email: "kati@example.test" });
    expect(await db.select().from(courseAccess)).toHaveLength(1);
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(await db.select().from(clientLoginTokens)).toEqual([]);
  });

  test("the course was deleted before the payment came: paid, nothing opened, Maria told to open it by hand or refund", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    await db.delete(courses).where(eq(courses.id, ecourseId));
    const s = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid", clientId: null } });
    await s.flush();
    expect(await db.select().from(clients)).toEqual([]);
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(m.mails()[0].text).toContain("E-koolitust ei avatud");
  });
});
```

  3. Run them — FAIL (`parseEcoursePurchase`, `handleEcoursePurchase` do not exist).

- [ ] **Step 2: The form's schema** (`src/server/forms.ts`). After `purchaseInterestSchema`, add:

```ts
/** The e-course cart's purchase (phase 2b, spec 6.4, D3): name, e-mail, the terms box (required) and the newsletter box (unticked). */
export const ecoursePurchaseSchema = z.object({ course: slug, name: line(MAX.name), email, terms, wantsNewsletter: flag, locale });
```

  and after `parsePurchaseInterest`:

```ts
/** The e-course purchase (phase 2b). Fields: course (slug), name, email, terms, newsletter ("Soovin MS LABi uudiseid ja pakkumisi"), locale. */
export const parseEcoursePurchase = (fd: FormData) =>
  parseForm(ecoursePurchaseSchema, fd, { ...same("course", "name", "email", "terms", "locale"), wantsNewsletter: "newsletter" }, slugPlacement);
```

- [ ] **Step 3: The start and the action.**
  1. **`src/server/payments/start.ts`.** Append:

```ts
/**
 * Starts an e-course purchase (spec 6.4): a pending `ecourse` row of the course's price, with the payer as entered and her newsletter wish
 * (acted on when it is paid), and Montonio's order. No account and no access before the payment: an abandoned purchase leaves only this row.
 * The same purchase pressed again while its order is open (the same course, address and price: liveAttempt) is sent again with the latest
 * name, language and newsletter box, never a second order (the double-payment rule).
 */
export async function startEcoursePayment(
  deps: StartDeps,
  input: { courseId: number; amountCents: number; email: string; name: string; locale: "et" | "ru"; newsletter: boolean },
): Promise<StartResult> {
  const montonio = deps.montonio;
  if (!montonio) return { kind: "off" };
  const live = await liveAttempt(deps.db, { courseId: input.courseId, email: input.email }, input.amountCents, deps.now);
  if (live) {
    const fresh = { name: input.name, locale: input.locale, newsletter: input.newsletter, updatedAt: deps.now };
    await deps.db.update(payments).set(fresh).where(and(eq(payments.id, live.id), eq(payments.status, "pending")));
    return order({ ...deps, montonio }, { ...live, ...fresh }, true);
  }
  const payment = await insertPayment(
    deps.db,
    { kind: "ecourse", registrationId: null, courseId: input.courseId, clientId: null, email: input.email, name: input.name, locale: input.locale, amountCents: input.amountCents, newsletter: input.newsletter },
    deps.now,
  );
  return order({ ...deps, montonio }, payment);
}
```

  2. **`src/server/submit.ts`.**
     - `FormName` gains `"ecourse"`: `export type FormName = "contact" | "subscribe" | "register" | "individual" | "interest" | "ecourse" | "practice" | "waitlist";`.
     - Add `parseEcoursePurchase` to the `./forms` import and `startEcoursePayment` to the `./payments/start` import.
     - `async function subscribeLater(…)` becomes `export async function subscribeLater(…)`, and its doc comment gains: "settle.ts calls it too, when a paid e-course purchase had the box ticked (phase 2b)."
     - After `handlePurchaseInterest`, add:

```ts
/**
 * The e-course cart's "Maksa {hind}" (phase 2b, spec 6.4): the forms' pipeline (honeypot, validation, 5 per 10 minutes per IP), a published
 * e-course with a price, then a payment row (`ecourse`; its time is the terms box's acceptance) and Montonio's order: `{ ok: true, paymentUrl }`.
 * Nothing else before the payment: no account, no access, no newsletter, no mail (server/payments/settle.ts does that when it is paid).
 * Without payments, or when Montonio says no: form "unavailable", and the cart shows its purchase-interest form instead.
 */
export function handleEcoursePurchase(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "ecourse", formData, parseEcoursePurchase, async ({ course: slug, name, email, locale, wantsNewsletter, terms: _terms }) => {
    void _terms;
    const [course] = await deps.db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, slug), eq(courses.published, true), eq(courses.type, "e_learning")))
      .limit(1);
    if (!course || course.price == null || course.price <= 0) return { result: fail({ form: "invalid" }) };
    const started = await startEcoursePayment(
      { db: deps.db, now: deps.now, siteUrl: deps.siteUrl, montonio: deps.montonio ?? null },
      { courseId: course.id, amountCents: course.price, email, name, locale, newsletter: wantsNewsletter },
    );
    return { result: started.kind === "started" ? { ok: true, paymentUrl: started.paymentUrl } : fail({ form: "unavailable" }) };
  });
}
```

  3. **`src/server/actions/public.ts`.** Add `handleEcoursePurchase` to the `../submit` import and, after `submitPurchaseInterest`:

```ts
/**
 * The e-course cart's purchase (phase 2b): `{ ok: true, paymentUrl }` (the cart sends the browser there), or form "unavailable" (no payments,
 * Montonio down: the cart shows its interest form). Fields: course (slug), name, email, terms, newsletter, locale, website (honeypot).
 */
export async function buyEcourse(formData: FormData): Promise<ActionResult> {
  return run("ecourse", handleEcoursePurchase, formData);
}
```

- [ ] **Step 4: The grant.**
  1. Create `src/server/payments/grant.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { clients, courseAccess, courses, payments, type Payment } from "@/db/schema";
import { defaultExpiryDate } from "@/domain/client-access";
import type { I18n } from "@/i18n/field";
import { addClient, grantAccess } from "../admin-clients";

/** What a paid e-course purchase opened: for whom (`created`: a new client), which course, until when. */
export type Grant = { clientId: number; created: boolean; courseSlug: string; courseTitle: I18n; expiresAt: Date };

/** The longest name a client keeps (the forms' and Minu andmed's limit). */
const NAME_MAX = 120;

/**
 * The e-course a paid purchase opens (phase 2b, spec 6.2.3), in the paid payment's own transaction (settle.ts): the client of the e-mail,
 * found or created as "Lisa õpilane" does it (admin-clients.ts addClient: under the logins' address lock, her earlier records linked) — a new
 * client gets the payer's name and the payment's language, an existing one keeps hers and gets the name only when she has none; then the
 * access as "Ava ligipääs" gives it (grantAccess, by "payment"): until the end of today + the course's access months (12 without), a renewal
 * moving the expiry and ending an end. The payment row is linked to her. null: the course is gone or is no e-course (settle.ts tells Maria).
 */
export async function grantPurchase(tx: Tx, payment: Payment, now: Date): Promise<Grant | null> {
  if (payment.courseId === null) return null;
  const db = tx as unknown as Db;
  const [course] = await db
    .select({ id: courses.id, slug: courses.slug, title: courses.title, type: courses.type, accessMonths: courses.accessMonths })
    .from(courses)
    .where(eq(courses.id, payment.courseId))
    .limit(1);
  if (!course || course.type !== "e_learning") return null;
  const client = await addClient(db, payment.email);
  if (!client.ok) return null;
  await db
    .update(clients)
    .set({
      name: sql`case when ${clients.name} = '' then ${payment.name.trim().slice(0, NAME_MAX)} else ${clients.name} end`,
      ...(client.created ? { locale: payment.locale } : {}),
    })
    .where(eq(clients.id, client.id));
  const granted = await grantAccess(db, { clientId: client.id, courseId: course.id, until: defaultExpiryDate(now, course.accessMonths), by: "payment", now });
  if (!granted.ok) return null;
  await db.update(payments).set({ clientId: client.id }).where(eq(payments.id, payment.id));
  const [access] = await db
    .select({ expiresAt: courseAccess.expiresAt })
    .from(courseAccess)
    .where(and(eq(courseAccess.clientId, client.id), eq(courseAccess.courseId, course.id)))
    .limit(1);
  return { clientId: client.id, created: client.created, courseSlug: course.slug, courseTitle: course.title, expiresAt: access.expiresAt };
}
```

  2. **`src/server/account-mail.ts`.** After `registrationPaidMail`, add:

```ts
export type EcourseOpenInput = {
  siteUrl: string;
  email: string;
  name: string;
  locale: Locale;
  course: I18n;
  /** The access's last moment (grant.ts). */
  expiresAt: Date;
  /** A live login for the address (client-auth.ts issueClientLogin), or null when it has its 3 already: then "Ava minu konto". */
  login: LoginCode | null;
};

/**
 * The mail after a paid e-course purchase (phase 2b, spec 6.2.4): "E-koolitus on avatud — {title}", the course with "Ligipääs kuni {date}.",
 * and the login: the code large and "Logi sisse" (verifyLink, like the code login), which opens Minu koolitused with the course on it. The
 * caller never sends it to a sample address and does not count it in the daily caps (it follows a real payment).
 */
export function ecourseOpenMail(input: EcourseOpenInput): Mail {
  const m = getDict(input.locale).payment.mail;
  const title = pick(input.course, input.locale);
  return confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(m.subjectEcourse, { title })),
    lead: m.leadEcourse,
    box: { title, lines: [fill(m.access, { date: formatDate(input.expiresAt, input.locale) })] },
    sections: [],
    login: input.login,
  });
}
```

  3. **`src/server/payments/settle.ts`.**
     - Imports: add `import { issueClientLogin } from "../client-auth";`, `import { subscribeLater } from "../submit";`, `import { ecourseOpenMail, registrationPaidMail } from "../account-mail";` (replacing the single import), and `import { grantPurchase, type Grant } from "./grant";`.
     - `type Won` becomes `type Won = { payment: Payment; registration: RegistrationPaid | null; grant: Grant | null };` and its comment "… and what it did to its registration, or the e-course it opened (phase 2b Task 7)".
     - In `paid`'s transaction, the two lines after `if (!payment) return null;` become:

```ts
    const registration = payment.kind !== "ecourse" && payment.registrationId !== null ? await addRegistrationPayment(tx, payment.registrationId, payment.amountCents, deps.now) : null;
    const grant = payment.kind === "ecourse" ? await grantPurchase(tx, payment, deps.now) : null;
    return { payment: grant ? { ...payment, clientId: grant.clientId } : payment, registration, grant };
```

     - `paid`'s `deps.later(…)` body becomes:

```ts
  deps.later(async () => {
    const ctx = await paymentContext(deps.db, won.payment.id);
    if (won.registration) await mailRegistrationPaid(deps, won.payment, won.registration);
    if (won.grant) await mailEcourseOpen(deps, won.payment, won.grant);
    await tellMaria(deps, won.payment, ctx, outcomeOf(won));
    // the cart's "Soovin MS LABi uudiseid ja pakkumisi": the one-step sign-up, acted on now that it is paid (spec 6.2.3)
    if (won.payment.kind === "ecourse" && won.payment.newsletter)
      await subscribeLater({ db: deps.db, env: deps.env, ip: null, siteUrl: deps.siteUrl, now: deps.now, later: deps.later }, "ecourse", { email: won.payment.email, locale: won.payment.locale });
  });
```

     - `outcomeOf`'s first line becomes `if (won.payment.kind === "ecourse") return { outcome: won.grant ? "opened" : "notOpened" };` followed by the existing lines.
     - After `mailRegistrationPaid`, add:

```ts
/**
 * "E-koolitus on avatud — …" with a live login (spec 6.2.4): never to a sample address, not counted in the daily caps. An address that has its
 * 3 live logins already gets the mail without a code ("Ava minu konto").
 */
async function mailEcourseOpen(deps: SettleDeps, p: Payment, g: Grant): Promise<void> {
  if (isSampleAddress(p.email) || !mailConfigured(deps.env)) return;
  try {
    const login = await issueClientLogin(deps.db, p.email, deps.now);
    const sent = await sendMail(deps.env, ecourseOpenMail({ siteUrl: deps.siteUrl, email: p.email, name: p.name, locale: p.locale, course: g.courseTitle, expiresAt: g.expiresAt, login }));
    console.info(`[payments] payment ${p.id}: the e-course mail sent: ${sent}`);
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the e-course mail failed`, e);
  }
}
```

     - In the file's top comment, after "the amount is added to the registration (…)", add: "or, for an e-course, its client is found or created and the course opened (grant.ts)", and after "the payer's mail and Maria's notice go out after the response" add "(an e-course's with a login code, and the newsletter sign-up when it was ticked)".
  4. Run `npx vitest run tests/unit/forms.test.ts tests/db/payments-ecourse.test.ts tests/db/payments-settle.test.ts tests/db/payments-return.test.ts` — expect PASS.

- [ ] **Step 5: The cart's form — failing DOM test** `tests/unit/ecourse-purchase-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EcoursePurchase, type EcoursePurchaseTexts } from "@/components/site/EcoursePurchase";

// The e-course cart's purchase form (phase 2b, spec 6.4, D3): name, e-mail, the terms box with its link, the newsletter box and "Maksa 190 €";
// filled from the account when the browser is signed in; the action's paymentUrl is where the page goes; "unavailable" shows the
// purchase-interest form instead. The action and the navigation are stood in for here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ buyEcourse: vi.fn<(fd: FormData) => Promise<unknown>>(), navigate: vi.fn<(url: string) => void>() }));
vi.mock("@/server/actions/public", () => ({ buyEcourse: mocks.buyEcourse }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));

const t: EcoursePurchaseTexts = {
  name: "Nimi",
  email: "E-post",
  terms: "Olen tutvunud tingimustega ja nõustun nendega.",
  termsLink: { label: "Õppetingimused", href: "/tingimused" },
  newsletterConsent: "Soovin MS LABi uudiseid ja pakkumisi",
  submit: "Maksa 190 €",
  starting: "Avan makse…",
  errorRequired: "See väli on kohustuslik.",
  errorEmail: "Sisesta korrektne e-posti aadress.",
  errorTooMany: "Liiga palju katseid. Proovi mõne minuti pärast.",
  errorGeneric: "Midagi läks valesti. Proovi uuesti.",
};
const props = { course: "kulmumeistri-e-koolitus", locale: "et" as const, t, fallback: createElement("p", { "data-fallback": "" }, "Makse lisandub peagi") };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-ecourse-form]")!.requestSubmit());
  await settle();
};
const type = async (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  mocks.buyEcourse.mockReset();
  mocks.navigate.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  document.cookie = "mslab_in=; max-age=0";
});

test("the markup: a POST form with name, e-mail, the terms box and its link, the newsletter box (unticked), the course, the honeypot and 'Maksa 190 €'", () => {
  const html = renderToStaticMarkup(createElement(EcoursePurchase, props));
  // either order of the two attributes (React 19 writes a form's `method` after the others)
  expect(html).toMatch(/<form\b(?=[^>]*\bmethod="post")(?=[^>]*\bdata-ecourse-form="")[^>]*>/);
  for (const part of ['name="name"', 'name="email"', 'name="terms"', 'name="newsletter"', 'name="course" value="kulmumeistri-e-koolitus"', 'name="locale" value="et"', 'name="website"', 'href="/tingimused"', "Maksa 190 €"])
    expect(html).toContain(part);
  expect(html).not.toMatch(/name="newsletter"[^>]*checked/);
});

test("a paid start: the button says 'Avan makse…' and the page goes to Montonio", async () => {
  mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Kati Tamm");
  await type("input[name='email']", "kati@example.test");
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  await submit();
  const sent = mocks.buyEcourse.mock.calls[0][0];
  expect([sent.get("name"), sent.get("email"), sent.get("terms"), sent.get("newsletter"), sent.get("course")]).toEqual(["Kati Tamm", "kati@example.test", "on", null, "kulmumeistri-e-koolitus"]);
  expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-1");
  expect($("button[type='submit']")!.textContent).toBe("Avan makse…");
});

test("errors: the first field with one takes the focus; 'unavailable' shows the purchase-interest form instead", async () => {
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { name: "required", terms: "required" } });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await submit();
  expect(document.activeElement).toBe($("input[name='name']"));
  expect($("input[name='terms']")!.getAttribute("aria-invalid")).toBe("true");
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { form: "unavailable" } });
  await submit();
  expect($("[data-fallback]")!.textContent).toBe("Makse lisandub peagi");
  expect($("[data-ecourse-form]")).toBeNull();
});

test("signed in on this browser (the hint cookie): her name and e-mail from /api/konto/me, never over what she typed", async () => {
  document.cookie = "mslab_in=1";
  const me = vi.fn(async () => new Response(JSON.stringify({ ok: true, email: "kati@example.test", name: "Kati Tamm" }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", me);
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await settle();
  expect(me).toHaveBeenCalledWith("/api/konto/me", expect.objectContaining({ credentials: "same-origin" }));
  expect([$<HTMLInputElement>("input[name='name']")!.value, $<HTMLInputElement>("input[name='email']")!.value]).toEqual(["Kati Tamm", "kati@example.test"]);
});
```

  Run it — FAIL (`@/components/site/EcoursePurchase` does not exist).

- [ ] **Step 6: Write `src/components/site/EcoursePurchase.tsx`:**

```tsx
"use client";

import { startTransition, useActionState, useEffect, useId, useState } from "react";
import type { Locale } from "@/i18n/locales";
import { hintIn } from "@/lib/account-cookies";
import { navigate } from "@/lib/navigate";
import { buyEcourse } from "@/server/actions/public";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./PurchaseInterest.module.css";
import checks from "./CourseBuy.module.css";

export type EcoursePurchaseTexts = {
  name: string;
  email: string;
  terms: string;
  termsLink: { label: string; href: string };
  newsletterConsent: string;
  /** "Maksa 190 €" */
  submit: string;
  starting: string;
  errorRequired: string;
  errorEmail: string;
  errorTooMany: string;
  errorGeneric: string;
};

type Field = "name" | "email" | "terms" | "form";
type Errors = Partial<Record<Field, string>>;
type State = { status: "idle" } | { status: "going" } | { status: "unavailable" } | { status: "error"; errors: Errors };

/** Where the focus goes after a failed submit: the first of these with an error, in page order. */
const ORDER: Field[] = ["name", "email", "terms"];

/**
 * The e-course cart's purchase (phase 2b, spec 6.4, D3): name, e-mail, the terms box (required, with the "Õppetingimused" link, as on the
 * registration form), the newsletter box (unticked) and "Maksa {hind}"; the bank or the card is chosen on Montonio's own page (D4). The cart is
 * cached for everyone, so a signed-in browser (the hint cookie) fills name and e-mail from /api/konto/me here, never over what was typed.
 * When payments are not available after all (form "unavailable": Montonio down), `fallback` takes the form's place: the cart's
 * purchase-interest form, so nothing is lost. After a failed submit the focus goes to the first field with an error.
 */
export function EcoursePurchase({ course, locale, t, fallback }: { course: string; locale: Locale; t: EcoursePurchaseTexts; fallback: React.ReactNode }) {
  const id = useId();
  const [values, setValues] = useState({ name: "", email: "" });
  const [agreed, setAgreed] = useState(false);
  const [newsletter, setNewsletter] = useState(false);

  useEffect(() => {
    if (!hintIn(document.cookie)) return;
    let live = true;
    void fetch("/api/konto/me", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<{ ok?: unknown; email?: unknown; name?: unknown }>) : null))
      .then((me) => {
        if (!live || me?.ok !== true) return;
        setValues((v) => ({ name: v.name || (typeof me.name === "string" ? me.name : ""), email: v.email || (typeof me.email === "string" ? me.email : "") }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    try {
      const result = await buyEcourse(formData);
      if (result.ok) {
        if (!result.paymentUrl) return { status: "unavailable" };
        navigate(result.paymentUrl);
        return { status: "going" };
      }
      if (result.errors.form === "unavailable") return { status: "unavailable" };
      const errors: Errors = {};
      for (const [f, code] of Object.entries(result.errors)) {
        if (f === "form") errors.form = code === "rate" ? t.errorTooMany : t.errorGeneric;
        else if (f === "email") errors.email = t.errorEmail;
        else if (f === "name" || f === "terms") errors[f] = t.errorRequired;
      }
      if (Object.keys(errors).length === 0) errors.form = t.errorGeneric;
      return { status: "error", errors };
    } catch {
      return { status: "error", errors: { form: t.errorGeneric } };
    }
  }, { status: "idle" });

  useEffect(() => {
    if (state.status !== "error") return;
    const first = ORDER.find((f) => state.errors[f]);
    document.getElementById(first ? `${id}-${first}` : `${id}-form-error`)?.focus();
  }, [state, id]);

  if (state.status === "unavailable") return <>{fallback}</>;
  const errors: Errors = state.status === "error" ? state.errors : {};
  const busy = pending || state.status === "going";
  const described = (f: Field) => ({ "aria-invalid": errors[f] ? true : undefined, "aria-describedby": errors[f] ? `${id}-${f}-error` : undefined });
  const err = (f: Field) =>
    errors[f] ? (
      <p id={`${id}-${f}-error`} className={styles.error}>
        {errors[f]}
      </p>
    ) : null;

  return (
    <form
      className={styles.form}
      method="post"
      noValidate
      data-ecourse-form=""
      // Submitted by hand (as the registration form); method="post" keeps the name and e-mail out of the URL without the script.
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <label className={styles.label} htmlFor={`${id}-name`}>
        {t.name}
      </label>
      <input id={`${id}-name`} className={styles.input} name="name" type="text" required autoComplete="name" maxLength={120} value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} {...described("name")} />
      {err("name")}
      <label className={styles.label} htmlFor={`${id}-email`}>
        {t.email}
      </label>
      <input id={`${id}-email`} className={styles.input} name="email" type="email" required autoComplete="email" maxLength={200} value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} {...described("email")} />
      {err("email")}
      <div>
        <label className={checks.check}>
          <input id={`${id}-terms`} type="checkbox" name="terms" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} {...described("terms")} />
          <span>{t.terms}</span>
        </label>
        <a className={checks.termsLink} href={t.termsLink.href} target="_blank" rel="noopener">
          {t.termsLink.label} ↗
        </a>
        {err("terms")}
      </div>
      <label className={checks.check}>
        <input type="checkbox" name="newsletter" checked={newsletter} onChange={(e) => setNewsletter(e.target.checked)} />
        <span>{t.newsletterConsent}</span>
      </label>
      <input type="hidden" name="course" value={course} />
      <input type="hidden" name="locale" value={locale} />
      {/* Honeypot: people never see or fill it. */}
      <div className={styles.honeypot} aria-hidden="true">
        <label>
          Website
          <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      {errors.form && (
        <p id={`${id}-form-error`} className={styles.error} role="alert" tabIndex={-1}>
          {errors.form}
        </p>
      )}
      {/* aria-disabled, not disabled: a disabled button would drop keyboard focus to the page while sending. */}
      <button className={`${ui.btn} ${ui.btnFull}`} type="submit" aria-disabled={busy || undefined}>
        {busy ? t.starting : t.submit}
        <Icon name="arrow" />
      </button>
    </form>
  );
}
```

- [ ] **Step 7: The cart uses it** (`src/app/[locale]/(site)/ostukorv/cart.tsx`).
  1. Imports: `import { EcoursePurchase } from "@/components/site/EcoursePurchase";`, `import { fill } from "@/i18n/format";`, `import { paymentsConfigured } from "@/server/payments/montonio";`.
  2. Replace the two children after the `total` paragraph in `<aside …>` (the `soon` paragraph and `<PurchaseInterest … />`) with:

```tsx
          {paymentsConfigured() ? (
            <EcoursePurchase
              course={course.slug}
              locale={locale}
              t={{
                name: d.forms.name,
                email: d.forms.email,
                terms: d.forms.terms,
                termsLink: { label: d.footer.terms, href: to("/tingimused") },
                newsletterConsent: d.forms.newsletterConsent,
                submit: fill(d.payment.pay, { amount: price }),
                starting: d.payment.starting,
                errorRequired: d.forms.errorRequired,
                errorEmail: d.forms.errorEmail,
                errorTooMany: d.forms.errorTooMany,
                errorGeneric: d.forms.errorGeneric,
              }}
              fallback={interest}
            />
          ) : (
            interest
          )}
```

     and, before the `return (` of the course branch, add:

```tsx
  // today's "Makse lisandub peagi" with the purchase-interest form: the cart without payments, and the fallback when Montonio is down (phase 2b)
  const interest = (
    <>
      <p className={styles.soon}>{c.checkoutSoon}</p>
      <PurchaseInterest
        course={course.slug}
        locale={locale}
        t={{
          email: d.forms.email,
          newsletterConsent: d.forms.newsletterConsent,
          submit: d.forms.interestSubmit,
          sending: d.forms.sending,
          sent: d.forms.interestSent,
          errorEmail: d.forms.errorEmail,
          errorTooMany: d.forms.errorTooMany,
          errorGeneric: d.forms.errorGeneric,
        }}
      />
    </>
  );
```

  3. The `Cart` doc comment's first sentences become: "Cart (/ostukorv?kursus=<slug>), target of "Osta kohe" on an e-learning page (P9). With online payments (phase 2b, spec 6.4) it sums up the course and takes the purchase: name, e-mail, the terms, the newsletter box and "Maksa {hind}" (components/site/EcoursePurchase.tsx); without them, or when Montonio is down, it says payment opens soon and takes an e-mail to tell the visitor. Whether payments are on is a setting of the deployment, read while the page renders (the page stays one cached page per course)."
- [ ] **Step 8: Run** `npx vitest run tests/unit/ecourse-purchase-dom.test.ts tests/unit/colour-tokens.test.ts` — PASS. `next build`: `/[locale]/ostukorv/[kursus]` is still ● (ISR), never ƒ.

- [ ] **Step 9: The e2e run** (the e2e server has payments on, so the cart shows the purchase form).
  1. **`tests/e2e/course.spec.ts`.** Import `storedPayments` (Task 4) if not yet.
     - In "forms post (personal data never goes into the URL)", `page.locator("[data-interest-form]")` becomes `page.locator("[data-ecourse-form]")`.
     - Replace the test "summarises the e-course, says payment opens soon, takes an e-mail (P9)" with:

```ts
  test("summarises the e-course; the purchase form — name, e-mail, the terms, the newsletter box — and 'Maksa 190 €' goes to the bank (phase 2b, D3)", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("buy", info.project.name);
    await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
    await expect(page.getByRole("heading", { name: "Kulmumeistri e-koolitus" })).toBeVisible();
    await expect(page.locator("[data-cart-summary]")).toContainText("190 €");
    const form = page.locator("[data-ecourse-form]");
    await form.getByRole("button", { name: "Maksa 190 €" }).click(); // empty: the focus on the name, with its error
    await expect(form.getByLabel("Nimi")).toBeFocused();
    await expect(form.getByLabel("Nimi")).toHaveAttribute("aria-invalid", "true");
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(addr);
    await expect(form.getByLabel("Soovin MS LABi uudiseid ja pakkumisi")).not.toBeChecked();
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
    await page.getByRole("button", { name: "Katkesta" }).click();
    await page.waitForURL(/\/makse#tulemus=katkestatud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus/);
    await expect(page.getByRole("link", { name: "Proovi uuesti" })).toHaveAttribute("href", "/ostukorv?kursus=kulmumeistri-e-koolitus");
    if (LOCAL_FIXTURES) expect(await storedPayments(addr)).toEqual([{ kind: "ecourse", status: "failed", amountCents: 19000 }]);
  });
```

  2. **`tests/e2e/forms.spec.ts`.** The rate-limit test ("5 submissions per form in 10 minutes; …") used the cart's interest form, which is not on the cart while payments are on. It moves to the contact page (the same limit, another form); its loop becomes:

```ts
    for (let i = 1; i <= 6; i++) {
      await page.goto("/kontakt");
      const form = page.locator("[data-contact-form]");
      await form.getByLabel("Nimi").fill("Test Õpilane");
      await form.getByLabel("E-post", { exact: true }).fill(addr);
      await form.getByLabel("Sõnum").fill(`Küsimus ${i}`);
      await form.getByRole("button", { name: "Saada" }).click();
      if (i <= 5) await expect(page.getByText("Aitäh! Sinu sõnum on saadetud.")).toBeVisible();
      else {
        const error = form.getByRole("alert");
        await expect(error).toHaveText("Liiga palju katseid. Proovi mõne minuti pärast.");
        await expect(error).toBeFocused();
      }
    }
    expect(await storedRequests(addr)).toHaveLength(5);
```

- [ ] **Step 10: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - `npx playwright test course forms cache` and `E2E_PROD_BUILD=1 npx playwright test course cache`.

- [ ] **Step 11: Commit.**

```bash
git add app/src/server/forms.ts app/src/server/submit.ts app/src/server/actions/public.ts app/src/server/payments app/src/server/account-mail.ts app/src/components/site/EcoursePurchase.tsx "app/src/app/[locale]/(site)/ostukorv/cart.tsx" app/tests
git commit -m "feat(payments): the e-course purchase — the cart's form, and access with a login link when it is paid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The daily check of pending payments, in the daily cron

Spec section 6.6 (and 5.3's revalidation). The existing `/api/cron/sweep` also:
- asks `GET /orders/:uuid` about every `pending` payment older than 45 minutes and younger than 14 days, at most 50 a run, oldest first, and settles each through `settlePayment` (the one door);
- marks `pending` rows older than 14 days `failed`, and so a row whose order was never created (no `provider_uuid` 45 minutes after it was written: its creation broke off) — nothing can be asked about it;
- revalidates `seats` when holds have ended since the last run (the last day).
The payment part keeps to the sweep's deadline: no new GET after `SWEEP_DEADLINE_MS` (each GET has 15 s at most). Without payments it does nothing and answers zeros.

**Files:**
- Modify: `app/src/db/queries/payments.ts`, `app/src/app/api/cron/sweep/route.ts`
- Create: `app/src/server/payments/check.ts`
- Test: `app/tests/db/payments-check.test.ts` (new), `app/tests/db/cron-sweep.test.ts` (the answer's new counts)

**Interfaces:**
- Consumes: `settlePayment`, `factsOf`, `SettleDeps` (Task 3); `paymentProvider` (Task 2).
- Produces, from `src/db/queries/payments.ts`: `CHECK_AFTER_MS = 45 * 60_000`; `GIVE_UP_MS = 14 * 86_400_000`; `pendingToCheck(db: Db, now: Date, limit: number): Promise<Payment[]>`; `expireStalePending(db: Db, now: Date): Promise<number>`; `holdsEnded(db: Db, since: Date, now: Date): Promise<number>`.
- Produces, from `src/server/payments/check.ts`: `CHECK_BATCH = 50`; `type PaymentSweep = { checked: number; settled: number; unanswered: number; expired: number; left: number; outOfTime: boolean; holdsEnded: number }`; `NO_PAYMENT_SWEEP: PaymentSweep`; `checkPendingPayments(deps: SettleDeps, until: number, clock?: () => number): Promise<PaymentSweep>`.
- Produces, from `GET /api/cron/sweep`: the answer gains `paymentsChecked`, `paymentsSettled`, `paymentsExpired`, `paymentsLeft`.

- [ ] **Step 1: Write the failing tests** `tests/db/payments-check.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations } from "@/db/schema";
import { CHECK_BATCH, checkPendingPayments } from "@/server/payments/check";
import { contactCourse, pendingPayment, registrationOn, settleDeps, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The daily check (phase 2b, spec 6.6): Montonio is asked about every pending payment older than 45 minutes and younger than 14 days (at most
// 50 a run, within the sweep's deadline) and its answer settled through the one door; older ones, and ones whose order was never created, fail;
// holds that ended in the last day revalidate the seats.

const NOW = new Date("2026-10-10T03:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const FOREVER = Number.MAX_SAFE_INTEGER;
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const status = async (id: number) => (await db.select().from(payments).where(eq(payments.id, id)))[0].status;
const snapshot = (p: { providerUuid: string | null; reference: string }, paymentStatus: string) => ({ uuid: p.providerUuid, paymentStatus, merchantReference: p.reference, grandTotal: "175.00", currency: "EUR", paymentMethodType: "paymentInitiation" });

test("older than 45 minutes: asked and settled (PAID confirms the place, ABANDONED fails); a younger one waits; no answer is counted", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c);
  const paid = await pendingPayment(db, r, {}, ago(2 * 60 * MIN));
  const abandoned = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(50 * MIN));
  const silent = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), {}, ago(3 * DAY));
  const young = await pendingPayment(db, await registrationOn(db, c, { email: "neljas@example.com" }), {}, ago(10 * MIN));
  m.state.snapshots.set(paid.providerUuid!, snapshot(paid, "PAID"));
  m.state.snapshots.set(abandoned.providerUuid!, snapshot(abandoned, "ABANDONED"));
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  expect(await checkPendingPayments(deps, FOREVER)).toEqual({ checked: 3, settled: 2, unanswered: 1, expired: 0, left: 0, outOfTime: false, holdsEnded: 0 });
  await flush();
  expect([await status(paid.id), await status(abandoned.id), await status(silent.id), await status(young.id)]).toEqual(["paid", "failed", "pending", "pending"]);
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].status).toBe("confirmed");
  expect(m.state.gets.sort()).toEqual([abandoned.providerUuid, paid.providerUuid, silent.providerUuid].sort());
  expect(m.mails().map((x) => x.subject)).toEqual(["Koht on kinnitatud — Kulmumeistri baaskoolitus", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"]);
});

test("14 days old: failed without asking; an order never created (no Montonio uuid) 45 minutes on: failed", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const old = await pendingPayment(db, await registrationOn(db, c), {}, ago(14 * DAY));
  const orphan = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), { providerUuid: null }, ago(46 * MIN));
  const fresh = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), { providerUuid: null }, ago(5 * MIN));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 0, expired: 2 });
  expect([await status(old.id), await status(orphan.id), await status(fresh.id)]).toEqual(["failed", "failed", "pending"]);
  expect(m.state.gets).toEqual([]);
});

test(`at most ${CHECK_BATCH} a run, oldest first; out of time: no new one is asked about`, async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  for (let i = 0; i < CHECK_BATCH + 2; i++) await pendingPayment(db, r, {}, ago(DAY + i * MIN));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: CHECK_BATCH, unanswered: CHECK_BATCH, left: 1, outOfTime: false });
  m.state.gets.length = 0;
  expect(await checkPendingPayments(deps, 0)).toMatchObject({ checked: 0, outOfTime: true });
  expect(m.state.gets).toEqual([]);
});

test("holds that ended in the last day revalidate the seats; none: nothing", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const { deps, changes } = settleDeps(db, m.montonio, NOW);
  await checkPendingPayments(deps, FOREVER);
  expect(changes).toEqual([]);
  await registrationOn(db, c, { seatHoldUntil: ago(5 * 60 * MIN) });
  await registrationOn(db, c, { email: "teine@example.com", seatHoldUntil: ago(2 * DAY) });
  expect((await checkPendingPayments(deps, FOREVER)).holdsEnded).toBe(1);
  expect(changes).toEqual([{ kind: "seats" }]);
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/db/payments-check.test.ts`.

- [ ] **Step 3: The queries** — in `src/db/queries/payments.ts`:
  1. The `drizzle-orm` import becomes `import { and, asc, count, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";`.
  2. Append:

```ts
/** The daily check asks about a pending payment once Montonio's 30-minute window is surely over, and gives up on it after 14 days (spec 6.6). */
export const CHECK_AFTER_MS = 45 * 60_000;
export const GIVE_UP_MS = 14 * 86_400_000;

/** The pending payments the daily check asks Montonio about: with an order, older than 45 minutes and younger than 14 days; oldest first. */
export async function pendingToCheck(db: Db, now: Date, limit: number): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.status, "pending"),
        isNotNull(payments.providerUuid),
        lte(payments.createdAt, new Date(now.getTime() - CHECK_AFTER_MS)),
        gt(payments.createdAt, new Date(now.getTime() - GIVE_UP_MS)),
      ),
    )
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(limit);
}

/**
 * Pending payments that will not be paid any more: 14 days old, or 45 minutes old without an order (its creation broke off: there is nothing
 * to ask about). They become failed; their count. (Their holds ended long ago.)
 */
export async function expireStalePending(db: Db, now: Date): Promise<number> {
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const rows = await (db as unknown as PostgresJsDatabase<typeof schema>)
    .update(payments)
    .set({ status: "failed", updatedAt: now })
    .where(
      and(
        eq(payments.status, "pending"),
        or(lte(payments.createdAt, new Date(now.getTime() - GIVE_UP_MS)), and(isNull(payments.providerUuid), lte(payments.createdAt, new Date(now.getTime() - CHECK_AFTER_MS)))),
      ),
    )
    .returning({ id: payments.id });
  return rows.length;
}

/** How many unpaid registrations' holds ended between `since` and `now` (cached pages may still count them as taken). */
export async function holdsEnded(db: Db, since: Date, now: Date): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(registrations)
    .where(
      and(
        eq(registrations.status, "awaiting_prepayment"),
        sql`${registrations.seatHoldUntil} > ${since.toISOString()}::timestamptz`,
        sql`${registrations.seatHoldUntil} <= ${now.toISOString()}::timestamptz`,
      ),
    );
  return Number(n);
}
```

- [ ] **Step 4: Write `src/server/payments/check.ts`:**

```ts
import { expireStalePending, holdsEnded, pendingToCheck } from "@/db/queries/payments";
import { factsOf, settlePayment, type SettleDeps } from "./settle";

// The daily check of pending payments (phase 2b, spec 6.6), run by the daily cron (app/api/cron/sweep). The webhook is retried for 48 hours
// and the return happens only when the payer comes back, so a payment whose webhook never got through, or whose payer closed the bank's page,
// is settled here: Montonio is asked (GET /orders/:uuid) and its answer goes through the one door (settle.ts). Counts only in the answer and
// the log: no reference, no address.

/** At most this many GET /orders a run (the run's other parts share its time). */
export const CHECK_BATCH = 50;

const DAY_MS = 86_400_000;

/**
 * What the check did: payments asked about (`checked`), settled to another status (`settled`), not answered (`unanswered`, asked again
 * tomorrow), failed for good (`expired`), still to ask (`left`, at least); `outOfTime`: the deadline came first; `holdsEnded`: holds that
 * ended in the last day (the seats were revalidated).
 */
export type PaymentSweep = { checked: number; settled: number; unanswered: number; expired: number; left: number; outOfTime: boolean; holdsEnded: number };

/** The check without payments (no keys): nothing. */
export const NO_PAYMENT_SWEEP: PaymentSweep = { checked: 0, settled: 0, unanswered: 0, expired: 0, left: 0, outOfTime: false, holdsEnded: 0 };

/**
 * Runs the check (spec 6.6): pending rows of 14 days and orders never created (no uuid after CHECK_AFTER_MS) fail; then each pending payment
 * older than CHECK_AFTER_MS and younger than 14 days, oldest first, at most CHECK_BATCH, is asked about and settled — no new one after `until`
 * (epoch ms, by `clock`). Last, when holds have ended in the last day, the seats are revalidated (the calendar's "Täis" of a hold that
 * ended). A failing database throws (the cron answers 500); Montonio not answering is only counted.
 */
export async function checkPendingPayments(deps: SettleDeps, until: number, clock: () => number = () => Date.now()): Promise<PaymentSweep> {
  const expired = await expireStalePending(deps.db, deps.now);
  const rows = await pendingToCheck(deps.db, deps.now, CHECK_BATCH + 1);
  let checked = 0;
  let settled = 0;
  let unanswered = 0;
  let outOfTime = false;
  for (const row of rows.slice(0, CHECK_BATCH)) {
    if (clock() > until) {
      outOfTime = true;
      break;
    }
    checked++;
    const snapshot = await deps.montonio.fetchOrder(row.providerUuid ?? "");
    if (!snapshot) {
      unanswered++;
      continue;
    }
    if (snapshot.reference !== row.reference) continue;
    const after = await settlePayment(deps, row, factsOf(snapshot));
    if (after.status !== row.status) settled++;
  }
  const ended = await holdsEnded(deps.db, new Date(deps.now.getTime() - DAY_MS), deps.now);
  if (ended > 0) await deps.changed?.({ kind: "seats" });
  return { checked, settled, unanswered, expired, left: rows.length - checked, outOfTime, holdsEnded: ended };
}
```

- [ ] **Step 5: Run** `npx vitest run tests/db/payments-check.test.ts` — expect PASS.

- [ ] **Step 6: The cron.**
  1. **`tests/db/cron-sweep.test.ts`.** After `const NO_VIDEOS = …`, add `const NO_PAYMENTS = { paymentsChecked: 0, paymentsSettled: 0, paymentsExpired: 0, paymentsLeft: 0 };` and add `...NO_PAYMENTS` to **every** expected answer compared with `toEqual` — nine of them today: the six that end in `...NO_VIDEOS` (the first two tests, twice each, and the last two tests) and the three that spell the video counts out (`uploads: 1, …`, `processingReady: 1, processingFailed: 1, …`, `uploads: 2, … videosLeft: 2`). The one `toMatchObject({ ok: true, uploads: 20, videosLeft: 2 })` stays as it is. (`grep -n "toEqual({ ok: true" tests/db/cron-sweep.test.ts` lists them; every one must end with the payment counts, or it fails on the four new fields.) In `beforeEach`, add `for (const name of ["MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER"]) vi.stubEnv(name, "");` (no payments unless a test says so). Append inside `describe("GET /api/cron/sweep", …)`:

```ts
  test("with payments set up the same call runs the daily check: a pending payment of 14 days is failed and counted (phase 2b)", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("MONTONIO_ACCESS_KEY", "test-access-key");
    vi.stubEnv("MONTONIO_SECRET_KEY", "test-secret-key-0123456789abcdef");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const [c] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 100 }).returning();
    await db.insert(payments).values({ reference: "MSLAB-M1", kind: "ecourse", courseId: c.id, email: "kati@example.test", name: "Kati", amountCents: 100, providerUuid: "uuid-1", createdAt: new Date(Date.now() - 15 * DAY) });
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, deleted: 1, logins: 0, sessions: 0, mailDays: 0, ...NO_VIDEOS, ...NO_PAYMENTS, paymentsExpired: 1 });
    expect((await db.select().from(payments))[0].status).toBe("failed");
  });
```

     (add `payments` to its `@/db/schema` import; `courses` is imported already.)
  2. **`src/app/api/cron/sweep/route.ts`.**
     - Imports: `import { after } from "next/server";`, `import { serverKv } from "@/server/kv";`, `import { checkPendingPayments, NO_PAYMENT_SWEEP, type PaymentSweep } from "@/server/payments/check";`, `import { paymentProvider } from "@/server/payments/montonio";`, `import { revalidatePublic } from "@/server/public-cache";`.
     - After `sweepVideos`, add:

```ts
/**
 * The payments' part (phase 2b, server/payments/check.ts): null without online payments (then no log line: the existing tests count the
 * sweep's log lines, and a line of zeros would only be noise). Mails of a payment it settles go after the response.
 */
async function sweepPayments(db: Db, now: Date, until: number): Promise<PaymentSweep | null> {
  const montonio = paymentProvider();
  if (!montonio) return null;
  const env = { ...serverEnv(), KV: serverKv() };
  return checkPendingPayments(
    { db, env, now, siteUrl: env.SITE_URL, later: (task) => after(() => task().catch((e) => logFailure("[payments] background task failed", e))), changed: revalidatePublic, montonio },
    until,
  );
}
```

     - In `GET`, the `Promise.all` becomes `const [deleted, accounts, videos, checked] = await Promise.all([sweepExpired(db, now), sweepClientRows(db, now), sweepVideos(db, bunnyConfig(), now, until), sweepPayments(db, now, until)]);`; after the video log lines add:

```ts
    // the payments' line only with online payments set up: without them the existing log lines are all there is (tests/db/cron-sweep.test.ts
    // counts them: toHaveBeenCalledTimes(1), the exact list of two), and the answer's payment counts are zeros
    if (checked) {
      console.info(
        `[cron] sweep: payments ${checked.checked} checked at Montonio, ${checked.settled} settled, ${checked.unanswered} not answered, ${checked.expired} failed as stale, ${checked.left} left for the next run, ${checked.holdsEnded} seat holds ended`,
      );
      if (checked.outOfTime) console.info(`[cron] sweep: no new payment asked about after ${SWEEP_DEADLINE_MS / 1000} s`);
    }
    const paid = checked ?? NO_PAYMENT_SWEEP;
```

     - The answer gains the payment counts: `return json(200, { ok: true, deleted, ...accounts, uploads: videos.uploads, processingReady: videos.processingReady, processingFailed: videos.processingFailed, videosLeft: videos.left, paymentsChecked: paid.checked, paymentsSettled: paid.settled, paymentsExpired: paid.expired, paymentsLeft: paid.left });`
     - The doc comment of `GET` gains a list item: "- with online payments set up (server/payments/check.ts, phase 2b), the pending payments: those older than 45 minutes and younger than 14 days are asked about at Montonio (at most 50, none after SWEEP_DEADLINE_MS) and settled; older ones, and orders never created, fail; holds that ended in the last day revalidate the seats;" and the 200's fields gain `paymentsChecked, paymentsSettled, paymentsExpired, paymentsLeft`.
  3. Run `npx vitest run tests/db/cron-sweep.test.ts tests/db/payments-check.test.ts` — PASS.

- [ ] **Step 7: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.

- [ ] **Step 8: Commit.**

```bash
git add app/src/db/queries/payments.ts app/src/server/payments/check.ts app/src/app/api/cron/sweep/route.ts app/tests
git commit -m "feat(payments): the daily check — pending payments asked at Montonio and settled, stale ones failed, ended holds revalidated

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Admin — "Maksed", the payments in a registration's drawer and in the Õpilased drawer

Spec section 8 (D7). Estonian only. Read-only: Maria refunds in Montonio's own dashboard and adjusts a registration with the forms she has (spec 11); no new admin action.
- **"Maksed"** (`/admin/maksed`, in the menu after "Registreerimised"): newest first, 50 a page; the filter Kõik / Makstud / Pooleli / Ebaõnnestunud / Tagastatud / Ootel kontrollil (`?staatus=`); the columns date, payer (name and e-mail, the name a link to the student when the payment has one), what (the course and the session's date, or the e-course), kind (Ettemaks / Ülejäänud / E-koolitus), amount, method/bank, status, Montonio id.
- **A `held` row, and a `failed` row with `paid_at` (voided after paid)**, carry the highlighted note "Kontrolli Montonios" (`domain/payments.ts needsCheck`).
- **The registration's drawer:** under "Laekunud" (the spec's "Tasutud") the online payments (date, amount, kind, status); Maria's "amount received" form stays.
- **The Õpilased drawer:** a "Maksed" list of her payments (her own, and those of her registrations made before she had an account); an access opened by a payment says "Avas veebimakse".

**Files:**
- Modify: `app/src/domain/payments.ts` (`needsCheck`), `app/src/db/queries/payments.ts` (the lists), `app/src/i18n/dict/admin.ts`, `app/src/components/admin/sections.ts`, `app/src/components/admin/AdminIcon.tsx`, `app/src/app/admin/(panel)/registreerimised/page.tsx`, `registrations.module.css`, `app/src/server/admin-clients.ts`, `app/src/components/admin/ClientDrawer.tsx`
- Create: `app/src/app/admin/(panel)/maksed/page.tsx`, `payments.module.css`, `app/src/components/admin/PaymentLines.tsx`, `PaymentLines.module.css`
- Test: `app/tests/db/payments-admin.test.ts` (new); `app/tests/unit/admin.test.ts`, `app/tests/unit/admin-guards.test.ts`, `app/tests/e2e/admin-inbox.spec.ts` (the menu); `app/tests/unit/colour-tokens.test.ts` (the two new CSS files)

**Interfaces:**
- Consumes: `payments`, `Payment`, `PaymentStatus`, `PaymentKind` (Task 1); `paged`, `Paged` (`db/queries/admin.ts`), `PAGE_SIZE` (`domain/paging.ts`).
- Produces, from `src/domain/payments.ts`: `needsCheck(p: { status: PaymentStatus; paidAt: Date | null }): boolean`.
- Produces, from `src/db/queries/payments.ts`: `type PaymentRow = Payment & { courseTitle: I18n | null; courseSlug: string | null; startsAt: Date | null }`; `type PaymentFilter = "all" | PaymentStatus`; `pagePayments(db: Db, filter: PaymentFilter, page: number, size?: number): Promise<Paged<PaymentRow>>`; `listPaymentsOf(db: Db, of: { registrationId: number } | { clientId: number }): Promise<PaymentRow[]>`.
- Produces, from `src/server/admin-clients.ts`: `ClientDetail.payments: PaymentRow[]`.
- Produces, from `src/components/admin/PaymentLines.tsx`: `PAYMENT_TONE: Record<PaymentStatus, string>`; `PaymentLines({ rows, withWhat? })` (`[data-payment-lines]`, each line `[data-payment=<reference>]`, the note `[data-payment-check]`).
- Produces, in `src/i18n/dict/admin.ts`: `nav.payments`, the section `payments`, `clients.drawer.byPayment`; `Section` gains `"payments"`.

- [ ] **Step 1: Write the failing tests.**
  1. **`tests/db/payments-admin.test.ts`** (new):

```ts
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { listPaymentsOf, pagePayments } from "@/db/queries/payments";
import { clients, courses, payments, registrations } from "@/db/schema";
import { needsCheck } from "@/domain/payments";
import { clientDetail } from "@/server/admin-clients";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The admin's view of the payments (phase 2b, spec 8): "Maksed" newest first with its status filter and pages, the payments of one
// registration and of one student (hers, and her registrations' made before she had an account), and the rows Maria must check in Montonio.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));

async function fixture() {
  const db = await makeTestDb();
  const c = await contactCourse(db);
  const [ecourse] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, price: 19000 })
    .returning();
  const [kati] = await db.insert(clients).values({ email: "kati@example.com" }).returning();
  const r = await registrationOn(db, c); // before she had an account: no client_id
  const a = await pendingPayment(db, r, {}, at(1));
  const b = await pendingPayment(db, r, { kind: "balance" }, at(2));
  const [e] = await db
    .insert(payments)
    .values({ reference: "MSLAB-M900", kind: "ecourse", courseId: ecourse.id, clientId: kati.id, email: "kati@example.com", name: "Kati Tamm", amountCents: 19000, status: "paid", paidAt: at(3), createdAt: at(3) })
    .returning();
  const other = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com", name: "Teine" }), {}, at(4));
  await db.update(payments).set({ status: "held" }).where(eq(payments.id, b.id));
  await db.update(payments).set({ status: "failed", paidAt: at(5) }).where(eq(payments.id, other.id)); // voided after paid
  await db.update(registrations).set({ clientId: kati.id }).where(eq(registrations.id, r.id)); // her later login linked the registration
  return { db, c, r, a, b, e, other, kati };
}

test("pagePayments: newest first with the course, the session's day and the kind; the status filter; 50 a page (2 here)", async () => {
  const { db, a, b, e, other } = await fixture();
  const all = await pagePayments(db, "all", 1);
  expect(all.total).toBe(4);
  expect(all.rows.map((p) => p.id)).toEqual([other.id, e.id, b.id, a.id]);
  expect(all.rows[3]).toMatchObject({ reference: a.reference, kind: "prepayment", courseTitle: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" }, courseSlug: "kulmumeistri-baaskoolitus", startsAt: new Date("2026-11-14T08:00:00Z") });
  expect(all.rows[1]).toMatchObject({ kind: "ecourse", courseTitle: { et: "Kulmumeistri e-koolitus" }, startsAt: null });
  expect((await pagePayments(db, "held", 1)).rows.map((p) => p.id)).toEqual([b.id]);
  expect((await pagePayments(db, "paid", 1)).rows.map((p) => p.id)).toEqual([e.id]);
  const second = await pagePayments(db, "all", 2, 2);
  expect([second.page, second.pages, second.rows.map((p) => p.id)]).toEqual([2, 2, [b.id, a.id]]);
});

test("one registration's payments; one student's: her own and her registrations' (paid before she had an account)", async () => {
  const { db, r, a, b, e, kati } = await fixture();
  expect((await listPaymentsOf(db, { registrationId: r.id })).map((p) => p.id)).toEqual([b.id, a.id]);
  expect((await listPaymentsOf(db, { clientId: kati.id })).map((p) => p.id)).toEqual([e.id, b.id, a.id]);
  expect((await clientDetail(db, kati.id))!.payments.map((p) => p.id)).toEqual([e.id, b.id, a.id]);
});

test("'Kontrolli Montonios': held, and failed after it was paid (voided); not a plain failure", () => {
  expect(needsCheck({ status: "held", paidAt: null })).toBe(true);
  expect(needsCheck({ status: "failed", paidAt: at(1) })).toBe(true);
  expect(needsCheck({ status: "failed", paidAt: null })).toBe(false);
  for (const status of ["pending", "paid", "refunded"] as const) expect(needsCheck({ status, paidAt: at(1) })).toBe(false);
});
```

  2. **`tests/unit/admin.test.ts`.** In "the sections in Maria's order …", insert `"Maksed",` after `"Registreerimised",`.
  3. **`tests/unit/admin-guards.test.ts`.** In the first test's page list, add `"maksed"` after `"registreerimised"`.
  4. **`tests/e2e/admin-inbox.spec.ts`.** In `MENU`, insert `"Maksed"` after `"Registreerimised"`.
  5. **`tests/unit/colour-tokens.test.ts`.** The list holds the admin's own CSS files too (ClientDrawer, list-table, registrations, clients); after `"src/app/admin/(panel)/opilased/[id]/vaade/view.module.css",` add `// the admin's Maksed (phase 2b)` and `"src/components/admin/PaymentLines.module.css",`, `"src/app/admin/(panel)/maksed/payments.module.css",` (both use the tokens only: `var(--muted-2)`, `var(--bad)` in a `color-mix`, `var(--font-mono)`).
  6. Run `npx vitest run tests/db/payments-admin.test.ts tests/unit/admin.test.ts` — FAIL.

- [ ] **Step 2: The rule and the lists.**
  1. **`src/domain/payments.ts`.** Add `import type { PaymentStatus } from "@/db/schema";` and append:

```ts
/**
 * A payment Maria must look at in Montonio's own dashboard (spec 8): held (paid, but the amount or the currency did not match), or failed
 * after it was paid (the bank voided it). The admin marks it "Kontrolli Montonios".
 */
export function needsCheck(p: { status: PaymentStatus; paidAt: Date | null }): boolean {
  return p.status === "held" || (p.status === "failed" && p.paidAt !== null);
}
```

  2. **`src/db/queries/payments.ts`.** Add `desc` to the `drizzle-orm` import; add `import { PAGE_SIZE } from "@/domain/paging";`, `import { paged, type Paged } from "./admin";` and `type PaymentStatus` to the `../schema` import. Append:

```ts
// ---------- the admin's lists (phase 2b, spec 8) ----------

/** A payment with what it was for: the course's title and slug (null when the course is gone) and its registration's session day. */
export type PaymentRow = Payment & { courseTitle: I18n | null; courseSlug: string | null; startsAt: Date | null };

/** "Maksed"'s filter: every payment, or one status. */
export type PaymentFilter = "all" | PaymentStatus;

const rowFields = { payment: payments, courseTitle: courses.title, courseSlug: courses.slug, startsAt: courseSessions.startsAt };

function rowQuery(db: Db) {
  return db
    .select(rowFields)
    .from(payments)
    .leftJoin(courses, eq(payments.courseId, courses.id))
    .leftJoin(registrations, eq(payments.registrationId, registrations.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id));
}

const toRow = (r: { payment: Payment; courseTitle: I18n | null; courseSlug: string | null; startsAt: Date | null }): PaymentRow => ({ ...r.payment, courseTitle: r.courseTitle, courseSlug: r.courseSlug, startsAt: r.startsAt });

/** One page of "Maksed": newest first, `size` (50) a page, all or one status. */
export async function pagePayments(db: Db, filter: PaymentFilter, page: number, size: number = PAGE_SIZE): Promise<Paged<PaymentRow>> {
  const where = filter === "all" ? undefined : eq(payments.status, filter);
  return paged(
    page,
    size,
    async () => Number((await db.select({ n: count() }).from(payments).where(where))[0].n),
    async (range) => (await rowQuery(db).where(where).orderBy(desc(payments.createdAt), desc(payments.id)).limit(range.limit).offset(range.offset)).map(toRow),
  );
}

/**
 * The payments of one registration (its drawer), or of one student (the Õpilased drawer): hers, and those of her registrations — a payment
 * made before she had an account carries no client of its own, its registration was linked to her later. Newest first.
 */
export async function listPaymentsOf(db: Db, of: { registrationId: number } | { clientId: number }): Promise<PaymentRow[]> {
  const where =
    "registrationId" in of
      ? eq(payments.registrationId, of.registrationId)
      : or(eq(payments.clientId, of.clientId), sql`${payments.registrationId} in (select r.id from registrations r where r.client_id = ${of.clientId})`);
  return (await rowQuery(db).where(where).orderBy(desc(payments.createdAt), desc(payments.id))).map(toRow);
}
```

  3. **`src/server/admin-clients.ts`.** Import `listPaymentsOf, type PaymentRow` from `@/db/queries/payments`. `ClientDetail` gains `/** Her online payments (phase 2b), newest first. */ payments: PaymentRow[];`. In `clientDetail`'s `Promise.all`, add `listPaymentsOf(db, { clientId: id })` as the last entry (`const [[client], regs, reqs, access, terms, payments] = …`), and the returned object gains `payments,` after `newsletter`.
  4. Run `npx vitest run tests/db/payments-admin.test.ts tests/db/admin-clients.test.ts` — PASS.

- [ ] **Step 3: The admin's words** (`src/i18n/dict/admin.ts`).
  1. In `nav`, after `registrations: "Registreerimised",`, add `payments: "Maksed",`.
  2. After the `registrations` section, add:

```ts
  // "Maksed" (phase 2b, spec 8): the online payments through Montonio. Bank transfers stay Maria's own entries on the registration.
  payments: {
    eyebrow: "Montonio",
    title: "Maksed",
    lead: "Veebimaksed Montonio kaudu, uuemad eespool. Tagastused tehakse Montonio töölaual; pangaülekanded märgid registreerimise juures nagu varem.",
    filterLabel: "Staatus",
    filter: { all: "Kõik", paid: "Makstud", pending: "Pooleli", failed: "Ebaõnnestunud", refunded: "Tagastatud", held: "Ootel kontrollil" },
    status: { pending: "Pooleli", paid: "Makstud", failed: "Ebaõnnestunud", refunded: "Tagastatud", held: "Ootel kontrollil" },
    kind: { prepayment: "Ettemaks", balance: "Ülejäänud", ecourse: "E-koolitus" },
    // a held payment, or one the bank voided after it was paid
    check: "Kontrolli Montonios",
    count: "Makseid: {n}",
    empty: "Makseid veel pole.",
    emptyFiltered: "Selle valikuga makseid pole.",
    col: { date: "Kuupäev", payer: "Maksja", what: "Mis", kind: "Liik", amount: "Summa", method: "Viis", status: "Staatus", provider: "Montonio id" },
    courseGone: "Koolitus on kustutatud",
    // under "Laekunud" in a registration's drawer
    online: "Veebimaksed",
    // the Õpilased drawer
    noneForClient: "Makseid pole.",
  },
```

  3. In `clients.drawer`, after `grantedBy: "Avas {who}, {date}",`, add `// an access a paid e-course purchase opened (granted_by "payment", phase 2b)` and `byPayment: "veebimakse",`.
- [ ] **Step 4: The menu.**
  1. **`src/components/admin/sections.ts`.** `Section` gains `| "payments"` after `"registrations"`; in `SECTIONS`, after the registrations entry, add `{ key: "payments", href: "/admin/maksed", icon: "card" },`.
  2. **`src/components/admin/AdminIcon.tsx`.** In `PATHS`, after `clipboard`, add `card: ["M3 6h18v12H3z", "M3 10h18", "M7 15h4"],` and in the top comment add "card" to the icons the real menu needs.
- [ ] **Step 5: The lines of payments** — create `src/components/admin/PaymentLines.module.css`:

```css
/* The online payments of a registration or a student (phase 2b): one line each, the status as the admin's tags. */

.lines {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-size: 14px;
}

.when {
  color: var(--muted-2);
}
```

  and `src/components/admin/PaymentLines.tsx`:

```tsx
import type { PaymentRow } from "@/db/queries/payments";
import type { PaymentStatus } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { needsCheck } from "@/domain/payments";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { formatDate, formatTime } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./PaymentLines.module.css";

/** A payment status's tag colour: paid ok, pending and held to look at, failed bad, refunded plain. */
export const PAYMENT_TONE: Record<PaymentStatus, string> = { paid: ui.ok, pending: ui.warn, held: ui.warn, failed: ui.bad, refunded: "" };

/**
 * Online payments as short lines (phase 2b, spec 8): when, how much, the kind (`withWhat`: and the course), the status, and "Kontrolli
 * Montonios" on a held payment or one voided after it was paid. A registration's drawer (under "Laekunud") and the Õpilased drawer show them.
 */
export function PaymentLines({ rows, withWhat = false }: { rows: PaymentRow[]; withWhat?: boolean }) {
  const t = adminEt.payments;
  return (
    <ul className={styles.lines} data-payment-lines="">
      {rows.map((p) => (
        <li key={p.id} className={styles.line} data-payment={p.reference} data-payment-status={p.status}>
          <span className={styles.when}>
            {formatDate(p.createdAt, "et")} {formatTime(p.createdAt, "et")}
          </span>
          <strong>{formatEUR(p.amountCents, "et")}</strong>
          <span>
            {t.kind[p.kind]}
            {withWhat ? ` · ${p.courseTitle ? pick(p.courseTitle, "et") : t.courseGone}` : ""}
          </span>
          <span className={`${ui.tag} ${PAYMENT_TONE[p.status]}`}>{t.status[p.status]}</span>
          {needsCheck(p) && (
            <span className={`${ui.tag} ${ui.bad}`} data-payment-check="">
              {t.check}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: The page "Maksed".**
  1. Create `src/app/admin/(panel)/maksed/payments.module.css`:

```css
/* Maksed (phase 2b): the list's own pieces (the table itself is the shared admin list, components/admin/list-table.module.css). */

.count {
  margin-bottom: 6px;
}

.sub {
  display: block;
  font-size: 12px;
}

.contact {
  color: var(--muted-2);
  font-size: 12px;
  overflow-wrap: break-word;
  word-break: break-word;
  text-decoration: none;
}

.contact:hover {
  text-decoration: underline;
}

.status {
  display: grid;
  justify-items: start;
  gap: 6px;
}

.provider {
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* a row Maria must look at in Montonio: held, or voided after it was paid */
.check > td {
  background: color-mix(in srgb, var(--bad) 6%, transparent);
}

/* the time next to the date once the row is a block (the shared list's narrow card) */
@container (max-width: 980px) {
  .sub {
    display: inline;
    margin-left: 6px;
  }
}
```

  2. Create `src/app/admin/(panel)/maksed/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { PAYMENT_TONE } from "@/components/admin/PaymentLines";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { pagePayments } from "@/db/queries/payments";
import type { PaymentStatus } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { parsePage } from "@/domain/paging";
import { needsCheck } from "@/domain/payments";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./payments.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.payments) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?staatus=makstud|pooleli|ebaonnestunud|tagastatud|kontroll (the filter), ?leht=<n> (50 a page). A new filter starts at page 1.
const STATUS_PARAM: Record<string, PaymentStatus> = { makstud: "paid", pooleli: "pending", ebaonnestunud: "failed", tagastatud: "refunded", kontroll: "held" };
const PARAM_OF: Record<PaymentStatus, string> = { paid: "makstud", pending: "pooleli", failed: "ebaonnestunud", refunded: "tagastatud", held: "kontroll" };

type View = { staatus: PaymentStatus | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View {
  const staatus = one(sp.staatus);
  return { staatus: staatus && staatus in STATUS_PARAM ? STATUS_PARAM[staatus] : null, leht: parsePage(sp.leht) };
}

function href(view: View): string {
  const q = new URLSearchParams();
  if (view.staatus) q.set("staatus", PARAM_OF[view.staatus]);
  if (view.leht > 1) q.set("leht", String(view.leht));
  const s = q.toString();
  return `/admin/maksed${s ? `?${s}` : ""}`;
}

/**
 * Maksed (phase 2b, spec 8): the online payments, newest first, 50 a page, with the status filter. Each row: the date, the payer (a link to the
 * student when the payment has one), what it was for, the kind, the amount, the method and bank, the status — "Kontrolli Montonios" on a held
 * payment or one voided after it was paid — and Montonio's id (to find it in Montonio's dashboard). Read-only: refunds are Montonio's.
 */
export default async function PaymentsPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const view = parse(await searchParams);
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list] = await Promise.all([pagePayments(getDb(), view.staatus ?? "all", view.leht), getAdminCounts()]);
  const t = adminEt.payments;
  const filters: { key: PaymentStatus | null; label: string }[] = [
    { key: null, label: t.filter.all },
    { key: "paid", label: t.filter.paid },
    { key: "pending", label: t.filter.pending },
    { key: "failed", label: t.filter.failed },
    { key: "refunded", label: t.filter.refunded },
    { key: "held", label: t.filter.held },
  ];

  return (
    <Shell email={email} active="payments">
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>

        <nav className={ui.filters} aria-label={t.filterLabel} data-payment-filter="">
          {filters.map((l) => (
            <Link key={l.label} className={ui.pill} href={href({ staatus: l.key, leht: 1 })} aria-current={view.staatus === l.key ? "true" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {list.rows.length === 0 ? (
            <p className={ui.empty}>{view.staatus ? t.emptyFiltered : t.empty}</p>
          ) : (
            <table className={`${ui.table} ${listTable.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.date}</th>
                  <th scope="col">{t.col.payer}</th>
                  <th scope="col">{t.col.what}</th>
                  <th scope="col">{t.col.kind}</th>
                  <th scope="col">{t.col.amount}</th>
                  <th scope="col">{t.col.method}</th>
                  <th scope="col">{t.col.status}</th>
                  <th scope="col">{t.col.provider}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((p) => {
                  const check = needsCheck(p);
                  return (
                    <tr key={p.id} className={check ? styles.check : undefined} data-payment={p.reference} data-payment-status={p.status}>
                      <td data-label={t.col.date} className={ui.nowrap}>
                        <span>
                          {formatDate(p.createdAt, "et")}
                          <span className={`${ui.muted} ${styles.sub}`}>{formatTime(p.createdAt, "et")}</span>
                        </span>
                      </td>
                      <td data-label={t.col.payer}>
                        <div className={listTable.who}>
                          {p.clientId ? (
                            <Link className={listTable.name} href={`/admin/opilased?id=${p.clientId}`}>
                              {p.name}
                            </Link>
                          ) : (
                            <span className={listTable.name}>{p.name}</span>
                          )}
                          <a className={`${ui.contactLink} ${styles.contact}`} href={`mailto:${p.email}`}>
                            {p.email}
                          </a>
                        </div>
                      </td>
                      <td data-label={t.col.what}>
                        {p.courseTitle ? pick(p.courseTitle, "et") : t.courseGone}
                        {p.startsAt && <span className={`${ui.muted} ${styles.sub}`}>{formatDate(p.startsAt, "et")}</span>}
                      </td>
                      <td data-label={t.col.kind}>{t.kind[p.kind]}</td>
                      <td data-label={t.col.amount} className={ui.nowrap}>
                        {formatEUR(p.amountCents, "et")}
                      </td>
                      <td data-label={t.col.method}>{[p.method, p.bank].filter(Boolean).join(" · ") || adminEt.common.none}</td>
                      <td data-label={t.col.status}>
                        <span className={styles.status}>
                          <span className={`${ui.tag} ${PAYMENT_TONE[p.status]}`}>{t.status[p.status]}</span>
                          {check && (
                            <span className={`${ui.tag} ${ui.bad}`} data-payment-check="">
                              {t.check}
                            </span>
                          )}
                        </span>
                      </td>
                      <td data-label={t.col.provider} className={styles.provider}>
                        {p.providerUuid ?? adminEt.common.none}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <Pager info={list} href={(n) => href({ ...view, leht: n })} />
        </section>
      </div>
    </Shell>
  );
}
```

- [ ] **Step 7: The two drawers.**
  1. **`src/app/admin/(panel)/registreerimised/page.tsx`.**
     - Imports: `import { PaymentLines } from "@/components/admin/PaymentLines";` and `import { listPaymentsOf, type PaymentRow } from "@/db/queries/payments";`.
     - The `Promise.all` becomes `const [list, open, online] = await Promise.all([pageRegistrations(db, filter, view.leht), view.id ? getRegistration(db, view.id) : null, view.id ? listPaymentsOf(db, { registrationId: view.id }) : [], getAdminCounts()]);` and the drawer renders `<RegistrationDetail r={open} payments={online} />`.
     - `function RegistrationDetail({ r }: { r: RegistrationRow })` becomes `function RegistrationDetail({ r, payments }: { r: RegistrationRow; payments: PaymentRow[] })`, and inside `<section className={styles.money} …>`, after the `total == null ? … : <dl …>` block, add:

```tsx
        {/* the online payments under "Laekunud" (phase 2b, spec 8); Maria's own "amount received" form below stays */}
        {payments.length > 0 && (
          <div className={styles.online} data-registration-payments="">
            <h3 className={ui.h3}>{adminEt.payments.online}</h3>
            <PaymentLines rows={payments} />
          </div>
        )}
```

     - **`registrations.module.css`**, after `.detailsTitle`, add:

```css
/* the online payments under "Laekunud" (phase 2b) */
.online {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}
```

  2. **`src/components/admin/ClientDrawer.tsx`.**
     - Import `PaymentLines` from `./PaymentLines`.
     - The access row's `fill(t.grantedBy, { who: a.grantedBy, date: stamp(a.grantedAt) })` becomes `fill(t.grantedBy, { who: a.grantedBy === "payment" ? t.byPayment : a.grantedBy, date: stamp(a.grantedAt) })`.
     - After the registrations `</section>`, add:

```tsx
      <section className={styles.section} aria-labelledby={`client-${c.id}-payments`} data-client-payments="">
        <h3 id={`client-${c.id}-payments`} className={ui.h3}>
          {adminEt.payments.title}
        </h3>
        {detail.payments.length === 0 ? <p className={styles.none}>{adminEt.payments.noneForClient}</p> : <PaymentLines rows={detail.payments} withWhat />}
      </section>
```

     - The component's doc comment, after "then her registrations (each with a link to its own drawer),", gains "her online payments (phase 2b),".
- [ ] **Step 8: Run everything.**
  - `npx vitest run` — all green (the admin dictionary test: no empty strings).
  - `npx tsc --noEmit`, then `npx eslint .`.
  - `npx playwright test admin-inbox admin-clients admin-auth` (the menu, the drawers).

- [ ] **Step 9: Commit.**

```bash
git add app/src/domain/payments.ts app/src/db/queries/payments.ts app/src/i18n/dict/admin.ts app/src/components/admin "app/src/app/admin/(panel)/maksed" "app/src/app/admin/(panel)/registreerimised" app/src/server/admin-clients.ts app/tests
git commit -m "feat(admin): Maksed — the online payments with their filter, in a registration's drawer and the Õpilased drawer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: E2E — every payment flow against the fake Montonio, under `next dev` and the production build

Spec section 12 (E2E). Tasks 4–7 already moved the existing specs onto the fake bank and added `pay-page.spec.ts`; the coming-soon gate's cases came with Tasks 3, 5 and 6. This task adds `payments.spec.ts`: the flows end to end, each with its own sample address (`e2e-client-pay-…@example.test`, never mailed; removed after each test by `removeClientRows`, which deletes their payments too).

The flows:
1. A group registration paid at the bank → `/makse` "Makse õnnestus" → her card says confirmed with the rest → "Maksa ülejäänud 175 €" paid → fully paid.
2. Cancelled at the bank → "Makse jäi tegemata." → "Proovi uuesti" → the `/maksa` page → paid. The result page at 390 / 834 / 1440 without overflow, its button 44 px.
3. Pending at the bank ("Pooleli": the bank decides later) → "Makse on pooleli" → the bank confirms (the fake's webhook) → paid.
4. An e-course bought from the cart → paid → "Ava e-koolitus"; the access is hers, by "payment", and her card offers "Ava koolitus".
5. The admin's "Maksed": the filter, "Kontrolli Montonios" on a held payment, the registration's drawer listing its payments.

A paid group registration takes a real seat of a seed session (Kulmumeistri baaskoolitus, Tallinn, 6 seats) for the length of the test; no other spec counts that session's seats, and the row is removed after the test.

**Files:**
- Create: `app/tests/e2e/payments.spec.ts`

**Interfaces:**
- Consumes: `E2E_MONTONIO`, the fake's `/_fake/orders/<reference>` and `/_fake/settle/<uuid>` (Task 2); `storedPayments`, `storedPayToken`, `storedRegistrations`, `onLocalDb`, `removeClientRows`, `removeAdminRows` (`tests/e2e/fixtures.ts`); `clientEmail`, `insertAccountFixtures`, `signInAsClient` (`tests/e2e/account.ts`); `signInAsAdmin`, `CreatedRows` (`tests/e2e/admin-login.ts`).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the spec** `tests/e2e/payments.spec.ts`:

```ts
import type { Page } from "@playwright/test";
import { clientEmail, insertAccountFixtures, signInAsClient } from "./account";
import { signInAsAdmin, type CreatedRows } from "./admin-login";
import { onLocalDb, removeAdminRows, removeClientRows, storedPayments, storedPayToken, storedRegistrations } from "./fixtures";
import { E2E_MONTONIO } from "./montonio-values";
import { submitsForms, test, expect } from "./test";

// Phase 2b (spec 12): the online payments end to end against the e2e run's fake Montonio (tests/e2e/fake-montonio.ts: PAYMENT_PROVIDER=mock,
// the app's real client, signed tokens, the webhook). Every payer is a sample address (`e2e-client-pay-…@example.test`, never mailed) whose
// rows — registrations, payments, the client — are removed after each test.

const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };

test.beforeEach(() => submitsForms());
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

/** A fresh payer address for this test (its leftovers removed first). */
async function fresh(label: string, project: string): Promise<string> {
  const email = clientEmail(`pay-${label}`, project);
  made.add(email);
  await removeClientRows(email);
  return email;
}

/** The group registration form of the open course page: a date in `city`, the payer, the payment choice, the terms; "Registreeru". */
async function register(page: Page, email: string, choice: "100%" | "50%", city: string): Promise<void> {
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").filter({ hasText: city }).first().click();
  await page.getByLabel("Nimi").fill("Test Maksja");
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByRole("radio", { name: new RegExp(choice) }).check();
  await page.getByLabel(/tingimustega/).check();
  await page.getByRole("button", { name: "Registreeru" }).click();
}

/** At the fake bank: one of its three outcomes. */
async function atBank(page: Page, outcome: "Makstud" | "Pooleli" | "Katkesta"): Promise<void> {
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await page.getByRole("button", { name: outcome }).click();
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("a group registration paid at the bank: confirmed, the rest offered on her card; the rest paid: fully paid (spec 6.1, 6.2, D5)", async ({ page }, info) => {
  const email = await fresh("reg", info.project.name);
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  await register(page, email, "50%", "Tallinn");
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);

  await signInAsClient(page, email);
  const card = page.locator("[data-card^='registration-']");
  await expect(card.locator("[data-next-step]")).toHaveText("Koht on kinnitatud. Ülejäänud 175 € tasud koolituspäeval.");
  await card.getByRole("button", { name: "Maksa ülejäänud 175 €" }).click();
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud/);
  await page.goto("/konto");
  await expect(card.locator("[data-next-step]")).toHaveText("Koht on kinnitatud.");
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 35000, paymentChoice: "half" })]);
  expect(await storedPayments(email)).toEqual([
    { kind: "prepayment", status: "paid", amountCents: 17500 },
    { kind: "balance", status: "paid", amountCents: 17500 },
  ]);
});

test("cancelled at the bank: 'Makse jäi tegemata.' and 'Proovi uuesti' (the /maksa page) → paid; the result page fits 390, 834 and 1440", async ({ page }, info) => {
  const email = await fresh("retry", info.project.name);
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  await register(page, email, "50%", "Tallinn");
  await atBank(page, "Katkesta");
  await page.waitForURL(/\/makse#tulemus=katkestatud&liik=registreering&maksa=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse jäi tegemata.");
  const retry = page.getByRole("link", { name: "Proovi uuesti" });
  for (const width of [390, 834, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noOverflow(page), String(width)).toBe(true);
    expect((await retry.boundingBox())!.height, String(width)).toBeGreaterThanOrEqual(44);
  }
  await retry.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolituse eest tasumine");
  await page.getByRole("button", { name: "Maksa 175 €" }).click();
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud/);
  expect(await storedPayments(email)).toEqual([
    { kind: "prepayment", status: "failed", amountCents: 17500 },
    { kind: "prepayment", status: "paid", amountCents: 17500 },
  ]);
});

test("pending at the bank: 'Makse on pooleli'; the bank confirms later (Montonio's webhook): paid", async ({ page }, info) => {
  const email = await fresh("pending", info.project.name);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
  await page.goto(`/maksa/${await storedPayToken(f.registrations.awaiting!)}`);
  await page.getByRole("button", { name: "Maksa 175 €" }).click();
  await atBank(page, "Pooleli");
  await page.waitForURL(/\/makse#tulemus=pooleli&liik=registreering&maksa=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.");
  expect(await storedPayments(email)).toEqual([{ kind: "prepayment", status: "pending", amountCents: 17500 }]);
  const [{ reference }] = await onLocalDb((sql) => sql<{ reference: string }[]>`select reference from payments where email = ${email}`, { marksPages: false });
  const order = (await (await fetch(`${E2E_MONTONIO.url}/_fake/orders/${reference}`)).json()) as { uuid: string };
  expect((await fetch(`${E2E_MONTONIO.url}/_fake/settle/${order.uuid}`, { method: "POST", body: JSON.stringify({ status: "PAID" }) })).status).toBe(200);
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
});

test("an e-course bought from the cart: paid → 'Ava e-koolitus'; the access is hers, opened by the payment, and her card offers it (spec 6.4)", async ({ page }, info) => {
  const email = await fresh("ecourse", info.project.name);
  await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
  const form = page.locator("[data-ecourse-form]");
  await form.getByLabel("Nimi").fill("Test Ostja");
  await form.getByLabel("E-post").fill(email);
  await form.getByLabel(/tingimustega/).check();
  await form.getByRole("button", { name: "Maksa 190 €" }).click();
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus$/);
  await expect(page.getByRole("link", { name: "Ava e-koolitus" })).toHaveAttribute("href", "/konto/kursus/kulmumeistri-e-koolitus");
  const access = await onLocalDb(
    (sql) => sql<{ grantedBy: string; name: string }[]>`
      select a.granted_by as "grantedBy", c.name from course_access a join clients c on c.id = a.client_id join courses k on k.id = a.course_id
      where c.email = ${email} and k.slug = 'kulmumeistri-e-koolitus'`,
    { marksPages: false },
  );
  expect(access).toEqual([{ grantedBy: "payment", name: "Test Ostja" }]);
  await signInAsClient(page, email);
  await expect(page.locator("[data-card='course-kulmumeistri-e-koolitus'] [data-card-action='open']")).toBeVisible();
});

test("the admin's Maksed: the filter, 'Kontrolli Montonios' on a held payment; the registration's drawer lists its payments (spec 8)", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("admin", info.project.name);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
  const regId = f.registrations.awaiting!;
  const refs = await onLocalDb(
    async (sql) =>
      (
        await sql<{ reference: string }[]>`
          insert into payments (reference, kind, registration_id, course_id, email, name, amount_cents, status, provider_uuid, method, bank, paid_at)
          values (${`E2E-${regId}-1`}, 'prepayment', ${regId}, ${f.course.id}, ${email}, 'E2E Maksja', 17500, 'paid', ${`e2e-uuid-${regId}-1`}, 'paymentInitiation', 'Testpank', now()),
                 (${`E2E-${regId}-2`}, 'balance', ${regId}, ${f.course.id}, ${email}, 'E2E Maksja', 17500, 'held', ${`e2e-uuid-${regId}-2`}, 'paymentInitiation', 'Testpank', null)
          returning reference`
      ).map((r) => r.reference),
    { marksPages: false },
  );
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/maksed");
  await expect(page.locator("[data-nav='payments']")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("nav[data-payment-filter] a")).toHaveText(["Kõik", "Makstud", "Pooleli", "Ebaõnnestunud", "Tagastatud", "Ootel kontrollil"]);
  const paid = page.locator(`[data-payment="${refs[0]}"]`);
  for (const text of ["E2E Maksja", "Ettemaks", "175 €", "Makstud", "paymentInitiation · Testpank", `e2e-uuid-${regId}-1`]) await expect(paid).toContainText(text);
  await expect(page.locator(`[data-payment="${refs[1]}"] [data-payment-check]`)).toHaveText("Kontrolli Montonios");
  await page.locator("nav[data-payment-filter]").getByRole("link", { name: "Ootel kontrollil" }).click();
  await expect(page).toHaveURL(/\/admin\/maksed\?staatus=kontroll$/);
  await expect(page.locator(`[data-payment="${refs[1]}"]`)).toBeVisible();
  await expect(page.locator(`[data-payment="${refs[0]}"]`)).toHaveCount(0);
  await page.goto(`/admin/registreerimised?id=${regId}`);
  await expect(page.locator("[data-registration-payments] [data-payment]")).toHaveCount(2);
  await expect(page.locator(`[data-registration-payments] [data-payment="${refs[1]}"] [data-payment-check]`)).toHaveText("Kontrolli Montonios");
});
```

- [ ] **Step 2: Run it** under `next dev`: `npx playwright test payments` — every test passes in both projects (desktop and phone). A failure that lands on the real sandbox's page instead of `localhost:3997/pay/…` means a dev server you started yourself was reused: stop it and run again.
- [ ] **Step 3: Run it** on the production build: `E2E_PROD_BUILD=1 npx playwright test payments pay-page course cache account-dashboard`.
- [ ] **Step 4: The whole e2e run**, both modes: `npx playwright test` and `E2E_PROD_BUILD=1 npx playwright test` — green (global teardown finds no leftover rows: the payments of the test addresses are counted there since Task 4). Then `npx playwright test -c playwright.gate.config.ts`.
- [ ] **Step 5: Look at the pages.** `npm run visual`, then open `visual-shots/local/<width>/` for the cart (`/ostukorv?kursus=kulmumeistri-e-koolitus`) at 390 / 834 / 1440, and, by hand in the browser at the same widths, `/makse#tulemus=katkestatud&liik=registreering&maksa=x` and a `/maksa/<token>` page: one primary button each, nothing overflows, the text buttons are 44 px tall.
- [ ] **Step 6: Run** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — green.
- [ ] **Step 7: Commit.**

```bash
git add app/tests/e2e/payments.spec.ts
git commit -m "test(e2e): every payment flow against the fake Montonio — registration, the rest, retry, pending, e-course, Maksed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The docs — the Montonio variables, the payments' runbook, and the launch checklist

Spec sections 7.2, 11, 13 and the launch items. Text only; no secret goes in (no key, no token, no database URL): the three `MONTONIO_` variables are **plain** variables of Maria's Vercel project, by the owner's choice (08.10.2026), and never in the repository. The Russian texts of 2b go to the native-speaker list. The address guard scans `docs/`: no real address is written.

**Files:**
- Modify: `docs/deploy.md`, `docs/launch-checklist.md`

**Interfaces:** none.

- [ ] **Step 1: `docs/deploy.md` §2 (Environment variables).**
  1. In the **Optional** table, after the `PREVIEW_SECRET` row, add:

```
| `MONTONIO_ENV` | Online payments (section 11): `live` (exactly) is Montonio's production, anything else (`sandbox`) its sandbox. The keys must be of the same environment: live keys on the sandbox address answer 401 `STORE_NOT_FOUND`. |
| `MONTONIO_ACCESS_KEY`, `MONTONIO_SECRET_KEY` | Maria's Montonio store's API keys (Partner System → Stores → API Keys, per environment). Both or none: without them there are no online payments and the site behaves as before phase 2b (no "Maksa" buttons, the cart's "Makse lisandub peagi", `/api/payments/*` answer 404). The secret key is secret (a plain variable, the owner's choice; never in the repo, never in a log). |
```

  2. The paragraph "Local only, never on Vercel: …" gains, after `BUNNY_FAKE_URL (…)`: "`PAYMENT_PROVIDER=mock`, `MONTONIO_FAKE_URL` and `PAYMENT_MOCK_IN_PRODUCTION` (the e2e run's fake Montonio: refused on Vercel, and in a production build without the last one; any other `PAYMENT_PROVIDER` value turns payments off, it never falls back to the fake)". And after its last sentence add: "For trying payments by hand in `next dev`, put the **sandbox** keys and `MONTONIO_ENV=sandbox` in `app/.env.local` (git-ignored); the e2e run overrides them with the fake's."
- [ ] **Step 2: `docs/deploy.md` §5 (the daily cron).** After the sentence about the expired client login codes …, add: "With online payments set up (section 11) it also asks Montonio (`GET /orders/:uuid`) about every pending payment older than 45 minutes and younger than 14 days, at most 50 a run and none after the 35 seconds, and settles what Montonio says; pending payments of 14 days, and orders that were never created, become failed; when unpaid seat holds ended in the last day, the calendar and the course pages are revalidated. The log line adds `[cron] sweep: payments N checked at Montonio, N settled, N not answered, N failed as stale, N left for the next run, N seat holds ended`." In the 200 answer's description, add the fields `paymentsChecked`, `paymentsSettled`, `paymentsExpired`, `paymentsLeft`.
- [ ] **Step 3: `docs/deploy.md` §9 (Hobby limits).** In the bullet about hung functions, add: "Montonio has 15 s to answer; the webhook, the return, `/maksa/<token>` and `/api/konto` set `maxDuration = 30`."
- [ ] **Step 4: `docs/deploy.md`, a new section at the end:**

```
## 11. Montonio (online payments)

Students pay through Maria's Montonio store (phase 2b, spec `docs/superpowers/specs/2026-10-09-phase2b-montonio-payments-design.md`): bank links, and cards, Apple Pay and Google Pay when Maria turns them on in the store. The bank or the card is chosen on Montonio's own page; the site shows no bank logos.

1. **Keys.** Partner System → Stores → (the store) → API Keys: the access key and the secret key, separately for the sandbox and for production. Set `MONTONIO_ENV`, `MONTONIO_ACCESS_KEY` and `MONTONIO_SECRET_KEY` in Production as plain variables (`vercel env add <NAME> production --no-sensitive --force`; the CLI asks for the value, it is never typed into a file), then redeploy. `vercel env ls production` lists the names without values.
2. **Nothing to set in Montonio for the way back.** Every order carries its own `returnUrl` (`/api/payments/return`) and `notificationUrl` (`/api/payments/notify`) on the address the payment was started from (mslab.ee, or SITE_URL). The webhook must reach the app while the coming-soon gate is on: `/api/payments/notify` always goes through it, and so does `/maksa/<token>` (the mail's "Maksa" link); the return and `/makse` are behind the gate like the rest of the site (admins with the preview cookie).
3. **What the app sends.** `payment.method` `paymentInitiation` with no preferred bank, `paymentDescription` `MS LAB MSLAB-M<id>`, never a `paymentReference`; every new attempt is a new order with a new `merchantReference` (`MSLAB-M<id>`, the row of the `payments` table). Pressing "Maksa" / "Proovi uuesti" again while that attempt's order is open (30 minutes from its last sending) sends the same order again under the same reference: Montonio replaces the unpaid order, so a payer never has two orders to pay. Montonio's payment window is its default 30 minutes, and an unpaid group registration holds its seat as long (`SEAT_HOLD_MS` in `app/src/domain/sessions.ts`): if the window is ever changed in the store, change the hold too.
4. **What the app trusts.** Only an order token signed with the store's secret key (HS256). A token for another store, for another order, or one older than its 10 minutes (a late retry) is confirmed with `GET /orders/:uuid` before anything changes; a paid amount or currency that is not the payment's makes it `held` ("Ootel kontrollil" in Maksed) and Maria gets "Kontrolli Montonios". A payment the bank voids after it was paid, and every refund, also alert Maria and change nothing by themselves.
5. **Refunds** are made in Montonio's own dashboard (Orders → the order → Refund). The app then marks the payment "Tagastatud" from Montonio's notice; Maria adjusts or cancels the registration (or ends the e-course access) in the admin herself.
6. **The sandbox.** The sandbox's bank links work with its test banks; the test card is `4111 1111 1111 1111`, 03/30, CVC 737. A paid or failed bank flow cannot be produced automatically: it is a check by hand (the go-live, `docs/launch-checklist.md` section 10).
7. **The logs.** `[payments] payment N: started`, `… paid`, `… failed`, `… held, Maria is alerted` (and `voided`, `refunded`), `[payments] webhook: a token that cannot be verified (signature)`; never a key, a token, a `pay_token` or an address. Montonio's own error text is kept (`[payments] payment N: no order (rejected: HTTP 401 · STORE_NOT_FOUND …)`).
8. **Rollback.** A rollback of the code past phase 2b (section 8) leaves the `payments` table and the two registration columns in place (migration 0006 is additive); unset the three `MONTONIO_` variables first if the older code should not be offered payments it cannot settle.
```

  In §6 (Migrations), after "Check afterwards (`select count(*) from drizzle.__drizzle_migrations`).", add "(7 after phase 2b's 0006.)".
- [ ] **Step 5: `docs/launch-checklist.md`, a new section at the end:**

```
## 10. Phase 2b (online payments with Montonio)
- [ ] Go-live with the **sandbox** keys behind the coming-soon gate (plan 2026-10-09-phase2b, Task 12): migration 0006 on Railway first, then `MONTONIO_ENV=sandbox` and the sandbox keys in Production (plain variables, never in the repo), then the deploy and the live checks with sample addresses.
- [ ] Before the public launch: Maria's Montonio store is approved; Dim enters the **live** keys and `MONTONIO_ENV=live` in Production and redeploys (`docs/deploy.md` section 11).
- [ ] Maria turns on in her store the methods she wants: bank links; cards, Apple Pay and Google Pay cost more per payment (her choice).
- [ ] One real purchase at about €1 (a 1 € test e-course or test session, unpublished afterwards) with an immediate manual refund in Montonio's dashboard; Maksed then shows it "Tagastatud".
- [ ] The privacy text (Seaded → Privaatsus) gets Maria's line about payments through Montonio: a payment row keeps the payer's name, e-mail and amount for the books, also after the account is deleted.
- [ ] Native-speaker check of the Russian texts phase 2b added: `payment.pay`, `payment.payRest`, `payment.transfer`, `payment.starting`, `payment.page.*`, `payment.result.*` (`openCourse` included), `payment.mail.*` (the subjects, `leadConfirmed` … `access`).
- [ ] Maria's "Ettemaksu juhised" in Seaded: the bank transfer stays the second way under "Maksa" (D6); she records those payments by hand as before.
- [ ] Accepted: a cached calendar can show "Täis" for up to 30 minutes after an unpaid hold ends (the registration form checks live; a payment, a registration or the daily sweep revalidates).
- [ ] Accepted: "Proovi uuesti" is offered on "pooleli" too, because Montonio answers a cancel at the bank with PENDING. The retry sends the same order again (the same reference) while it is open, and Montonio replaces the unpaid one, so the first cannot be paid as well; only after its 30 minutes is a retry a new order. Watch Maksed for a registration with two paid prepayments in the first weeks all the same (Maria refunds one in Montonio).
- [ ] Watch Maksed → "Ootel kontrollil" and the "Kontrolli Montonios" mails for the first weeks.
- [ ] e2e: a dev server started by hand is reused by Playwright and would talk to the sandbox of `app/.env.local` instead of the fake Montonio: stop it before a run.
```

- [ ] **Step 6: Check.** Read both docs once more: no key, token, secret, database URL or personal address (`npx vitest run tests/unit/test-addresses.test.ts`). Then `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — green.
- [ ] **Step 7: Commit.**

```bash
git add docs/deploy.md docs/launch-checklist.md
git commit -m "docs: online payments — the Montonio variables and runbook, the daily check, and the go-live list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Migration 0006 on Railway, the sandbox keys, the deploy and the live checks (controller)

Spec section 13. This task is run by the controller, not a subagent. It is the first that writes to Railway, pushes or deploys.

The order is "the additive migration first, then the keys, then the deploy": the live code (2c) never names `payments`, `seat_hold_until` or `pay_token`, and its registration insert gets a `pay_token` from the column's default, so 0006 cannot disturb it. The sandbox keys are safe in Production while the coming-soon gate is on: only admins with the preview cookie reach the buy flows (spec 10, 13.2).

The ledger is `.superpowers/sdd/2026-10-09-phase2b-montonio-payments/progress.md` (git-ignored). Record each step's outcome there: counts and statuses only, never a URL, a key, a token or an address.

**Files:** none (the database, the Vercel variables, the deployment and the ledger).

- [ ] **Step 1 (read-only): Railway before.** Take the public TCP proxy URL of Maria's Railway project `mslab` (Postgres → Connect → Public Network) and put it in the shell only (`docs/deploy.md` section 6), with `?sslmode=require`. Read, printing counts only:
  - `select count(*) from drizzle.__drizzle_migrations` → 6 (0000–0005);
  - `select count(*) from information_schema.tables where table_name = 'payments'` → 0;
  - `select count(*) from registrations` → note N.
- [ ] **Step 2: Branch checks.**
  - The whole `npx vitest run`, `npx tsc --noEmit` and `npx eslint .`.
  - `next build`: every `/[locale]/konto…` route and `/[locale]/makse` are prerendered (● / ○), never ƒ; `/[locale]/ostukorv/[kursus]` stays ● (ISR).
  - The e2e under `next dev` and with `E2E_PROD_BUILD=1` (the whole run), and `npx playwright test -c playwright.gate.config.ts`.
  - `git status` is clean on `feat/phase2b-payments`.
- [ ] **Step 3 (read-only): the production variables.** `vercel --global-config ~/.vercel-mslabinformation env ls production` from the scratch link folder of Maria's project: `DATABASE_URL`, `SITE_URL`, `MAIL_FROM`, `RESEND_API_KEY`, `CRON_SECRET`, `SITE_GATE`, `PREVIEW_SECRET` are there; `MONTONIO_*` are not yet; `PAYMENT_PROVIDER`, `MONTONIO_FAKE_URL`, `PAYMENT_MOCK_IN_PRODUCTION` are not and never will be. No value is printed.
- [ ] **Step 4: Migration 0006 on Railway.**
  1. From `app/`: `DATABASE_URL='…?sslmode=require' npm run db:migrate`.
  2. Check:
     - `select count(*) from drizzle.__drizzle_migrations` → 7;
     - `select count(*) from payments` → 0;
     - `select count(*) from registrations where pay_token is null` → 0, and `select count(distinct pay_token) = count(*) from registrations` → `t` (N rows);
     - `select count(*) from registrations where seat_hold_until is not null` → 0.
  3. Open https://mslab.ee once (as an admin with the preview cookie): the live (2c) site still answers.
- [ ] **Step 5: The sandbox keys (Dim).** Dim takes the sandbox access key and secret key from Montonio's Partner System (sandbox) → Stores → API Keys of Maria's store and enters them in Production himself, as plain variables: `vercel env add MONTONIO_ENV production --no-sensitive --force` (value `sandbox`), then `MONTONIO_ACCESS_KEY` and `MONTONIO_SECRET_KEY` the same way. The controller never sees, prints or stores a value; it checks only that `env ls production` lists the three names.
- [ ] **Step 6: Deploy.** Merge `feat/phase2b-payments` into `main` and push `main` to `origin` (`mslabinformation-collab/mslab`): that push is the production deployment, and it reads the new variables. Do not push the feature branch itself.
- [ ] **Step 7: READY.** `vercel --global-config ~/.vercel-mslabinformation ls mslab` (and `inspect <url>`): the deployment is READY and holds the alias `mslab.ee`.
- [ ] **Step 8: Read-only acceptance on https://mslab.ee.**
  - `node tools/cache-smoke.mjs https://mslab.ee` passes parts A, B and C.
  - The remote read-only e2e with 1–2 workers: `E2E_BASE_URL=https://mslab.ee E2E_ALLOW_REMOTE=1 npx playwright test --workers=2` (the specs that submit or need the local database skip themselves; a difference that comes only from Maria's live content goes to the ledger).
  - `curl -s -X POST https://mslab.ee/api/payments/notify -H 'content-type: application/json' -d '{"orderToken":"x"}'` → `{"ok":false}` with 400 (the webhook passes the gate and has the keys).
  - `curl -s -o /dev/null -w '%{http_code}' https://mslab.ee/maksa/x` → 200 (the page; an unknown token: "Selle registreeringu eest pole praegu midagi tasuda."), and `curl -sI https://mslab.ee/maksa/x | grep -i referrer-policy` → `same-origin`.
  - `curl -s https://mslab.ee/api/payments/return?order-token=x` → `{"ok":false,"error":"not_found"}` (gated for a visitor's script).
- [ ] **Step 9: Live checks behind the gate**, as an admin with the preview cookie, every payer a sample address `*.naidis@example.test` (never mailed). After each payment read Railway (read-only) for the row: `select id, kind, status, amount_cents, method, bank from payments where email = '<the sample address>'`.
  1. **A group registration paid by a sandbox bank link.** On a course page, register (50 %) on a session with seats; Montonio's sandbox page lists the banks; pick one and pay. You land on `/makse` "Makse õnnestus. …". Railway: the payment `paid` with its method and bank, the registration `confirmed` with 50 % paid. Maria's notice "Uus makse: …" arrives at `MARIA_EMAIL` (Dim's, until the launch) and in Telegram. In Vercel's logs the `POST /api/payments/notify` of that payment answered 200 (the webhook reached the app, not only the return).
  2. **The same with the test card** `4111 1111 1111 1111`, 03/30, CVC 737, if cards are on in the sandbox store (else note it in the ledger).
  3. **The 50 % rest.** Sign the sample client in (as phase 2a Task 11 step 7: a token row in Railway, then `/api/konto/verify?t=…`): her card says "Koht on kinnitatud. Ülejäänud … tasud koolituspäeval." with "Maksa ülejäänud …"; pay it in the sandbox; the card then says "Koht on kinnitatud.".
  4. **An e-course purchase** from `/ostukorv?kursus=kulmumeistri-e-koolitus` with another sample address: paid → `/makse` "Ava e-koolitus"; Railway: a client of that address and `course_access` with `granted_by = 'payment'`.
  5. **A cancelled payment and "Proovi uuesti".** Register again, cancel on Montonio's page: `/makse` says "Makse jäi tegemata." (or "Makse on pooleli. …": Montonio may answer a cancel with PENDING) with "Proovi uuesti"; it opens `/maksa/<token>`; pay there.
  6. **`/maksa` as the mail's link would open it:** read a sample registration's `pay_token` from Railway (read-only), open `https://mslab.ee/maksa/<token>` in a private window (no preview cookie: the page goes through the gate): the course, the amount, "Maksa …" and the transfer.
  7. **The admin's "Maksed"**: every payment above, newest first, the filter, the student links, Montonio's ids; a registration's drawer lists its payments under "Laekunud"; the Õpilased drawer of the e-course buyer lists hers and says "Avas veebimakse".
  8. **The daily check** runs at 03:00 UTC: the next day, the cron's log line has the payments' counts (`[cron] sweep: payments …`).
- [ ] **Step 10: Clean-up, by SQL and the admin.**
  - In the admin: cancel or delete nothing by hand that the SQL below removes.
  - SQL (Railway), for the sample addresses only (`email like '%naidis@example.test'`): delete their `payments`, their `registrations`, their `client_login_tokens`, their `clients` (cascading sessions and `course_access`), and any `subscribers` row.
  - Nothing to clean in Montonio's sandbox (its orders stay there; they are test orders).
  - Check: `select count(*) from payments` → 0, `select count(*) from registrations where seat_hold_until > now()` → 0.
- [ ] **Step 11: Durations.** From the runtime logs, note the max and median of `POST /api/payments/notify`, `GET /api/payments/return`, `POST /maksa/<token>` and the registration's server action (it now creates an order).
- [ ] **Step 12: What stays for the public launch** is `docs/launch-checklist.md` §10 (Maria's approved store, the live keys and `MONTONIO_ENV=live`, her methods, the €1 test with a refund, the privacy line, the Russian texts). Migration 0008 (the drop of `courses.modules`; the protocols phase took 0007) stays as planned in phase 3a: code first, then the migration; the migrations count afterwards is 9.

---

## Self-review

### Spec coverage

| Spec section | Task |
|---|---|
| 1 Goal (registration prepayment, paying later, the rest, e-course, Maria) | 4, 5, 7, 3 + 9 |
| 2 D1 pay at once after "Registreeru"; "Maksa" in the mail and Minu koolitused | 4 (the start, the redirect, the mail's button), 5 (`/maksa`, the cards) |
| 2 D2 a 30-minute hold; a late payment on a full course recorded, Maria alerted | 1 (the seat rule), 4 (the hold), 3 (`addRegistrationPayment`'s full case, "Makse laekus, aga koolitus on täis"), 8 (revalidation) |
| 2 D3 name, e-mail, the terms box, the newsletter box | 7 |
| 2 D4 the bank or card chosen on Montonio's page | 2 (`paymentInitiation`, no `preferredProvider`; the fake refuses one), 7 |
| 2 D5 the rest online until the training day | 4 (`amountDue` balance), 5 ("Maksa ülejäänud") |
| 2 D6 the bank transfer as the second way | 4 (the mail), 5 (the page, the card's "Vaata juhiseid") |
| 2 D7 mail + Telegram, "Maksed", the row, the drawer | 3 (`paymentSummary` via `notifyMaria`), 9 |
| 3 building blocks reused | 1 (seat counters), 3 (`recordRegistrationPayment`'s rule in `addRegistrationPayment`), 7 (`addClient`, `grantAccess`) |
| 4 Montonio facts (URLs, JWT, order, webhook, return, GET, sandbox) | 2 (+ docs-payload tests), 11 (runbook); the reference: a new one per new attempt, and an open attempt re-sent under its own (4, 7: the pre-flight's double-payment fix, using spec 4's "reusing it on an unpaid order overwrites that order"; 3: a token of the replaced order) |
| 5 (0006; the 0006→0007 rename) | 1 |
| 5.1 `payments` | 1 (table), 3 (`insertPayment`: the reference in the same transaction) |
| 5.2 `seat_hold_until`, `pay_token` | 1 |
| 5.3 one seat expression for the four counters; the stale "Täis" | 1, 8 |
| 6.1 group registration | 4 |
| 6.2 one door (6.2.1–6.2.6) | 3 (registrations, mails, Maria, caps), 7 (6.2.3 e-course, its mail) |
| 6.3 `/maksa`, `POST /api/konto/maksa`, the buttons | 5 |
| 6.4 e-course purchase | 7 |
| 6.5 return and `/makse` | 6 |
| 6.6 daily check | 8 |
| 7.1 the files | 2 (`jwt.ts`, `montonio.ts`), 3 (`settle.ts`) |
| 7.2 configuration, `paymentsConfigured`, 404 without keys, never logged | 2, 3 (notify 404), 6 (return 404), 7 (the cart), 5 (the cards) |
| 7.3 status map; paid is a floor; VOIDED; refunded | 2 (the map), 3 (the rules) |
| 7.4 token checks, GET on doubt, 503, the amount check, 400/200/503 | 3 |
| 8 admin | 9 |
| 9 texts and mails | 3 (dictionary, payer and Maria texts), 4 (the mail's button), 7 (the e-course mail), 9 (admin) |
| 10 gate, same-origin, Referrer-Policy, rate limits, CSP, redirects, privacy | 3 (notify through the gate, 8 KB, POST only, no redirect), 5 (`/maksa` through the gate, same-origin, the pin, 5/IP and 5/registration), 6 (return and `/makse` gated, the return's no-referrer), 11 (the privacy line on the launch list) |
| 11 not in this phase | respected: no instalments, no invoice PDFs, no refund API, no payment of individual courses, no reminders or automatic cancellation, no bank logos |
| 12 testing (unit, docs payloads, DB, routes, E2E with the mock, the gate) | 1–9 (each task's tests), 10 (E2E flows), 3/5/6 (gate cases) |
| 13 go-live | 12 (+ 11's checklist section 10) |
| 14 open items | the split (4 and 7 apart), the seat helper's place (1: `db/queries/seats.ts` + `domain/sessions.ts holdsSeat`), the port (2: logic, not layout; English comments) |

### Placeholder scan

Searched the plan for "TBD", "TODO", "implement later", "similar to", "as today" and "…" inside code blocks. Every code step holds the complete code it adds or replaces; where a step edits an existing file it names the exact line or block and gives its replacement. The remaining "…" are in prose that points at existing code (`<aside …>`, `.foot { … }`) or in user-facing texts ("Avan makse…").

### Type and name consistency

Checked across tasks: `takesSeat` / `seatsTaken` / `hasFreeSeat` / `holdsSeat` / `holdUntil` / `SEAT_HOLD_MS` (1); `SessionWithSeats.taken`, `AdminSessionRow.taken` (1); `paymentsEnv`, `montonioConfig`, `paymentsConfigured`, `paymentProvider`, `montonioClient`, `Montonio`, `OrderToken`, `OrderSnapshot`, `MontonioError`, `JwtError` (2); `orderReference`, `insertPayment`, `paymentByReference`, `attachOrder`, `releaseHold`, `failPayment`, `paymentContext`, `addRegistrationPayment(tx: Tx, …)`, `settleToken`, `settlePayment`, `factsOf`, `SettleDeps`, `handleNotify`, `PaymentRouteDeps` (3, used by 4–8); `amountDue`, `startRegistrationPayment`, `StartResult` (`started | off | failed | nothing | full | rate | notFound`), `STARTS_PER_HOUR`, `payLinkUrl`, `navigate` (4, used by 5 and 7); `liveAttempt` and `order(…, again)` (4, private to `start.ts`, used by 7's `startEcoursePayment`: the re-send of an open attempt); `PAY_STARTS_PER_IP`, `crossSiteFormPost`, `handlePayPage`, `Dashboard.payOnline`, `CoursesTexts.online` (named `online` because the dashboard's own `payment` holds PrepaymentInfo's labels) (5); `resultFragment` / `parseResultFragment` / `returnTarget` / `handleReturn` (6); `handleEcoursePurchase`, `buyEcourse`, `startEcoursePayment`, `grantPurchase`, `ecourseOpenMail`, the exported `subscribeLater` (7); `checkPendingPayments`, `NO_PAYMENT_SWEEP` (8); `needsCheck`, `pagePayments`, `listPaymentsOf`, `PaymentRow`, `PAYMENT_TONE` (9). The settlement's `Won` gains `grant` in Task 7, which replaces the two lines of Task 3 that build it. The e2e helpers `storedPayments` / `storedHold` (4) and `storedPayToken` (5) are defined before the specs that use them.
