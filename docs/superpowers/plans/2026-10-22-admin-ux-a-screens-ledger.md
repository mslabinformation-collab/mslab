# Admin UX pass, piece 2 (A screens) — build ledger (rulings and deferred items)

Copied from the SDD workspace when piece 2 finished (23.10.2026). Every `Ruling:` line is a decision taken during the build on Dim's behalf; „Open for Dim“ lines were answered on 23.10 (piece2-texts.md §6); the whole-branch review (2026-10-22-admin-ux-a-screens-final-review.md) triaged every deferred minor.


Spec: docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md (§8 item 2); design handoff/README.md §2, §5; approved texts analysis/piece2-texts.md (Dim 22.10 "OK"; S3-e refuse; Pikenda base = later of end/today). Plan approved by Dim 22.10 ("Yes"). Branch feat/admin-a-screens from main 6e538ee. Montonio order URL pattern: asked from Dim 22.10, not yet given (Task 13 needs it).

## Pre-flight scan

| Pair / task | Produces → consumes | Found |
|---|---|---|
| T1 → T4, T12, T13, T14, T15 | ListToolbar `pillRows`, href-based `ListScope` | consistent; no callers of the old props (facts) |
| T1 → T5 / T6 / T9 / T12 / T13 / T14 | PillChoice; MoreMenu, FoldRow; TabPills | consistent |
| T1 → T8; T1 → T4, T13, T15 | `firstName`/`allative`; `phoneQuery` | consistent |
| T2 → T5, T12 | `listPaymentsOf` without replaced rows | consistent |
| T2 → T7, T13 | `CheckReason`, `checkReasonLabel` | consistent |
| T2 ↔ T13 | both touch maksed/page.tsx (T2 maps only) | sequential, fine |
| T3 → T5 | `addManualPaymentAction` / `ManualPaymentResult` | consistent |
| T3 ↔ T5 ↔ T6 | RegistrationForms: T3 removes typed sum, T5 status+note, T6 cancel | sequential, fine |
| T3 → T6 | receipt undo lowers sum ↔ S3-f ConfirmPanel lines | consistent |
| T4 ↔ T5 ↔ T6 | registreerimised/page.tsx (list / detail) | sequential |
| T6 → T14 | `InvoiceRow` actions | consistent |
| T7 → T13, T14 | links to `/admin/maksed?staatus=kontroll` (B14 meaning) and `/admin/arved#arveta` | targets land later in the same push — ruled in T7 |
| T8 ↔ T10 | ProtocolScreen.tsx, protokollid/page.tsx | sequential |
| T9 → T12 | ReopenTest on ConfirmPanel used in ClientDrawer | consistent |
| T9 ↔ T11 | tests/unit/test-review-dom.test.ts (ReopenTest / TestReview parts) | sequential |
| T4 ↔ T13 | stackAt980 removal (T4 page only, T13 entirely) | consistent |
| T1 self | tests ↔ interfaces; Sidebar refetch item added in self-review | consistent |
| T2 self | rulings vs tests (replaced payable, hold window kept, return page) | consistent |
| T3 self | Step 4 says drawer has no money UI until T5 | accepted: same push |
| T5 self | P-2 pill examples (290 €) ↔ S3-a/e texts | consistent |
| T7 self | Tallinn midnight test | consistent |
| T12 self | two commits (B12 then A5) | consistent |
| T13 self | needs Dim's Montonio URL | blocker for T13 only |
| T14 self | month default ruling ↔ CSV label | consistent |
| T15 self | undo refuses when changed meanwhile ↔ RequestToggle today has no expected value | T15 must add an expected-state guard to the toggle (in its tests) |
| T6/T10/T11/T12/T15 | plan-mandated defects (empty tests, duplication) | none found |

- Ruling: run Task 13 (Maksed, needs the Montonio order URL) after Task 15 if Dim's answer has not come; Task 7's link to `?staatus=kontroll` works before B14 (it lists held rows only until T13) — cost: none, same push
- Ruling: T15's undo guard = the toggle action takes the expected current `handled` and refuses when it differs — spec Review Focus 5 — cost: one more hidden field
- Ruling: start Task 1 before the separate järelmaks text fix merges (no shared files except testplan.json/dicts, merged at the end) — cost: one merge of main into the branch
- Task 1: dispatched (base 6e538ee, implementer ac446eda93f56b32e, sonnet)
- Ruling withdrawn: Task 13 no longer waits — Dim answered 22.10 (link + copy id)
- Task 1: review base = 6eaaf77 (controller doc commit landed after dispatch, before any implementer commit)
- Dim 22.10: test page stays in admin; note box opens for every answer (overrides C7's Viga-only note); 💬 review bubble also on admin pages — built separately on feat/review-tools-admin (worktree), merges before piece 2's deploy
- Ruling: piece 2 bottom-fixed parts carry data-fab-avoid (constraint added, controller commit) — cost: none
- Note: controller doc commits 6eaaf77 and the data-fab-avoid one sit inside Task 1's range; Task 1's review package uses base = the last controller commit before the implementer's first
- Task 1: implementer DONE_WITH_CONCERNS b1a542b (unit 3504 pass; FoldRow per Part 2 prototype; adminEt.common.more „Veel“ added; MoreMenu absolute → clip risk in overflow:hidden cards; allative uses the name's script; 3 extra BROWSER_FILES; no testplan change)
- Task 1: review — Approved (minors M1 MoreMenu aria label, M2 names.ts comment, M3 Space on link item, M4 pill variant for „Pikenda“, M5 Esc-in-drawer e2e, M6 placement on scroll)
- Ruling (T1): M1–M4 into fix round 1 now (shared parts reused by Tasks 6/8/12/13/15); M5 carried to Task 6's dispatch (one chromium e2e: „Veel ▾“ in a drawer, Esc closes the menu, drawer stays open); M6 leave — cost: none
- Ruling (T1 ⚠️): FoldRow keeps the quarter-turn when open under reduced motion (only the transition goes) — otherwise open and closed look alike — cost: none
- Task 1: fix round 1/5 dispatched (resume ac446eda93f56b32e)
- Task 1: fix round 1 → 2560a87 (M1–M4 addressed; controller checked the diff)
- Task 1: complete (commits e05bb87..2560a87)
- Task 2: dispatched (base 2560a87, implementer a6a5d69103c48b3ac, opus — money path)
- Note: two checkouts running Playwright share :3000/:3997/:3998 (reuseExistingServer) — both running agents warned to check the port first; future parallel side work must not run e2e at the same time
- Task 2: implementer DONE_WITH_CONCERNS a91461a (vitest 5720 pass; 0019 on local DB; replaceOlderOrders leaves updated_at (seat window); checkReasonLabel in PaymentLines (browser bundle); told-stuck replaced row counted; liveAttempt pending-only; a refused new order still replaces the older open one)
- Task 2: review (opus) — Approved; deviations accepted: no updated_at bump on replace (seat window reads it; the plan's interface line is wrong), checkReasonLabel/checkText in PaymentLines.tsx (domain/payments.ts ships to students)
- Ruling (T2, implementer's): a replaced row Maria was told is stuck and recorded by hand is counted, not held — same as the instalments late-loan rule — cost: an Ülemakse alert instead of a hold
- Ruling (T2 concern 5): the replace stays at insert (atomic with the new row under the lock); a refused new order leaves the older one hidden from Raha though still payable — money safe — cost: Maria sees no open order in the drawer for that case
- Ruling (T2 review minor → fix round 1): liveAttempt also revives a replaced row inside its window (back to pending, others replaced) so loan → bank → loan re-sends the first Inbank application instead of filing a second — cost: one more state transition
- Ruling (T2): stuck-check reads status inside the tx; OPEN_ORDER constant in releaseHold; PARAM_OF.replaced not "" — fix round 1
- Ruling (T2): the replaced-hold mail keeps „Tagasta üks neist“ (either order can be refunded) — cost: none
- Carry → Task 13: import checkText/checkReasonLabel from @/components/admin/PaymentLines (Maksed still prints „Kontrolli Montonios“ for 'double')
- Carry → Task 16: deploy.md rollback warning — before any code rollback after 0019: UPDATE payments SET status='pending' WHERE status='replaced' (old code ignores replaced rows: money lost silently)
- Task 2: fix round 1/5 dispatched (resume a6a5d69103c48b3ac)
- Task 2: fix round 1 → 9e2fc34 (revive replaced row inside window; stuck read before tx, status under lock; OPEN_ORDER; PARAM_OF without replaced)
- Task 2: re-review — all 3 addressed; minor: the revive UPDATE's row count unchecked (held()/refunded() don't take the lock; narrow race, money safe)
- Task 2: minor (deferred → final review): `.returning({id})` on the revive, 0 rows = no live attempt
- Task 2: minor (deferred → Task 16): testplan step for loan → bank → loan inside 60 min = one Inbank application
- Task 2: complete (commits 2560a87..9e2fc34)
- Task 3: dispatched (base 9e2fc34, opus — money path)
- Task 3: implementer DONE_WITH_CONCERNS e09c458 (vitest 5744; e2e 6 expected fails on the removed „Laekunud summa (€)“ field → Task 5; deviations: ManualPaidMethod, seats revalidated on confirmedNow||full, „Osamakse“ receipt kind for no-price, paidInvalid kept for S3-e, receiptKind in domain/invoice.ts)
- Ruling (T3 concern 1, money): after B4 a receipt („Juba tasutud“) documents only recorded, uninvoiced money — createInvoice receipt mode refuses above the uncovered amount; openAmounts offers no receipt amount when nothing is uncovered; undo lowers by the amount, capped at paid_cents (old receipts for never-recorded money) — spec §9 / R10 replacement — cost if wrong: Maria can't make a receipt for money she forgot to record (she adds it with „Lisa laekumine“ + receipt instead)
- Carry → Task 6: InvoiceRow undo panel wording by dueAt === null (receipt), not paidAdds
- Task 3: fix round (pre-review) dispatched (resume a4d5fa474175ad9ce)
- Task 3: fix round → c64a48f (receipt only for uncovered recorded money, server refuses with existing notOpen; undo capped at paid_cents); breaks e2e invoices.spec:60 and admin-invoices.spec:66 (they make „Juba tasutud“ at paid 0) → Task 5 rewrites; invoices.spec hang holds a 420 s shared lock → a full e2e run looks worse until Task 5
- Task 3: review (opus) — Needs fixes: I1 takeBackRegistrationPayment can confirm with no seat check (B4 makes ≥50 %-awaiting common on full sessions); minors: receipt label ignores earlier recorded money, form parse outside try, undo cap weaker than it looks, stale invoices-spec wording; all six deviations accepted
- Ruling (T3): take-back only stays or demotes; cap = min(amount, paid − other paid coverage) — protects old receipts for never-recorded money — cost: none for new receipts
- Ruling (T3 hand-off → Task 6): S3-f's lines apply to every receipt undo (all now lower the sum; the "no money change" case is gone by spec §9) — not new text — cost: none
- Carry → Task 5: registreerimine-arve-kviitung needs new steps (receipt for unrecorded money is disabled; use „Lisa laekumine“ with receipt); rewrite invoices.spec:60 / admin-invoices.spec:66 / admin-inbox :170 :249 :376 before any full e2e run (420 s lock hang)
- Carry → Task 16: deploy notes — „Koosta arve“ no longer offers a receipt for unrecorded venue money; Maria records it with „Lisa laekumine“
- Task 3: fix round 2/5 dispatched
- Task 3: fix round 2 → 9b0fc52 (take-back never confirms; cap = part not covered by other paid invoices or unbilled online payments; „Jääk 50%“ label; parse in try; spec D5/D6)
- Task 3: re-review — all 5 addressed; minors: `instanceof FormData` stricter than other actions (duck-type), cap's unbilled-online leg has no own db test
- Carry → Task 5: manualPaymentForm duck-typed (`typeof formData?.get === "function"`); Task 5's drawer e2e exercises the real action path
- Task 3: minor (deferred → final review): db test for the cap's unbilled-online-payment leg (seller unset)
- Task 3: complete (commits 9e2fc34..9b0fc52)
- Task 4: dispatched (base 9b0fc52, sonnet)
- Task 4: implementer DONE_WITH_CONCERNS a60c71e (vitest 5795; list e2e pass; ListEmpty gained optional `search`; db page tests got a next/navigation mock; testplan: registreerimine-haldus redo, haldus-registreerimised-otsing new, haldus-loend-terve-rida redo, haldus-loend-tahvel reworded)
- Ruling (T4 concern 1): README A2 gives counts on the status pills only and the prototype draws the form pills light — form pills follow the design (light tone, no count) via a ListToolbar row option; the plan's "counts on both rows" yields to README (D1) — cost: none
- Task 4: review — Approved (minors: +372 prefix vs stored national number, flex none at 375, phone arm over-matches on emails with digits, testplan wording ×3, scope select lists all sessions)
- Ruling (T4): „Uuemad eespool“ not drawn (only Part 1 pattern frame shows it; README and Part 2 A2 omit) — cost: none
- Ruling (T4): no-session line keeps existing „E-õpe“ / „Aeg kokkuleppel“ — existing words — cost: none
- Ruling (T4): leave the phone arm's over-match and the all-sessions scope list — cost: a few extra hits / a long select
- Task 4: fix round 1/5 dispatched (form pills light/no count, +372, 375 px flex, testplan wording)
- Task 4: fix round 1 → b93f370 (light form pills without counts; +372 strip; 375 px flex + shared ListToolbar grid minmax(0,1fr) for a wide scope option — accepted; testplan wording)
- Ruling (T4): +372 is stripped when ≥ 7 digits follow (Estonian landlines are 7 digits; my "more than 7" was wrong) — fix round 2 — cost: none
- Task 4: fix round 2 → dae28a2 (+372 with ≥7 digits); re-review dispatched in parallel with Task 5 (read-only)
- Task 5: dispatched (base dae28a2, implementer a5a0a94bdb01cdb1b, opus — first useAutosave adopter + money UI + e2e rewrites)
- Task 4: re-review — all addressed, no new breakage; minor: `>= 4` at admin-registrations-list.test.ts:104 should be the exact five names
- Task 4: minor (deferred → final fix wave): exact list for the +372 5000 assertion; search.test.ts comment "8-digit" on a 7-digit case
- Task 4: complete (commits 9b0fc52..dae28a2)
- Task 5: implementer DONE_WITH_CONCERNS b791032 (vitest 5834; e2e admin-inbox/invoices/admin-invoices pass --no-deps, invoices.spec no longer hangs; 375 px + real-browser offline guard check; note route answers POST (engine sends POST); cancelled registration can't be restored from the drawer (spec §10); a first run without --no-deps saw 4 site-editing spec failures (news, campaign, RU switch) — not this task's files → check in the full run)
- Task 5: review — Approved (minors: 12 testplan lines still quote the drawer's old „Laekunud“ row; money `stale` reuses the status text; full PaymentRow[] as a client prop; empty role=alert adds a gap; phone first screen with many online lines; ledger "PATCH" wording — the note route is POST like patchSender; local e2e DB campaign row left active with E2E values)
- Ruling (T5): note route POST is correct (engine/patchSender/autosaveHandler use POST); plan's "PATCH" was loose — cost: none
- Carry → Task 6: reword the 12 testplan lines „Laekunud“ → „Raha“ (reworded); pass PaymentLines as a server-rendered node (no full rows client-side); hide the empty alert (:empty); restore the local e2e campaign fixture before e2e
- Open for Dim (collect for the piece 2 report): a money-specific stale line for „Lisa laekumine“ (today reuses „Staatus muutus vahepeal … salvesta uuesti“)
- Ruling (T5): phone Raha keeps the online payment lines (README: "Raha (with only the „Lisa laekumine“ button)" read as the panel closed) — cost: status may fall below the first screen with 3+ online rows
- Task 5: complete (commits dae28a2..b791032)
- Task 6: dispatched (base b791032, sonnet)
- Task 6: implementer DONE_WITH_CONCERNS 4007d49 + 56d3012 (vitest 5899; e2e admin-invoices/contracts/clients/invoices/inbox/payments pass; {x} = capped take-back, rule moved to domain/invoice.ts receiptTakeBack; new PhoneFold (section on desktop, fold < 640); FoldRow gained shortSummary; local campaign row 1 restored to campaignSeed)
- Open for Dim: a question line for undoing a marked payment request (no approved text; panel shows today's sentence as its first line)
- Carry → Task 14: pass `takeBack` (receiptTakeBack) to InvoiceRow on the Arved list so its undo panel shows the capped sum and the „läheb tagasi“ line
- Task 6: review — Needs fixes (small): I1 registreerimine-arveta-makse-paneelis asks for the removed generic button; M1 konto-arve-maksa mark, kontakt-tagasiside-haldus wording; M2 aria „Veel: {number}“; M3 typo; M4 InvoiceRow panels under the buttons; M5 „väheneb 0 €“, bare() ×5, paidAdds unused, open form after catch-up
- Ruling (T6): M2 aria „Veel: {number}“ accepted (on-screen words, Task 1 buttonLabel rule); M4 accepted; 0 € take-back omits the money line — cost: none
- Task 6: minor (deferred → final fix wave): bare() euro helper ×5; create form reopening after a catch-up
- Task 6: fix round 1/5 dispatched
- Task 6: fix round 1 → a135f49 (I1, M1, M3, M5-part-1); kontakt-tagasiside-haldus kept `redo` (pinned; behaviour changed to a fold) — accepted; controller checked the report (testplan/typo/0 € line only)
- Task 6: complete (commits b791032..a135f49)
- Task 7: dispatched (base a135f49, sonnet)
- Task 7: implementer DONE_WITH_CONCERNS 39e9434 (vitest 5922; e2e admin-inbox/completion/protocols pass)
- Ruling (T7): every queue row's hint is „Vanim {dd.mm} · {name}“ (P-1, approved pattern); the prototype's one-item hints are mock samples — cost: less detail when one item waits
- Ruling (T7): „Tulevased koolitused“ lists the next five sessions; the note counts the next 30 days (prototype: 5 rows with note „4“) — cost: none
- Task 7: review — Needs fixes: I1 dead openPurchaseInterest query on every admin render; I2 dead ui.module.css stat/columns/stack; minors: protocolIndex heavy for today only (L101 partly), overviewQueue repeats adminCounts predicates (test-guarded), stale comments, plusDays third copy, unused hooks/icon path, TestplanCard between Täna and queue
- Ruling (T7 M6): TestplanCard goes after „Tulevased koolitused“ (README order Täna → queue → upcoming; card only "stays the same") — cost: tester scrolls a little further on the overview
- Task 7: minor (deferred → final review): today-only protocol counts export (L101), plusDays/daysBefore/addDays duplication
- Task 7: fix round 1/5 dispatched
- Task 7: fix round 1 → 7098c18 (dead query/CSS/hooks/icon removed; TestplanCard after upcoming, order pinned); controller checked the report
- Carry → Task 9: stale comment hindamine/page.tsx:24 ("the anchor the overview's card links to")
- Task 7: complete (commits a135f49..7098c18)
- Task 8: dispatched (base 7098c18, opus — protocol engine + B13)
- Task 8: implementer DONE_WITH_CONCERNS c71cc8f (unit 3634; protocol e2e ×3 pass; „Saada kõigile (0)“ asks nothing; restore box by box (nothing lost); restore unlocks a sent protocol like „Muuda“; chip short „✓ HH:MM“ below 900 px; shared chip wording; practical screen keeps „Saada“/„Saada uuesti“ via two keys (Task 10 to know))
- Ruling (T8): accept the implementer's B13 reading — restore box by box, keeping later typing and leaving words of a vanished heading in the notice — spec §9 "writes the local copy back" without losing text — cost: none
- Task 8: review — Approved (minors: dead .editorHead p CSS; empty-first-name label double space; ConfirmPanel „Katkesta“ looks live while busy (piece 1 component); no testplan line for the „← Protokollid“ back link)
- Task 8: minor (deferred → final fix wave): .editorHead p dead CSS; „Saada protokoll  uuesti“ double space fallback; testplan expect for „← Protokollid“; ConfirmPanel busy state on „Katkesta“
- Task 8: complete (commits 7098c18..c71cc8f)
- Task 9: dispatched (base c71cc8f, sonnet)
- Task 9: implementer DONE_WITH_CONCERNS 268a167 + ceaca4a (unit 3649, db 2309; completion/certificate e2e pass; queue row meta per prototype (no course); reopen status line keeps today's text; 7 testplan checks marked)
- Ruling (T9): queue rows follow the prototype meta (no course name) — D1 — cost: two courses of one student read alike until opened
- Carry → Task 10: amend docs/superpowers/specs/2026-10-13-ecourse-completion-design.md §5.2 (three groups → one queue) with its spec §9 amendment
- Task 9: review — Approved (minors: `.what` flex also styles the /hindamine/test attempts list (Vaata wraps at 375); heading focus offset 4 not 2; reopen status line names no student (Dim wording); stale docs §5.2 + deploy.md:293; newRound „vooru“ (Task 10); nits)
- Carry → Task 11: own class for the queue row vs the attempts list in assessment.module.css; heading outline-offset 2
- Carry → Task 16: docs/deploy.md:293 „Väljastatud tunnistused“
- Open for Dim: reopen status line „Test on uuesti avatud: katseid jäänud n.“ without the student's name
- Task 9: complete (commits c71cc8f..ceaca4a)
- Task 10: dispatched (base ceaca4a, sonnet)
- Task 10: implementer DONE_WITH_CONCERNS 84b3cbc (unit 3660; completion/protocols e2e pass; 375 px sticky bar with data-fab-avoid; phone hint „Puuduta pilti, et avada täissuuruses.“ from the phone prototype (D1: phone-only) — accepted; extra photos as thumbnails under the 260 px hero; resend/notes-only sends without a panel)
- Open for Dim: newRound „uue vooru“ → „uue korra“ (minimal change; stilted)
- Task 10: review — Approved (minors: deploy.md:259/:262 stale; refusal doesn't focus the field; failed „Kinnita kõik“ only per-card; focused field under the sticky bar; no phone testplan check)
- Ruling (T10): fix M2–M5 now (reasonable-person expectations on the course day); M1 → Task 16 — cost: one round
- Carry → Task 16: docs/deploy.md:259 („uue vooru“) and :262 (confirmation closed by a read)
- Task 10: fix round 1/5 dispatched
- Task 10: fix round 1 → 6cc6fd4 (focus on refusal, approve-all unsaved line, scroll margins, phone testplan check; mutation-checked) — complete (commits ceaca4a..6cc6fd4)
- Controller: merged main (financing texts, test-page notes, admin 💬 bubble) into feat/admin-a-screens; conflicts resolved: testplan.json vahepeal-valja keeps "deploy" (B22 redo pending), payments-start keeps main's new price test + the B22-reworded test, testplan-file combines REDONE + REDONE_BY_B22 and keeps both describe blocks; the B22 guard now accepts a stamped markedAt (markedSince); tsc clean; full vitest running
- Controller: after the merge full vitest 6038/6039 — the one failure was main's admin-fab-avoid guard not knowing Task 10's dock; added it (b5309bd), passes
- Task 11: dispatched (base b5309bd, sonnet; + Task 9 carries)
- Task 11: implementer DONE_WITH_CONCERNS eb0fd11 (unit 3730; completion e2e pass ×2; route POST like Task 5; guard label reuses „Hinnang vastusele {n}“; conflict UI = chip + „Taasta minu tekst“ when stored marks exist; stray draft on save-vs-send race is never read; Task 9 carries done (.queueWhat, offset 2); db flake tests/db/actions.test.ts waitlist mail subject passes alone → watch in the full run)
- Task 11: review — Needs fixes: I1 a save from a page for older answers accepted when no draft exists (version "0"); I2 „Saada“ not held in a conflict (other sends are); minors: lone surrogate wedges the save, BROWSER_FILES line, drafts survive client deletion, old localStorage keys, back-button old page conflict (shared with Task 5), minimal conflict notice, guard label
- Ruling (T11): fix I1 (submittedAt in the version), I2 (hold the send in a conflict with other marks, existing autosave.conflict text), M1–M4 — cost: one round
- Task 11: minor (deferred → final review): back-button restored page posts an old version → conflict (shared with Task 5's note); conflict notice shows no other-device marks (minimal UI piece-wide)
- Open for Dim: leave-guard label for a test-review answer — reuses „Hinnang vastusele {n}“
- Task 11: fix round 1/5 dispatched
- Task 11: fix round 1 → 313f65e (version "<submittedAt ms>.<counter>"; send held in a conflict; toStorable refusal + client strip; BROWSER_FILES; drafts deleted with the client; old localStorage key removed); re-review dispatched in parallel with Task 12
- Task 12: dispatched (base 313f65e, sonnet)
- Task 11: re-review — all 6 addressed, no new breakage; out-of-scope: the held-send check runs before the send's own flush, so a 409 found by that flush still sends (re-check engine conflict after flush)
- Task 11: minor (deferred → final fix wave): re-check `engine.snapshot().conflict` after `await auto.flush()` in TestReview send()
- Task 11: complete (commits b5309bd..313f65e)
- Task 12: implementer DONE_WITH_CONCERNS 71b4523 (B12) + 4d32793 (A5) + 4f70550, d6ab96d, 4359c52 (unit+db 3918; admin-clients e2e 25 incl. 375 px; contracts/completion/certificate/list-widths specs updated)
- Ruling (T12): Õpilased search also matches phone digits — the prototype placeholder promises phones (D1) — cost: none
- Ruling (T12): an e-course access's „Lisa/Ava protokoll“ goes under „Veel ▾“ (README gives it no place; dropping it loses the entry) — cost: one more tap
- Ruling (T12): extendAccess never shortens; „Hinda“ is one button (practical first; the test via „Testi katsed“) — cost: none
- Task 12: review — Needs fixes: I1 „Pikenda ▾“ menu overflows 360–381 px when „Hinda“ precedes it (e2e fixture had no „Hinda“); minors: date min offers an always-refused day; stale pick/undo shows the generic save error; undrawn parts (empty line, aria labels, header „Vaata tema vaadet“, „Avas …“); date form inside the flex row; tests after code; ekursus-tingimused-leping mark; no Cyrillic search test
- Ruling (T12): phone card actions as the prototype's two-column grid + MoreMenu chooses the roomier side and caps width at 100vw − 16px — cost: shared MoreMenu change (Tasks 6/8 tests re-run)
- Open for Dim: a text for a stale „Pikenda“/undo (today the generic „Salvestamine ei õnnestunud. Proovi uuesti.“, which never succeeds for a stale undo)
- Task 12: fix round 1/5 dispatched
- Task 12: fix round 1 → a7f7890 (phone two-column actions; MoreMenu roomier side + width cap; 375 px e2e with „Hinda“; date min = first accepted day; ekursus-tingimused-leping reworded; client-add-dom test built a gmail-looking address literally → now at run time) — complete (commits 313f65e..a7f7890)
- Task 13: dispatched (base a7f7890, sonnet)
- Task 13: implementer DONE_WITH_CONCERNS 09b6c32 (B14) + 9c4401f (A6 Maksed) (db 2356; e2e payments/admin-inbox/admin-invoices/list-widths pass)
- Ruling (T13): Maksed columns from the A6 phone frame's fields (no desktop frame): Kuupäev, Maksja, Eest, Summa, Staatus, Montonio id — D1 fallback — cost: none
- Ruling (T13): Maksed and Arved share eyebrow/H1 (strings.md W21) and the tabs replace „← Maksed“ — cost: none
- Task 13: review — Approved (I1 no 375 px e2e for Maksed; minors: empty live region display:none, middle-click doesn't copy, rel noopener only (brief pins it), aria-label per row, overview parity test can't fail, widths fit() drops zero-box cells, waitForTimeout absence proof)
- Ruling (T13): fix I1, M1, M2, M4 (aria from on-screen words), M5; leave M3 (brief) and M6 — cost: one round
- Task 13: fix round 1/5 dispatched
- Task 13: fix round 1 → f1b924f (375 px e2e with a held/reason row; live region margin 0; middle-click copies; aria „Montonios ↗ — {name}“ (payments.montonioFor); parity vs overviewQueue/adminCounts) — complete (commits a7f7890..f1b924f)
- Task 14: dispatched (base f1b924f, sonnet)
- Task 14: implementer DONE_WITH_CONCERNS b5c107e (B11) + 511b74e (A6 Arved) (db 2377, unit 3831; admin-invoices/invoices e2e pass incl. 375 px; strip is a custom section#arveta (summary can't hold a button); preview range not consecutive when a payment pays an existing unpaid invoice; ?kuu=koik; invalid ?kuu → this month; csvNote gone; maxDuration 60; deploy.md item 8 amended)
- Task 14: review — Approved (minors: preview range false with a linked payment; seller missing not "nothing made" with a linked payment; Katkesta/Esc during the batch; empty status gap; #arveta under the phone bar; default-month search hides older unpaid invoices; stale comments; testplan step order)
- Ruling (T14): with linked payments the panel line drops its range parenthetical (designed sentence minus the range; n = payments) — cost: no range shown in that rare case
- Ruling (T14 M6): a search with no month chosen covers all months (default view stays this month; CSV rule unchanged) — reasonable-person expectation — cost: none
- Task 14: fix round 1/5 dispatched
- Task 14: fix round 1 → a68010f (linked-aware preview/result; seller pre-check + refresh; cancel held while pending; status out of grid flow; scroll-margin 76; search all months without a chosen month; comments; testplan 2nd Proov payment; RED 18 first) — complete (commits f1b924f..a68010f)
- Task 15: dispatched (base a68010f, sonnet)
- Task 15: implementer DONE_WITH_CONCERNS 8f0117b (unit 218 files + db subset; admin-inbox 52, admin-clients 26, 375 px; undo guard = expected + row xmin; refused undo uses common.saveError; „Huvi: {course}“ from the prototype sample; phone plain text in facts line; deep link beyond first 50 doesn't scroll; a one-process full vitest run didn't finish (TimeoutOverflowWarning flood) → controller to investigate)
- Task 15: review — Needs fixes: I1 grid 3 columns ≥1617 px / 1 column 900–1150; I2 three testplan checks still expect „Uus“; I3 tap-to-call gone; minors: deep link past the first 50, empty open list shows only a closed fold, focus after „Märgi tehtuks“, stale-press wording, tabs under search, 640 vs 760 switch, Praktika subject uses the package code
- Ruling (T15): xmin + expected guard kept (expected alone fails reopen+re-close, no migration allowed) — cost: Postgres-specific token
- Ruling (T15): „Huvi: {course}“ accepted (Part 2 prototype P2:553, D1) — cost: none
- Ruling (T15 I3): the facts line's phone becomes a tel: link (S3-j text kept) — Maria phones students — cost: none
- Task 15: minor (deferred → final review): a #p-{id} past the first 50 of its list does not scroll
- Open for Dim: a request-specific stale line (today „… Proovi uuesti.“ after an already refreshed page); `requests.lead` „Tehtud päringud jäävad nimekirja lõppu.“ kept
- Task 15: fix round 1/5 dispatched
- Controller: full vitest 6283/6283 at 8f0117b; the 125–133 TimeoutOverflowWarnings come from PGlite's wasm setitimer (test DB internals, @electric-sql/pglite __setitimer_js), not app code — harmless; the Task 15 agent's unfinished one-process run was load, not a hang
- Task 15: fix round 1 → 5aab02d (2-column cap with e2e at 7 widths; 3 testplan rewordings; tel: link 44 px; fold opens when nothing open; focus after „Märgi tehtuks“) — complete (commits a68010f..5aab02d)
- Task 16: dispatched (base 5aab02d, sonnet; deploy.md §22, rollback warning, stale lines, launch checklist + Open-for-Dim list, testplan loan→bank→loan, sweep, full run incl. full e2e)
- Task 16: implementer DONE_WITH_CONCERNS b95bac2 (vitest 6301; tsc/lint/build clean; full e2e 917/4 then 919/2, all failures pass alone — cold-start timeouts admin-edit:76, admin-site:55; a leftover local course_images row deleted; deploy.md §22 + §6/§8 notes; launch-checklist §21 with 7 Open-for-Dim lines; haldus-maksed-asendatud loan→bank→loan step)
- Open for Dim: the follow-up mail „Makse on nüüd kirja pandud … eemalda oma käsitsi lisatud summa“ asks for something a no-receipt „Lisa laekumine“ can't do (no undo by design, spec §10) — new sentence needed
- Task 16: complete
- Final review: dispatched (opus, base = merge-base with main)
- Dim 23.10 "OK": the 8 open wordings approved as proposed (piece2-texts.md §6 W1–W8) → into the final fix wave
- Final review (opus): With fixes — 0 Critical; I1 Dim's W1–W8b texts not in code (stuck-payment mails tell Maria to do the impossible); I2 TestReview send after a 409 found by its own flush; minors M1 revive UPDATE unchecked, M2 docs vs code (seat refusal, drafts per attempt), M3 „· koht kinnitub“ on a full session, M4 batch range with an interleaved number, M5 deleted registration undo line, M6 ConfirmPanel Katkesta while busy; triage: fix L66 (=M1), L84, L99, L133 (CSS + back-link testplan + Katkesta), L164 (=I2); leave the rest (reasons in final-review.md)
- Ruling (final): one fix wave = I1, I2, M1–M6, L84, L99, L133 (final-fix-brief.md) — cost: none
- Final fix wave: dispatched (base 328c9fb, sonnet)
- Final fix wave: implementer DONE_WITH_CONCERNS 9adb604..ad9db22 (13 commits; vitest 6315; tsc/lint/build clean; testplan 212; e2e inbox/invoices/clients/completion/payments pass one by one; completion e2e 9 flaked once, 3/3 on repeat; UndoBar undo may return a sentence (W6/W7); W3 with no name reads „Nimi puudub“; M3 mirrors the server's seat count; M6 blocks cancelling a discard question while a publish runs)
- Final fix wave: re-review — all 11 addressed, no new Critical/Important; minor: a failed revive that then hits the rate limit leaves a seat hold extended (needs a lost race + the hourly limit; expires on its own) — leave
- Final review: complete (c062b27..ad9db22)
