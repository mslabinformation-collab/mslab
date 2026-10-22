# Final review — feat/instalments (5309649..5514a47)

Reviewer: senior code review (payments, Postgres concurrency). Read-only; no tests run (the suites passed per the ledger).

How the 1 MB diff was read, in passes:
1. Stat and commit list.
2. Server/payments and data: `server/payments/{start,settle,routes,check,montonio}.ts`, `db/queries/{payments,seats}.ts`, `db/schema.ts`, migration 0018 with its journal and test, `domain/{financing,payments,invoice,contract,registration,sessions}.ts`.
3. Invoices and messages: `server/invoices.ts`, `server/invoice-pdf.ts`, `server/messages.ts`, `server/account-mail.ts`.
4. Entry points and UI: `server/{submit,forms,pay-page,account-api,account-input,client-data,site-data,cache-targets}.ts`, `server/actions/admin-financing.ts`, the course page, the cart, `/makse`, Seaded, `ContactRegister`, `EcoursePurchase`, `ELearningBuy`, `PaymentResult`, `AccountCourseCard`, the dictionaries.
5. Tests: the new test names in the db and unit payment tests, the e2e `financing.spec.ts` list and the fake Montonio.
6. Docs and test plan: skimmed for cross-cutting problems only (Task 8 is reviewed separately).

## Strengths

- **Settlement under races holds up.**
  - Every paid path takes its lock before it reads anything. A registration takes lockForPayment. An e-course now takes its purchase's advisory lock, the same lock the start takes, and takes it first.
  - The late-loan check (`paidAlready`) runs inside that transaction, before the conditional UPDATE.
  - Webhook and return arriving together: one wins the `held` update. The other gets `null` and goes to `lost()`. A held row has no `paid_at`, so `lost()` sends no second alert. The once-only alert key (`pay:double:<id>:<uuid>`) also covers the late alert.
  - I traced these orderings and found no path that counts a loan twice or counts it silently:
    - bank then loan;
    - loan then bank;
    - two loans;
    - a re-sent loan whose replaced order is also paid (the existing second-order "Topeltmakse");
    - a renewal past the 30 minutes.
- **The deadlock analysis is right.** The e-course's new advisory-lock-first order is taken only by the start (advisory lock, then its one row) and by the settlement. No path that holds the address lock or an e-course payment row waits for the advisory lock.
- **Seat holds are computed from open attempts.**
  - `releaseHold` is a single conditional UPDATE. It can only end or shorten a hold, never lengthen it, and it reads each attempt's window from its own method.
  - A bank press keeps a longer loan hold (`start.ts:247-251`).
  - A failed first sending of a loan leaves no phantom 60 minutes.
  - Tests cover each of these cases.
- **Method recording.** The narrowed rule is correct (`settle.ts:207-211`): `case when hirePurchaseRow then method else coalesce(Montonio's, stored)`. A card or Apple Pay payment keeps the method Montonio reports. A loan never loses `hirePurchase`: `paid`, `held`, the late hold and `lost` all keep it, and `failed`, `voided` and `refunded` never write the method.
- **Gating is enforced on the server at every entry.** `financingStarts` reads the toggle in the start's own transaction, so all of these refuse the same way:
  - the contact submit;
  - the cart;
  - the `/maksa` POST;
  - the account card;
  - the return page's buttons (they post to `/maksa`).

  The loan needs `paymentChoice === "financing"`, the price in range, nothing paid, and the full price due. The UI flags are only hints.
- **The Montonio payload.**
  - A bank order is byte-identical to before: same keys, same order.
  - A loan order adds `payment.method: "hirePurchase"`, a top-level `expiresIn: 60` and a whitelisted `billingAddress`, with `phoneCountry` only beside `phoneNumber`.
  - The name split and the phone rule match spec §4. Tests cover one-word names, extra spaces, brackets and dashes, and foreign numbers.
- **Migration 0018 is safe to run first.**
  - It is one `ADD VALUE`, which Postgres 18 allows inside drizzle's transaction because nothing uses the value in the same transaction.
  - The running code never writes the new value.
  - The migration test applies it on top of 0017 with existing rows in place.
  - `deploy.md` §21.9 documents the rollback hazard (older code reads `financing` as the 50% choice).
- **Texts.** The Estonian strings match the spec's Draft wording exactly. That includes Maria's three „Topeltmakse“ notes, „Tasutud … · Järelmaks (Inbank)“ (with a PDF test that the font has the middle dot), and the contract sentence (the dictionary and `paymentText` are kept equal).
- **Security.**
  - The new admin action is `adminAction`, takes a strict boolean, and the guard test lists it.
  - `/makse` builds its links only from fragment parts it has validated (the token regex, `isSlug`).
  - The return buttons post same-origin. `/maksa`'s `crossSiteFormPost` accepts `Origin: null` only together with `Sec-Fetch-Site: same-origin`, and `/makse` keeps the default referrer policy, so the Origin is sent.
  - User input reaches Montonio only as JSON claims.
- **Tests on the money paths are thorough.** That covers the start, the late loan, the e-course both ways, the lock-order tests, the 30/60 and 45/75 windows, the hold fallbacks and method preservation. The e2e run covers the approved, declined and toggled-off flows at three widths.

## Issues

### Critical (Must Fix)

None found.

### Important (Should Fix)

**I1. A loan Maria was told to record by hand turns into „Topeltmakse: refund the loan“ when the app records it later.**

- **Where:** `app/src/server/payments/settle.ts:285-288` (the late hold), `:309-313` (its alert) and `:331` (the follow-up the late path skips).
- **What happens:**
  1. The daily check finds a registration's `hirePurchase` order PAID, but settling it throws a non-transient error.
  2. Maria gets „Makse vajab kontrolli“, which tells her to record it by hand at the registration („märgi makse registreeringu juures käsitsi“). She does, so `paid_cents` becomes the price.
  3. When the fault is gone, the webhook retry, the return or the next run settles the row. `paidAlready` now sees the registration paid in full, so the only real payment is held. Maria gets the late-loan note: „Tagasta see Montonio halduses: täielik tagastus tühistab järelmaksu.“
  4. `followUpUnsettled` („Makse on nüüd kirja pandud … eemalda oma käsitsi lisatud summa“) is never sent, because the late path returns before it.
- **Why it matters:** if Maria follows the mail, the student's loan is cancelled. The registration still shows „Kinnitatud“ with the full sum, and Maria has no money. For a bank payment today the same flow ends in the follow-up, which tells her to remove her hand-entered sum.
- **How likely:** rare, because it needs a non-transient settle failure. But the app itself instructs both steps. E-courses are not affected (their check reads payment rows, not hand grants), and registration bank payments are not affected (never held).
- **Fix:** in `paid()`, before treating a registration loan as late, read the KV record `pay:stuck:<id>`, as `followUpUnsettled` does. If Maria was told, take the normal path: record it, then `alertIfOverpaid` and the follow-up, which tells her to remove her own sum. Read the record before the transaction; a KV failure reads as "not told". Add a db test: stuck record set and `paid_cents = price` by hand, then a PAID loan is recorded with the follow-up, not held as Topeltmakse.
- **When:** the toggle ships off, so this can land in the final fix wave before Maria switches it on.

### Minor (Nice to Have)

**m1. The retry link of a loan that ended „katkestatud“ goes to two different places.**

- **Where:** `app/src/components/site/PaymentResult.tsx:65-66, 90-95`.
- **What:** for a registration it is a GET link to `/maksa/<token>`, which shows both buttons. For an e-course it goes to the cart with „Pangalink“ preselected (no `&makse=jarelmaks`). So „Proovi uuesti“ means "pay by bank" there, while on „pooleli“ the same button means Inbank again.
- **Fix:** for an e-course loan, add `&makse=jarelmaks` to the katkestatud retry, or show the two links as on „pooleli“.

**m2. The late-path log line reads awkwardly.**

- **Where:** `settle.ts:311`, `a järelmaks paid after the whole price was, held`. This repeats the deferred minor; it is listed here because `deploy.md` §21.5 quotes the line.
- **Fix:** if the wording changes, change both together.

**m3. Rows created by the start now record `method` from the start.**

- **Where:** `db/queries/payments.ts` NewPayment.method, and `components/admin/PaymentLines.tsx`.
- **What:** a pending or failed bank row now shows „Pangalink“ in Maksed. That is intended (deferred → Task 8). Rows created before the deploy still show an empty cell, so the list is mixed for a while.
- **Fix:** none needed; the test plan check `haldus-maksed-jarelmaks` should say "a row from after the deploy".

## Deferred minors triage

Lines in `progress.md` with "minor (deferred" that were not routed to a task:

**Task 1**
- No test pins +372 followed by 1/2/9: **leave**. The T1 ruling accepts it, and a wrong number is corrected in Inbank's form.
- `attemptWindowMs` trim/case untested: **leave**. Only exact codes are ever written; `isHirePurchase` normalises anyway.
- No drift check between the `PaymentChoice` type and the pgEnum: **leave**. tsc already fails if the enum gains a value the type lacks; the reverse is harmless. A one-line type assertion would be nice.
- `createInvoice` method typed `PaidMethod`: **leave**. It is guarded at runtime by `isManualMethod` (`invoices.ts:202`), so "financing" cannot be marked by hand.
- `00372` prefix → null: **leave**. The phone is left out and she types it in Inbank's form; nothing breaks.
- The old-safari comment "imports nothing": **leave**. `financing.ts` imports `./sessions`, which browser files already import, so it is covered. The comment is cosmetic.

**Task 2**
- The fake's header says billing keys are required (the fake's rule, not Montonio's): **leave**. It is a test double, and the app always sends them.
- `billingClaim` whitelist not pinned by a cast test: **leave**. The `toEqual` claims tests in `montonio.test.ts` pin the output.
- The fake lets a paid loan be flipped: **leave**. Test-only.
- No loan-specific re-send/refund test: **leave**. `payments-start` now covers the 60-minute loan re-send, and refunds do not depend on the method. Montonio's real behaviour on a loan re-send is a sandbox question (Recommendations).

**Task 3**
- Stale "30 minutes" comments at `submit.ts:329-335` and `payments.ts:82-83`: **leave**. Already fixed on the branch: both now say 60 for a järelmaks.
- 45/75 hard-coded: **leave**. Tests pin both values, and `deploy.md` §11.3 says to change them with `expiresIn`.
- New tests use `@example.com`/`.ee`: **leave**. `example.com` is reserved. The single new `@example.ee` is a schema-parse unit test (`forms.test.ts`) that sends nothing.

**Task 4**
- The refund note after refunding a held row speaks of adjusting the counted amount: **fix before deploy**.
  - Every late loan now ends this way. The Topeltmakse mail tells Maria to refund the held loan, and Montonio's refund notice then brings `messages.ts:406`: „Laekunud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja.“
  - That invites her to lower a correct Laekunud summa, and lowering it could unconfirm the student's place.
  - The fix is one condition: a refunded row with `paid_at === null` (it was held, never counted) gets „Seda makset ei pandud kirja: adminis pole vaja midagi muuta.“ (Draft), plus a unit test.
- A held late loan's return page shows the järelmaks pending text: **leave**. The student has been confirmed by her bank payment already, a held bank payment reads the same today, and the late approval usually arrives by webhook, not in her browser.
- Re-pressing a live loan row more than 30 minutes after a bank purchase is held, not renewed: **leave**. Held is the safe side: Maria is told, and a deliberate renewal minutes after buying is unlikely.
- The late alert is sent once only: **leave**. That is the rule for every Topeltmakse (KV record, given back if it reached no one).
- Log line wording at `settle.ts:308`: **leave** (see m2).
- The `lateNotes.bank` type allows an unreachable registration combination: **leave**. It is unreachable because `paidAlready` returns false for a registration's bank row.

**Task 5**
- JS trim vs Postgres btrim whitespace difference: **leave**. Only exact codes are written.
- Checkbox enabled during a pending save: **leave**. The result sets the box to what was stored, and the status line tells the truth.
- `.check` CSS duplicated from InvoiceSettings: **leave**. Cosmetic.

**Task 6**
- (→ ask Dim) The range sentence is also shown when the toggle is off: **leave** for this deploy (the toggle ships off, and switching it off mid-flow is rare). Ask Dim for a second Draft sentence before Maria turns the toggle on. `launch-checklist` §20 already lists it.
- (→ ask Dim) The Russian payment terms are inconsistent: **leave**. They are Draft and go to the native-speaker check (`launch-checklist` §20).
- Optional pay-now button on the contact refusal confirmation: **leave**. The mail's „Maksa“ and the account cover it, and it is rare.
- `admin-site` saveButton `.first()` order-dependent: **leave**. Resolved by Task 8's `seadedSave` (`ac364ab`); the remaining clicks are on other pages.
- New db tests use `@example.com`: **leave**. Reserved domain, no mail sent.

**Task 7**
- `payPage` JSDoc mentions one button: **leave**. Cosmetic.
- 409 re-read edge cases: **leave**. A read failure falls back to the 503 page; nothing is started.
- `loadPayView` reads the toggle for every registration: **leave**. One small read on a page that is not cached.
- No pay-page DB test for the hand-confirmed financing case: **leave**. The T7 ruling covers it, the DOM tests cover the card, and the start's rule is the same function.
- `data-card-pay-ways` has no group label: **leave**. Each button names its way in full; nice-to-have accessibility polish.

## Declined to judge

- Whether Montonio accepts `phoneCountry: "372"` rather than "EE": the T2 ruling; Dim's sandbox check `registreerimine-jarelmaks-kinnitatud` uses an Estonian phone and will show it.
- Whether Montonio lets a PENDING `hirePurchase` order be overwritten by a re-send under the same `merchantReference` („Proovi uuesti“ within 60 minutes): Montonio's behaviour. The `-keeldus` check covers it; if it fails, the student still has „Maksa pangalingiga“.
- Whether the return after a signed loan carries PAID or a brief PENDING (in which case the page offers „Maksa pangalingiga“ to someone who just signed): spec D5's design; a second payment is caught (Topeltmakse or Ülemakse).
- An e-course bank payment after a paid loan: the bank payment is held and refunded, and the student keeps the loan with interest. Spec D5/§4 "the second … Topeltmakse", and the T4 ruling.
- A registration's bank payment after a paid loan is counted, with „Ülemakse“: spec §4 states it explicitly.
- The e-course course page shows the single radio „Maksa kohe — 100% pangalingiga“ beside „Võimalik tasuda ka järelmaksuga (Inbank).“: approved design (spec D4, §4 "the choice is in the cart"; the test plan `avalik-kursus-jarelmaks-rida` expects exactly this).
- The 60-minute seat hold keeps a seat from others for longer: spec D5.
- A loan signed after its hold, on a full session, gets „Täis“ and a refund: spec D5.
- A crafted or stale form stores `paymentChoice = 'financing'` when it was never offered (paid in full by bank afterwards): spec says the form value "is still read"; harmless.
- Rollback reads `financing` as the 50% choice: documented in `deploy.md` §21.9 with the steps to take.
- Maria ticking the toggle before Montonio activates financing on the live store: every loan start fails gracefully (the registration stands, the bank stays). Operational, covered by `launch-checklist` §20.
- Montonio's or Inbank's limits on name length and characters (Cyrillic) in `billingAddress`: outside the spec; a rejection degrades to the bank.
- The confirmation mail shows the bank transfer rows while a loan is pending: pre-existing D6 design; a transfer recorded by hand makes the later loan „Topeltmakse“.
- The daily check asks the first order's uuid after a re-send (`attachOrder` never replaces it): pre-existing, and harmless for loans (they stay PENDING).
- The content of the Task 8 test plan, docs and e2e helper: reviewed separately.

## Recommendations

1. **The final fix wave.**
   - I1: check the stuck record before the late hold, with a db test.
   - The held-row refund note (Task 4 deferred → fix before deploy).
   - Both are small; neither changes anything with the toggle off.
2. **Before Maria turns the toggle on, confirm in the sandbox and write the results into `deploy.md` §21.3:**
   - (a) the token's `paymentMethod` for a loan, though the stored method is authoritative anyway;
   - (b) that `phoneCountry: "372"` is accepted and prefills Inbank's form;
   - (c) that „Proovi uuesti“ re-sends a PENDING loan order without an error;
   - (d) the status on return right after signing.
3. Ask Dim for a toggle-off refusal sentence (Task 6 deferred).
4. Optional: a compile-time assertion that `PaymentChoice` equals `typeof payChoice.enumValues[number]`.

## Assessment

**Ready to merge?** With fixes

**Reasoning:** No critical problems. The settlement, locking, hold, method and gating logic are correct and well tested, and the migration is safe to run first. Two small Maria-facing message fixes should land in the final wave before the toggle can be switched on: I1 (a rare path where the app tells her to refund the only real loan) and the held-row refund note, which every late loan will now produce.
