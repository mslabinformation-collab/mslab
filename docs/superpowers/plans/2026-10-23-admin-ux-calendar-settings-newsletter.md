# Admin UX pass, piece 3b: Kalender, Seaded, Uudiskiri — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design's B3 Kalender, B4 Seaded (with the legal texts on the draft layer and B21's number previews) and B5 Uudiskiri (with B17 „Kustuta mustand“ and B9 matching counts), so every card and field autosaves under one SaveStatus and nothing is published or sent without an explicit press.

**Architecture:**
- **Autosave.** Each editor autosaves through route handlers built with piece 1's `autosaveHandler`. Rows without `updated_at` (sessions, the invoice, certificate and financing settings) take a `contentVersion` hash as their version.
- **Legal texts.** Privaatsus, Õppetingimused, E-koolituse leping and Kontaktkoolituse leping live in `content_drafts` (entity `legal`, a fixed numeric id per text). „Avalda uus leping“ / „Avalda uus tekst“ publishes through the existing save functions unchanged, so version bumps, locks and revalidation stay where they are (spec C6).
- **Newsletter.** The editor's save stops moving `updatedAt` when nothing changed (spec C4). A send flushes first.

This plan follows piece 3a (`docs/superpowers/plans/2026-10-23-admin-ux-courses.md`) and is built after it merges. It reuses 3a's `SectionMap` and optional-search `ListToolbar`.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest + happy-dom, Playwright, Resend.

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`, built as designed. This plan covers §8 item 3 for B3–B5, C4, C6, B9, B17, B21's UI, and §9's renames (newsletter „Kampaaniad“ → „Kirjad“; contracts).

Other sources:
- Design: `docs/superpowers/specs/admin-ux-pass/handoff/README.md` §3 B3, B4, B5 and §5 B9, B17, B21; prototypes `… Part 3.dc.html` and `… Part 4.dc.html`.
- Approved texts: **`docs/superpowers/specs/admin-ux-pass/analysis/piece3-texts.md`** (Dim 23.10), with S3-P3-f, g (sessions), h, i, j, k, l and P-7…P-13, including P-9's „Seaded → Maksmine“ renames.
- Code map: `analysis/behaviours.md` ("Contract texts on the draft layer", B9, B17, conflicts 1, 13, 15, 22) and `analysis/strings.md` rows B3–B5 and D11–D17.
- Contracts spec: `docs/superpowers/specs/2026-10-17-contracts-design.md` (R6, R11, D3, D4).

## Global Constraints

Same as piece 3a's Global Constraints (`docs/superpowers/plans/2026-10-23-admin-ux-courses.md`, the section of that name), word for word, with these additions:
- **Migration.** None in this plan. If a task finds one is needed, it stops and reports.
- **Cards that move.** Seaded's old anchors keep working as aliases: `#arve`, `#ettemaks` and `#jarelmaks` go to „Maksmine“, plus `#tunnistus` and `#lepingud`. Links in `InvoiceBlock.tsx`, `MoneyCard.tsx`, `UninvoicedStrip.tsx` and `InvoiceSettings.tsx` follow P-9.
- **Number fields** („Järgmine number“ for invoices and certificates) commit on blur, not while typing (behaviours conflict 13). Their `taken` refusal shows in the field.

## Rulings carried (spec silent)

- **R-a. Session version.** `contentVersion` of `{courseId, startsAt, city, venue, language, capacity, status}`. The write takes `lockSession(tx, id)` (the same lock order as public registration).
- **R-b. Kalender counts.** "{n} õpilast on registreerunud", „teavita {n} õpilast ise“ and „Koolitus“ being locked all use n = registrations that are not cancelled (confirmed + awaiting). „Kustuta toimumine“ counts every registration, cancelled ones too, as the server does today. When only cancelled ones exist, the delete refusal text still applies, because the rows stay as history.
- **R-c. „Kohti“ below the confirmed count** is refused on the server too, under `lockSession`, using confirmed only (README „Kinnitatud on {n}“).
- **R-d. Legal text ids** in `content_drafts`: entity `legal`, entity_id `1` privacy, `2` terms, `3` course_terms, `4` contract_contact, part `text`, value `{title: I18n, body: I18n}`.
  - There is no discard: the draft stays until published. The design draws none.
  - The sample PDF („Näidisleping“) uses the draft text when one exists.
- **R-e. Re-accept count.** The count in the e-course ConfirmPanel is distinct clients with an active e-course access (`revoked_at is null and expires_at > now`, as `activeAccess`). They are asked at their next opening.
- **R-f. „Maksmine“** holds „Ettemaksu juhised“, the invoice settings („Arve andmed“) and „Järelmaks (Inbank)“. The bank fields are one source: the invoice already reads the prepayment bank.
- **R-g. A new newsletter draft** („Uus kiri +“, S3-P3-h) is created with name „Uus kiri“ and empty subject and body.
  - Saves accept an empty subject and body. The send-time check (`checkCampaignDraft`'s required rules) moves to „Saada proov“ and „Saada kõigile“.
  - The button rule (ET label + address together, RU label with an RU body) is checked per field as today, and again at send.
- **R-h. B9.** „Saada kõigile ({n})“ shows `n` from `countsOf(recipientsNow)` read without the press lock at render. The ConfirmPanel re-reads the count under the lock as today, and an `n` that moved is the existing `changed` answer. The Tellijad pills count every subscriber row shown, sample addresses included; only the send excludes them.

## Review Focus

1. **Two tabs on Seaded.** The same card is edited in both tabs. Expected: the second save is a conflict and the local text is kept. A number field that another tab took shows `taken` in the field. (Task 4 tests.)
2. **Publishing a legal text while a student has the old one open in a cart or form.** Expected: her press is refused as today (`shownVersionHolds`). The ConfirmPanel count equals the students who will be asked. (Task 5 db tests.)
3. **„Saada kõigile“ right after typing.** Expected: the send flushes first and never sends an older text than the screen shows. If the flush fails, the buttons are replaced by S3-P3-l. (Task 6 DOM tests.)
4. **A session edited while a student registers.** Expected: capacity can't drop below confirmed, and the course can't change once someone is booked. Both are checked on the server under `lockSession`, never only in the field. (Task 2 db tests.)
5. **375 px phone.** Expected: the Kalender drawer, the Seaded section select and the Uudiskiri „Muuda | Eelvaade“ switch scroll nothing sideways, and sticky bars carry `data-fab-avoid`. (e2e in Tasks 3, 4, 6.)

---

### Task 1: Kalender list (B3)

**Files:**
- Modify: `src/components/admin/ListToolbar.tsx` (`scopes?: ListScope[]`, several selects; `scope` stays as a single-select alias), `src/app/admin/(panel)/kalender/page.tsx`, its CSS, `src/db/queries/admin.ts` (`listAdminSessions` filters `courseId`, `city`; counts per pill), `src/i18n/dict/admin.ts`.
- Test: `tests/unit/list-toolbar-dom.test.ts`, `tests/db/admin-content.test.ts` ("calendar sessions"), `tests/e2e/admin-edit.spec.ts` ("calendar"), `tests/e2e/admin-list-widths.spec.ts`.

**Interfaces:**
- Produces:
  - URL `?koolitus=<courseId>`, `?linn=<city>`, `?aeg=moodunud`, `?id=<n>|uus`.
  - `sessionCounts(db, filter, now): Promise<{upcoming: number; past: number}>` under the course and city filters.

**Exact behaviour (README B3, P-7):**
- ListToolbar with the course select, the city select and the pills „Tulevased / Möödunud“ with counts. No search field.
- The whole row opens the drawer, through the shared list table and `ListRows`.

- [ ] **Step 1: Failing tests.**
  - DOM: two scope selects render and navigate to their option hrefs.
  - db: filters by course and by city; the pill counts equal the rows under the filters.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `admin-edit.spec.ts` "calendar", and `admin-list-widths.spec.ts` (add Kalender).
- [ ] **Step 5: Test plan.** `haldus-kalender-toimumine` `redo`.
- [ ] **Step 6: Commit** `feat(admin): B3 Kalender list — course and city selects, pills with counts, whole-row drawer`.

### Task 2: Session server — autosave and rules

**Files:**
- Create: `src/server/session-edit.ts`, `src/app/api/admin/toimumine/[id]/route.ts` (POST autosave).
- Modify: `src/server/admin-content.ts` (create stays explicit), `src/db/queries/admin.ts` (`deleteUnusedSession` unchanged count; a not-cancelled count read), `src/server/actions/admin-content.ts` (create returns the id so the drawer stays open; `cancelSession` instant action).
- Test: `tests/db/session-edit.test.ts` (new), `tests/db/admin-content.test.ts`, `tests/unit/admin-guards.test.ts`.

**Interfaces:**
- `readSession(db, id) → {version, value}`.
- `writeSession(db, id, patch, version, admin, now): Promise<SaveAnswer>` with R-a/R-c. Refusals use field codes: `capacityBelow` (README text with {n}) and `courseLocked` (S3-P3-i).
- `createSession(db, input, now): Promise<{ok: true; id} | invalid>`.
- `setSessionStatus(db, id, status, expectedVersion)`: an instant ConfirmPanel action.
- Revalidation `{kind:"sessions"}` on every successful write.

- [ ] **Step 1: Failing db tests.**
  - Capacity 3 with 4 confirmed is refused `capacityBelow` and nothing is written.
  - A course change with one awaiting registration is refused `courseLocked`.
  - A stale version is a conflict.
  - A date change writes and revalidates.
  - A concurrent public registration and a capacity save serialise on `lockSession`; the query log shows the lock first.
  - A cancelled-only session still refuses delete.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `seats.test.ts` and `admin-guards`; they PASS.
- [ ] **Step 5: Commit** `feat(admin): B3 sessions — autosave route, capacity and course rules under the session lock`.

### Task 3: Kalender drawer (B3)

**Files:**
- Modify: `src/components/admin/SessionForm.tsx` (rewritten), `src/app/admin/(panel)/kalender/page.tsx` (the drawer), `src/i18n/dict/admin.ts`.
- Test: `tests/unit/session-form-dom.test.ts` (new), `tests/e2e/admin-edit.spec.ts` ("calendar" ~:625-736), `tests/e2e/protocols.spec.ts` (`data-session-protocols`).

**Exact behaviour (README B3, S3-P3-g, S3-P3-i, P-7):**
- **Header:** SaveStatus, ✕, the course in Jost 28, "{date} · {city} · {confirmed}/{cap} kinnitatud · ootenimekirjas {n}", and „Protokollid“ as the first button.
- **Registrations notice:** with registrations, „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“
- **Fields:** they autosave through Task 2's route. Changing the date or time shows the hint „Muudetud — teavita {n} õpilast ise.“ (#6b4f5c). The label is „Algus (Eesti aeg)“.
- **Kohti:** a value below confirmed is refused in the field with „Kinnitatud on {n} — kohti ei saa olla vähem.“
- **Koolitus:** disabled once anyone is booked, with S3-P3-i under it.
- **Cancelling:** „Tühistatud“ with registrations opens a ConfirmPanel: „Kas tühistan toimumise? {n} registreeringut jäävad alles; teavita õpilasi ise.“, „Jah, tühista“ / „Katkesta“.
- **Deleting:** „Kustuta toimumine“ shows only with 0 registrations. Otherwise show the text „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“
- **New session** (`?id=uus`): the header shows „Täida kohustuslikud väljad“, then „Vajuta „Lisa toimumine“.“. The button „Lisa toimumine“ creates the session and the drawer moves to `?id=<new>` and autosaves. Leaving with typed text asks, giving the reason „Toimumist pole veel lisatud.“

- [ ] **Step 1: Failing DOM tests:** each text, the hint on a date change, the refused capacity, the locked course with its reason, the cancel ConfirmPanel, the delete rule, and the new-session header states.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `admin-edit.spec.ts` "calendar". Rewrite its „Salvesta toimumine“ steps. Add a 375×812 drawer check.
- [ ] **Step 5: Test plan.** `haldus-kalender-toimumine` (already `redo`) gains the autosave, cancel and delete-rule steps. New check: `haldus-kalender-kohad` (capacity below confirmed is refused).
- [ ] **Step 6: Commit** `feat(admin): B3 Kalender drawer — autosave, notices, refusals in the field, ConfirmPanel cancel, explicit new session`.

### Task 4: Seaded page — section map, Maksmine, autosave, number previews (B4, B21)

**Files:**
- Modify:
  - `src/app/admin/(panel)/seaded/page.tsx`
  - `src/components/admin/SettingsEditor.tsx`, `CertificateSettings.tsx`, `InvoiceSettings.tsx`, `FinancingSettings.tsx`
  - `src/server/admin-site.ts` (`settingsParts`), `src/server/invoices.ts` (`saveInvoiceSettings` as a part writer), `src/server/certificates.ts`, `src/server/actions/*` (removed card actions), `src/i18n/dict/admin.ts`
  - the P-9 texts and links (`InvoiceBlock.tsx`, `MoneyCard.tsx`, `UninvoicedStrip.tsx`, `InvoiceSettings.tsx`, `messages.ts` if a mail names the card)
- Create: `src/app/api/admin/seaded/[part]/route.ts` (POST autosave, parts `contact | newsletter | prepayment | invoice | certificate | financing`).
- Test: `tests/unit/invoice-settings-dom.test.ts`, `certificate-settings-dom.test.ts`, `financing-settings-dom.test.ts`, `tests/db/seaded-*.test.ts`, `tests/db/admin-site.test.ts` ("settings"), `tests/e2e/admin-site.spec.ts` ("settings"), `admin-invoices.spec.ts` (~:607), `certificate.spec.ts`, `tests/e2e/admin-login.ts` (`seadedSave` helper goes).

**Interfaces:**
- Consumes 3a's `SectionMap`.
- Produces one route for every settings part. Versions are `contentVersion` of the stored part; the invoice and certificate rows use their stored JSON. The financing toggle is a part too, and is instant: a checkbox that saves on change.

**Exact behaviour (README B4, B21, R-f, P-9, P-10):**
- **Layout:** one page with a section map: Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja tingimused, Halduse ligipääs. The old anchors are aliases.
- **Saving:** every card autosaves under one SaveStatus. The five card buttons go: the page SaveBar „Salvesta“ and the four card buttons. `SaveBar.tsx` stays for the editors of piece 4.
- **Number fields:** „Järgmine number“ fields show a preview, „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“ (P-10). The invoice preview shows 001 when the typed prefix differs from the stored one (R3). Numbers commit on blur. The page passes its `now` to `InvoiceSettings` (B21 ledger T1). Certificates keep their „Aasta“ field (spec D6).
- **Stale comment:** fix the one at `src/server/actions/admin-invoices.ts` ~:190-191.

- [ ] **Step 1: Failing tests:**
  - DOM: the previews, including 001 for a new prefix, and commit on blur;
  - db: each part's route with conflict, invalid and `taken`;
  - the aliases resolve to the right section ids.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the Seaded e2e specs (rewrite the save-button steps). Add a 375×812 check of the „Jaotised ▾“ select.
- [ ] **Step 5: Test plan.**
  - `redo`: `haldus-seaded-kontakt`, `-ettemaks`, `-tunnistus`, `-arve`, `-jarelmaks`.
  - `reworded`: `registreerimine-arve-jalus` and every check naming „Arve andmed“ (P-9).
- [ ] **Step 6: Commit** `feat(admin): B4 Seaded — section map, „Maksmine“, autosave under one status, number previews (B21)`.

### Task 5: Legal texts on the draft layer (B4, C6)

**Files:**
- Create: `src/server/legal-drafts.ts`, `src/app/api/admin/oigustekst/[key]/route.ts` (POST autosave of the draft), `src/app/api/admin/oigustekst/[key]/avalda/route.ts` (POST publish).
- Modify:
  - `src/components/admin/SettingsEditor.tsx` and `ContractTexts.tsx`: the four texts become one „Lepingud ja tingimused“ section;
  - `src/components/admin/I18nInput.tsx`: an `insert(text)` handle via ref, inserting at the cursor in the language shown;
  - `src/server/admin-site.ts` and `src/server/contracts.ts`: the existing writers are called by publish;
  - `/api/admin/naidisleping`: uses the draft;
  - `src/i18n/dict/admin.ts`.
- Test: `tests/db/legal-drafts.test.ts` (new), `tests/db/contracts.test.ts`, `tests/db/admin-site.test.ts` (course_terms), `tests/unit/contract-texts-dom.test.ts`, `tests/e2e/admin-site.spec.ts` (Lepingud), `tests/e2e/contracts.spec.ts`.

**Interfaces:**
- `readLegal(db, key)` returns `{version, value, live, changed}`.
- `writeLegalDraft(db, key, patch, version, admin)`.
- `publishLegal(db, key, now)` calls `saveSettings`' `pagePart`/`course_terms` writer or `saveContractTexts` unchanged, then deletes the draft. Its result is `{ok} | {ok:false; error:"changed"}`.
- `reacceptCount(db, now): Promise<number>` (R-e).

**Exact behaviour (README B4, S3-P3-j, S3-P3-k, P-11):**
- Typing saves only to the draft. The tag „Avaldamata muudatus“ shows while a draft differs from live.
- **E-koolituse leping:** the button „Avalda uus leping“ opens the drawn ConfirmPanel: „Kas avaldan uue e-koolituse lepingu?“ · „{n} aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.“ · „Vana leping jääb alles ja märgitakse asendatuks.“ · „Jah, avalda“ / „Katkesta“. Use the n = 1 and n = 0 forms from P-8.
- **Kontaktkoolituse leping:** the S3-P3-j panel.
- **Privaatsus and Õppetingimused:** the button „Avalda uus tekst“ with the S3-P3-k panels. The second line of the Õppetingimused panel shows only while `contract_contact` is empty.
- Placeholders are chips that insert at the cursor.
- Publishing makes a new contract version exactly as a save does today (C6). A student's open form or cart is then refused as today.

- [ ] **Step 1: Failing db tests:**
  - a draft never changes `pages`, nor the version settings, until publish;
  - publish bumps `courseTermsVersion` once;
  - a second publish with no change does not bump;
  - `reacceptCount` counts distinct active e-course clients;
  - the sample PDF uses the draft;
  - a stale draft version is a conflict.

  **Failing DOM tests:** the panel texts with n = 1 and n = 0, and a chip inserts at the cursor.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `contracts.test.ts`, `contracts.spec.ts` and the Lepingud e2e.
- [ ] **Step 5: Test plan.**
  - `haldus-seaded-lepingud` and `-tingimused`: `redo`.
  - `ekursus-tingimused-leping` and `registreerimine-leping-muutunud`: `reworded` (they now press „Avalda uus leping“).
  - New check: `haldus-seaded-privaatsus-avalda`.
- [ ] **Step 6: Commit** `feat(admin): B4 legal texts — drafts, „Avalda uus leping“ / „Avalda uus tekst“ with the re-accept count`.

### Task 6: Uudiskiri — Kirjad (B5, B17, B9, C4)

**Files:**
- Modify: `src/app/admin/(panel)/uudiskiri/page.tsx`, `src/components/admin/CampaignsPanel.tsx`, `NewsletterCampaignEditor.tsx`, `src/server/newsletter-campaigns.ts` (C4 no-op save; R-g; `deleteDraft`), `src/domain/newsletter-campaign.ts` (save vs send checks), `src/server/actions/admin-newsletter.ts`, `src/i18n/dict/admin.ts` (P-12 renames).
- Create: `src/app/api/admin/kiri/[id]/route.ts` (POST autosave).
- Test: `tests/unit/campaign-editor-dom.test.ts`, `tests/db/newsletter-campaigns.test.ts`, `newsletter-send.test.ts`, `newsletter-page.test.ts`, `admin-newsletter-actions.test.ts`, `tests/e2e/newsletter-campaigns.spec.ts`, `newsletter-race.spec.ts`, `admin-inbox.spec.ts` (~:1425).

**Interfaces:**
- `saveCampaign` leaves `updatedAt` alone when no field changed (C4).
- `createDraft(db, now): Promise<{id}>` makes the draft „Uus kiri“ (R-g).
- `deleteDraft(db, id): Promise<"ok" | "sent" | "notFound">`, under the press lock with the row `FOR UPDATE`; the status must be draft.
- `sendCountNow(db): Promise<number>` (R-h, without the lock).

**Exact behaviour (README B5, S3-P3-f, h, l, P-12, P-13):**
- **Tabs and layout:**
  - Tabs „Tellijad“ | „Kirjad“ through `TabPills`; the route keeps `?vaade=kampaaniad`.
  - The Kirjad layout is a 300 px list („Uus kiri +“, rows with name + state line) | the editor | a 380 px column (Eelvaade, Saatmine).
  - On a phone, the prototype's „Muuda | Eelvaade“ switch.
- **Editor and preview:** the editor autosaves and keeps its counters. The preview follows the page `LangSwitch`; `PreviewLangSwitch` goes from this screen (ledger L152).
- **„Kustuta mustand“** (drafts only) opens a ConfirmPanel: „Kas kustutan mustandi „{nimi}“?“ · „Seda ei saa tagasi võtta.“ · „Jah, kustuta“ / „Katkesta“. The list then shows „Mustand kustutatud.“. If the letter was sent meanwhile: „See kiri on juba saadetud.“
- **„Uus kiri +“** creates the draft and puts the cursor in „Nimi“.
- **Saatmine:**
  - A select "{address} · {eesti|vene keeles}" and „Saada proov“.
  - „Saada kõigile ({n})“ opens the ConfirmPanel with the existing count text and „Jah, saada {n} tellijale“; n excludes sample addresses.
  - The busy text: „Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.“
  - Both sends flush first. When the flush can't go through, the buttons give way to S3-P3-l.

- [ ] **Step 1: Failing tests:**
  - db:
    - a no-change save keeps `updatedAt`, so the send guard is unaffected;
    - a draft with empty subject saves;
    - a send of it is refused with the existing required-field words;
    - `deleteDraft` refuses a sent letter;
    - `sendCountNow` excludes `@example.test`.
  - DOM:
    - the Kustuta panel texts;
    - „Saada kõigile (3)“ with „Jah, saada 3 tellijale“;
    - S3-P3-l when the flush fails;
    - the preview follows the page switch.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `newsletter-campaigns.spec.ts`, `newsletter-race.spec.ts` and `admin-inbox.spec.ts` (newsletter). Add a 375×812 check.
- [ ] **Step 5: Test plan.**
  - `redo`: `avalik-uudiskiri-kampaania`, `-saada`, `-muudetud`.
  - New check: `avalik-uudiskiri-kustuta`.
  - Reword every check saying „kampaania“ for a letter (P-12).
- [ ] **Step 6: Commit** `feat(admin): B5 Kirjad — autosave without a moved timestamp, „Uus kiri +“, B17 „Kustuta mustand“, B9 counts, flush before send`.

### Task 7: Uudiskiri — Tellijad (B5)

**Files:**
- Modify: `src/app/admin/(panel)/uudiskiri/page.tsx` (subscribers view), `src/db/queries/admin.ts` (subscriber search and filters), `src/app/api/admin/subscribers.csv/route.ts` (current filter), `src/i18n/dict/admin.ts`.
- Test: `tests/db/newsletter-page.test.ts`, `tests/e2e/newsletter-campaigns.spec.ts` (~:123), `admin-inbox.spec.ts` (~:1395).

**Exact behaviour (README B5, P-13, R-h):**
- ListToolbar with address search (escaped `containsPattern`) and the pills „Kinnitatud“ / „Ootab kinnitust“ with counts.
- „Laadi alla (CSV)“ exports the current filter: `?otsi=` and `?olek=`. It replaces the two fixed CSV buttons.

- [ ] **Step 1: Failing tests:** the search finds by part of an address; the counts equal the rows; the CSV holds exactly the filtered rows.
- [ ] **Step 2: Run** them; they FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the two e2e specs.
- [ ] **Step 5: Test plan:** the subscribers checks in `avalik-uudiskiri-*` that name the CSV buttons become `reworded`.
- [ ] **Step 6: Commit** `feat(admin): B5 Tellijad — search, pills with counts, CSV of the current filter`.

### Task 8: Docs, test-plan sweep and the full run

**Files:**
- Modify:
  - `docs/deploy.md`, section 24. It covers: no migration; what changed for Maria on each screen; the legal-text publish rule; C4; B9; the rollback note (a legal-text draft not yet published is lost to old code, so publish or note it first); and a read-only check of Railway `settings.invoice.nextYear` against a pre-B21 next-year preset (piece 1 ledger T1).
  - `docs/launch-checklist.md`.
  - `docs/superpowers/specs/2026-10-17-contracts-design.md` and `2026-10-20-newsletter-simple-design.md`: spec §9 amendments, the contract texts as drafts, „Kampaaniad“ → „Kirjad“, and the send's ConfirmPanel.
  - `src/data/testplan.json`.
- Test: full suites.

- [ ] **Step 1:** Sweep `tests/` and `testplan.json` for every removed or changed string of Tasks 1–7.
- [ ] **Step 2:** Write the docs and check each claim against the code.
- [ ] **Step 3:** Run all vitest, tsc, lint, the build, and the full Playwright run with the ports checked. A flake must pass when run alone; a test that fails twice is a finding.
- [ ] **Step 4: Commit** `docs(admin): piece 3b — deploy notes, launch checklist, spec amendments, test plan sweep`.
