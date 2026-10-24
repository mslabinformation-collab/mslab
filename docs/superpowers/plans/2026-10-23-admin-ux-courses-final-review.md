# Admin UX pass, piece 3a — final whole-branch review and the fix wave's re-review (25.10.2026)

# Final review: admin UX pass piece 3a (5574755..85eb3ea, feat/admin-courses)

Reviewer: final whole-branch review, read-only. I ran no Playwright, no dev server and no vitest; nothing raised a doubt that needed one.

### Passes done

1. **Migration, schema and every reader.** I went through `drizzle/0020`, the journal, `schema.ts`, and every module at HEAD that reads `course_modules`, `lessons`, `lesson_files` or `content_drafts`:
   - public pages: `public.ts`, the course page, the catalogue, the cart, home, the recommendations;
   - the student side: `lesson-outline.ts`, `lesson-data.ts`, `client-data.ts`, `completion.ts`, `test-attempts.ts`, `practical.ts`, `admin-clients.ts` (view as student, „Ava järgmine õppetund“);
   - certificates and contracts, and the admin readers.
2. **The draft layer and course parts.** I read `drafts.ts`, `course-parts.ts` and `course-outline.ts` in full, and `admin-lessons.ts` (the actions and `writeOutlineText`). I checked publish, discard and R-d (switching „Avaldatud“ off). I traced the lock order through every course write, including `moveCourseTo` and the lesson-file and video paths.
3. **Routes and auth.** The five new routes, `autosave-route.ts` (size cap, zod), the server actions (`admin-content.ts`, `admin-lessons.ts`), the `eelvaade`/`preview`/`logout` routes, and the IDOR surface (every id resolves to its own course; no route takes a course id and a row id together).
4. **Preview.** `preview.ts` (`previewActive`, `previewPath`), `preview-bar.ts`, `PreviewBar.tsx`, `withCourseDrafts` and `previewModuleTitles`, and how the ISR pages call them. I also checked that the answer key stays out (`readDrafts` `except`/`only`, `course_tests` never read).
5. **The course editor client.** `SavedCourse.tsx` (holds, bounds, stamps, publish/discard/switch), `useCoursePart.ts`, `course-view.ts` (labels come from the same `domain/course-parts` as the server), `CourseView.tsx` (what goes inert), and the engine diff (`discardCopy`).
6. **List editors.** `DragList.tsx` in full (pointer and keyboard paths, focus return, announcements, 44 px targets), `foot-bar.ts`, `Switch.tsx`, `PublishBar.tsx`, and where the shared `ListEditor` and `GalleryEditor` are used outside the course editor.
7. **The modules and lesson drawer side.** `LessonFiles.tsx`, `lesson-files.ts` (soft delete, restore under lock), `lesson-file-purge.ts` (the outer re-check of the due mark, the drain), the Bunny progress code (`bunny.ts`, `lesson-videos.ts` `applyAnswer`), the cron sweep, the editor page and `read-stamp.ts`.
8. **Tests and docs.** The names of the db tests on the load-bearing paths (`course-preview`, `lesson-api`, `queries`, `completion-core`, `migration-0020`, `preview-routes`), `old-safari` `BROWSER_FILES`, the e2e config and fixtures, the `testplan.json` checks I needed, `deploy.md` §5, §6, §8 and §23, and `launch-checklist.md` §22.

### Strengths

- **Students never see unpublished content.**
  - Every student reader filters both the module's and the lesson's `unpublished` flag, and `removed_at is null` on file lists and downloads. That covers the outline, the counts and completion, the lesson GET, progress, „tehtud“, downloads, „Ava järgmine õppetund“ and view as student.
  - `listModuleTitles` filters the flag for the public pages.
  - No public or student reader touches `content_drafts`. The preview loads it only behind `previewActive()` and only via a dynamic `import()`.
  - The DB tests pin each of these.
- **The answer key is designed out.** `withCourseDrafts` uses `readDrafts(..., { except: ["test","outline"] })` and `test: null`, and `readLayout` reads only the outline. `getCourseBySlug` carries no test relation. Only the admin's own editor holds the key.
- **One lock order, kept everywhere.** `lockCourse` comes first in part saves, publish (`Publisher.lock`), discard, both switches, every module/lesson action (`underCourse`) and `writeOutlineText`. The lesson-file and video paths never take the course lock and never touch drafts, so no cycle is possible. `moveCourseTo` locks the course rows by id, then reads — a nice catch from Task 3.
- **Versions cannot be confused.** `d:<draftId>.<n>` versions (R-b amended) make an earlier draft's version unusable. `t:` row-text versions (R-b2) remove engine-against-engine conflicts in one page. There is one hash function (`contentVersion`), and the client's `liveSeeds` reproduces the server's `l:` hash from the same live value. A mismatch would show as a conflict, never as a silent write.
- **Additive, safe migration.** Four `ADD COLUMN`s with false/null defaults. Old code never creates flagged rows or removed files, so the window between migrate and deploy shows students nothing new; I confirmed old inserts get `unpublished=false` by default. The rollback note (§23 item 2: four counts that must be 0, how to reach them, the purge route) is complete; I found nothing it misses.
- **Visitors stay on ISR.**
  - `previewActive()` reads `draftMode().isEnabled` first and the session only when it is on. A session lookup that fails throws a 500 rather than quietly falling back to live data.
  - `previewPath` is a careful open-redirect guard (dot segments, encoded `//`, backslashes, control characters), with a second same-origin check on the redirect.
  - Logout and „Vaata kodulehte“ end draft mode.
- **The purge is correct under concurrency.** The outer WHERE re-checks the due mark under READ COMMITTED; restore re-reads under the lesson lock; the row is deleted before the object; it never throws; the sweep drains within its bounds.
- **Discard is thorough.** It deletes flagged lessons (removed files included), then only the flagged modules left empty, and returns the media for `after()`. A published lesson can never go with them.
- **DragList is a model component.** Pointer capture with a fallback, focus kept through re-orders, polite announcements re-keyed so a repeat is read again, `aria-disabled` (not `disabled`) at the ends, modifier chords left to the browser, Esc scoped to the drag.
- **Documentation.** `deploy.md` §23 is unusually complete: deploy order, read-only checks, rollback, smoke checks, and the rules in plain words.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None of my own beyond the parked items I recommend taking below. I looked specifically for a student-visible leak, an answer-key path, a lock-order break, an IDOR, an open redirect, a non-admin turning on draft mode, and a deploy or rollback gap. I found none.

#### Minor (Nice to Have)

- **M-1. `reorder.ts` is missing from `BROWSER_FILES`.**
  - `app/src/components/admin/reorder.ts` is a new browser module without `"use client"`, imported by `CourseList.tsx:13` and `LessonsEditor.tsx:19`, but `tests/unit/old-safari.test.ts:112-121` has no line for it. That breaks the "Old iPads" constraint.
  - The content is safe today (`splice` only), but the guard would not catch a future lookbehind in it.
  - Fix: add one line.
- **M-2. The client copies of the lesson limits have already drifted (part of P10-1).**
  - `LessonsEditor.tsx:224-228` `checkTitle` measures the untrimmed length (`v.et.length > TITLE_MAX`).
  - `LessonDrawer.tsx:66-76` `checkText` and the server's `Check.text` (`edit-check.ts:86-91`) measure the trimmed length.
  - Today `maxLength={TITLE_MAX}` on the inputs hides the difference. If the limit changes or an input loses `maxLength`, the client holds back a name the server would take. This is the drift the brief asked about.
  - Fix: move `LESSON_LIMITS` (`course-outline.ts:40`) into a pure `domain/` module, import it in all three places, and check trimmed values the same way.
- **M-3. The catalogue preview does per-course work** (admin only, informational, known from Task 6). `withCourseDrafts` runs one `readDrafts` per course, and a course with a basics draft also runs `courseUsage` (five counts) and `isSlugTaken`. With about 10 courses that is roughly 30–80 queries over a pool of 5. It is acceptable for one admin; no action.
- **Plan deviations, all judged fine.**
  - R-f says "purge at the start of the next lesson-file action / by `listCourseLessons`". It was built as purges in `after()` of the actions and of the editor page read, with the undo's purge after its restore. This is safer: no answer waits for R2 and an undo cannot purge its own file. Task 10's review accepted it.
  - The plan is not wrong anywhere I could find. R-b and R-b2 were amended in the plan itself, as they should be.

### Parked items (parked.md): each one, is it still present, and take now or leave

| Item | Present? | Verdict | Reason |
|---|---|---|---|
| P6-1 logout `endDraftMode` outside the guarded flow (`api/auth/logout/route.ts:29`) | yes | **take now** | One line: wrap it in try/catch where it is, so it still runs for the expired-session early return at :30. Logout is the path that "works when things around it fail". |
| P6-2 `#b9b1b5` in `PreviewBar.module.css:47` | yes | leave | It is an existing admin colour, not a stray value: `ui.module.css:105` (secondary button border) and `LeaveGuard.module.css:79` use the same literal, and no token exists. A token would be a project-wide change. |
| P6-3 `previewChangeCount` loads the test draft into server memory | yes | leave | Only a count leaves the server, the request is admin-only, and nothing is serialized. A key-free variant of `courseChanges` adds a second code path for one number. |
| P7-1 publish/discard pressable while a switch waits (shared hold) | yes (`CourseView.tsx:134` renders the bar outside the inert layout; `SavedCourse.tsx:519,539` do not check the hold) | **take now** | Small fix: `publish`/`discard` return when `waiting` is true (discard throws so its question stays open). It removes a double-action race in which the first `release()` ends the other's wait. Both server outcomes are consistent, so this is about UI honesty, not data. |
| P7-2 „Lõpeta eelvaade“ / „Eelvaade“ as constants in `server/preview-bar.ts:15-16` | yes | **take now** | Breaks the constraint "every admin string in adminEt". Move them into `adminEt.publish` and reuse `publish.phonePreview` („Eelvaade“, `admin.ts:225`); sweep tests for the old place. |
| P7-3 `liveSeeds` has no rejection handler (`SavedCourse.tsx:315`) | yes | **take now** (with P7-1, same file) | `crypto.subtle` is missing on an insecure context, so the bound's `.then` never runs and the cards stay inert. There is no production effect (https), but it is the "inert forever" class that round 3 ruled out. One line: `.catch(() => null)`. |
| NB3-2 / NB3-3 (accepted as known) | yes | leave | Agree with the ruling: at worst a false conflict after a 10 s server stall; nothing is lost. |
| P8-1 `--admin-foot` measured by style, not by place | yes | leave | Cosmetic: for 8 s the UndoBar covers the top ~25 px of a 44 px „Salvesta“ at the page end on Praktika (phone); the rest stays tappable. Before Task 8 the UndoBar covered the bars entirely. |
| P8-2 hand-on keyed by list kind; a bar from `/uus` survives the „Lisa koolitus“ redirect, and its undo is a no-op | yes | leave | Needs a row removal then a create within 8 s. The card on screen shows the row is gone, so she is not misled for long. Needs a scoping context, more than a one-liner. Record it as known. |
| P8-3 `haldus-praktika` lacks the row drag / × / „Rida eemaldatud.“ / „Võta tagasi“ (`testplan.json:1549`) | yes. `PracticeEditor.tsx:72` uses the shared `ListEditor`, so Praktika's behaviour changed; the check has no mark | **take now** | Project rule "test plan follows the code". Mark it `redo` with `"markedAt":"deploy"` and run the two testplan tests. (The trainer gallery's change is covered: `haldus-koolitaja` is `redo`.) |
| P8-4 the e2e afterEach undo loops: a throwing step skips the lock releases | yes | leave | Test-only robustness. It can cause a cascade of failures, never a false pass, and the three full runs were clean. |
| P9-1 the editor page awaits the read stamp before everything (`koolitused/[id]/page.tsx:47-53`) | yes | **take now** | Start `readStamp(db)` before `await requireAdmin()` and await it before the reads; reading a clock before auth exposes nothing. This saves one sequential DB round trip on every editor read, including each `router.refresh()` after a module action, a label read and a drawer text save. |
| P9-2 the type-change save answer of an unpublished course carries no stamp | yes | leave | Never silent: at worst a 409 with „Taasta minu tekst“, and only on an unpublished course whose type is changed while a module action's read is in flight. |
| P10-1 duplicated `focusFell`; `TITLE_MAX` / `BODY_MAX` / `checkText` copy `LESSON_LIMITS` by hand | yes, and already drifted (M-2) | **take now** | A shared pure module for the limits, plus `focusFell`. This is the client/server drift the brief asks about. |
| P10-2 a file dropped just outside the drop zone opens in the tab and leaves the admin (`LessonFiles.tsx` handles dragover/drop on the zone only) | yes | **take now** | A reasonable person drags a PDF onto the drawer and expects either an upload or nothing, not to leave the admin. Cheap: `preventDefault` on `dragover`/`drop` across the dialog. |
| P10-3 a purge on every editor read; no index on `removed_at` | yes | leave | The table is tiny and the DELETE runs after the answer. Revisit only if `lesson_files` grows to thousands of rows. |
| P10-4 ~260 lines of drawer CSS in `LessonsEditor.module.css`; the purge pin is a source regex; the CRLF test is gone | yes | leave | Housekeeping. The CRLF normalisation is moot now that the drawer saves JSON, not multipart. |
| P11-1 a begun purge batch can overrun the sweep's 60 s | yes (documented in `deploy.md` §5) | leave | Only while R2 hangs. The rows are already deleted, so at worst an orphaned object and a lost log line or answer for that run. The other passes end by ~50 s. |
| P3-1 phone course-order drag flake | not seen in Task 12's three full runs | leave | Verified by those runs; nothing to change. |
| P12-1 `financing.spec.ts:295` (mobile) failed once | unknown | **take now (verification)** | The test drives the public course page, which this branch changed (preview gating). The controller runs `npx playwright test financing --project=mobile --no-deps --repeat-each=3` and records the result; I may not run Playwright. |
| P12-2 `deploy.md:114` (0017 item) and `:572` (§20 item 4) still say "today the preview shows the live page" | yes (`:572` has a parenthesis for 3a, but the sentence is still false) | **take now** | A false statement in the deploy guide. |
| P12-3 `deploy.md` §5 (`:101`): "a database or R2 failure … counts as nothing purged" | yes | **take now** | False for R2: the row is deleted and counted, and only the object is orphaned (`lesson-file-purge.ts:52-60`). |
| P12-4 `test.slow()` comment "about 15 s alone" vs 23 s (`admin-edit.spec.ts:112,200,255,499`) | yes | leave | A comment only; no effect on anyone. |
| P12-5 `haldus-ekursus-video` (`testplan.json:971,973`): „Töötlemisel 40%“ reads as the expected figure | yes | **take now** | Maria's check would fail on any other percentage. Write „näiteks 40%“ and note that the row's figure is as of the page's last read; it stays `redo`. |
| P12-6 `launch-checklist.md:351` "the new checks" → "new and reworked checks" | yes | **take now** | Trivial, and in a file the wave touches anyway. |
| Controller at deploy: `E2E_PROD_BUILD=1 npx playwright test admin-eelvaade --no-deps` on the final HEAD | n/a | **keep as a deploy step** | The ISR and no-store proof belongs on the merged HEAD. |

### Declined to judge

- **Visual fidelity against the frames** (`*.dc.html`) at each width: the controller compared screenshots per task; I did not compare frames again.
- **Estonian wording and tone:** the texts are Dim-approved (piece3-texts, Dim 24.10 D-1…D-8). I only checked that strings come from `adminEt`.
- **The piece 3b plan** (`docs/superpowers/plans/2026-10-23-admin-ux-calendar-settings-newsletter.md`, in this range): a separate piece with its own review.
- **Container queries and `color-mix` on iOS 15:** they were used across the project before this branch (`tokens.css` defines `--muted` with `color-mix`). The plan's old-iPad constraint names only lookbehind and `crypto.randomUUID`.
- **E2E flakiness** (P3-1, P12-1, protocols-autosave:204): I may not run Playwright here.
- **Old admin tabs open across the deploy that call removed server actions** (`saveCourse`, `moveCourseInList`): generic Next.js behaviour on every release, not specific to this piece.
- **Lock strength:** `FOR UPDATE` rather than `FOR NO KEY UPDATE` on course rows briefly blocks foreign-key checks of registration and access inserts. Milliseconds, no correctness effect, and the pattern was there before.
- **`autosaveHandler` reads the body before its size check when there is no content-length:** piece 1 code, and Vercel caps bodies at 4.5 MB.
- **`addLessonFile`'s position race** with two concurrent uploads on one lesson: there before; this branch only added the `removed_at` filter.
- **The README's „Eelvaade ↗ … `?mustand=1`“ mechanism note** against the built draft-mode route: spec C3 governs, and the route is built per spec.
- **Completion while a course is edited:** a student who finishes the live lessons completes before newly flagged lessons are published. This is inherent to R-e and spec §4.4 ("never cleared"), not something the branch chose.

### Verdict

**Ready to merge: Yes after the fix wave.**

Nothing blocks on correctness, safety or data. The wave is small and mechanical.

The one fix wave:

1. **P8-3:** mark `haldus-praktika` `redo` for Praktika's row drag / × / UndoBar.
2. **P12-5:** reword the `haldus-ekursus-video` figure („näiteks 40%“, the row's figure as of the page's last read).
3. **P7-2:** move „Lõpeta eelvaade“ / „Eelvaade“ into `adminEt` (reuse `publish.phonePreview`); sweep the tests.
4. **P12-2, P12-3, P12-6:** fix the false or stale lines in `deploy.md` (`:114`, `:572`, §5 `:101`) and `launch-checklist.md:351`.
5. **P9-1:** start the read stamp alongside `requireAdmin()` on the editor page.
6. **P10-2:** `preventDefault` on `dragover`/`drop` across the lesson drawer.
7. **P7-1 + P7-3:** publish/discard return while a hold is set (discard throws to keep its question); `liveSeeds(...).catch(() => null)`.
8. **P6-1:** guard `endDraftMode()` in logout with try/catch at its current place.
9. **P10-1 + M-2:** one pure module for `LESSON_LIMITS` and `focusFell`; check trimmed values on the client too.
10. **M-1:** add `src/components/admin/reorder.ts` to `BROWSER_FILES`.

Then:

- re-run `npx vitest run tests/unit/testplan-file.test.ts tests/unit/testplan-rules.test.ts`, `tsc`, lint and the unit tests the wave touches;
- before deploy, the controller runs P12-1 (`financing --project=mobile --repeat-each=3`) and `E2E_PROD_BUILD=1 npx playwright test admin-eelvaade --no-deps` on the final HEAD;
- then follow `deploy.md` §23 item 1 (stamp, migrate 0020 first, push, smoke).


---

## The fix wave (bae53f2..1d42c52) — re-review

# Re-review: piece 3a final fix wave (85eb3ea..1d42c52, feat/admin-courses)

Read-only. I read the diff once, plus the HEAD sources the named risks needed. I ran one focused check: `tests/unit/course-editor-dom.test.ts` three times at once (63/63 each, about 55 s), and once more with the verbose reporter to get per-test times. I ran no other tests, no Playwright and no dev server.

### Finding Verdicts

| Item | Verdict | Evidence |
|---|---|---|
| P8-3 `haldus-praktika` | **Fixed** | 3 steps added (drag the 2nd point by ⋮⋮, ↓, × then „Võta tagasi“) and 4 expect lines („Rida eemaldatud.“, „Võta tagasi“ puts the point back in its place). The check is now 7 steps and 6 expects, marked `redo`/`deploy`. The labels match the code: `adminEt` `items: "Paketi punktid"`, `removed: "Rida eemaldatud.“`, `undo: "Võta tagasi"`, and the glyph is `ListEditor.tsx:151` "×". `PracticeEditor.tsx:72` uses that `ListEditor`. The net change is nil, so `writes: false` still holds. |
| P12-5 `haldus-ekursus-video` | **Fixed** | Both places now say „näiteks „Töötlemisel 40%““. The new line „Rea protsent on lehe viimase laadimise seisuga ja uueneb lehe järgmisel laadimisel.“ covers the row figure. The check has 8 expect lines (the cap) and stays `redo`/`deploy`. |
| P7-2 preview-bar words | **Fixed** | `adminEt.publish.previewExit = "Lõpeta eelvaade"`, and „Eelvaade“ reuses `publish.phonePreview`. `server/preview-bar.ts` no longer has the `EXIT`/`LABEL` constants. That module already imported `adminEt` before this wave, so nothing new is imported anywhere. `components/site/PreviewBar.tsx` is unchanged (`preview-bar-dom.test.ts:187-188` still pins that it has no `i18n/dict/admin` import). The new db test pins the dictionary values and checks that the module has no quoted literal. The old strings left in `tests/` are the props a test passes itself or the rendered output; nothing is stale. |
| P12-2 deploy.md L114 / L572 | **Fixed** | Both lines are now in the past tense: "until piece 3a … the live page". They add that the course page and the catalogue now show the drafts and the other pages still show live, with a pointer to §23 item 5. |
| P12-3 deploy.md §5 | **Fixed** | Matches `lesson-file-purge.ts:43-63`. A database failure is caught by the outer catch and returns 0. An R2 failure is caught per key, the row is already deleted, and `rows.length` counts it. |
| P12-6 launch-checklist | **Fixed** | Now reads "the new and reworked checks". |
| P9-1 read stamp | **Fixed** | See the named risk below. The stamp starts once `params` resolve, while `requireAdmin()` runs. Every course read (and the `after()` purge) starts only after `await Promise.all([parsed, searchParams, stamped])`. The `admin-guards.test.ts:146` text pin `await requireAdmin()` still holds. |
| P10-2 file drops | **Fixed** | See the named risk below. Native `dragover`/`drop` listeners on the drawer's `<dialog>` call `preventDefault()` only when `types` includes "Files". |
| P7-1 publish/discard vs a switch's hold | **Fixed** | Two guards: `PublishBar` `waiting={frozen}` (aria-busy, both buttons aria-disabled, `run()` and the discard trigger refuse), plus `waitingNow()` (`holding.current`, which a `useLayoutEffect` keeps in step with `hold`) at the top of `publish`/`discard`. The parked text offered either guard, and the review asked for the form guard; both are there. No test-plan line for a ≤ 10 s transient; I accept the implementer's reasoning (report concern 4). |
| P7-3 `liveSeeds` rejection | **Fixed** | `liveSeeds(live).catch(() => null)` → no restart. The bound still clears `holding`/`hold`, resets the asked state and calls `reread()`, and the next read starts the cards over (`awaiting.from === null`). The DOM test mocks `crypto.subtle.digest` to reject and checks that the cards are released, there is a second refresh, and the live text comes back after the read. |
| P6-1 logout | **Fixed** | See the named risk below. `deleteSession` (with `getDb()` inside the try) and the cookie clear come first. `endDraftMode()` then runs for every case in its own try/catch. The early return is gone. |
| P10-1 + M-2 lesson limits, `focusFell` | **Fixed** | `domain/lesson-limits.ts` is pure: type-only import of `I18n`, nothing at run time. `textProblem` returns exactly what the old `Check.text` refused: trimmed, tooLong first, then `!et && (ru \|\| required)`. `Check.text` now runs it and still normalises the same way. The table test compares the two over 13 inputs × both limits × required/optional. The drawer's checks are equivalent to the old `checkText`. The card's `checkTitle` is now trimmed and checks tooLong first, which was the M-2 drift. A DOM test proves a padded 120-character name is sent and 121 is held back. `course-outline.ts` and `admin-lessons.ts` re-export the domain object (`toBe`-pinned). `focusFell` is now one file; grep finds no other definition and no import from `useListRows`. Adding `!isConnected` changes nothing in a browser. |
| M-1 BROWSER_FILES | **Fixed** | Added `reorder.ts`, `UnpublishedTag.tsx`, `lesson-limits.ts` and `focus-fell.ts`. The test checks that each listed file exists. The import walk from every "use client" file reached them anyway; the list is now complete per the constraint. |

### Named risks

- **P7-2: does a module that ships to visitors import adminEt?** No.
  - `PreviewBar.tsx` (client) imports only React, `lib/course-copies` and its CSS. ConfirmPanel stays a `lazy()` import, and the file is untouched by this diff.
  - `adminEt` is read only in `server/preview-bar.ts`. The course page and the catalogue load that module by a dynamic `import()` inside their preview branch, so it is never in a client bundle.
  - The guard tests still stand: the `preview-bar-dom` source pin, and the e2e `admin-eelvaade` checks that a visitor's page has no bar or admin code. The prod-build e2e is a deploy step that is still pending; see the Verdict.
- **P9-1: can a course read start before the stamp resolves?** No.
  - The only `Promise.all` that includes the stamp holds `parsed`, `searchParams` and `stamped`, and no reader. The readers' `Promise.all` comes after it, and so does the `after()` purge. `requireAdmin()` reads the session, not the course.
  - Rejections are handled. `stamped.catch(() => {})` covers a stamp that fails after a redirect. `parsed` has a handler through its `.then`, so a rejected `params` cannot be unhandled either. On the normal path `Promise.all` still sees `stamped`, so a failed stamp fails the read, as before.
  - Taking the stamp earlier only makes it older. That is the conservative direction: a read can be judged stale, never fresh by mistake. A `router.refresh()` starts after the press's answer, so its stamp is past that answer anyway.
  - Cost: one clock query for an unauthenticated hit before the redirect. That is harmless, and the review accepted it.
- **P6-1: can a failure skip `endDraftMode` or the response?**
  - An exception in `deleteSession` (or `getDb()`) is caught inside the `if (raw)` block. The session cookie is still cleared and `endDraftMode()` still runs. So no deleteSession failure can leave draft mode on.
  - Draft mode stays on only when `endDraftMode()` itself throws. That is logged, and the session is already gone. This is acceptable: R-h means draft mode without a live session reads live data.
  - The response is returned in every failure case except an exception in `cookies()`, which sits outside any try exactly as before.
  - The new test checks a 303, the row gone, both cookies cleared and exactly one log line; with no cookie it still gets a 303.
- **P7-1: is the busy state accessible, and is it bounded?**
  - Accessible: the region is `aria-busy`. The buttons use `aria-disabled`, never `disabled`, so focus is not lost. An open ConfirmPanel gets `busy`, and its two buttons are `aria-disabled` (DOM-tested).
  - Bounded: on a published course `frozen === (hold !== null)`, because `typeSaving` is only reachable on an unpublished course (`ear.current = published ? null : …`). A hold ends in one of three ways:
    - the awaited read (`setHold(null)`, with the layout effect clearing `holding`);
    - a `release()`;
    - the SAVE_TIMEOUT_MS bound effect, whose `.then` now always runs (the P7-3 catch), and whose cleanup clears its timer on unmount.
  - So the bar cannot stay busy past the bound.
  - The one new visible behaviour: after a publish goes through, the bar stays busy until the read the publish asked for. That is intended and documented in deploy.md §23 item 6.
- **P10-2: does preventDefault break the zone, text drags or the video upload?** No.
  - The dialog listener fires before React's root-delegated `onDrop` on the zone. The zone does not check `defaultPrevented`, and `dataTransfer.files` is readable either way, so it still uploads (DOM-tested).
  - Text drags carry no "Files" type and are untouched (DOM-tested on both fields).
  - `LessonVideoField` has no drop handling of its own: only a picker, whose input is 1 px and clipped, as `LessonFiles`' is. So no native file-input drop is cancelled.
  - The backdrop sends its events to the `<dialog>`, so drops there are covered too.
- **The flaky „Loobu muudatustest“ drops a module name's copy… test: is this diff involved?** Not plausibly.
  - The failure is a stray **`test`-part** save in `remote.log` after `resetRemote()`. Neither that test nor any of this wave's new tests edits the test part; the new ones touch `summary` only.
  - The diff's changes on the discard path could only show as a discard that never runs: the copy still there, or no `/loobu` call. The test's own `moduleCopies()` assertion passed before the failing line.
  - The new tests' timers are fake (and dropped by `useRealTimers()`) or cleared by the bound effect's cleanup.
  - The implementer's reading fits the timings. "A refusal of the questions…" (`course-editor-dom.test.ts:1119`) ends with a `test`-part save held unanswered. The engine gives it up after SAVE_TIMEOUT_MS = 10 s and retries after RETRY_MS[0] = 2 s. By then `remote.hold` has been reset, so the retry is logged into whichever test is running.
  - Measured here at idle, the tests between the end of that test and the end of the flaky one take about 5.6–6.9 s. A full run under load, about 2× slower, puts that roughly 12 s retry inside the flaky test.
  - My three concurrent runs of the file all passed.

### New Breakage in the Fix Diff

No Critical or Important issues. Three Minor, non-blocking wording or polish nits:

1. **`haldus-praktika` (testplan.json:1573):** „Riba ajal on „Salvesta“ näha ja seda saab vajutada, ka telefonis.“ The check's device is `tahvel`, and no step takes Maria to a phone. Either drop „ka telefonis“ or add a phone step. Also, step 3 opens the public page and step 4 assumes she is back in the admin, without saying so.
2. **P10-2 cursor:** files dragged anywhere over the drawer now show the browser's "copy" cursor, though nothing happens. Showing a no-drop cursor would need `dropEffect = "none"` set only outside `[data-file-drop]`. Setting it across the dialog would stop the zone's own drop, because the dialog listener runs first. Optional.
3. **`waitingNow()` form guard has no RED of its own:** the implementer says so (concern 3). It is defence only; the visible guard is tested.

### Out-of-Scope Observations

- **The flaky test (test-only):** hardening is worth a small follow-up. Options: resolve or abort `remote.hold.waiting` at the end of the questions-refusal test, or stamp `remote.log` entries with a per-test generation so a leftover retry cannot land in a later test.
- **`PublishBar` gained an optional prop (`waiting`):** the constraint says "piece 1 and 2 parts, used as they are". There is precedent (the `error` prop), the parked P7-1 text offers this option, and the default `false` leaves every other user unchanged.
- **`deploy.md` L572:** the reworded sentence still says "no admin screen wrote to it", while its parenthesis says piece 2's test review writes `test_review` rows. This contradiction was already there before this wave, and the line was only moved to the past tense.
- **Still to do before deploy (controller, outside the wave):**
  - P12-1, `npx playwright test financing --project=mobile --no-deps --repeat-each=3`;
  - `E2E_PROD_BUILD=1 npx playwright test admin-eelvaade --no-deps` on the final HEAD (this wave touched `preview-bar.ts`);
  - the stamp tool;
  - then deploy.md §23 item 1 (migrate 0020 first).

### Verdict

**Fix wave:** All findings addressed, no new Critical/Important breakage. P8-3, P12-5, P7-2, P12-2, P12-3, P12-6, P9-1, P10-2, P7-1, P7-3, P6-1, P10-1 + M-2 and M-1 are all closed. **Ready to merge:** Yes, after the controller's deploy steps above.
