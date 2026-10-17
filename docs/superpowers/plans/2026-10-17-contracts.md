# Contracts ("Lepingud") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every group registration and every e-course access gets one frozen contract when the student ticks the box she already ticks. The contract holds the exact text she read, filled with her course, date and price. She gets it as a PDF by mail and in her account. Maria writes the texts in Seaded, sees the contracts in the drawers, can ask again, and can send a copy.

**Architecture:**
- **Migration 0013** (additive): a `contracts` table (frozen title/body/fields), `registrations.contract_requested_at`, `payments.contract_snapshot`.
- **Pure rules:** `src/domain/contract.ts`. It fills the placeholders and builds the frozen fields. The same fill runs in the browser for the inline preview.
- **Server:** `src/server/contracts.ts`. It inserts contracts inside the existing transactions (the registration submit, the e-course settle, the terms gate) and handles reads, ask-again, supersede and send.
- **PDF:** a multi-page PDF from `src/server/contract-pdf.ts`, on a text helper shared with the invoice.

**Tech Stack:** Next.js 16.3.8 (pinned), Drizzle 0.45 + postgres.js, pdf-lib 1.17.1 + fontkit 1.1.1 (pinned), Resend attachments (built in the invoices piece), vitest + PGlite, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-contracts-design.md` (approved by Dim 17.10.2026). D1–D7 and §3–§7 are binding.

## Global Constraints

- **Environment.**
  - mslab.ee is staging: run the migration first, then push.
  - Agents never write on mslab.ee.
  - Use local `next dev` against the local Docker `mslab-pg` only (13 migrations; 14 after Task 1).
  - Never `db:seed --target railway`.
- **Copy.**
  - Estonian admin; Estonian + Russian for the student; contract texts in the language she read.
  - Every new text is Draft unless the spec quotes it.
  - Verbatim from the spec: „Olen tutvunud lepingu tingimustega ja nõustun nendega.", „Loe lepingut", „Leping on lisatud.", „Kinnita leping", „Kinnitan", „Asendatud", „Saada leping kinnitamiseks", „Saada koopia õpilasele", „Õpilasel pole kontot — lisa ta Õpilased lehel.", „Kinnitatud elektrooniliselt {date time}, {name} ({e-mail})", „Lepingud", „Kontaktkoolituse leping", „E-koolituse leping (tingimused)", „Näidisleping (PDF)".
  - Russian typography uses ` ` escapes.
- **Placeholders**, exactly: `{nimi}` `{e-post}` `{koolitus}` `{toimumine}` `{hind}` `{ettemaks}`. An unknown `{…}` stays as typed.
- **Frozen means frozen.** A contract row never changes after insert, except `superseded_at` and `sent_at`.
- **Transactions.** A contract is inserted in the same transaction as the act that accepts it:
  - registration submit;
  - e-course settle's paid winner;
  - `acceptTerms`;
  - account „Kinnitan".

  If the contract insert fails, the registration's or the payment's act must still follow its existing rule. Use a savepoint where the outer act must not fail (settle), as the invoice step does.
- **Access and caching.**
  - A student reads only her own contracts, by client id.
  - Admin routes use `withAdmin` and actions use `adminAction`.
  - PDF answers are `private, no-store` with nosniff.
  - pdf-lib is imported lazily.
  - The fonts are traced into every function that renders a contract PDF, **including the public course page's function**, where the registration and cart server actions run (`src/server/actions/public.ts`). Verify in the build's `.nft.json`; bracketed keys trace nothing under Turbopack.
- **Logs** carry ids only.
- **Old Safari:** no lookbehind and no `Object.hasOwn` in browser files.
- **Test plan (standing rule).** Behaviour changes update `app/src/data/testplan.json`: new checks get `"mark": "new"`, changed ones `"redo"`, both with `"markedAt": "deploy"`. Ids never change, and `tests/unit/testplan-file.test.ts` stays green.

## Review Focus

1. **A registration that fails after the contract insert** (a full session, a mail cap). No orphan contract, and no registration without its contract when it succeeds. Task 4 DB test.
2. **Maria edits the e-course text between the cart and the payment.** The contract holds what the cart showed. Task 4 DB test with the snapshot.
3. **Placeholders the live preview and the server fill differently.** For example a session's date format, or the price with VAT. The same function and identical output on both sides. Task 1 unit test on shared fixtures.
4. **„Kinnitan" tapped twice, or Maria asking again while the student accepts.** One current contract, and the old one superseded once. Task 3 DB test (partial unique index).
5. **A student with no account.** She still gets the mailed PDF, and „Saada leping kinnitamiseks" is not offered. Tasks 4 and 5.

---

### Task 1: Data and rules — migration 0013, `src/domain/contract.ts`

**Files:**
- Create: `app/drizzle/0013_contracts.sql` (generated), `app/src/domain/contract.ts`.
- Modify: `app/src/db/schema.ts`.
- Test: `app/tests/db/migration-0013.test.ts`, `app/tests/unit/contract-rules.test.ts`.

**Interfaces (produces):**

```ts
// schema.ts
export const contracts = pgTable("contracts", { id, kind: text().$type<ContractKind>().notNull(), registrationId: …set null, accessId: …set null, courseId: …set null,
  clientId: …set null, paymentId: …set null, version: text().notNull(), locale: text().$type<"et" | "ru">().notNull(), title: text().notNull(), body: text().notNull(),
  fields: jsonb().$type<ContractFields>().notNull(), acceptedAt: timestamp tz notNull, acceptedVia: text().$type<AcceptedVia>().notNull(), sentAt: timestamp tz, supersededAt: timestamp tz, createdAt });
// indexes: contracts_registration, contracts_access, contracts_client; partial unique contracts_current_registration (registration_id) where superseded_at is null and registration_id is not null; same for access_id
// registrations.contractRequestedAt: timestamp tz (nullable); payments.contractSnapshot: jsonb $type<ContractSnapshot | null>
export type Contract = typeof contracts.$inferSelect;

// domain/contract.ts
export type ContractKind = "contact" | "ecourse";
export type AcceptedVia = "form" | "purchase" | "account" | "terms";
export type ContractFields = { school: { company: string; registryCode: string; address: string }; student: { name: string; email: string }; course: string; session: string; price: string; payment: string };
export type ContractSnapshot = { version: string; locale: "et" | "ru"; title: string; body: string };
export const CONTRACT_CONTACT_KEY = "contract_contact";        // pages key
export const CONTRACT_CONTACT_VERSION_KEY = "contractContactVersion";
export const PLACEHOLDERS = ["nimi", "e-post", "koolitus", "toimumine", "hind", "ettemaks"] as const;
export function fillContract(text: string, values: Record<(typeof PLACEHOLDERS)[number], string>): string;   // unknown {x} untouched; no lookbehind
export function contractValues(f: ContractFields, prepayment: string): Record<(typeof PLACEHOLDERS)[number], string>;
export function contractLocale(registeredLocale: "et" | "ru", ruTextExists: boolean): "et" | "ru";
export function sessionText(s: { startsAt: Date; city: string; venue?: string } | null): string;   // "14.11.2026, Tallinn" (Tallinn time), "" for none
export function paymentText(choice: "full" | "half" | null, locale: "et" | "ru"): string;
export function contractFileName(id: number): string;            // "MS-LAB-leping-{id}.pdf"
export function contractDownloadHeaders(id: number): Record<string, string>;
export function schoolOf(invoiceSettings: { company: string; registryCode: string; address: string }): ContractFields["school"];   // empty company → "MS LAB" (spec §6)
```

- [ ] **Step 1: Failing tests.**
  - **`fillContract`:** every placeholder is filled; an unknown `{x}` and a lone `{` stay as typed; a value containing `{nimi}` is not re-filled.
  - **`sessionText`:** handles the Tallinn-time boundary (21:59 vs 22:00 UTC).
  - **`contractLocale`:** RU with no RU text gives et.
  - **`schoolOf`:** an empty company gives "MS LAB".
  - **The migration test:** after 0012 the tables and columns exist. Check each named index: a second current contract for one registration fails on `contracts_current_registration`, and a superseded one then lets a new one in. Deleting a registration keeps the contract with `registration_id` null.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Write the schema, then run `npx drizzle-kit generate --name contracts`.
  - Check the SQL is additive.
  - Migrate the local DB with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/mslab npx drizzle-kit migrate`, which should bring it to 14.
  - Write `domain/contract.ts`. It must be pure and stay browser-safe, because the preview imports it.
- [ ] **Step 4: Run** the tests, tsc and eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): migration 0013 — contracts, registrations.contract_requested_at, payments.contract_snapshot; the contract rules`.

### Task 2: The PDF — `src/server/pdf-text.ts`, `src/server/contract-pdf.ts`

**Files:**
- Create: `app/src/server/pdf-text.ts` (holds `wrap` and `clean`, extracted from `invoice-pdf.ts`; `invoice-pdf.ts` imports them, and its output must not change), `app/src/server/contract-pdf.ts`.
- Modify: `app/src/server/invoice-pdf.ts`, `app/next.config.ts` (font tracing for the public course page's function).
- Test: `app/tests/unit/contract-pdf.test.ts`. `invoice-pdf.test.ts` and `certificate-pdf.test.ts` must stay green and unchanged.

**Interfaces:**
- Consumes: Task 1's types; `drawLogo` (`pdf-logo.ts`); `loadCertificateAssets`.
- Produces: `export async function renderContract(c: Pick<Contract, "title" | "body" | "fields" | "acceptedAt" | "acceptedVia" | "locale" | "supersededAt">, assets: { sans: Uint8Array }): Promise<Uint8Array>`.

**Rules:**
- A4 portrait, white, Jost, the black logo.
- Blocks per spec §5: the title; „Pooled" / «Стороны» (Draft); „Koolitus" / «Обучение»; the paragraphs (split on blank lines); the closing line.
- Multi-page: paragraphs wrap and break across pages, with a page number „{n} / {total}" in the footer.
- A superseded contract prints „Asendatud {date}" under the title.
- Labels are in the contract's locale.
- Deterministic: the PDF dates are `acceptedAt`.

- [ ] **Step 1: Failing tests.** Use `tests/pdf-read.ts`.
  - A contract with 30 paragraphs reads back every paragraph's text in order across ≥ 2 pages.
  - The parties, course, session, price and payment text appear, and so does the closing line with the date and name.
  - An RU contract has the RU labels.
  - A superseded contract shows „Asendatud".
  - The output is deterministic.
  - Nothing falls outside the page bounds.
  - The invoice tests are unchanged and green.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the PDF and the shared text helper.**
- [ ] **Step 4: Tracing.**
  - Add the font tracing for the course page's function (where `src/server/actions/public.ts` runs).
  - Run `npm run build`.
  - Confirm that the nft file of the route serving `/[locale]/koolitused/[slug]` lists `assets/fonts/Jost[wght].ttf`.
  - Extend `tests/unit/next-config.test.ts` with the new key.
- [ ] **Step 5: Run** tsc and eslint, then commit `feat(contracts): the contract PDF — multi-page, the parties and the course frozen; the text helper shared with the invoice`.

### Task 3: The server — `src/server/contracts.ts`

**Files:**
- Create: `app/src/server/contracts.ts`.
- Test: `app/tests/db/contracts.test.ts`.

**Interfaces:**
- Consumes:
  - Task 1's rules and schema;
  - `getInvoiceSettings` (`src/server/invoices.ts`), for the school;
  - `readSetting`/`setSetting`;
  - the pages table;
  - `nextTermsVersion` (`src/domain/course-terms.ts`), as the version pattern.
- Produces:

```ts
export async function contractTemplate(q: Q, kind: ContractKind, locale: "et" | "ru"): Promise<{ version: string; locale: "et" | "ru"; title: string; body: string }>; // contact: contract_contact page, fallback the public "terms" page text (D2); ecourse: course_terms
export async function contractForRegistration(tx: Tx, input: { registrationId: number; clientId: number | null; courseId: number; template: { version; locale; title; body }; fields: ContractFields; prepaymentText: string; via: "form" | "account"; now: Date }): Promise<Contract>;  // supersedes the current one in the same tx; clears contract_requested_at
export async function contractForAccess(tx: Tx, input: { accessId: number; clientId: number; courseId: number; paymentId?: number | null; snapshotOrTemplate: { version; locale; title; body }; fields: ContractFields; via: "purchase" | "terms"; now: Date }): Promise<Contract | null>;  // null when this access already has a current contract of that version
export async function requestContract(db: Db, registrationId: number, now: Date): Promise<{ ok: true } | { ok: false; error: "notFound" | "noAccount" | "cancelled" }>;
export async function contractsOfRegistration(db: Db, registrationId: number): Promise<Contract[]>;   // current first, then superseded
export async function contractsOfClient(db: Db, clientId: number): Promise<Contract[]>;
export async function contractForStudent(db: Db, clientId: number, id: number): Promise<Contract | null>;
export async function contractForAdmin(db: Db, id: number): Promise<Contract | null>;
export async function contractPdf(c: Contract): Promise<Uint8Array>;    // lazy import of contract-pdf.ts
export async function markContractSent(db: Db, id: number, now: Date): Promise<void>;
export async function saveContractTexts(db: Db, raw: unknown): Promise<{ ok: true } | { ok: false; fields: Record<string, string> }>;   // contract_contact page (et/ru title+body), bumps contractContactVersion only on a change
export async function registrationContractFields(q: Q, registrationId: number): Promise<{ fields: ContractFields; prepaymentText: string; locale: "et" | "ru" } | null>;
export async function accessContractFields(q: Q, accessId: number, paymentId?: number | null): Promise<ContractFields | null>;
```

**Rules:**
- **Superseding.** Run it under the registration's row lock (`FOR UPDATE`) or the access row's lock: first mark the current contract superseded, then insert the new one. The partial unique index is the backstop.
- **Asking again.** `requestContract` sets `contract_requested_at`. It requires a linked `client_id` (`noAccount`) and a registration that is not cancelled.
- **The filled text.** The filled title and body are what is stored: `fillContract` runs over the template with `contractValues`.
- **Prices.**
  - Contact: the price is the registration's price via `registrationPrice`, euro-formatted with `euro()` from `domain/invoice.ts`. The payment choice uses `paymentText`, and „Ettemaks" shows `prepaymentDue`.
  - E-course: the price is the paid payment's amount when `paymentId` is set; otherwise it is empty.

- [ ] **Step 1: Failing DB tests.**
  - A registration contract: the fields are frozen, and a later edit of the course title or price does not change it.
  - Asking again, then accepting again: the old contract is superseded and the flag cleared. Two concurrent re-accepts leave one current contract (Review Focus 4).
  - `requestContract` returns `noAccount` when no client is linked.
  - Access contracts:
    - the same version twice gives null the second time;
    - a new version supersedes the old contract;
    - `paymentId` puts the paid amount in `price`.
  - Template fallback: with no `contract_contact` page, the public "terms" text is used.
  - `saveContractTexts` bumps the version only on a change.
  - `contractForStudent` returns null for another client's contract.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, tsc and eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): frozen contracts for registrations and accesses, asked again and superseded under the row's lock`.

### Task 4: The flows — the registration form, the cart, settle, the gate, the mails

**Files:**
- Modify:
  - `app/src/components/site/ContactRegister.tsx` — the box and the inline „Loe lepingut" with the live fill.
  - `app/src/components/site/EcoursePurchase.tsx` — the same.
  - `app/src/app/[locale]/(site)/koolitused/[slug]/page.tsx` — passes the templates.
  - `app/src/server/submit.ts` — the contract inserted in the registration's transaction.
  - `app/src/server/payments/start.ts` — `contract_snapshot` on an e-course purchase.
  - `app/src/server/payments/settle.ts` — the contract in a savepoint beside the grant.
  - `app/src/server/client-data.ts` — `acceptTerms` also freezes the contract; a purchase contract satisfies the gate.
  - `app/src/server/account-mail.ts` — the confirmation, paid and gate mails attach the PDF with „Leping on lisatud.".
  - `app/src/i18n/dict/et.ts`, `ru.ts` — `forms.contractTerms` and `ecourse.contractTerms` replace the shared `forms.terms` for these two forms only; the individual form keeps `forms.terms`.
  - `app/src/data/testplan.json`.
- Test:
  - `app/tests/db/contracts-flows.test.ts`
  - `app/tests/unit/contract-preview-dom.test.ts`
  - The existing submit, payment and terms tests stay green.

**Interfaces:**
- Consumes: Task 3. The fill function from Task 1 runs in the client for the preview.

**Rules:**
- **The preview fill.** The inline preview is filled from the form state: the chosen session's text, the price, and the payment choice's text, using the same helpers as the server. When no session is chosen yet, `{toimumine}` shows „(vali toimumine)" (Draft).
- **Registration submit.** It inserts the contract after the registration, in the same transaction. A failure of the registration rolls back both. A failure of the contract alone also fails the submit: the student sees the generic error and nothing is stored, because a booking without its contract would break D1.
- **E-course purchase.**
  - The purchase start stores `contract_snapshot`: the filled template the cart showed.
  - Settle's paid winner runs `contractForAccess` in a savepoint, with `via: "purchase"` and `paymentId`. If it fails, the payment and the grant still stand, the error is logged, and the gate asks her later (`via: "terms"`).
- **The gate.** A current contract of the current version marks the terms as accepted.
- **Mails.**
  - The confirmation mail (the group registration), the e-course paid mail and the gate (a new short mail „MS LAB leping", Draft) attach the PDF.
  - The e-course paid mail already carries the invoice attachment. The contract is a second attachment.
  - If the PDF fails, the mail is sent without it and a log line is written.
- **The test plan.**
  - New checks: the box and the inline contract on the course page; the confirmation mail with the PDF; the cart's contract; the e-course paid mail with both PDFs.
  - Redo: the registration-form and cart checks; the terms-gate check.

- [ ] **Step 1: Failing tests.**
  - DB:
    - a submit makes a registration and its contract together;
    - a forced contract failure stores neither (Review Focus 1);
    - Review Focus 2: the snapshot survives a text edit between start and settle;
    - a purchase contract satisfies the gate;
    - a gate acceptance freezes one contract.
  - DOM: the preview fills the session, price and payment when chosen, and shows the „(vali toimumine)" placeholder before (Review Focus 3, with Task 1's fixtures).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.**
  - The touched test files, the full vitest, tsc and eslint.
  - The e2e `course forms account-ecourse payments` under `next dev`.
- [ ] **Step 5: Commit** `feat(contracts): the tick she gives is the contract — the form, the cart, settle and the gate freeze it and mail the PDF`.

### Task 5: Maria's side — Seaded „Lepingud", the drawers, ask again, send a copy

**Files:**
- Create:
  - `app/src/components/admin/ContractTexts.tsx` (+ css)
  - `app/src/components/admin/ContractBlock.tsx` (+ css)
  - `app/src/server/actions/admin-contracts.ts`
  - `app/src/app/api/admin/leping/[id]/route.ts`
  - `app/src/app/api/admin/naidisleping/route.ts`
- Modify:
  - `app/src/app/admin/(panel)/seaded/page.tsx` — the card; the e-course card's title becomes „E-koolituse leping (tingimused)".
  - `app/src/app/admin/(panel)/registreerimised/page.tsx` — the block.
  - The client drawer — the list.
  - `app/src/i18n/dict/admin.ts` — `adminEt.contracts`.
  - `app/next.config.ts` — headers and tracing for the new routes.
  - `app/src/data/testplan.json`.
- Test:
  - `app/tests/unit/contract-block-dom.test.ts`
  - `app/tests/unit/contract-texts-dom.test.ts`
  - `app/tests/db/admin-contract-routes.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: the actions `saveContractTextsAction`, `requestContractAction` and `sendContractCopyAction`.
  - `sendContractCopyAction` mails the PDF with a short mail „MS LAB leping" (et/ru, Draft) and sets `sent_at`.

**Rules:**
- **The block.** It shows the current contract (accepted date, the way, „Laadi alla (PDF)", „Saada koopia õpilasele") and the superseded ones („Asendatud {date}").
  - „Saada leping kinnitamiseks" is offered only to a linked, not-cancelled registration. Without an account the drawer shows the spec's no-account text.
  - Once asked, the block shows „Kinnitamist ootab (saadetud {date})" (Draft).
- **The card.** It follows the legal-text editor pattern: ET/RU title and body, „Tühi rida alustab uut lõiku.", a hint listing the placeholders, and „Näidisleping (PDF)" built from the card's current values with a sample student and course, storing nothing.
- **The test plan.** New checks: Seaded „Lepingud" and the sample; the drawer block; asking again; sending a copy. Redo: the Seaded e-course terms check, for its new title.

- [ ] **Step 1: Failing tests.**
  - DOM: the block per state; the card's fields and hint.
  - Routes: 401 without a session; PDF headers; the sample reads the card's values.
  - Actions: errors mapped to Estonian.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, tsc, eslint, and the e2e `admin-clients admin-site admin-invoices`.
- [ ] **Step 5: Commit** `feat(admin): contracts — Seaded's texts, the drawer's „Leping", ask again and send a copy`.

### Task 6: The student's side — the card line, the download, „Kinnita leping"

**Files:**
- Modify:
  - `app/src/server/client-data.ts` — `loadDashboard`: each contact and e-course card gets `contract: { id; acceptedAt } | null` and `contractRequested: boolean`.
  - `app/src/domain/account-cards.ts`
  - `app/src/components/account/AccountCourseCard.tsx`
  - `app/src/server/account-api.ts` — the routes below.
  - `app/src/i18n/dict/et.ts`, `ru.ts`
  - `app/src/data/testplan.json`
- Routes:
  - `GET /api/konto/leping/<id>` → `contractFile`, in the certificate download's order, with rate limit `client-contract-pdf` 10/3600;
  - `GET /api/konto/leping-tekst/<registrationId>` → the current filled text for „Kinnita leping";
  - `POST /api/konto/leping` → `{ registrationId, version }`, which accepts the current text with `via: "account"`. A version mismatch gives 409, as `/api/konto/tingimused` does.
- Test:
  - `app/tests/db/account-contracts.test.ts`
  - `app/tests/unit/account-contract-card-dom.test.ts`

**Rules:**
- **The card line.** A quiet „Leping · kinnitatud {date}" + „Laadi alla (PDF)", or „Kinnita leping" when `contractRequested`.
- **„Kinnita leping".** It opens the filled text on the course card, as a panel (the smallest UI that fits the card), with „Kinnitan".
- **On accept.** The new contract is mailed, and the card switches to the line.
- **Read-only cards.** `readOnly` renders `aria-disabled`.
- **No N+1 queries.** One query in `loadDashboard`'s `Promise.all`.
- **The test plan.** New checks: the card line and the download; „Kinnita leping" after Maria asks; the Russian card.

- [ ] **Step 1: Failing tests.**
  - DB: the dashboard carries the contract per card.
  - Another client's contract → 404.
  - A version mismatch → 409.
  - Accepting supersedes the old contract and clears the flag.
  - DOM: the states.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files, tsc, eslint, and the e2e `account-dashboard account-ecourse account-invoices`.
- [ ] **Step 5: Commit** `feat(account): the student's contract — on her card, the PDF, „Kinnita leping" when Maria asks`.

### Task 7: End to end, docs, spec amendments

**Files:**
- Create: `app/tests/e2e/contracts.spec.ts`.
- Modify: `docs/deploy.md` (new §17 „Lepingud"), `docs/launch-checklist.md` (new §16), the spec (amendments marked "(amended 17.10 during the build)"), `app/src/data/testplan.json` (fixes the e2e shows).

**Rules:**
- **The e2e path**, on local `mslab-pg`, with rows removed by exact id:
  1. Maria writes the contact text with placeholders in Seaded, and „Näidisleping (PDF)" starts with `%PDF`.
  2. A visitor registers with the box ticked. The inline preview shows the chosen session's date.
  3. The registration's drawer shows the contract, and the PDF downloads.
  4. „Saada leping kinnitamiseks" → the student signs in → „Kinnita leping" → „Kinnitan". The old contract shows „Asendatud".
  5. The student downloads her PDF.
  - Widths 390/834/1194/1440 for the form's preview, the drawer block and the card.
  - It uses no Montonio: the purchase contract is covered by Task 4's DB tests.
- **`docs/deploy.md` §17:**
  - what a contract is;
  - when it is made;
  - the frozen copy;
  - the snapshot;
  - the supersede rule and lock;
  - the mails;
  - the log lines;
  - rollback: 0013 is additive, and older code ignores it.
- **The migration note:** Railway is at 13; this deploy applies 0013; the count goes 13 → 14.
- **`docs/launch-checklist.md` §16:**
  - Maria writes „Kontaktkoolituse leping" and reviews „E-koolituse leping (tingimused)";
  - her lawyer or accountant reads one „Näidisleping";
  - test contracts are removed with the test rows, by exact address, before the launch.

- [ ] **Step 1: Write the e2e and run it** under `next dev` and `E2E_PROD_BUILD=1`.
- [ ] **Step 2: Write the docs and the amendments.**
- [ ] **Step 3: Run** the full vitest, tsc and eslint.
- [ ] **Step 4: Commit** `test(e2e): contracts end to end; docs: the runbook's Lepingud and the launch list`.

### Task 8: Railway 0013, merge, push, smoke (controller)

- [ ] **Step 1: Branch checks.**
  - The full vitest, tsc and eslint.
  - `npm run build`, then check that the nft traces of the course page, `/api/payments/notify`, `/api/konto/[[...path]]` and `/api/admin/leping/[id]` list Jost.
  - The e2e `contracts invoices certificate course forms account-ecourse` under dev and `E2E_PROD_BUILD=1`, plus the gate config.
  - `git status` is clean.
- [ ] **Step 2: Railway, read-only.** Using the `rw.env` pattern: 13 migrations, `contracts` absent.
- [ ] **Step 3: Migrate.** Then check: 14 migrations, `contracts` count 0, `registrations.contract_requested_at` and `payments.contract_snapshot` present. Delete `rw.env`.
- [ ] **Step 4: Merge and push.** `node tools/testplan-stamp.mjs`, commit, merge `--no-ff`, push, delete the branch.
- [ ] **Step 5: Smoke.**
  - `/` → 200.
  - `/api/konto/leping/1` → the gate's 404 JSON.
  - `/api/admin/leping/1` → 401.
  - `/api/admin/naidisleping` → 401.
  - A course page → 200.
- [ ] **Step 6: Tell Dim** what Maria sets up (launch-checklist §16), and update the memory.
