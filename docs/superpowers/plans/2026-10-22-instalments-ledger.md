# Instalments (järelmaks) — build ledger (rulings and deferred items)

Copied from the SDD workspace when the build finished (22.10.2026). Every `Ruling:` line is a decision taken during the build on Dim's behalf; the whole-branch review triaged every `minor (deferred)` line (fix before deploy or leave, with reasons) — the fixes landed in the final fix wave. The review reports are summarised in the last lines.


Spec: docs/superpowers/specs/2026-10-20-instalments-design.md (Montonio's answers 22.10, calls c7a19a0). Branch feat/instalments from main 5309649 (main checkout). Dim: "You can proceed" (22.10).

## Pre-flight scan

| Tasks | Shared | Produces → consumes | Found / ruling |
|---|---|---|---|
| T1 → T2,T3,T4,T6,T7 | domain/financing.ts | financingOffered/Allowed, billingAddressOf, attemptWindowMs, FINANCING_KEY | consistent |
| T2 → T3,T6 | montonio.ts OrderRequest.method/billing; fake Inbank page | consistent |
| T3 → T4,T6,T7 | start(…, {method}); payments.method; {kind:"financing"} | consistent |
| T1 ↔ T4 | invoice PaidMethod "financing" (T1) used by T4's born-paid invoice | consistent |
| T5 → T3,T6 | settings key `financing` | T3 reads it in the start tx; T6 pages read it | consistent |
| T6 ↔ T7 | dict keys „Maksa pangalingiga“, „Maksa järelmaksuga (Inbank)“ | Ruling: T6 adds the keys it uses (return page: „Maksa pangalingiga“, „Proovi uuesti“); T7 adds „Maksa järelmaksuga (Inbank)“ and reuses „Maksa pangalingiga“ — avoids duplicate keys — cost: none |

| Task | Self-consistency |
|---|---|
| T1 | tests use exact cents and phones; sweep list long — OK |
| T2 | asks to verify billingAddress keys in Montonio docs — OK |
| T3 | late check 60+15=75 min for hirePurchase — OK (test says 75) |
| T4 | OK |
| T5 | OK |
| T6 | e2e needs the toggle on via a fixture — OK |
| T7 | OK |
| T8 | OK |

No test mandated by the plan asserts nothing.

## Progress
- Task 1: dispatched (base 5309649, implementer a40659cb812018a15, sonnet)
- Task 1: implementer DONE_WITH_CONCERNS bcc81c5 (test-addresses failed on the spec's support@ address — controller fixed the spec in acd00b2; +372 followed by any 7–8 digits counts as Estonian; invoiceKindOfPayment fixed for financing; financing kept out of manual paid methods)
- Ruling (T1): +372/372 followed by any 7–8 digits counts as Estonian (the explicit country code is enough; a wrong number is corrected in Inbank's form) — cost: an invalid EE number prefilled
- Task 1: complete (commits 5309649..bcc81c5, review clean)
- Task 1: minor (deferred → Task 4): invoice PDF prints „Tasutud <date> (Järelmaks (Inbank))“ — nested parentheses; D6 draft is „Tasutud: järelmaks (Inbank)“
- Task 1: minor (deferred → Task 3): late-check age is separate from attemptWindowMs (bank 45, hirePurchase 75)
- Task 1: minor (deferred): no test pins +372 followed by 1/2/9; attemptWindowMs trim/case untested; PaymentChoice TS type vs pgEnum drift check; createInvoice method typed PaidMethod; 00372 prefix → null; old-safari comment "imports nothing"
- Task 2: dispatched (base acd00b2, implementer a93aa0b516fd9f1dd, sonnet)
- Task 2: implementer DONE_WITH_CONCERNS 0f4bc49 (Montonio docs give phoneCountry as a calling code e.g. "372"; no methodOptions for hirePurchase; fake provider name Inbank)
- Ruling (T2): phoneCountry = "372" (calling code) per Montonio's orders guide, not "EE" — spec D8 amended — the fix (billingAddressOf + tests) goes in with Task 2's fix round — cost if wrong: Montonio rejects loan orders with an EE phone; Dim's sandbox check catches it
- Task 2: complete (commits acd00b2..4f0a011, review clean)
- Ruling (T2 I1): docs/deploy.md §11.3 describes the toggle/caller/60-min windows ahead of the code — fine on the unmerged branch; Task 8 re-verifies every deploy.md claim against the code before the merge — cost: none if Task 8 does it
- Task 2: minor (deferred → Task 4): paymentMethodLabel("hirePurchase","Inbank") would render „Järelmaks (Inbank) · Inbank“ — drop the provider suffix for hirePurchase
- Task 2: minor (deferred): fake header says billing keys required (fake's rule, not Montonio's); billingClaim whitelist not pinned by a cast test; fake lets a paid loan be flipped; no loan-specific re-send/refund test
- Task 3: dispatched (base c469099, implementer a7e24f4bd915e3b33, opus). Rulings carried: method stored at insert; liveAttempt per method + window; holdUntil(now, ms); late check 45 bank / 75 hirePurchase in one query; {kind:"financing"} refusal; a financing registration may still pay in full by bank
- Task 3: implementer DONE_WITH_CONCERNS beb7b85 (a bank press keeps a longer existing hold; Maksed shows the method on pending rows; refusal has no text yet (T6/T7); toggle off refuses a loan re-send)
- Task 3: complete (commits c469099..beb7b85, review clean)
- Ruling (T3): a bank press keeps an existing later hold (never shortens a loan's 60 min) — a declined loan stays PENDING and may still be approved; cutting to 35 min would wrongly hit a loan signed at 35–60 min with „Täis“ — cost: a hold can outlast a failed loan send by up to one window
- Task 3: minor (deferred → Task 4): a failed loan send can leave its 60-min hold while another row is pending (compute the hold from open attempts)
- Task 3: minor (deferred → Task 7): postedMethod reads only urlencoded bodies — the buttons must post default form encoding
- Task 3: minor (deferred → Task 8): testplan for Maksed showing the method on pending/failed rows; refusal states
- Task 3: minor (deferred): stale comments submit.ts:329-335 and payments.ts:82-83 ("30 minutes"); 45/75 hard-coded (derive from SEAT_HOLD_MS/FINANCING_ATTEMPT_MS); new tests use @example.com/.ee instead of @example.test
- Task 4: dispatched (base ab59cbb, implementer afb48e7f1051c085c, opus; carries: invoice PDF nested brackets, no provider suffix for hirePurchase label, releaseHold from open attempts)
- Task 4: implementer DONE_WITH_CONCERNS 3f91c70 (e-course already-paid = a paid purchase of same course+email paid at/after the loan started (renewal rule); every e-course settle takes the purchase advisory lock; releaseHold counts all other pending rows; loan settled before bank → bank counted with Ülemakse; PDF „Tasutud <date> · Järelmaks (Inbank)“; new Maria late-loan note draft)
- Task 4: review — Approved with one Important needing a ruling (e-course: loan paid first, bank paid later → the bank row is counted and re-granted with no alert; registrations have Ülemakse)
- Ruling (T4): add the symmetric e-course rule — a bank e-course payment turning PAID while a hirePurchase purchase of the same course and e-mail was paid at or after that bank row's created_at is held and alerted „Topeltmakse“, under the same advisory lock (spec D5: "the second … Topeltmakse") — registrations keep today's Ülemakse — cost if wrong: a deliberate renewal paid by bank right after a loan is held for Maria
- Ruling (T4 minor 2 → into the fix): Maria's late-loan note says „Seda ei pandud kirja“ (house wording) — cost: none
- Task 4: minor (deferred → Task 8): test plan checks for the late-loan Topeltmakse (Maksed „Ootel kontrollil“, Maria's note) and the invoice PDF line; spec §4 gets Maria's late-loan note text as Draft
- Task 4: minor (deferred): the refund note after refunding a held row speaks of adjusting the counted amount (held rows need their own note); a held late loan's return page shows the järelmaks pending text; re-pressing a live loan row >30 min after a bank purchase is held, not renewed; the late alert is sent once only
- Task 4: fix round 1/5 (2 addressed, 0 open; commits 3f91c70..cb6a385)
- Task 4: complete (commits ab59cbb..cb6a385, review clean)
- Ruling (T4, load-bearing out-of-scope): the late-loan rules read the stored method, which detailsOf overwrites with Montonio's reported paymentMethodType — if Montonio reports another name for a loan, the rules silently stop firing. The start's method becomes authoritative: Montonio's reported method only fills an empty one (older rows); carried into Task 5's dispatch with a test — cost: Maksed shows the start's method even if Montonio reports a different spelling
- Task 4: minor (deferred): log line wording settle.ts:308; lateNotes.bank type allows an unreachable registration combo
- Task 5: dispatched (base cb6a385, implementer a6bec93f2a807ca89, sonnet; + carried fix: start's method authoritative)
- Task 5: implementer DONE 7bfbcdb + b777474
- Task 5: review — Needs fixes (I1: my ruling was too broad — making the stored method win for all rows can relabel card/Apple Pay/Google Pay payments as „Pangalink“ irreversibly)
- Ruling (T5, narrowing my earlier ruling): the stored method is authoritative only for hirePurchase starts; every other row keeps the pre-branch rule (Montonio's non-empty value wins) — the loan rules only ask "is it hirePurchase" — cost: none
- Task 5: fix round 1/5 (1 addressed, 0 open; commits b777474..b130b51)
- Task 5: complete (commits cb6a385..b130b51, review clean)
- Task 5: minor (deferred → Task 8): testplan haldus-seaded-jarelmaks incl. the card's saving/saved/error Draft texts
- Task 5: minor (deferred): JS trim vs Postgres btrim whitespace difference for the hirePurchase check (only exact codes are written); checkbox enabled during a pending save; .check CSS duplicated from InvoiceSettings
- Task 6: dispatched (base b130b51, implementer a0fa16d25b9ab8e43, sonnet)
- Task 6: implementer DONE_WITH_CONCERNS 0f4eb2c + 0c58849 (Task 5 regression fixed in e2e helper: two Salvesta buttons on Seaded; refused järelmaks shows the range sentence on the confirmation, not at the choice; liik=jarelmaks only for unpaid loans; cart preselects via ?makse=jarelmaks; return buttons post method to /maksa/<token>; 0018 applied to local e2e DB)
- Task 6: complete (commits b130b51..0c58849, review clean; deviations accepted: contact refusal on the confirmation, liik=jarelmaks for unpaid loans only, inline contract changes only {ettemaks}, ?makse=jarelmaks preselect)
- Task 6: minor (deferred → ask Dim): the range refusal sentence is also shown when the toggle is off (misleading for a 350 € course); RU payment terms inconsistent (Банковская ссылка / Оплатить через банк / через интернет-банк)
- Task 6: minor (deferred → Task 7): until Task 7, „Proovi uuesti“ with the toggle off gets a silent 409 pay page — Task 7 must ship in the same push
- Task 6: minor (deferred → Task 8): reword avalik-ekursus-leht (placeholder gone) and the contact-form check; held late loan return wording (Task 4)
- Task 6: minor (deferred): optional pay-now button on the contact refusal confirmation; admin-site saveButton .first() order-dependent; new db tests use @example.com
- Task 7: dispatched (base 0c58849, implementer a9d0465dee2fbd94e, sonnet; + the toggle-off 409 message fix from Task 6)
- Task 7: implementer DONE_WITH_CONCERNS cf7a470 (seadedSave e2e helper for Task 5's second Salvesta; a confirmed financing registration with nothing paid also gets two buttons)
- Ruling (T7): a financing registration Maria confirmed by hand with nothing paid may still be paid by järelmaks — spec §4 ties the choice to "nothing paid and the full price due", not to the status — cost: none
- Task 7: complete (commits 0c58849..cf7a470, review clean)
- Task 7: minor (deferred → Task 8): hoist seadedSave into one shared e2e helper; testplan for the two buttons, the refusal sentence, the former silent 409
- Task 7: minor (deferred): payPage JSDoc mentions one button; 409 re-read edge cases; loadPayView reads the toggle for every registration; no pay-page DB test for the hand-confirmed financing case; data-card-pay-ways has no group label
- Task 8: dispatched (base cf7a470, implementer ae8e8a71c7451334f, sonnet; testplan + docs + seadedSave hoist + full run)
- Task 8: implementer DONE_WITH_CONCERNS ac364ab + 5514a47 (unit 5574 pass; e2e 870 passed / 194 skipped / 4 flakes passing alone; course.spec beforeEach terms-lock wait inside the 30 s timeout; e-course bank-after-loan has no hand check; deploy.md §11.3 corrected)
- Ruling: run Task 8's review and the whole-branch review in parallel (Task 8 is docs/testplan/test-helper only; the final fix wave covers both) — cost: a Task 8 finding lands in the final wave instead of its own round
- Task 8: review — Needs fixes (I1 haldus-maksed-jarelmaks failed-row step: a sandbox bank cancel may stay PENDING; I2 haldus-seaded-jarelmaks expects an unticked box the plan's own order already ticked; I3 course.spec cart beforeEach lock wait inside 30 s — pre-existing hook made likely by financing.spec holdTerms; minors: area keep, bare Salvesta on non-Seaded pages, financing.ts:73-75 comment says 60 not 75, area note states 901–1000 € decline as fact)
- Ruling (T8): I1, I2, I3, m6 (comment 75), m7 („peaks tagasi lükkama“) go into the final fix wave with the whole-branch findings — one wave per the ruling above — cost: none
- Ruling (T8 m4): keep id haldus-maksed-jarelmaks in area registreerimine — the brief, deploy.md §21.3 and the unit test name it; the area is right — cost: one id prefix differs from its area
- Ruling (T8 m5): leave the bare „Salvesta“ calls on non-Seaded editors — unique there — cost: none
- Final review (opus): With fixes — 0 Critical; I1 a hand-recorded stuck loan later settled is held as Topeltmakse („refund the loan“) and the follow-up is skipped; m1 e-course katkestatud retry preselects Pangalink; m2 late log line wording (deploy.md §21.5 quotes it); m3 old rows have empty Makseviis; deferred triage: fix the held-row refund note (messages.ts:406 invites lowering a correct sum), leave the rest (reasons in 2026-10-22-instalments-final-review.md)
- Ruling (final): one fix wave = final I1 (read pay:stuck:<id> before the late hold; told → normal record + follow-up; KV failure = not told; db test), held-row refund note (refunded row with paid_at null → own Draft line „Seda makset ei pandud kirja: adminis pole vaja midagi muuta.“ + unit test), m1 (&makse=jarelmaks on the e-course katkestatud retry of a loan), m2 (log line + deploy.md together), m3 (into T8 I1's reworded check: „pärast uuendust tehtud“ rows), T8 I1, I2, I3, m6, m7 — cost: none with the toggle off
- Ruling (final, leave): every other deferred minor per the triage in 2026-10-22-instalments-final-review.md; Task 6's toggle-off range sentence and RU terms go to Dim at finish — cost: listed for Dim
- Final fix wave: dispatched (base 5514a47, implementer ad51b43fe5616b3a6, sonnet; brief final-fix-brief.md, F1–F4 + T1–T5)
- Final fix wave: implementer DONE 6968a83..c531600 (7 commits; vitest 5583 pass, tsc/lint clean; e2e course+financing+payments 181 passed / 1 flake admin-site.spec:55 passing alone); controller commit 5628165 (T5 wording „taotluse peaks Inbank tagasi lükkama“ + its test pin)
- Ruling (fix wave F1 concern): a stuck loan Maria was told about, paid after a bank payment covered the price, is counted with „Ülemakse“ + the follow-up instead of held — same as a registration's bank-after-loan (spec §4: counted with Ülemakse); rare² — cost: the follow-up's „eemalda oma käsitsi lisatud summa“ when she added none
- Ruling (fix wave F2): the held-row refund line also applies to e-course alerts — same defect — cost: none
- Final fix wave: re-review — all 9 addressed (F1–F4, T1–T5), no new Critical/Important; minor: Maksed ordering guard bans Proov 11 by name rather than deriving
- Ruling (residual): Ülemakse mail arriving before the follow-up in F1's told path — accepted, the follow-up is explicit and last — cost: Maria reads one misleading line first in a rare² case
- Ruling (residual): neverCounted also covers a refunded pending row and an amount-mismatch held row — „Seda makset ei pandud kirja“ is true for both — cost: understates if Maria acted by hand on a mismatch-held row
- Ruling (residual): leave the hard-coded Proov 11 guard — no regression — cost: a future later-made Proov reference slips past as before
- Final review: complete (5309649..5628165)
