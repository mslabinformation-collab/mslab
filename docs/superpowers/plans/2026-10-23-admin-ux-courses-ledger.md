# Admin UX pass, piece 3a (Koolitused and the course editor) — build ledger (rulings and deferred items)

Copied from the SDD workspace when piece 3a finished (25.10.2026). Every `Ruling:` line is a decision taken during the build on Dim's behalf; Dim's answers of 24.10 (D-1…D-8) are in analysis/piece3-texts.md; the whole-branch review (2026-10-23-admin-ux-courses-final-review.md) triaged every parked item (the parked list follows the ledger).

# SDD ledger — plan: docs/superpowers/plans/2026-10-23-admin-ux-courses.md

Spec: docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md (§8 item 3; piece 3 split into 3a (this plan: B1, B2, B18) and 3b (B3–B5)); texts analysis/piece3-texts.md (Dim 23.10 "Ok"). Plan approved by Dim 23.10 ("Yes"). Branch feat/admin-courses from main. constraints.md holds Global Constraints + Rulings R-a…R-h.

## Pre-flight scan

| Pair / task | Produces → consumes | Found |
|---|---|---|
| T1 → T3, T8, T9 | DragList (onMove, labels, announce) | consistent |
| T1 → T7 | SectionMap + card scroll-margin class | consistent |
| T2 → T5, T9, T10 | unpublished flags, removed_at, video_progress, purge | consistent |
| T3 ↔ T4 | list `changes` flag reads content_drafts entity course (T4 writes them) | consistent; T3 before T4 → flag false until drafts exist |
| T4 → T5 | course-parts.ts outline part added in T5 | consistent (T5 modifies course-parts.ts) |
| T4 → T6 | drafted parts overlay | consistent |
| T4 → T7 | routes, versions, courseChanges, publish blocked shape | consistent |
| T5 → T9, T10 | move/add/flag behaviour; outline draft for texts | consistent |
| T7 ↔ T8 ↔ T9 ↔ T10 | CourseEditor cards host list editors / lessons card; [id]/page.tsx touched by T7, T9, T10 | sequential |
| T10 ↔ T11 | lesson video field shows progress (T11 provides it; T10 builds the drawer) | T11 after T10: T10 shows the tag via AdminLesson.videoProgress from T2 (null until T11) — fine |
| T2 ↔ T12 | sweep JSON (T2) / docs (T12) | consistent |
| T4 self | lock-order test via query log | consistent |
| T6 self | ISR must stay static (build check) | consistent |
| T7 self | removes the old save bar → admin-fab-avoid list | consistent |
| T10 self | removes Drawer confirmClose → drawer-dom tests, db page stubs, dict keys | consistent |
| plan-mandated defects | none found | — |
- Task 1: dispatched (base 5574755, implementer a0899abc77b2af425, sonnet)
- Controller: plan 3b written and committed (docs only, during Task 1); Task 1 review base = last controller commit before the implementer's first
- Dim 23.10 (night): "full authority to proceed. I approve everything recommended." → plan 3b approved; build 3a → review → deploy (migrate 0020 first) → build 3b → review → deploy; report when he is back
- Task 1: implementer DONE_WITH_CONCERNS eff3bda (unit 4000; DragList ol>li — Task 3's table needs a wrapper; arrows aria-disabled; drag starts from the handle at once (Part 4 draws long-press); no edge auto-scroll; money-text names vs domain/invoice euro)
- Ruling (T1): handle drag starts at once — only the handle drags, so no conflict with page scrolling; long moves use ↑/↓ and the phone menu — cost: no long-press
- Carry → Task 3: DragList renders ol>li; the course list needs a grid/list layout or a table variant
- Task 1: review — Approved (I-1 no moveTo hook for the phone menu; minors: focus steal, modifier arrows, --drag-dy on ol, capture throw leaves a session, select change on ArrowDown, option text, sectionCard in client file, nearest-centre jump, duplicate arrow keys, clash note one-way)
- Ruling (T1): SectionMap select option text `{label} · {status}` accepted (sourced words; keeps the RU signal on phones) — cost: none
- Ruling (T1): leave M-5 (select change on ArrowDown, per brief), M-7, M-8; M-9 (old arrow keys) deleted as Tasks 3/8/9 migrate — cost: none
- Task 1: fix round 1/5 dispatched (I-1, M-1–M-4, M-10)
- Task 1: fix round 1 → 7a177b9 (moveTo hook + menu tool, focus guard, modifiers, --drag-dy on li, capture-throw supersede, clash note; mutation-checked) — complete (commits 542ab0e..7a177b9)
- Task 2: dispatched (base 7a177b9, sonnet)
- Task 2: implementer DONE bbb74de (281 relevant db tests; migration-0003 test fixed to select its own columns; account-ecourse/lesson-player e2e pass; 0020 on local DB)
- Carry → Task 10: call purgeRemovedLessonFiles at the start of the lesson-file actions and the editor page read; deleteLessonFileForm becomes the soft delete
- Task 2: review — Approved (forward notes: moving a published lesson into an unpublished module hides it at once → Task 5 must refuse or draft it; purge not yet called by listCourseLessons → Task 10; purge R2 deletes unbounded → Task 10 add a per-run limit; positions may repeat after undo → Task 10; deploy.md §5 sweep JSON → Task 12; admin contact preview hides unpublished modules → Task 6 decides)
- Task 2: complete (commits 7a177b9..bbb74de)
- Task 3: dispatched (base bbb74de, sonnet)
- Task 3: implementer DONE_WITH_CONCERNS 406a7ea (CSS grid rows on DragList ol>li + ListRows li selector; unit 4056, db 54; e2e list-widths + admin-edit order desktop/phone incl. real touch drag; haldus-loend-terve-rida kept redo; 761–1039 two-line row layout undesigned; MoreMenu variant icon + disabled items)
- Task 3: review — Needs fixes: I-1 eight columns only from a 1040 px card (≈1423 px viewport); minors: undefined styles.status, moveCourseTo READ COMMITTED stale-order hazard, stale comment, click inside an open menu opens the row, icon menu without name, phone rows not separate cards (Part 4), testplan says "tabel"
- Ruling (T3): eight columns from a ~940 px card (content-sized band 940–1039) — reasonable-person laptop/iPad view — cost: none
- Ruling (T3 M-6): phone rows as separate cards per Part 4 (built as designed) — cost: differs from other phone lists
- Ruling (T3 M-2): lock by id, then read by sort — no stale-order move — cost: one extra statement
- Task 3: fix round 1/5 dispatched
- Task 3: fix round 1 → 225f7e8 (band 998–1097 of the .box container (= 940–1039 card content); lock by id then read by sort, proven by a new real-Postgres course-order-race e2e; menu clicks don't open the row; icon menu name; phone cards; testplan reword) — controller looked at the 1366 and 390 screenshots: eight columns / cards as designed — complete (commits bbb74de..225f7e8)
- Task 4: dispatched (base 225f7e8, opus)
- Task 4: implementer DONE_WITH_CONCERNS c52b46a (unit 4062, db 2463; drafts.ts gained Publisher lock/hold hooks, publishDraftsIn, dropDraftPart; domain/course-parts.ts for the browser; implementer rulings: a draft typed back to live is dropped, a refused R-d rolls back the whole publish, the publish price rule only when price/basics publish, slug taken / type locked meanwhile = "changed")
- Carry → Task 7: on an unpublished course a type change empties the other type's parts (new versions) — the editor must re-read them or the next save conflicts
- Task 4: review (opus) — Needs fixes: I-1 a stale tab's d:<n> overwrites a newer draft after publish/discard/drop (probe-proven); minors: price check on title-only basics, duplicate fieldCodes, unlocked full read before write, old editor can unpublish without R-d (→ Task 7), publish must clear flags with no drafts (→ Task 5)
- Ruling (T4 I-1, amends R-b): draft version = d:<draftId>.<n> — unique per draft — cost: none (controller doc commit)
- Ruling (T4 M-1): the publish price check applies to basics only when the type changes — cost: none
- Carry → Task 7: until the old editor goes its „Salvesta“ can unpublish without R-d (M-4) — Task 7 removes it
- Carry → Task 5: publish clears flagged rows and revalidates even with no drafts (M-5)
- Task 4: fix round 1/5 dispatched
- Task 4: fix round 1 → fd4c799 (d:<id>.<n>, engine resume gets 409, M-1, M-2, M-3; mutation-checked) — complete (commits 225f7e8..fd4c799)
- Task 5: dispatched (base fd4c799, opus; + M-5 and Task 2's move-into-unpublished-module note)
- Task 5: implementer DONE_WITH_CONCERNS f45c3d4 (db 2491, unit 4060 + 3 load timeouts passing alone; admin-lessons/account-ecourse e2e pass; outline = one part; new rows' position = working order; a live lesson into a new module drafts the module as a container; instant deletes remake the outline draft; discardCourse returns {discarded, cleanup}; course-outline.ts added)
- Task 5: review (opus) — Needs fixes: I-1 one outline part can't carry Tasks 9/10's per-field autosave (engine-vs-engine conflicts in one page, whole-outline saves, 64 KiB/1 MB limits); minors: deletable flag, whole-outline save loses flagged places, rebase absorbs stale drafts, addLessonForm checks live type (→ Task 9), untested container/blocked paths, stale casts
- Ruling (T5 I-1, amends R-b): keep one outline part for storage/publish; text autosave per row through /api/admin/moodul/[id] and /api/admin/oppetund/[id] with t:<row text hash> versions; whole-outline writes via /osa/outline refused — cost: two routes
- Ruling (T5): accepted — working-order model for flagged rows; container entries for a flagged module holding a drafted live lesson; a blocked outline keeps its flags; discardCourse returns {discarded, cleanup}
- Carry → Task 9: addLessonForm must follow the drafted type (M-4); use the moodul route for inline titles; hide/explain „Kustuta moodul“ via AdminModule.deletable
- Carry → Task 10: the drawer's name/text use the oppetund route
- Task 5: fix round 1/5 dispatched
- Task 5: fix round 1 → fdf8ef0 (row text routes with t: versions, /osa/outline refuses writes, deletable, guarded rebase, container/blocked tests; mutation-checked) — complete (commits fd4c799..fdf8ef0); plan R-b2 added (controller doc commit)
- Task 6: dispatched (sonnet; + Task 2 note: preview shows flagged rows and drafts)
- Task 6: dispatched (base a62d07a, implementer a0846b6f2d8e40de7)
- Task 6: implementer DONE_WITH_CONCERNS 2f4e263 (unit+db 6589; course page and catalogue still ISR (manifest identical); new prod-build e2e admin-eelvaade; mutation-checked; only course page + catalogue preview drafts; draft-mode cookie lingers after logout (pages uncached for that browser); preview keeps the live slug → Task 7 previewHref uses the live slug)
- Carry → Task 7: previewHref uses the live slug
- Task 6: review — Approved (I-1 draft mode has no exit and no sign on public pages; spec C3's preview-page „Loobu muudatustest“ unowned; minors: logout keeps the draft-mode cookie, overclaiming comment, move case missing, dead previewOutline, per-course readDrafts in catalogue)
- Ruling (T6): Task 6 fix round owns the exit (Vaata kodulehte + logout disable draft mode) and the Part 4 preview bar on the course page (draft-mode branch only; texts from the frame, D1) — cost: one round
- Task 6: fix round 1/5 dispatched
- Task 6: fix round 1 → 27e0edf (Vaata kodulehte + logout disable draft mode; course-page preview bar „Avaldamata {n}“ + exit + „Loobu muudatustest“ via ConfirmPanel lazy-loaded (admin CSS kept off visitor page); readDrafts only/except; move case; previewOutline removed; build ISR kept; e2e 5 pass) — concerns: exit link words = „Vaata kodulehte“ (no frame); failed discard silent (no design words); catalogue no bar
- Task 6: re-review 1 dispatched (sonnet)
- Task 6: re-review 1 (sonnet) — all addressed, no new Critical/Important; minors: previewChangeCount reads the test draft into memory (count only leaves), logout endDraftMode before deleteSession outside try, PreviewBar.module.css hard-coded #b9b1b5
- Task 6: complete (commits a62d07a..27e0edf)
- Park → final review: logout — call endDraftMode after deleteSession (keeps "logout works when things around it fail"); PreviewBar #b9b1b5 → token; previewChangeCount no-key variant optional
- Ruling (T7): a failed publish/discard (5xx/network) shows the existing fallback „Salvestamine ei õnnestunud. Proovi uuesti.“ (ADM:162); 401 shows the existing „Logi uuesti sisse.“ (ADM:203-207); the preview page's bar gets the same fallback as a prop — no design words exist, existing strings reused per piece3-texts reuse rule — cost: one string swap if Dim wants other words
- Ruling (T7): exit link words stay „Vaata kodulehte“ (Task 6) — listed for Dim
- Carry → Task 7: testplan marks for Task 6's behaviour (logout and „Vaata kodulehte“ end the preview; the course page's preview bar) go into the new haldus-koolitus-mustand-eelvaade / haldus-koolitus-loobu items
- Ruling (T7): no koolitused/uus/page.tsx exists — the explicit new-course flow lives in [id]/page.tsx's "uus" branch (parseId) — cost: none
- Task 7: dispatched (base 27e0edf, opus, implementer a0b63f708a90c8dcc; carries: live-slug previewHref, re-read after type change, Salvesta removed, testplan for Task 6; ruling: failure line ADM:162 / 401 line, also on PreviewBar)
- Task 7: implementer DONE_WITH_CONCERNS ee347e0 (vitest 6626; e2e admin-edit 35, lessons 8, certificate 6, protocols 18, site 25, eelvaade 5; piece-1 parts extended: PublishBar blocked shape + error line, LeaveGuard notCreated, I18nInput unpublished; cards re-read after publish/discard/switch/type change; side column before cards <1180 (README); side column not data-fab-avoid (bubble moved over button); chip fixed width; checkboxes where frame draws toggles; extra testplan haldus-koolitus-uus; P-5 Seaded hints → 3b)
- Task 7: review dispatched (opus; named risks: checkbox vs frame toggles, side column order <1180 README vs Part 4, fab-avoid, piece-1 part changes, fresh re-read losing pending edits, Lisa koolitus placement)
- Task 7: review (opus) — Needs fixes: I-1 discard resumes held-back/conflicted local copies (fields not live after „Loobu muudatustest“); I-2 type-change/publish/discard re-read window: remount steals focus, text typed in the window → spurious conflict; I-3 „Avaldamine“ card drawn as switches „Avalikul lehel“ / „Näidissisu“ (Part 3 L111, Part 4 L61, strings.md L300), built as checkboxes „Avaldatud“ with hints; minors M-1…M-7
- Ruling (T7 I-3): build as drawn — a shared admin Switch (input checkbox role=switch, 48×28 track, ≥44 px row, focus ring, reduced motion) labelled „Avalikul lehel“ and „Näidissisu“, no hints (frames draw none; errors still show); the plan's „Avaldatud“ names the field, not its label (D1: desktop frame decides) — cost: e2e/testplan label change; Task 10 reuses the Switch for „Õpilastele nähtav“
- Ruling (T7 I-2): cards inert + aria-busy while awaiting the re-read; restore focus only when it is on <body> or still on the captured control — cost: cards untouchable for one RSC round trip
- Ruling (T7): take M-1 (· avaldamata on every labelled part field), M-2, M-3, M-4, M-5, M-6; M-7 optional
- Carry → Task 10: „Õpilastele nähtav“ uses Task 7's admin Switch
- Task 7: fix round 1/5 dispatched
- Task 7: fix round 1 → e5dc51b (discardCopy on engine; cards inert while re-reading; shared admin Switch „Avalikul lehel“/„Näidissisu“; M-1…M-6 + M-7 filter dedupe; TestEditor unpublished prop; phone course-order e2e ignores other project's new course; vitest 6634, admin-edit 35, lessons 8)
- Task 7: re-review 1 dispatched (opus)
- Task 7: re-review 1 (opus) — all addressed, no Critical/Important; new Minors N-1 discarded engines mute (text lost, no leave guard) if the re-read is given up; N-2 type-moving freeze recurs on retries/basics edits when the type save doesn't end in a remount (focus pulled, keys dropped); N-3 gallery upload landing in the freeze dropped; residual: publish/switch POST window unfrozen; out-of-scope: PreviewBar discard leaves the editor's copies in that browser
- Ruling (T7): take a round 2 for N-1, N-2, N-3, the POST window and the PreviewBar copies — they lose typed text or steal focus, and the resumed agent holds the context — cost: one round
- Task 7: fix round 2/5 dispatched
- Task 7: fix round 2 → fcbcf62 (freeze from press through POST to re-read; discard always restarts, re-read re-asked every 15 s; type freeze follows its own save; gallery upload during freeze kept; PreviewBar discard drops the editor copies via a non-admin module; vitest 6642, admin-edit 35, eelvaade 5; tests written after fixes, each mutation-checked by revert)
- Task 7: re-review 2 dispatched (opus)
- Task 7: re-review 2 (opus) — N-1, N-2, POST window, PreviewBar copies addressed; N-3 NOT addressed (real upload callback bypasses the queue; test drives a path inert forbids); new NB-1 Important: a type click during a basics conflict freezes the editor for good (commit sends nothing, typeWaiting never ends); NB-2 a lost type answer confirmed by a 409 never re-reads; NB-3 refused switch leaves focus on body; NB-4 posting freeze unbounded
- Ruling (T7 round 3): every freeze gets an upper bound (SAVE_TIMEOUT_MS) after which the cards are released and the editor re-reads (outcome unknown → read, never a failure line) — removes the "inert forever" class; typeAsk only when the type commit actually sends; confirmed also from a 409 that matches what was sent; refocus the switch after a refusal; N-3 via a latest-ref onUploaded (or a stable update) with a test whose upload is pending at the press — cost: one round
- Task 7: fix round 3/5 dispatched
- Dim 24.10 (AskUserQuestion): D-1 preview exit link „Lõpeta eelvaade“ (replaces „Vaata kodulehte“ on the preview bar); D-2 failure lines per action: publish „Avaldamine ei õnnestunud. Proovi uuesti.“, discard „Muudatustest loobumine ei õnnestunud. Proovi uuesti.“ (401 stays „Logi uuesti sisse.“; editor bar and preview bar); D-3 switch label „Avalikul lehel“ (as built); D-4 catalogue /koolitused gets a slim preview bar in draft mode: „Eelvaade“ + „Lõpeta eelvaade“, no discard; ISR kept, same gating and lazy import as the course page
- Ruling: D-1, D-2, D-4 go to the Task 7 implementer with round 3 (same files: SavedCourse post(), PreviewBar, preview-bar.ts) — piece3-texts.md gets a „Dim 24.10“ section in a controller doc commit after Task 7 closes; the 761–1039 two-line Koolitused row stays as built (not asked; told Dim)
- Task 7: fix round 3 → f09c18b (one bounded hold for every wait; type waits only for its own send; 409 confirms type; refocus; update routed at call time (N-3); D-1/D-2/D-4 in; vitest 6657, admin-edit 35, eelvaade 6 incl. catalogue; report section pasted by controller)
- Task 7: re-review 3 dispatched (opus)
- Task 7: re-review 3 (opus) — all addressed (N-3, NB-1…NB-4, test title; D-1, D-2, D-4, testplan); no Critical/Important; Minors NB3-1 shared hold ended by first owner (publish/discard pressable during a switch wait), NB3-2 post-bound read can restart a card older than a save made meanwhile (false conflict), NB3-3 type flow inert up to ~2× bound; D-1 constraint gap: „Lõpeta eelvaade“/„Eelvaade“ constants in server/preview-bar.ts not adminEt; nits: liveSeeds no .catch (insecure context → inert), ear nulled on published flip, sample bound restarts after release, ms aborted-hold window
- Ruling (T7): close Task 7 — degraded-path minors after 3 rounds, nothing lost in any of them; park for the final fix wave: NB3-1 (publish/discard return while a hold is set, or PublishBar busy while waiting), D-1 strings into adminEt (reuse publish.phonePreview for „Eelvaade“), liveSeeds .catch → release + reread; accept NB3-2 / NB3-3 / other nits as known (false conflict at worst, after a 10 s server stall) — cost: a rare false „Muudeti teises aknas“ on a slow server
- Task 7: complete (commits 27e0edf..f09c18b; + controller doc 4cfdb45)
- Park → final review: NB3-1, D-1 strings → adminEt, liveSeeds .catch (see ruling above); also Task 6's parked items
- Carry → Task 8: list editors are hosted by Task 7 cards whose `update` goes through SavedCourse's call-time `route` (N-3) — keep removal/undo/move going through the card's api, never a captured engine; list editors get the „· avaldamata“ tag on their label when their part is drafted (like TestEditor's `unpublished` prop, re-review 1 M-1 note)
- Task 8: dispatched (base 4cfdb45, opus, implementer a7fe297b30f861e84; carries: call-time route for undo/move, „· avaldamata“ on list labels, gallery undo never loses the stored image, errors mapped to row ids at answer time)
- Task 8: implementer DONE_WITH_CONCERNS 7c280fe (vitest 6699; admin-edit 35 (one flaky Task 3 phone finger drag, passed alone + rerun), site/protocols/certificate pass; arrows on pictures/questions now read the row form „Liiguta rida {n} üles“ (DragList unchanged); phone UndoBar covers PublishBar „Avalda“ 8 s; trainer gallery (piece 4) gets drag + UndoBar via shared editor, errors positional there; options: undo, no drag; stored image never deleted on removal)
- Task 8: review dispatched (opus; risks: generic row names on pictures/questions vs S3-P3-m, phone UndoBar over PublishBar, trainer gallery, options no drag + debounced add/remove, undo in conflict, flaky phone drag)
- Task 8: review (opus) — Needs fixes: I-1 row keys from a module counter rendered in SSR never match after hydration → DragList focus return fails on hydrated rows (outcomes, includes, stages, certificate lines, Praktika); minors M-1 arrow nouns lost (imageUp/testUp), M-2 phone UndoBar covers PublishBar „Avalda“/SaveBar „Salvesta“ 8 s (design gap; e2e hides it with Esc), M-3 four editors duplicate live-ref/change/undo-focus, M-4 silent no-op undos, M-5 gallery remove by content vs undo by key, M-6 UndoBar outlives navigation, M-7 question-undo focus by index, M-8 gallery/works hints still say „või lohista pilti“; risk 6: Task 3 phone drag flake pre-existing (list re-read during a press)
- Ruling (T8): I-1 useId-seeded keys + SSR→hydrate test; M-1 DragList optional arrowNames keeps the shipped per-noun strings (no new words); M-2 the UndoBar stacks above a phone bottom bar (PublishBar phone bar, SaveBar) via a CSS variable the bar sets — layout only, no words; mobile e2e drops the Esc presses and asserts „Avalda“ is pressable while the UndoBar shows — tell Dim; M-3 one useListRows hook; M-5 remove by key; M-6 an editor's client-state undo is dismissed when the editor unmounts; M-7 focus by id; M-8 drop the drag clause from the two hints (shorter text, no new words); M-4 leave — cost: one round
- Park → Task 12 / final: Task 3 phone course-order drag flake (list re-read cancels a press) — note in the e2e or make the seed rows isolated
- Task 8: fix round 1/5 dispatched
- Task 8: fix round 1 → fecea70 (useId keys + hydration test; arrowNames; UndoBar above phone bottom bar via --admin-foot (SaveBar sets it at all widths); useListRows; gallery by key; M-6 dismiss by list (survives same-list remount); focus by id; hints shortened; e2e fixtures: writeBack no longer restores sort mid-run + new-course test takes the order lock (fixes Task 3 phone drag flake 2/3); vitest 6713, admin-edit 35 ×2)
- Task 8: re-review 1 dispatched (opus; risks: M-6 same-list across courses, --admin-foot cleanup/desktop, e2e fixture sort/lock, useListRows behaviour)
- Task 8: re-review 1 (opus) — all addressed, no Critical/Important; Minors N-1 SaveBar lift by style not place (phone page end: UndoBar covers top ~25 px of „Salvesta“ on Praktika), N-2 M-6 hand-on keyed by list kind not owner (bar survives „Lisa koolitus“ redirect, undo silently no-op); out-of-scope: haldus-praktika testplan lacks the new row drag/×/undo; afterEach undo loop: a throwing step skips the order-lock release
- Task 8: complete (commits 4cfdb45..fecea70)
- Park → final review: N-1 (--admin-foot = visible distance max(0, innerHeight − rect.top), passive scroll), N-2 (scope owners `${scope}:${owner}` via context), haldus-praktika testplan item for row drag/×/undo, afterEach undo loop try/finally so the lock always releases
- Task 9: dispatched (base fecea70, opus, implementer a74f45df2339b94fc; carries: drafted type for addLesson, moodul route t:, deletable, DragList moves into outline draft, PublishBar updates without restarting cards, ConfirmPanels, „· avaldamata“/flag marks)
- Task 9: implementer DONE_WITH_CONCERNS de44985 (vitest 6742; e2e lessons 10 incl. phone finger drag, edit 35, video 4; contact course delete still „Kustuta moodul“, no programme summary (no source); undeletable module: no button/no explanation; lesson ↑/↓ kept (not drawn), lesson numbers dropped, „Muuda“ → ›; each saved module name on a published course re-reads the page (guard vs restart); I18nInput describedBy; e2e unpublished courses only; video testplan item reworded not redo)
- Task 9: review dispatched (opus)
- Dim 24.10 (AskUserQuestion, Task 9): D-5 a programme point's delete button „Kustuta punkt“; D-6 programme count line „{n} punkti“ / „1 punkt“ (none: the existing empty line); D-7 an undeletable module shows „Moodulit saab kustutada, kui selles pole õppetunde.“ in place of the button; D-8 keep lesson ↑/↓
- Task 9: review (opus) — Needs fixes: I-1 no e2e on the published-course path (labels-read mechanism relies on real router ordering); minors M-1 labels-read counter counts any read (stale seeds after publish / 10 s freeze), M-2 haldus-ekursus-video should be redo, M-3/M-4 → Dim (answered D-7, D-8), M-5 stale module name in delete question/drag names after inline rename, M-6 renameModuleForm/moveModuleForm test-only, M-7 failed module move should say courses.moveError, M-8 testplan wording („+ Lisa moodul“, reload step), M-9 moveFailed lingers
- Ruling (T9): fix round takes I-1, M-1 (restart only on a read that reflects the press — a server stamp in the answer and in the editor data; also closes the Task 5/7 action-read race), M-2 redo, M-5, M-6, M-7, M-8, M-9, and D-5…D-8 (D-7 also for a module emptied only in the draft) — cost: one round
- Task 9: fix round 1/5 dispatched
- Todo (controller): add D-5…D-8 to piece3-texts.md „Dim 24.10“ section in a doc commit after Task 9 closes (agent working now)
- Task 9: fix round 1 → 47b2106 (published-course e2e both projects; restarts by server read stamp; D-5…D-8; M-2, M-5…M-9; vitest 6746, admin-edit 37, lessons 10; seed modules restored exactly) — concerns: type-change save answer has no stamp (restart on next read as before); +1 query per editor load; discard e2e desktop only (phone has none)
- Carry → Task 11: reset lessons.video_progress when a replacement upload/processing starts and on ready/failed
- Controller doc commit: D-5…D-8 in piece3-texts.md
- Task 9: re-review 1 (opus) — all addressed, D-5…D-8 as ruled, no new Critical/Important; stamp = Postgres clock_timestamp() taken after commit (sound); N-1 stamp await adds a sequential DB round trip per editor load (start it with requireAdmin/params); N-2 nit; carry: type-save path still restarts on next read (stamp the basics autosave answer)
- Task 9: complete (commits fecea70..47b2106; + controller doc d9163f1)
- Park → final review: Task 9 N-1 (stamp alongside requireAdmin/params), type-save stamp (basics autosave answer carries the stamp, or reload waits for a read whose drafted type matches)
- Task 10: dispatched (base d9163f1, opus, implementer a9d33d35d765c92dd; carries: oppetund route t:, purge at start of file actions + page read, soft delete, per-run purge limit, unique positions after undo, shared Switch, Drawer confirmClose removal, UndoBar in dialog e2e, testplan)
- Task 10: implementer stopped by an API auth error mid-work (uncommitted edits in tree); resumed via SendMessage
- Task 10: implementer DONE_WITH_CONCERNS 3c93fcc (vitest 6783; e2e lessons 10 incl. 375×812 + UndoBar-in-dialog, video 4, edit 37; purge in after() not at action start; daily sweep capped 20; phone line at every width while processing; ConfirmPanel split „Kas vahetan liigi?“ + „Video kustutatakse.“; hiddenNote kept; UndoBar not withdrawn on close (server-action undos); removed saveLesson/saveLessonForm; course discard calls dropCourseCopies)
- Carry → Task 12: docs/launch-checklist.md L55, L307 still say the drawer keeps confirmClose
- Task 10: review dispatched (opus)
- Task 10: review (opus) — Approved; no Critical/Important; M1 purge can delete a just-restored file (due condition only in the IN subquery), M2 Bunny 1–24 % announced exactly, M3 daily sweep now capped at 20/run, M4 duplicated helpers, M5 drop outside the zone opens the file in the tab, M6 purge on every editor read (no removed_at index), M7 drawer CSS in LessonsEditor.module.css 563 lines / source-regex pin / CRLF test lost, M8 launch-checklist L55/L307
- Task 10: complete (commits d9163f1..3c93fcc)
- Ruling (T10): M1, M2, M3 go with Task 11 (same dispatch; M2 is the progress line Task 11 feeds) — M1 is a one-line data-safety fix; M3: the sweep loops batches until none due (bounded by its run time); the phone line on desktop stays (reviewer: allowed by the constraint order) — cost: none
- Park → final review: Task 10 M4 (shared focusFell, LESSON_LIMITS in a pure module), M5 (preventDefault dragover/drop on the dialog), M6, M7
- Task 11: dispatched (base 3c93fcc, sonnet, implementer a53fb2fba7a3017e0; + video_progress reset carry, Task 10 M1/M2/M3)
- Task 11: implementer DONE 96c4238 + 3dec702 (encodeProgress verified in Bunny docs; video_progress reset; M1 outer due re-check; M2 „Töötlemisel…“ below 25 %; sweep drains 25×20 within 35 s; vitest 6805, video 4, lessons 10; rows may lag the drawer's percent until a status change)
- Task 11: review dispatched (sonnet)
- Task 11: review (sonnet) — Approved; minors: a begun purge batch can overrun the sweep's 60 s (sequential R2 deletes), drain `stopped` edge cases, haldus-ekursus-video expect lines should name „Töötlemisel 40%“, e2e column read window, deleteDueFiles exported for the test
- Task 11: complete (commits 3c93fcc..3dec702)
- Park → final review: Task 11 minor 1 (allSettled R2 deletes per batch or a 25 s drain deadline)
- Carry → Task 12: haldus-ekursus-video expect lines name „Töötlemisel 40%“
- Task 12: dispatched (base 3dec702, sonnet, implementer ad01c0c2fce5a4416; carries: rollback counts incl. course_modules.unpublished + lesson_files.removed_at, §5 sweep JSON files + drain, launch-checklist confirmClose lines, testplan video wording, Task 3 flake note, spec §7)
- Task 12: implementer DONE_WITH_CONCERNS 81763fd + 85eb3ea (docs §23/§5/§6/§8/§9/§20, launch-checklist §22 + L55/L307, spec §7/§8, testplan video wording; vitest 6805, build ISR kept; full Playwright 3 runs 936/934/938 passed of 1166 (227 skipped), failures 3/5/1 — last run's single failure protocols-autosave:204 passes alone 30/30; fixed: eelvaade no-store vs dev no-cache + skipped-project afterEach deleting fixture, admin-edit test.slow() on 4 long flows, admin-inbox touch-target scroll; financing:295 once; Task 3 flake not seen; launch-checklist L55 checkbox left open for Dim)
- Task 12: review dispatched (sonnet)
- Task 12: review (sonnet) — Approved; doc claims hold against the code; e2e edits legit (dev no-cache allowance keeps prod no-store); no failure branch-caused; minors parked as P12-1…P12-6 in parked.md
- Task 12: complete (commits 3dec702..85eb3ea)
- All 12 tasks complete. Parked items collected in parked.md for the final review.
- Final review: dispatched (opus, base 5574755..85eb3ea, with parked.md triage)
- Final review (opus): Ready to merge after one fix wave; no Critical/Important; take now: P8-3, P12-5, P7-2, P12-2, P12-3, P12-6, P9-1, P10-2, P7-1+P7-3, P6-1, P10-1+M-2 (lesson title limit drift), M-1 (reorder.ts into BROWSER_FILES); leave: P6-2 (no token exists; existing admin colour), P6-3, NB3-2/3, P8-1, P8-2, P8-4, P9-2, P10-3, P10-4, P11-1, P3-1, P12-4; controller before deploy: P12-1 financing repeat-each=3, prod-build admin-eelvaade on final HEAD
- Final fix wave: dispatched (one opus fixer, full list)
- Final fix wave → bae53f2, ab37fde, 89e725c, 1d42c52 (all 10 items; vitest 6822, e2e lessons/edit/site 72 passed; one course-editor discard test flaked once in a full run (stray save), passed alone ×3, under load ×6, final run; P7-1 visible fix = PublishBar busy while cards wait; P9-1 stamp started before await requireAdmin())
- Final fix wave: re-review dispatched (opus); controller running P12-1 financing mobile ×3 (background)
- P12-1: financing --project=mobile --repeat-each=3 → 36 passed, exit 0 (HEAD 1d42c52)
- Prod-build admin-eelvaade on 1d42c52 → 6 passed, 6 skipped, exit 0 (server log: 'destination stream closed early' ×2 from navigations during streaming, as before)
- Final fix wave: re-review (opus) — all 10 addressed, no new Critical/Important; Ready to merge: Yes; nits: haldus-praktika „ka telefonis“ in a tablet check, copy cursor on file drag over the drawer, waitingNow() guard untested; out-of-scope: flaky discard test (earlier test leaves a quiz save unanswered → retry lands in a later test) → test-only fix later


---

# Piece 3a — items parked for the final review and its one fix wave

Each was found in a task review, judged Minor (or a known degraded path), and deferred here by a controller ruling. The final reviewer verdicts each (still present? take / leave) alongside its own findings.

## Task 6 (preview)
- P6-1 Logout: call `endDraftMode()` after `deleteSession`, inside the guarded flow, so "logout works when things around it fail" holds (`src/app/api/auth/logout/route.ts`).
- P6-2 `PreviewBar.module.css` hard-codes `#b9b1b5` → a token.
- P6-3 (optional) `previewChangeCount` reads the test draft (answer key) into server memory just to count — a no-key variant of `courseChanges`.

## Task 7 (course editor)
- P7-1 NB3-1: „Avalda muudatused“ / „Loobu muudatustest“ can be pressed while a switch waits and share its hold; the first release ends it for both. Fix: publish/discard return while a hold is set, or PublishBar busy while the cards wait.
- P7-2 D-1 strings „Lõpeta eelvaade“ and „Eelvaade“ live as constants in `server/preview-bar.ts`, not in `adminEt` (constraint: every admin string in adminEt; reuse `publish.phonePreview` for „Eelvaade“).
- P7-3 `liveSeeds` has no rejection handler — on an insecure context (no `crypto.subtle`) the discard's cards stay inert; `.catch(() => null)` → release + reread.
- Accepted as known (no fix): NB3-2 (post-bound read older than a save → false conflict), NB3-3 (type flow inert up to ~2× bound), the other NB3 nits.

## Task 8 (list editors)
- P8-1 N-1: `--admin-foot` measured by style, not place — a resting sticky SaveBar lifts the UndoBar over the top of „Salvesta“ at the page end on a phone (Praktika). Fix: set it to the visible distance `max(0, innerHeight − rect.top)` with a passive scroll listener.
- P8-2 N-2: M-6's hand-on keyed by list kind, not owner — a bar from `/uus` survives the „Lisa koolitus“ redirect and its undo silently does nothing. Fix: scope owners `${scope}:${owner}` via a small context.
- P8-3 testplan `haldus-praktika` lacks Praktika's new row drag / × / „Rida eemaldatud.“ / „Võta tagasi“.
- P8-4 e2e afterEach undo loops: a throwing step skips the rest, including lock releases — per-step try/finally.

## Task 9 (modules and lessons)
- P9-1 The editor page awaits the read stamp before everything; start it with `requireAdmin()` / params (still before any course read).
- P9-2 The unpublished type-change save answer carries no stamp, so the restart happens on the next read (a module action's read in flight can seed stale versions → a 409, never silent). Fix: the basics autosave answer carries the stamp, or the reload waits for a read whose drafted type matches.

## Task 10 (lesson drawer)
- P10-1 Duplicated `focusFell` (LessonDrawer, LessonFiles); `TITLE_MAX`/`BODY_MAX`/`checkText` copy `LESSON_LIMITS` by hand → one pure shared module.
- P10-2 A file dropped just outside the drop zone opens in the tab and leaves the admin → `preventDefault` on dragover/drop across the dialog.
- P10-3 Every editor read runs a purge; `lesson_files` has no index on `removed_at` (trivial today).
- P10-4 ~260 lines of drawer CSS in `LessonsEditor.module.css` (563 lines); the page's purge pinned only by a source regex; the CRLF→LF lesson body test went with `saveLessonForm`.

## Task 11 (Bunny progress / sweep)
- P11-1 A begun purge batch (20 sequential R2 deletes, 10 s timeout each) can overrun the sweep's 60 s → `Promise.allSettled` per batch, or a ~25 s drain deadline.

## Task 3
- P3-1 Phone course-order drag flake: Task 8 fixed the fixture; it did not recur in Task 12's three full runs. Verify only.

## Task 12 (docs / run)
- P12-1 `financing.spec.ts:295` (mobile) failed once in a full run, unexplained; its page is one the branch changed — run `npx playwright test financing --project=mobile --no-deps --repeat-each=3` and record.
- P12-2 deploy.md L114 (0017 item) and L572 (§20 item 4) still say "today the preview shows the live page" — false for the course page and catalogue after 3a.
- P12-3 deploy.md §5: "a database or R2 failure ... counts as nothing purged" — true only for the database (R2 failure: row deleted and counted, object orphaned).
- P12-4 the `test.slow()` comment's "about 15 s alone" vs the report's 23 s.
- P12-5 testplan `haldus-ekursus-video`: „Töötlemisel 40%“ reads as the expected figure — say „näiteks 40%“; the row figure is as of the page's last read.
- P12-6 launch-checklist §22: "the new checks" → "new and reworked checks".
- Controller at deploy: re-run `E2E_PROD_BUILD=1 npx playwright test admin-eelvaade --no-deps` on the final HEAD.
