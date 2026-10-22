# Instalments („Järelmaks (Inbank)“) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student can pay a contact course or an e-course with Inbank's hire purchase through the existing Montonio checkout. Maria switches it on in Seaded and receives the full price; the site never tracks instalments.

**Architecture:**
- **The choice.** A new payment choice `financing` is offered while Seaded's toggle is on, payments are on, the price is 100–5000 € and nothing has been paid yet. It starts the same Montonio order as today with `payment.method = "hirePurchase"`, the full price, a 60-minute `expiresIn` and the student's `billingAddress`.
- **Method-aware rules.** Seat hold, re-send and late-check windows read the attempt's method from the payment row.
- **After payment.** A paid order settles through today's path; a declined one simply stays PENDING. A loan approved late, after the item was already paid in full, is held for Maria as „Topeltmakse“.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, Drizzle 0.45 + postgres.js (PGlite in tests), vitest 5 + happy-dom, Playwright 1.63 with the fake Montonio (`tests/e2e/fake-montonio.ts`).

**Spec:** `docs/superpowers/specs/2026-10-20-instalments-design.md`. It has Montonio's answers of 22.10 at the top, decisions D1–D8, the edge cases with the calls from the code check in §4, the test plan in §5, and go-live in §7.

## Global Constraints

- **Strings.** Every text below is quoted exactly and marked Draft in the spec. Dim sees them on the test page.
  - Public strings go in `i18n/dict/et.ts` and `ru.ts`, and `tests/unit/i18n.test.ts` keeps the keys identical. Admin strings go in `i18n/dict/admin.ts`.
  - The RU texts are Draft, by the same rule.
  - The ET texts:
    - choice „Järelmaks (Inbank)“;
    - the course page line „Võimalik tasuda ka järelmaksuga (Inbank).“;
    - the out-of-range refusal „Järelmaks on võimalik 100–5000 € hinnaga koolitusele.“;
    - the contract payment sentence „Koolituse hind tasutakse täies ulatuses: järelmaksuga (Inbank) või pangamaksega.“;
    - the return page „Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.“;
    - the buttons „Maksa pangalingiga“, „Proovi uuesti“, „Maksa järelmaksuga (Inbank)“;
    - the cart choices „Pangalink“ / „Järelmaks (Inbank)“;
    - the Seaded card title „Järelmaks (Inbank)“;
    - the invoice paid method „Järelmaks (Inbank)“;
    - the Maksed method label „Järelmaks (Inbank)“.
- **Range.** 100–5000 € is `10_000`–`500_000` cents, inclusive. Seat hold, re-send window and late-check age for a `hirePurchase` attempt are 60 minutes; bank attempts keep 30, 30 and 45 minutes.
- **Montonio fields.** `payment.method` is `"hirePurchase"`; `expiresIn` is `60` (minutes, top level of the order). `billingAddress` holds `{ firstName, lastName, email, phoneNumber?, phoneCountry? }` (spec D8 and §4). Bank orders are unchanged.
- **Migration.** `drizzle/0018_financing.sql` is `ALTER TYPE "public"."payment_choice" ADD VALUE 'financing';`, additive (precedent: `0001_client_accounts.sql:1`). Apply it on Railway before the push (`docs/deploy.md` §6). The settings key `financing` (`{ enabled: boolean }`, default off) needs no migration.
- **Admin guards** (`tests/unit/admin-guards.test.ts`): a new admin action is `export const x = adminAction(...)` in a `"use server"` file.
- **Old iPads.** No regex lookbehind, no `crypto.randomUUID`. A new non-"use client" browser module goes in `BROWSER_FILES` (`tests/unit/old-safari.test.ts`).
- **Test plan.** Every behaviour change marks `src/data/testplan.json` with `new`/`redo`/`reworded` and `"markedAt": "deploy"`, following the `checkPlan` rules. Guards accept "deploy" or an ISO time (the `markedSince` helper in `tests/unit/testplan-file.test.ts`).
- **E-mail addresses.** No real ones anywhere; use `@example.test`.
- **Never** read `app/.env.local`, print secrets, or touch Railway or the live Montonio.
- **Commands** (from `app/`):
  - `npx vitest run <file>`
  - `npx tsc --noEmit --incremental false`
  - `npm run lint`
  - `npm run build`
  - `npx playwright test <spec> --project=chromium --project=mobile` (needs Docker `mslab-pg`)
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A declined application, then a bank payment, then the loan approved late.** The bank payment confirms the place. The late loan is held as „Topeltmakse“ and never counted twice, for a registration and for an e-course alike. (Task 4 tests.)
2. **A bank press while a järelmaks attempt is open, or the reverse.** It starts a new attempt and never re-sends or overwrites the other. (Task 3 tests.)
3. **The price, the toggle or the paid amount changing between booking and paying.** Järelmaks is refused with the range message, or simply not offered. A partly paid registration never gets järelmaks. (Task 3 and Task 6 tests.)
4. **The seat hold at 30 vs 60 minutes, keyed by method, across the daily check.** A järelmaks hold that ended frees the seat; a loan signed later gets the „Täis“ handling. (Task 3 and Task 4 tests.)
5. **Names and phones that don't fit Inbank.** A one-word name, a foreign phone, or a phone typed with spaces or brackets: `billingAddress` is still valid, and only an Estonian phone is sent. (Task 2 tests.)

---

### Task 1: Data, choice rules and texts

**Files:**
- Modify:
  - `src/db/schema.ts:13` (`payChoice` gains `"financing"`)
  - `src/domain/registration.ts:3` (`prepaymentDue`: financing → full)
  - `src/domain/payments.ts` (`DueInput.paymentChoice`, `amountDue`, `METHOD_LABELS` gains `hirepurchase`)
  - `src/domain/invoice.ts` (`PaidMethod` gains `"financing"`, `paidMethodText`; `openAmounts`, `invoiceKindOfPayment` treat financing as full)
  - `src/domain/contract.ts:155` (`paymentText`)
  - every other `"full"|"half"` site listed in the spec's code facts: `registration-card.ts:13`, `account-cards.ts:83,246`, `contract.ts:82`, `account-mail.ts:355,379`, `contracts.ts:179`, `contract-sample.ts:37`, `messages.ts:18,65,76,84`, `client-data.ts:180,321`, `pay-page.ts:60`, `admin/(panel)/registreerimised/page.tsx:209,279,289,325,351`, `i18n/dict/admin.ts:293,310-311`
- Create:
  - `drizzle/0018_financing.sql` (+ journal and snapshot via `npm run db:generate`, renamed to `0018_financing`)
  - `src/domain/financing.ts`
- Test:
  - `tests/db/migration-0018.test.ts`
  - `tests/unit/financing-rules.test.ts`
  - `tests/unit/payments-domain.test.ts`: its `hirePurchase` → „Muu“ expectation becomes „Järelmaks (Inbank)“
  - `tests/unit/contract-rules.test.ts`, `tests/unit/invoice-rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/domain/financing.ts
  export const FINANCING_MIN_CENTS = 10_000; export const FINANCING_MAX_CENTS = 500_000;
  export const FINANCING_KEY = "financing";
  export type FinancingSettings = { enabled: boolean };
  export function readFinancingSettings(value: unknown): FinancingSettings;           // anything but {enabled:true} → off
  export function financingOffered(o: { enabled: boolean; paymentsOn: boolean; priceCents: number | null }): boolean;
  export function financingAllowed(o: { enabled: boolean; paymentsOn: boolean; priceCents: number | null; paidCents: number; dueCents: number }): boolean;
      // offered && paidCents === 0 && dueCents === priceCents
  export function billingAddressOf(o: { name: string; email: string; phone?: string | null }):
      { firstName: string; lastName: string; email: string; phoneNumber?: string; phoneCountry?: "372" };
  export function estonianPhone(raw: string): string | null;                          // national digits, or null
  export const FINANCING_ATTEMPT_MS = 60 * 60_000;
  export function attemptWindowMs(method: string): number;                            // "hirePurchase" → 60 min, else 30 min
  ```
- `PaidMethod` gains `"financing"`, and `paidMethodText("financing")` returns „Järelmaks (Inbank)“.
- `paymentLabel`: `paymentText("financing", "et")` is the contract sentence from the Global Constraints, with a RU Draft.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/financing-rules.test.ts
it("offered only when on, payments on, and 100–5000 € inclusive", () => {
  expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 10_000 })).toBe(true);
  expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 500_000 })).toBe(true);
  expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 9_999 })).toBe(false);
  expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 500_001 })).toBe(false);
  expect(financingOffered({ enabled: false, paymentsOn: true, priceCents: 20_000 })).toBe(false);
  expect(financingOffered({ enabled: true, paymentsOn: false, priceCents: 20_000 })).toBe(false);
  expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: null })).toBe(false);
});
it("allowed only when nothing is paid and the full price is due", () => {
  const base = { enabled: true, paymentsOn: true, priceCents: 29_000 };
  expect(financingAllowed({ ...base, paidCents: 0, dueCents: 29_000 })).toBe(true);
  expect(financingAllowed({ ...base, paidCents: 1_000, dueCents: 28_000 })).toBe(false);
  expect(financingAllowed({ ...base, paidCents: 0, dueCents: 14_500 })).toBe(false);
});
it.each([
  ["Mari Maasikas", ["Mari", "Maasikas"]], ["Anna-Liisa van der Berg", ["Anna-Liisa van der", "Berg"]], ["Madonna", ["Madonna", "Madonna"]],
])("splits %s", (name, [first, last]) => expect(billingAddressOf({ name, email: "a@example.test" })).toMatchObject({ firstName: first, lastName: last }));
it.each([
  ["+372 5123 4567", "51234567"], ["372-5123-4567", "51234567"], ["(+372) 6123456", "6123456"], ["5123 456", "5123456"],
  ["+371 2123 4567", null], ["+44 7700 900123", null], ["12345", null], ["", null],
])("estonianPhone(%s) = %s", (raw, want) => expect(estonianPhone(raw)).toBe(want));
it("billingAddress sends the phone only when Estonian", () => {
  expect(billingAddressOf({ name: "Mari Maasikas", email: "m@example.test", phone: "+372 5123 4567" })).toEqual(
    { firstName: "Mari", lastName: "Maasikas", email: "m@example.test", phoneNumber: "51234567", phoneCountry: "372" });
  expect(billingAddressOf({ name: "Mari Maasikas", email: "m@example.test", phone: "+371 2123 4567" })).toEqual(
    { firstName: "Mari", lastName: "Maasikas", email: "m@example.test" });
});
it("attempt windows: 60 min for hirePurchase, 30 for a bank attempt", () => {
  expect(attemptWindowMs("hirePurchase")).toBe(3_600_000); expect(attemptWindowMs("paymentInitiation")).toBe(1_800_000); expect(attemptWindowMs("")).toBe(1_800_000);
});
it("financing is due in full, like „100% kohe“", () => {
  expect(prepaymentDue(29_000, "financing")).toBe(29_000);
});
```

Also add:
- `paidMethodText("financing")` → „Järelmaks (Inbank)“;
- `paymentMethodLabel("hirePurchase", null)` → „Järelmaks (Inbank)“;
- `paymentText("financing","et")` → the contract sentence;
- the migration test: after 0018, inserting a registration with `payment_choice = 'financing'` succeeds and 'full'/'half' still work.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/financing-rules.test.ts tests/db/migration-0018.test.ts`
Expected: FAIL (module or value missing).

- [ ] **Step 3: Implement**

- **Phone rule** (spec §4): strip spaces, `-`, `(`, `)`, `.`. Then `+372`/`372` followed by 7–8 digits, or 7–8 digits starting `5` or `3`–`8`, is Estonian; return the national digits.
- **Choice sites:** sweep every `"full"|"half"` site above and handle `"financing"` as full where an amount is concerned. Where a label is shown, it is „Järelmaks (Inbank)“ (admin) or the public choice text.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/unit/financing-rules.test.ts tests/db/migration-0018.test.ts tests/unit/payments-domain.test.ts tests/unit/contract-rules.test.ts tests/unit/invoice-rules.test.ts tests/unit/i18n.test.ts && npx tsc --noEmit --incremental false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(financing): the choice, its rules and texts; migration 0018 (payment_choice financing)"
```

### Task 2: The Montonio order for a järelmaks, and the fake

**Files:**
- Modify:
  - `src/server/payments/montonio.ts`: `OrderRequest`; `createOrder` l.272-309; the header comment l.6-23
  - `tests/e2e/fake-montonio.ts`: `orderProblem` l.128-141; `orderToken` l.59-76; the GET answer l.186; the bank page l.48-56
  - `docs/deploy.md:193`: the "paymentInitiation only" note
- Test:
  - `tests/unit/montonio.test.ts`: the `createOrder` claims test l.236-259, plus new cases
  - `tests/unit/montonio-fake.test.ts`: the "another method" case l.108-123

**Interfaces:**
- Consumes: `billingAddressOf` (Task 1).
- Produces: `OrderRequest` gains `method?: "paymentInitiation" | "hirePurchase"` (default `"paymentInitiation"`) and `billing?: BillingAddress`. For `hirePurchase`:
  - the claims carry `payment.method: "hirePurchase"` (and no `methodOptions.paymentDescription` unless Montonio's docs allow it for financing; keep it if allowed, it is harmless);
  - top-level `expiresIn: 60`;
  - `billingAddress`.
- Bank claims are byte-identical to today.
- **The fake** accepts `hirePurchase` and reports `paymentMethod`/`paymentMethodType: "hirePurchase"`.
  - Its pay page for such an order shows „Kinnita laen“ (→ PAID) and „Inbank keeldus“. The second leaves the order PENDING and redirects back with no webhook, as Montonio does.
  - It stores the decoded `billingAddress` and `expiresIn` for assertions (`GET /_fake/orders/<reference>`).

- [ ] **Step 1: Write the failing tests**

  - **`montonio.test.ts`:**
    - a `hirePurchase` order's claims equal today's plus `payment.method: "hirePurchase"`, `expiresIn: 60` and the billing object;
    - a bank order's claims are unchanged (keep the existing `toEqual`).
  - **`montonio-fake.test.ts`:**
    - `hirePurchase` is accepted;
    - `cardPayments` is still refused;
    - the token's `paymentMethod` is `hirePurchase`;
    - „Inbank keeldus“ leaves the status PENDING and sends no webhook.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/montonio.test.ts tests/unit/montonio-fake.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Check Montonio's order docs (`https://docs.montonio.com/api/stargate/guides/orders`) for the exact `billingAddress` keys and `expiresIn` placement, and note the source in a comment.
- Update the header comment and `docs/deploy.md:193`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/unit/montonio.test.ts tests/unit/montonio-fake.test.ts tests/unit/montonio-docs-payloads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(payments): a hirePurchase order with expiresIn 60 and the student's billing details; the fake knows Inbank"
```

### Task 3: Starting a payment with a method

**Files:**
- Modify:
  - `src/server/payments/start.ts`: `StartDeps` l.27; `liveAttempt` l.79-100; `order()` l.115-139; `startRegistrationPayment` l.152; `startEcoursePayment` l.274
  - `src/db/queries/payments.ts`: `NewPayment` l.18-32 gains `method`; `insertPayment`; `CHECK_AFTER_MS` use l.148 becomes method-aware
  - `src/domain/sessions.ts`: `SEAT_HOLD_MS`, `holdUntil(now, ms?)`
  - `src/server/submit.ts`: l.405, l.430, l.556-572
  - `src/server/pay-page.ts` (l.208)
  - `src/server/account-api.ts` (l.1115-1133)
  - `src/server/account-input.ts` (`parsePayStart` l.88)
  - `src/server/forms.ts`: `payment` enum l.57/69 gains `financing`; `ecoursePurchaseSchema` gains `method`
- Test:
  - `tests/db/payments-start.test.ts`
  - `tests/db/payments-ecourse.test.ts`
  - `tests/db/payments-check.test.ts`
  - `tests/unit/forms.test.ts`: its "instalment is not a payment choice yet" test becomes "financing is accepted when offered"

**Interfaces:**
- Consumes:
  - `financingAllowed`, `attemptWindowMs`, `billingAddressOf` and `FINANCING_KEY`/`readFinancingSettings` (Task 1);
  - `OrderRequest.method`/`billing` (Task 2).
- Produces: `startRegistrationPayment(deps, target, opts?: { method?: "paymentInitiation" | "hirePurchase" })` and `startEcoursePayment(deps, { …, method? })`.
  - **Refusals:** `hirePurchase` is refused with a new result `{ kind: "financing" }` (→ the range text) unless `financingAllowed` holds. That checks Seaded's toggle, payments on, the price range, nothing paid, the full price due, and, for a registration, `paymentChoice === "financing"`.
  - **What the start writes:**
    - `payments.method` = the requested method;
    - the seat hold uses `attemptWindowMs(method)`;
    - `liveAttempt` matches the method as well;
    - the late check (`CHECK_AFTER_MS`) waits `attemptWindowMs(method) + 15 min`.
  - **Billing details:** the registration's name, e-mail and phone, or the cart's name and e-mail.
  - **The default** is always the bank. The submit action passes `hirePurchase` when the form's choice is `financing`, and the pay page and account action take a `method` field.

- [ ] **Step 1: Write the failing tests** (`payments-start.test.ts`, with `stubMontonio().state.orders` holding the decoded claims)

```ts
it("a financing registration starts a hirePurchase order for the full price, 60-min hold, billing details", …);
it("hirePurchase is refused with kind 'financing' when off, out of range, partly paid, or the choice was 100%/50%", …);
it("a bank press while a hirePurchase attempt is open starts a new attempt (new row and reference), never re-sends the loan's", …);
it("a re-send of the same method within its window reuses the row; the window is 60 min for hirePurchase, 30 for a bank attempt", …);
it("the late check waits 75 min for a hirePurchase attempt and 45 for a bank one", …);
it("an e-course hirePurchase start: name and e-mail only in billingAddress; refused outside 100–5000 €", …);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/db/payments-start.test.ts tests/db/payments-ecourse.test.ts tests/db/payments-check.test.ts tests/unit/forms.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Read Seaded's toggle inside the start's transaction with `readSetting(tx, FINANCING_KEY)`, so a toggle switched off mid-way refuses new loans.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command, then `npx tsc --noEmit --incremental false`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(payments): start a payment with its method — järelmaks only when allowed; holds and re-sends per method"
```

### Task 4: Settling a järelmaks, and the late loan

**Files:**
- Modify:
  - `src/server/payments/settle.ts`: `paid()` l.207; `alert()`/`lost()` l.181; `outcomeOf` l.379
  - `src/server/invoices.ts`: `issueForPayment` l.452, `markLinkedInvoicePaid` l.470 (`paidMethod: "financing"` when the payment's method is `hirePurchase`)
  - `src/server/messages.ts` („Topeltmakse“ for the late loan; Maria's „Makseviis“)
- Test:
  - `tests/db/payments-settle.test.ts`
  - `tests/db/payments-settle-guards.test.ts`
  - `tests/db/payments-invoices.test.ts`

**Interfaces:**
- Consumes: `payments.method`, which is the start's value and is kept by `detailsOf` unless Montonio reports one.
- Produces:
  - **A late loan:** a `hirePurchase` payment turning PAID while its registration already has `paidCents >= price`, or while the same e-mail already has paid access to the e-course, is set to `held`. It is never added to `paidCents` or re-granted. `alert(…, "double", …)` tells Maria „Topeltmakse“.
  - **The invoice:** a born-paid invoice of a `hirePurchase` payment has `paidMethod: "financing"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a hirePurchase PAID on an unpaid financing registration confirms it like a bank payment (full price, invoice „Järelmaks (Inbank)“)", …);
it("a hirePurchase PAID after a bank payment already paid the registration in full is held, alerted as Topeltmakse, not counted", …);
it("the same for an e-course: a late loan after a paid bank purchase is held and alerted, the access is not granted twice", …);
it("a hirePurchase PAID after its 60-min hold ended on a full session: recorded, „Täis“ notice (today's rule)", …);
it("a declined application (still PENDING) changes nothing; the daily check leaves it pending until Montonio abandons it", …);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/db/payments-settle.test.ts tests/db/payments-settle-guards.test.ts tests/db/payments-invoices.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The already-paid check happens inside the settle transaction, under `lockForPayment`.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(payments): settle a järelmaks; a loan approved after a paid bank payment is held as Topeltmakse"
```

### Task 5: Seaded's toggle

**Files:**
- Create:
  - `src/components/admin/FinancingSettings.tsx` (pattern: `CertificateSettings.tsx`'s own form, status line and `useTransition`)
  - `src/server/actions/admin-financing.ts` (`"use server"`, `saveFinancingSettingsAction = adminAction(...)`)
- Modify:
  - `src/app/admin/(panel)/seaded/page.tsx` (load and render the card after `InvoiceSettings`)
  - `src/server/cache-targets.ts` (`kind: "settings"` part `financing` → course pages and carts)
  - `src/i18n/dict/admin.ts` (`financing.settings`)
- Test:
  - `tests/unit/financing-settings-dom.test.ts`
  - `tests/unit/admin-financing-action.test.ts`
  - `tests/unit/cache-targets.test.ts`

**Interfaces:**
- Produces: the card „Järelmaks (Inbank)“.
  - A checkbox „Paku järelmaksu (Inbank)“ (Draft), with the lead „Lülita sisse, kui Montonio on järelmaksu sinu poele avanud. Hind peab olema 100–5000 €.“ (Draft), and the button „Salvesta“.
  - The action writes `settings.financing = { enabled }` and calls `revalidatePublic({ kind: "settings", parts: ["financing"] })` and `refresh()`.

- [ ] **Step 1: Write the failing tests**

  - The card shows the saved state, saving writes `{ enabled: true }`, and the status says it was saved.
  - The action refuses anything but a boolean.
  - Cache targets: `financing` gives the course pages and the carts.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/financing-settings-dom.test.ts tests/unit/admin-financing-action.test.ts tests/unit/cache-targets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** following the CertificateSettings pattern.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command, then `npx vitest run tests/unit/admin-guards.test.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(admin): Seaded → „Järelmaks (Inbank)“ toggle, off by default"
```

### Task 6: The public choice — contact form, course page, e-course cart, return page

**Files:**
- Modify:
  - `src/components/site/ContactRegister.tsx`: l.142 state; l.427-444 radios; the disabled placeholder goes
  - `app/[locale]/(site)/koolitused/[slug]/page.tsx`: l.160, l.235-300 (the line „Võimalik tasuda ka järelmaksuga (Inbank).“ next to the price when offered; texts to the form)
  - `src/components/site/ELearningBuy.tsx`: the „Vormista järelmaks — tulekul“ placeholder goes
  - `app/[locale]/(site)/ostukorv/cart.tsx` and `EcoursePurchase.tsx`: the choice „Pangalink“ / „Järelmaks (Inbank)“ while offered
  - `src/components/site/PaymentResult.tsx` and `src/server/payments/routes.ts` `handleReturn`: the fragment carries `liik=jarelmaks` for a hirePurchase row; the Draft text and the two buttons
  - `i18n/dict/et.ts`, `ru.ts` (replace `payInstalment`/`payInstalmentNote`, `course.instalmentSoon`/`instalmentNote`; new keys)
  - `src/db/seed-data.ts:346` (the seed FAQ line only; never the live DB)
- Test:
  - `tests/unit/contact-register-pay-dom.test.ts`
  - `tests/unit/ecourse-purchase-dom.test.ts`
  - `tests/unit/payment-result.test.ts`
  - `tests/db/payments-return.test.ts`
  - `tests/e2e/course.spec.ts`: l.17, l.75-80 and l.244-249 (the placeholders)
  - new e2e `tests/e2e/financing.spec.ts`

**Interfaces:**
- Consumes: `financingOffered` (Task 1), the start's `{ kind: "financing" }` (Task 3), and the fake's Inbank page (Task 2).
- Produces:
  - the visible choice and line, only while offered;
  - the out-of-range refusal text at the choice;
  - the return page for a pending järelmaks.

- [ ] **Step 1: Write the failing tests**

  - **DOM:** the form shows three choices when offered and two when not, with no disabled placeholder; picking „Järelmaks (Inbank)“ makes the inline contract's payment sentence the financing sentence.
  - **Cart:** with the choice offered, „Järelmaks (Inbank)“ starts `hirePurchase`.
  - **Return page:** `liik=jarelmaks&tulemus=pooleli` shows the Draft text with „Maksa pangalingiga“ and „Proovi uuesti“.
  - **E2E, contact course at a price within range, toggle on** (a fixture writes the setting):
    1. choose järelmaks → the fake's Inbank page → „Kinnita laen“ → the return shows paid and the registration is confirmed;
    2. a second registration → „Inbank keeldus“ → the return shows the Draft pending text → „Maksa pangalingiga“ → the bank page → paid;
    3. an e-course in the cart with järelmaks.
  - **E2E, phone width:** the same choice is reachable at 390 px.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/contact-register-pay-dom.test.ts tests/unit/ecourse-purchase-dom.test.ts tests/unit/payment-result.test.ts tests/db/payments-return.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The course page and the cart read the toggle through `getSiteSettings()` / `readSetting`. The cart has no settings read today, so add it.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command, then `npx playwright test tests/e2e/financing.spec.ts tests/e2e/course.spec.ts tests/e2e/payments.spec.ts --project=chromium --project=mobile`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(financing): the choice on the course form and in the cart, the course page line, the return page for a pending application"
```

### Task 7: „Maksa“ for a järelmaks registration

**Files:**
- Modify:
  - `src/components/account/AccountCourseCard.tsx` (l.74-77, l.191-194)
  - `src/server/account-api.ts` (`payRegistration`, `Dashboard.payOnline` l.639)
  - `src/server/pay-page.ts` (`loadPayView`, `payPage`, `handlePayPage`) and `src/app/maksa/[token]/route.ts`
  - `src/server/account-mail.ts` (l.355, 379: the amount for a financing registration is the full price)
  - the dicts
- Test:
  - `tests/unit/account-pay-dom.test.ts`
  - `tests/db/account-pay.test.ts`
  - `tests/db/pay-page.test.ts`
  - `tests/db/pay-page-route.test.ts`

**Interfaces:**
- Consumes: `financingAllowed`, and `startRegistrationPayment(…, { method })`.
- Produces: for a `financing` registration that is unpaid and allowed, two buttons, „Maksa järelmaksuga (Inbank)“ and „Maksa pangalingiga“. They post `method=hirePurchase|paymentInitiation`. Otherwise there is one „Maksa“, as today.

- [ ] **Step 1: Write the failing tests**

  - The account card and the pay page show two buttons for an allowed financing registration and one when not allowed (partly paid, toggle off, out of range).
  - Each button starts its method.
  - A bank payment then confirms the place in full.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/account-pay-dom.test.ts tests/db/account-pay.test.ts tests/db/pay-page.test.ts tests/db/pay-page-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(financing): „Maksa“ offers järelmaks again and the bank for an unpaid järelmaks registration"
```

### Task 8: Docs, test plan and the whole run

**Files:**
- Modify:
  - `docs/deploy.md`: a new section "Instalments" covering migration 0018 (additive, migrate first); the toggle stays off until Maria's live Montonio is activated; the sandbox amounts; payouts up to 8 working days
  - `docs/launch-checklist.md`: Maria verifies the company; switch the toggle on after Montonio's live activation; the accountant knows järelmaks payouts arrive separately
  - `src/data/testplan.json`
- Test: everything.

- [ ] **Step 1: Test plan.** Add checks, each `new`/`deploy`, following `checkPlan`:
  - `haldus-seaded-jarelmaks` (the toggle);
  - `avalik-kursus-jarelmaks-rida` (the course-page line);
  - `registreerimine-jarelmaks-kinnitatud` (Dim, sandbox, a price within 100–500 €, demo person 10101010005, SMS 0000, an Estonian phone: approved → confirmed, invoice „Järelmaks (Inbank)“);
  - `registreerimine-jarelmaks-keeldus` (901–1000 €: declined → the pending text → „Maksa pangalingiga“);
  - `ekursus-jarelmaks` (the cart);
  - `haldus-maksed-jarelmaks` (Maksed shows „Järelmaks (Inbank)“).

  Mark `redo` on the payment checks whose choices changed (`registreerimine-montonio-esmane` and the like), and `reworded` on `avalik-ekursus-leht`, whose old placeholder line goes.

- [ ] **Step 2: The whole run**

Run: `npx vitest run && npx tsc --noEmit --incremental false && npm run lint && npm run build`, then `npx playwright test`.
Expected: all pass. Re-run a failing spec alone to tell a flake from a failure, and report both counts.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs(financing): deploy notes, the go-live steps, the test plan"
```
