# Final review — admin UX pass, piece 2 (A screens)

Range: `c062b27..b95bac2` (43 commits, 236 files). Reviewer: final review (opus), read-only. No suites re-run; no worktree needed.

I reviewed in five passes:
1. Money and data: migration 0019, schema, `db/queries/payments.ts`, `server/payments/{start,settle,check,routes,montonio}.ts`, `server/registration-money.ts`, `server/invoices.ts` (issueInTx, issueReceiptInTx, take-back, B11), `domain/invoice.ts`, `db/queries/admin.ts`, `server/admin-clients.ts` (B12), deploy.md §22.
2. Autosave and drafts: the note route and `server/registration-note.ts`, the test-review route and `server/test-review-marks.ts`, `TestReview.tsx`, `protocol-autosave.ts` restoreLost, `useAutosave` and the LeaveGuard/Drawer contract.
3. Each screen's page and queries: Ülevaade, Registreerimised and its drawer, Protokollid, Hindamine and its test page, Õpilased, Maksed, Arved and Päringud.
4. Shared client parts: ListToolbar, MoreMenu, FoldRow, PhoneFold, PillChoice, TabPills, MoneyCard, InvoiceRow, UninvoicedStrip, RequestToggle, RequestTarget, RequestFold, MontonioLink, ExtendAccess, AccessActions, ConfirmPanel usage, Sidebar.
5. Tests, test plan and docs (skim): testplan id and mark diff, BROWSER_FILES, deploy.md, launch-checklist, the spec amendments, and the commit-per-B rule.

I also compared the code with commit `328c9fb`. It came after the review head: eight texts Dim approved on 23.10 (piece2-texts §6, W1–W8b).

## Strengths

- **The money path is sound where it counts.** `addManualPayment` takes `lockForPayment` (session, then registration: the order every payment path uses). It re-reads `paid_cents`, refuses `stale` on any difference and refuses `overRemainder` on the server. It adds through the shared `addRegistrationPayment` (seat check, never un-confirms) and makes the receipt in the same transaction. A missing seller rolls everything back through a thrown `Refused`. A double click, a second tab and a Montonio payment landing all end as `stale`, never as a double add.
- **Receipt undo is capped and never confirms.** `takeBackCents`, `registrationStatusAfterTakeBack` and `receiptTakeBack` are one rule, used on the server and in both panels (drawer and Arved list), so the S3-f panel states what the server will do. An old pre-B4 receipt for venue money that was never recorded cannot take an online payment's money off.
- **B22 is thorough.** `OPEN_ORDER` is used consistently in `unsettled`, `failPayment`, `releaseHold`, `pendingToCheck`, `expireStalePending`, `stillOpen` and the return page. The replace is in the insert's transaction under the registration lock. `updated_at` is left alone, so the seat window and the check age survive. The "replaced" decision in `paidAlready` reads the status under the lock. The loan → bank → loan revive keeps one Inbank application, and a db test pins it.
- **B11 cannot double-bill.** Each payment goes through `catchUpInvoice`, which holds the payment row FOR UPDATE, checks `invoiceOfPayment` and is backed by the unique `invoices_payment` index. "Already" is counted and reported. The preview drops the range when a linked invoice would break it.
- **The lost-text guards are well thought through.** The note route does a compare-and-set on the stored text. The B15 version embeds `submittedAt`, so a save for rewritten answers can never land on the new ones. The send deletes the draft in the review's own transaction, and the drafts go with the client on deletion. `restoreLost` places words box by box and keeps words whose heading has vanished in the notice.
- **Undo guards are stale-safe.** B12 uses a conditional update to the millisecond, and an undo only goes back. Päringud uses the expected state plus xmin.
- **Security is uniform.** Every new route is `withAdmin` (POST only), every new action is `adminAction` with zod or a defensive parse, and every page calls `requireAdmin`. No client file imports a server or db module at runtime: Montonio's Partner URL is computed on the server and passed as a string, and the Raha card gets its payment lines as a server-rendered node.
- **Old browsers are respected.** No lookbehind and no `randomUUID` in `src`. Every new browser module is in `BROWSER_FILES`. The 44 px targets are kept, including the MontonioLink negative-margin trick. MoreMenu keeps inside the viewport with a width cap. The phone send dock carries `data-fab-avoid` and the bottom padding.
- **Counts equal rows.** Each list's pills reuse the list's own WHERE (`FILTER_WHERE`, `registrationWhere`, `invoiceCounts`, `clientCounts`). The overview uses the same predicates as the badges (`NEEDS_CHECK`, `UNINVOICED_PAID`, `openRequestsByKind`).
- **Migration 0019 is safe to run first.** It is additive. `ADD VALUE` runs inside the migrator's transaction (allowed since PG 12) and the value is not used there. Old code never writes it, and the rollback hazard is written down plainly (deploy.md §22 item 2, launch checklist §21).
- **Process discipline held.** B4, B10, B11, B12, B14, B15 and B22 each have their own commit. No test-plan id was removed. Every spec amendment of spec §9 landed.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

**I1. Eight texts Dim approved on 23.10 (piece2-texts §6, commit `328c9fb`) are not in the code at `b95bac2`. Two are mails that tell Maria to do something B4 removed.**

| Text | Where | What it shows now |
|---|---|---|
| W8a | `app/src/server/messages.ts:340` (`stuckPaymentSummary`) | „Kontrolli Montonios ja märgi makse registreeringu juures käsitsi.“ The typed „Laekunud summa“ is gone, so there is nothing to „märkida käsitsi“. Maria will reach for „Lisa laekumine“, maybe without the receipt. |
| W8b | `app/src/server/messages.ts:358` (`recordedAfterAlertSummary`) | „… eemalda oma käsitsi lisatud summa …“. A payment added without a receipt has no undo (spec §10), so she cannot do what the mail asks and the money stays counted twice. „Ülemakse“ does alert, so it is not silent. |
| W1 | `MoneyCard.tsx:80` (uses `registrations.drawer.stale`, `admin.ts:383`) | The status sentence „Staatus muutus vahepeal … salvesta uuesti.“ on the money panel. |
| W2 | `InvoiceRow.tsx:352` | No question: the old sentence where the question should be. |
| W3 | `admin.ts:1042` | „Test on uuesti avatud: katseid jäänud {n}.“, with no student name. |
| W6 | `ExtendAccess.tsx:63,72` | The generic „… Proovi uuesti.“, which never succeeds for a stale undo. |
| W7 | `RequestToggle.tsx:53,60` | The generic „… Proovi uuesti.“, shown after the page has already refreshed. |

- **Why it matters:** the mails reach Maria exactly when money is in doubt. The stale lines mislead at the moment she needs to look again.
- **Fix:**
  - Add W1, W2, W3, W6 and W7 as their own `adminEt` keys and use them for the `stale` refusals (W6 and W7 also in the UndoBar undo's failure path where the error is `stale`).
  - Replace the two sentences in `messages.ts` with W8a and W8b, and update their unit tests.
  - Sweep `tests/` and `testplan.json` for the old strings (Global Constraint "Strings that leave or change").
  - Tick the matching lines off the launch-checklist §21 wording list and the W8b owner note.

**I2. A test-review send can mail an outdated review and delete the other device's marks.** At `app/src/components/admin/TestReview.tsx:190-205`, `send()` checks `auto.conflict` before `await auto.flush()`, never after (deferred item L164).

- **How it happens:** Maria opens the attempt on the laptop before working on it on her phone. On the laptop she types a comment and presses „Saada“. The blur's flush and the send's flush meet a 409 (the phone saved newer marks), but the check has already passed.
- **What follows:**
  - `reviewAttemptAction` stores this screen's verdicts and mails the student.
  - `discardDrafts` deletes the draft that held the phone's marks and comments.
  - The server has no marks-version check on the send, so it cannot catch it.
  - That is lost typed text plus a wrong mail. It needs two devices and a press within the save window, so it is unlikely, but the fix is one line.
- **Fix:** after `await auto.flush()`, read the engine's current state again (a fresh conflict from the snapshot, not the render-time `auto.conflict`). If there is a conflict with stored marks, `setError(adminEt.autosave.conflict)` and return before calling the action. Add a DOM test: the flush answers 409, so no `reviewAttemptAction` call is made.

### Minor (Nice to Have)

**M1. The loan → bank → loan revive does not check its own UPDATE** (`app/src/server/payments/start.ts:280-286`, deferred item L66). The revive `UPDATE … SET status='pending'` has no `.returning()`.
- **What can go wrong:** `held()` (`settle.ts:504`) takes no registration lock. If it settles the replaced row between `liveAttempt`'s SELECT and this UPDATE, the update hits 0 rows but `replaceOlderOrders` still replaces the live bank row, and `order()` then answers "nothing"/"failed". Both orders stay payable and settle (money safe), but the Raha card shows no open order and the student is told there is nothing to pay.
- **Fix:** `.returning({ id: payments.id })`. On 0 rows, skip `replaceOlderOrders` and fall through to a new attempt (or answer "nothing"), with a db test that settles the row first.

**M2. Two doc statements disagree with the code.**
- `docs/deploy.md:639` and `docs/launch-checklist.md:351` say a new order "refused for want of a seat" / "(no seat)" still replaces the older one. In `start.ts` the `hasFreeSeat` refusal returns `full` before the insert, so nothing is replaced. The real case is a new order that Montonio refuses (`order()` → `failPayment` on the new row). Reword both.
- `docs/deploy.md:630` says the B15 drafts are "one for each answer". It is one `content_drafts` row per attempt (`part "marks"`) holding every answer's mark.

**M3. „Lisa {x} · koht kinnitub“ also shows when the session has no free seat** (`app/src/components/admin/MoneyCard.tsx:149-150`). The suffix depends only on reaching 50 %. On a full session where the registration holds no seat (its hold ran out), the card says „vabu kohti 0 / 8“ and the button still promises the seat; the result then says „Koolitus on vahepeal täis …“. The README rule ("only when this payment reaches 50 %") is met literally. Optional: pass `takesSeat` (the page already computes `holdsSeat`) and drop the suffix when `free === 0 && !takesSeat`.

**M4. The B11 result range can overstate when an invoice is made during the batch** (`UninvoicedStrip.tsx:25` `resultLines`; `server/invoices.ts` `createInvoicesForUnbilled`). „Koostatud {n} arvet: {first}–{last}.“ prints the first and last numbers made. If an online payment lands during the walk and takes a number inside that span, the range names one invoice the batch did not make. This is rare (seconds-long window). Optional: return a `consecutive` flag from the walk (compare seqs) and use `manyLinked`'s range-less sentence when it is false.

**M5. On the Arved list, the undo panel of a receipt whose registration was deleted states a money change that will not happen** (`app/src/components/admin/InvoiceRow.tsx:164`). `receiptTakeBacks` skips such receipts, so `takeBackCents` falls back to `v.amountCents` and the panel says „Laekunud summa väheneb {x} €“. The server only cancels (`undoInvoicePaid`: `inv.registrationId !== null`). Fix: when `v.registrationId === null`, give the panel no sum line.

**M6. „Katkesta“ stays live while a ConfirmPanel's action runs** (`app/src/components/admin/ConfirmPanel.tsx:80`, deferred item L133).
- **Where:** RegistrationCancel, the InvoiceRow undo and cancel, and AccessActions revoke and unlock.
- **What happens:** the panel closes, the trigger comes back, and the action still completes (e.g. the registration is cancelled). Maria may believe she stopped it. The result line does appear, so it is not silent.
- **Fix:** in ConfirmPanel, `aria-disabled` plus a no-op on „Katkesta“ and Esc while `busy`, as UninvoicedStrip and SendAll already do by hand. One place fixes all users.

## Deferred minors triage

- **L66, Task 2: `.returning({id})` on the revive.** Fix in the final wave (M1). One line on the money path, and it removes a "nothing to pay" answer with a payable order hidden.
- **L67, Task 2 → Task 16: test-plan step loan → bank → loan.** Done in Task 16 (`haldus-maksed-asendatud`). Nothing to do.
- **L84, Task 3: db test for the take-back cap's unbilled-online-payment leg.** Fix in the final wave. It is a test only, but this leg is what protects an online payment's money from an old receipt's undo, and today only the invoice leg is pinned.
- **L99, Task 4: exact five-name list for the +372 assertion; the "8-digit" comment on a 7-digit case.** Fix in the final wave. Two-minute test hygiene on the B7 phone rule, which is easy to regress.
- **L114, Task 6: the `bare()` euro helper ×5.** Leave. It is duplication with no user effect; worth one helper in piece 3 when these files are touched again.
- **L114, Task 6: the create form reopening after a catch-up.** Leave. It needs the form open while a payment arrives; it is harmless (the form shows the right amounts) and very unlikely.
- **L124, Task 7: protocolIndex heavy for today only (L101).** Leave. A 14-day index at Maria's volume is a few rows; no person is affected.
- **L124, Task 7: plusDays / daysBefore / addDays duplication.** Leave. Three tiny pure helpers, each tested where it is used.
- **L133, Task 8: dead `.editorHead p` CSS.** Fix in the final wave (it is free), or leave; no user effect.
- **L133, Task 8: the „Saada protokoll  uuesti“ double space for an empty first name.** Leave. A registration always has a name, so the case cannot happen through the form.
- **L133, Task 8: a test-plan expect for „← Protokollid“.** Fix in the final wave. The standing rule says the test plan follows the code, and the back link is new behaviour.
- **L133, Task 8: ConfirmPanel busy state on „Katkesta“.** Fix in the final wave (M6). One component, several screens, and a person can misread what happened.
- **L158, Task 11: a page restored by Back posts an old version, which is a conflict (shared with the note).** Leave. No text is lost: the conflict chip and „Taasta minu tekst“ cover it.
- **L158, Task 11: the conflict notice shows no other-device marks.** Leave. It is the piece-wide minimal UI with no approved text, noted in launch checklist §21.
- **L164, Task 11: re-check the conflict after `await auto.flush()` in `TestReview` `send()`.** Fix in the final wave, raised to Important (I2): lost text on the other device plus a wrong mail to a student.
- **L196, Task 15: a `#p-{id}` past the first 50 of its list does not scroll.** Leave. Maria's request volume keeps open and done lists well under 50 per tab. If wanted later, the drawer link could add `?otsi=<email>`.

## Declined to judge

- **Container queries on iOS < 16 (old iPads with iOS 15).** The README mandates them ("Container query 980 → 760 px") and `stackAt980` was already one before this piece. Not a piece-2 regression, and the device versions are unknown.
- **Railway's collation for Cyrillic ILIKE.** PGlite tests pass (`admin-registrations-list.test.ts:70`), but Railway's `LC_CTYPE` cannot be checked read-only. See Recommendations.
- **xmin as the Päringud undo token.** Ruling T15 (no migration allowed). Freezing does not overwrite xmin since PG 9.4, and the window is 8 s.
- **The status pill „Kinnitatud“ confirms without a seat check.** This is existing, accepted behaviour (`seats.ts` comment): Maria's own decision.
- **A replaced order hidden from Raha when the new order is refused.** Ruling T2 concern 5. Money is safe and the case is documented (wording corrected in M2).
- **„Lisa laekumine“ without a receipt has no undo; a cancelled registration cannot be restored.** Spec §10 says these are not changed.
- **B13's restore overwrites the other device's server text.** Spec §9 replaces "newer text is never overwritten" on purpose.
- **Five test-plan checks with reworded cleanup steps keep their old marks.** These are `registreerimine-montonio-esmane`, `-ulejaanud`, `-jarelmaks-kinnitatud`, `-jarelmaks-nupud` and `konto-arve-tuhistatud`. Task 6's "Rule I", accepted at review: the wording change only adds „Jah, tühista“ to a cleanup step, and switching a pending `redo` to `reworded` would revalidate old answers.
- **The B11 panel's `{first}–{last}` preview can shift if another invoice is issued between render and press.** It is a preview; the result line reports the real numbers. The concurrent case is M4.
- **Pre-B22 registrations with two `pending` rows stay as they are until their next start.** Legacy data, transient. A live re-send does not call `replaceOlderOrders`, which is the right call for a re-send.
- **The `undoExtendAccess` ABA case** (extended, then undone and re-extended in another tab, then this tab's undo succeeds). Practically unreachable within the 8 s UndoBar.
- **Paid days with no lower bound** (`addManualPayment`'s `paidOn` may be any past day). The same as „Märgi tasutuks“ today; it is Maria's own entry.
- **`today` in MoneyCard and InvoiceRow goes stale across midnight with the drawer open.** The field refuses tonight's day until a reload; the server is right either way.
- **The invoice buyer, send and "Koosta arve" forms are not leave-guarded.** They are small forms, and this is pre-existing (not autosave editors in this piece).
- **Visual fidelity to the prototypes at pixel level.** Not rendered here. The e2e at 375 px and the listed desktop widths passed, and the per-task reviews checked the frames.
- **The Hindamine row has no course name; the scope select lists every session; „Hinda“ is one button.** Rulings T9, T4 and T12, and they are in the launch-checklist owner notes.
- **The full e2e and vitest results.** Taken as reported (6301 / 919 + 2 cold-start flakes), as instructed.

## Recommendations

1. Final fix wave, in this order:
   - I1, with the string sweep;
   - I2;
   - M1, M6 and M2;
   - the "fix" triage lines above (L84, L99, L133 test-plan and CSS).

   Then stamp the test plan and re-run the testplan tests, as the deploy order says.
2. After the push, add one smoke check on staging: search Registreerimised for „МАРИЯ“ against a lower-case Cyrillic name. This confirms Railway's collation folds Cyrillic case the way PGlite does.
3. Keep deploy.md §22 item 2 (the `UPDATE … 'replaced' → 'pending'` before any rollback) at the top of the go-live notes. It is the one step whose omission loses money silently.

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** Nothing is critical. The money, B22, B11, autosave and security paths are correct and well guarded, and migration 0019 is safe to run before the push. Two Important items should be fixed before the deploy:
- Dim's approved texts are not wired in, notably the two stuck-payment mails that now tell Maria to do something B4 removed.
- The test-review send does not re-check a conflict after its flush, which can mail an outdated review and discard the other device's marks.
