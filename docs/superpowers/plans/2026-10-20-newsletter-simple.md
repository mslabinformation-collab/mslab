# Newsletter campaigns, simplified — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Resend Broadcast machinery (deployed but switched off, main 56f38dc) with Rempire's simple approach. A campaign goes out as one ordinary mail per subscriber, under a daily counter that keeps 30 of Resend's 100 a day free. What does not fit goes out the next day, Maria sees one progress line and can stop the campaign, and nothing is set up in Resend.

**Architecture:**
- **Migration 0016:**
  - adds `newsletter_deliveries`: one row per recipient, written at the press;
  - drops the never-used Resend columns and table;
  - clears the two Resend settings rows.
- **Day counter:** `sendMail` counts every accepted mail on a UTC day counter (`mail_quota` row `<day>:all`).
- **Engine:** `src/server/newsletter-campaigns.ts` claims waiting rows (`FOR UPDATE SKIP LOCKED`) and sends each through `sendMail`, with the List-Unsubscribe headers. It runs at the press and in a daily cron of its own.
- **Removed:** `resend-marketing.ts`, the webhook, the sync hooks and UI, and the marketing key.

**Tech Stack:** Next.js 16.3.8 (pinned), Drizzle 0.45 + postgres.js, resend 6.31 (`emails.send` only), vitest + PGlite + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-newsletter-simple-design.md`, approved by Dim 20.10.2026. It replaces the sending half of `2026-10-18-newsletter-campaigns-design.md`, whose D4, D5, D7 and D9 still stand.

## Global Constraints

- **Environment.**
  - mslab.ee is staging. Migrate first, then push.
  - Agents never write on mslab.ee or Railway, and never call the real Resend API: tests fake it as `tests/unit/notify.test.ts` does.
  - Local `mslab-pg` is at 16 migrations, and at 17 after Task 1.
  - Never read `app/.env.local`.
- **Limits.** These are pinned in one place (`src/domain/newsletter-campaign.ts`):
  - `CAMPAIGN_DAILY_ROOM = 70`: a campaign sends only while the day's counter is below it.
  - The day is the UTC date, like every `mail_quota` row and like Resend's own day.
  - The existing per-kind caps stay unchanged.
- **At most once.** Every outcome maps to exactly one status, as in spec §3:
  - claimed → `sent`;
  - refused for the address → `failed`;
  - unknown (timeout, 5xx, crash) → `unknown`, never retried;
  - Resend's daily or monthly limit → back to `waiting`, batch stops;
  - any other refusal → back to `waiting`, batch stops, Maria told.

  A row is claimed under `FOR UPDATE SKIP LOCKED` before its send, so two runners never send one row.
- **Consent.** The recipients are the confirmed `subscribers` rows at the moment of the press. A row whose subscriber is gone before its turn is `skipped`. Each mail carries the subscriber's own token link and the `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.
- **One campaign at a time.** A second „Saada kõigile" while one is `sending` is refused with the spec's text.
- **Copy.**
  - Verbatim from the spec, old and new:
    - „Saada proov"
    - „Saada kõigile"
    - „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?"
    - „Saadetud {date} · {n} tellijale"
    - „Kopeeri"
    - „Vene keeles tellijad saavad eestikeelse kirja."
    - „Said selle kirja, sest liitusid MS LAB-i uudiskirjaga."
    - „Loobu uudiskirjast"
    - „Proovikiri — …"
  - New texts are Draft:
    - „Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval."
    - „Peata saatmine"
    - „Saatmine peatus: Resend keeldus. Kirjuta Dimile."
    - „Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud."
- **Logs** carry ids and counts only.
- **Test plan (standing rule).**
  - Update `app/src/data/testplan.json` in every task that changes behaviour: new checks are `"new"`, changed ones `"redo"`, wording-only changes `"reworded"`, each with `"markedAt": "deploy"`.
  - Ids never change and marks are never downgraded. The file stays walkable in order, and `tests/unit/testplan-file.test.ts` stays green.
  - The checks for removed features (sync, counts, blocked marks, „Märgi saatmata", „Saada puuduv keel") keep their ids and are rewritten to the simple flow, or reshaped into a check of what replaced them.
- **`next.config.ts` must keep loading.** Run `npm run build` in every task that touches a module it imports.

## Review Focus

1. **A runner dies after Resend accepted but before `sent` was written.** The row stays `claimed` and is never resent; the next run marks a stale claim (older than the runner's time limit) `unknown`. Task 3 DB test.
2. **The press and the daily cron run at once, or two tabs press.** Each row is sent once and the counts add up. Task 3 test, plus the Task 5 real-Postgres race.
3. **The site's own mails fill the day before the campaign starts.** The campaign sends nothing, the progress line says the rest goes on the next day, and the site's mails are never stopped by the campaign's counter. Task 3 test.
4. **A mail program's one-click unsubscribe.** A POST with body `List-Unsubscribe=One-Click` and the token in the query deletes the row and answers 200, and the next batch skips her. Tasks 1 and 3 tests.
5. **„Peata saatmine" during a running batch.** It never resends, the running batch finishes its claimed rows, and nothing waiting is sent afterwards. Task 3 test.

---

### Task 1: Data, the day counter, the headers, the one-click route

**Files:**
- Create: `app/drizzle/0016_newsletter_simple.sql` (generated, then checked by hand).
- Modify:
  - `app/src/db/schema.ts`
  - `app/src/domain/newsletter-campaign.ts` (`CAMPAIGN_DAILY_ROOM`)
  - `app/src/server/notify.ts`: add `Mail.headers?: Record<string, string>`, passed to Resend; every accepted send adds to the day counter, best effort.
  - `app/src/server/client-auth.ts`: `countSentMail(q, now)` and `mailsSentToday(q, now)` on the row `<day>:all`.
  - `app/src/app/api/newsletter/loobu/route.ts`: one-click.
- Test:
  - `app/tests/db/migration-0016.test.ts`
  - `app/tests/unit/notify.test.ts` (extend)
  - `app/tests/db/mail-day-count.test.ts`
  - `app/tests/db/newsletter-unsubscribe.test.ts` (extend, or the route's existing test)

**Interfaces (produces):**

```ts
// schema.ts
export const newsletterDeliveries = pgTable("newsletter_deliveries", { id, campaignId: integer().notNull().references(() => newsletterCampaigns.id, { onDelete: "cascade" }),
  email: text().notNull(), locale: text().$type<"et" | "ru">().notNull(), token: text().notNull(),
  status: text().$type<DeliveryStatus>().notNull().default("waiting"), claimedAt: timestamp tz, sentAt: timestamp tz, createdAt });
// unique (campaign_id, email); index (campaign_id, status)
// subscribers: − resend_contact_id, − synced_at; mail_suppressions dropped; settings rows resend_segments, newsletter_sync_lease deleted in the migration
// newsletter_campaigns.status: "draft" | "sending" | "sent"; recipients { et, ru } kept; broadcasts column dropped (never used live)
export type DeliveryStatus = "waiting" | "claimed" | "sent" | "failed" | "unknown" | "skipped";
// client-auth.ts
export async function countSentMail(q: Q, now: Date): Promise<void>;     // +1 on "<UTC day>:all"; never throws
export async function mailsSentToday(q: Q, now: Date): Promise<number>;
// notify.ts: sendMail(env, mail) counts an accepted mail when it is given a db (add an optional `count?: Q` to its options, or a wrapper; the builder picks one and every caller that has a db passes it)
```

- [ ] **Step 1: Failing tests.**
  - Migration: 16 → 17, the new table, the drops, the deleted settings rows, and existing rows untouched.
  - The counter on the UTC day.
  - `sendMail` passes `headers` and counts only accepted mails.
  - The loobu route: a POST with body `List-Unsubscribe=One-Click` and `?t=<token>` deletes the row and answers 200; the existing form POST still answers 303.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, the existing newsletter, notify and quota tests, tsc, and `npm run build`.
- [ ] **Step 5: Commit** `feat(db): migration 0016 — newsletter deliveries, the Resend list columns dropped; the day's mail counter; one-click unsubscribe`.

### Task 2: Remove the Resend list machinery

**Files:**
- Delete:
  - `app/src/server/resend-marketing.ts`
  - `app/src/app/api/resend/webhook/route.ts`
  - `app/src/components/admin/NewsletterSync.tsx`
  - `tests/db/resend-marketing.test.ts`
  - `tests/db/resend-webhook.test.ts`
  - `tests/db/resend-fake.ts`, if nothing else uses it
- Modify every importer listed by `grep -rl resend-marketing app/src app/tests`:
  - the sync hooks in `submit.ts`, `newsletter.ts`, `client-data.ts`, `actions/public.ts`, `account-api.ts`, `payments/settle.ts`, and the `konto` / `payments` / `newsletter` routes;
  - the cron's sync in `api/cron/sweep/route.ts`;
  - the gate passthrough for `api/resend/webhook` in `lib/site-gate.ts`;
  - `RESEND_MARKETING_KEY` and `RESEND_WEBHOOK_SECRET` in `env.ts`, `send-deps.ts` and `tests/local-secrets.ts`;
  - the „Uudiskiri" page's sync part, contact counts and blocked marks (`uudiskiri/page.tsx`, `newsletter-admin.ts`);
  - the drawer's blocked mark (`admin-clients.ts`, `ClientDrawer.tsx`);
  - `fullSyncAction`;
  - the Broadcast send path in `newsletter-campaigns.ts`:
    - `prepareSend` / `sendCampaign` / `markNotSent` / `missingLocales`;
    - the test segment.

    Keep `saveCampaign`, `copyCampaign`, `campaignPreview`, `draftOf`, `getCampaign` and `listCampaigns`. Leave the editor's send buttons calling stubs that answer "not available yet" until Task 3, or hide them; the builder picks.
  - The e2e and race specs for the removed parts. Keep the race spec's file; Task 5 rewrites it.
  - `testplan.json`: rewrite the removed features' checks, per the global rule.

**Rules:**
- Behaviour after this task: the „Uudiskiri" page is the list and the CSV again, and „Kampaaniad" can write, preview and copy.
- Nothing in the code refers to segments, contacts, broadcasts, suppressions, the lease or the webhook any more. Prove it with a grep in the report.

- [ ] **Step 1: Remove the code and update the tests.** The full suite must be green after the removal.
- [ ] **Step 2: Run** the full vitest, tsc, eslint, `npm run build`, and the e2e `admin-inbox newsletter-campaigns`.
- [ ] **Step 3: Commit** `refactor(newsletter): remove the Resend lists, the sync, the webhook and the suppressions`.

### Task 3: The sending engine and the daily job

**Files:**
- Modify: `app/src/server/newsletter-campaigns.ts`, `app/src/server/actions/admin-newsletter.ts`.
- Create: `app/src/app/api/cron/uudiskiri/route.ts` (`CRON_SECRET` bearer like the sweep; `maxDuration = 300`).
- Modify: `app/vercel.json`, adding `{ "path": "/api/cron/uudiskiri", "schedule": "0 4 * * *" }`, an hour after the sweep.
  - If Vercel Hobby refuses a second cron job, run the batch at the end of the existing sweep instead, inside a time budget that leaves the sweep its own work. The route stays, for the press and for tests. Say which you did.
- Test:
  - `app/tests/db/newsletter-send.test.ts`
  - `app/tests/db/newsletter-cron-route.test.ts`

**Interfaces:**
- **Consumes:** Task 1 (`newsletterDeliveries`, `countSentMail`, `mailsSentToday`, `CAMPAIGN_DAILY_ROOM`, `Mail.headers`).
- **Produces:**

```ts
export type SendDeps = { db: Db; env: Env; siteUrl: string; now: () => Date; deadline: number /* ms epoch */; gapMs?: number; send?: typeof sendMail /* fake seam */ };
export type Progress = { total: number; sent: number; waiting: number; failed: number; unknown: number; skipped: number };
export async function prepareSend(db: Db, id: number): Promise<{ ok: true; et: number; ru: number; ruFallsBack: boolean; updatedAt: string } | { ok: false; error: "notFound" | "sent" | "busy" | "empty" }>;
//   busy = another campaign is `sending` (spec: one at a time)
export async function startSend(deps: SendDeps, id: number, confirmed: { et: number; ru: number; updatedAt: string }): Promise<{ ok: true; progress: Progress; stopped: null | "room" | "refused" | "time" } | { ok: false; error: "notFound" | "sent" | "busy" | "changed" | "empty" }>;
//   one tx: the campaign row FOR UPDATE, status draft, nothing else sending, counts and updatedAt as confirmed → rows written, status "sending"; then runBatch
export async function runBatch(deps: SendDeps, id: number): Promise<{ progress: Progress; stopped: null | "room" | "refused" | "time" }>;
//   first: claimed rows older than STALE_CLAIM_MS → "unknown"; then while room (CAMPAIGN_DAILY_ROOM − mailsSentToday) and time: claim one waiting row (FOR UPDATE SKIP LOCKED),
//   skip it if her subscriber row is gone, render campaignMail for her locale with her token link and the headers, send, map the outcome; when no row is waiting, status "sent", sent_at, recipients
export async function stopSend(db: Db, id: number, now: Date): Promise<{ ok: true; progress: Progress } | { ok: false; error: "notFound" | "notSending" }>;  // waiting → skipped; status sent
export async function sendTest(deps: SendDeps, id: number, to: string, locale: "et" | "ru"): Promise<{ ok: true } | { ok: false; error: "notFound" | "mail" | "limited" }>;
export async function progressOf(q: Q, id: number): Promise<Progress>;
export async function runDueCampaigns(deps: SendDeps): Promise<{ campaignId: number | null; progress: Progress | null }>;  // the cron: the one sending campaign, if any
```

**Rules:**
- **The outcome map.** `sendMail` must now say which outcome it was. Give it, or a sibling used here, a result such as `{ ok: true } | { ok: false; kind: "address" | "quota" | "refused" | "unknown" }`, from Resend's error names and status:
  - `validation_error` that names the address → `address`;
  - `daily_quota_exceeded` / `monthly_quota_exceeded` → `quota`;
  - other 4xx → `refused`;
  - timeout / 5xx / network → `unknown`.

  Existing callers keep the boolean meaning.
- **Stale claims.** `STALE_CLAIM_MS` is the cron's `maxDuration` plus a margin, 6 minutes.
- **The press's time limit.** About 60 s within the page's existing `maxDuration` of 120. The cron's limit is its `maxDuration` minus a margin.
- **Pacing.** A 600 ms gap between sends, injectable as 0 in tests.
- **„Saada proov".** One `sendMail` to `MARIA_EMAIL` or the signed-in admin, at most 10 an hour (`ratelimit.ts`). It carries the „[Proov]" subject and the proov unsubscribe link, and it is counted.

- [ ] **Step 1: Failing tests.**
  - Each outcome → its status.
  - Review Focus 1, 2, 3 and 5.
  - A gone subscriber → `skipped`.
  - RU fallback to ET with the RU footer.
  - One campaign at a time.
  - `changed` when the counts or `updatedAt` moved.
  - The cron route: 401 without the bearer, runs the one sending campaign, nothing when none.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, the full suite, tsc and `npm run build`.
- [ ] **Step 5: Commit** `feat(newsletter): one mail per subscriber under the day's room; the rest goes on the next day; Peata saatmine`.

### Task 4: „Kampaaniad" — progress and stop

**Files:**
- Modify:
  - `app/src/components/admin/NewsletterCampaignEditor.tsx`, `CampaignsPanel.tsx` (+ css)
  - `app/src/app/admin/(panel)/uudiskiri/page.tsx`
  - `app/src/i18n/dict/admin.ts`
  - `app/src/data/testplan.json`
- Test: `app/tests/unit/campaign-editor-dom.test.ts` (rewrite the send states), `app/tests/db/admin-newsletter-actions.test.ts`.

**Rules:**
- **The editor's states:**
  - **draft:** „Saada proov" and „Saada kõigile" → the confirmation → the result line;
  - **sending:** „Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval." with „Peata saatmine", which asks for confirmation first, plus the failed and unknown counts when they are non-zero;
  - **sent:** „Saadetud {date} · {n} tellijale" and „Kopeeri".
- **When another campaign is `sending`,** „Saada kõigile" shows the one-at-a-time text.
- **Refused stop.** When the batch stopped because Resend refused, the line „Saatmine peatus: Resend keeldus. Kirjuta Dimile." shows.
- **Old UI is gone.** No interrupted, „Märgi saatmata" or „Saada puuduv keel" UI remains.
- **The list** shows each campaign's state and, for one going out, its progress.
- **The test plan:** the send check becomes "the first batch and the progress line" (`redo`). New checks are „Peata saatmine" and "continues the next day". The latter is Dim's, done with the room temporarily lowered; the builder says how, for example by a setting read only when present.

- [ ] **Step 1: Failing DOM and action tests** for each state.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, tsc, eslint, `npm run build`, and the e2e `admin-inbox newsletter-campaigns`.
- [ ] **Step 5: Commit** `feat(admin): „Kampaaniad" — the progress line and „Peata saatmine"`.

### Task 5: End to end, the race, docs

**Files:**
- Modify:
  - `app/tests/e2e/newsletter-campaigns.spec.ts`
  - `app/tests/e2e/newsletter-race.spec.ts`, rewritten
  - `docs/deploy.md` §19, rewritten
  - `docs/launch-checklist.md` §18, rewritten
  - the 18.10 spec: a note at its top that its sending half is replaced by the 20.10 design
  - `app/src/data/testplan.json`: only the fixes the e2e shows

**Rules:**
- **The e2e** runs locally with Resend unset, so `sendMail` is not configured and the fake seam is used through a test hook. Follow how the existing e2e fakes mail. It covers:
  - writing a campaign;
  - the preview;
  - pressing „Saada kõigile" with 3 test subscribers and the room set to 2, then the progress line „2 / 3";
  - running the cron route with the bearer, then „Saadetud";
  - „Peata saatmine" on another campaign;
  - widths 390, 834, 1194 and 1440.
- **The race** (real Postgres scratch database, as now): the press and the cron batch at once, each row sent once, the counts exact; and a mutation check of `SKIP LOCKED`.
- **`deploy.md` §19:**
  - how it works;
  - the counter and the room of 70;
  - the cron (`/api/cron/uudiskiri`, 04:00 UTC);
  - the outcome map;
  - „Peata saatmine";
  - the logs;
  - the migration note: Railway goes from 16 to 17, and the drops are of empty, never-used parts;
  - rollback: the code before this deploy expects the dropped columns. Rolling back needs the old code with the columns re-added, so say so plainly.
  - Dim's first check: one „Saada proov", then a check of the subscriber list, before any real send.
- **Launch list §18:** Maria's privacy text names Resend as the mail service, and test subscribers are removed by exact address.

- [ ] **Step 1: Write the e2e and the race, and run them** under `next dev` and `E2E_PROD_BUILD=1`.
- [ ] **Step 2: Write the docs.**
- [ ] **Step 3: Run** the full vitest, tsc, eslint and the build.
- [ ] **Step 4: Commit** `test(e2e): the simple newsletter; docs: the runbook's Uudiskirjad rewritten`.

### Task 6: Railway 0016, merge, push, smoke (controller)

- [ ] **Step 1: Branch checks.**
  - The full vitest, tsc, eslint and build.
  - The e2e `newsletter-campaigns newsletter-race admin-inbox course home`, under dev and `E2E_PROD_BUILD=1`.
  - The gate config.
- [ ] **Step 2: Railway, read-only.**
  - Expect 16 migrations.
  - Expect `mail_suppressions` to have 0 rows and no subscriber to have a `resend_contact_id`. Stop if either is not true.
- [ ] **Step 3: Migrate.**
  - Expect 17 migrations, `newsletter_deliveries` present, the dropped parts gone, and the subscribers unchanged.
  - Delete `rw.env`.
- [ ] **Step 4: Stamp, merge and push.**
  - Stamp, then re-run the testplan tests.
  - Merge and push.
  - If the build fails on a transient fetch, redeploy once.
- [ ] **Step 5: Smoke.**
  - `/` → 200.
  - `/api/resend/webhook` → 404.
  - `/api/cron/uudiskiri` without the bearer → 401.
  - `/admin/uudiskiri?vaade=kampaaniad` → login.
- [ ] **Step 6: Tell Dim** his first check and update the memory.
