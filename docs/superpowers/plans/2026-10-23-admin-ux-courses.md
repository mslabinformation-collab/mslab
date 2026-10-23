# Admin UX pass, piece 3a: Koolitused and the course editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design's B1 (Koolitused list) and B2 (course editor and lesson drawer) with B18 (modules and lessons in the course draft) on piece 1's draft layer, so a published course is edited in a draft, previewed, and published with „Avalda muudatused“, while an unpublished course saves straight to the record.

**Architecture:**
- **Course parts.** A course is split into named parts. Each part has a live value, a live version (a hash) and an optional draft in `content_drafts` (entity `course`, entity id = course id). One autosave route per course part writes a draft when the course is published and the live record when it is not. A course `Publisher` writes the parts through the existing course writer's checks.
- **Modules and lessons (B18).** They join the draft the same way: text and order are drafted, and new rows are real rows flagged `unpublished` (migration 0020). Media, visibility, kind and confirmed deletes stay instant.
- **Preview.** The public course page and catalogue lay the drafts over the live data only in `draftMode()` with a live admin session.
- **This plan and the next.** Piece 3 is split into two plans and two deploys. This plan (3a) is B1 + B2/B18. The next plan (3b) covers B3 Kalender, B4 Seaded with the legal-text drafts, B5 Uudiskiri with B17/B9, and B21's preview.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest + happy-dom, Playwright, Bunny Stream, R2.

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`. It is built as designed. This plan covers §8 item 3 (B1, B2, B18), plus S2, S6, §7 (the module and lesson flag, `removed_at` on lesson files), C3 (draftMode) and §10 ("an unpublished e-course that already has students saves straight to the record").

Other sources:
- Design: `docs/superpowers/specs/admin-ux-pass/handoff/README.md` §3 B1, B2 and §5 B5 and B18; prototypes `… Part 3.dc.html` (B screens) and `… Part 4.dc.html` (phone).
- Approved texts: **`docs/superpowers/specs/admin-ux-pass/analysis/piece3-texts.md`** (Dim 23.10). The ones this plan uses are S3-P3-a…e, g and m; P-1…P-6; §3 reuse; §4 defaults.
- Code map (21.10, line numbers stale): `analysis/behaviours.md` B2, B5, B18; `analysis/strings.md` rows B1, B2 and §3.B.
- Piece 1 ledger notes for the draft layer and the lesson drawer: `docs/superpowers/plans/2026-10-21-admin-ux-global-ledger.md` T10, T11 and L170/L183.

## Global Constraints

- **Built as designed.** Layout, behaviour and strings follow, in this order: the README, then the Part 3 desktop prototype, then the Part 4 phone prototype, then the notes (spec D1). Where the README gives no layout, take it from the prototype and name the frame in the commit message.
- **Text.** Quote every string exactly from the README, the „Outcome“ column of `strings.md`, or `piece3-texts.md`. A text none of these give is a blocker to report, not one to write.
- **Strings.** Every admin string lives in `adminEt` (`src/i18n/dict/admin.ts`) and is filled with `fill()`. Admin text is Estonian only. „Mustand“ stays out of the draft layer's texts (behaviours B2): a published course with unpublished changes says „Avaldamata muudatused“.
- **Piece 1 and 2 parts, used as they are** (`src/components/admin/`):
  - `useAutosave({owner, key, version, fields, save, validate?, label, title?, focusField?})` with `patchSender(url)`, and the route helper `autosaveHandler({schema, read, write})` inside `withAdmin`.
  - `SaveStatus {status, draft?, compact?, thing?, onShowInvalid?}`.
  - `PublishBar {changed, previewHref, blocked?, onDiscard, onPublish}`.
  - `ConfirmPanel` (the parent renders it in place of its trigger and refocuses it; while `busy`, „Katkesta“ and Esc do nothing).
  - `useUndo().show({text, undo: () => Promise<boolean | string>})`, which lasts 8 s; a string answer is shown as the refusal.
  - `ListToolbar`, `ListRows`, `ListEmpty`, `MoreMenu {…, buttonLabel?, variant?}`, `PillChoice`, `Drawer`, `LangSwitch` / `I18nInput`.
  - The draft layer `src/server/drafts.ts`: `readDrafts`, `saveDraftPart` (numeric versions), `discardDrafts`, and `publishDrafts(db, entity, id, Publisher)`.
- **Look.**
  - Existing tokens and admin colours only. The row highlight is `#faf6f8`; the status accent for „RU puudub“ and „Kontrolli“ is `#6b4f5c` (README B2).
  - Tap targets are ≥ 44 px. Focus ring is `2px solid var(--rose)`, offset 2. No motion under `prefers-reduced-motion`.
  - Every bottom-fixed or sticky admin part carries `data-fab-avoid` (the 💬 bubble lifts above it).
  - Anchors clear the 64 px phone top bar below 900 px (`scroll-margin-top`).
- **Old iPads.** No regex lookbehind and no `crypto.randomUUID`. New non-`"use client"` browser modules get a line in `BROWSER_FILES` (`tests/unit/old-safari.test.ts`). Drag must work with pointer events and touch on iOS 15.
- **Admin guards.**
  - Every admin route is `export const METHOD = withAdmin(…)`.
  - Every admin page calls `requireAdmin()`.
  - Every `server/actions/admin*.ts` export is `adminAction(…)`.
  - When an action file's exports change, update the list `tests/unit/admin-guards.test.ts` pins.
- **Test plan.** Each behaviour change marks `src/data/testplan.json`: `"mark": "new" | "redo" | "reworded"`, with `"markedAt": "deploy"`, which overrides an earlier ISO stamp.
  - `checkPlan` rules: 1–8 lines per check, each line ≤ 20 words ending in a full stop.
  - Never change the `id` of a check that has answers.
  - Run `npx vitest run tests/unit/testplan-file.test.ts tests/unit/testplan-rules.test.ts` after every change.
  - Guards over marks use `markedSince` (accept "deploy" or an ISO stamp). Do not run the stamp tool.
- **Strings that leave or change.** Sweep `tests/` and `src/data/testplan.json` for the old text in the same task.
- **E-mail addresses.** None real in tracked files; use `@example.test`.
- **E2E concurrency.** Before each Playwright run, check that :3000, :3997 and :3998 are not listening on a process you did not start. If one is, wait and re-check every 60 s, up to 30 min. Never kill what isn't yours.
- **Commands** (from `app/`):
  - unit and db: `npx vitest run <file>`;
  - types: `npx tsc --noEmit --incremental false`;
  - lint: `npm run lint`;
  - build: `npm run build`;
  - e2e: `npx playwright test <spec> --no-deps`, one spec at a time. The local Docker DB is `mslab-pg`; on CONNECT_TIMEOUT run `docker desktop restart`, then `docker start mslab-pg`.
  - About 130 `TimeoutOverflowWarning`s in db runs come from PGlite internals and are harmless.
- **Migration.** This plan adds only `drizzle/0020_course_drafts.sql` (Task 2). Generate it with `npm run db:generate`, check the SQL by hand, and apply it to the local e2e DB.

## Rulings carried (spec silent; spec §12 leaves "how each editor's fields map to draft parts" to the builder)

- **R-a. Course parts.**
  - The draft parts are:
    - `basics`: type, level, slug, language, title, summary, body;
    - `outcomes`;
    - `includes` (contact);
    - `protocolStages`;
    - `test` (e-course, `course_tests`);
    - `certificate`: skills and volume (e-course);
    - `price`: the e-course `price`, `accessMonths`, `videoCount`, `nextDiscount`, or the contact `priceGroup`, `priceIndividual`, `durationLabel`;
    - `badge`;
    - `gallery`: images;
    - `recommendations`;
    - `outline`: module and lesson order, module titles, lesson titles and short texts, for existing rows of a published course.
  - `published` and `isSample` are instant switches, not drafted.
  - Each part's live version is `contentVersion` of its live value.
- **R-b. One version string per part for the autosave engine.** It is `"l:<liveHash>"` while no draft exists and `"d:<draftVersion>"` once one does.
  - On a published course:
    - a save on `l:` whose hash matches creates the draft, with the live hash as its base;
    - `d:` saves compare-and-set the draft;
    - anything else is a conflict.
  - On an unpublished course the part writes the live record, by hash compare.
- **R-c. Publishing.** `publishDrafts` with a course `Publisher` runs in one transaction: it locks the course row, checks every part's base against its live version, then writes.
  - A part that changed meanwhile stays a draft and is listed as blocked (S3-P3-b, "changed meanwhile").
  - The existing course rules hold at publish. A published course needs a price (S3-P3-b „Puudub: hind“). A slug must be unique; a taken slug is refused already at the draft save with the existing slug error.
  - Revalidation is `{kind:"courses"}` once after commit.
  - Discard and publish take the same lock order: the course row first, then the drafts. This avoids the 40P01 deadlock in the piece 1 ledger.
- **R-d. Switching „Avaldatud“ off on a course with pending drafts** first publishes them in the same transaction, then sets `published = false`. If any part is blocked, the switch is refused and the blocked list shows (S3-P3-b). Switching it on keeps today's price rule.
- **R-e. B18 modules and lessons on a published course.**
  - A new module or lesson is a real row with `unpublished = true`. It is invisible to students and on the public page until „Avalda muudatused“ clears the flag.
  - Text edits and reorder of existing rows go into the `outline` draft. Rows flagged `unpublished` are edited and moved directly, since nobody sees them.
  - Instant, as today (the media model, behaviours B18): video upload or replace, lesson kind (Video→Tekst asks the README ConfirmPanel), „Õpilastele nähtav“ (hidden), and file add or „Eemalda“.
  - Deleting a module (only without lessons) or a lesson (only without progress) is instant after its ConfirmPanel. Nothing depends on it, so the draft gains nothing.
  - „Loobu muudatustest“ also deletes the rows flagged `unpublished`, with their Bunny and R2 cleanup in `after()`.
  - On an unpublished course everything is direct.
- **R-f. Lesson file „Eemalda“** sets `lesson_files.removed_at`. Every reader filters `removed_at is null`. Undo clears it. The R2 object and row are purged lazily at the start of the next lesson-file action, or by `listCourseLessons` for rows removed ≥ 10 s ago, with the daily sweep as backstop. 10 s is a minimum.
- **R-g. Encode progress (S6).** `lessons.video_progress smallint null` is written from Bunny's `encodeProgress` by `refreshLessonVideo`, the poll and the webhook. Rows show „Töötlemisel {n}%“ when a number exists and „Töötlemisel“ otherwise (S3-P3-e).
- **R-h. Draft-mode reads.** Public readers lay drafts over live only when `(await draftMode()).isEnabled` and the request carries a live admin session (the piece 1 ledger notes that draft mode outlives logout). Otherwise they read live.

## Review Focus

1. **Two tabs on one published course.** The same part is edited in both tabs, then one publishes. Expected: the other tab's next save is a conflict (never a silent overwrite), and a part changed under a draft is listed as blocked at publish (S3-P3-b). (Task 4 db tests.)
2. **A published course with students during editing.** Students and the public page see only live values and only rows without `unpublished`, until „Avalda muudatused“. After publish they see the new order and texts at once. Expected: no draft text, new lesson or answer key leaks into the account JSON or the ISR page. (Tasks 2, 5, 6 tests.)
3. **Draft mode after logout, or for a visitor.** Expected: the public course page reads live data unless the request has a live admin session, even with the draft-mode cookie still set. (Task 6 db/route test.)
4. **Touch drag on a phone or old iPad.** Lists are dragged with a finger and reordered with ↑/↓ and the phone move menu. Expected: one final order is saved, with no duplicate or lost row, focus stays on the moved row, and the move is announced (S3-P3-m). (Task 1 DOM tests, Task 3 and Task 9 e2e on mobile.)
5. **The lesson drawer at 375 px with a running upload.** Expected: focus moves to the progress line when the picker unmounts, progress is announced at 25 % steps, ✕ while uploading asks (leave guard, reason `upload`), and „Eemalda“ undo works inside the open dialog. (Task 10 tests.)

---

### Task 1: Shared parts — DragList, SectionMap, euro helper

**Files:**
- Create: `src/components/admin/DragList.tsx` (+ `.module.css`), `src/components/admin/SectionMap.tsx` (+ css), `src/domain/money-text.ts`.
- Modify: the five copies of the `bare()` euro helper (piece 2 final review L114; grep `const bare`) to use `money-text.ts`.
- Test: `tests/unit/drag-list-dom.test.ts`, `section-map-dom.test.ts`, `money-text.test.ts`.

**Interfaces:**
- `DragList<T> {items: T[]; keyOf(item): string; label(item, index): string; onMove(fromIndex, toIndex): void; renderRow(item, index, handle: ReactNode, arrows: ReactNode): ReactNode; disabled?: boolean}`.
  - It renders a handle „⋮⋮“ with `aria-roledescription="lohistatav"` and `aria-label` = S3-P3-m (`Lohista: {nimi}` / `Lohista rida {n}`).
  - ↑/↓ buttons, disabled at the ends.
  - Pointer and touch drag (`pointerdown` / `pointermove` / `pointerup` with `setPointerCapture`; `touch-action: none` on the handle only).
  - It moves the row visually and calls `onMove` once on drop.
  - A polite live region announces `„{nimi}“ on nüüd {k}. kohal.` / `Rida {n} on nüüd {k}. kohal.` after any move.
  - Focus stays on the moved row's handle or arrow.
- `SectionMap {sections: {id: string; label: string; count?: number; flag?: "ru" | "check"}[]}`.
  - From 1180 px it is a 190 px sticky list of links. Each link shows its count, or „RU puudub“ or „Kontrolli“ in `#6b4f5c`.
  - Below 1180 px it is a select „Jaotised ▾“ that scrolls to the chosen card.
  - Cards need `scroll-margin-top: 24px` from 900 px and `calc(64px + 24px)` below 900 px; export the class name for cards.
- `euro(cents: number): string` and `euroBare(cents: number): string` in `domain/money-text.ts`, with the same output as today's copies. Add it to `BROWSER_FILES`.

- [ ] **Step 1: Failing tests.**
  - `drag-list-dom`: dragging row 1 below row 3 calls `onMove(0, 2)` once; ↑ on row 2 calls `onMove(1, 0)`; arrows are disabled at the ends; after a move the live region reads `„B“ on nüüd 1. kohal.`; `disabled` hides handles and arrows; the handle has `aria-roledescription="lohistatav"` and `aria-label="Lohista: B"`.
  - `section-map-dom`: renders counts and the „RU puudub“ / „Kontrolli“ flags; the select variant scrolls to the card.
  - `money-text`: the outputs match the five old helpers' cases.
- [ ] **Step 2: Run** the three files; expect FAIL.
- [ ] **Step 3: Implement.** Replace the five helpers.
- [ ] **Step 4: Run** the tests, `old-safari.test.ts` and the tests of the five changed files; expect PASS.
- [ ] **Step 5: Commit** `feat(admin): shared parts for the B screens — DragList, SectionMap, one euro helper`.

### Task 2: Migration 0020 and the readers

**Files:**
- Create: `drizzle/0020_course_drafts.sql`, via `db:generate`.
- Modify:
  - `src/db/schema.ts`: `course_modules.unpublished boolean not null default false`, `lessons.unpublished boolean not null default false`, `lessons.video_progress smallint`, `lesson_files.removed_at timestamptz`.
  - Readers: `src/server/lesson-outline.ts` (`courseOutline`), `src/server/lesson-data.ts` (`visibleLesson`, file lists, `lessonFileFor`), `src/db/queries/public.ts` (`listModuleTitles`), `src/server/lesson-files.ts` (position max), `src/server/admin-lessons.ts` (`listCourseLessons`, `deleteLessonForm` file list), `src/app/api/cron/sweep/route.ts` (+ its pinned JSON).
- Create: `src/server/lesson-file-purge.ts` (`purgeRemovedLessonFiles(db, files, now): Promise<number>`; rows with `removed_at <= now − 10 s`; R2 delete after the row delete; never throws).
- Test: `tests/db/migration-0020.test.ts`, `tests/db/lesson-api.test.ts`, `tests/db/admin-lessons.test.ts`, `tests/db/cron-sweep.test.ts`, `tests/db/completion-*.test.ts` (counts).

**Interfaces:**
- Produces:
  - **Students' and public readers** never return `unpublished` modules or lessons, nor `removed_at` files. A student's outline, completion counts, lesson GET, progress, files and downloads all follow this.
  - **Admin readers** return them with the flag. `AdminModule.unpublished`, `AdminLesson.unpublished` and `AdminLesson.videoProgress: number | null` are added.
  - `purgeRemovedLessonFiles` is called from the lesson-file actions (Task 10) and the daily sweep. Add `files` to the sweep's JSON answer and update its pinned test.

- [ ] **Step 1: Failing db tests.**
  - An unpublished module and its lessons are absent from `courseOutline`, the public `listModuleTitles` and the completion totals.
  - A student GET of an unpublished lesson is 404.
  - A removed file is absent from the student's file list and its download is 404.
  - The admin `listCourseLessons` includes the unpublished rows with the flag and leaves out removed files.
  - `purgeRemovedLessonFiles` deletes rows removed 11 s ago, keeps one removed 5 s ago, and deletes their R2 keys.
  - The migration test applies 0020 on top of 0019 with rows present, and the defaults are false/null.
- [ ] **Step 2: Run** the files; expect FAIL.
- [ ] **Step 3: Generate the migration.** Check that the SQL is exactly four `ALTER TABLE … ADD COLUMN`. Then implement the reader filters and the purge.
- [ ] **Step 4: Run** the db tests and `tsc`; expect PASS. Apply 0020 to the local e2e DB. Run `npx playwright test tests/e2e/account-ecourse.spec.ts tests/e2e/lesson-player.spec.ts --no-deps`.
- [ ] **Step 5: Commit** `feat(courses): migration 0020 — unpublished modules and lessons, removed lesson files, video progress; students never read them`.

### Task 3: B1 Koolitused list

**Files:**
- Modify: `src/app/admin/(panel)/koolitused/page.tsx`, `courses.module.css`, `src/components/admin/CourseOrder.tsx` (replaced by the list's `DragList`), `src/db/queries/admin.ts` (`moveCourseTo`, list read with a draft flag), `src/server/actions/admin-content.ts` (`moveCourseToAction`), `src/components/admin/ListToolbar.tsx` (make `placeholder` optional: no search field when absent), `src/i18n/dict/admin.ts`.
- Test: `tests/db/admin-content.test.ts` (ordering), `tests/unit/list-toolbar-dom.test.ts`, `tests/e2e/admin-edit.spec.ts` (~:564 course order), `tests/e2e/admin-list-widths.spec.ts`.

**Interfaces:**
- Consumes Task 1's `DragList`.
- Produces:
  - `moveCourseTo(db, id: number, index: number): Promise<"ok" | "notFound">`: one transaction, `FOR UPDATE` over all courses, then renumber `sort` 1…n. It replaces the swap-based `moveCourse`; the up/down arrows call it with `index ± 1`.
  - `listAllCourses` rows gain `changes: boolean`, true when `content_drafts` has a row for entity `course` with that course id.

**Exact behaviour (README B1, P-1, S3-P3-m):**
- The shared list table and `ListRows`; the whole row opens the editor.
- Columns: drag handle | ↑/↓ | 56 px thumbnail | title + "{tase} · /{slug}" | Õppevorm tag | price on two lines | Märgis | Staatus („Avaldatud“ / „Mustand“ / „Avaldamata muudatused“). The „Muudetud“ column goes.
- Pills with counts, through `ListToolbar` without search.
- In a filtered view the handles and arrows are hidden, and the hint „Järjekorda saab muuta vaates „Kõik“.“ shows.
- On a phone, a „↕“ `MoreMenu` offers „Üles“ / „Alla“ / „Esimeseks“ / „Viimaseks“.
- Replace the lead text per P-1.

- [ ] **Step 1: Failing tests.**
  - db: `moveCourseTo(c3, 0)` puts it first and the rest keep their order; an index past the end goes last.
  - The list row has `changes` true when a draft exists.
  - DOM: `ListToolbar` without `placeholder` renders no search input.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Run `admin-edit.spec.ts`: update the course order test to drag and ↑/↓, and add a mobile case with the move menu. Run `admin-list-widths.spec.ts`, adding Koolitused at 1180/1280/1440.
- [ ] **Step 5: Test plan.**
  - `haldus-koolitus-jarjekord` `redo` (drag or arrows, filtered-view hint).
  - `haldus-loend-terve-rida` `reworded` if it lists the screens.
- [ ] **Step 6: Commit** `feat(admin): B1 Koolitused — drag and arrows, one moveCourseTo, pill counts, „Avaldamata muudatused“`.

### Task 4: Course parts and the course Publisher (server)

**Files:**
- Create: `src/server/course-parts.ts`, `src/app/api/admin/koolitus/[id]/osa/[part]/route.ts` (POST autosave), `src/app/api/admin/koolitus/[id]/avalda/route.ts` (POST publish), `src/app/api/admin/koolitus/[id]/loobu/route.ts` (POST discard).
- Modify: `src/server/admin-content.ts` (split `saveCourseForm`'s checks into per-part checks used by both the live write and the publish), `src/db/queries/admin.ts` (part-level writers, or `saveCourseWithImages` per part), `src/server/actions/admin-content.ts` (`setCoursePublished` with R-d; `setCourseSample`).
- Test: `tests/db/course-parts.test.ts` (new), `tests/db/admin-content.test.ts` (existing course rules keep holding), `tests/unit/admin-guards.test.ts`.

**Interfaces:**
- Produces:
  - `COURSE_PARTS` (the R-a list) and `CoursePart`.
  - `partLabels(part, value): string[]`: the P-3 labels for the PublishBar.
  - `readCoursePart(db, courseId, part): Promise<{version: string; value: unknown} | null>`: R-b versions.
  - `writeCoursePart(db, courseId, part, patch, version, admin, now): Promise<SaveAnswer>`: draft on a published course, live on an unpublished one, with per-part validation through the existing field errors.
  - `coursePublisher(courseId): Publisher` (R-c).
  - `publishCourse(db, courseId, now): Promise<{published: string[]; blocked: {part: string; reason: "changed" | "missing"; fields: string[]}[]}>`.
  - `discardCourse(db, courseId): Promise<number>`, which also deletes `unpublished` rows (R-e), with media cleanup through `after()` in the route.
  - `courseChanges(db, courseId): Promise<{part: string; labels: string[]}[]>`.
  - The routes answer the autosave contract, `{published, blocked}`, and `{discarded}`.

- [ ] **Step 1: Failing db tests.**
  - **Published course:**
    - A `basics` save on `l:<hash>` creates a draft and the live title is unchanged.
    - A second save on `d:1` updates it.
    - A save on a stale `l:` is a conflict.
    - Publishing writes the title and revalidates once.
    - A part whose live value changed after its draft began is blocked with `changed`.
    - Clearing the price in the draft blocks with `missing` and `fields: ["hind"]`.
    - A slug taken by another course is refused at save with the existing slug error.
    - Discard deletes the drafts and leaves live untouched.
  - **Unpublished course:** a save writes live at once, with no draft row.
  - **R-d:** switching off with a pending title draft publishes it, then unpublishes. A blocked part refuses the switch and unpublishes nothing.
  - **Locks:** `publishCourse`, `discardCourse` and `writeCoursePart` each take `lockCourse(tx, id)` (`SELECT … FROM courses WHERE id = $1 FOR UPDATE`) before they touch `content_drafts`. The test asserts that order in a query log, as the piece 2 invoice lock-order test does, so the publish-versus-discard deadlock (ledger 40P01) cannot happen.
  - **Answer key:** the test part's draft never appears in `getCourseBySlug`'s result.
- [ ] **Step 2: Run** `npx vitest run tests/db/course-parts.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Keep every existing course rule: the type lock, the cleared fields of the other type, and price-when-published.
- [ ] **Step 4: Run** the tests, `tests/db/admin-content.test.ts`, `admin-guards` and `tsc`; expect PASS.
- [ ] **Step 5: Commit** `feat(courses): course parts on the draft layer — autosave per part, publish and discard`.

### Task 5: The outline in the draft (B18 server)

**Files:**
- Modify: `src/server/course-parts.ts` (the `outline` part), `src/server/admin-lessons.ts` (create flagged rows on a published course; direct edits for flagged rows; delete rules R-e), `src/server/actions/admin-lessons.ts`, `src/server/lesson-outline.ts` (draft overlay in preview only, for Task 6).
- Test: `tests/db/course-outline-draft.test.ts` (new), `tests/db/admin-lessons.test.ts`.

**Interfaces:**
- Produces:
  - The `outline` part value: `{modules: {id: number; title: I18n; lessons: {id: number; title: I18n; body: I18n}[]}[]}`. It holds the order and texts of the rows that are not flagged.
  - `addModule` and `addLesson` on a published course create `unpublished = true` rows.
  - Publish clears every flag of that course and applies the outline's order and texts.
  - `discardCourse` deletes the flagged rows, returning their media for cleanup.
  - `moveModule` and `moveLesson` on a published course write the outline draft; on flagged rows they move directly.

- [ ] **Step 1: Failing db tests.**
  - On a published course, a new lesson is flagged and absent from the student's outline. After publish it is visible, in the order the draft put it.
  - A renamed module stays live-old until publish.
  - A lesson moved between modules in the draft is moved at publish.
  - Discard removes the flagged lesson and returns its Bunny id and R2 keys.
  - A lesson with progress cannot be deleted (unchanged rule).
  - Deleting a lesson without progress on a published course is instant.
  - Two tabs changing the outline get a conflict.
  - On an unpublished course everything is direct.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `tests/db/admin-lessons.test.ts`, `lesson-api.test.ts` and `tsc`; expect PASS.
- [ ] **Step 5: Commit** `feat(courses): B18 — modules and lessons join the course draft; new rows wait for „Avalda muudatused“`.

### Task 6: Preview in draft mode

**Files:**
- Modify: `src/app/[locale]/(site)/koolitused/[slug]/page.tsx`, `src/app/[locale]/(site)/koolitused/page.tsx` (catalogue), `src/db/queries/public.ts` (`getCourseBySlug` and the list with an optional draft overlay), `src/server/preview.ts` (`previewActive(): Promise<boolean>`, true only with draft mode on **and** a live admin session), `src/app/api/admin/eelvaade/route.ts` (no change, unless the comments describe unwired intent).
- Test: `tests/db/course-preview.test.ts` (new), `tests/db/admin-eelvaade-route.test.ts`.

**Interfaces:**
- Produces:
  - `previewActive()`.
  - `withCourseDrafts(db, course): Promise<Course>`: lays the drafted parts and outline over a live course object (admin preview only), leaving out the test answer key.
  - The ISR pages call `previewActive()` only inside a `draftMode().isEnabled` branch, so normal visitors stay static.

- [ ] **Step 1: Failing tests.**
  - With draft mode on and an admin session, the course page data shows the draft title and the flagged lesson's module.
  - With draft mode on and no admin session (logged out), it shows live data.
  - With draft mode off, it shows live data and makes no session read.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npm run build` (the course page must stay ISR: check the build output marks it as before); expect PASS.
- [ ] **Step 5: Commit** `feat(courses): preview — the public course page shows the draft only in draft mode for a signed-in admin`.

### Task 7: The course editor (B2 layout, autosave per card, PublishBar)

**Files:**
- Modify: `src/components/admin/CourseEditor.tsx` (rewritten into a shell plus one card component per part), `CourseEditor.module.css`, `src/app/admin/(panel)/koolitused/[id]/page.tsx`, `src/app/admin/(panel)/koolitused/uus/page.tsx` (explicit create, S3-P3-g, P-6), `src/i18n/dict/admin.ts`.
- Create: `src/components/admin/course/` (one file per card).
- Test: `tests/unit/course-editor-dom.test.ts` (new), `tests/e2e/admin-edit.spec.ts` (course editor ~:75-624), `tests/unit/admin-fab-avoid.test.ts` (the old editor save bar goes; PublishBar's phone bar is already marked).

**Interfaces:**
- Consumes: Task 4 routes and part versions, Task 1 `SectionMap`, `useAutosave`, `SaveStatus` (`draft` true for a published course, `thing` „koolitust“ P-2), `PublishBar` (`changed` from `courseChanges`, `previewHref` = `/api/admin/eelvaade?tee=/koolitused/{slug}`, `blocked` with the S3-P3-a line on every bar and S3-P3-b sentences), and `LangSwitch`.

**Exact behaviour (README B2, S3-P3-a, b, g, P-2…P-6):**
- **Layout.** From 1180 px: the 190 px section map, a content column, and a 300 px sticky side column. Map entries are only the cards this course type has. Below 1180 px the map is the „Jaotised ▾“ select under the H1, and the side column follows the header.
- **Header.** „← Koolitused“, H1, tags, `LangSwitch`, `SaveStatus`, then the PublishBar when the course is published.
- **Cards.** Every card autosaves its part. The type card follows the draft „Õppevorm“: the cards shown follow the drafted type, and the type lock rule stands.
- **Switches.** „Avaldatud“ (R-d) and „Näidis“ are instant.
- **Leaving.** The old `beforeunload` and „Salvesta“ go; the leave guard covers unsaved fields.
- **New course** (`/admin/koolitused/uus`):
  - the header shows „Täida kohustuslikud väljad“, then „Vajuta „Lisa koolitus“.“ when „Koolituse nimi“ is valid;
  - „Lisa koolitus“ creates the course and opens it;
  - leaving with typed text asks with the reason „Koolitust pole veel lisatud.“ (S3-P3-g).
- Fix the hints that name the removed Save button (P-5).

- [ ] **Step 1: Failing DOM tests.**
  - A published course shows the PublishBar with „Avaldamata muudatused: 2 · Lühikirjeldus, Hind. Avalikul lehel on näha eelmine versioon.“ after two card edits.
  - An unpublished course shows no PublishBar, and its chip shows saved.
  - The section map lists only this type's cards with their counts.
  - The new-course header switches from „Täida kohustuslikud väljad“ to „Vajuta „Lisa koolitus“.“.
  - A blocked publish lists „Puudub: hind“.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the DOM tests and `admin-edit.spec.ts`. Rewrite its steps that used „Salvesta“ to autosave plus „Avalda muudatused“ for a published course. Add the two-tab conflict case and a 375×812 check of the „Jaotised ▾“ select and the PublishBar phone bar.
- [ ] **Step 5: Test plan.**
  - `redo`: `haldus-koolitus-tekst`, `-hind`, `-margis`, `-pildid`, `haldus-ekursus-avalda`, `haldus-kontakt-punktid`, `haldus-ekursus-test`, `-punktid`, `-tunnistus`.
  - New: `haldus-koolitus-mustand-eelvaade` (edit a published course, „Eelvaade ↗“ shows the change, the public page doesn't until „Avalda muudatused“).
  - New: `haldus-koolitus-loobu` (discard).
- [ ] **Step 6: Commit** `feat(admin): B2 course editor — section map, autosave per card, PublishBar with preview, explicit new course`.

### Task 8: List editors — drag, arrows, undo

**Files:**
- Modify: `src/components/admin/ListEditor.tsx`, `GalleryEditor.tsx`, `ProtocolStagesEditor.tsx`, `TestEditor.tsx`; the course cards from Task 7 that host them; `src/i18n/dict/admin.ts`.
- Test: `tests/unit/list-editor-dom.test.ts`, `test-editor-dom.test.ts`, `protocol-stages-dom.test.ts`, `gallery-editor-dom.test.ts` (create if absent).

**Interfaces:**
- Consumes Task 1's `DragList` and `useUndo`.
- Produces stable row ids for JSON-array rows: client keys kept per editor mount and survive an undo. Test question and option ids are unchanged. Errors are keyed by row id, not index (README B2).

**Exact behaviour (README B2, S3-P3-d):**
- Each row has drag and ↑/↓.
- Removing a row is instant, with an UndoBar: „Rida eemaldatud.“, „Küsimus eemaldatud.“, „Vastusevariant eemaldatud.“ or „Pilt eemaldatud.“.
- Undo restores the row at its index with its id, and the part autosaves after the change.
- A programme point's delete keeps its ConfirmPanel „Kas kustutan punkti „{title}“?“ (README; it lives in the modules card for a contact course, Task 9).

- [ ] **Step 1: Failing DOM tests.**
  - Removing outcome 2 shows „Rida eemaldatud.“, and undo puts it back at index 1 with the same key.
  - A removed test question comes back with its original question id, and its options keep theirs.
  - An error on row id X stays on X after a move.
  - Dragging gallery image 3 to 1 saves the new order once.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `admin-edit.spec.ts` (lists ~:321, gallery ~:359).
- [ ] **Step 5: Commit** `feat(admin): list editors — drag and arrows, removal with UndoBar, errors by row id`.

### Task 9: Modules and lessons card

**Files:**
- Modify: `src/components/admin/LessonsEditor.tsx` (+ css), `src/app/admin/(panel)/koolitused/[id]/page.tsx` (online flag from the drafted type, facts §0.6), `src/i18n/dict/admin.ts`.
- Test: `tests/unit/lessons-editor-dom.test.ts` (new), `tests/e2e/admin-lessons.spec.ts`.

**Interfaces:**
- Consumes Task 5's server functions, Task 1's `DragList`, `useAutosave` for inline titles (the `outline` part, or a direct write on flagged rows), and `ConfirmPanel`.

**Exact behaviour (README B2, P-4):**
- Module rows have drag and ↑/↓, and the title edits inline with autosave. The per-module „Salvesta“ goes.
- Lesson rows show the video status tags „Valmis“ / „Töötlemisel {n}%“ (or „Töötlemisel“ with no number, S3-P3-e) / „Video puudub“ / „Tekst“, plus P-4's two undrawn states.
- A contact course's programme point delete asks „Kas kustutan punkti „{title}“?“ / „Jah, kustuta“ / „Katkesta“.
- Deleting a module (only without lessons) asks the same way, with today's question.

- [ ] **Step 1: Failing DOM tests.**
  - A processing lesson with progress 40 shows „Töötlemisel 40%“, and without a number shows „Töötlemisel“.
  - Dragging module 2 above 1 calls the move once.
  - An inline title edit autosaves.
  - The programme point ConfirmPanel uses the exact question.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `admin-lessons.spec.ts`, adding a mobile drag case.
- [ ] **Step 5: Test plan.** Mark `haldus-ekursus-moodul` `redo` (no „Salvesta“; a new lesson on a published course waits for „Avalda muudatused“).
- [ ] **Step 6: Commit** `feat(admin): modules and lessons — drag, inline titles, video tags with progress`.

### Task 10: Lesson drawer rebuild

**Files:**
- Modify:
  - `src/components/admin/LessonDrawer.tsx`, `LessonFiles.tsx`, `LessonVideoField.tsx`;
  - `src/components/admin/Drawer.tsx`: remove the deprecated `confirmClose`, `CloseQuestion` and `useUnsavedInDrawer`, and their dict keys and stubs;
  - `src/app/admin/(panel)/koolitused/[id]/page.tsx`;
  - `src/server/actions/admin-lessons.ts`: `removeLessonFile`, `undoRemoveLessonFile`, purge calls;
  - `src/i18n/dict/admin.ts`.
- Test: `tests/unit/lesson-drawer-dom.test.ts` (new), `lesson-video-field.test.ts`, `drawer-dom.test.ts`, `tests/db/lesson-files.test.ts`, `tests/e2e/admin-lessons.spec.ts`, `admin-video.spec.ts`.

**Interfaces:**
- Consumes: Task 2's `removed_at` and purge, Task 5's text drafts, `useAutosave`, `SaveStatus`, `ConfirmPanel`, `useUndo`, and the leave guard (register the upload as a source with reason `upload`, piece 1 `leave.reasons.upload`).

**Exact behaviour (README B2, S3-P3-c, ledger L136/L139):**
- **Header.** „Moodul {nn} · Õppetund {n.n}“, the title, `SaveStatus`, ✕.
- **Fields.** „Õppetunni nimi“ and „Lühike tekst“ autosave. On a published course with a live lesson they write the `outline` draft; otherwise they write the row directly.
- **„Õppetunni liik“.** Instant. Switching Video→Tekst with a video asks the ConfirmPanel „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“.
- **„Failid“.**
  - A drop zone plus the list.
  - „Eemalda“ is instant, with the UndoBar „Fail eemaldatud.“. Undo clears `removed_at`, and a refusal shows its string.
  - The UndoBar works inside the open dialog; this needs a real-browser e2e (ledger T6-8).
- **„Õpilastele nähtav“.** A switch with the existing hint. Turning it off shows the UndoBar „Õppetund peidetud.“. Turning it on shows no bar.
- **„Kustuta õppetund“.** Offered only without progress. It opens a ConfirmPanel with today's question, „Jah, kustuta“ / „Katkesta“.
- **Focus and announcements.**
  - When the video input unmounts, focus moves to the progress line.
  - Upload progress is announced only at 25 % steps.
  - ✕ while uploading asks through the leave guard.
- **Phone.** The line „Võid lehelt lahkuda — töötlemine jätkub.“ shows (drawn).
- **Not here.** No ET|RU switch in the drawer (Dim 22.10).
- **Test plan.** Add the deferred step for dismissing a file picker in the drawer (ledger L139). The drawer stays open and nothing changes.

- [ ] **Step 1: Failing tests.**
  - DOM:
    - The header reads „Moodul 02 · Õppetund 2.3“.
    - Removing a file shows „Fail eemaldatud.“, and undo restores it.
    - The Video→Tekst ConfirmPanel has the exact texts.
    - The visibility switch off shows „Õppetund peidetud.“.
    - Progress is announced at 0, 25, 50, 75 and 100 only.
    - Focus lands on the progress line when the input unmounts.
  - db: remove then undo restores the file; remove then purge after 10 s deletes the row and the R2 object.
  - The Drawer tests no longer exercise `confirmClose`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `admin-lessons.spec.ts` and `admin-video.spec.ts`. Add a 375×812 check and the UndoBar-in-dialog real-browser case.
- [ ] **Step 5: Test plan.**
  - `haldus-lahkumine-salvestamata` `reworded`: steps 6–8 no longer use the drawer's old question; the leave notice asks instead.
  - `haldus-ekursus-video` `redo`: „Töötlemisel {n}%“.
  - New `haldus-oppetund-fail-eemalda`: „Eemalda“ then „Võta tagasi“.
  - The file-picker step.
- [ ] **Step 6: Commit** `feat(admin): lesson drawer — autosave, ConfirmPanels, files with undo, visibility switch, focus and progress fixes`.

### Task 11: Bunny encode progress (S6)

**Files:**
- Modify: `src/server/bunny.ts` (`getVideo` reads `encodeProgress`), `src/server/lesson-videos.ts` (`refreshLessonVideo` stores `video_progress`; it is cleared when ready or failed), `src/app/api/bunny/webhook/route.ts` (no change if it only triggers a refresh), `tests/e2e/fake-bunny.ts` (returns `encodeProgress`).
- Test: `tests/unit/bunny.test.ts`, `tests/db/lesson-videos.test.ts`.

**Interfaces:**
- Produces `BunnyVideo.encodeProgress: number | null`, a 0–100 integer, or null when absent. `AdminVideo.progress: number | null`.

- [ ] **Step 1: Failing tests.**
  - `getVideo` maps `encodeProgress: 40` to 40 and a missing field to null.
  - A refresh while processing stores 40.
  - When ready, it clears the progress.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.** Verify the field name against Bunny's Stream API reference („Get Video“); if it differs, use the documented name and say so in the report.
- [ ] **Step 4: Run** the tests and `admin-video.spec.ts`.
- [ ] **Step 5: Commit** `feat(courses): S6 — „Töötlemisel {n}%“ from Bunny's encode progress`.

### Task 12: Docs, test-plan sweep and the full run

**Files:**
- Modify:
  - `docs/deploy.md`: new section 23 covering migration 0020 (additive, migrate first, the 20 → 21 count, a read-only check), the course draft rules for Maria (R-a…R-e in plain words), the preview, the lesson file undo, and the rollback note. Before any code rollback after this deploy:
    - first publish or discard every course's changes in the admin; every row that shows „Avaldamata muudatused“ in Koolitused;
    - then check `select count(*) from content_drafts where entity='course'` is 0 and `select count(*) from lessons where unpublished` is 0.

    Old code reads neither the drafts nor the flag, so a flagged lesson would become visible to students.
  - `docs/launch-checklist.md`: Maria's walk of the course editor.
  - `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`: §7 numbering notes 0020, and that piece 3 was split into 3a and 3b.
  - `src/data/testplan.json`.
- Test: the full suites.

- [ ] **Step 1:** Sweep `tests/` and `testplan.json` for every removed or changed string of Tasks 1–11; `git diff main...HEAD -- app/src/i18n/dict/admin.ts` shows the removed values.
- [ ] **Step 2:** Write the docs. Check every claim against the code.
- [ ] **Step 3:** Run `npx vitest run` (all), `tsc`, `lint`, `npm run build`, and the full `npx playwright test` (ports checked). A flake must pass alone; anything failing twice is a finding.
- [ ] **Step 4: Commit** `docs(admin): piece 3a — deploy notes, launch checklist, test plan sweep`.
