# Admin UX pass, piece 1 — build ledger (rulings and deferred items)

Copied from the SDD workspace when piece 1 finished (22.10.2026). Every `Ruling:` line is a decision taken during the build on Dim's behalf; every `minor (deferred)` and `parked` line is open work for pieces 2–4.


**Run details:**
- Spec: docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md (approved by Dim 21.10 "if as designed", answers fc856cd).
- Branch: feat/ux-global, from main fc856cd, in the main checkout. There is no worktree: e2e needs `app/node_modules` and `app/.env.local`, as in earlier phases.
- Merge base: fc856cd.

## Pre-flight scan

**Pairs of tasks that share a file or an interface:**

| Tasks | Shared | Produces → consumes | Found / ruling |
|---|---|---|---|
| T2 → T3 | `sections.ts`, `Sidebar.tsx`, `Shell.tsx` | `activeSection`, and Shell without `active` | consistent |
| T3 ↔ T4 | `Sidebar.tsx` and `Shell.tsx` | T3's Sidebar gets the `today` prop, which T4 fills | Ruling: T3 passes `today={null}` from Shell, and T4 fills it — T3's prop exists before its data — a phone card absent until T4 |
| T4 → T5 | `todaySessions` | T5's B16 href reads it | consistent |
| T4 | `adminCounts(db, email, now)` changes its signature | other callers must change too (`data.ts`, and the overview page if it calls it) | Ruling: T4 updates every caller — required by its signature — a missed caller fails tsc, so caught |
| T8 → T9 | `AutosaveStatus` and `SaveAnswer` in `domain/autosave.ts` | T9 consumes them | consistent |
| T9 ↔ T10 | `useAutosave.ts` | T9's interface comment says the hook "also registers with the leave guard (Task 10)", but T10 is built later | Ruling: T9 builds `useAutosave` with no guard registration, and T10 adds it (T10's file list modifies `useAutosave.ts`) — T10 can't exist before T9 — none |
| T6 → T7, T10, T11 | the dict's `common.cancel`, `common.close` and `common.undo`, plus ConfirmPanel | T7 uses `undo`, T10 uses `close`, T11's PublishBar uses ConfirmPanel | consistent |
| T2, T7, T10, T11, T12 | `(panel)/layout.tsx` | each mounts a provider | sequential edits, no conflict |
| T2 → T13 | the list pages | T2 removes Shell from the pages; T13 changes the list CSS | consistent |
| T1 | invoice settings | — | no other task touches it |
| T14 | docs | — | consistent |

**Each task checked against itself:**

| Task | Finding |
|---|---|
| T1 | The tests name helpers (`validRaw`, `stored`, `getSetting`) that the test file may not have; the plan says to fit them to the file. OK. |
| T2 | `?registreering=` maps to protocols, which matches spec D4. Today that address shows registrations, so the change is intended. OK. |
| T3 | OK. |
| T4 | OK. |
| T5 | OK. |
| T6 | OK. |
| T7 | OK. |
| T8 | The 21.10 test time 09:04Z shows as 12:04 in Tallinn, which is right (EEST runs until 25.10). OK. |
| T9 | Covered by the T9 ↔ T10 ruling above. |
| T10 | OK. |
| T11 | OK. |
| T12 | OK. |
| T13 | OK. |
| T14 | OK. |

No test mandated by the plan asserts nothing, and no logic block is duplicated.

## Progress
- Task 1: dispatched (base fc856cd, implementer a5b95d6e6ef3ff44f, sonnet)
- Task 1: implementer DONE 8202e60 (concerns: sample-invoice route uses this year — extra beyond brief; prefix upper-cased in January line); review dispatched (reviewer a5974aec3e83d2d72, sonnet)
- Task 1: complete (commits fc856cd..8202e60, review clean)
- Task 1: minor (deferred): stale comment server/actions/admin-invoices.ts:190-191 lists nextYear
- Task 1: minor (deferred): testplan haldus-seaded-arve expect line is December-conditional (vacuous before 1.12)
- Task 1: minor (deferred): a pre-B21 next-year preset in prod settings would make the January line disagree with issue() — check Railway settings.invoice.nextYear before deploy
- Task 1: minor (deferred): pass seaded page's `now` to InvoiceSettings (hydration edge at midnight)
- Task 1: minor (deferred): run admin-invoices e2e on --project=mobile before final review
- Task 2: dispatched (base 8202e60, implementer a316df8c3e161aa2c, sonnet). Ruling: Task 2 adds Section keys protocols/testing to the type and activeSection but no menu rows (Task 3 adds them) — keeps tasks separable — cost: none
- Task 2: implementer DONE_WITH_CONCERNS faf359d (badges stale on soft navigation since the layout persists; ReadyMark now waits for the page's first hydrated element; nav.protocols/testing labels added)
- Ruling: badges must follow soft navigation (spec C2, Review Focus 1) — Task 4 loads counts through a withAdmin GET route the Sidebar refetches on pathname change (and focus), seeded by the layout's server read for first paint — layouts don't re-render on client navigation; template.tsx re-execution is not guaranteed — cost if wrong: one extra small request per navigation
- Task 2: review — Needs fixes (C1 loading.tsx turns panel notFound into HTTP 200, admin-clients e2e red; I2 load test blind to page failures; I3 plan-mandated 300 ms vs React 19 reveal throttle; I4 no testplan check for loading/error)
- Ruling (T2 C1): accept Next's streaming semantics — admin not-found answers 200 with the not-found content + noindex; update the three admin-clients assertions to check the not-found text and meta robots noindex — design mandates (panel)/loading.tsx; admin is noindex and nothing consumes admin status codes — cost if wrong: status-code monitoring can't see admin 404s
- Ruling (T2 I3): measure on the production build; reveal delay becomes 400 ms (still "shown after 300 ms" per README §1.10, clears React's 300 ms throttle); reduced motion keeps the delay with an instant step instead of showing at once — cost if wrong: a slow page shows its grey rows 100 ms later
- Ruling (T2 I4): add one testplan check for the loading and error states (who dim, arvuti, new/deploy) — standing test-plan rule — cost: one more check for Dim
- Task 2: minor (deferred → Task 3 dispatch): phone menu dialog must close when usePathname() changes (Sidebar now persists across navigations)
- Task 2: minor (deferred → Task 4 dispatch): drop the discarded getAdminCounts() calls and stale "shell's counts are read here too" comments in 9 pages once counts are client-refetched
- Task 2: minor (deferred): ReadyMark relies on React's private __reactFiber$ key; add a real-render test and a distinct timeout value
- Task 2: minor (deferred): activeSection vs page parameter parsing differ for repeated params (hand-typed only)
- Task 2: minor (deferred): an app/admin/error.tsx would cover layout failures (not a regression)
- Task 2: minor (deferred): no HTML assertion that the server already marks the active entry
- Task 2: fix round 1 committed b5d4345 (notFound → text+noindex assertions; load test needs h1, rejects data-dgst/$RX(; reveal 400 ms; testplan haldus-laadimine-viga). Measured prod build: fast nav page on screen 328–395 ms, 0/10 grey flashes; held page rows at 424–473 ms
- Ruling (T2): keep (panel)/loading.tsx although React's 300 ms reveal hold makes every soft navigation show the new page at ~330–390 ms (before it came as soon as the server answered) — design README §1.10 mandates loading.tsx; Dim asked to build as designed — cost if wrong: menu clicks feel ~0.2 s slower; remove loading.tsx if Dim prefers speed (report this consequence to Dim at finish)
- Task 2: re-review dispatched (a7abdf9eb5f1c9863, sonnet)
- Task 2: fix round 1/5 (4 addressed, 0 open; commits faf359d..b5d4345)
- Task 2: complete (commits 8202e60..b5d4345, review clean)
- Task 2: minor (deferred → Task 14 docs): record the 400 ms reveal (vs README's 300 ms) in the spec's D-list
- Task 3: dispatched (base b5d4345, implementer ab15c4b3ba5523e4e, sonnet; carries T2 minor: close phone menu on pathname change)
- Task 3: implementer DONE_WITH_CONCERNS bd61d28 (duplicate <aside> during Suspense swap after goto; phone ≡/✕ drawn twice; site link in top line and phone footer; fold aria-disabled while page inside)
- Task 3: review — Needs fixes (I1 top line still shown below 900 px → site link twice on phone/tablet; I2 protocol screen at 768–899 px switches to column layout whose sticky column hides under the 64 px bar; I3 Suspense duplicate sidebar during streaming, fallback differs in fold/bar title, adminReady doesn't guarantee swap)
- Ruling (T3 I3): remove the <Suspense> and SidebarWithoutActive — (panel) is force-dynamic so useSearchParams renders on the server; verify npm run build shows no suspense-boundary error — cost if wrong: a build error, caught at once
- Ruling (T3 I2): the protocol screen keeps its chips layout below 900 px viewport (the course-day iPad upright), correct the file comment — design: Q3 tablet below 900 uses the phone layout — cost: none
- Task 3: minor (deferred): sidebar spacing differs slightly from prototype (aside gap 2px, navWrap margin 16px, phone group gap 10 vs 12)
- Task 3: minor (deferred): fold button aria-disabled keeps pointer cursor/hover while held open
- Task 3: minor (deferred): testplan „avalik“ steps „Ava halduses „Uudiskiri““ now behind the closed fold — add the note to the avalik area, widen wording beyond „Arvutis“
- Task 3: minor (deferred): scroll-margin-top 20px anchors (Seaded cards, TestPlan) land under the 64 px bar at 641–899 px
- Task 3: minor (deferred → Task 5): menu row „Protokollid“ shows not-found until the index lands (same deploy)
- Task 3: minor (deferred): sections.ts missing from old-safari BROWSER_FILES
- Task 3: minor (deferred): menu opened on overview focuses the logo link, not ✕
- Task 3: fix round 1 committed 581bfb4; note: admin-edit.spec.ts:76 (stale RU title on public course page) flakes in several runs — check in Task 14's full run
- Task 3: fix round 1/5 (3 addressed, 0 open; commits bd61d28..581bfb4)
- Task 3: complete (commits b5d4345..581bfb4, review clean)
- Task 3: minor (deferred): ProtocolScreen.tsx:66-67 JSDoc omits the 900 px viewport condition; Shell.tsx:73 styles.whoName has no CSS rule
- Task 4: dispatched (base 581bfb4, implementer ae568ac9fd8a628c1, sonnet; carries the badge-refetch ruling via GET /api/admin/margid and T2's stale getAdminCounts cleanup)
- Task 4: implementer DONE_WITH_CONCERNS 4d593f8 (Hindamine row leaves at once after reopen; route returns hrefs map; Testimine counts own-address Viga; paged moved to db/queries/paged.ts; db/queries/admin.ts imports @/server/testplan — layering)
- Task 4: review — Needs fixes (I1 plan-mandated: components/admin/menu-state.ts missing from old-safari BROWSER_FILES). Ruling: the same fix adds sections.ts (T3 deferred minor, same finding class) — one line each — cost: none
- Task 4: minor (deferred): db/queries/admin.ts imports @/server/testplan (layering; move testPlan to a non-server module or compose ownFaults in a server helper)
- Task 4: minor (deferred): refetch keyed on pathname+search runs 9 queries per drawer open/filter; focus+visibilitychange double request — add ~1 s guard or key on pathname
- Task 4: minor (deferred): after „Ava test uuesti“ on Hindamine the row leaves and ReopenTest's focus/status line is lost (needs a page-level live region)
- Task 4: minor (deferred): testplan haldus-menuu-margid step 4 makes the tester record a false „Viga“ (Telegram ping, no restore); step 3 doesn't exercise the client refetch
- Task 4: minor (deferred): overview reads todaySessions/answers twice; ownFaultCount unguarded in layout counts (a plan-eval bug would take down every admin page)
- Task 4: minor (deferred): admin-menu-route test order dependency (shared beforeAll DB); ReopenTest.tsx:595 JSDoc wrapping
- Task 4: fix round 1/5 (1 addressed, 0 open; commits 4d593f8..ebb9647)
- Task 4: complete (commits 581bfb4..ebb9647, review clean)
- Task 5: dispatched (base ebb9647, implementer af095c0212850ced5, sonnet; B16 via menuOf hrefs.protocols)
- Task 5: implementer DONE_WITH_CONCERNS e654568 (B16 in menuOf; individual rows show „Mustand“/„Alustamata“; e2e can't pin B16 exactly — shared DB)
- Task 5: complete (commits ebb9647..e654568, review clean)
- Ruling (T5): individual rows with a draft say „Mustand“ (existing string) instead of the drawn „Alustamata“ — showing „Alustamata“ on a started protocol would be false; design only draws the empty case — cost: a word Dim may want changed
- Task 5: minor (deferred → ask Dim): a protocol edited after sending counts as sent on the index („✓ Kõik saadetud“) while the screen shows „Muudetud“/„Saada uuesti“
- Task 5: minor (deferred): no rule above the „INDIVIDUAALKOOLITUSED“ label (prototype has the last row's border-bottom); individual list uncapped; identical „Ava“ link names; .smallBtn 12 vs 13 px; order within a day later-first vs overview earliest-first
- Ruling: Tasks 6, 7, 8 (ConfirmPanel, UndoBar, SaveStatus) go to one implementer as a batch — same shape (new presentational client component + DOM test + dict keys), no shared files beyond the dict, each small — cost if wrong: one larger review diff
- Tasks 6-8: dispatched as one batch (base e654568, implementer a6579f6a31658ef68, sonnet)
- Tasks 6-8: implementer DONE 2624dbb, c25e249, 9aa4e0d (ReadyMark skips [data-undo-region]; UndoBar portals into an open dialog; failed undo keeps the button; SaveStatus without time shows „Salvestatud“, gone falls back to „asja“)
- Tasks 6-8: review — Needs fixes (I1 plan-mandated: UndoBar button radius 10 vs prototype pill 99 / padding; UndoBar bar padding/gap/type; ConfirmPanel padding/type/gaps differ from the prototype)
- Ruling (T8): SaveStatus fallbacks „Salvestatud“ (no time), „✓ Mustand“ (no time), gone „asja“ are the design's own strings minus their placeholders, not invented text — consumers must pass `thing` and a time — cost: Dim may want other words
- Tasks 6-8: minor (deferred): undo region inside a dialog not pre-existing (may not be announced); no real-browser e2e of the dialog path (add with first adopter); hung undo() leaves the bar (add ~30 s safety); late failed undo arms a timer after unmount; SaveStatus „Näita“ precedes the live region in DOM order; ConfirmPanel aria-describedby for lines; bar re-parenting may announce twice; autosave.saving duplicates common.saving
- Tasks 6-8: fix round 1/5 (1 addressed, 0 open; commits 9aa4e0d..4704f47)
- Tasks 6-8: complete (commits e654568..4704f47, review clean)
- Tasks 6-8: minor (deferred): prototype desktop UndoBar width differs between Pass:356 (shrink) and Part 2:395 (stretch); B4 contract panel uses a tighter ConfirmPanel spec (per-screen override in piece 3); Katkesta/danger buttons 49 px vs prototype 44 px
- Task 9: dispatched (base 4704f47, implementer a3f886a3ade521f5d, opus). Rulings carried: no guard registration (Task 10); 409 keeps local text, restore() overwrites; lost answer + 409 with stored value == last sent → confirmed; resume a differing local copy as dirty; autosaveHandler is a helper (1 MB → 413)
- Task 9: implementer DONE_WITH_CONCERNS c778301 (engine 604 lines; constants imported from protocol-autosave — must move in piece 2; no 'take server's' call after conflict; local copy rewritten per keystroke, 200k cap; simplified resume)
- Task 9: review — Needs fixes (I1 a refused field equal to confirmed but in an unanswered save is never held back → immediate endless re-send, reproduced; I2 a 400/409 after a failure leaves status retry/signedOut and unconfirmed().reason wrong)
- Ruling (T9 m3 → into the fix): repeating refusals (413, 400 body, 400 naming no patch field, malformed 409) must not be retried every 30 s forever — same defect class as I1 (refusal handling) in the base every editor uses — stop retrying and report a terminal status (invalid for 400 with fields, else "error" kind via unconfirmed().reason = "error" with status retry? → use status `invalid` only for field errors; for the others stop retrying and keep status `retry` WITHOUT a timer is the bug — so: mark them as a non-retryable error and surface it via unconfirmed().reason="error"; status kind stays `retry` but no further sends until the next edit) — cost if wrong: a stuck edit needs a new keystroke to resend
- Task 9: minor (deferred → piece 2): move DEBOUNCE/RETRY/KEEPALIVE/SAVE_TIMEOUT constants to autosave/constants.ts re-exported by protocol-autosave.ts (avoid chunk bloat and the piece-2 cycle)
- Task 9: minor (deferred): simplified resume may drop an idle tab's conflict copy; per-keystroke copy writes OK unless old iPads lag; keepalive rarely used when visibilitychange precedes pagehide (copy covers it); useAutosave status recomputed per render with inline label; zod default English messages as field codes; arrayBuffer read before size check without content-length; listener-removal tests for visibilitychange/pageshow
- Ruling (T9 m3, final wording): non-retryable refusals (413, 400 body, 400 naming no patch field, malformed 409) stop the timer; status stays retry, unconfirmed().reason = "error"; the next setField, focus or online sends once — no new status kind — cost if wrong: a refused save waits for the next edit
- Task 9: fix round 1/5 (3 addressed, 1 new Important — stale retry after wait() when the next edit leaves nothing to send; commits c778301..224e48e)
- Ruling (T9 r2): fold in the one-line race fix — add a 400-named field to serverInvalid only if its value is unchanged since the save — same root cause, one line — cost: none
- Task 9: fix round 2/5 (2 addressed, 0 open; commits 224e48e..171fb7e)
- Task 9: complete (commits 4704f47..171fb7e, review clean)
- Task 9: minor (deferred): after a 401/403, an edit typed back to the confirmed text leaves the chip at signedOut until the next armed retry (unconfirmed() already null); unreachable wait() guard at engine.ts:408; engine.ts 641 lines
- Task 10: dispatched (base 171fb7e, implementer a4a643bc9d2bf4489, opus). Rulings carried: useAutosave registers as a guard source (adds focusField/title options); confirmClose kept @deprecated for the lesson drawer and not double-asked; sources always supply a label (no field-less sentence — design has one sentence)
- Task 10: implementer DONE_WITH_CONCERNS fcaa034 (no real-browser e2e of notice/3 s wait/Back until an editor adopts useAutosave; Back hold depends on listener order; route change during wait cancels a drawer close)
- Task 10: review — Needs fixes (I1 regression: a dismissed file picker's bubbling `cancel` now closes the lesson drawer; I2 plan-mandated: test-plan check can't cover "menu click keeps unsaved text" yet)
- Ruling (T10 I2): waived for piece 1 — no editor adopts useAutosave yet, so no person can exercise the guard — tracked: piece 2's first autosaving editor rewords haldus-lahkumine-salvestamata (same id) to add offline + menu click / Back / ✕ — cost if wrong: the guard ships untested by hand until piece 2
- Task 10: minor (deferred): held link loses replace/scroll={false}; same-pathname links inside an open drawer count as leaving it; null-state popstate (hash) held in a drawer (start onPop with `if (!e.state?.__NA) return;`); „Jää siia“ for a page source while a drawer is open can't focus behind the modal; listener-order and Chrome history-manipulation intervention to verify in piece 2's real-browser e2e; route change during a drawer wait cancels ✕ silently; LeaveGuard.module.css repeats ui.btn metrics; npm run build not in T10's verification
- Task 10: fix round 1/5 (1 addressed, 0 open; commits fcaa034..5f1b107)
- Task 10: complete (commits 171fb7e..5f1b107, review clean)
- Task 10: minor (deferred → piece 2): add a test-plan step for dismissing a file picker in the lesson drawer; PhotoViewer/ChangeRequestDialog/PopupDialog/Lightbox have the same unguarded onCancel (no file inputs today)
- Task 11: dispatched (base 5f1b107, implementer ad56e3d36661cb5fe, opus). Rulings carried: version null = create; publish = one tx, FOR UPDATE, base_version vs liveVersion, blocked listed by labels only (no invented sentence — ask Dim); eelvaade route with ?lopeta=1 to leave draft mode
- Task 11: implementer DONE 4d8fe33 (0017 applied to local Docker DB only; blocked fields listed without a sentence; mock line „Avalikul lehel on näha eelmine versioon.“ left out; phone bar fixed bottom; save to a deleted draft → conflict version 0 value null)
- Task 11: review — Needs fixes (C1 open redirect in previewPath: dot segments /.//host → Location https://host/, also via ?lopeta=1; reachable from an e-mail link with SameSite=Lax)
- Ruling (T11): leave out „Avalikul lehel on näha eelmine versioon.“ — only 1 of 5 desktop bars draws it, README silent; built as README's literal "count + labels" — ask Dim at finish (one dict key) — cost: none if Dim wants it, one line
- Task 11: minor (deferred): discard vs publish lock order can deadlock (40P01, no data lost) — document lock order; liveVersion "must" read under the writer's lock (+ test with the first publisher); draft mode outlives logout (pieces 3–4: disable at logout / check session before reading drafts); PublishBar unmount drops focus; only-blocked render shows „…: 0“ with buttons; blocked list has no sentence/live region (Dim wording); JSON null value → 500 (validate in the adapter); draft store numeric versions vs C1 string versions (adapter); analysis/behaviours.md still says UX pass starts at 0018
- Task 11: fix round 1/5 (1 addressed, 0 open; commits 4d8fe33..823bb88; 300k random hostile inputs: no off-site Location)
- Task 11: complete (commits 5f1b107..823bb88, review clean)
- Task 11: minor (deferred): a malformed % in a legit tee path goes to /; tee may point to another same-site redirecting route (audit other redirects in the final review)
- Task 12: dispatched (base 823bb88, implementer a8367dd9bcd97ffac, sonnet). Rulings carried: SSR renders ET then stored choice after mount; PreviewLangSwitch only for the two previews; Faq/ListEditor rows follow context
- Task 12: implementer DONE_WITH_CONCERNS 48862b2 (lesson drawer modal → page switch inert inside it; Seaded switch only at the top; „tõlge tulekul“ shows in ET mode as the prototype; 3 'new' checks re-marked 'reworded' and a pin changed; edit lang is an external store to keep SSR HTML)
- Task 12: review — Needs fixes (I1 „RU puudub“ count/„Järgmine →“ miss collapsed slides on Avaleht; I2 haldus-ru-tekst gained an expectation under `reworded`; I3 test plan ignores the remembered language between checks)
- Ruling (T12 m4 → into the fix): haldus-keel-lehel first empties one or two RU fields (no save) so the count line, „Järgmine →“ and „Kopeeri“ show — same check, same file as I3 — cost: none
- Ruling (T12): popup/newsletter previews keep PreviewLangSwitch in piece 1 (brief); the design's "preview follows the page switch" lands with C4 (piece 4, Hüpikaken as Part 4) and B5 (piece 3) — cost: none
- Task 12: minor (deferred): page-header mockups show bare „ET | RU“ without „Sisu keel“ (label sanctioned by strings G12); I18nInput lang/onLangChange removed rather than ignored; lesson drawer has no switch (design faithful; RU-mode ET error can't be fixed inside — ask Dim); PreviewLangSwitch dead missingRu prop; LangStore reads localStorage per snapshot and one storage listener per field; cross-tab sync flips other tabs; ET-mode „tõlge tulekul“ not linked via aria-describedby
- Task 12: fix round 1/5 (3 addressed, 0 open; commits 48862b2..5ff6390)
- Task 12: complete (commits 823bb88..5ff6390, review clean)
- Task 13: dispatched (base 5ff6390, implementer a1e65b5d0f5c4cc5a, sonnet). Rulings carried: no per-page search adoption now (screens later); withListParams copies all params except id unless href sets them; whole-row technique must work on iOS 15–16 (tr position:relative caveat)
- Task 13: implementer DONE 4f25b66 (td-positioned overhanging ::after clipped by the card — not verified on iOS 15–16; controls z-index 2; list-params.ts split for server use; --row-highlight token)
- Task 13: review — Needs fixes (C1 card overflow:clip + 760 switch silently cut Registreerimised/Maksed columns at 761–1360 px, and at every width on iOS 15 via the hidden fallback; I1 three page stylesheets still switch at 980; I2 a pending search/scope can be dropped by Next discarding the older replace; I3 the row check misses the tablet and says "heledaks")
- Ruling (T13 C1): drop the overhanging ::after and the card clip; the whole row becomes clickable through one delegated client click handler per list card that forwards a plain pointer click (no selection, not on an interactive element, no modifier) to the row's name Link — the Link stays the keyboard/AT target; works on old Safari; keeps text selection — cost: a small client component per list card
- Ruling (T13 C1/I1): the shared list-table switches at 760 (design); Registreerimised and Maksed keep a 980 override (list-table and their own page CSS) until their screens (A2, A6 in piece 2) drop columns, Tagasiside moves its page rule to 760; an e2e asserts table.scrollWidth ≤ card content width for every list at 1180, 1280 and 1360 px — cost if wrong: two lists turn into cards 220 px earlier than designed until piece 2
- Task 13: fix round 1/5 (4 addressed, 0 open; commits 4f25b66..cc8a55c)
- Task 13: complete (commits 5ff6390..cc8a55c, review clean)
- Task 13: minor (deferred): .stackAt980 has one class more specificity than the 760 block → Maksed stacked cells lost ui .table td padding/line while Tunnistused keeps them (give the 760 block the same specificity); width e2e never measures Registreerimised/Maksed table mode (add 1366, 1440); iOS tap highlight would paint the whole table (wrapper -webkit-tap-highlight-color: transparent + :active row tint); admin-inbox.spec.ts:494 mail-link check passes by its own preventDefault; ListToolbar stale `sent` entries when a replace equals the committed address
- Task 14: dispatched (base cc8a55c, implementer a80a0eeb3fa6bb441, sonnet; docs + full unit/e2e run; no stamp, no push)
- Task 14: implementer NEEDS_CONTEXT 1ff3ce1 (docs done; unit 5380 pass, build clean; e2e 840 passed / 8 failed / 194 skipped — 7 public desktop specs 15 px short from the global html { scrollbar-gutter: stable } (Task 3); flakes course:552, newsletter-campaigns:334)
- Ruling (T14): scope scrollbar-gutter: stable to the admin only — the admin root <html> gets an admin-only marker and the rule moves to an admin-only stylesheet; the public site is out of scope (spec §11) and its layout must not change — reword the launch-checklist line accordingly — cost: public pages keep their old scroll-lock shift (pre-existing)
- Ruling (T14): the five checks whose steps were swept „Maksed“ → „Maksed ja arved“ get `"mark": "reworded"`, `"markedAt": "deploy"` (standing rule: changed wording is marked) unless they already carry redo/new — cost: five checks shown as reworded to the testers
- Task 14: implementer DONE 1ff3ce1 + 456416a (gutter scoped to html[data-admin]; five checks already carry new/redo, left as is; full unit pass; 7 public specs pass; flakes pass alone)
- Task 14: review — Needs fixes (I1 launch-checklist.md:55 claims the lesson drawer asks the guard — false; no screen uses the guard yet)
- Ruling (T14 I1): keep the unsaved-warning item open `[ ]` with the note "the guard is built in the panel layout; no screen is on it yet — the lesson drawer keeps confirmClose until piece 3, editors keep beforeunload until pieces 2–4"; fix behaviours.md:913 (stale 0017 wording) in the same commit — cost: none
- Task 14: minor (deferred): gutter rule scoped by selector in the shared globals.css (not an admin-only stylesheet) — deliberate, test-pinned; phone menu has no root scroll lock (README wording); stamp/migrate order inconsistent across deploy.md §14/§15/§20; D8 wording "does not fit 761–979" vs table starts at 878
- Task 14: fix round 1/5 (1 addressed, 0 open; commits 456416a..985a4b8)
- Task 14: complete (commits cc8a55c..985a4b8, review clean)
- Task 14: minor (deferred): behaviours.md 713/719/842 keep the old 0017 clash as history; eelvaade/route.ts:5-7 and Drawer.tsx:44-46 comments describe intent not yet wired
- Final review: dispatched (fc856cd..985a4b8, a2d8ee0214a470802, opus)
- Final review: With fixes (I1 Shell's unguarded badge counts take down every admin page on a throw; I2 lesson drawer RU trap — Dim; I3 testplan haldus-menuu-margid step 4 leaves a false Viga; m4 iOS tap highlight flashes the whole list; m5 deploy smoke address /admin/xyz falls to the public 404; plus the avalik fold note)
- Ruling (final): one fix wave for I1, I3, m4, m5 and the avalik area note; I2, T5's sent-counting and D7's speed tradeoff go to Dim before deploy — cost: none
- Final fix wave: 40b5ddb, 22782c8, 1296207 (counts guarded + app/admin/error.tsx; iOS tap; testplan restore + avalik note; smoke address /admin/opilased/999999999/vaade); vitest 5392 pass, build clean
- Final fix wave: re-review — all addressed (commits 985a4b8..1296207)
- Final: parked — haldus-menuu-margid step 4 should pick a check already answered „OK“ (no way to clear an answer) — Ruling: fix together with the deploy stamp commit — cost: a false „OK“ if the tester picks an unanswered check
- Final: parked — no test-plan line for the iPhone row-tap tint — Ruling: add with piece 2's list screens — cost: unverified on iOS until then
- Final: parked — Shell.tsx:19 comment says the refetch fills badges "a moment later" (it waits for navigation/focus); deploy.md §20.6 calls the smoke page "the panel's" not-found (it's the student view's)
