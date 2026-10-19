# Newsletter campaigns („Uudiskirjad") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maria writes a newsletter campaign in the admin (ET and RU, a picture, paragraphs, a code and a button), previews it, sends herself a test and then sends it to every subscriber. It goes out as a Resend Broadcast in each subscriber's language, with the site's own unsubscribe link. The site stays the record of consent and keeps Resend's contacts in sync. Addresses Resend blocks are shown to Maria.

**Architecture:**
- **Migration 0015 (additive):**
  - a `newsletter_campaigns` table;
  - `subscribers.resend_contact_id` and `subscribers.synced_at`;
  - a `mail_suppressions` table.
- **Pure rules and the mail's HTML:** `src/domain/newsletter-campaign.ts` and `src/server/campaign-mail.ts`. The mail reuses the account mails' card, which is exported from `account-mail.ts`.
- **The Resend side:** `src/server/resend-marketing.ts` holds the contacts, segments, the full sync, the suppressions and the broadcasts, through the `resend` SDK (6.31, already installed: `contacts`, `segments`, `broadcasts`, `suppressions`, `webhooks.verify`).
- **Webhook:** `/api/resend/webhook`. Contact unsubscribes and suppressions come back through it.
- **Admin:** the „Uudiskiri" page gains the sync, the counts and the marks, plus a „Kampaaniad" tab with the editor, the test and the send.

**Tech Stack:** Next.js 16.3.8 (pinned), Drizzle 0.45 + postgres.js, resend 6.31.0, vitest + PGlite + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-newsletter-campaigns-design.md` (approved by Dim 19.10.2026). D1–D10 and §3–§6 are binding.

## Global Constraints

- **Environment.**
  - mslab.ee is staging: migrate first, then push.
  - Agents never write on mslab.ee or Railway, and never call the real Resend API.
  - Tests fake the SDK, the way `tests/unit/notify.test.ts` fakes `emails.send`.
  - Use local `next dev` against the local Docker `mslab-pg` only (15 migrations; 16 after Task 1).
  - Never read `app/.env.local`.
- **Keys.**
  - The marketing calls use `RESEND_MARKETING_KEY`, falling back to `RESEND_API_KEY`. (Amended 19.10 in the final wave, ruling R15: no fallback; `RESEND_MARKETING_KEY` alone is the switch.)
  - The webhook uses `RESEND_WEBHOOK_SECRET`.
  - Without a marketing key, sync and send are "not set up": nothing fails and nothing is sent. The visitor's sign-up still works.
- **Naming.** The existing `campaign` table, `domain/campaign.ts` and `/admin/kampaania` are the home-page popup („Hüpikaken").
  - The new pieces are named `newsletter_campaigns`, `newsletterCampaigns` and `domain/newsletter-campaign.ts`, so the two never meet.
  - The admin tab is „Kampaaniad" on the „Uudiskiri" page (`/admin/uudiskiri?vaade=kampaaniad`).
- **Consent.**
  - Only confirmed `subscribers` rows are synced and sent to.
  - A sync failure never fails a visitor's action.
  - An unsubscribe by any route (the site's link, „Minu andmed", account deletion, Resend's one-click or webhook, or the full sync's read of unsubscribed contacts) deletes the row before the next send.
- **No campaign through `/emails`.** Only „Saada proov" sends one transactional mail. Tracking stays off.
- **Frozen once sent.** A campaign whose status is `sent` is never changed. „Kopeeri" makes a new draft.
- **Resend calls.**
  - At most 2 a second: a 600 ms gap between calls in loops, as `protocols.ts MAIL_GAP_MS` does.
  - Every call has a timeout, and a 429 is retried once, as `notify.ts sendMail` does.
  - The full sync stops at a time budget and reports what it did not finish.
- **Copy.**
  - Every new text is marked Draft unless the spec quotes it.
  - Verbatim from the spec:
    - „Sünkrooni Resendiga"
    - „Kampaaniad"
    - „Saada proov"
    - „Saada kõigile"
    - „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?"
    - „Saadetud {date} · {n} tellijale"
    - „Kopeeri"
    - „Vene keeles tellijad saavad eestikeelse kirja."
    - „Said selle kirja, sest liitusid MS LAB-i uudiskirjaga."
    - „Loobu uudiskirjast"
    - „Resendi tasuta paketis on 1000 kontakti. Üle selle on vaja tasulist paketti."
    - „Resendiga ei saanud ühendust — proovi hiljem uuesti."
    - „{n} tellijat ei ole Resendis — kontaktide piir on täis."
    - „Resend ei saada sellele aadressile kirju (tagastus või rämpspostiks märgitud). Seda saab muuta ainult Resendis."
- **Logs** carry ids and counts only: no addresses, no texts.
- **Test plan (standing rule).**
  - Behaviour changes update `app/src/data/testplan.json`: a new check gets `"new"`, a behaviour change `"redo"`, a wording-only change `"reworded"`, each with `"markedAt": "deploy"`.
  - Ids never change, and a mark is never downgraded.
  - The file stays walkable in order.
  - `tests/unit/testplan-file.test.ts` stays green. Its guards accept `"deploy"` or a stamped time.

## Review Focus

1. **She unsubscribed through Resend just before Maria presses „Saada kõigile".** The send's full sync reads the unsubscribed contacts and deletes her row first, so the counts never include her. Task 2 DB test with a faked SDK.
2. **A contact has no `unsubscribe_url` property.** It was synced before the property existed, or its property write failed. The full sync sets the property for every synced contact before a send, and the send refuses while any synced contact still lacks it. Task 2 test.
3. **Two presses of „Saada kõigile", or two tabs.** One broadcast per segment. The second press answers "already sent". Task 4 DB test with the row lock.
4. **Over 1,000 contacts.** The sync stops adding, counts the rest, and the send reports them. Nothing is dropped silently. Task 2 test with a faked limit error.
5. **A Russian subscriber when the Russian text is empty.** She gets the Estonian mail with her own (Russian) unsubscribe page, and Maria is told before sending. Task 1 rule test and Task 4 DB test.

---

### Task 1: Data, rules and the mail — migration 0015, `domain/newsletter-campaign.ts`, `server/campaign-mail.ts`

**Files:**
- Create:
  - `app/drizzle/0015_newsletter_campaigns.sql` (generated)
  - `app/src/domain/newsletter-campaign.ts`
  - `app/src/server/campaign-mail.ts`
- Modify:
  - `app/src/db/schema.ts`
  - `app/src/server/account-mail.ts`: export the card and its row helpers (`mailCard`, `paragraphRow`, `codeRow`, `buttonRow`, `linkRow`, `signatureRow`), with no change to their output.
- Test:
  - `app/tests/db/migration-0015.test.ts`
  - `app/tests/unit/newsletter-campaign-rules.test.ts`
  - `app/tests/unit/campaign-mail.test.ts`

**Interfaces (produces):**

```ts
// schema.ts
export const newsletterCampaigns = pgTable("newsletter_campaigns", { id, name: text().notNull(), subject: jsonb().$type<I18n>().notNull(),
  preheader: jsonb().$type<I18n>().notNull(), imageKey: text(), body: jsonb().$type<I18n>().notNull(), code: text(),
  buttonLabel: jsonb().$type<I18n>(), buttonHref: text(), status: text().$type<"draft" | "sent">().notNull().default("draft"),
  sentAt: timestamp tz, recipients: jsonb().$type<{ et: number; ru: number } | null>(), broadcasts: jsonb().$type<{ et?: string; ru?: string } | null>(),
  createdAt, updatedAt });
// subscribers: + resendContactId: text("resend_contact_id"), syncedAt: timestamp("synced_at", tz)
export const mailSuppressions = pgTable("mail_suppressions", { id, email: text().notNull() /* lower-case, unique */, reason: text().$type<"bounce" | "complaint" | "other">().notNull(),
  since: timestamp tz notNull, clearedAt: timestamp tz });
export type NewsletterCampaign = typeof newsletterCampaigns.$inferSelect;

// domain/newsletter-campaign.ts (pure, browser-safe)
export const CAMPAIGN_LIMITS = { name: 80, subject: 150, preheader: 150, body: 10000, buttonLabel: 40, href: 500 } as const;
export const RESEND_FREE_CONTACTS = 1000; export const CONTACTS_WARN_AT = 900;
export type NewsletterCampaignDraft = { name: string; subject: I18n; preheader: I18n; imageKey: string | null; body: I18n; code: string | null; buttonLabel: I18n | null; buttonHref: string | null };
export function checkCampaignDraft(raw: unknown): { ok: true; value: NewsletterCampaignDraft } | { ok: false; fields: Record<string, string> };
//  required: name, subject.et, body.et; the code matches WELCOME_CODE's pattern (domain/welcome-code.ts); the button needs both label.et and href;
//  href is https:// or a site path starting with "/"; texts cleaned of control characters (newlines kept)
export function campaignContentFor(c: NewsletterCampaignDraft, locale: "et" | "ru"): { locale: "et" | "ru"; subject: string; preheader: string; paragraphs: string[]; buttonLabel: string | null };
//  ru falls back to et as a whole when subject.ru or body.ru is empty (never a mix); `locale` says which text was used
export function ruFallsBack(c: NewsletterCampaignDraft): boolean;

// server/campaign-mail.ts
export type CampaignMailInput = { content: ReturnType<typeof campaignContentFor>; pageLocale: "et" | "ru"; imageUrl: string | null; code: string | null;
  buttonHref: string | null; siteUrl: string; school: { name: string; address: string }; unsubscribeHref: string; test: boolean };
export function campaignMail(input: CampaignMailInput): { subject: string; html: string; text: string };
//  logo `${siteUrl}/brand/logo.png`; the preheader as the hidden first line; footer: the spec's two lines in pageLocale (the subscriber's language),
//  the school's name and address (Seaded → „Arve andmed", "MS LAB" when empty); test: subject "[Proov] …"
```

- [ ] **Step 1: Write the failing tests.**
  - **Migration:** 15 → 16, the columns, defaults and the unique lower-case email on `mail_suppressions`. Existing `subscribers` rows are unchanged, with null `synced_at`.
  - **Rules:** every refusal in `checkCampaignDraft`; the RU fallback as a whole (Review Focus 5); control characters cleaned.
  - **Mail:**
    - every user text is escaped (`<script>` in the body stays text);
    - the preheader is present;
    - the footer appears in the subscriber's language even when the content is ET;
    - `unsubscribeHref` is placed verbatim, so a `{{{…}}}` placeholder survives escaping;
    - the plain text holds the same paragraphs, code, button URL and footer;
    - the test mail's subject starts with „[Proov]".
  - **The account mails' existing tests stay green.** Their output must not change.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Run `npx drizzle-kit generate` and check by hand that the SQL is additive.
- [ ] **Step 4: Run** the three files, the account-mail tests, the purity and old-Safari tests, `npx drizzle-kit migrate` locally (count 16), and tsc.
- [ ] **Step 5: Commit** `feat(db): migration 0015 — newsletter campaigns, subscriber sync marks, mail suppressions; the campaign rules and mail`.

### Task 2: The Resend side — contacts, segments, full sync, suppressions, webhook

**Files:**
- Create:
  - `app/src/server/resend-marketing.ts`
  - `app/src/app/api/resend/webhook/route.ts`
- Modify:
  - `app/src/server/env.ts`: the two optional keys.
  - The sync hooks, each after its commit and best effort (`after()` where the request has one):
    - `submit.ts` (subscribe, ~:660);
    - `newsletter.ts` (`unsubscribeByToken`, `confirmSubscriber`);
    - `client-data.ts` (`setNewsletter` ~:778; `updateProfile` ~:769: a language change moves her linked row's `locale`; the account deletion ~:900);
  - `app/src/app/api/cron/sweep/route.ts`: the full sync with a time budget.
  - `app/src/lib/site-gate.ts`: `/api/resend/webhook` passes the gate.
- Test:
  - `app/tests/db/resend-marketing.test.ts`
  - `app/tests/db/resend-webhook.test.ts`
  - `app/tests/unit/site-gate.test.ts` (extend)

**Interfaces:**
- **Consumes:** Task 1's tables.
- **Produces:**

```ts
export type MarketingDeps = { db: Db; env: Env; siteUrl: string; now: Date; resend?: ResendLike /* injectable fake */; gapMs?: number; budgetMs?: number };
export function marketingConfigured(env: Env): boolean;
export async function ensureSegments(deps: MarketingDeps): Promise<{ et: string; ru: string }>;     // settings key "resend_segments"; creates „MS LAB uudiskiri (ET)" / „(RU)" once
export async function syncAddress(deps: MarketingDeps, email: string): Promise<"synced" | "removed" | "skipped" | "failed">;
//  a confirmed row → upsert her contact (unsubscribed false, property unsubscribe_url = the site's /api/newsletter/loobu?t=<token>), in the segment of her
//  locale and not the other; no row → delete her contact; sets synced_at / resend_contact_id; never throws
export type FullSyncReport = { contacts: number; added: number; updated: number; removed: number; unsubscribedPulled: number; suppressed: number;
  unsynced: number; limitReached: boolean; finished: boolean };
export async function fullSync(deps: MarketingDeps): Promise<FullSyncReport>;
//  1) reads Resend's contacts: each unsubscribed one deletes our row (D3); 2) reads the suppression list into mail_suppressions (D10), if the API offers it;
//  3) syncs every confirmed row with synced_at null or a missing property/segment; 4) deletes contacts with no row
export async function handleWebhook(deps: MarketingDeps, event: WebhookEventPayload): Promise<void>;
//  contact.updated with unsubscribed → delete the row of that address; suppression.added / .removed → mail_suppressions; others ignored
export async function suppressedAddresses(q: Q, emails: string[]): Promise<Set<string>>;   // for the admin's marks
export async function contactCount(deps: MarketingDeps): Promise<number | null>;
```

**Rules:**
- **The contact property.** The property key is `unsubscribe_url`. Check the template syntax that fills a custom contact property into a broadcast against Resend's documentation for 6.31 / the current API (expected `{{{contact.unsubscribe_url}}}`), and export it as `UNSUBSCRIBE_PLACEHOLDER`. Create the property definition first if the API requires one.
- **The 1,000-contact limit.** When Resend refuses a new contact because of the plan's limit, the sync stops adding and reports `limitReached`, with the rest counted as `unsynced` (Review Focus 4).
- **The webhook.**
  - It verifies with `resend.webhooks.verify` against the raw body and the svix headers, and answers 400 on a bad signature.
  - It answers 200 to every verified event, including those it ignores.
  - Deduplicate by `svix-id`. It is idempotent anyway, because deleting a row twice is harmless.
- **Logs:** `[newsletter-sync] …`, with counts and ids only.

- [ ] **Step 1: Write the failing tests** against a faked SDK.
  - Each hook calls `syncAddress` after its commit, and a failed sync leaves `synced_at` null without failing the action.
  - `fullSync` pulls a Resend-side unsubscribe before anything else (Review Focus 1).
  - Every synced contact ends with the property (Review Focus 2).
  - The limit stops adding (Review Focus 4).
  - The locale moves the segment.
  - A deleted account's contact is deleted.
  - Webhook: a bad signature gives 400; an unsubscribe deletes the row; a suppression is recorded and then cleared.
  - The gate lets the webhook through.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, the existing newsletter, subscribe and account tests, and tsc.
- [ ] **Step 5: Commit** `feat(newsletter): Resend contacts and segments kept in sync; unsubscribes and suppressions come back`.

### Task 3: Maria's „Uudiskiri" page — sync, counts, marks

**Files:**
- Modify:
  - `app/src/app/admin/(panel)/uudiskiri/page.tsx` (+ css): „Sünkrooni Resendiga", the contact count against 1,000 with the warning at 900, the last sync's report, and the suppression mark per row.
  - `app/src/components/admin/ClientDrawer.tsx` and `app/src/server/admin-clients.ts`: the suppression mark on her account.
  - `app/src/i18n/dict/admin.ts`
  - `app/src/data/testplan.json`
- Create: `app/src/server/actions/admin-newsletter.ts` with `fullSyncAction()`.
- Test:
  - `app/tests/db/admin-newsletter-actions.test.ts`
  - `app/tests/unit/newsletter-page-dom.test.ts`

**Interfaces:**
- **Consumes:** Task 2's `fullSync`, `contactCount`, `suppressedAddresses` and `marketingConfigured`.
- **Produces:** `fullSyncAction`, wrapped in `adminAction`. It returns the `FullSyncReport` or `{ error: "unavailable" | "notConfigured" }`.

**Rules:**
- **Without a marketing key** the sync button and the count are replaced by „Resendi uudiskirja saatmine pole veel seadistatud." (Draft). The list and the CSV stay as they are.
- **The report** after a sync, as one line (Draft): „{added} lisatud, {removed} eemaldatud, {unsubscribedPulled} loobus Resendis".
  - Also the spec's limit line when `limitReached`.
  - Also the spec's „Resendiga ei saanud ühendust…" on `unavailable`.
- **The suppression text** is the spec's, on the row and in the student's drawer.
- **The test plan:** a new check for „Sünkrooni Resendiga" and the contact count. It runs only with the key set, so it is Dim's check, `"who": "dim"`.

- [ ] **Step 1: Failing tests.** The action's results and errors, and the DOM states: not configured, the warning at 900, the limit line, the mark.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, tsc and eslint, and the e2e specs `admin-clients` and `admin-site`. If neither covers „Uudiskiri", use whichever does today.
- [ ] **Step 5: Commit** `feat(admin): „Uudiskiri" — sync with Resend, the contact count, blocked addresses`.

### Task 4: „Kampaaniad" — the editor, „Saada proov", „Saada kõigile", „Kopeeri"

**Files:**
- Create:
  - `app/src/components/admin/CampaignsPanel.tsx` (+ css)
  - `app/src/components/admin/NewsletterCampaignEditor.tsx`
  - `app/src/server/newsletter-campaigns.ts`
  - `app/src/app/api/admin/kampaania-eelvaade/route.ts`: the preview's HTML for an iframe, from posted unsaved values, storing nothing.
- Modify:
  - `app/src/app/admin/(panel)/uudiskiri/page.tsx`: the tab `?vaade=kampaaniad`;
  - `app/src/server/actions/admin-newsletter.ts`;
  - `app/src/i18n/dict/admin.ts`;
  - `app/src/data/testplan.json`.
- Test:
  - `app/tests/db/newsletter-campaigns.test.ts`
  - `app/tests/unit/campaign-editor-dom.test.ts`
  - `app/tests/db/campaign-preview-route.test.ts`

**Interfaces:**
- **Consumes:** Tasks 1–3. That covers `checkCampaignDraft`, `campaignContentFor`, `ruFallsBack`, `campaignMail`, `fullSync`, `ensureSegments` and `UNSUBSCRIBE_PLACEHOLDER`, plus `getInvoiceSettings` for the school.
- **Produces:**

```ts
// newsletter-campaigns.ts
export async function saveCampaign(db: Db, id: number | null, raw: unknown, now: Date): Promise<{ ok: true; id: number } | { ok: false; fields: Record<string, string> } | { ok: false; error: "sent" }>;
export async function copyCampaign(db: Db, id: number, now: Date): Promise<{ ok: true; id: number } | { ok: false }>;
export async function sendTest(deps: MarketingDeps, id: number, to: string): Promise<{ ok: true } | { ok: false; error: "notFound" | "mail" | "limited" }>;
export type SendPlan = { et: number; ru: number; ruFallsBack: boolean; report: FullSyncReport };
export async function prepareSend(deps: MarketingDeps, id: number): Promise<{ ok: true; plan: SendPlan } | { ok: false; error: "notFound" | "sent" | "notConfigured" | "unavailable" | "unsynced" }>;
export async function sendCampaign(deps: MarketingDeps, id: number): Promise<{ ok: true; recipients: { et: number; ru: number } } | { ok: false; error: "notFound" | "sent" | "notConfigured" | "unavailable" | "unsynced" }>;
// actions (adminAction): saveCampaignAction, copyCampaignAction, sendTestAction({ id }), prepareSendAction({ id }), sendCampaignAction({ id })
```

**Rules:**
- **„Saada proov".**
  - It goes to `MARIA_EMAIL` or the signed-in admin's address (a choice of the two), at most 10 an hour (`ratelimit.ts`).
  - It is a single `sendMail` with `test: true`. Its unsubscribe link is `${siteUrl}/api/newsletter/loobu?proov=1`, which shows „Proovikiri — päris kirjas viib see link loobumisele." (Draft) and changes nothing.
- **„Saada kõigile".**
  - `prepareSend` runs the full sync and returns the counts, and the dialog shows the spec's confirmation. When `ruFallsBack`, the dialog also shows „Vene keeles tellijad saavad eestikeelse kirja.".
  - `sendCampaign` runs in one transaction with the campaign row `FOR UPDATE`, and requires `status = "draft"`.
  - It runs the full sync again and refuses `unsynced` while any confirmed row is unsynced or lacks the property (Review Focus 2).
  - It creates one broadcast per non-empty segment, with `send: true`:
    - `from`: `MAIL_FROM`;
    - `reply_to`: `MARIA_EMAIL`;
    - the language's subject;
    - the html and text from `campaignMail`, with `unsubscribeHref = UNSUBSCRIBE_PLACEHOLDER` and `pageLocale` = the segment's language.
  - It then sets `sent`, `sent_at`, `recipients` and `broadcasts`.
  - A second press answers `sent` (Review Focus 3).
- **Partial failure.** If the second broadcast fails after the first was sent, the campaign is still marked `sent`, with the one that went recorded. Maria sees „Venekeelne kiri jäi saatmata — kopeeri kampaania ja saada uuesti." (Draft) or the ET equivalent. Nothing is ever sent twice.
- **A sent campaign** is read-only. It shows „Saadetud {date} · {n} tellijale" and a link to each broadcast in Resend's dashboard (`https://resend.com/broadcasts/<id>`).
- **The preview** is the real `campaignMail` output in an `<iframe srcdoc sandbox>`, for ET and for RU. The preview route is admin-only, `private, no-store`, and caps its body like `/api/admin/naidisleping`.
- **The picture** uses the existing `SingleImage` upload (as `CampaignEditor.tsx` does, ratio free or 4 / 5 for flyers, the builder's call), and `mediaUrl(key)` as an absolute URL. `/media` already passes the gate.
- **The test plan:**
  - new checks: writing a campaign and the preview; „Saada proov"; „Saada kõigile" (Dim's, with test addresses only); the received campaign's unsubscribe removes the row; „Kopeeri";
  - placed in file order after the „Uudiskiri" sync check.

- [ ] **Step 1: Failing tests.** Cover the rules above, with a faked SDK (Review Focus 3 and 5 in DB tests), and the editor's DOM states: draft, sent and not configured.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, tsc and eslint, and the e2e spec covering the admin's „Uudiskiri", extended with the editor and the preview. The e2e never sends: the marketing key is unset locally.
- [ ] **Step 5: Commit** `feat(admin): „Kampaaniad" — write, preview, test and send a newsletter through Resend`.

### Task 5: End to end and docs

**Files:**
- Create: `app/tests/e2e/newsletter-campaigns.spec.ts`
- Modify:
  - `docs/deploy.md`: new §19 „Uudiskirjad";
  - `docs/launch-checklist.md`: new §18;
  - the spec: amendments marked "(amended DD.MM during the build)";
  - `app/src/data/testplan.json`: only the fixes the e2e shows.

**Rules:**
- **The e2e path**, local, with no Resend key:
  1. „Uudiskiri" shows „pole veel seadistatud".
  2. Maria writes a campaign with a picture, a code and a button. The ET and RU previews show the texts, the code and the footer.
  3. „Kopeeri" makes a draft.
  4. A sent campaign (set in the DB) is read-only.
  - Widths: 390, 834, 1194 and 1440.
- **The webhook e2e:** a signed fake event (the test signs with a local secret) deletes a subscriber row, and a bad signature gives 400.
- **`docs/deploy.md` §19:**
  - what is synced and when;
  - the keys (`RESEND_MARKETING_KEY` / `RESEND_API_KEY` full access, `RESEND_WEBHOOK_SECRET`; amended by R15: `RESEND_MARKETING_KEY` only) and the webhook URL with its three events;
  - the full sync and the cron;
  - the logs;
  - the 1,000-contact limit;
  - the shared-suppression consequence of D1;
  - rollback: 0015 is additive;
  - the migration note: Railway goes from 15 to 16;
  - Dim's first live check: a sync, one „Saada proov", then „Saada kõigile" with only `+proov` test addresses subscribed, and the unsubscribe from the received mail.
- **`docs/launch-checklist.md` §18:**
  - Dim creates the full-access key and the webhook;
  - Maria's privacy text names Resend as the newsletter's processor;
  - the first real campaign after the launch;
  - test subscribers removed by exact address before the launch.

- [ ] **Step 1: Write the e2e and run it** under `next dev` and `E2E_PROD_BUILD=1`.
- [ ] **Step 2: Write the docs and the amendments.**
- [ ] **Step 3: Run** the full vitest, tsc and eslint.
- [ ] **Step 4: Commit** `test(e2e): newsletter campaigns; docs: the runbook's Uudiskirjad and the launch list`.

### Task 6: Railway 0015, merge, push, smoke (controller)

- [ ] **Step 1: Branch checks.**
  - The full vitest, tsc, eslint and `npm run build`.
  - The e2e `newsletter-campaigns`, the „Uudiskiri" spec, `course` and `home` under dev and under `E2E_PROD_BUILD=1`, plus the gate config.
- [ ] **Step 2: Railway, read-only.** Expect 15 migrations and no `newsletter_campaigns`.
- [ ] **Step 3: Migrate.** Expect 16, the tables present, and `subscribers` with its new columns, its rows unchanged. Delete `rw.env`.
- [ ] **Step 4: Stamp, then re-run the testplan tests, then merge and push.** If the Vercel build fails on a transient fetch, redeploy once.
- [ ] **Step 5: Smoke.**
  - `/` → 200.
  - `POST /api/resend/webhook` with a bad signature → 400.
  - `/admin/uudiskiri?vaade=kampaaniad` → login.
- [ ] **Step 6: Tell Dim** the setup steps (§19 and §18): the key and the webhook. Then his first live check. Update the memory.
