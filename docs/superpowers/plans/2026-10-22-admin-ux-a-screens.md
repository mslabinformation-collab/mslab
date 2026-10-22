# Admin UX pass, piece 2: the A screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design hand-off's §2 daily-work screens A1–A7 (Ülevaade, Registreerimised, Protokollid, Hindamine, Õpilased, Maksed ja arved, Päringud), with the behaviour changes B4 (one money path), B7 (search), B10, B11, B12, B14, B15 and B22, on top of piece 1's components.

**Architecture:** Every screen stays a server page in `app/admin/(panel)/…` with drawers opened by a URL parameter. Piece 1's blocks (`ListToolbar`, `ListEmpty`, `ConfirmPanel`, `UndoBar`, `SaveStatus`, `useAutosave`, `useLeaveGuard`) get their first adopters here; the few shared parts the screens still lack (folded row, „Veel ▾“ menu, pill choice, tab pills, two-row/multi-parameter toolbar, search and name helpers) come first in Task 1. Money changes go through server functions with one transaction each (B4 `addManualPayment`, B22 replaced orders, B11 batch invoices, B12 `extendAccess`); one additive migration `0019` adds `payments.status = 'replaced'` and `payments.check_reason`.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md` (built as designed; §8 item 2 is this piece). The design: `docs/superpowers/specs/admin-ux-pass/handoff/README.md` §2 and §5 (B items), prototypes `… Part 2.dc.html` (A screens, desktop + phone). Texts the design leaves unwritten, **approved by Dim 22.10**: `docs/superpowers/specs/admin-ux-pass/analysis/piece2-texts.md` (S3-a…m, P-1…P-14, §3 reuse, §4 defaults). Code map (21.10, line numbers stale): `analysis/screens.md`, `behaviours.md`, `strings.md`. Piece 1's ledger (deferred items for piece 2): `docs/superpowers/plans/2026-10-21-admin-ux-global-ledger.md`.

## Global Constraints

- **Built as designed.** Layout, behaviour and strings follow the README, then the Part 2 desktop prototype, then the phone prototype, then the notes (spec D1). Where the README gives no columns or layout (e.g. Maksed columns, Arved row meta), take them from the Part 2 desktop prototype and name the frame in the commit message. Quote every string exactly: README, the „Outcome" column of `analysis/strings.md`, or `analysis/piece2-texts.md`. Do not invent text; a text none of these give is a blocker to report, not to write.
- **Strings.** Every admin string lives in `adminEt` (`src/i18n/dict/admin.ts`) and is filled with `fill()` (`src/i18n/format.ts`). Admin text is Estonian only. The one outgoing text (S3-k mail subject) also gets RU in `src/i18n/dict/ru.ts` / `et.ts`. Wording: always „kord“, never „voor“ (README A4).
- **Glossary (README §1.11).** „Katkesta“ steps back; „Tühista …“ cancels a record; „Laadi alla ({PDF|CSV})“; „Sulge“ closes a drawer; back links „← {Lehe nimi}“; „Võta tagasi“ undoes.
- **Piece 1 parts, used as they are** (`components/admin/`): `ConfirmPanel {question, lines?, yesLabel, tone:"danger"|"send", busy?, onYes, onCancel}` (the parent renders it in place of its trigger and refocuses the trigger after); `useUndo().show({text, undo: () => Promise<boolean>})` (8 s); `SaveStatus {status, draft?, compact?, thing?, onShowInvalid?}`; `useAutosave({owner, key, version, fields, save, validate?, label, title?, focusField?})` with `patchSender(url)` and the route helper `autosaveHandler({schema, read, write})` inside `withAdmin`; `ListEmpty {things, filtered, clearHref?}`; `ListRows`; `Drawer` (no header slot: SaveStatus goes in `children`).
- **Look.** Existing tokens (`styles/tokens.css`, G11) and admin colours. The only new colour is `#faf6f8` (selected/linked row). Tap targets ≥ 44 px. Focus ring `2px solid var(--rose)`, offset 2. No motion under `prefers-reduced-motion`. Phone layouts below 760 px of the list card (the shared list-table switch); the admin uses the phone top bar below 900 px viewport (Q3).
- **Old iPads.** No regex lookbehind, no `crypto.randomUUID`. Every new browser module that is not `"use client"` gets a line in `BROWSER_FILES` in `tests/unit/old-safari.test.ts`.
- **Admin guards** (`tests/unit/admin-guards.test.ts`): every admin route is `export const METHOD = withAdmin(…)`; every admin page calls `requireAdmin()`; every `server/actions/admin*.ts` export is `adminAction(…)`. When an action file's export list changes, update the pinned list in that test.
- **Dates.** „Täna“, „today“, date limits and the „Pikenda“ base use the Tallinn date (`tallinnToday`, `startOfDayTallinn`, `endOfDayTallinn`), never UTC.
- **Test plan** (standing rule). Each behaviour change adds or marks checks in `src/data/testplan.json`: `"mark": "new" | "redo" | "reworded"`, `"markedAt": "deploy"` (this overrides an ISO `markedAt` stamped by an earlier deploy). Lines follow `checkPlan`: 1–8 `steps` and `expect`, each ≤ 20 words ending in a full stop; titles no full stop. Never change the `id` of a check that has answers. Run `npx vitest run tests/unit/testplan-file.test.ts tests/unit/testplan-rules.test.ts` after every change to the file. Do not run the stamp tool.
- **Strings that leave or change.** When a dict value changes or goes, sweep `tests/` and `src/data/testplan.json` for the old text in the same task.
- **E-mail addresses.** None real in tracked files; use `@example.test`.
- **Commits.** B4, B10, B11, B12, B14, B15 and B22 are each their own commit (README §5), with the B number in the subject.
- **Commands** (from `app/`): unit/db `npx vitest run <file>`; types `npx tsc --noEmit --incremental false`; lint `npm run lint`; build `npm run build`; e2e `npx playwright test <spec> --project=chromium --project=mobile` (local Docker DB: `docker start mslab-pg`; on CONNECT_TIMEOUT `docker desktop restart` first). Before a task's last commit: its focused tests, `tsc`, `lint`, and the e2e specs it touched.
- **Migration.** This piece adds `drizzle/0019_payments_replaced.sql` (Task 2) and nothing else. Write it with `npm run db:generate`, check the SQL by hand, apply it to the local e2e DB (`npm run db:migrate` with the local URL the e2e setup uses).

## Review Focus

1. **A replaced („Asendatud“) order that is paid after all.** A student can still finish an older Montonio page after starting a new one, and a declined loan stays PENDING for 7 days. Expected: the money is never lost — the replaced row settles (counted, or held with „Topeltmakse — tagasta“ when the registration is already paid in full), the daily check still asks about it, and it still keeps its seat-hold window. (Task 2 db tests.)
2. **„Lisa laekumine“ against a stale screen.** Two tabs, or a Montonio payment landing while the panel is open. Expected: the server re-reads the paid total under the payment lock; a press built on an old total is refused with the stale message and a refresh, and „Muu summa“ above what is left is refused by the server too, not only by the field. (Task 3 db tests.)
3. **Search input.** `%`, `_`, `\`, Cyrillic, upper case, a phone typed as „+372 5123 4567“ or „5123-4567“. Expected: literal matching (escaped), case-insensitive, and a phone found whatever separators were stored or typed (digits compare when the query has ≥ 3 digits). (Task 1 unit tests, Task 4 / 13 / 15 db tests.)
4. **375 px phone.** Drawers, cards, the Raha card with its panel, the „Veel ▾“ menu and the sticky „Saada hinnang“ bar. Expected: no sideways scroll, menus stay inside the viewport, and the sticky bar never covers the last point card or „Üldised märkused“. (e2e at 375×812 in Tasks 5, 6, 10, 12, 13, 15.)
5. **Undo after the world moved.** „Võta tagasi“ on „Pikenda“ after someone extended again, on „Märgi tehtuks“ after the request was reopened elsewhere. Expected: undo restores exactly the value it replaced, or refuses with the stale message — it never overwrites a newer change. (Task 12 and Task 15 tests.)

---

### Task 1: Shared parts for the A screens

**Files:**
- Modify: `src/components/admin/ListToolbar.tsx` (+ its CSS), `tests/unit/list-toolbar-dom.test.ts`
- Create: `src/components/admin/FoldRow.tsx` (+ `.module.css`), `MoreMenu.tsx` (+ css), `PillChoice.tsx` (+ css), `TabPills.tsx` (+ css)
- Create: `src/domain/search.ts`, `src/domain/names.ts`
- Create: `src/components/admin/autosave/constants.ts`; Modify: `autosave/engine.ts`, `protocol-autosave.ts` (re-export, ledger L124)
- Modify: `src/components/admin/Sidebar.tsx` (refetch `/api/admin/margid` when the pathname changes, not when only the query changes — every toolbar keystroke would cost nine queries, ledger L98), `tests/unit/sidebar-dom.test.ts`
- Test: `tests/unit/fold-row-dom.test.ts`, `more-menu-dom.test.ts`, `pill-choice-dom.test.ts`, `tab-pills-dom.test.ts`, `search.test.ts`, `names.test.ts`

**Interfaces:**
- Consumes: piece 1 `ListToolbar` (`placeholder, pills, pillsLabel, scope, countLine`; today one pill row, one scope `{label,name,options,value}` that writes `?name=`).
- Produces:
  - `ListToolbar` props become `{placeholder: string; pillRows?: {label: string; pills: ListPill[]}[]; scope?: ListScope; countLine?: string}` with `ListPill {href, label, count?, current}` unchanged and `ListScope {label: string; value: string; options: {value: string; label: string; href: string}[]}` — choosing an option navigates to its page-built `href` (so one select can set `?koolitus=` or `?toimumine=`); search still writes `?otsi=` (300 ms debounce) and drops `leht`. No page uses the old props (piece 1 ledger), so this is a breaking change with no callers.
  - `FoldRow {title: string; summary: string; count?: number; id?: string; defaultOpen?: boolean; children}` — a `<details data-fold>` whose 52 px summary row shows „▸“ (rotated when open, no rotation under reduced motion), the title, the count and the one-line summary.
  - `MoreMenu {label?: string; items: {label: string; onSelect?: () => void; href?: string; tone?: "danger"}[]}` — button `{label ?? „Veel“} ▾`, `role="menu"` list, opens on click/Enter/Space, closes on Esc / outside click / item choice, returns focus to the button, keeps inside the viewport (flips up / aligns right when needed).
  - `PillChoice {name: string; legend: string; options: {value: string; label: string}[]; value: string | null; onChange(value: string): void; disabled?: boolean}` — native radios styled as pills in a `fieldset`; arrow keys move as radios do.
  - `TabPills {label: string; tabs: {href: string; label: string; count?: number; current: boolean}[]}` — `nav` of pill links, `aria-current="page"` on the current one.
  - `domain/search.ts`: `digitsOf(q: string): string` (all digits), `phoneQuery(q: string): string | null` (`%<digits>%` when the query has ≥ 3 digits, else null). The SQL side compares `regexp_replace(<col>, '[^0-9]', '', 'g') like <phoneQuery>`; text parts keep `containsPattern` from `domain/paging.ts`.
  - `domain/names.ts`: `firstName(full: string): string` (first word, trimmed) and `allative(first: string): string` — S5: +„le“ after a vowel (Latin aeiouõäöüy, Cyrillic аеёиоуыэюя, any case), +„ile“ after anything else.
  - `components/admin/autosave/constants.ts` exports the debounce/retry/keepalive/timeout constants now in `protocol-autosave.ts`; `protocol-autosave.ts` re-exports them unchanged; `engine.ts` imports from `constants.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `names.test.ts`: `allative("Kati") === "Katile"`, `allative("Mari-Liis") === "Mari-Liisile"`, `allative("Anu") === "Anule"`, `allative("Kristjan") === "Kristjanile"`, `allative("Мария") === "Марияле"`, `allative("Олег") === "Олегиле"`, `firstName("  Kati  Kask ") === "Kati"`.
  - `search.test.ts`: `phoneQuery("+372 5123 4567") === "%37251234567%"`, `phoneQuery("5123-4567") === "%51234567%"`, `phoneQuery("ab12") === null`, `phoneQuery("Kati") === null`.
  - `list-toolbar-dom`: two pill rows render under their own labels with `aria-current` on the current pill; choosing a scope option calls `router.replace` (or navigates) with that option's `href`; typing still writes `?otsi=` after 300 ms and removes `leht`.
  - `fold-row-dom`: summary text and count visible while closed; opening shows children; `defaultOpen` opens; `id` lands on the `details`.
  - `more-menu-dom`: Enter opens, Esc closes and focus returns to the button, choosing an item calls `onSelect` and closes, a `tone:"danger"` item carries `data-tone="danger"`.
  - `pill-choice-dom`: clicking a pill calls `onChange` with its value; the checked pill has `aria-checked`/checked radio; `disabled` disables all.
  - `tab-pills-dom`: current tab has `aria-current="page"`; counts render when given.
- [ ] **Step 2: Run them to see them fail** (`npx vitest run tests/unit/names.test.ts tests/unit/search.test.ts tests/unit/list-toolbar-dom.test.ts tests/unit/fold-row-dom.test.ts tests/unit/more-menu-dom.test.ts tests/unit/pill-choice-dom.test.ts tests/unit/tab-pills-dom.test.ts`). Expected: FAIL (modules missing / props changed).
- [ ] **Step 3: Implement** the components and helpers above; in `sidebar-dom`, a change of `?otsi=` alone does not refetch the badges and a change of pathname does; add `domain/search.ts` and `domain/names.ts` to `BROWSER_FILES`. Move the autosave constants (no value changes).
- [ ] **Step 4: Run the tests and `tests/unit/autosave-engine.test.ts`, `protocol-autosave.test.ts`, `old-safari.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): shared parts for the A screens — folded row, Veel menu, pill choice, tab pills, two-row toolbar, search and name helpers`.

### Task 2: B22 — one open Montonio order per registration (migration 0019)

**Files:**
- Create: `drizzle/0019_payments_replaced.sql` (+ journal/snapshot via `db:generate`); Modify: `src/db/schema.ts` (`payStatus` + `'replaced'`, `payments.checkReason: text("check_reason")`)
- Modify: `src/server/payments/start.ts`, `settle.ts`, `routes.ts`, `check.ts`; `src/db/queries/payments.ts` (`unsettled` readers, `pendingToCheck`, `expireStalePending`, `failPayment`, `releaseHold`/`attemptEnds`, `listPaymentsOf`); `src/domain/payments.ts` (labels, `CheckReason`); `src/components/admin/PaymentLines.tsx` (`PAYMENT_TONE`, label); `src/app/admin/(panel)/maksed/page.tsx` (`STATUS_PARAM`/`PARAM_OF` maps only — the screen is Task 13); `src/i18n/dict/admin.ts`
- Modify: `docs/superpowers/specs/2026-10-20-instalments-design.md` (D5/§4: a later start now marks an older open loan or bank row „Asendatud“), `src/server/payments/start.ts` header comment
- Test: `tests/db/payments-start.test.ts`, `payments-settle.test.ts`, `payments-settle-guards.test.ts`, `payments-check.test.ts`, `payments-return.test.ts`, `tests/unit/payments-domain.test.ts`, `tests/unit/payment-lines-dom.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - Status `'replaced'` (label „Asendatud“, muted tone). `CheckReason = "double"`; `checkReasonLabel("double") === "Topeltmakse — tagasta"` (ADM `payments.reason.double`). The column stores the code; the label lives in the dict.
  - `replaceOlderOrders(tx, registrationId: number, keepId: number, now: Date): Promise<number>` in `db/queries/payments.ts` — `UPDATE payments SET status='replaced', updated_at=now WHERE registration_id=$1 AND status='pending' AND id<>$2`, returns the count.
  - `listPaymentsOf(db, {registrationId | clientId, includeReplaced?: boolean})` — replaced rows are left out unless `includeReplaced`.

**Rulings carried (spec silent; record in the ledger):**
- B22 covers registrations only („per registration“); e-course purchases keep today's rules (their late-payment hold now also writes `check_reason='double'`).
- Every new row inserted by `startRegistrationPayment` replaces all older `pending` rows of the same registration, whatever their kind or method — a bank start replaces an open loan application and the reverse (spec §9: „Asendatud“ covers a järelmaks attempt too). This replaces the instalments rule „a bank payment never replaces a loan application“ (tests `payments-start.test.ts` ~633, ~661 are reworded, not deleted). A re-send of the same live row (`liveAttempt`) replaces nothing.
- A replaced row stays payable: `unsettled` accepts `pending | failed | replaced` with `paid_at is null`; `pendingToCheck` and `expireStalePending` treat `replaced` like `pending`; `failPayment` turns a replaced row `failed`; `releaseHold`'s `attemptEnds` keeps counting a replaced row's window (the instalments ruling „a bank press never shortens a longer hold“ stands).
- A replaced row turning PAID: if the registration's `paid_cents >= price` → `held` + `check_reason='double'` + the existing „Topeltmakse“ alert with the second-order sentence; otherwise it is recorded normally (`addRegistrationPayment`, then `alertIfOverpaid` as today). Today's late-loan hold also writes `check_reason='double'`. An amount-mismatch hold keeps `check_reason` null.
- Return page (`routes.ts` outcome map): an unpaid `replaced` row reads as „pooleli“, like `pending`.

- [ ] **Step 1: Write the failing db tests.**
  - start: a registration with a pending bank row; a new start with another amount inserts a row and the old row is `replaced`; a loan start after a pending bank row replaces it; a re-send inside the window (same row) replaces nothing; another registration's pending row is untouched.
  - settle: a replaced row reported PAID on an unpaid registration → `paid`, `paid_cents` grows; a replaced row reported PAID when the registration is already paid in full → `held`, `check_reason = 'double'`, one „Topeltmakse“ alert; a late loan (not replaced) held → `check_reason = 'double'`; an amount-mismatch hold → `check_reason` null.
  - check: `pendingToCheck` returns a replaced row older than its window; `expireStalePending` fails a replaced row older than 14 days.
  - hold: after a loan row is replaced by a bank start, the seat hold still ends at the loan's 60-minute window.
  - return: an unpaid replaced row → outcome „pooleli“.
  - `listPaymentsOf` leaves replaced rows out unless `includeReplaced: true`.
- [ ] **Step 2: Run** `npx vitest run tests/db/payments-start.test.ts tests/db/payments-settle.test.ts tests/db/payments-settle-guards.test.ts tests/db/payments-check.test.ts tests/db/payments-return.test.ts`. Expected: FAIL.
- [ ] **Step 3: Generate the migration** (`npm run db:generate`), check it reads exactly `ALTER TYPE "public"."payment_status" ADD VALUE 'replaced';` and `ALTER TABLE "payments" ADD COLUMN "check_reason" text;`, and add the migration test case next to 0018's (applies on top of 0018 with rows present).
- [ ] **Step 4: Implement** the rulings above; extend every `Record<PaymentStatus,…>` (tsc lists them); `PaymentLines` shows `checkReasonLabel` in place of „Kontrolli Montonios“ when a reason is set (P-8); the registration drawer and the Õpilased drawer call `listPaymentsOf` without `includeReplaced` (README: hidden from the Raha card).
- [ ] **Step 5: Run** the db tests above, `tests/unit/payments-domain.test.ts`, the migration test, `tsc`. Expected: PASS. Apply 0019 to the local e2e DB; run `npx playwright test tests/e2e/payments.spec.ts tests/e2e/financing.spec.ts`.
- [ ] **Step 6: Test plan.** Add `haldus-maksed-asendatud` (new, area `registreerimine`, who dim): start a bank payment for a Proov registration, return without paying, start again with the other amount (or järelmaks) → Maksed „Kõik“ shows the first row „Asendatud“, the drawer's Raha shows only the latest. Mark `registreerimine-jarelmaks-vahepeal-valja` and any check that expects two open rows `redo`.
- [ ] **Step 7: Commit** `feat(payments): B22 — a new online payment marks the older open order „Asendatud“; a replaced order paid later is counted or held as „Topeltmakse — tagasta“ (migration 0019)`.

### Task 3: B4 — one money path: „Lisa laekumine“ on the server

**Files:**
- Create: `src/server/registration-money.ts`
- Modify: `src/server/invoices.ts` (`issue()` → `issueInTx(tx, …)` usable inside a caller's transaction, with an explicit amount and `paidAdds`; `undoInvoicePaid` for receipts), `src/db/queries/admin.ts` (remove `recordRegistrationPayment` if nothing else uses it), `src/server/admin.ts` (remove `savePayment`), `src/server/actions/admin.ts` (remove `saveRegistrationPayment`; add `addManualPaymentAction`), `src/components/admin/RegistrationForms.tsx` (remove the typed „Laekunud summa“ field and its texts)
- Modify: `docs/superpowers/specs/2026-10-16-invoices-design.md` (R10 replaced: undoing a receipt's payment lowers „Laekunud summa“) and the payments spec line on the typed field (spec §9)
- Test: `tests/db/registration-money.test.ts` (new), `tests/db/invoices.test.ts` (~468 R10 test inverted), `tests/db/admin.test.ts` (~52-88 typed-sum tests go), `tests/unit/admin-guards.test.ts` (~143 export list), the three db tests that `vi.mock("@/server/actions/admin", …saveRegistrationPayment…)` (`arved-page`, `feedback-admin-pages`, `payments-admin-pages`)

**Interfaces:**
- Consumes: `lockForPayment(tx, id)` and `addRegistrationPayment(tx, id, cents, now)` (`db/queries/seats.ts`, `db/queries/admin.ts`: adds, seat check, never un-confirms, returns `{registration, course, session, wasConfirmed, full}`), `takeBackRegistrationPayment` (`server/invoices.ts`), `PaidMethod` (`bank | cash | card`), `paidDay`.
- Produces:
  - `addManualPayment(db, input: {registrationId: number; cents: number; paidOn: string; method: PaidMethod; receipt: boolean; expectedPaidCents: number}, now: Date): Promise<ManualPaymentResult>` where `ManualPaymentResult = {ok: true; addedCents: number; paidCents: number; status: RegistrationStatus; confirmedNow: boolean; full: boolean; receiptNumber: string | null} | {ok: false; error: "notFound" | "cancelled" | "invalid" | "future" | "overRemainder" | "stale" | "sellerMissing"}` — one transaction: `lockForPayment` → re-read the registration → refuse `stale` when `paid_cents !== expectedPaidCents` → refuse `overRemainder` when the course has a price and `cents > price − paid` → `addRegistrationPayment` → when `receipt`, issue a „Juba tasutud“ invoice for exactly `cents` with `paidAdds: true`, `paidAt` = `paidOn` (Tallinn day), `method` → all or nothing (a seller missing at press time rolls back with `sellerMissing`, nothing recorded).
  - `addManualPaymentAction(prev, formData)` (adminAction) → `addManualPayment`, then `revalidatePublic({kind: "seats"})` when the status changed, `refresh()`.
  - `undoInvoicePaid` for a receipt (a paid invoice that is not paid online): the invoice becomes cancelled (its number stays) **and** „Laekunud summa“ drops by its amount (never below 0) through `takeBackRegistrationPayment`, which recomputes the status (may go back to „Ootab ettemaksu“). This now holds for receipts made before this piece too (spec §9 replaces R10). A payment request marked paid keeps today's undo (back to unpaid + take back).

**Rulings carried:**
- A course with no price: `overRemainder` is not checked and the status is not recomputed (today's `noPrice` behaviour); the panel offers only „Muu summa“ (Task 5).
- A cancelled registration refuses (`cancelled`); the panel is hidden there (piece2-texts §4).

- [ ] **Step 1: Write the failing db tests** in `registration-money.test.ts`: adding 145 € of 290 € confirms the seat and returns `confirmedNow: true`; adding 100 € stays „Ootab ettemaksu“; a full session adds the money and returns `full: true` with status unchanged; `expectedPaidCents` off by any amount → `stale`, nothing written; `cents` above the remainder → `overRemainder`; `paidOn` tomorrow (Tallinn) → `future`; `receipt: true` makes a paid invoice for exactly `cents` with `paid_adds = true` and returns its number; `receipt: true` with no seller data → `sellerMissing` and `paid_cents` unchanged; cancelled → `cancelled`. In `invoices.test.ts`: undoing a receipt made by `addManualPayment` lowers `paid_cents` by its amount and can return the status to `awaiting_prepayment`; undoing an old receipt (`paid_adds = false`) lowers it too.
- [ ] **Step 2: Run** `npx vitest run tests/db/registration-money.test.ts tests/db/invoices.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `issueInTx` (no behaviour change for its existing callers: `createInvoice`, `catchUpInvoice` and `markInvoicePaid` keep their own transactions and pass the same values as today), `addManualPayment`, the action, the receipt undo; remove `saveRegistrationPayment` / `savePayment` / the typed field and their dict keys; update the guard test's export list and the three `vi.mock` blocks.
- [ ] **Step 4: Run** the two db files, `tests/db/admin.test.ts`, `tests/db/arved-page.test.ts`, `tests/db/payments-admin-pages.test.ts`, `tests/db/feedback-admin-pages.test.ts`, `tests/unit/admin-guards.test.ts`, `tsc`. Expected: PASS. (The drawer UI and its e2e follow in Task 5; until then the drawer shows no way to add money — Tasks 3 and 5 ship in the same push.)
- [ ] **Step 5: Commit** `feat(admin): B4 — one money path: addManualPayment adds, checks the seat and makes the receipt in one transaction; undoing a receipt lowers Laekunud summa`.

### Task 4: A2 Registreerimised — the list (B7 search)

**Files:**
- Modify: `src/app/admin/(panel)/registreerimised/page.tsx`, `registrations.module.css`, `src/components/admin/list-table.module.css` (remove `stackAt980` from this page; the modifier stays for Maksed until Task 13), `src/db/queries/admin.ts` (`RegistrationFilter`, `registrationWhere`, `pageRegistrations`, `countRegistrations`, new `registrationCounts`), `src/i18n/dict/admin.ts`
- Test: `tests/db/admin-registrations-list.test.ts` (new), `tests/unit/list-rows-dom.test.ts` (~161-165, ~192-195), `tests/e2e/admin-list-widths.spec.ts` (Registreerimised in table mode at 1180/1280/1366/1440; ledger L163), `tests/e2e/admin-inbox.spec.ts` (list assertions)

**Interfaces:**
- Consumes: Task 1 `ListToolbar` (two pill rows, href scope), `phoneQuery`, `containsPattern`, `parseSearch`; piece 1 `ListEmpty`, `ListRows`.
- Produces:
  - `RegistrationFilter` gains `search?: string`, `courseId?: number`, `sessionId?: number`; `registrationWhere` matches name, e-mail (ILIKE, escaped) or phone digits (`phoneQuery`) on `registrations`.
  - `registrationCounts(db, filter): Promise<{status: Record<"all" | "ootab" | "kinnitatud" | "tuhistatud", number>; type: Record<"all" | "e" | "k", number>}>` — each pill row counts under the other filters (search, scope and the other row), so a pill's count equals the rows it shows (B9).
  - URL: `?otsi=`, `?koolitus=<courseId>` or `?toimumine=<sessionId>` (mutually exclusive; the scope select's options: „Kõik koolitused ja toimumised“, then each course, then its sessions indented as „{dd.mm.yyyy} {linn}“), `?staatus=`, `?vorm=`, `?leht=`, `?id=` (drawer keeps the list state in `closeHref`).

- [ ] **Step 1: Failing db tests:** search by part of a name, by e-mail, by phone „5123 4567“ matching a stored „+372 51234567“; `%` and `_` match literally; `?toimumine=` limits to one session, `?koolitus=` to one course; status counts with a search applied equal the filtered row counts; type counts likewise.
- [ ] **Step 2: Run** `npx vitest run tests/db/admin-registrations-list.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the query and the page: ListToolbar (placeholder from `strings.md` A2 Outcome; scope select; status pills „Kõik / Ootab ettemaksu / Kinnitatud / Tühistatud“ with counts; form pills with counts); columns exactly „Kuupäev | Nimi ja kontakt (name + phone) | Koolitus ja toimumine | Laekunud („{paid} / {price} €“) | Staatus“; „Liik“, „Modelli abi“ and „Konto“ leave the list (they are in the drawer's details, Task 6). Below 760 px of the card: README phone cards (name + status pill, course, then „{session} · laekunud {x}“), not label rows. Empty states through `ListEmpty` (P-9 nouns). Remove the page's own 980 px rule and `stackAt980`.
- [ ] **Step 4: Run** the db test, `list-rows-dom`, and `npx playwright test tests/e2e/admin-list-widths.spec.ts tests/e2e/admin-inbox.spec.ts`. Expected: PASS (update selectors that read removed columns).
- [ ] **Step 5: Test plan.** Mark `registreerimine-haldus` `redo` (search, scope, pills with counts, five columns); add `haldus-registreerimised-otsing` (new): search by a phone typed with spaces finds the Proov registration; the iPhone row-tap tint line (ledger L181) goes into `haldus-loend-terve-rida` (`redo`).
- [ ] **Step 6: Commit** `feat(admin): A2 Registreerimised list — B7 search over name, e-mail and phone, course and session scope, pills with counts, five columns`.

### Task 5: A2 drawer — header, Raha with „Lisa laekumine“, Staatus ja märkus

**Files:**
- Modify: `src/app/admin/(panel)/registreerimised/page.tsx` (`RegistrationDetail`), `registrations.module.css`, `src/components/admin/RegistrationForms.tsx` (status + note only)
- Create: `src/components/admin/MoneyCard.tsx` (+ css) — the Raha card and its „Lisa laekumine“ panel; `src/app/api/admin/registreering/[id]/markus/route.ts` (PATCH, `autosaveHandler`)
- Modify: `src/server/actions/admin.ts` (status-only action `saveRegistrationStatus` keeps `expected`), `src/i18n/dict/admin.ts`
- Test: `tests/unit/money-card-dom.test.ts` (new), `tests/db/registration-note-route.test.ts` (new), `tests/e2e/admin-inbox.spec.ts` (~170, ~249, ~277, ~376, ~465), `tests/e2e/admin-invoices.spec.ts`, `tests/e2e/invoices.spec.ts` (~60)

**Interfaces:**
- Consumes: Task 3 `addManualPaymentAction` / `ManualPaymentResult`; Task 1 `PillChoice`; piece 1 `SaveStatus`, `useAutosave`, `patchSender`, `autosaveHandler`, `contentVersion` (`lib/version.ts`; `registrations` has no `updated_at`); `PaymentLines` (Task 2: no replaced rows).
- Produces: `MoneyCard {registration: {id, paidCents, priceCents | null, status, cancelled}; session: {taken, capacity} | null; sellerReady: boolean; payments: PaymentRow[]; today: string}`; note route `PATCH /api/admin/registreering/{id}/markus` body `{version, patch: {note}}` (max 2000) → `SaveAnswer`.

**Exact behaviour (README A2 drawer 1–3, piece2-texts S3-a…e, P-2, P-4):**
- Header: status pill, SaveStatus (the note's), ✕ (Drawer's); name (Jost 30); „{course} · {date time} · {city, venue} · {Grupp|Individuaal}“ — no session: P-4; tel and mail links; „Ava protokoll“ for contact courses only.
- Raha (bg `#f6f4f5`, radius 18): „{laekunud} / {hind} laekunud“ (Jost 34); 8 px bar with a marker at 50 %; „Koht kinnitub {pool} juures · vabu kohti {x} / {cap}“ (no session: S3-d line); the online payment lines; the button „Lisa laekumine“ (hidden on a cancelled registration).
- The panel: amount pills by P-2 (missing up to 50 % preselected; the full remainder; „Muu summa“ with a number field — above what is left: field error S3-e, nothing sent); date (today, `max` today); method pills „Pangaülekanne“ (default) / „Sularaha“ / „Kaart“; checkbox „Koosta kviitung (arve „Juba tasutud“)“ checked by default when `sellerReady`, else the S3-c line in its place; submit „Lisa {summa} · koht kinnitub“ (suffix only when this amount reaches 50 % and the seat is not yet confirmed; S3-d form without a session) and „Katkesta“. No price: only „Muu summa“, no cap. Results: README lines, S3-a, S3-b, S3-c refusal; `stale` → `drawer.stale` text + refresh.
- Staatus ja märkus: `PillChoice` „Ootab ettemaksu“ / „Kinnitatud“ (instant save with `expected`; stale → conflict text + refresh; „Salvesta staatus“ goes); textarea „Märkus“ (autosave through the note route, max 2000, hint „Näeb ainult haldus.“, SaveStatus `thing` = „registreerimist“ (P-10), guard label „Märkus“ (P-12)). The note is the first `useAutosave` editor: it registers as a leave-guard source.
- Phone drawer: header, Raha (only the „Lisa laekumine“ button visible until pressed) and status on the first screen.

- [ ] **Step 1: Failing tests.**
  - `money-card-dom`: at 0 of 290 € the pills read „145 € · ettemaks“ (checked) and „290 € · kogu summa“; at 100 € paid „45 € · ettemaks“ and „190 € · ülejäänud summa“; at 150 € paid only „140 € · ülejäänud summa“ (checked); the submit reads „Lisa 145 € · koht kinnitub“ only for the 50 % amount; „Muu summa“ 500 € shows „Summa on suurem kui tasumata osa (290 €).“ and sends nothing; seller missing shows „Kviitungit ei saa koostada: täida Seaded → Arve andmed.“ with no checkbox; a cancelled registration has no „Lisa laekumine“.
  - note route: wrong version → conflict; 2001 chars → invalid; ok → stored, new version.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** as above. Keep `data-` hooks the e2e specs use where the element survives; add `data-money-card`, `data-add-payment`, `data-status-choice`.
- [ ] **Step 4: Run** the unit and db tests, then `npx playwright test tests/e2e/admin-inbox.spec.ts tests/e2e/admin-invoices.spec.ts tests/e2e/invoices.spec.ts` (rewrite the steps that typed „Laekunud summa (€)“ / „Salvesta summa“ / „Salvesta staatus“ to use „Lisa laekumine“ and the status pills), plus a 375×812 check: no sideways scroll with the panel open, and a real-browser leave-guard check (ledger L136): type in „Märkus“ with the network offline, then a menu click, Back and the drawer's ✕ each ask instead of leaving.
- [ ] **Step 5: Test plan.** `registreerimine-pangaulekanne` `redo` (record the bank transfer with „Lisa laekumine“, receipt ticked); `registreerimine-arve-kviitung`, `-kviitung-tagasi`, `-arve-laekunud` `redo` (receipt made with the payment; undo lowers the sum); `haldus-lahkumine-salvestamata` `reworded` (same id; ledger L135: the A2 note, offline, then a menu click, Back and ✕ each ask); new `haldus-lisa-laekumine-alla-poole` (100 € of 290 €: S3-a result).
- [ ] **Step 6: Commit** `feat(admin): A2 drawer — Raha card with „Lisa laekumine“, status pills and an autosaved note`.

### Task 6: A2 drawer — Arved, folded rows, B10 cancel

**Files:**
- Modify: `src/app/admin/(panel)/registreerimised/page.tsx`, `src/components/admin/InvoiceBlock.tsx`, `InvoiceRow.tsx`, `ContractBlock.tsx` (summary line), `src/components/admin/RegistrationForms.tsx` (cancel → ConfirmPanel), `src/i18n/dict/admin.ts`
- Test: `tests/unit/invoice-block-dom.test.ts`, `tests/unit/invoice-row-dom.test.ts` (create if absent), `tests/unit/registration-cancel-dom.test.ts` (new), `tests/db/arved-page.test.ts` (~249 drawer order), `tests/e2e/admin-invoices.spec.ts`, `tests/e2e/admin-contracts.spec.ts`, `tests/e2e/admin-clients.spec.ts` (~602, ~639)

**Interfaces:**
- Consumes: Task 1 `MoreMenu`, `FoldRow`; piece 1 `ConfirmPanel`; existing invoice actions; `cancelRegistration` action.
- Produces: `InvoiceRow` actions: visible „Saada õpilasele“ (hidden on cancelled, paid online and „Tagastatud“) and „Laadi alla (PDF)“; `MoreMenu` with „Muuda saajat“, „Märgi tasutuks“, „Tühista arve“ (P-11 ConfirmPanel), „Võta tasumine tagasi“ (S3-f ConfirmPanel) as today's conditions allow. `InvoiceRow` is shared with the Arved list (Task 14).

**Exact behaviour (README A2 drawer 4–6, S3-f, S3-g, P-3, P-11):**
- Arved: the existing rows with the actions above; only one „Koosta arve“ button — the unbilled online payment's row button when one exists, otherwise the generic one.
- Folded rows (`FoldRow`, 52 px, „▸“) with P-3 summaries: Leping, Tagasiside, „Registreerimise andmed“ (the details list, now holding „Liik“, „Modelli abi“, „Konto“). Phone: invoices and the contract are folded rows too.
- „Tühista registreerimine“ (danger) → ConfirmPanel: question `Kas tühistan registreerimise: {name}?`, lines per S3-g (each only when true), „Jah, tühista“ / „Katkesta“. After cancelling: today's result text and the public seat freed.

- [ ] **Step 1: Failing DOM tests:** a paid-online invoice shows no „Saada õpilasele“; a „Tagastatud“ one neither; „Veel ▾“ lists exactly the allowed actions per state; with an unbilled online payment there is one „Koosta arve“; the cancel panel lists the seat line only with a session, the money line in its three forms, and always „Õpilasele kirja ei saadeta.“.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the DOM tests, `tests/db/arved-page.test.ts`, and `npx playwright test tests/e2e/admin-invoices.spec.ts tests/e2e/admin-contracts.spec.ts tests/e2e/admin-clients.spec.ts`. Expected: PASS.
- [ ] **Step 5: Test plan.** `registreerimine-tuhista` `redo` (ConfirmPanel lines); `registreerimine-arve-*` drawer checks that name moved actions `reworded` („Veel ▾“); `registreerimine-arve-tagastatud` `redo` (no „Saada õpilasele“); `registreerimine-leping-plokk` `reworded` (folded row).
- [ ] **Step 6: Commit** `feat(admin): B10 — „Tühista registreerimine“ asks with ConfirmPanel; A2 drawer invoices under „Veel ▾“ and folded rows`.

### Task 7: A1 Ülevaade

**Files:**
- Modify: `src/app/admin/(panel)/page.tsx`, `overview.module.css`
- Create: `src/db/queries/overview.ts`
- Modify: `src/db/queries/admin.ts` (`listAdminSessions` gains `to?: Date` if absent), `src/i18n/dict/admin.ts`
- Test: `tests/db/overview-queue.test.ts` (new), `tests/db/assessment-admin.test.ts` (~46, ~53 render `Overview()`), `tests/e2e/admin-inbox.spec.ts` (~94: tiles, `[data-inbox]`, Kiirlingid go), `tests/e2e/completion.spec.ts` (~487 `[data-overview-assessment]` goes), `tests/e2e/protocols.spec.ts` (~117-122 `[data-today-session]`)

**Interfaces:**
- Consumes: `protocolIndex(db, now)` (`db/queries/protocols.ts`: `{id, startsAt, course, place, students, sent, drafts}`; „alustamata“ = students − sent − drafts), `getAdminCounts`, `assessmentQueue`, `UNINVOICED_PAID` and `NEEDS_CHECK` (`db/queries/payment-checks.ts`, counted apart), `listAdminSessions`, `TestplanCard`.
- Produces: `overviewQueue(db, now): Promise<OverviewQueue>` with `OverviewQueue = {awaiting: {count: number; oldest: {at: Date; name: string} | null}; assessment: {count: number; practical: number; test: number; triesUsed: number}; requests: {count: number; byKind: Record<RequestKind, number>}; unbilled: {count: number; oldest: {at: Date; name: string} | null}; reviews: {count: number; oldest: {at: Date; name: string} | null}; check: {count: number; oldest: {at: Date; name: string} | null; reason: CheckReason | null}}` (the `check` reason is the oldest row's).

**Exact behaviour (README A1, P-1):** heading date eyebrow + „Tere, {name}.“ (the button goes); one dark „Täna“ card per session today („TÄNA {HH:MM} · {city, venue}“, course in Jost 28, „{n} õpilast · protokollid: {a} saadetud, {b} mustand, {c} alustamata“, „Ava protokollid →“ to `?sessioon=`); „Sinu järjekord“ rows (Jost 30 count, 600 label, muted 13 px hint, „→“, min-height 64; zero rows hidden) in README order with README targets and P-1 hints; the empty state „Järjekord on tühi.“ / „Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.“; „Tulevased koolitused“ with „järgmise 30 päeva jooksul: {n}“, rows to `/admin/kalender?id=`, seat count red at 0 (admin sessions, cancelled left out); TestplanCard unchanged; tiles, the assessment card, the Päringud card and Kiirlingid removed. Phone: Täna → queue → upcoming. Ruling: „Arveta makset“ targets `/admin/arved#arveta` — the anchor arrives in Task 14 (same push).

- [ ] **Step 1: Failing db tests:** `overviewQueue` counts each source and returns the oldest awaiting registration with its name; a Muutmine request counts under `requests`; unbilled and check are counted apart (a held row counts under `check`, not `unbilled`); a voided-after-paid row counts under `check`; reviews oldest by `writtenAt`. At 23:30 UTC the day before, a session at 00:30 Tallinn time counts as today.
- [ ] **Step 2: Run** `npx vitest run tests/db/overview-queue.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the query and the page.
- [ ] **Step 4: Run** the db tests and `npx playwright test tests/e2e/admin-inbox.spec.ts tests/e2e/completion.spec.ts tests/e2e/protocols.spec.ts`. Expected: PASS.
- [ ] **Step 5: Test plan.** `kontakt-tana` `redo` (Täna card counts); `registreerimine-haldus` already redo — mention the queue row „Ootab ettemaksu“; new `haldus-ulevaade-jarjekord` (each non-empty row opens its list; the empty state).
- [ ] **Step 6: Commit** `feat(admin): A1 Ülevaade — Täna card, „Sinu järjekord“, upcoming 30 days`.

### Task 8: A3 Protokollid — the protocol screen (B13)

**Files:**
- Modify: `src/app/admin/(panel)/protokollid/page.tsx` (back link), `src/components/admin/ProtocolScreen.tsx`, `ProtocolSend.tsx`, `protocol-autosave.ts` (a `restoreLost()` method), `src/i18n/dict/admin.ts`
- Modify: `docs/superpowers/specs/2026-10-12-protocols-design.md` (spec §9: „Saada kõigile ({n})“; „Taasta minu tekst“ writes the local copy back)
- Test: `tests/unit/protocol-screen-dom.test.ts`, `protocol-send-dom.test.ts`, `protocol-autosave.test.ts`, `tests/e2e/protocols.spec.ts`, `protocols-autosave.spec.ts`, `tests/e2e/protocols.ts` (helper)

**Interfaces:**
- Consumes: Task 1 `firstName`, `allative`; piece 1 `SaveStatus`, `ConfirmPanel`; the protocol engine's statuses (`saved{at} | checking | pending | saving | retrying | tooLong | signedOut | gone`) and `entry.conflict.lost`.
- Produces: `protocolSaveStatus(engineStatus, conflict): AutosaveStatus` (pure, in `components/admin/protocol-status.ts`, browser file) mapping `pending → dirty`, `retrying → retry`, `tooLong → invalid{fields:[…]}`, conflict → `conflict`, others by name.

**Ruling carried:** the protocol screen keeps its own engine (`protocol-autosave.ts`) — README A3 asks for the SaveStatus chip, the labels, the ConfirmPanel and B13, and „everything else stays unchanged“. Its `beforeunload` stays (ledger L170).

**Exact behaviour (README A3, S5, P-5):** back link „← Protokollid“ to `/admin/protokollid`; per-student send „Saada protokoll {eesnimi}le“ (no confirmation), after a sent protocol was changed „Saada protokoll {eesnimi}le uuesti“; send-all button „Saada kõigile ({n})“ (n = will receive), ConfirmPanel question „Kas saadan {n} protokolli?“ with the existing summary lines, „Jah, saada {n} protokolli“ / „Katkesta“ (the opener is replaced while the panel shows); the chip is `SaveStatus`; the conflict notice gains „Taasta minu tekst“, which writes the lost text back into the fields and saves it.

- [ ] **Step 1: Failing tests:** the send label for „Kati Kask“ is „Saada protokoll Katile“ and for „Kristjan“ „Saada protokoll Kristjanile“; the resend label; „Saada kõigile (3)“ opens a ConfirmPanel with „Kas saadan 3 protokolli?“ and the summary lines; `protocolSaveStatus` maps every engine status; „Taasta minu tekst“ puts the lost note back and schedules a save; the e2e `data-save-status` assertions move to the SaveStatus kinds (`retry` instead of `retrying`).
- [ ] **Step 2: Run** the unit tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests and `npx playwright test tests/e2e/protocols.spec.ts tests/e2e/protocols-autosave.spec.ts tests/e2e/protocols-race.spec.ts`. Expected: PASS.
- [ ] **Step 5: Test plan.** `kontakt-lukusta-koik` `redo` (title and steps: „Saada kõigile ({n})“, ConfirmPanel; keep the id); `kontakt-protokoll-saada` `reworded` (label); new `kontakt-protokoll-taasta` (two tabs, conflict, „Taasta minu tekst“ brings the text back and saves).
- [ ] **Step 6: Commit** `feat(admin): A3 protocol screen — SaveStatus, „Saada protokoll {eesnimi}le“, „Saada kõigile ({n})“ with ConfirmPanel, B13 „Taasta minu tekst“`.

### Task 9: A4 Hindamine — tabs and one queue

**Files:**
- Modify: `src/app/admin/(panel)/hindamine/page.tsx`, `src/app/admin/(panel)/tunnistused/page.tsx` (same tabs), `src/db/queries/assessment.ts` (`TriesUsed` gains `at: Date`; new `assessmentList`), `src/components/admin/ReopenTest.tsx` (ConfirmPanel), `src/i18n/dict/admin.ts`
- Test: `tests/db/assessment-queue.test.ts`, `tests/db/certificate-admin.test.ts` (~187 „Väljastatud tunnistused“ + `data-to-register` go), `tests/unit/test-review-dom.test.ts` (~243-302 ReopenTest), `tests/e2e/completion.spec.ts`, `tests/e2e/certificate.spec.ts` (~192)

**Interfaces:**
- Produces: `assessmentList(db): Promise<AssessmentItem[]>` where `AssessmentItem = {kind: "practical" | "test" | "triesUsed"; at: Date; name: string; course: string; accessId: number; attemptId?: number; best?: number; attempts?: number; round?: number}`, oldest first.

**Exact behaviour (README A4 tabs and queue, P-6, P-13):** tab pills „Ootab hindamist {n}“ (`/admin/hindamine`) and „Tunnistused“ (`/admin/tunnistused`) on both pages; „Väljastatud tunnistused“ goes; one list oldest first, rows „{name} · {praktiline töö | testi vastus | katsed otsas}“ + meta (P-6 for tries used), actions „Hinda“ (ink, practical → `/admin/protokollid?ligipaas=`), „Vaata“ (test → `/admin/hindamine/test?id=`), and for tries used „Testi katsed“ + „Ava test uuesti“ (ConfirmPanel, P-13: today's question and line split at the „?“, yes unchanged, „Katkesta“); empty „Hindamist ootavaid töid pole.“; after reopening, focus goes to the next row (or the heading) with a status line (ledger L99).

- [ ] **Step 1: Failing tests:** `assessmentList` merges the three sources oldest first with a date on tries-used rows; ReopenTest shows the ConfirmPanel and „Katkesta“ returns focus to „Ava test uuesti“.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx playwright test tests/e2e/completion.spec.ts tests/e2e/certificate.spec.ts`. Expected: PASS.
- [ ] **Step 5: Test plan.** `ekursus-test-uuesti` `redo` (ConfirmPanel); `ekursus-tunnistused` `reworded` (tab „Tunnistused“); `ekursus-hinda-praktiline` `reworded` (one list).
- [ ] **Step 6: Commit** `feat(admin): A4 Hindamine — tabs and one queue, „Ava test uuesti“ with ConfirmPanel`.

### Task 10: A4 practical work — „Kinnita kõik“, informed send, point cards

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-ecourse-completion-design.md` (spec §9: „Saada hinnang“ is the informed button with no panel, plus „Kinnita kõik“)
- Modify: `src/components/admin/AssessmentScreen.tsx`, `AssessmentStage.tsx`, `AssessmentSend.tsx`, `Assessment.module.css`, `ProtocolScreen.tsx` (the access branch's layout hooks only), `src/app/admin/(panel)/protokollid/page.tsx` (`?ligipaas=` header), `src/i18n/dict/admin.ts` („voor“ → „kord“ in `assessment.screen.errors.newRound` and any other)
- Test: `tests/unit/assessment-screen-dom.test.ts`, `verdict-taps.test.ts`, `tests/e2e/completion.spec.ts` (~252, ~288, ~336, ~422, ~460)

**Interfaces:**
- Consumes: `verdict-taps.ts` (each tap POSTs to `/api/admin/hinnang`), `PhotoViewer`, piece 1 `SaveStatus`.

**Exact behaviour (README A4 practical, D1 outcome for „, 0 paranda“, P-12):** header „← Hindamine“, H1 the student, a meta line, SaveStatus; action bar „{n} punkti · {k} hinnatud“, „Kinnita kõik“ (every unset point to approved, each through `verdict-taps`), the send button „Saada hinnang · {k} kinnitatud, {p} paranda“ (drop „, 0 paranda“ when p = 0) with no confirmation panel — it keeps today's refusals (a „Paranda“ without a comment); point cards in a 3-column grid (1 on a phone): photo 260 px (full width on a phone, tap opens PhotoViewer), title (Jost 19), a segmented verdict (Kinnitatud `#2f5d46` filled, Paranda `#8a3b3b` filled; tapping the pressed one clears it), a comment box that opens by itself on Paranda, „Lisa märkus“ otherwise; „Üldised märkused“ below; on a phone the send bar sticks to the bottom and the page gets bottom padding equal to the bar so nothing is covered.

- [ ] **Step 1: Failing tests:** „Kinnita kõik“ sets only unset points and sends one tap each; the label drops „, 0 paranda“; no confirmation panel opens; tapping the pressed verdict clears it; Paranda opens the comment box; no „voor“ in `adminEt`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests and `npx playwright test tests/e2e/completion.spec.ts`, with a 375×812 check that the last card and „Üldised märkused“ can be scrolled clear of the sticky bar.
- [ ] **Step 5: Test plan.** `ekursus-hinda-praktiline`, `-praktiline-paranda`, `-lopeta` `redo` (Kinnita kõik, informed send without a panel).
- [ ] **Step 6: Commit** `feat(admin): A4 practical work — point cards, „Kinnita kõik“, „Saada hinnang · {k} kinnitatud, {p} paranda“ without a panel`.

### Task 11: B15 — test-review marks on the server

**Files:**
- Create: `src/app/api/admin/testi-hinnang/[attemptId]/route.ts` (PATCH, `autosaveHandler`)
- Modify: `src/components/admin/TestReview.tsx`, `src/server/test-attempts.ts` (`reviewAttempt` discards the draft after sending), `src/i18n/dict/admin.ts`
- Test: `tests/db/test-review-route.test.ts` (new), `tests/unit/test-review-dom.test.ts` (~96-241), `tests/e2e/completion.spec.ts`

**Interfaces:**
- Consumes: `content_drafts` through `server/drafts.ts` (`readDrafts`, `saveDraftPart` — numeric versions; send them as strings, ledger L144), `autosaveHandler`, `useAutosave`, `SaveStatus`.
- Produces: draft key `entity "test_review"`, `entity_id = attemptId`, `part "marks"`, value `{submittedAt: string; marks: Record<questionId, {verdict: "ok" | "fix" | null; comment: string}>}`; a draft whose `submittedAt` differs from the attempt's is ignored (the student sent a new attempt).

**Exact behaviour (README A4 test review, B15):** marks autosave to the server (SaveStatus, `thing` „katset“ P-10); tapping a pressed verdict clears it; the send label „Saada · {õ} õige, {v} vale“; the localStorage copy is gone (the autosave engine keeps its own local copy); after „Saada“ the draft is deleted.

- [ ] **Step 1: Failing tests:** route stores marks and answers a new version; a stale version → conflict; marks for another `submittedAt` are not returned; the screen restores marks from the server on reload; re-tap clears; label counts.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx playwright test tests/e2e/completion.spec.ts` (a mark survives a reload in another browser context).
- [ ] **Step 5: Test plan.** `ekursus-test-oige`, `-paranda`, `-kinnita` `redo` (marks saved; open on the phone, the marks are there).
- [ ] **Step 6: Commit** `feat(admin): B15 — test-review marks autosave to the server`.

### Task 12: A5 Õpilased (B12 „Pikenda“)

**Files:**
- Modify: `src/app/admin/(panel)/opilased/page.tsx`, `src/components/admin/ClientDrawer.tsx`, `ClientForms.tsx`, `src/server/admin-clients.ts` (`clientDetail`: completedAt, attempt id for „Hinda“, counts; `extendAccess`; list counts), `src/server/actions/admin-clients.ts` (`extendAccessAction`; `addStudent` keeps list params in its redirect), `src/domain/client-access.ts` (`extendBase`), `src/i18n/dict/admin.ts`
- Test: `tests/db/admin-clients.test.ts` (list counts, `extendAccess`), `tests/unit/admin-clients.test.ts` (`extendBase`), `tests/unit/client-drawer-dom.test.ts` (create if absent), `tests/unit/admin-unlock-dom.test.ts`, `tests/e2e/admin-clients.spec.ts` (~244 search, ~319)

**Interfaces:**
- Consumes: Task 1 `ListToolbar`, `MoreMenu`, `FoldRow`; piece 1 `ConfirmPanel`, `useUndo`; `addMonths`, `tallinnToday`, `endOfDayTallinn`, `grantExpiry` limits.
- Produces:
  - `extendBase(expiresAt: Date, now: Date): Date` = the later of `expiresAt` and the end of today in Tallinn (piece2-texts §4); +1/+3/+6 kuud = `addMonths(extendBase(...), n)`.
  - `extendAccess(db, {accessId: number; until: Date; expected: Date}, now: Date): Promise<{ok: true; previous: Date; until: Date} | {ok: false; error: "notFound" | "revoked" | "stale" | "date"}>` — conditional UPDATE `expires_at = until WHERE id = accessId AND expires_at = expected AND revoked_at IS NULL`; `date` when `until` is not later than today's end or beyond `grantExpiry`'s 10 years; leaves `granted_by/granted_at`, `completed_at`, `extra_tries` untouched.
  - Undo = `extendAccess({accessId, until: previous, expected: until})` (refuses `stale` if changed meanwhile; the undo's own date check allows a `previous` in the past).

**Exact behaviour (README A5, S3-h, S3-i, P-7, P-13):**
- List: ListToolbar (search as you type over name and e-mail; „Otsi“ goes), form pills with counts; „Lisa õpilane +“ in the header opens the inline form (e-mail + „Lisa õpilane“; typo guard as today); the „Koolitusi“ explanation becomes the column header's `title` and `aria-describedby`.
- Drawer header: name, tel, mail, „Konto loodud … · Keel … · Uudiskiri: …“ as one line.
- „Koolitused“: one list, accesses and registrations newest first; card: kicker (form · date/city; P-7 kicker for an individual registration), title, state pill („Avatud kuni {date}“ / „Läbitud {date}“ / „Ligipääs lõpetatud {date}“ / S3-h `Ligipääs lõppes {date}` / registration status; a completed course shows „Läbitud“ even if it also ran out), the progress line (P-7), actions: e-course — „Hinda“ when work waits (practical → `/admin/protokollid?ligipaas=`, test → `/admin/hindamine/test?id=`), „Pikenda ▾“ (+1 kuu / +3 kuud / +6 kuud / „Kuupäev…“ with S3-i; hidden on an access an admin ended; menu title per S3-h for a run-out one) applying at once with the UndoBar „Ligipääs pikendatud kuni {date}.“, „Veel ▾“ with „Ava järgmine õppetund“ (ConfirmPanel), „Testi katsed“, „Vaata tema vaadet“, „Lõpeta ligipääs“ (ConfirmPanel); registration — „Ava registreering“, „Ava protokoll“.
- Folded rows with counts: „Ava ligipääs e-koolitusele“ (the grant form; select text „{course} · mustand · avatud kuni {date}“), Maksed, Lepingud, Päringud, Tagasiside.

- [ ] **Step 1: Failing tests:** `extendBase` for an open access is its end, for one that ran out is today's end; `extendAccess` refuses a revoked access, a stale `expected`, a date not after today; undo restores the previous end; undo after a second extension refuses `stale`; `grantedBy` unchanged; list counts per form pill under a search; the drawer card shows „Läbitud {date}“ for a completed course, „Ligipääs lõppes {date}“ for a run-out one, and no „Pikenda“ on a revoked one.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** (B12 is its own commit: the server function, action and the „Pikenda ▾“ menu first; then the rest of A5.)
- [ ] **Step 4: Run** the tests and `npx playwright test tests/e2e/admin-clients.spec.ts` (+ a 375×812 check of the drawer and the menus).
- [ ] **Step 5: Test plan.** `konto-opilased` `redo` (search as you type, no „Otsi“); `ekursus-ligipaas-ava`, `-ava-jargmine`, `-lopeta` `redo` (folded row, „Veel ▾“, ConfirmPanel); new `ekursus-ligipaas-pikenda` (+1 kuu, then „Võta tagasi“ restores the date).
- [ ] **Step 6: Commits** `feat(admin): B12 — „Pikenda ▾“ extends an e-course access at once with undo` and `feat(admin): A5 Õpilased — toolbar, inline add, one „Koolitused“ list, folded rows`.

### Task 13: A6 Maksed (B14)

**Files:**
- Modify: `src/app/admin/(panel)/maksed/page.tsx`, `payments.module.css`, `src/components/admin/list-table.module.css` (remove `stackAt980` entirely), `src/db/queries/payments.ts` (`pagePayments` filter + search, `paymentCounts`), `src/domain/payments.ts` (`montonioOrderUrl`), `src/i18n/dict/admin.ts`
- Test: `tests/db/payments-admin-pages.test.ts`, `tests/db/payments-admin.test.ts`, `tests/e2e/payments.spec.ts` (~217), `tests/e2e/admin-inbox.spec.ts` (~297, ~376), `tests/e2e/admin-list-widths.spec.ts` (Maksed at 1180/1280/1366/1440)

**Interfaces:**
- Consumes: Task 1 `TabPills`, `ListToolbar`, `phoneQuery`/`containsPattern`; Task 2 statuses and `checkReasonLabel`; `NEEDS_CHECK`.
- Produces: `PaymentFilter = "all" | "makstud" | "pooleli" | "ebaonnestunud" | "tagastatud" | "kontroll"` where `kontroll` = `NEEDS_CHECK` (held, or failed with `paid_at`) and `ebaonnestunud` = failed with `paid_at is null` (each row in exactly one pill; B9), `replaced` only under „Kõik“; `paymentCounts(db, {search}): Promise<Record<PaymentFilter, number>>`; search over name, e-mail, `provider_uuid` and `reference`; `montonioPartnerUrl(): string` — the Partner System home (`https://partner.montonio.com`, or `https://sandbox-partner.montonio.com` while the sandbox keys are in use; one place, next to the API bases in `server/payments/montonio.ts`). **Dim 22.10:** Montonio has no page for one order (Rempire finding 24.09: only Orders → search by the id), so „Montonios ↗“ opens the Partner System in a new tab **and copies the order id at the same press**; a polite status line „Montonio id kopeeritud.“ (Dim-approved text) confirms. If the clipboard is refused, the link still opens and the id stays readable in the link's `title`.

**Exact behaviour (README A6 Maksed, B14, P-8):** tabs „Maksed“ | „Arved“ (also on the Arved page); ListToolbar with the Maksed placeholder S3-m; pills with counts, „Tühistatud pangas“ counted under „Ootel kontrollil“; columns as the Part 2 desktop prototype draws them (README silent; D1); each row links to the registration drawer (`/admin/registreerimised?id=`) or, for an e-course payment, the student (`/admin/opilased?id=`, P-8 `Ava õpilane →` where a text is needed); the Montonio id becomes „Montonios ↗“ (`montonioPartnerUrl()`, new tab, `rel="noopener"`, copies the id; „Montonio id kopeeritud.“); held and voided rows keep the tint and get a 3 px `#9e8993` left border on the phone; a held row with a reason shows „Topeltmakse — tagasta“ in place of „Kontrolli Montonios“; a replaced row shows „Asendatud“.

- [ ] **Step 1: Failing db tests:** a voided-after-paid row is under `kontroll` and not under `ebaonnestunud`; counts equal the filtered rows under a search; search by Montonio uuid and by reference; `replaced` appears only under `all`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (B14 as its own commit: the filter and counts; then the screen).
- [ ] **Step 4: Run** the db tests and `npx playwright test tests/e2e/payments.spec.ts tests/e2e/admin-inbox.spec.ts tests/e2e/admin-list-widths.spec.ts`.
- [ ] **Step 5: Test plan.** `registreerimine-maksed` `redo` (tabs, search, counts, row link, „Montonios ↗“); `haldus-maksed-jarelmaks` `reworded` (pill names unchanged, „Tühistatud pangas“ now under „Ootel kontrollil“).
- [ ] **Step 6: Commits** `feat(admin): B14 — „Tühistatud pangas“ counts under „Ootel kontrollil“` and `feat(admin): A6 Maksed — tabs, search, pills with counts, row links, „Montonios ↗“`.

### Task 14: A6 Arved (B11 batch invoices)

**Files:**
- Modify: `src/app/admin/(panel)/arved/page.tsx`, its CSS, `src/server/invoices.ts` (`createInvoicesForUnbilled`, `unbilledPreview`, list search, month list), `src/server/actions/admin-invoices.ts` (`createInvoicesForUnbilledAction`), `src/components/admin/InvoiceCatchUp.tsx` (doc „No bulk button“ goes), `src/i18n/dict/admin.ts` (`invoices.uninvoiced` „ükshaaval“ text per strings.md Outcome)
- Modify: `docs/superpowers/specs/2026-10-16-invoices-design.md` (B11 replaces „No bulk button“)
- Test: `tests/db/invoices.test.ts` (catch-up ~555+), `tests/db/arved-page.test.ts`, `tests/unit/admin-invoices-action.test.ts`, `tests/e2e/admin-invoices.spec.ts` (~202)

**Interfaces:**
- Consumes: `catchUpInvoice(db, paymentId, now)` (own transaction each; `CatchUpResult` ok | notFound | sellerMissing | already | notPaid), `uninvoicedPaymentRows`, `invoiceCard` (next number), Task 6 `InvoiceRow`, Task 1 `TabPills`, `ListToolbar`, `FoldRow`.
- Produces: `unbilledPreview(db, now): Promise<{ids: number[]; first: string; last: string} | null>`; `createInvoicesForUnbilled(db, ids: number[], now): Promise<{made: string[]; already: number; failed: string[]; sellerMissing: boolean}>` — walks `ids` (the list the panel showed) oldest first, one `catchUpInvoice` each; a payment billed meanwhile counts as `already`; `failed` holds payer names.

**Exact behaviour (README A6 Arved, B11, S3-l, P-8):** strip `id="arveta"`: „Arveta maksed: {n}“ + summary, „Näita ▸“ / „Peida ▾“ expanding today's per-row list, and „Koosta {n} arvet“ → ConfirmPanel „Kas koostan {n} arvet? Iga arve saab oma numbri ({first}–{last}). Õpilastele neid ei saadeta.“ / „Jah, koosta {n} arvet“ (n = 1 forms and results per S3-l; seller missing: the existing line in place of the button); ListToolbar searches number, name and e-mail (S3-m Arved placeholder); the month is a select applying on change (options „Kõik kuud“ and each month that has invoices, newest first; „Näita“ goes); the header button „Laadi alla (CSV) · {kuu aasta}“ follows the visible month. **Ruling:** with no month chosen the list shows the current month (the CSV always has a month to name); „Kõik kuud“ stays a choice, and while it is chosen the CSV button names the current month. Pills with counts; rows: number + state tag | name · course + meta | amount | actions (Task 6 `InvoiceRow`).

- [ ] **Step 1: Failing tests:** three unbilled payments → three invoices with consecutive numbers matching the preview; one billed between preview and press → `already: 1`; seller missing → `sellerMissing` and none made; the list defaults to the current month; search by invoice number.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (B11 as its own commit).
- [ ] **Step 4: Run** the tests and `npx playwright test tests/e2e/admin-invoices.spec.ts`.
- [ ] **Step 5: Test plan.** `registreerimine-arveta-maksed` `redo` („Koosta {n} arvet“); `registreerimine-arved-loend` `redo` (month select on change, no „Näita“); `registreerimine-arved-csv` `reworded` (label names the month).
- [ ] **Step 6: Commits** `feat(invoices): B11 — „Koosta {n} arvet“ bills every unbilled payment` and `feat(admin): A6 Arved — strip, search, month select, rows`.

### Task 15: A7 Päringud

**Files:**
- Modify: `src/app/admin/(panel)/paringud/page.tsx`, its CSS, `src/db/queries/admin.ts` (`pageRequests` with search across kinds and the done fold, `requestCounts`), `src/components/admin/RequestToggle.tsx` (UndoBar), `src/i18n/dict/admin.ts`, `src/i18n/dict/et.ts`, `ru.ts` (S3-k subject)
- Test: `tests/db/admin.test.ts` (~143 handled toggle), `tests/db/admin-requests.test.ts` (new), `tests/unit/request-card-dom.test.ts` (new), `tests/e2e/admin-inbox.spec.ts` (~418, ~513, ~563), `tests/e2e/admin-clients.spec.ts` (~602 Muutmine)

**Interfaces:**
- Produces: `pageRequests(db, {kind?: RequestKind; search?: string; handled: boolean; page: number})` (search ignores `kind` and returns rows of every kind); `requestCounts(db): Promise<Record<TabKey, number>>` (open requests per tab, as the badge counts them); `requestFacts(kind, payload): string` (S3-j, pure, browser-safe); `replySubject(locale, title): string` (S3-k).

**Exact behaviour (README A7, S3-j, S3-k, P-9, P-14):** ListToolbar search across all tabs (placeholder „Otsi nime, e-posti või telefoni järgi“; results carry their tab tag); tab pills with open counts; „Kontakt“ includes e-learning interest tagged „E-õppe huvi“; cards in a 2-column grid (1 on a phone): name (Jost 20) + „{date} · {lang} · {email}“, type tag, the message, the facts line (S3-j), „Märgi tehtuks“ (instant, UndoBar „Märgitud tehtuks.“; undo sets it open again and refuses if it changed meanwhile) and „Vasta e-kirjaga ↗“ (`mailto:` with `subject` = S3-k, URL-encoded); waitlist cards add „Ava toimumine →“ (`/admin/kalender?id={session}`), Muutmine cards „Ava registreering →“; done requests in the fold „Tehtud ({n})“ at the bottom with „Märgi tegemata“ (no UndoBar, P-14); `id="p-{id}"` on each card: a link to `…?liik={tab}#p-{id}` scrolls to the card and highlights it (`#faf6f8` for 2 s, none under reduced motion; a target inside the fold opens it). Muutmine payloads have no `locale`: take the registration's.

- [ ] **Step 1: Failing tests:** search finds a Praktika request from the Kontakt tab by phone digits; counts are open counts; the facts lines for Individuaal, Praktika, Ootenimekiri, Muutmine per S3-j (empty parts dropped); the subject for RU reads „Ответ на ваш запрос — {title}“ and falls back to „MS LAB“; „Märgi tehtuks“ then „Võta tagasi“ reopens; undo after another tab reopened and closed it refuses.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx playwright test tests/e2e/admin-inbox.spec.ts tests/e2e/admin-clients.spec.ts` (+ 375×812 card grid).
- [ ] **Step 5: Test plan.** `registreerimine-paringud` `redo` (all five tabs incl. Muutmine, search, „Märgi tehtuks“ + „Võta tagasi“, the fold); `kirjad-paring` `redo` (the reply subject).
- [ ] **Step 6: Commit** `feat(admin): A7 Päringud — search across tabs, card grid with facts line, UndoBar, „Tehtud ({n})“ fold, deep links`.

### Task 16: Docs, test-plan sweep and the full run

**Files:**
- Modify: `docs/deploy.md` (new section 22: migration 0019 additive, migrate first; what each screen changed; the money-path change and R10's replacement; B22 behaviour for Maria), `docs/launch-checklist.md` (Maria's first walk of the new screens; the Montonio link), `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md` (§7 numbering note: 0019), `src/data/testplan.json`
- Test: `tests/unit/testplan-file.test.ts`, `testplan-rules.test.ts`, the full suites

- [ ] **Step 1:** Sweep `tests/` and `src/data/testplan.json` for every removed or changed string of Tasks 1–15 (`grep` each old dict value); fix leftovers.
- [ ] **Step 2:** Write deploy.md §22 and the launch-checklist lines; check every claim against the code (function names, migration SQL, windows).
- [ ] **Step 3:** Run `npx vitest run` (all), `tsc`, `lint`, `npm run build`, and the full e2e (`npx playwright test`); a flake must pass alone, and any test that fails twice is a finding.
- [ ] **Step 4: Commit** `docs(admin): piece 2 — deploy notes, launch checklist, test plan sweep`.
