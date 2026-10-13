# MS LAB Phase 3a — Lessons, Video and Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An e-course becomes a real course. It has modules with lessons. Each lesson has one Bunny Stream video, a short ET/RU text and optional files. Lessons open in order. The student sees her progress, and the admin can open the next lesson for a stuck student. Everything runs on Vercel Hobby, with no paid plan.

**Architecture:**
- **Data.** Module titles move from `courses.modules` (jsonb) into the table `course_modules`. Lessons, their files and each student's progress get tables of their own. Migration 0003 is additive and copies the titles.
- **Video upload.** Maria uploads a video from her browser straight to Bunny with tus. A server action creates the Bunny video and signs the upload, so the API key never leaves the server. The status is read from Bunny's API: the open editor polls every 5 s, and Bunny's webhook only triggers the same read.
- **Student pages.** They stay static shells: `/konto/kursus/<slug>` and the new `/konto/kursus/<slug>/<lessonId>`. Both load everything from `/api/konto/*`.
- **Player.** The lesson endpoint signs a 4-hour Bunny embed URL. The page wraps Bunny's iframe with the student's e-mail as a moving watermark and its own fullscreen. A small Player.js listener posts progress.
- **Lesson files.** They are private R2 objects under `lessons/`. The API checks access and lesson order, then answers with a 302 to a 5-minute presigned GET.

**Tech Stack:**
- Next.js 16.3.8 (pinned exactly — do not upgrade), React 19, TypeScript.
- Drizzle 0.45 + postgres.js 3.4 (Railway); PGlite for DB tests.
- Vitest (+ happy-dom for DOM tests), Playwright.
- aws4fetch: R2, now also presigned GET and DELETE.
- Bunny Stream: REST API, tus, the iframe embed with token authentication, and the Player.js postMessage protocol.
- `tus-js-client` 4.3.1: new, admin only.
- Hosting: Vercel project `mslab`, Hobby plan, region `fra1` (`docs/deploy.md`).

**Spec:** `docs/superpowers/specs/2026-10-05-phase3a-lessons-video-design.md`. Read all of it before starting; the section your task names is binding. Bunny facts used here were checked against bunny.net/docs on 05.10.2026 (Task 3 names the pages).

## Global Constraints

### Platform limits

- **Vercel Hobby only** (paid plans are ruled out). The limits that bind 3a:
  - **1M function invocations a month.** A watching student posts progress about every 15 s: 4 calls a minute, about 240 an hour.
  - **4.5 MB request body.** Lesson files are limited to 4 MB, the image limit `MAX_IMAGE_BYTES`. Videos never pass through Vercel: tus goes from the browser to Bunny.
  - **Cron jobs at most daily.** 3a adds no cron: the existing `/api/cron/sweep` also deletes Bunny uploads stuck for more than 24 h.
  - **100 GB data transfer.** Videos are served by Bunny; files by R2, through a signed URL.
- **Bunny Stream is pay-as-you-go** (spec 8). Never call the real Bunny from a test. The e2e run uses the fake server `tests/e2e/fake-bunny.ts`, and unit/DB tests inject `fetch`.

### Static shells and the account API

- **`/konto…` pages are static shells** (phase 2a rule, unchanged).
  - The new lesson shell `app/[locale]/(site)/konto/kursus/[slug]/[lesson]/page.tsx` reads only `params`. It has `generateStaticParams() → []`, and loads nothing personal.
  - No `cookies()`, `headers()`, `connection()` or `searchParams`.
  - Links carry state in the fragment. The middleware answers any query on a shell with a 303 into the fragment, `no-store`.
  - Check: `next build` lists `/[locale]/konto/kursus/[slug]/[lesson]` as prerendered (● / ○), never ƒ. The local `E2E_PROD_BUILD=1` cache spec answers the lesson shell from the cache with no `Set-Cookie` (Task 9).
- **Personal data comes only from `/api/konto/*` JSON** with `Cache-Control: private, no-store`.
  - Every endpoint behind a session starts with `requireClient(request, deps)` and answers through `clientResponse(session, …)`. Lesson files go through `fileAnswer`, a helper outside the guarded section that carries the session's cookies too.
  - `tests/unit/account-guards.test.ts` lists every handler: extend it.
  - The route uses the app's one pool (`getDb()`); never `end()` it.
- **Every check runs in this order (spec 6):** session (one device) → active access to the course (not expired or revoked; unpublished courses still work) → the lesson is a visible lesson of that course (404) → terms accepted (lesson page only, 403 `terms`) → lesson order (403 `locked`). After the session, this order lives in one place: `openLesson` (`lesson-data.ts`, Task 7).
- **Ids read from text** (form fields, address segments, query values) all go through one parser, `parseRowId` in `src/lib/row-id.ts` (Task 5): digits only, no leading zero, 1 … 2 147 483 647.

### Simplicity and design

- **Simplicity rules** (phase 2a spec 2.1) still bind:
  - Each screen has one plain next-step sentence and at most one primary button.
  - The e-course page's one button is "Jätka" ("Alusta" before the first lesson).
  - The lesson page's one button is "Järgmine õppetund", or "Märgi tehtuks" in its place while a text lesson is not done, plus a quiet "Tagasi koolitusele" link. A video lesson that is not done and whose video is not ready shows "Video lisandub peagi" and an empty button slot.
  - No extra setup steps for students.
- **A lesson's kind is explicit** (controller ruling, 05.10.2026): `lessons.kind` is `"video"` (the default) or `"text"`, chosen by the admin ("Õppetunni liik"). It is never inferred from a missing video.
  - A text lesson is completed with "Märgi tehtuks".
  - A video lesson is completed only by the 90 % rule on a playable video. While its video is `none`, `uploading`, `processing` or `failed` (and no replaced video plays), nothing completes it: progress and "tehtud" answer 409 `{ error: "video" }`. The lessons after it therefore stay locked.
- **Design rules (Dim): simple in steps and words, not a new look.**
  - Use the public site's components, fonts (Jost/Manrope), colour tokens (`src/styles/tokens.css` only), button styles (`ui.btn`, `ui.btnOutline`, `ui.link`) and icons (`Icon`: `check`, `play`, `lock`, `arrow`).
  - The admin uses its existing `ui.module.css`, `Drawer` and the inline confirm pattern of `RevokeAccess`.
  - Touch targets ≥ 44 px. Mobile first (390 px; check 834/1440/2560). Respect `prefers-reduced-motion`. No horizontal page overflow.
  - Reviewers check that no new visual style, colour or component appears where an existing one fits.

### Admin and text rules

- **Admin guards.** Admin pages call `requireAdmin()`. Route handlers are `export const POST = withAdmin(…)`. Server actions are `export const name = adminAction(…)` in `src/server/actions/admin*.ts` (`tests/unit/admin-guards.test.ts`: extend its export lists).
- **Dictionaries.** Every student string goes in `src/i18n/dict/et.ts` **and** `ru.ts`, and the parity, placeholder and Cyrillic tests stay green. Russian keeps the existing typography: a no-break space (` `) after a one-letter word. Admin strings are ET only, in `src/i18n/dict/admin.ts`.
  - The spec's texts are used verbatim: "Jätka", "Alusta", "Avaneb, kui eelmine õppetund on tehtud.", "Järgmine õppetund", "Tagasi koolitusele", "Lae alla", "Video lisandub peagi", "Õppetund tehtud ✓", "Märgi tehtuks", "Video ei lae. Proovi hiljem uuesti.", "Moodulid ja õppetunnid", "Peida", "Töötlemisel…", "Valmis · 12:34", "Asenda video", "Üleslaadimine katkes", "Proovi uuesti", "Töötlemine ebaõnnestus", "Lae uuesti üles", "Video seadistamata", "5/24 tehtud", "Ava järgmine õppetund".
- **No real e-mail addresses** anywhere in the repo (`tests/unit/test-addresses.test.ts`). Tests use `@example.test`. The GitHub repo is **public**.

### Secrets, logging and the database

- **No PII and no secrets in logs.** Use `logFailure` / `logNote` from `src/server/log.ts`. Never log an e-mail, a Bunny key, a tus signature, an embed token or URL, or a signed R2 URL.
  - Exception: the Bunny webhook secret travels in the URL query (spec 8 chose a query secret; the webhook sends no header the app checks), so it appears in Vercel request logs — accepted. It only lets someone ask the app to re-read a video's status.
- **Bunny secrets stay on the server.** `BUNNY_API_KEY` and `BUNNY_TOKEN_KEY` never reach the browser. The browser gets only a tus signature for one video id (6 h) and a signed embed URL (4 h).
  - The Bunny settings are the three variables `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` (+ the optional `BUNNY_WEBHOOK_SECRET`). There is no `BUNNY_CDN_HOST`: the embed needs only the library and video id (spec 8).
  - `BUNNY_FAKE_URL` exists for the e2e run only and is ignored when `VERCEL` is set.
  - Without the three Bunny settings, the admin shows "Video seadistamata" and students see "Video lisandub peagi".
- **`courses.modules` stays** in `schema.ts` and in the database through 3a. After Task 1 no code reads or writes it.
  - Migration `0008` drops it in Task 12, **code first, then the migration**. Drizzle selects every column it knows, so dropping the column before the code stops knowing it would break every course query.
- **No Railway writes, no deploys and no push before Task 12.**
  - Migration `0003_lessons.sql` is generated in Task 1 and applied **locally only** (`npm run db:migrate` against `localhost`).
  - Tests and tools never write to Railway (the e2e run refuses non-local databases, `tests/e2e/local-db.ts`).
  - Merging into `main` deploys production, and pushing any other branch makes a preview. So phase 3a stays on `feat/phase3a-lessons`, local and unpushed, until Task 12.

### Commits and dependencies

- **Commits:** Conventional Commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The repo-local `git user.email` stays the GitHub noreply address.
- **One new dependency:** `tus-js-client@4.3.1`, loaded with a dynamic `import()` inside the admin's `LessonVideoField.tsx` only.
  - Why: resumable chunked uploads with retries are Bunny's documented browser path, and the protocol by hand would be about 200 lines.
  - The student side gets no new dependency: Player.js is a small postMessage listener (`player-js.ts`).

---

## File Structure

```
app/
  drizzle/0003_lessons.sql                         (generated + the copy of module titles, Task 1)
  src/db/schema.ts                                 + course_modules, lessons, lesson_files, lesson_progress (Task 1)
  src/db/queries/public.ts                         listModuleTitles; CourseDetail.moduleTitles (Task 1)
  src/domain/lessons.ts                            lock rule, progress, 90 %, resume, duration, reorder, video lifecycle (pure, Task 2)
  src/server/env.ts                                + BUNNY_* (optional, Task 3)
  src/server/bunny.ts                              config, tus signature, embed token/URL, REST client, status map (Task 3)
  src/server/media.ts, r2.ts, media-local.ts, media-store.ts   FileStore: delete + presigned GET (Task 4)
  src/server/lesson-files.ts                       lesson file type/size/signature checks, names, addLessonFile (Task 4)
  src/app/api/admin/lesson-file/route.ts           POST one lesson file (withAdmin, Task 4)
  src/lib/row-id.ts                                parseRowId: the one id parser, client-safe (Task 5)
  src/server/admin-lessons.ts                      modules/lessons/files forms for the admin (DB, Task 5)
  src/server/lesson-media.ts                       removeLessonMedia: Bunny videos + R2 files of a deleted lesson (Task 5)
  src/server/actions/admin-lessons.ts              adminAction exports (Task 5 + 6)
  src/components/admin/LessonsEditor.tsx (+css)    "Moodulid ja õppetunnid" / "Programm" (Task 5)
  src/components/admin/LessonDrawer.tsx, LessonFiles.tsx       one lesson in the Drawer (Task 5)
  src/server/lesson-videos.ts                      start/refresh/sweep a lesson's Bunny video (DB + Bunny, Task 6)
  src/app/api/bunny/webhook/route.ts               Bunny's webhook: a trigger for refreshLessonVideo (Task 6)
  src/components/admin/LessonVideoField.tsx        tus upload, progress, polling, states (Task 6)
  src/server/lesson-outline.ts                     one student's modules/lessons/states/counts (DB, Task 7)
  src/server/lesson-data.ts                        openLesson (the checks, in order), loadLesson, saveProgress, markTextLessonDone, lessonFileFor (Task 7)
  src/server/client-data.ts                        EcourseView with modules + lessons + progress; termsState (Task 1 + 7)
  src/server/account-api.ts, account-input.ts      the lesson endpoints (Task 7)
  src/components/account/player-js.ts             the Player.js messages (Task 8)
  src/components/account/LessonPlayer.tsx (+css)   iframe + watermark + fullscreen + progress posts (Task 8)
  src/components/account/EcourseView.tsx (+css)    progress, Jätka, modules with lesson states (Task 9)
  src/components/account/LessonPage.tsx (+css)     the lesson page's personal part (Task 9)
  src/app/[locale]/(site)/konto/kursus/[slug]/[lesson]/page.tsx   the lesson shell (Task 9)
  src/lib/site-routing.ts                          the lesson route is a known account shell (Task 9)
  src/server/admin-clients.ts (+ actions, ClientDrawer, ClientForms)  progress, "Ava järgmine õppetund" (Task 10)
  src/app/admin/(panel)/opilased/[id]/vaade/[slug]/page.tsx           read-only course view (Task 10)
  src/app/api/cron/sweep/route.ts                  + stuck uploads (Task 11)
  tests/e2e/fake-bunny.ts, bunny-values.ts         the fake Bunny (API, tus, Player.js embed) for the e2e run (Task 6)
  tests/e2e/lessons.ts                             e2e fixtures: an e-course with lessons, a file and a client (Task 9)
  tests/e2e/targets.ts                             smallTargets, shared by the admin and account specs (Task 5)
docs/deploy.md, docs/launch-checklist.md           Bunny setup, env, cron line, launch items (Task 11)
tools/cache-smoke.mjs                              + the lesson shell in part C (Task 12)
```

---

### Task 1: Schema, migration 0003 and module titles from the table

Spec sections 3 and 10. After this task the public course page, the e-course page and the seed use `course_modules`. Nothing reads or writes `courses.modules` any more. The course editor no longer edits module titles; Task 5 brings them back in "Moodulid ja õppetunnid". This is consistent on the branch, because nothing deploys before Task 12.

**Files:**
- Modify: `app/src/db/schema.ts`
- Create: `app/drizzle/0003_lessons.sql` (+ `app/drizzle/meta/0003_snapshot.json` and the `_journal.json` entry, from drizzle-kit)
- Modify: `app/src/db/queries/public.ts`, `app/src/app/[locale]/(site)/koolitused/[slug]/page.tsx`, `app/src/server/client-data.ts`
- Modify: `app/src/db/seed-apply.ts`, `app/src/db/ru-fill.ts`
- Modify: `app/src/domain/course-editor.ts`, `app/src/server/admin-content.ts`, `app/src/components/admin/CourseEditor.tsx`
- Test: `app/tests/db/schema.test.ts` (extend), `app/tests/db/migration-0003.test.ts` (new), `app/tests/db/queries.test.ts` (extend), `app/tests/db/helpers.ts` (+ `addModules`)
- Update: `app/tests/db/seed.test.ts`, `app/tests/db/ru-fill.test.ts`, `app/tests/db/client-data.test.ts`, `app/tests/db/account-api.test.ts`, `app/tests/unit/admin-content.test.ts`, `app/tests/e2e/account.ts`, `app/tests/e2e/fixtures.ts`, `app/tests/e2e/admin-edit.spec.ts`

**Interfaces:**
- Produces, from `src/db/schema.ts`:
  - tables `courseModules`, `lessons`, `lessonFiles`, `lessonProgress`;
  - `type VideoStatus = "none" | "uploading" | "processing" | "ready" | "failed"`;
  - `type LessonKind = "video" | "text"` (the column `lessons.kind`, not null, default `"video"`);
  - types `CourseModule`, `Lesson`, `LessonFile`, `LessonProgressRow` (each the table's `$inferSelect`).
- Produces, from `src/db/queries/public.ts`:
  - `listModuleTitles(db: Db, courseId: number): Promise<I18n[]>`;
  - `CourseDetail` gains `moduleTitles: I18n[]`.
- Produces, from `tests/db/helpers.ts`: `addModules(db: Db, courseId: number, titles: I18n[]): Promise<CourseModule[]>`.
- Unchanged in this task: `EcourseView.course.modules: I18n[]`. Its values now come from `course_modules`; Task 7 changes its shape.

- [ ] **Step 1: Write the failing schema test.** Append it to `tests/db/schema.test.ts` and add `courseModules, lessons, lessonFiles, lessonProgress` to its `@/db/schema` import.

```ts
test("lesson tables: modules, lessons, files and progress, with their defaults, one progress row per student and lesson, cascading with the course", async () => {
  const db = await makeTestDb();
  const [course] = await db.insert(courses).values({ slug: "lt", type: "e_learning", level: "basic", title: { et: "L" }, summary: { et: "" }, body: { et: "" } }).returning();
  const [mod] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "M" } }).returning();
  const [lesson] = await db.insert(lessons).values({ moduleId: mod.id, position: 1, title: { et: "Õ" } }).returning();
  expect([lesson.kind, lesson.hidden, lesson.videoStatus, lesson.videoId, lesson.durationSec, lesson.body, lesson.replacedVideoId, lesson.videoStartedAt]).toEqual(["video", false, "none", null, null, null, null, null]);
  const [text] = await db.insert(lessons).values({ moduleId: mod.id, position: 2, title: { et: "T" }, kind: "text" }).returning();
  expect(text.kind).toBe("text");
  await db.insert(lessonFiles).values({ lessonId: lesson.id, position: 1, name: "a.pdf", r2Key: "lessons/x.pdf", size: 10, contentType: "application/pdf" });
  const [c] = await db.insert(clients).values({ email: "lt@example.test" }).returning();
  const [p] = await db.insert(lessonProgress).values({ clientId: c.id, lessonId: lesson.id }).returning();
  expect([p.watchedSec, p.doneAt, p.unlockedBy]).toEqual([0, null, null]);
  await expect(db.insert(lessonProgress).values({ clientId: c.id, lessonId: lesson.id })).rejects.toThrow();
  await db.delete(courses).where(eq(courses.id, course.id));
  for (const table of [courseModules, lessons, lessonFiles, lessonProgress]) expect(await db.select().from(table)).toHaveLength(0);
});
```

- [ ] **Step 2: Run it — expect FAIL.** Run `cd app && npx vitest run tests/db/schema.test.ts`. It fails with "courseModules is not exported".

- [ ] **Step 3: Add the schema.** In `src/db/schema.ts`, put these after `mailQuota` (they reference `courses` and `clients`, which are declared above). Leave `courses.modules` where it is and add a comment line above it:

```ts
  // Legacy (phase 3a): module titles live in course_modules; nothing reads or writes this column. Migration 0008 drops it after the 3a deploy.
  modules: jsonb("modules").$type<I18n[]>().notNull().default([]),
```

```ts
// ---------- phase 3a: modules, lessons, files, progress ----------

/** A module of a course (an e-course's module, a contact course's programme item), in `position` order (1…n). */
export const courseModules = pgTable("course_modules", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: jsonb("title").$type<I18n>().notNull(),
}, (t) => [index("course_modules_course").on(t.courseId, t.position)]);

/** A lesson video's state: none (no video uploaded yet), uploading (tus to Bunny), processing (Bunny encodes), ready, failed. */
export type VideoStatus = "none" | "uploading" | "processing" | "ready" | "failed";

/**
 * A lesson's kind, chosen by the admin ("Õppetunni liik"): a video lesson is done at 90 % of its video, and cannot be completed
 * while it has no video to play; a text lesson has no video and is done with "Märgi tehtuks". Never inferred from a missing video.
 */
export type LessonKind = "video" | "text";

/**
 * A lesson of an e-course module, in `position` order within its module. `kind`: see LessonKind. `videoId` is the Bunny video
 * uploaded last; `replacedVideoId` is the ready video it replaces ("Asenda video"), which plays until the new one is ready and is
 * then deleted. `videoStartedAt`: when the current upload began (the daily sweep gives up uploads older than 24 h).
 */
export const lessons = pgTable("lessons", {
  id: serial("id").primaryKey(),
  moduleId: integer("module_id").notNull().references(() => courseModules.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: jsonb("title").$type<I18n>().notNull(),
  body: jsonb("body").$type<I18n>(),
  kind: text("kind").$type<LessonKind>().notNull().default("video"),
  hidden: boolean("hidden").notNull().default(false),
  videoId: text("video_id"),
  videoStatus: text("video_status").$type<VideoStatus>().notNull().default("none"),
  durationSec: integer("duration_sec"),
  replacedVideoId: text("replaced_video_id"),
  videoStartedAt: timestamp("video_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("lessons_module").on(t.moduleId, t.position), uniqueIndex("lessons_video").on(t.videoId)]);

/** A downloadable file of a lesson: the private R2 object `r2Key` (lessons/<uuid>.<ext>), shown as `name`. */
export const lessonFiles = pgTable("lesson_files", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  r2Key: text("r2_key").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
}, (t) => [index("lesson_files_lesson").on(t.lessonId, t.position)]);

/**
 * One student's progress on one lesson: `watchedSec` only grows; `doneAt` is set once (≥ 90 % watched, or "Märgi tehtuks");
 * `unlockedBy` is the admin's e-mail when an admin opened this lesson for her ("Ava järgmine õppetund").
 */
export const lessonProgress = pgTable("lesson_progress", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  lessonId: integer("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  watchedSec: integer("watched_sec").notNull().default(0),
  doneAt: timestamp("done_at", { withTimezone: true }),
  unlockedBy: text("unlocked_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clientId, t.lessonId] }), index("lesson_progress_lesson").on(t.lessonId)]);
```

Add these at the end of the type exports:

```ts
export type CourseModule = typeof courseModules.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type LessonFile = typeof lessonFiles.$inferSelect;
export type LessonProgressRow = typeof lessonProgress.$inferSelect;
```

Three columns go beyond the spec's list (spec 3):
- `kind` makes a lesson's type explicit (controller ruling): a text lesson is never inferred from a missing video, so a video lesson whose video is not uploaded yet cannot be skipped.
- `replacedVideoId` implements "old Bunny video deleted after the new one is ready" (spec 4).
- `videoStartedAt` implements "stuck in uploading > 24 h" (spec 7).

- [ ] **Step 4: Generate the migration.** Run `cd app && npx drizzle-kit generate --name lessons`. Open `drizzle/0003_lessons.sql`. It must contain:
  - four `CREATE TABLE`s, the foreign keys with `ON DELETE cascade`, the indexes and the unique index `lessons_video`;
  - **nothing** that drops or alters `courses`.

Then append the copy of the module titles by hand at the end of the file (drizzle-kit does not generate data steps; the snapshot is unaffected):

```sql
--> statement-breakpoint
INSERT INTO "course_modules" ("course_id", "position", "title")
SELECT c."id", m.ord::int, m.value
FROM "courses" c
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c."modules") = 'array' THEN c."modules" ELSE '[]'::jsonb END) WITH ORDINALITY AS m(value, ord);
```

- [ ] **Step 5: Write the migration test** `tests/db/migration-0003.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courseModules, courses } from "@/db/schema";

// Migration 0003 copies every course's module titles (courses.modules, jsonb) into course_modules, in their order, and keeps the
// column (the live code reads it until the 3a deploy). Checked as the Railway database goes through it: 0000–0002 applied, courses
// with titles, then 0003. courses.modules is written and read by plain SQL, and the test stops at 0003, so it stays true after
// migration 0008 drops the column from the schema and the database (Task 12).

/** A copy of ./drizzle whose journal ends with `tag` (the migrator applies what the journal lists, by its time stamps). */
function migrationsThrough(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mslab-migrations-"));
  cpSync("./drizzle", dir, { recursive: true });
  const path = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  expect(at, tag).toBeGreaterThanOrEqual(0);
  journal.entries = journal.entries.slice(0, at + 1);
  writeFileSync(path, JSON.stringify(journal));
  return dir;
}

test("0003 copies the module titles of every course into course_modules, in order; courses.modules stays", async () => {
  const db = drizzle(new PGlite(), { schema });
  const migrateThrough = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await migrateThrough("0002_kv_entries");
  await db.execute(sql`
    insert into courses (slug, type, level, title, summary, body, modules) values
      ('veeb', 'e_learning', 'basic', '{"et":"Veeb"}', '{"et":""}', '{"et":""}', '[{"et":"Üks","ru":"Один"},{"et":"Kaks"},{"et":"Kolm"}]'),
      ('kontakt', 'contact', 'basic', '{"et":"Kontakt"}', '{"et":""}', '{"et":""}', '[{"et":"Programm"}]'),
      ('tuhi', 'contact', 'basic', '{"et":"Tühi"}', '{"et":""}', '{"et":""}', '[]')`);

  await migrateThrough("0003_lessons");

  const id = Object.fromEntries((await db.select({ id: courses.id, slug: courses.slug }).from(courses)).map((c) => [c.slug, c.id]));
  const rows = await db.select().from(courseModules).orderBy(asc(courseModules.courseId), asc(courseModules.position));
  expect(rows.map((r) => [r.courseId, r.position, r.title])).toEqual([
    [id.veeb, 1, { et: "Üks", ru: "Один" }],
    [id.veeb, 2, { et: "Kaks" }],
    [id.veeb, 3, { et: "Kolm" }],
    [id.kontakt, 1, { et: "Programm" }],
  ]);
  const kept = (await db.execute(sql`select slug, jsonb_array_length(modules)::int as n from courses order by slug`)) as unknown as { rows: { slug: string; n: number }[] };
  expect(kept.rows).toEqual([{ slug: "kontakt", n: 1 }, { slug: "tuhi", n: 0 }, { slug: "veeb", n: 3 }]);
});
```

- [ ] **Step 6: Run** `npx vitest run tests/db/schema.test.ts tests/db/migration-0003.test.ts` — expect PASS.

- [ ] **Step 7: Write the failing query test.** Append it to `tests/db/queries.test.ts`, and add the imports `courseModules`, `listModuleTitles` and `getCourseBySlug` if missing:

```ts
test("a course's module titles come from course_modules, in position order (phase 3a)", async () => {
  const db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "moodulid", type: "e_learning", level: "basic", title: { et: "M" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
  await db.insert(courseModules).values([{ courseId: c.id, position: 2, title: { et: "Teine" } }, { courseId: c.id, position: 1, title: { et: "Esimene", ru: "Первый" } }]);
  expect(await listModuleTitles(db, c.id)).toEqual([{ et: "Esimene", ru: "Первый" }, { et: "Teine" }]);
  expect((await getCourseBySlug(db, "moodulid"))?.moduleTitles).toEqual([{ et: "Esimene", ru: "Первый" }, { et: "Teine" }]);
});
```

Add to `tests/db/helpers.ts`:

```ts
import type { I18n } from "@/i18n/field";
import { courseModules, type CourseModule } from "@/db/schema";

/** Module rows for a course (course_modules), positions 1…n in the given order. */
export async function addModules(db: Db, courseId: number, titles: I18n[]): Promise<CourseModule[]> {
  return titles.length ? db.insert(courseModules).values(titles.map((title, i) => ({ courseId, position: i + 1, title }))).returning() : [];
}
```

- [ ] **Step 8: Run it — expect FAIL.** The failure is "listModuleTitles is not exported".

- [ ] **Step 9: Switch the read paths.**
  1. **`src/db/queries/public.ts`.** Import `courseModules`, and the type `I18n` from `@/i18n/field`. Then:

```ts
export type CourseDetail = CourseWithImages & { sessions: SessionWithSeats[]; moduleTitles: I18n[] };

/** The module titles of a course (course_modules), in their order: the public course page and the e-course page show them. */
export async function listModuleTitles(db: Db, courseId: number): Promise<I18n[]> {
  const rows = await db
    .select({ title: courseModules.title })
    .from(courseModules)
    .where(eq(courseModules.courseId, courseId))
    .orderBy(asc(courseModules.position), asc(courseModules.id));
  return rows.map((r) => r.title);
}
```

     In `getCourseBySlug`, replace the last two lines with:

```ts
  const [counts, moduleTitles] = await Promise.all([confirmedBySession(db, course.sessions.map((s) => s.id)), listModuleTitles(db, course.id)]);
  return { ...course, moduleTitles, sessions: course.sessions.map((s) => ({ ...s, confirmed: counts.get(s.id) ?? 0 })) };
```

  2. **`app/[locale]/(site)/koolitused/[slug]/page.tsx`.** Change `pickList(course.modules, locale)` to `pickList(course.moduleTitles, locale)`. Give the outcomes `<ul className={styles.checkList}>` the attribute `data-outcomes=""`; the e2e of step 11 reads it.
  3. **`src/server/client-data.ts`.**
     - `activeAccess` selects `course: { id, slug, title }` (drop `modules: courses.modules`).
     - `loadEcourse` adds `listModuleTitles(db, access.course.id)` to its `Promise.all` and returns `course: { slug, title, modules: <those titles> }`.
     - Import `listModuleTitles` from `@/db/queries/public`.
  4. **`src/db/seed-apply.ts`.**
     - The course loop destructures `modules = []`: `for (const [index, { images, sessions = [], modules = [], ...course }] of courseSeeds.entries())`.
     - After the sessions insert, add `if (modules.length) await tx.insert(courseModules).values(modules.map((title, i) => ({ courseId: created.id, position: i + 1, title })));`.
     - Add `"course_modules"` to `CONTENT_TABLES` after `"course_images"`.
     - Import `courseModules`.
  5. **`src/db/ru-fill.ts`.**
     - Drop `"modules"` from the course list fields (`["outcomes", "includes"]`).
     - After the course images loop, add (import `asc` and `courseModules`):

```ts
    // the module titles (course_modules, by position), each while its Estonian text is still the seed's
    const moduleRows = await db.select().from(courseModules).where(eq(courseModules.courseId, row.id)).orderBy(asc(courseModules.position), asc(courseModules.id));
    for (const [i, m] of moduleRows.entries()) {
      const title = fillI18n(m.title, seed.modules?.[i]);
      if (title) add("course_modules", (tx) => tx.update(courseModules).set({ title }).where(eq(courseModules.id, m.id)));
    }
```

  6. **Remove module titles from the course draft:**
     - `src/domain/course-editor.ts`: delete `modules` from `CourseDraft`, `newCourseDraft()`, `StoredCourse` and `draftFromCourse()`.
     - `src/server/admin-content.ts`: delete `modules: z.array(i18n).max(200),` from `draftSchema`, the line `const modules = c.list("modules", d.modules);`, and `modules,` in `fields`. `courses.modules` is then never written.
     - `src/components/admin/CourseEditor.tsx`: delete the `<section … aria-label={online ? t.sections.modulesE : t.sections.modulesC}>` block with its `ListEditor`, and drop "modules" / "programme" from the component's doc comment.

- [ ] **Step 10: Update the tests that wrote `courses.modules`.**
  - **`tests/db/client-data.test.ts` `seed()`:** drop `modules: [...]` from the `online` insert. After it, add `await addModules(db, online.id, [{ et: "Sissejuhatus" }, { et: "Praktika", ru: "Практика" }]);` (import `addModules` from `./helpers`). The expectations stay as they are.
  - **`tests/db/account-api.test.ts` `seedCourses()`:** do the same with `[{ et: "Sissejuhatus" }, { et: "Praktika" }]`.
  - **`tests/unit/admin-content.test.ts`:** delete `modules: [],` from the draft fixture.
  - **`tests/db/seed.test.ts`:** replace each `online["…"].modules.length` with the count from `listModuleTitles`, e.g. `const moduleCount = async (slug: string) => (await listModuleTitles(db, online[slug].id)).length;`. Then `expect([online[s].accessMonths, online[s].videoCount, await moduleCount(s)]).toEqual([6, 24, 6])`, and the same with `[6, 8, 3]` and `[6, 12, 4]`.
  - **`tests/db/ru-fill.test.ts`:**
    - Delete `modules: c.modules.map(etOnly) as never,` from the setup update.
    - After the course loop add `for (const m of await db.select().from(courseModules)) await db.update(courseModules).set({ title: etOnly(m.title) as never }).where(eq(courseModules.id, m.id));`.
    - In the first test add `expect(plan.counts.course_modules).toBeGreaterThan(0);` before the apply. After it add:

```ts
    const [kuju] = await db.select().from(courses).where(eq(courses.slug, "kulmukuju-ja-summeetria"));
    expect((await listModuleTitles(db, kuju.id))[0]).toEqual({ et: "Sissejuhatus ja töövahendid", ru: "Введение и инструменты" });
```

  - **`tests/e2e/account.ts` `insertEcourseAccess`:**
    - The own course's `insert into courses` loses the `modules` column and value.
    - Right after it add:

```ts
      const [own] = await sql<{ id: number }[]>`select id from courses where slug = ${slug}`;
      await sql`insert into course_modules (course_id, position, title) values
                (${own.id}, 1, ${sql.json({ et: "Sissejuhatus", ru: "Введение" })}), (${own.id}, 2, ${sql.json({ et: "Praktika", ru: "Практика" })})`;
```

    - The `select id, title, modules from courses` becomes `select id, title from courses`, followed by `const modules = await sql<{ title: { et: string; ru?: string } }[]>\`select title from course_modules where course_id = ${course.id} order by position, id\``.
    - Return `modules: modules.map(({ title: m }) => ({ et: m.et, ru: m.ru ?? m.et }))`.
  - **`tests/e2e/fixtures.ts`:** remove `"modules"` from `JSON_COLUMNS`. No e2e test edits a seed course's modules any more, and the column goes in 0008.
  - **`tests/e2e/admin-edit.spec.ts`:**
    - Delete the two assertions on `[data-list-editor="modules"] h3`, and drop "modules" from the comment above them.
    - In the test "lists (ET/RU rows, ↑ ↓, add, remove) are saved in their order", use the outcomes list instead: `const modules = page.locator('[data-list-editor="outcomes"]');` (rename the variable to `outcomes`). Type `E2E õpiväljund` / `E2E результат`.
    - On the public page read `[data-outcomes] li` instead of `[data-modules] li`. The seed courses have 4 outcomes, so "Eemalda rida 3" still exists.

- [ ] **Step 11: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit --incremental false`, then `npm run lint`.
  - Apply locally only: `npm run db:migrate` (the local URL). Then `psql postgres://postgres:postgres@localhost:5432/mslab -c "select count(*) from course_modules"` must equal `select coalesce(sum(jsonb_array_length(modules)), 0) from courses` (25 for an untouched seed: 4 + 4 + 4 + 6 + 3 + 4).
  - Then the e2e specs this task touched (`npx playwright test admin-edit account-ecourse`). Under `next dev` the public course page still lists its modules.

- [ ] **Step 12: Commit.**

```bash
git add app/src/db/schema.ts app/drizzle app/src/db/queries/public.ts "app/src/app/[locale]/(site)/koolitused/[slug]/page.tsx" app/src/server/client-data.ts app/src/db/seed-apply.ts app/src/db/ru-fill.ts app/src/domain/course-editor.ts app/src/server/admin-content.ts app/src/components/admin/CourseEditor.tsx app/tests
git commit -m "feat(db): course_modules, lessons, lesson files and progress; module titles from the table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The lessons domain (pure)

Spec sections 3, 4 and 5. Every rule of who may open what, what counts as done, and how a video is replaced lives here. There is no database or React in this file.

A lesson's kind is explicit (controller ruling): `completion()` says how a lesson can be completed. A video lesson without a playable video cannot be completed at all, so it is never done. `lessonStates` needs no special case for this: a lesson that is not done keeps the next one locked.

**Files:**
- Create: `app/src/domain/lessons.ts`
- Test: `app/tests/unit/lessons.test.ts`

**Interfaces:**
- Consumes: `type VideoStatus`, `type LessonKind` (Task 1).
- Produces, from `src/domain/lessons.ts`:
  - `type LessonState = "done" | "current" | "locked"`
  - `type OrderedLesson = { id: number; done: boolean; unlockedByAdmin: boolean }`
  - `lessonStates(lessons: readonly OrderedLesson[]): LessonState[]`
  - `type CourseProgress = { done: number; total: number; next: number | null }`
  - `courseProgress(lessons: readonly OrderedLesson[]): CourseProgress`
  - `nextLessonAfter(lessons: readonly { id: number }[], id: number): number | null`
  - `isWatched(watchedSec: number, durationSec: number | null): boolean`
  - `resumeAt(watchedSec: number, durationSec: number, done: boolean): number`
  - `formatDuration(totalSec: number): string`
  - `type ModuleLayout = { moduleId: number; lessonIds: number[] }`
  - `moveLesson(layout: readonly ModuleLayout[], lessonId: number, dir: -1 | 1): ModuleLayout[] | null`
  - `type VideoFields = { videoId: string | null; videoStatus: VideoStatus; replacedVideoId: string | null; durationSec: number | null }`
  - `type VideoChange = { next: VideoFields; obsolete: string[] }`
  - `playableVideo(v: VideoFields): string | null`
  - `type Completion = "mark" | "watch" | "wait"`
  - `completion(l: VideoFields & { kind: LessonKind }): Completion`
  - `dropVideo(v: VideoFields): VideoChange` (a lesson switched to "Tekst": every video it has becomes obsolete)
  - `startUpload(v: VideoFields, newVideoId: string): VideoChange`
  - `settleVideo(v: VideoFields, videoId: string, status: "uploading" | "processing" | "ready" | "failed", lengthSec: number): VideoChange | null`
  - `abandonUpload(v: VideoFields): VideoChange`

- [ ] **Step 1: Write the failing tests** `tests/unit/lessons.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  abandonUpload, completion, courseProgress, dropVideo, formatDuration, isWatched, lessonStates, moveLesson, nextLessonAfter, playableVideo, resumeAt,
  settleVideo, startUpload, type OrderedLesson, type VideoFields,
} from "@/domain/lessons";

// Phase 3a (spec 3 and 5): visible lessons in course order; lesson k opens when it is the first, the one before it is done, or
// an admin opened it. Hidden lessons are not in the list at all.

const L = (id: number, done = false, unlockedByAdmin = false): OrderedLesson => ({ id, done, unlockedByAdmin });

describe("lessonStates", () => {
  test("the first is open; the next opens when the one before is done", () => {
    expect(lessonStates([L(1), L(2), L(3)])).toEqual(["current", "locked", "locked"]);
    expect(lessonStates([L(1, true), L(2), L(3)])).toEqual(["done", "current", "locked"]);
    expect(lessonStates([L(1, true), L(2, true), L(3, true)])).toEqual(["done", "done", "done"]);
  });
  test("an admin's unlock opens that lesson only, not the ones after it", () => {
    expect(lessonStates([L(1), L(2), L(3, false, true), L(4)])).toEqual(["current", "locked", "current", "locked"]);
  });
  test("a done lesson stays done whatever is before it (e.g. a lesson shown again after hiding)", () => {
    expect(lessonStates([L(1), L(2, true), L(3)])).toEqual(["current", "done", "current"]);
  });
  test("no lessons, no states", () => expect(lessonStates([])).toEqual([]));
});

describe("courseProgress", () => {
  test("done of total, and Jätka goes to the first open lesson not done", () => {
    expect(courseProgress([L(1, true), L(2), L(3)])).toEqual({ done: 1, total: 3, next: 2 });
    expect(courseProgress([L(1), L(2)])).toEqual({ done: 0, total: 2, next: 1 });
    expect(courseProgress([L(1, true), L(2, true)])).toEqual({ done: 2, total: 2, next: null });
    expect(courseProgress([])).toEqual({ done: 0, total: 0, next: null });
  });
});

test("nextLessonAfter: the next visible lesson in course order, null after the last or for an unknown id", () => {
  const list = [{ id: 4 }, { id: 9 }, { id: 2 }];
  expect(nextLessonAfter(list, 4)).toBe(9);
  expect(nextLessonAfter(list, 9)).toBe(2);
  expect(nextLessonAfter(list, 2)).toBeNull();
  expect(nextLessonAfter(list, 7)).toBeNull();
});

describe("the 90 % rule and the resume point", () => {
  test("watched at 90 % of the length (integer arithmetic), never for a video without a length", () => {
    expect(isWatched(89, 100)).toBe(false);
    expect(isWatched(90, 100)).toBe(true);
    expect(isWatched(677, 754)).toBe(false); // 89.8 %
    expect(isWatched(679, 754)).toBe(true); // 90.05 %
    expect(isWatched(500, null)).toBe(false);
    expect(isWatched(0, 0)).toBe(false);
  });
  test("resume at the saved second, but from the start when done or barely begun, and never in the last 5 s", () => {
    expect(resumeAt(42.7, 100, false)).toBe(42);
    expect(resumeAt(4, 100, false)).toBe(0);
    expect(resumeAt(99, 100, false)).toBe(95);
    expect(resumeAt(80, 100, true)).toBe(0);
  });
  test("durations as the admin and the student read them", () => {
    expect(formatDuration(754)).toBe("12:34");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(-3)).toBe("0:00");
  });
});

describe("moveLesson (↑ ↓ within and across modules)", () => {
  const layout = [{ moduleId: 10, lessonIds: [1, 2] }, { moduleId: 20, lessonIds: [] }, { moduleId: 30, lessonIds: [3] }];
  test("swaps with its neighbour inside the module", () => {
    expect(moveLesson(layout, 2, -1)).toEqual([{ moduleId: 10, lessonIds: [2, 1] }, { moduleId: 20, lessonIds: [] }, { moduleId: 30, lessonIds: [3] }]);
  });
  test("past the end of its module: to the start of the next one (an empty one too), or the end of the one before", () => {
    expect(moveLesson(layout, 2, 1)).toEqual([{ moduleId: 10, lessonIds: [1] }, { moduleId: 20, lessonIds: [2] }, { moduleId: 30, lessonIds: [3] }]);
    expect(moveLesson(layout, 3, -1)).toEqual([{ moduleId: 10, lessonIds: [1, 2] }, { moduleId: 20, lessonIds: [3] }, { moduleId: 30, lessonIds: [] }]);
  });
  test("the very first and the very last cannot move further; an unknown id is null; the input is not changed", () => {
    expect(moveLesson(layout, 1, -1)).toBeNull();
    expect(moveLesson(layout, 3, 1)).toBeNull();
    expect(moveLesson(layout, 99, 1)).toBeNull();
    expect(layout[0].lessonIds).toEqual([1, 2]);
  });
});

describe("a lesson's video: upload, replacement, the sweep", () => {
  const none: VideoFields = { videoId: null, videoStatus: "none", replacedVideoId: null, durationSec: null };
  const ready: VideoFields = { videoId: "old", videoStatus: "ready", replacedVideoId: null, durationSec: 300 };

  test("what plays: the ready video, nothing while an upload is on its way", () => {
    expect(playableVideo(none)).toBeNull();
    expect(playableVideo(ready)).toBe("old");
    expect(playableVideo({ videoId: "new", videoStatus: "processing", replacedVideoId: null, durationSec: null })).toBeNull();
  });

  test("first upload; a replacement keeps the ready video playing until the new one is ready, then deletes it", () => {
    expect(startUpload(none, "v1")).toEqual({ next: { videoId: "v1", videoStatus: "uploading", replacedVideoId: null, durationSec: null }, obsolete: [] });
    const replacing = startUpload(ready, "new");
    expect(replacing).toEqual({ next: { videoId: "new", videoStatus: "uploading", replacedVideoId: "old", durationSec: 300 }, obsolete: [] });
    expect(playableVideo(replacing.next)).toBe("old");
    expect(completion({ ...replacing.next, kind: "video" })).toBe("watch");
    expect(settleVideo(replacing.next, "new", "processing", 0)).toEqual({ next: { ...replacing.next, videoStatus: "processing" }, obsolete: [] });
    expect(settleVideo(replacing.next, "new", "ready", 754.4)).toEqual({ next: { videoId: "new", videoStatus: "ready", replacedVideoId: null, durationSec: 754 }, obsolete: ["old"] });
  });

  test("a retry gives up the unfinished or failed upload but keeps the replaced one", () => {
    const failed: VideoFields = { videoId: "bad", videoStatus: "failed", replacedVideoId: "old", durationSec: 300 };
    expect(startUpload(failed, "again")).toEqual({ next: { videoId: "again", videoStatus: "uploading", replacedVideoId: "old", durationSec: 300 }, obsolete: ["bad"] });
  });

  test("news about another video (an older upload) changes nothing", () => {
    expect(settleVideo({ videoId: "new", videoStatus: "uploading", replacedVideoId: "old", durationSec: 300 }, "old", "ready", 10)).toBeNull();
  });

  test("the daily sweep: the replaced video comes back, or the lesson has no video again", () => {
    expect(abandonUpload({ videoId: "new", videoStatus: "uploading", replacedVideoId: "old", durationSec: 300 })).toEqual({ next: { videoId: "old", videoStatus: "ready", replacedVideoId: null, durationSec: 300 }, obsolete: ["new"] });
    expect(abandonUpload({ videoId: "v1", videoStatus: "uploading", replacedVideoId: null, durationSec: null })).toEqual({ next: none, obsolete: ["v1"] });
  });

  test("switched to “Tekst”: every video of the lesson becomes obsolete and the lesson has none", () => {
    expect(dropVideo({ videoId: "new", videoStatus: "uploading", replacedVideoId: "old", durationSec: 300 })).toEqual({ next: none, obsolete: ["new", "old"] });
    expect(dropVideo(ready)).toEqual({ next: none, obsolete: ["old"] });
    expect(dropVideo(none)).toEqual({ next: none, obsolete: [] });
  });
});

describe("completing a lesson: the kind is explicit (controller ruling)", () => {
  const none: VideoFields = { videoId: null, videoStatus: "none", replacedVideoId: null, durationSec: null };

  test("a text lesson is completed with “Märgi tehtuks”", () => {
    expect(completion({ ...none, kind: "text" })).toBe("mark");
  });

  test("a video lesson is completed by watching a playable video (90 %), and by nothing else", () => {
    expect(completion({ videoId: "v", videoStatus: "ready", replacedVideoId: null, durationSec: 300, kind: "video" })).toBe("watch");
    for (const videoStatus of ["none", "uploading", "processing", "failed"] as const)
      expect(completion({ ...none, videoId: videoStatus === "none" ? null : "v", videoStatus, kind: "video" }), videoStatus).toBe("wait");
  });
  // That a waiting video lesson keeps the next one locked is checked end to end in Task 7's DB test (the API refuses to complete it).
});
```

- [ ] **Step 2: Run it — expect FAIL.** Run `npx vitest run tests/unit/lessons.test.ts`. The module is missing.

- [ ] **Step 3: Implement** `src/domain/lessons.ts`:

```ts
import type { LessonKind, VideoStatus } from "@/db/schema";

// The learning rules of phase 3a (spec 3, 4, 5), pure: which lessons a student may open, how a lesson is completed, where the
// course goes on, how a lesson moves in the admin's list, and how a lesson's video is uploaded, replaced and given up. No database,
// no React (tests/unit/lessons.test.ts).

export type LessonState = "done" | "current" | "locked";

/** A visible lesson of a course, in course order (module position, then lesson position), with one student's progress. */
export type OrderedLesson = { id: number; done: boolean; unlockedByAdmin: boolean };

/**
 * The state of each lesson, in the same order. Lesson k is open when it is the first, when the lesson before it is done, or when an
 * admin opened it for this student ("Ava järgmine õppetund"). Done wins; open and not done is "current"; the rest is "locked".
 * Hidden lessons are not in the list, so they neither count nor block.
 */
export function lessonStates(lessons: readonly OrderedLesson[]): LessonState[] {
  return lessons.map((l, i) => {
    if (l.done) return "done";
    return i === 0 || lessons[i - 1].done || l.unlockedByAdmin ? "current" : "locked";
  });
}

export type CourseProgress = { done: number; total: number; next: number | null };

/** "5 / 24 õppetundi tehtud" and where "Jätka" goes: the first open lesson that is not done (null when none is left). */
export function courseProgress(lessons: readonly OrderedLesson[]): CourseProgress {
  const at = lessonStates(lessons).indexOf("current");
  return { done: lessons.filter((l) => l.done).length, total: lessons.length, next: at < 0 ? null : lessons[at].id };
}

/** The visible lesson after `id` in course order ("Järgmine õppetund"), or null (the last one, or not in the list). */
export function nextLessonAfter(lessons: readonly { id: number }[], id: number): number | null {
  const at = lessons.findIndex((l) => l.id === id);
  return at >= 0 && at + 1 < lessons.length ? lessons[at + 1].id : null;
}

/** Has a student watched enough of a video of `durationSec` seconds: at least 90 % of it (spec 5)? A video without a length never. */
export function isWatched(watchedSec: number, durationSec: number | null): boolean {
  return durationSec !== null && durationSec > 0 && watchedSec * 10 >= durationSec * 9;
}

/** Where the player starts: the saved second, unless the lesson is done or barely begun (then the start); never in the last 5 s. */
export function resumeAt(watchedSec: number, durationSec: number, done: boolean): number {
  if (done || watchedSec < 5) return 0;
  return Math.max(0, Math.min(Math.floor(watchedSec), durationSec - 5));
}

/** A video's length as the admin reads it: "12:34", "1:02:03". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** The admin's lessons of a course: its modules in order, each with its lessons in order (hidden ones too). */
export type ModuleLayout = { moduleId: number; lessonIds: number[] };

/**
 * ↑ / ↓ on a lesson: it swaps with its neighbour in the module; at the top of a module ↑ moves it to the end of the module before,
 * at the bottom ↓ to the start of the module after (an empty one too). null when it cannot move or is unknown. A new layout.
 */
export function moveLesson(layout: readonly ModuleLayout[], lessonId: number, dir: -1 | 1): ModuleLayout[] | null {
  const m = layout.findIndex((x) => x.lessonIds.includes(lessonId));
  if (m < 0) return null;
  const out = layout.map((x) => ({ moduleId: x.moduleId, lessonIds: [...x.lessonIds] }));
  const list = out[m].lessonIds;
  const i = list.indexOf(lessonId);
  const j = i + dir;
  if (j >= 0 && j < list.length) {
    [list[i], list[j]] = [list[j], list[i]];
    return out;
  }
  const target = m + dir;
  if (target < 0 || target >= out.length) return null;
  list.splice(i, 1);
  if (dir < 0) out[target].lessonIds.push(lessonId);
  else out[target].lessonIds.unshift(lessonId);
  return out;
}

/** A lesson's video columns (schema `lessons`). */
export type VideoFields = { videoId: string | null; videoStatus: VideoStatus; replacedVideoId: string | null; durationSec: number | null };
/** The columns after a change, and the Bunny videos nobody plays any more (to delete). */
export type VideoChange = { next: VideoFields; obsolete: string[] };

/** The video students get: the ready one, or during a replacement the old one; null when there is none to play. */
export function playableVideo(v: VideoFields): string | null {
  return v.videoStatus === "ready" && v.videoId ? v.videoId : v.replacedVideoId;
}

/**
 * How a lesson can be completed. The kind is explicit (lessons.kind), never inferred from a missing video:
 * - "mark": a text lesson, done with "Märgi tehtuks";
 * - "watch": a video lesson whose video plays (a ready one, or the replaced one during a replacement), done at 90 % of it;
 * - "wait": a video lesson with nothing to play yet (none, uploading, processing, failed). The student sees "Video lisandub peagi";
 *   nothing completes it, so the lessons after it stay locked.
 */
export type Completion = "mark" | "watch" | "wait";

export function completion(l: VideoFields & { kind: LessonKind }): Completion {
  if (l.kind === "text") return "mark";
  return playableVideo(l) && l.durationSec !== null ? "watch" : "wait";
}

/** The admin switches a lesson to "Tekst": every video it has (the current upload, a replaced one) becomes obsolete. */
export function dropVideo(v: VideoFields): VideoChange {
  return {
    next: { videoId: null, videoStatus: "none", replacedVideoId: null, durationSec: null },
    obsolete: [v.videoId, v.replacedVideoId].filter((id): id is string => id !== null),
  };
}

/** A new upload of `newVideoId` begins. A ready video becomes the replaced one (it keeps playing); an unfinished or failed one is given up. */
export function startUpload(v: VideoFields, newVideoId: string): VideoChange {
  if (v.videoStatus === "ready" && v.videoId) return { next: { ...v, videoId: newVideoId, videoStatus: "uploading", replacedVideoId: v.videoId }, obsolete: [] };
  return { next: { ...v, videoId: newVideoId, videoStatus: "uploading" }, obsolete: v.videoId && v.videoId !== newVideoId ? [v.videoId] : [] };
}

/**
 * Bunny's word about `videoId` (the editor's poll, the webhook): null when it is not the lesson's current upload (an older one:
 * nothing changes). Ready: its length is stored and the replaced video becomes obsolete.
 */
export function settleVideo(v: VideoFields, videoId: string, status: "uploading" | "processing" | "ready" | "failed", lengthSec: number): VideoChange | null {
  if (v.videoId !== videoId) return null;
  if (status === "ready") return { next: { videoId, videoStatus: "ready", replacedVideoId: null, durationSec: Math.max(1, Math.round(lengthSec)) }, obsolete: v.replacedVideoId ? [v.replacedVideoId] : [] };
  return { next: { ...v, videoStatus: status }, obsolete: [] };
}

/** An upload left unfinished for a day (the daily sweep): the replaced video comes back, or the lesson has no video again. */
export function abandonUpload(v: VideoFields): VideoChange {
  const obsolete = v.videoId ? [v.videoId] : [];
  if (v.replacedVideoId) return { next: { videoId: v.replacedVideoId, videoStatus: "ready", replacedVideoId: null, durationSec: v.durationSec }, obsolete };
  return { next: { videoId: null, videoStatus: "none", replacedVideoId: null, durationSec: null }, obsolete };
}
```

- [ ] **Step 4: Run it — expect PASS.** Run the test file, then `npx tsc --noEmit --incremental false`.

- [ ] **Step 5: Commit.**

```bash
git add app/src/domain/lessons.ts app/tests/unit/lessons.test.ts
git commit -m "feat(learning): lesson order, progress, 90 % rule and video lifecycle (pure)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bunny Stream configuration, signatures and API client

Spec sections 4, 5 and 8. The facts below come from bunny.net/docs, checked on 05.10.2026:

**API and upload**
- Create, get and delete a video: https://bunny.net/docs/reference/video_createvideo, …/video_getvideo, …/video_deletevideo.
  - Base URL: `https://video.bunnycdn.com/library/{libraryId}/videos[/{videoId}]`.
  - Every call sends the `AccessKey` header.
  - Create takes `{ title }` and answers with `guid`.
  - The `status` codes are 0 Created, 1 Uploaded, 2 Processing, 3 Transcoding, 4 Finished, 5 Error, 6 UploadFailed, 7 JitSegmenting and 8 JitPlaylistsCreated. `length` is in seconds.
- tus: https://bunny.net/docs/reference/tus-resumable-uploads.
  - Endpoint `https://video.bunnycdn.com/tusupload`.
  - Headers `AuthorizationSignature` = sha256 hex of (libraryId + apiKey + expires + videoId), `AuthorizationExpire`, `VideoId` and `LibraryId`.
  - Metadata `filetype` and `title`.
  - The expiry is checked on every POST, HEAD and PATCH; Bunny advises at least 3600 s.

**Embed and player**
- Embed: https://bunny.net/docs/stream/token-authentication, …/stream/embedding and …/stream/player.
  - URL: `https://player.mediadelivery.net/embed/{libraryId}/{videoId}?token=<sha256 hex of (token key + videoId + expires)>&expires=<unix s>`.
  - `iframe.mediadelivery.net` is the deprecated player, to be removed in early 2027.
  - `autoplay` defaults to **true**, so the URL sets `autoplay=false`.
  - `t` sets the start second.
- Player.js: https://bunny.net/docs/stream/playback-api and https://github.com/embedly/player.js/blob/master/SPEC.rst (used in Task 8).

**Webhook**
- https://bunny.net/docs/stream/webhooks.
- The body is `{ VideoLibraryId, VideoGuid, Status }`.
- Its status numbers differ from the API's. The app ignores them and reads the API.

**Deviation from the original spec 8 (now updated):** there is no `BUNNY_CDN_HOST`. The settings are the three variables `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` (+ the optional `BUNNY_WEBHOOK_SECRET`): the iframe embed needs only the library id and the video id, and 3a uses no thumbnails or direct files on the library's CDN hostname.

**Files:**
- Create: `app/src/server/bunny.ts`
- Modify: `app/src/server/env.ts`, `app/.env.example`
- Test: `app/tests/unit/bunny.test.ts`, `app/tests/unit/env.test.ts` (extend)

**Interfaces:**
- Consumes: `sha256(value: string): Promise<string>` (`src/server/token.ts`); `serverEnv()`, `type ServerEnv`.
- Produces, from `src/server/env.ts`: the optional `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY`, `BUNNY_WEBHOOK_SECRET` and `BUNNY_FAKE_URL`.
- Produces, from `src/server/bunny.ts`:
  - `type BunnyConfig = { libraryId: string; apiKey: string; tokenKey: string; webhookSecret: string | null; apiBase: string; tusEndpoint: string; embedBase: string }`
  - `bunnyConfig(env?: BunnyEnv, onVercel?: boolean): BunnyConfig | null`, where `BunnyEnv = Partial<Pick<ServerEnv, "BUNNY_LIBRARY_ID" | "BUNNY_API_KEY" | "BUNNY_TOKEN_KEY" | "BUNNY_WEBHOOK_SECRET" | "BUNNY_FAKE_URL">>`
  - `EMBED_TTL_SEC = 14400`, `UPLOAD_TTL_SEC = 21600`
  - `tusSignature(libraryId: string, apiKey: string, expires: number, videoId: string): Promise<string>`
  - `embedToken(tokenKey: string, videoId: string, expires: number): Promise<string>`
  - `signedEmbedUrl(config: BunnyConfig, videoId: string, expires: number, startSec?: number): Promise<string>`
  - `type BunnyVideo = { status: number; length: number }`
  - `type BunnyApi = { createVideo(title: string): Promise<string>; getVideo(videoId: string): Promise<BunnyVideo | null>; deleteVideo(videoId: string): Promise<void> }`
  - `class BunnyError extends Error { op: "create" | "get" | "delete"; status: number }`
  - `bunnyApi(config: BunnyConfig, fetchImpl?: typeof fetch): BunnyApi`
  - `type BunnyVideoStatus = "uploading" | "processing" | "ready" | "failed"`
  - `lessonVideoStatus(bunnyStatus: number): BunnyVideoStatus`

- [ ] **Step 1: Write the failing tests** `tests/unit/bunny.test.ts`. The vectors were computed with `node:crypto`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { bunnyApi, BunnyError, bunnyConfig, embedToken, lessonVideoStatus, signedEmbedUrl, tusSignature } from "@/server/bunny";

const VIDEO = "11111111-2222-3333-4444-555555555555";
const ENV = { BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "test-api-key", BUNNY_TOKEN_KEY: "test-token-key" };
const CONFIG = bunnyConfig(ENV, false)!;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("signing", () => {
  test("tus (reference/tus-resumable-uploads): sha256 of library id + API key + expiry + video id, lowercase hex", async () => {
    expect(await tusSignature("12345", "test-api-key", 1767225600, VIDEO)).toBe("a6abfdd5d725736f86b8233000c5ba454075e9f9d222198aad1bf74e01fc62ee");
    expect(await tusSignature("12345", "test-api-key", 1767225600, VIDEO)).toBe(sha(`12345test-api-key1767225600${VIDEO}`));
  });
  test("embed token (stream/token-authentication): sha256 of token key + video id + expiry", async () => {
    expect(await embedToken("test-token-key", VIDEO, 1767225600)).toBe("adebd867cd8a745b86fb42b2337b4488d397ad9134efbb4a7da8ed5869a55e48");
  });
  test("the embed URL: player.mediadelivery.net, token, expiry, autoplay off; t only for a resume point (whole seconds)", async () => {
    const url = new URL(await signedEmbedUrl(CONFIG, VIDEO, 1767225600));
    expect(`${url.origin}${url.pathname}`).toBe(`https://player.mediadelivery.net/embed/12345/${VIDEO}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ token: "adebd867cd8a745b86fb42b2337b4488d397ad9134efbb4a7da8ed5869a55e48", expires: "1767225600", autoplay: "false" });
    expect(new URL(await signedEmbedUrl(CONFIG, VIDEO, 1767225600, 95.7)).searchParams.get("t")).toBe("95");
  });
});

describe("bunnyConfig", () => {
  test("all three settings, or no video ('Video seadistamata')", () => {
    expect(bunnyConfig({}, false)).toBeNull();
    expect(bunnyConfig({ ...ENV, BUNNY_TOKEN_KEY: undefined }, false)).toBeNull();
    expect(CONFIG).toEqual({
      libraryId: "12345", apiKey: "test-api-key", tokenKey: "test-token-key", webhookSecret: null,
      apiBase: "https://video.bunnycdn.com", tusEndpoint: "https://video.bunnycdn.com/tusupload", embedBase: "https://player.mediadelivery.net/embed",
    });
    expect(bunnyConfig({ ...ENV, BUNNY_WEBHOOK_SECRET: "s" }, false)?.webhookSecret).toBe("s");
  });
  test("BUNNY_FAKE_URL (the e2e run's fake) replaces the three addresses, and is ignored on Vercel", () => {
    const fake = { ...ENV, BUNNY_FAKE_URL: "http://localhost:3998/" };
    expect(bunnyConfig(fake, false)).toMatchObject({ apiBase: "http://localhost:3998", tusEndpoint: "http://localhost:3998/tusupload", embedBase: "http://localhost:3998/embed" });
    expect(bunnyConfig(fake, true)).toMatchObject({ apiBase: "https://video.bunnycdn.com", embedBase: "https://player.mediadelivery.net/embed" });
  });
});

/** A fetch that records the calls and answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; method: string; headers: Headers; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal });
    return respond(url, init);
  });
  return { calls, fetch: fn as unknown as typeof fetch };
}

describe("the API client", () => {
  test("createVideo: POST …/library/<id>/videos with the AccessKey and the title; answers the guid", async () => {
    const f = fakeFetch(() => Response.json({ guid: VIDEO, status: 0 }));
    expect(await bunnyApi(CONFIG, f.fetch).createVideo("Kulmud · Sissejuhatus")).toBe(VIDEO);
    expect(f.calls[0]).toMatchObject({ url: "https://video.bunnycdn.com/library/12345/videos", method: "POST", body: { title: "Kulmud · Sissejuhatus" } });
    expect(f.calls[0].headers.get("accesskey")).toBe("test-api-key");
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal); // a timeout, and Next.js's fetch does not deduplicate a call with a signal (server/r2.ts)
  });
  test("createVideo without a guid in the answer, or with an error status, is a BunnyError", async () => {
    await expect(bunnyApi(CONFIG, fakeFetch(() => Response.json({})).fetch).createVideo("x")).rejects.toThrow(new BunnyError("create", 200));
    await expect(bunnyApi(CONFIG, fakeFetch(() => new Response("no", { status: 401 })).fetch).createVideo("x")).rejects.toThrow(new BunnyError("create", 401));
  });
  test("getVideo: status and length; null for an unknown video (404)", async () => {
    const f = fakeFetch((url) => (url.endsWith(VIDEO) ? Response.json({ guid: VIDEO, status: 4, length: 754, title: "x" }) : new Response("", { status: 404 })));
    const api = bunnyApi(CONFIG, f.fetch);
    expect(await api.getVideo(VIDEO)).toEqual({ status: 4, length: 754 });
    expect(await api.getVideo("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(f.calls[0]).toMatchObject({ url: `https://video.bunnycdn.com/library/12345/videos/${VIDEO}`, method: "GET" });
  });
  test("deleteVideo: DELETE; 404 counts as gone; another status is an error that names the operation and status only", async () => {
    const ok = fakeFetch(() => Response.json({ success: true }));
    await bunnyApi(CONFIG, ok.fetch).deleteVideo(VIDEO);
    expect(ok.calls[0]).toMatchObject({ url: `https://video.bunnycdn.com/library/12345/videos/${VIDEO}`, method: "DELETE" });
    await bunnyApi(CONFIG, fakeFetch(() => new Response("", { status: 404 })).fetch).deleteVideo(VIDEO);
    const err = await bunnyApi(CONFIG, fakeFetch(() => new Response("key test-api-key", { status: 401 })).fetch).deleteVideo(VIDEO).catch((e) => e);
    expect(err).toEqual(new BunnyError("delete", 401));
    expect(String(err.message)).not.toContain("test-api-key");
  });
});

test.each([
  [0, "uploading"], [1, "processing"], [2, "processing"], [3, "processing"], [4, "ready"], [5, "failed"], [6, "failed"], [7, "processing"], [8, "processing"],
] as const)("Bunny status %i → %s", (n, status) => expect(lessonVideoStatus(n)).toBe(status));
```

In `tests/unit/env.test.ts`, add `"BUNNY_LIBRARY_ID", "BUNNY_API_KEY", "BUNNY_TOKEN_KEY", "BUNNY_WEBHOOK_SECRET", "BUNNY_FAKE_URL"` to the list of optional names in the test at line 37. Add them with values to the object at line 43 and to the `toMatchObject` at line 46.

- [ ] **Step 2: Run** `npx vitest run tests/unit/bunny.test.ts tests/unit/env.test.ts`. Expect FAIL.

- [ ] **Step 3: Add the settings** to `src/server/env.ts`. Add these fields to `ServerEnv`, after `CRON_SECRET`:

```ts
  /** Bunny Stream (lesson videos): the library's id, its API key (server only), its embed token authentication key (server only). All three or no video. */
  BUNNY_LIBRARY_ID?: string;
  BUNNY_API_KEY?: string;
  BUNNY_TOKEN_KEY?: string;
  /** The query secret of the webhook URL (/api/bunny/webhook?secret=…). Optional: the webhook only triggers a status read. */
  BUNNY_WEBHOOK_SECRET?: string;
  /** The e2e run's fake Bunny server (tests/e2e/fake-bunny.ts). Ignored on Vercel (server/bunny.ts). */
  BUNNY_FAKE_URL?: string;
```

and the same five names at the end of `OPTIONAL`. In `app/.env.example`, append after `CRON_SECRET=`:

```
# Bunny Stream, the lesson videos (docs/deploy.md section 10): the video library's id, its API key and its token authentication key
# (Security → Token Authentication). All three or none: without them the admin's video field says "Video seadistamata" and
# students see "Video lisandub peagi". The keys are sensitive: Vercel only, never in a file
# BUNNY_LIBRARY_ID=
# BUNNY_API_KEY=
# BUNNY_TOKEN_KEY=
# a long random string; the webhook URL in Bunny is https://<site>/api/bunny/webhook?secret=<it>
# BUNNY_WEBHOOK_SECRET=
# the e2e run's fake Bunny server (tests/e2e/fake-bunny.ts sets it for the server it starts); never on Vercel, where it is ignored
# BUNNY_FAKE_URL=
```

- [ ] **Step 4: Implement** `src/server/bunny.ts`:

```ts
import { serverEnv, type ServerEnv } from "./env";
import { sha256 } from "./token";

// Bunny Stream, the lesson videos' host (spec 3a section 2): one video library. Maria's browser uploads straight to it with tus;
// students watch in its iframe player through a signed embed URL. Configuration, the two signatures and a small client of its REST
// API; no database. bunny.net/docs (checked 05.10.2026):
// - API: https://video.bunnycdn.com/library/{libraryId}/videos[/{videoId}], header AccessKey (reference/video_createvideo,
//   video_getvideo, video_deletevideo);
// - tus: https://video.bunnycdn.com/tusupload; AuthorizationSignature = sha256(libraryId + apiKey + expires + videoId), checked on
//   every request (reference/tus-resumable-uploads);
// - embed: https://player.mediadelivery.net/embed/{libraryId}/{videoId}?token=sha256(tokenKey + videoId + expires)&expires=…
//   (stream/token-authentication; iframe.mediadelivery.net is the deprecated player); autoplay defaults to on, `t` starts at a
//   second (stream/player).

export type BunnyConfig = {
  libraryId: string;
  apiKey: string;
  tokenKey: string;
  /** The webhook URL's query secret; null: the webhook is taken without one (it only triggers a status read from the API). */
  webhookSecret: string | null;
  apiBase: string;
  tusEndpoint: string;
  embedBase: string;
};

type BunnyEnv = Partial<Pick<ServerEnv, "BUNNY_LIBRARY_ID" | "BUNNY_API_KEY" | "BUNNY_TOKEN_KEY" | "BUNNY_WEBHOOK_SECRET" | "BUNNY_FAKE_URL">>;

const API = "https://video.bunnycdn.com";
const PLAYER = "https://player.mediadelivery.net/embed";

/**
 * The library, or null when the three settings are not all there (the admin's video field says "Video seadistamata", students see
 * "Video lisandub peagi"). BUNNY_FAKE_URL points the API, tus and the player at the e2e run's fake (tests/e2e/fake-bunny.ts); never
 * on Vercel (VERCEL is set there, build and runtime), whatever the project's variables say.
 */
export function bunnyConfig(env: BunnyEnv = serverEnv(), onVercel: boolean = Boolean(process.env.VERCEL)): BunnyConfig | null {
  if (!env.BUNNY_LIBRARY_ID || !env.BUNNY_API_KEY || !env.BUNNY_TOKEN_KEY) return null;
  const fake = !onVercel && env.BUNNY_FAKE_URL ? env.BUNNY_FAKE_URL.replace(/\/+$/, "") : null;
  return {
    libraryId: env.BUNNY_LIBRARY_ID,
    apiKey: env.BUNNY_API_KEY,
    tokenKey: env.BUNNY_TOKEN_KEY,
    webhookSecret: env.BUNNY_WEBHOOK_SECRET ?? null,
    apiBase: fake ?? API,
    tusEndpoint: `${fake ?? API}/tusupload`,
    embedBase: fake ? `${fake}/embed` : PLAYER,
  };
}

/** How long a signed embed URL plays (spec 5: about 4 hours). */
export const EMBED_TTL_SEC = 4 * 3600;
/** How long one tus upload may go on (Bunny checks the expiry on every request and advises an hour at least). */
export const UPLOAD_TTL_SEC = 6 * 3600;

export const tusSignature = (libraryId: string, apiKey: string, expires: number, videoId: string): Promise<string> => sha256(`${libraryId}${apiKey}${expires}${videoId}`);

export const embedToken = (tokenKey: string, videoId: string, expires: number): Promise<string> => sha256(`${tokenKey}${videoId}${expires}`);

/** The player's address for one video, signed until `expires` (unix seconds); autoplay off; `startSec` > 0 starts there. */
export async function signedEmbedUrl(config: BunnyConfig, videoId: string, expires: number, startSec = 0): Promise<string> {
  const query = new URLSearchParams({ token: await embedToken(config.tokenKey, videoId, expires), expires: String(expires), autoplay: "false" });
  if (startSec >= 1) query.set("t", String(Math.floor(startSec)));
  return `${config.embedBase}/${encodeURIComponent(config.libraryId)}/${encodeURIComponent(videoId)}?${query}`;
}

export type BunnyVideo = { status: number; length: number };

export type BunnyApi = {
  /** A new, empty video titled `title`; its guid. */
  createVideo(title: string): Promise<string>;
  /** Its status and length (s), or null when Bunny does not know it (404). */
  getVideo(videoId: string): Promise<BunnyVideo | null>;
  /** Deletes it; a video that is gone already (404) is fine. */
  deleteVideo(videoId: string): Promise<void>;
};

/** Bunny answered with a status the client does not take: the operation and the status only (never the URL, the key or the answer). */
export class BunnyError extends Error {
  constructor(
    readonly op: "create" | "get" | "delete",
    readonly status: number,
  ) {
    super(`Bunny ${op} answered ${status}`);
    this.name = "BunnyError";
  }
}

/** Bunny has 10 s to answer (the admin waits on create; the cron and the webhook on get and delete). */
const ANSWER_TIMEOUT_MS = 10_000;

const discard = (res: Response) => void res.body?.cancel().catch(() => {});

/** The REST client. `fetchImpl` is the platform's fetch (looked up at each call); tests pass a fake. Every call carries a signal (server/r2.ts explains why). */
export function bunnyApi(config: BunnyConfig, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): BunnyApi {
  const videos = `${config.apiBase}/library/${encodeURIComponent(config.libraryId)}/videos`;
  async function send(url: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
    try {
      return await fetchImpl(url, {
        method,
        headers: { AccessKey: config.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async createVideo(title) {
      const res = await send(videos, "POST", { title });
      if (!res.ok) {
        discard(res);
        throw new BunnyError("create", res.status);
      }
      const json = (await res.json().catch(() => null)) as { guid?: unknown } | null;
      if (typeof json?.guid !== "string" || !json.guid) throw new BunnyError("create", res.status);
      return json.guid;
    },
    async getVideo(videoId) {
      const res = await send(`${videos}/${encodeURIComponent(videoId)}`, "GET");
      if (res.status === 404) {
        discard(res);
        return null;
      }
      if (!res.ok) {
        discard(res);
        throw new BunnyError("get", res.status);
      }
      const json = (await res.json().catch(() => null)) as { status?: unknown; length?: unknown } | null;
      return { status: typeof json?.status === "number" ? json.status : -1, length: typeof json?.length === "number" ? json.length : 0 };
    },
    async deleteVideo(videoId) {
      const res = await send(`${videos}/${encodeURIComponent(videoId)}`, "DELETE");
      discard(res);
      if (!res.ok && res.status !== 404) throw new BunnyError("delete", res.status);
    },
  };
}

export type BunnyVideoStatus = "uploading" | "processing" | "ready" | "failed";

/**
 * A lesson's video state from Bunny's video status (video_getvideo): 4 Finished → ready; 5 Error, 6 UploadFailed → failed;
 * 0 Created → still uploading; 1 Uploaded, 2 Processing, 3 Transcoding, 7–8 (JIT) and anything new → processing. Only 4 counts as
 * ready (3 may already play some resolutions; waiting for 4 is the safe side).
 */
export function lessonVideoStatus(bunnyStatus: number): BunnyVideoStatus {
  if (bunnyStatus === 4) return "ready";
  if (bunnyStatus === 5 || bunnyStatus === 6) return "failed";
  return bunnyStatus === 0 ? "uploading" : "processing";
}
```

- [ ] **Step 5: Run** the tests — expect PASS. Then run `npx vitest run`, `tsc` and lint.

- [ ] **Step 6: Commit.**

```bash
git add app/src/server/bunny.ts app/src/server/env.ts app/.env.example app/tests/unit/bunny.test.ts app/tests/unit/env.test.ts
git commit -m "feat(video): Bunny Stream configuration, tus and embed signatures, API client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Lesson file store and the upload route (server)

Spec sections 4 and 6. Lesson files live in the image store under the **private** prefix `lessons/`. `/media` serves only `img/<uuid>.<ext>` keys (`isMediaKey`), so a lesson file is never public.

The store learns two things here: `delete`, and on R2 a presigned GET. The download name is stored as the object's `Content-Disposition` at upload time. R2's documentation does not list the `response-content-disposition` override on presigned GETs, so the plan does not rely on it.

**Files:**
- Modify: `app/src/server/media.ts` (`FileStore`, `put` with an optional disposition)
- Modify: `app/src/server/r2.ts` (`delete`, `signedGetUrl`, the disposition on `put`)
- Modify: `app/src/server/media-local.ts` (`delete`), `app/src/server/media-store.ts` (returns `FileStore | null`)
- Create: `app/src/server/lesson-files.ts`, `app/src/app/api/admin/lesson-file/route.ts`
- Test: `app/tests/unit/r2.test.ts`, `app/tests/unit/media-local.test.ts` (extend), `app/tests/unit/lesson-files.test.ts`, `app/tests/db/lesson-files.test.ts` (new), `app/tests/fakes.ts` (`fakeMediaStore` gains `delete`, `deleted`, `disposition`), `app/tests/unit/admin-guards.test.ts` (the new route in the expected list)

**Interfaces:**
- Consumes: `lessons`, `lessonFiles` (Task 1); `MAX_IMAGE_BYTES`, `UploadError`, `UploadReason`, `hasImageSignature`, `type ImageType` (`media.ts`); `storable` (`src/lib/storable.ts`); `withAdmin` (`auth.ts`); `getDb`, `logFailure`, `logNote`.
- Produces, from `media.ts`:
  - `MediaStore.put(key: string, bytes: ArrayBuffer, contentType: string, disposition?: string): Promise<void>`
  - `type FileStore = MediaStore & { delete(key: string): Promise<void>; signedGetUrl?(key: string, opts: { expiresSec: number }): Promise<string> }`
- `r2Store(config, fetchImpl?)` and `localStore(dir?)` return `FileStore`; `mediaStore(…)` returns `FileStore | null`. `R2Error.op` is `"put" | "get" | "delete"`.
- Produces, from `lesson-files.ts`:
  - `LESSON_FILE_TYPES`, `type LessonFileType`
  - `lessonFileType(file: { type: string; name: string }): LessonFileType | null`
  - `hasFileSignature(type: LessonFileType, head: Uint8Array): boolean`
  - `cleanFileName(raw: string, ext: string): string`
  - `attachmentHeader(name: string): string`
  - `FILE_URL_TTL_SEC = 300`
  - `type StoredLessonFile = { id: number; name: string; size: number; contentType: LessonFileType }`
  - `addLessonFile(db: Db, store: FileStore, lessonId: number, file: File): Promise<StoredLessonFile | "notFound">`, which throws `UploadError` for a refused file.
- Produces the route `POST /api/admin/lesson-file`. Multipart fields are `lessonId` and `file`.
  - Success: 201 `{ ok: true, file: StoredLessonFile }`.
  - 400 `{ error: "missing" | "empty" }`; 404 `{ error: "notFound" }`; 413 `{ error: "size" }`; 415 `{ error: "type" | "content" }`; 503 `{ error: "storage" }`; 500 `{ error: "server" }`.
- Produces, from `tests/fakes.ts`: `fakeMediaStore` objects carry `disposition: string | null`; the store gains `deleted: string[]` and `delete(key)`.

- [ ] **Step 1: Write the failing pure tests** `tests/unit/lesson-files.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { attachmentHeader, cleanFileName, hasFileSignature, lessonFileType } from "@/server/lesson-files";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("lesson file types: PDF, Word (.docx), JPEG, PNG, WebP", () => {
  test("the browser's type, or the extension when it sends none (some send none for .docx)", () => {
    expect(lessonFileType({ type: "application/pdf", name: "a.pdf" })).toBe("application/pdf");
    expect(lessonFileType({ type: "", name: "Juhend.DOCX" })).toBe(DOCX);
    expect(lessonFileType({ type: "application/octet-stream", name: "x.pdf" })).toBe("application/pdf");
    expect(lessonFileType({ type: "text/html", name: "x.pdf" })).toBeNull();
    expect(lessonFileType({ type: "", name: "x.doc" })).toBeNull();
    expect(lessonFileType({ type: "image/svg+xml", name: "x.svg" })).toBeNull();
  });
  test("the first bytes must be the type: %PDF-, a ZIP for .docx, the image signatures", () => {
    expect(hasFileSignature("application/pdf", PDF)).toBe(true);
    expect(hasFileSignature("application/pdf", ZIP)).toBe(false);
    expect(hasFileSignature(DOCX, ZIP)).toBe(true);
    expect(hasFileSignature(DOCX, PDF)).toBe(false);
    expect(hasFileSignature("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });
});

describe("the name the student sees", () => {
  test("no folder, one line, the extension kept when cut at 120, a fallback when nothing is left", () => {
    expect(cleanFileName("C:\\Users\\maria\\Juhend 1.pdf", "pdf")).toBe("Juhend 1.pdf");
    expect(cleanFileName("a/b/  Kaks\n rida.pdf ", "pdf")).toBe("Kaks rida.pdf");
    const long = cleanFileName(`${"x".repeat(200)}.pdf`, "pdf");
    expect(long).toHaveLength(120);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(cleanFileName("   ", "docx")).toBe("fail.docx");
  });
  test("Content-Disposition: an ASCII fallback and the UTF-8 name (RFC 6266)", () => {
    expect(attachmentHeader("Juhend.pdf")).toBe(`attachment; filename="Juhend.pdf"; filename*=UTF-8''Juhend.pdf`);
    expect(attachmentHeader('Kulmud "Õpik".pdf')).toBe(`attachment; filename="Kulmud __pik_.pdf"; filename*=UTF-8''Kulmud%20%22%C3%95pik%22.pdf`);
  });
});
```

- [ ] **Step 2: Write the failing store tests.**
  - **Append to `tests/unit/r2.test.ts`.** Reuse its `CONFIG`, `KEY`, `URL_OF_KEY`, `JPEG`, `fakeFetch`, `sha256hex` and `hmac`:

```ts
describe("delete and the signed address of one object (lesson files)", () => {
  test("delete: a signed DELETE of the key; 204 and 404 are fine, 403 is an R2Error", async () => {
    const { seen, fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    await r2Store(CONFIG, fetch).delete(KEY);
    expect(seen[0].request.method).toBe("DELETE");
    expect(seen[0].request.url).toBe(URL_OF_KEY);
    expect(seen[0].request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    await r2Store(CONFIG, fakeFetch(() => new Response(null, { status: 404 })).fetch).delete(KEY);
    await expect(r2Store(CONFIG, fakeFetch(() => new Response(null, { status: 403 })).fetch).delete(KEY)).rejects.toThrow(new R2Error("delete", 403));
  });

  test("put with a disposition sends it as Content-Disposition (kept with the object; the signed GET answers with it)", async () => {
    const { seen, fetch } = fakeFetch();
    await r2Store(CONFIG, fetch).put(KEY, JPEG.buffer.slice(0) as ArrayBuffer, "application/pdf", 'attachment; filename="a.pdf"');
    expect(seen[0].request.headers.get("content-disposition")).toBe('attachment; filename="a.pdf"');
  });

  test("signedGetUrl: a presigned GET for 300 s (query signature over the host), made without any request", async () => {
    const { seen, fetch } = fakeFetch();
    const href = await r2Store(CONFIG, fetch).signedGetUrl!(KEY, { expiresSec: 300 });
    expect(seen).toHaveLength(0);
    const url = new URL(href);
    expect(`${url.origin}${url.pathname}`).toBe(URL_OF_KEY);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(presignIsValid(href, CONFIG.secretAccessKey)).toBe(true);
    expect(presignIsValid(href, "another-secret")).toBe(false);
  });
});

/** RFC 3986 encoding as SigV4 wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** An independent check of a presigned (query-signed) GET, written from the AWS SigV4 documentation, not aws4fetch. */
function presignIsValid(href: string, secret: string): boolean {
  const url = new URL(href);
  const q = url.searchParams;
  const m = /^[^/]+\/(\d{8})\/auto\/s3\/aws4_request$/.exec(q.get("X-Amz-Credential") ?? "");
  if (!m) return false;
  const canonicalQuery = [...q]
    .filter(([k]) => k !== "X-Amz-Signature")
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = ["GET", url.pathname, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", q.get("X-Amz-Date"), `${m[1]}/auto/s3/aws4_request`, sha256hex(canonicalRequest)].join("\n");
  const signingKey = ["auto", "s3", "aws4_request"].reduce((key, part) => hmac(key, part), hmac(`AWS4${secret}`, m[1]));
  return hmac(signingKey, stringToSign).toString("hex") === q.get("X-Amz-Signature");
}
```

    (If `presignIsValid` disagrees while aws4fetch is right, compare the canonical query with aws4fetch's `encodeRfc3986`; do not loosen the check.)
  - **Append to `tests/unit/media-local.test.ts`.** Use the file's own temp-folder pattern for `dir`, and add `existsSync` and `join` to its imports if missing:

```ts
  test("delete removes the file and its type; a key that is not there is fine; a key outside the folder is refused", async () => {
    const store = localStore(dir);
    await store.put("lessons/x.pdf", new Uint8Array([1, 2]).buffer, "application/pdf");
    await store.delete("lessons/x.pdf");
    expect(await store.get("lessons/x.pdf")).toBeNull();
    expect(existsSync(join(dir, "lessons", "x.pdf.type"))).toBe(false);
    await store.delete("lessons/never.pdf");
    await expect(store.delete("../escape.pdf")).rejects.toThrow();
  });
```

- [ ] **Step 3: Write the failing DB test** `tests/db/lesson-files.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonFiles, lessons } from "@/db/schema";
import { addLessonFile } from "@/server/lesson-files";
import { MAX_IMAGE_BYTES, UploadError } from "@/server/media";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

let db: Db;
let lessonId: number;
beforeEach(async () => {
  db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "V" }, summary: { et: "" }, body: { et: "" } }).returning();
  const [m] = await db.insert(courseModules).values({ courseId: c.id, position: 1, title: { et: "M" } }).returning();
  [{ id: lessonId }] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "L" } }).returning();
});

const pdf = (size = 20, name = "Juhend.pdf") => {
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return new File([bytes], name, { type: "application/pdf" });
};
const reason = (e: unknown) => (e instanceof UploadError ? e.reason : e);

test("a PDF is stored under lessons/<uuid>.pdf with its type and download name, and listed last", async () => {
  const store = fakeMediaStore();
  const first = await addLessonFile(db, store, lessonId, pdf(20, "Juhend.pdf"));
  await addLessonFile(db, store, lessonId, pdf(30, "Lisa.pdf"));
  expect(first).toEqual({ id: expect.any(Number), name: "Juhend.pdf", size: 20, contentType: "application/pdf" });
  const rows = await db.select().from(lessonFiles).orderBy(lessonFiles.position);
  expect(rows.map((r) => [r.position, r.name, r.size])).toEqual([[1, "Juhend.pdf", 20], [2, "Lisa.pdf", 30]]);
  expect(rows[0].r2Key).toMatch(/^lessons\/[0-9a-f-]{36}\.pdf$/);
  const stored = store.objects.get(rows[0].r2Key)!;
  expect([stored.contentType, stored.disposition]).toEqual(["application/pdf", `attachment; filename="Juhend.pdf"; filename*=UTF-8''Juhend.pdf`]);
});

test("refused: another type, over 4 MB, empty, bytes that are not a PDF; an unknown lesson stores nothing", async () => {
  const store = fakeMediaStore();
  expect(reason(await addLessonFile(db, store, lessonId, new File(["<html>"], "x.html", { type: "text/html" })).catch((e) => e))).toBe("type");
  expect(reason(await addLessonFile(db, store, lessonId, pdf(MAX_IMAGE_BYTES + 1)).catch((e) => e))).toBe("size");
  expect(reason(await addLessonFile(db, store, lessonId, new File([], "x.pdf", { type: "application/pdf" })).catch((e) => e))).toBe("empty");
  expect(reason(await addLessonFile(db, store, lessonId, new File(["not a pdf"], "x.pdf", { type: "application/pdf" })).catch((e) => e))).toBe("content");
  expect(await addLessonFile(db, store, 999999, pdf())).toBe("notFound");
  expect(store.objects.size).toBe(0);
  expect(await db.select().from(lessonFiles)).toHaveLength(0);
});
```

- [ ] **Step 4: Run them — expect FAIL.**

- [ ] **Step 5: Implement.**
  - **`media.ts`.** `MediaStore.put` gains the optional fourth parameter `disposition?: string` (document it: "the Content-Disposition kept with the object: a lesson file's download name"). Add:

```ts
/**
 * A store that can also remove an object and, on R2, give a short-lived signed address of one (the lesson files,
 * server/lesson-files.ts): the browser fetches the object from R2 itself, with the type and Content-Disposition it was stored
 * with. `delete` of a key that is not there is fine. The local folder has no addresses: the account API sends its bytes itself.
 */
export type FileStore = MediaStore & {
  delete(key: string): Promise<void>;
  signedGetUrl?(key: string, opts: { expiresSec: number }): Promise<string>;
};
```

  - **`r2.ts`:**
    - `R2Error.op` becomes `"put" | "get" | "delete"`.
    - `send`'s `method` accepts `"DELETE"`.
    - `r2Store` returns `FileStore`.
    - `put` adds `...(disposition ? { "content-disposition": disposition } : {})` to its headers.
    - Add:

```ts
    async delete(key) {
      const res = await send(key, { method: "DELETE" });
      discard(res);
      if (!res.ok && res.status !== 404) throw new R2Error("delete", res.status);
    },

    // A presigned GET (query signature, X-Amz-Expires): made here, no request. R2 answers it with the object's stored type and
    // Content-Disposition.
    async signedGetUrl(key, { expiresSec }) {
      if (signingKeys.size > MAX_SIGNING_KEYS) signingKeys.clear();
      const url = new URL(urlOf(key));
      url.searchParams.set("X-Amz-Expires", String(expiresSec));
      const signer = new AwsV4Signer({ method: "GET", url: url.toString(), accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", signQuery: true, cache: signingKeys });
      return (await signer.sign()).url.toString();
    },
```

  - **`media-local.ts`.** `localStore` returns `FileStore`; `put` ignores the disposition (the account API sets the header on local bytes itself). Add (import `rm` from `node:fs/promises`):

```ts
    async delete(key) {
      const path = pathOf(key);
      await rm(path, { force: true });
      await rm(`${path}.type`, { force: true });
    },
```

  - **`media-store.ts`.** `mediaStore(...)` returns `FileStore | null` (the type only).
  - **`tests/fakes.ts` `fakeMediaStore`:**
    - `FakeMedia` gains `disposition: string | null`.
    - `put(key, bytes, contentType, disposition?)` stores it (`disposition ?? null`); the initial objects get `disposition: null`.
    - Add `const deleted: string[] = [];`, return it, and add `async delete(key: string) { deleted.push(key); objects.delete(key); }`.
  - **`src/server/lesson-files.ts`:**

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { lessonFiles, lessons } from "@/db/schema";
import { storable } from "@/lib/storable";
import { hasImageSignature, MAX_IMAGE_BYTES, UploadError, type FileStore, type ImageType } from "./media";

// A lesson's files (spec 3a section 4): PDF, Word (.docx) or an image, at most 4 MB like the images (Vercel takes request bodies up
// to 4.5 MB). Kept in the image store (R2; app/.media-local under `next dev` and the e2e run) under the private prefix
// lessons/<uuid>.<ext>: /media serves img/ keys only (media.ts isMediaKey), so a file is reached only through the account API,
// which checks the student's access and the lesson order and then sends a 5-minute signed R2 address (or, locally, the bytes).

export const LESSON_FILE_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type LessonFileType = keyof typeof LESSON_FILE_TYPES;

const BY_EXTENSION: Record<string, LessonFileType> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** How long a signed file address works: the student's click follows it at once. */
export const FILE_URL_TTL_SEC = 300;
const NAME_MAX = 120;

/** The type of an uploaded file: the browser's, or the name's extension when the browser sends none. null: not one of ours. */
export function lessonFileType(file: { type: string; name: string }): LessonFileType | null {
  if (Object.hasOwn(LESSON_FILE_TYPES, file.type)) return file.type as LessonFileType;
  if (file.type && file.type !== "application/octet-stream") return null;
  return BY_EXTENSION[file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

const startsWith = (head: Uint8Array, sig: number[]) => head.length >= sig.length && sig.every((b, i) => head[i] === b);

/** Do the first bytes look like the type? PDF "%PDF-", .docx a ZIP ("PK\x03\x04"), images as media.ts checks them. */
export function hasFileSignature(type: LessonFileType, head: Uint8Array): boolean {
  if (type === "application/pdf") return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
  return hasImageSignature(type as ImageType, head);
}

/** The name the student sees: the file's own, without a folder, on one line, at most 120 characters (extension kept); "fail.<ext>" when nothing is left. */
export function cleanFileName(raw: string, ext: string): string {
  const base = raw
    .slice(Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\")) + 1)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let name = base;
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const tail = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, NAME_MAX - tail.length) + tail;
  }
  return name && storable(name) ? name : `fail.${ext}`;
}

/** Content-Disposition of a download with the file's own name: an ASCII fallback and the UTF-8 name (RFC 6266). */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export type StoredLessonFile = { id: number; name: string; size: number; contentType: LessonFileType };

/**
 * Checks one file and stores it for the lesson, last in its list. Throws UploadError ("type" | "size" | "empty" | "content") for a
 * refused file; "notFound" when there is no such lesson (nothing stored). The store keeps the type and the download's
 * Content-Disposition with the object.
 */
export async function addLessonFile(db: Db, store: FileStore, lessonId: number, file: File): Promise<StoredLessonFile | "notFound"> {
  const type = lessonFileType(file);
  if (!type) throw new UploadError("type");
  if (file.size === 0) throw new UploadError("empty");
  if (file.size > MAX_IMAGE_BYTES) throw new UploadError("size");
  const [lesson] = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) return "notFound";
  const bytes = await file.arrayBuffer();
  if (!hasFileSignature(type, new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)))) throw new UploadError("content");
  const ext = LESSON_FILE_TYPES[type];
  const name = cleanFileName(file.name, ext);
  const key = `lessons/${crypto.randomUUID()}.${ext}`;
  await store.put(key, bytes, type, attachmentHeader(name));
  const [{ last }] = await db.select({ last: sql<number | null>`max(${lessonFiles.position})` }).from(lessonFiles).where(eq(lessonFiles.lessonId, lessonId));
  const [row] = await db.insert(lessonFiles).values({ lessonId, position: (last ?? 0) + 1, name, r2Key: key, size: file.size, contentType: type }).returning();
  return { id: row.id, name: row.name, size: row.size, contentType: type };
}
```

  - **`src/app/api/admin/lesson-file/route.ts`** (the pattern of `api/admin/upload/route.ts`):

```ts
import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { addLessonFile } from "@/server/lesson-files";
import { logFailure, logNote } from "@/server/log";
import { MAX_IMAGE_BYTES, UploadError, type UploadReason } from "@/server/media";
import { mediaStore } from "@/server/media-store";

export const dynamic = "force-dynamic";
// R2 is given 10 s to answer (server/r2.ts); whatever else holds a request up ends after 30 s
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const STATUS: Record<UploadReason, number> = { type: 415, size: 413, empty: 400, content: 415 };
/** Room for the multipart boundaries and the lesson id around the file. */
const ENVELOPE = 64 * 1024;

/**
 * POST /api/admin/lesson-file — one file for a lesson (signed-in admins only; a cross-site POST is 403): multipart fields
 * `lessonId` and `file` (PDF, .docx, JPEG, PNG or WebP, at most 4 MB). 201 `{ ok: true, file }` (server/lesson-files.ts
 * StoredLessonFile); 400 missing | empty; 404 notFound; 413 size; 415 type | content; 503 storage (no store); 500 server.
 */
export const POST = withAdmin(async (request) => {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES + ENVELOPE) return json({ ok: false, error: "size" }, 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const lessonId = Number(form?.get("lessonId"));
  if (!(file instanceof File) || !Number.isInteger(lessonId) || lessonId <= 0 || lessonId > 2_147_483_647) return json({ ok: false, error: "missing" }, 400);
  try {
    const store = mediaStore();
    if (!store) {
      logNote("[admin] lesson file refused: no file store (production needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET)");
      return json({ ok: false, error: "storage" }, 503);
    }
    const saved = await addLessonFile(getDb(), store, lessonId, file);
    return saved === "notFound" ? json({ ok: false, error: "notFound" }, 404) : json({ ok: true, file: saved }, 201);
  } catch (e) {
    if (e instanceof UploadError) return json({ ok: false, error: e.reason }, STATUS[e.reason]);
    logFailure("[admin] lesson file upload failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});
```

  - **`tests/unit/admin-guards.test.ts`:** add `"app/api/admin/lesson-file/route.ts"` to both `arrayContaining` lists of route paths (the first test, and "every route under app/api/admin and app/admin is wrapped").

- [ ] **Step 6: Run** the four test files, then `npx vitest run`, `tsc` and lint. Expect PASS.

- [ ] **Step 7: Commit.**

```bash
git add app/src/server/media.ts app/src/server/r2.ts app/src/server/media-local.ts app/src/server/media-store.ts app/src/server/lesson-files.ts app/src/app/api/admin/lesson-file app/tests
git commit -m "feat(learning): private lesson files in the image store, presigned R2 GET, upload route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Admin — "Moodulid ja õppetunnid"

Spec section 4. This task adds:
- the course editor's new part, with modules for every course and lessons for e-courses;
- one lesson in the admin `Drawer` (`?oppetund=<id>`): title and short text ET/RU, "Õppetunni liik" (Video / Tekst), files, Peida/Näita and Kustuta.

The video field comes in Task 6; until then the drawer has no video section. A new lesson is a video lesson (the column default). Switching a lesson to "Tekst" deletes its Bunny videos through the obsolete-video path (`dropVideo` → `deleteBunnyVideos`), after an inline confirm when it has one.

**Files:**
- Create: `app/src/lib/row-id.ts` (the one id parser, client-safe), `app/tests/unit/row-id.test.ts`
- Create: `app/src/server/admin-lessons.ts`, `app/src/server/lesson-media.ts`, `app/src/server/actions/admin-lessons.ts`
- Create: `app/src/components/admin/LessonsEditor.tsx` (+ `LessonsEditor.module.css`), `app/src/components/admin/LessonDrawer.tsx`, `app/src/components/admin/LessonFiles.tsx`
- Create: `app/tests/e2e/targets.ts` (`smallTargets`, moved out of `admin-clients.spec.ts`)
- Modify: `app/src/app/admin/(panel)/koolitused/[id]/page.tsx` (the part below the editor, the drawer for `?oppetund=`)
- Modify: `app/src/i18n/dict/admin.ts`
  - add `lessons`;
  - remove `courseEditor.sections.modulesE`, `courseEditor.fields.modulesE` and `courseEditor.fields.modulesEHint`;
  - keep `sections.modulesC`, `fields.modulesC` and `fields.modulesCHint`, which the contact course's part uses.
- Modify: `app/tests/e2e/admin-clients.spec.ts` (imports `smallTargets` from `./targets`)
- Test: `app/tests/db/admin-lessons.test.ts`, `app/tests/unit/lesson-media.test.ts`, `app/tests/unit/admin-guards.test.ts`, `app/tests/e2e/admin-lessons.spec.ts`

**Interfaces:**
- Produces, from `src/lib/row-id.ts` (no server imports, so the pages, the routing and the admin's client code can use it too):
  - `ROW_ID_MAX = 2_147_483_647`
  - `parseRowId(raw: string): number | null` — digits only, no leading zero, 1 … 2 147 483 647; null for anything else. Every id this phase reads from text goes through it: the admin forms (`admin-lessons.ts`), `courseOf` and the `?oppetund` parse (Task 5), the account API's lesson and file ids (Task 7), the lesson route and shell (Task 9), the read-only course view (Task 10). The private `idSchema` of `admin-clients.ts` (phase 2a) may switch to it later; that is not required here.
- Produces, from `tests/e2e/targets.ts`: `smallTargets(scope: Locator): Promise<string[]>` (the controls under 44 px; used by `admin-clients.spec.ts`, `admin-lessons.spec.ts` and `account-lessons.spec.ts`).
- Consumes:
  - `courseModules`, `lessons`, `lessonFiles`, `lessonProgress`, `type VideoStatus`, `type LessonKind` (Task 1);
  - `moveLesson`, `type ModuleLayout`, `dropVideo`, `formatDuration` (Task 2);
  - `bunnyConfig`, `bunnyApi`, `type BunnyApi` (Task 3);
  - `type FileStore`, `mediaStore()`, `POST /api/admin/lesson-file` (Task 4);
  - `Check`, `field`, `invalid`, `type EditResult` (`edit-check.ts`); `adminAction`; `revalidatePublic({ kind: "courses" })`; `refresh` (`next/cache`); `redirect`.
- Produces, from `src/server/admin-lessons.ts`:
  - `LESSON_LIMITS = { title: 120, body: 5000 }`
  - types `AdminLessonFile = { id: number; name: string; size: number; contentType: string }`; `AdminLesson = { id: number; moduleId: number; title: I18n; body: I18n | null; kind: LessonKind; hidden: boolean; videoStatus: VideoStatus; durationSec: number | null; replacing: boolean; inUse: boolean; files: AdminLessonFile[] }`; `AdminModule = { id: number; title: I18n; lessons: AdminLesson[] }`
  - `listCourseLessons(db: Db, courseId: number): Promise<AdminModule[]>`
  - form handlers that each take `(db: Db, fd: FormData)` and return `Promise<EditResult>`: `addModuleForm`, `renameModuleForm`, `moveModuleForm`, `deleteModuleForm`, `addLessonForm`, `saveLessonForm`, `moveLessonForm`, `setLessonHiddenForm`
  - `setLessonKindForm(db, fd): Promise<{ result: EditResult; obsolete: string[] }>` (fields `id`, `kind`; `obsolete`: the Bunny videos a switch to "Tekst" leaves behind)
  - `type LessonCleanup = { videoIds: string[]; fileKeys: string[] }`
  - `deleteLessonForm(db, fd): Promise<{ result: EditResult; cleanup: LessonCleanup }>`
  - `deleteLessonFileForm(db, fd): Promise<{ result: EditResult; key: string | null }>`
- Produces, from `src/server/lesson-media.ts`:
  - `deleteBunnyVideos(api: BunnyApi, ids: string[]): Promise<void>`, which never throws;
  - `removeLessonMedia(cleanup: LessonCleanup, deps: { bunny: BunnyApi | null; files: FileStore | null }): Promise<void>`, which never throws.
- Produces, from `src/server/actions/admin-lessons.ts` (all `adminAction`; each takes `(prev: EditResult | null, formData: FormData)` and returns `Promise<EditResult>`):
  - `addModule`, `renameModule`, `moveModuleInList`, `deleteModule`;
  - `addLesson` (redirects to `?oppetund=<new id>`), `saveLesson`, `moveLessonInList`, `setLessonHidden`, `setLessonKind` (deletes the obsolete Bunny videos);
  - `deleteLesson` (redirects back to the course), `deleteLessonFile`.
- Form fields: `courseId`, `moduleId`, `id`, `dir` (`up` | `down`), `titleEt`, `titleRu`, `bodyEt`, `bodyRu`, `hidden` (`"1"` | `"0"`), `kind` (`"video"` | `"text"`).

- [ ] **Step 0a: Write the failing test for the id parser** `tests/unit/row-id.test.ts`:

```ts
import { expect, test } from "vitest";
import { parseRowId, ROW_ID_MAX } from "@/lib/row-id";

test("a row id: digits only, no leading zero, 1 … 2147483647", () => {
  expect(ROW_ID_MAX).toBe(2_147_483_647);
  expect(parseRowId("1")).toBe(1);
  expect(parseRowId("2147483647")).toBe(2147483647);
  for (const bad of ["0", "01", "2147483648", "1a", "", "-1", "1.5", " 1", "1 ", "99999999999"]) expect(parseRowId(bad), JSON.stringify(bad)).toBeNull();
});
```

- [ ] **Step 0b: Implement** `src/lib/row-id.ts`, then run the test (expect PASS):

```ts
// One parser for the ids this app reads from text: a form field, an address segment, a query value. Client-safe (no server
// imports), so the admin forms, the account API, the routing and the pages all read an id the same way.

/** The largest id the database's integer columns (serial) hold. */
export const ROW_ID_MAX = 2_147_483_647;

/** A row id written as digits, without a leading zero, from 1 to ROW_ID_MAX; null for anything else (a sign, a space, a fraction, letters). */
export function parseRowId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= ROW_ID_MAX ? n : null;
}
```

- [ ] **Step 0c: Share the touch-target helper.** Move `smallTargets` out of `tests/e2e/admin-clients.spec.ts` (module-private today) into `tests/e2e/targets.ts`, unchanged in behaviour:

```ts
import type { Locator } from "@playwright/test";

/** The controls in `scope` less than 44 px tall (the touch target rule): the start of each one's HTML, for the failure message. */
export const smallTargets = (scope: Locator): Promise<string[]> =>
  scope
    .locator("a:visible, button:visible, input:visible, select:visible")
    .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 120)));
```

  In `admin-clients.spec.ts`, delete the local `smallTargets` and add `import { smallTargets } from "./targets";`. Run `npx playwright test admin-clients` once: unchanged results.

- [ ] **Step 1: Write the failing DB tests** `tests/db/admin-lessons.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { clients, courses, lessonFiles, lessonProgress, lessons } from "@/db/schema";
import {
  addLessonForm, addModuleForm, deleteLessonFileForm, deleteLessonForm, deleteModuleForm, listCourseLessons, moveLessonForm, moveModuleForm, renameModuleForm,
  saveLessonForm, setLessonHiddenForm, setLessonKindForm,
} from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { makeTestDb } from "./helpers";

const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const idOf = (r: EditResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.id;
};

let db: Db;
let courseId: number;
beforeEach(async () => {
  db = await makeTestDb();
  [{ id: courseId }] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "Veeb" }, summary: { et: "" }, body: { et: "" } }).returning();
});
const titles = async () => (await listCourseLessons(db, courseId)).map((m) => [m.title.et, m.lessons.map((l) => l.title.et)]);

describe("modules", () => {
  test("add (last), rename ET/RU, ↑ ↓, delete only when it has no lessons", async () => {
    const a = idOf(await addModuleForm(db, form({ courseId, titleEt: " Sissejuhatus ", titleRu: "" })));
    const b = idOf(await addModuleForm(db, form({ courseId, titleEt: "Praktika", titleRu: "Практика" })));
    expect(await titles()).toEqual([["Sissejuhatus", []], ["Praktika", []]]);
    expect(await renameModuleForm(db, form({ id: a, titleEt: "Algus", titleRu: "Начало" }))).toEqual({ ok: true, id: a });
    expect(await moveModuleForm(db, form({ id: b, dir: "up" }))).toEqual({ ok: true, id: b });
    expect(await titles()).toEqual([["Praktika", []], ["Algus", []]]);
    expect((await listCourseLessons(db, courseId))[1].title).toEqual({ et: "Algus", ru: "Начало" });
    expect(await moveModuleForm(db, form({ id: b, dir: "up" }))).toEqual({ ok: true, id: b }); // already first: nothing moves
    idOf(await addLessonForm(db, form({ moduleId: b, titleEt: "Esimene" })));
    expect(await deleteModuleForm(db, form({ id: b }))).toEqual({ ok: false, error: "inUse" });
    expect(await deleteModuleForm(db, form({ id: a }))).toEqual({ ok: true, id: a, deleted: true });
    expect(await titles()).toEqual([["Praktika", ["Esimene"]]]);
  });

  test("a title is needed, at most 120 characters; an unknown course is notFound; a bad id is invalid", async () => {
    expect(await addModuleForm(db, form({ courseId, titleEt: "  " }))).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await addModuleForm(db, form({ courseId, titleEt: "x".repeat(121) }))).toEqual({ ok: false, error: "invalid", fields: { title: "tooLong" } });
    expect(await addModuleForm(db, form({ courseId: 999999, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
    expect(await addModuleForm(db, form({ courseId: "x", titleEt: "X" }))).toEqual({ ok: false, error: "invalid" });
    expect(await renameModuleForm(db, form({ id: 999999, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
  });
});

describe("lessons", () => {
  async function twoModules() {
    const a = idOf(await addModuleForm(db, form({ courseId, titleEt: "A" })));
    const b = idOf(await addModuleForm(db, form({ courseId, titleEt: "B" })));
    const add = async (moduleId: number, titleEt: string) => idOf(await addLessonForm(db, form({ moduleId, titleEt })));
    return { a, b, l1: await add(a, "Üks"), l2: await add(a, "Kaks"), l3: await add(b, "Kolm") };
  }

  test("added last in its module; the title and the short text are saved (a blank text is none)", async () => {
    const w = await twoModules();
    expect(await titles()).toEqual([["A", ["Üks", "Kaks"]], ["B", ["Kolm"]]]);
    expect(await saveLessonForm(db, form({ id: w.l1, titleEt: "Esimene", titleRu: "Первый", bodyEt: "Loe.\n\nVaata.", bodyRu: "" }))).toEqual({ ok: true, id: w.l1 });
    const [l] = await db.select().from(lessons).where(eq(lessons.id, w.l1));
    expect([l.title, l.body]).toEqual([{ et: "Esimene", ru: "Первый" }, { et: "Loe.\n\nVaata." }]);
    await saveLessonForm(db, form({ id: w.l1, titleEt: "Esimene", bodyEt: "  " }));
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0].body).toBeNull();
    expect(await saveLessonForm(db, form({ id: w.l1, titleEt: "", bodyEt: "x".repeat(5001) }))).toEqual({ ok: false, error: "invalid", fields: { title: "required", body: "tooLong" } });
    expect(await addLessonForm(db, form({ moduleId: 999999, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
  });

  test("↑ ↓ within a module and across modules; the very first stays", async () => {
    const w = await twoModules();
    await moveLessonForm(db, form({ id: w.l2, dir: "down" }));
    expect(await titles()).toEqual([["A", ["Üks"]], ["B", ["Kaks", "Kolm"]]]);
    await moveLessonForm(db, form({ id: w.l3, dir: "up" }));
    expect(await titles()).toEqual([["A", ["Üks"]], ["B", ["Kolm", "Kaks"]]]);
    await moveLessonForm(db, form({ id: w.l3, dir: "up" }));
    expect(await titles()).toEqual([["A", ["Üks", "Kolm"]], ["B", ["Kaks"]]]);
    expect(await moveLessonForm(db, form({ id: w.l1, dir: "up" }))).toEqual({ ok: true, id: w.l1 });
    expect(await titles()).toEqual([["A", ["Üks", "Kolm"]], ["B", ["Kaks"]]]);
  });

  test("hide and show; delete only without progress, and the cleanup names its videos and files", async () => {
    const w = await twoModules();
    expect(await setLessonHiddenForm(db, form({ id: w.l1, hidden: "1" }))).toEqual({ ok: true, id: w.l1 });
    expect((await listCourseLessons(db, courseId))[0].lessons[0]).toMatchObject({ kind: "video", hidden: true, inUse: false, videoStatus: "none", replacing: false, files: [] });
    await setLessonHiddenForm(db, form({ id: w.l1, hidden: "0" }));
    expect((await listCourseLessons(db, courseId))[0].lessons[0].hidden).toBe(false);

    await db.update(lessons).set({ videoId: "new", videoStatus: "uploading", replacedVideoId: "old" }).where(eq(lessons.id, w.l2));
    await db.insert(lessonFiles).values({ lessonId: w.l2, position: 1, name: "a.pdf", r2Key: "lessons/a.pdf", size: 1, contentType: "application/pdf" });
    expect((await listCourseLessons(db, courseId))[0].lessons[1]).toMatchObject({ replacing: true, files: [{ name: "a.pdf", size: 1, contentType: "application/pdf" }] });
    expect(await deleteLessonForm(db, form({ id: w.l2 }))).toEqual({ result: { ok: true, id: w.l2, deleted: true }, cleanup: { videoIds: ["new", "old"], fileKeys: ["lessons/a.pdf"] } });
    expect(await db.select().from(lessonFiles)).toHaveLength(0);

    const [c] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
    await db.insert(lessonProgress).values({ clientId: c.id, lessonId: w.l3, watchedSec: 5 });
    expect((await listCourseLessons(db, courseId))[1].lessons[0].inUse).toBe(true);
    expect(await deleteLessonForm(db, form({ id: w.l3 }))).toEqual({ result: { ok: false, error: "inUse" }, cleanup: { videoIds: [], fileKeys: [] } });
    expect((await deleteLessonForm(db, form({ id: 999999 }))).result).toEqual({ ok: false, error: "notFound" });
  });

  test("a file row is removed and its key comes back for the store", async () => {
    const w = await twoModules();
    const [f] = await db.insert(lessonFiles).values({ lessonId: w.l1, position: 1, name: "a.pdf", r2Key: "lessons/a.pdf", size: 1, contentType: "application/pdf" }).returning();
    expect(await deleteLessonFileForm(db, form({ id: f.id }))).toEqual({ result: { ok: true, id: f.id, deleted: true }, key: "lessons/a.pdf" });
    expect(await deleteLessonFileForm(db, form({ id: f.id }))).toEqual({ result: { ok: false, error: "notFound" }, key: null });
  });

  test("“Õppetunni liik”: a new lesson is a video lesson; to Tekst drops its videos (obsolete for Bunny); back to Video has none", async () => {
    const w = await twoModules();
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0].kind).toBe("video");
    await db.update(lessons).set({ videoId: "new", videoStatus: "processing", replacedVideoId: "old", durationSec: 300, videoStartedAt: new Date() }).where(eq(lessons.id, w.l1));
    expect(await setLessonKindForm(db, form({ id: w.l1, kind: "text" }))).toEqual({ result: { ok: true, id: w.l1 }, obsolete: ["new", "old"] });
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0]).toMatchObject({ kind: "text", videoId: null, videoStatus: "none", replacedVideoId: null, durationSec: null, videoStartedAt: null });
    expect((await listCourseLessons(db, courseId))[0].lessons[0].kind).toBe("text");
    expect(await setLessonKindForm(db, form({ id: w.l1, kind: "video" }))).toEqual({ result: { ok: true, id: w.l1 }, obsolete: [] });
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0]).toMatchObject({ kind: "video", videoStatus: "none" });
    expect(await setLessonKindForm(db, form({ id: w.l1, kind: "audio" }))).toEqual({ result: { ok: false, error: "invalid" }, obsolete: [] });
    expect(await setLessonKindForm(db, form({ id: 999999, kind: "text" }))).toEqual({ result: { ok: false, error: "notFound" }, obsolete: [] });
  });
});
```

  And `tests/unit/lesson-media.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { BunnyError, type BunnyApi } from "@/server/bunny";
import { removeLessonMedia } from "@/server/lesson-media";
import { fakeMediaStore } from "../fakes";

test("a deleted lesson's videos leave Bunny and its files the store; a failure is logged without ids and the rest goes on", async () => {
  const gone: string[] = [];
  const bunny: BunnyApi = {
    createVideo: vi.fn(),
    getVideo: vi.fn(),
    deleteVideo: vi.fn(async (id: string) => {
      if (id === "bad-video") throw new BunnyError("delete", 500);
      gone.push(id);
    }),
  };
  const files = fakeMediaStore({ "lessons/a.pdf": { bytes: [1] } });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await removeLessonMedia({ videoIds: ["bad-video", "v2"], fileKeys: ["lessons/a.pdf"] }, { bunny, files });
  expect(gone).toEqual(["v2"]);
  expect(files.deleted).toEqual(["lessons/a.pdf"]);
  expect(error).toHaveBeenCalledWith("[lesson] video not deleted: BunnyError (status 500)");
  expect(JSON.stringify(error.mock.calls)).not.toContain("bad-video");
  error.mockRestore();
});

test("without Bunny or a store nothing is tried, and nothing throws", async () => {
  await expect(removeLessonMedia({ videoIds: ["v"], fileKeys: ["k"] }, { bunny: null, files: null })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run them — expect FAIL.**

- [ ] **Step 3: Implement `src/server/admin-lessons.ts`:**

```ts
import { asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonFiles, lessonProgress, lessons, type LessonKind, type VideoStatus } from "@/db/schema";
import { dropVideo, moveLesson, type ModuleLayout } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";
import { parseRowId } from "@/lib/row-id";
import { Check, field, invalid, type EditResult } from "./edit-check";

// "Moodulid ja õppetunnid" (spec 3a section 4): a course's modules (a contact course's programme too) and an e-course's lessons
// and lesson files, for the admin, without Next.js (tests/db/admin-lessons.test.ts). Callers have checked the admin session
// (server/actions/admin-lessons.ts wraps each in adminAction). Nothing the browser sends is trusted. Positions are 1…n within their
// list (modules per course, lessons per module), and every list is read by position, then id.

export const LESSON_LIMITS = { title: 120, body: 5000 } as const;

/** A form field's row id (lib/row-id.ts parseRowId), or null when it is missing or not one. */
const idOf = (value: string | null): number | null => (value === null ? null : parseRowId(value));
const i18nOf = (fd: FormData, prefix: string): I18n => ({ et: field(fd, `${prefix}Et`) ?? "", ru: field(fd, `${prefix}Ru`) ?? "" });

export type AdminLessonFile = { id: number; name: string; size: number; contentType: string };
export type AdminLesson = {
  id: number;
  moduleId: number;
  title: I18n;
  body: I18n | null;
  /** "Õppetunni liik": a video lesson (the default) or a text lesson (no video field). */
  kind: LessonKind;
  hidden: boolean;
  videoStatus: VideoStatus;
  durationSec: number | null;
  /** A new video is on its way while the old one still plays. */
  replacing: boolean;
  /** A student has progress on it (watched, done, or opened by an admin): it can be hidden, not deleted. */
  inUse: boolean;
  files: AdminLessonFile[];
};
export type AdminModule = { id: number; title: I18n; lessons: AdminLesson[] };

/** The course's modules, each with its lessons (hidden ones too) and their files, in order: three small queries. */
export async function listCourseLessons(db: Db, courseId: number): Promise<AdminModule[]> {
  const [mods, rows, files] = await Promise.all([
    db.select({ id: courseModules.id, title: courseModules.title }).from(courseModules).where(eq(courseModules.courseId, courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)),
    db
      .select({
        id: lessons.id,
        moduleId: lessons.moduleId,
        title: lessons.title,
        body: lessons.body,
        kind: lessons.kind,
        hidden: lessons.hidden,
        videoStatus: lessons.videoStatus,
        durationSec: lessons.durationSec,
        replacedVideoId: lessons.replacedVideoId,
        inUse: sql<boolean>`exists (select 1 from lesson_progress p where p.lesson_id = ${lessons.id})`,
      })
      .from(lessons)
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .where(eq(courseModules.courseId, courseId))
      .orderBy(asc(lessons.position), asc(lessons.id)),
    db
      .select({ id: lessonFiles.id, lessonId: lessonFiles.lessonId, name: lessonFiles.name, size: lessonFiles.size, contentType: lessonFiles.contentType })
      .from(lessonFiles)
      .innerJoin(lessons, eq(lessonFiles.lessonId, lessons.id))
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .where(eq(courseModules.courseId, courseId))
      .orderBy(asc(lessonFiles.position), asc(lessonFiles.id)),
  ]);
  return mods.map((m) => ({
    id: m.id,
    title: m.title,
    lessons: rows
      .filter((r) => r.moduleId === m.id)
      .map(({ replacedVideoId, ...r }) => ({
        ...r,
        inUse: Boolean(r.inUse),
        replacing: replacedVideoId !== null,
        files: files.filter((f) => f.lessonId === r.id).map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })),
      })),
  }));
}

/** "Lisa moodul" / "Lisa punkt": fields courseId, titleEt, titleRu. The new module goes last. */
export async function addModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const courseId = idOf(field(fd, "courseId"));
  if (courseId === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return db.transaction(async (tx): Promise<EditResult> => {
    const [course] = await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).for("update");
    if (!course) return { ok: false, error: "notFound" };
    const [{ last }] = await tx.select({ last: sql<number | null>`max(${courseModules.position})` }).from(courseModules).where(eq(courseModules.courseId, courseId));
    const [row] = await tx.insert(courseModules).values({ courseId, position: (last ?? 0) + 1, title }).returning();
    return { ok: true, id: row.id, created: true };
  });
}

/** A module's "Salvesta": fields id, titleEt, titleRu. */
export async function renameModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  const rows = await db.update(courseModules).set({ title }).where(eq(courseModules.id, id)).returning({ id: courseModules.id });
  return rows.length ? { ok: true, id } : { ok: false, error: "notFound" };
}

/** A module's ↑ / ↓: fields id, dir. The course's modules are numbered 1…n again. One that cannot move stays (ok). */
export async function moveModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const dir = field(fd, "dir");
  if (id === null || (dir !== "up" && dir !== "down")) return { ok: false, error: "invalid" };
  return db.transaction(async (tx): Promise<EditResult> => {
    const [own] = await tx.select({ courseId: courseModules.courseId }).from(courseModules).where(eq(courseModules.id, id));
    if (!own) return { ok: false, error: "notFound" };
    const list = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.courseId, own.courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)).for("update");
    const i = list.findIndex((m) => m.id === id);
    const j = i + (dir === "up" ? -1 : 1);
    if (j < 0 || j >= list.length) return { ok: true, id };
    [list[i], list[j]] = [list[j], list[i]];
    for (const [n, m] of list.entries()) await tx.update(courseModules).set({ position: n + 1 }).where(eq(courseModules.id, m.id));
    return { ok: true, id };
  });
}

/** "Kustuta moodul": field id. Refused (inUse) while it has lessons. */
export async function deleteModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  return db.transaction(async (tx): Promise<EditResult> => {
    const [mod] = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.id, id)).for("update");
    if (!mod) return { ok: false, error: "notFound" };
    const [{ n }] = await tx.select({ n: count() }).from(lessons).where(eq(lessons.moduleId, id));
    if (Number(n) > 0) return { ok: false, error: "inUse" };
    await tx.delete(courseModules).where(eq(courseModules.id, id));
    return { ok: true, id, deleted: true };
  });
}

/** "Lisa õppetund": fields moduleId, titleEt, titleRu. Last in its module; no video, no text, visible. */
export async function addLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const moduleId = idOf(field(fd, "moduleId"));
  if (moduleId === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return db.transaction(async (tx): Promise<EditResult> => {
    const [mod] = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.id, moduleId)).for("update");
    if (!mod) return { ok: false, error: "notFound" };
    const [{ last }] = await tx.select({ last: sql<number | null>`max(${lessons.position})` }).from(lessons).where(eq(lessons.moduleId, moduleId));
    const [row] = await tx.insert(lessons).values({ moduleId, position: (last ?? 0) + 1, title }).returning();
    return { ok: true, id: row.id, created: true };
  });
}

/** The lesson drawer's "Salvesta": fields id, titleEt, titleRu, bodyEt, bodyRu (the short text; blank is none). */
export async function saveLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  const body = c.text("body", i18nOf(fd, "body"), LESSON_LIMITS.body);
  if (!c.ok || !title) return invalid(c.errors);
  const rows = await db.update(lessons).set({ title, body }).where(eq(lessons.id, id)).returning({ id: lessons.id });
  return rows.length ? { ok: true, id } : { ok: false, error: "notFound" };
}

/** A lesson's ↑ / ↓ (domain/lessons.ts moveLesson: across modules at a module's edge): fields id, dir. Only moved rows are written. */
export async function moveLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const dir = field(fd, "dir");
  if (id === null || (dir !== "up" && dir !== "down")) return { ok: false, error: "invalid" };
  return db.transaction(async (tx): Promise<EditResult> => {
    const [own] = await tx.select({ courseId: courseModules.courseId }).from(lessons).innerJoin(courseModules, eq(lessons.moduleId, courseModules.id)).where(eq(lessons.id, id));
    if (!own) return { ok: false, error: "notFound" };
    const mods = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.courseId, own.courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)).for("update");
    const rows = await tx
      .select({ id: lessons.id, moduleId: lessons.moduleId, position: lessons.position })
      .from(lessons)
      .where(inArray(lessons.moduleId, mods.map((m) => m.id)))
      .orderBy(asc(lessons.position), asc(lessons.id));
    const layout: ModuleLayout[] = mods.map((m) => ({ moduleId: m.id, lessonIds: rows.filter((r) => r.moduleId === m.id).map((r) => r.id) }));
    const moved = moveLesson(layout, id, dir === "up" ? -1 : 1);
    if (!moved) return { ok: true, id };
    const before = new Map(rows.map((r) => [r.id, r]));
    for (const m of moved)
      for (const [i, lessonId] of m.lessonIds.entries()) {
        const was = before.get(lessonId)!;
        if (was.moduleId !== m.moduleId || was.position !== i + 1) await tx.update(lessons).set({ moduleId: m.moduleId, position: i + 1 }).where(eq(lessons.id, lessonId));
      }
    return { ok: true, id };
  });
}

/** "Peida" / "Näita õpilastele": fields id, hidden ("1" | "0"). A hidden lesson is not shown, counted or in the order (spec 3). */
export async function setLessonHiddenForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const hidden = field(fd, "hidden");
  if (id === null || (hidden !== "1" && hidden !== "0")) return { ok: false, error: "invalid" };
  const rows = await db.update(lessons).set({ hidden: hidden === "1" }).where(eq(lessons.id, id)).returning({ id: lessons.id });
  return rows.length ? { ok: true, id } : { ok: false, error: "notFound" };
}

/**
 * "Õppetunni liik": fields id, kind ("video" | "text"). To "text": the lesson's videos are dropped (domain/lessons.ts dropVideo) and
 * come back as `obsolete`, for the action to delete from Bunny (the drawer asked "Video kustutatakse. Jätkan?" first). To "video":
 * nothing else changes (a text lesson has no video). Progress rows stay as they are.
 */
export async function setLessonKindForm(db: Db, fd: FormData): Promise<{ result: EditResult; obsolete: string[] }> {
  const id = idOf(field(fd, "id"));
  const kind = field(fd, "kind");
  if (id === null || (kind !== "video" && kind !== "text")) return { result: { ok: false, error: "invalid" }, obsolete: [] };
  return db.transaction(async (tx): Promise<{ result: EditResult; obsolete: string[] }> => {
    const [row] = await tx
      .select({ videoId: lessons.videoId, videoStatus: lessons.videoStatus, replacedVideoId: lessons.replacedVideoId, durationSec: lessons.durationSec })
      .from(lessons)
      .where(eq(lessons.id, id))
      .for("update");
    if (!row) return { result: { ok: false, error: "notFound" }, obsolete: [] };
    if (kind === "video") {
      await tx.update(lessons).set({ kind }).where(eq(lessons.id, id));
      return { result: { ok: true, id }, obsolete: [] };
    }
    const { next, obsolete } = dropVideo(row);
    await tx.update(lessons).set({ kind, ...next, videoStartedAt: null }).where(eq(lessons.id, id));
    return { result: { ok: true, id }, obsolete };
  });
}

/** What a deleted lesson leaves outside the database: its Bunny videos and its files' store keys (lesson-media.ts removes them). */
export type LessonCleanup = { videoIds: string[]; fileKeys: string[] };
const NOTHING: LessonCleanup = { videoIds: [], fileKeys: [] };

/**
 * "Kustuta õppetund": field id. Refused (inUse) once any student has a progress row for it — then it can only be hidden, so the counts
 * stay honest (spec 7). The lesson and its file rows go (cascade); `cleanup` names its videos and files for removeLessonMedia.
 */
export async function deleteLessonForm(db: Db, fd: FormData): Promise<{ result: EditResult; cleanup: LessonCleanup }> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { result: { ok: false, error: "invalid" }, cleanup: NOTHING };
  return db.transaction(async (tx): Promise<{ result: EditResult; cleanup: LessonCleanup }> => {
    const [row] = await tx.select({ videoId: lessons.videoId, replacedVideoId: lessons.replacedVideoId }).from(lessons).where(eq(lessons.id, id)).for("update");
    if (!row) return { result: { ok: false, error: "notFound" }, cleanup: NOTHING };
    const [{ n }] = await tx.select({ n: count() }).from(lessonProgress).where(eq(lessonProgress.lessonId, id));
    if (Number(n) > 0) return { result: { ok: false, error: "inUse" }, cleanup: NOTHING };
    const files = await tx.select({ key: lessonFiles.r2Key }).from(lessonFiles).where(eq(lessonFiles.lessonId, id)).orderBy(asc(lessonFiles.position), asc(lessonFiles.id));
    await tx.delete(lessons).where(eq(lessons.id, id));
    const videoIds = [row.videoId, row.replacedVideoId].filter((v): v is string => v !== null);
    return { result: { ok: true, id, deleted: true }, cleanup: { videoIds, fileKeys: files.map((f) => f.key) } };
  });
}

/** A file's "Eemalda": field id. The row goes; `key` is the store key to delete (null when there was no such file). */
export async function deleteLessonFileForm(db: Db, fd: FormData): Promise<{ result: EditResult; key: string | null }> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { result: { ok: false, error: "invalid" }, key: null };
  const [row] = await db.delete(lessonFiles).where(eq(lessonFiles.id, id)).returning({ key: lessonFiles.r2Key });
  return row ? { result: { ok: true, id, deleted: true }, key: row.key } : { result: { ok: false, error: "notFound" }, key: null };
}
```

- [ ] **Step 4: Implement `src/server/lesson-media.ts`:**

```ts
import type { LessonCleanup } from "./admin-lessons";
import type { BunnyApi } from "./bunny";
import { logFailure } from "./log";
import type { FileStore } from "./media";

// What a deleted lesson leaves outside the database: its Bunny videos (the current one and a replaced one) and its files in the
// store. Removed after the database row is gone; a failure is logged (no ids, no keys) and the rest goes on — an orphan only
// costs storage.

/** Deletes these Bunny videos one by one; never throws. */
export async function deleteBunnyVideos(api: BunnyApi, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await api.deleteVideo(id);
    } catch (e) {
      logFailure("[lesson] video not deleted", e);
    }
  }
}

/** Removes a deleted lesson's videos and files. Without Bunny or a store that part is skipped. Never throws. */
export async function removeLessonMedia(cleanup: LessonCleanup, deps: { bunny: BunnyApi | null; files: FileStore | null }): Promise<void> {
  if (deps.bunny) await deleteBunnyVideos(deps.bunny, cleanup.videoIds);
  if (!deps.files) return;
  for (const key of cleanup.fileKeys) {
    try {
      await deps.files.delete(key);
    } catch (e) {
      logFailure("[lesson] file not deleted", e);
    }
  }
}
```

- [ ] **Step 5: Implement the actions** `src/server/actions/admin-lessons.ts`:

```ts
"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import {
  addLessonForm, addModuleForm, deleteLessonFileForm, deleteLessonForm, deleteModuleForm, moveLessonForm, moveModuleForm, renameModuleForm, saveLessonForm,
  setLessonHiddenForm, setLessonKindForm, type LessonCleanup,
} from "../admin-lessons";
import { adminAction } from "../auth";
import { bunnyApi, bunnyConfig } from "../bunny";
import type { EditResult } from "../edit-check";
import { deleteBunnyVideos, removeLessonMedia } from "../lesson-media";
import { logFailure } from "../log";
import { mediaStore } from "../media-store";
import { revalidatePublic } from "../public-cache";

// "Moodulid ja õppetunnid" server actions: every export is wrapped in adminAction (tests/unit/admin-guards.test.ts). The work is in
// ../admin-lessons.ts. Module titles show on the public course page, so their changes revalidate the course pages; lessons are
// only in the account (its JSON is never cached), so they refresh the open admin page only.

async function run(what: string, publicChange: boolean, work: (db: Db) => Promise<EditResult>): Promise<EditResult> {
  try {
    const result = await work(getDb());
    if (result.ok) {
      if (publicChange) revalidatePublic({ kind: "courses" });
      refresh();
    }
    return result;
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/** The course id a form names (the address to go back to; lib/row-id.ts parseRowId); null when it is not one. */
const courseOf = (fd: FormData): number | null => parseRowId(String(fd.get("courseId") ?? ""));

const media = () => {
  const config = bunnyConfig();
  return { bunny: config ? bunnyApi(config) : null, files: mediaStore() };
};

export const addModule = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("module add", true, (db) => addModuleForm(db, formData)));
export const renameModule = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("module rename", true, (db) => renameModuleForm(db, formData)));
export const moveModuleInList = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("module move", true, (db) => moveModuleForm(db, formData)));
export const deleteModule = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("module delete", true, (db) => deleteModuleForm(db, formData)));

/** "Lisa õppetund": the new lesson opens in the drawer (fields moduleId, courseId, titleEt). */
export const addLesson = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("lesson add", false, (db) => addLessonForm(db, formData));
  const course = courseOf(formData);
  if (result.ok && result.created && course) redirect(`/admin/koolitused/${course}?oppetund=${result.id}`);
  return result;
});

export const saveLesson = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("lesson save", false, (db) => saveLessonForm(db, formData)));
export const moveLessonInList = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("lesson move", false, (db) => moveLessonForm(db, formData)));
export const setLessonHidden = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("lesson visibility", false, (db) => setLessonHiddenForm(db, formData)));

/** "Õppetunni liik" (to Tekst after "Video kustutatakse. Jätkan?"): fields id, kind. The videos it drops are deleted from Bunny. */
export const setLessonKind = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  let obsolete: string[] = [];
  const result = await run("lesson kind", false, async (db) => {
    const done = await setLessonKindForm(db, formData);
    obsolete = done.obsolete;
    return done.result;
  });
  const config = bunnyConfig();
  if (result.ok && obsolete.length && config) await deleteBunnyVideos(bunnyApi(config), obsolete);
  return result;
});

/** "Kustuta õppetund" (after its confirmation): the row, then its videos and files; back to the course with the drawer closed. */
export const deleteLesson = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  let cleanup: LessonCleanup = { videoIds: [], fileKeys: [] };
  const result = await run("lesson delete", false, async (db) => {
    const done = await deleteLessonForm(db, formData);
    cleanup = done.cleanup;
    return done.result;
  });
  if (result.ok) await removeLessonMedia(cleanup, media());
  const course = courseOf(formData);
  if (result.ok && course) redirect(`/admin/koolitused/${course}`);
  return result;
});

/** A file's "Eemalda": the row, then the stored object. */
export const deleteLessonFile = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  let key: string | null = null;
  const result = await run("lesson file delete", false, async (db) => {
    const done = await deleteLessonFileForm(db, formData);
    key = done.key;
    return done.result;
  });
  if (result.ok && key) await removeLessonMedia({ videoIds: [], fileKeys: [key] }, { bunny: null, files: mediaStore() });
  return result;
});
```

- [ ] **Step 6: Extend the guard test** (`tests/unit/admin-guards.test.ts`). Add `"server/actions/admin-lessons.ts"` to the `arrayContaining` list of the first test. In "every admin page calls requireAdmin() itself and every admin action is wrapped", add:

```ts
    const lessonActions = files().find((f) => f.path === "server/actions/admin-lessons.ts")!;
    const lessonExports = [...strip(lessonActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(lessonExports).toEqual(["addModule", "renameModule", "moveModuleInList", "deleteModule", "addLesson", "saveLesson", "moveLessonInList", "setLessonHidden", "setLessonKind", "deleteLesson", "deleteLessonFile"]);
    expect(violations(lessonActions.path, lessonActions.source)).toEqual([]);
```

- [ ] **Step 7: Run** the DB, unit and guard tests — expect PASS. Then run `tsc`.

- [ ] **Step 8: Add the admin texts** to `src/i18n/dict/admin.ts`, after `courseEditor`:

```ts
  // Koolitused → one course: "Moodulid ja õppetunnid" (an e-course) or "Programm" (a contact course: module titles only), in
  // components/admin/LessonsEditor.tsx; one lesson in the drawer (LessonDrawer.tsx) with its files (LessonFiles.tsx) and video
  // (LessonVideoField.tsx: `video`, added in Task 6).
  lessons: {
    title: "Moodulid ja õppetunnid",
    hint: "Õpilane avab õppetunnid järjekorras: järgmine avaneb, kui eelmine on tehtud.",
    saveFirst: "Salvesta koolitus, et lisada mooduleid.",
    empty: "Mooduleid veel pole.",
    moduleName: "Mooduli nimi",
    newModule: "Uue mooduli nimi",
    newItem: "Uus programmi punkt",
    addModule: "Lisa moodul",
    addItem: "Lisa punkt",
    save: "Salvesta",
    moveUp: "Liiguta üles: {title}",
    moveDown: "Liiguta alla: {title}",
    deleteModule: "Kustuta moodul",
    deleteModuleConfirm: "Kas kustutan mooduli „{title}“?",
    deleteYes: "Jah, kustuta",
    deleteNo: "Ei",
    noLessons: "Selles moodulis pole veel õppetunde.",
    newLesson: "Uue õppetunni nimi",
    addLesson: "Lisa õppetund",
    edit: "Muuda",
    editLabel: "Muuda õppetundi: {title}",
    hiddenTag: "Peidetud",
    textTag: "Tekst",
    videoTag: { none: "Video puudub", uploading: "Video üleslaadimisel", processing: "Video töötlemisel", ready: "Video {duration}", failed: "Video viga" },
    errors: {
      required: "Kirjuta nimi.",
      tooLong: "Liiga pikk.",
      inUse: "Moodulis on õppetunnid. Kustuta või tõsta need enne ära.",
      notFound: "Seda ei leitud. Laadi leht uuesti.",
      server: "Salvestamine ei õnnestunud. Proovi uuesti.",
    },
    drawer: {
      label: "Õppetund: {title}",
      close: "Sulge",
      name: "Õppetunni nimi",
      body: "Lühike tekst",
      bodyHint: "Näidatakse õppetunni lehel. Tühi rida alustab uut lõiku.",
      saved: "Salvestatud.",
      // "Õppetunni liik": a video lesson is done at 90 % of its video; a text lesson with "Märgi tehtuks"
      kind: {
        label: "Õppetunni liik",
        video: "Video",
        text: "Tekst",
        confirm: "Video kustutatakse. Jätkan?",
        yes: "Jah, jätka",
        no: "Ei",
      },
      visibility: "Nähtavus",
      hide: "Peida",
      show: "Näita õpilastele",
      hiddenNote: "Peidetud: õpilased seda ei näe ja see ei loe edenemises.",
      delete: "Kustuta õppetund",
      deleteConfirm: "Kas kustutan õppetunni „{title}“ koos video ja failidega?",
      inUse: "Õppetunnil on õpilaste edenemist: seda saab ainult peita.",
    },
    files: {
      title: "Failid",
      none: "Faile pole.",
      add: "Lisa fail",
      hint: "PDF, Word (.docx) või pilt (JPEG, PNG, WebP), kuni 4 MB.",
      uploading: "Laen faili üles…",
      added: "Fail lisatud.",
      remove: "Eemalda",
      removeLabel: "Eemalda fail: {name}",
      type: "Seda faili ei saa kasutada. Vali PDF, Word (.docx) või pilt.",
      size: "Fail on liiga suur (kuni 4 MB).",
      empty: "Fail on tühi.",
      content: "Faili sisu ei vasta selle tüübile.",
      storage: "Failide salvestamine pole seadistatud — anna arendajale teada.",
      session: "Sessioon on aegunud. Logi uuesti sisse ja proovi siis uuesti.",
      server: "Üleslaadimine ei õnnestunud. Proovi uuesti.",
    },
  },
```

  Then delete `courseEditor.sections.modulesE`, `courseEditor.fields.modulesE` and `courseEditor.fields.modulesEHint`.

- [ ] **Step 9: Build the UI.** The behaviour below is binding. Copy the markup patterns from `ClientForms.tsx` (`useActionState`, `submitWith`, the inline confirm of `RevokeAccess`) and `Drawer.tsx`. The client components take `AdminModule` / `AdminLesson` with `import type` only, so no server module enters the browser bundle.
  - **`app/admin/(panel)/koolitused/[id]/page.tsx`:**
    - Below `<CourseEditor …/>`, render `<LessonsEditor courseId={course?.id ?? null} online={course?.type === "e_learning"} modules={course ? await listCourseLessons(db, course.id) : []} />`.
    - When `typeof sp.oppetund === "string"` and `parseRowId(sp.oppetund)` (`src/lib/row-id.ts`) is the id of a lesson in those modules, also render `<Drawer label={fill(adminEt.lessons.drawer.label, { title: pick(lesson.title, "et") })} closeHref={`/admin/koolitused/${course.id}`} closeLabel={adminEt.lessons.drawer.close} returnFocus={`edit-lesson-${lesson.id}`}><LessonDrawer courseId={course.id} lesson={lesson} bunnyReady={bunnyConfig() !== null} /></Drawer>`.
    - Any other `oppetund` shows no drawer and no error.
    - `bunnyReady` is only used from Task 6 on.
  - **`LessonsEditor`** (`"use client"`; `<section className={ui.card} data-lessons-editor="">`):
    - **Heading** `<h2>`: `online ? t.title : adminEt.courseEditor.sections.modulesC` ("Programm"). Under it one hint line: `online ? t.hint : adminEt.courseEditor.fields.modulesCHint`.
    - **`courseId === null`** (a new course): only `t.saveFirst`.
    - **No modules:** `t.empty`.
    - **Modules** are an `<ol>`. Each `<li data-module={id}>` holds:
      - its number `01`, `02` … (the look of the public `ModuleList`);
      - `<I18nInput label={online ? t.moduleName : adminEt.courseEditor.fields.modulesC} name={`module-${id}`} maxLength={120} …/>`;
      - "Salvesta" (`t.save`), shown only while the value differs from the stored one. It runs `renameModule` with `id`, `titleEt`, `titleRu`.
      - ↑ and ↓ (`aria-label` = `fill(t.moveUp | t.moveDown, { title })`, `aria-disabled` on the first / last, the focus kept on the moved button) → `moveModuleInList`;
      - "Kustuta moodul" (`data-delete-module`), **only when the module has no lessons**. It opens the inline confirm `fill(t.deleteModuleConfirm, { title })` with `t.deleteYes` / `t.deleteNo` → `deleteModule`.
      - Errors under the row: `t.errors.required` / `t.errors.tooLong` for the field codes of `invalid`, else `t.errors[error]` (`inUse`, `notFound`, `server`).
    - **Online only**, inside each module:
      - its lessons as `<ol data-lessons>`; each `<li data-lesson={id}>` holds:
        - the number "1.2" (module.lesson);
        - the Estonian title;
        - the tag `t.hiddenTag` (`data-lesson-hidden`) when hidden;
        - for a text lesson the tag `t.textTag` (`data-lesson-kind="text"`); for a video lesson the video tag `t.videoTag[videoStatus]` (`data-lesson-video={videoStatus}`), with `{duration}` = `formatDuration(durationSec)` (so "Video puudub" shows which video lessons still lock the course for students);
        - ↑ ↓ (`aria-label` = `fill(t.moveUp | t.moveDown, { title })`) → `moveLessonInList`, aria-disabled only on the course's very first and very last lesson;
        - `<Link id={`edit-lesson-${id}`} href={`/admin/koolitused/${courseId}?oppetund=${id}`} aria-label={fill(t.editLabel, { title })} data-edit-lesson="">{t.edit}</Link>`.
      - With no lessons: `t.noLessons`.
      - Then a one-field form `data-add-lesson={moduleId}`: `<input name="titleEt">` labelled `t.newLesson`, hidden `moduleId` and `courseId`, button `t.addLesson` → `addLesson`. It redirects into the drawer.
    - **At the end**, a one-field form `data-add-module`: label `online ? t.newModule : t.newItem`, hidden `courseId`, button `online ? t.addModule : t.addItem` → `addModule`. The field is cleared after an ok answer.
    - Every button and input is ≥ 44 px tall. The rows wrap at 390 px without horizontal overflow.
  - **`LessonDrawer`** (`data-lesson-drawer={id}`), in this order:
    1. A form → `saveLesson`:
       - hidden `id`;
       - `<I18nInput label={t.drawer.name} name="lesson-title" maxLength={120}>`;
       - `<I18nInput label={t.drawer.body} hint={t.drawer.bodyHint} multiline rows={6} maxLength={5000}>`;
       - both sent as `titleEt`/`titleRu`/`bodyEt`/`bodyRu`;
       - the "Salvesta" button with `data-save-lesson`;
       - a `role="status"` line: `t.drawer.saved` after an ok answer, or the error.
    2. "Õppetunni liik" (`data-lesson-kind`): a `fieldset` with the legend `t.drawer.kind.label` and two radios (the admin's `Choice` component), `t.drawer.kind.video` and `t.drawer.kind.text`, checked by `lesson.kind`.
       - Choosing "Tekst" on a lesson that has a video (`videoStatus !== "none"` or `replacing`) first shows the inline confirm (the `RevokeAccess` pattern) `t.drawer.kind.confirm` with `t.drawer.kind.yes` / `t.drawer.kind.no`. "Ei" puts the radio back on "Video".
       - Otherwise (or after "Jah, jätka") it submits `setLessonKind` with hidden `id` and `kind` at once. The page refresh then shows or hides the video field.
       - Errors: `t.errors[error]` (`notFound`, `server`) under the fieldset.
    3. Task 6 adds the video field here, for a video lesson only.
    4. `<LessonFiles lessonId files />` (`data-lesson-files`):
       - **The list.** Each file shows its name, its size (`Math.ceil(size / 1000) + " kB"`; Task 9 adds `formatSize` and this line switches to it) and an "Eemalda" button (`aria-label` `fill(t.files.removeLabel, { name })`) → `deleteLessonFile` with `id`. `t.files.none` when there are none.
       - **The picker.** It is the `ImageUpload` pattern: a visually hidden `<input type="file" accept=".pdf,.docx,image/jpeg,image/png,image/webp">` with `<label className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}>{t.files.add}</label>`, the hint `t.files.hint`, and a `role="status"` line.
       - **A pick** is checked in the browser for its size only: over `4 * 1024 * 1024` bytes (the server's `MAX_IMAGE_BYTES`, written out: no server module enters the browser bundle) → `t.files.size`. The type is the server's to judge (415 → `t.files.type`). Then it is sent with `fetch("/api/admin/lesson-file", { method: "POST", body: <FormData with lessonId and file>, credentials: "same-origin" })`.
       - **While it runs:** `t.files.uploading`. A 201 → `t.files.added` and `router.refresh()`.
       - **Errors:** otherwise `t.files[error]` for `type`, `size`, `empty`, `content`, `storage`, `server`; `missing` → `t.files.server`; `notFound` → `t.errors.notFound`; a 401 → `t.files.session`.
    5. Visibility (`data-lesson-visibility`): the heading `t.drawer.visibility`, `t.drawer.hiddenNote` while hidden, and one button `hidden ? t.drawer.show : t.drawer.hide` → `setLessonHidden` (hidden `"0"` / `"1"`).
    6. Delete (`data-delete-lesson`): with `inUse`, only the sentence `t.drawer.inUse`. Otherwise "Kustuta õppetund" → the inline confirm `fill(t.drawer.deleteConfirm, { title })` with `t.deleteYes` / `t.deleteNo` → `deleteLesson` (hidden `id`, `courseId`). Its redirect closes the drawer.

- [ ] **Step 10: Write the e2e test** `tests/e2e/admin-lessons.spec.ts` (desktop and phone; `submitsForms()`; skip unless `LOCAL_FIXTURES`):
  - **Fixtures.** Use the admin sign-in of `admin-clients.spec.ts` (`signInAsAdmin(page, context, visitorIp, created)`; `removeAdminRows(created)` afterwards). Create the test's own course with `onLocalDb(…, { marksPages: false })`: `insert into courses (slug, type, level, title, summary, body, price, access_months, published) values (${accountCourseSlug(clientEmail("les", project))}, 'e_learning', 'basic', ${sql.json({ et: "E2E õppetunnid" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`. `removeClientRows(clientEmail("les", project))` in `afterEach` deletes it with everything under it.
  - **Steps:**
    1. Open `/admin/koolitused/<id>` → `[data-lessons-editor] h2` reads "Moodulid ja õppetunnid", and "Mooduleid veel pole." is shown.
    2. Add "Sissejuhatus", then "Praktika", through `[data-add-module]` → two `[data-module]`. "↓" on the first → the page shows Praktika, Sissejuhatus, and `select title->>'et' from course_modules where course_id = … order by position` agrees.
    3. Add the lesson "Tere tulemast" in "Sissejuhatus" → the address has `?oppetund=<n>` and `dialog[data-drawer]` is open with the name field filled.
    4. Type the short text, "Salvesta" → "Salvestatud.".
    4a. "Õppetunni liik": "Video" is checked, and the list shows the tag "Video puudub". Choose "Tekst" (the lesson has no video, so there is no confirm) → the row's `kind` is `text` and the list shows "Tekst". Choose "Video" again → `kind` is `video`.
    5. `page.locator("[data-lesson-files] input[type=file]").setInputFiles({ name: "Juhend.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%e2e\n") })` → "Fail lisatud." and "Juhend.pdf" listed; its `lesson_files` row exists with a key starting `lessons/`. "Eemalda" → gone (row gone).
    6. "Peida" → behind the drawer, `[data-lesson] [data-lesson-hidden]` reads "Peidetud". "Näita õpilastele" → the tag is gone.
    7. Add a second lesson; "↑" on it moves it before "Tere tulemast". In its drawer, "Kustuta õppetund" → confirm → the drawer closes and the lesson is gone.
    8. "Kustuta moodul" is offered on "Praktika" (empty) and not on "Sissejuhatus"; delete "Praktika".
    9. Set the course to `contact` by SQL and reload → the heading reads "Programm", there is no `[data-lessons]` and no "Lisa õppetund", and the add button reads "Lisa punkt".
    10. At 390 px: no horizontal overflow, and every visible control of `[data-lessons-editor]` and the drawer is ≥ 44 px: `expect(await smallTargets(page.locator("[data-lessons-editor], dialog[data-drawer]"))).toEqual([])` (`import { smallTargets } from "./targets"`, step 0c).

- [ ] **Step 11: Run** unit + DB, `tsc`, lint, the new e2e (both projects, under `next dev` and with `E2E_PROD_BUILD=1`), the whole e2e suite, and `next build`.

- [ ] **Step 12: Commit.**

```bash
git add app/src app/tests
git commit -m "feat(admin): Moodulid ja õppetunnid — modules, lessons, files, hide and delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin — the lesson video (tus to Bunny), the webhook and the fake Bunny

Spec sections 4, 7 and 8.
- **Upload.** Maria picks a file. A server action creates the Bunny video and signs the upload. `tus-js-client` sends the file straight to Bunny, resumably and with retries.
- **Status.** The editor shows "Töötlemisel…" and polls every 5 s until "Valmis · 12:34". Bunny's webhook only triggers the same status read: its payload is not trusted, and its status numbers even differ from the API's (bunny.net/docs/stream/webhooks).
- **Replacement.** "Asenda video" keeps the old video playing until the new one is ready, then deletes it (Task 2 `startUpload` / `settleVideo`).
- **Video lessons only.** The video field shows only for a lesson of kind `video`, and `startLessonVideo` refuses a text lesson ("notFound").

**Files:**
- Create: `app/src/server/lesson-videos.ts`, `app/src/app/api/bunny/webhook/route.ts`, `app/src/components/admin/LessonVideoField.tsx`
- Modify: `app/src/server/actions/admin-lessons.ts` (+ `createLessonVideo`, `checkLessonVideo`), `app/src/components/admin/LessonDrawer.tsx` (the video section), `app/src/i18n/dict/admin.ts` (`lessons.video`), `app/package.json` / `package-lock.json` (`tus-js-client`)
- Create: `app/tests/e2e/bunny-values.ts`, `app/tests/e2e/fake-bunny.ts`
- Modify: `app/tests/local-secrets.ts` (LOCAL_ENV + FORBIDDEN), `app/tests/e2e/server.ts` (the fake as a second web server), `app/tests/unit/e2e-local-secrets.test.ts`, `app/tests/unit/admin-guards.test.ts`
- Test: `app/tests/db/lesson-videos.test.ts`, `app/tests/db/bunny-webhook.test.ts`, `app/tests/unit/lesson-video-field.test.ts` (happy-dom), `app/tests/e2e/admin-video.spec.ts`

**Interfaces:**
- Consumes:
  - `startUpload`, `settleVideo`, `abandonUpload`, `type VideoFields` (Task 2);
  - `bunnyConfig`, `bunnyApi`, `tusSignature`, `UPLOAD_TTL_SEC`, `lessonVideoStatus`, `type BunnyApi`, `type BunnyConfig` (Task 3);
  - `deleteBunnyVideos` (Task 5);
  - `keyMatches(given, expected)` (`review-key.ts`).
- Produces, from `src/server/lesson-videos.ts`:
  - `type UploadTicket = { videoId: string; libraryId: string; expires: number; signature: string; endpoint: string; title: string }`
  - `type AdminVideo = { status: VideoStatus; durationSec: number | null; replacing: boolean }`
  - `type VideoTicketResult = { ok: true; ticket: UploadTicket } | { ok: false; error: "setup" | "notFound" | "server" }`
  - `type VideoCheckResult = { ok: true; video: AdminVideo } | { ok: false; error: "setup" | "notFound" | "server" }`
  - `startLessonVideo(db: Db, api: BunnyApi, config: BunnyConfig, lessonId: number, now: Date): Promise<UploadTicket | "notFound">` ("notFound" also for a text lesson)
  - `refreshLessonVideo(db: Db, api: BunnyApi, target: { lessonId: number } | { videoId: string }): Promise<AdminVideo | null>`
  - `sweepStuckUploads(db: Db, api: BunnyApi, now: Date): Promise<number>` (Task 11 calls it)
- Produces, from `src/server/actions/admin-lessons.ts`: `createLessonVideo(lessonId: number): Promise<VideoTicketResult>`, `checkLessonVideo(lessonId: number): Promise<VideoCheckResult>`.
- Produces the route `POST /api/bunny/webhook?secret=…`:
  - 200 `{ ok: true }`, also for videos and libraries that are not ours;
  - 400 for a body that is no JSON object;
  - 401 with a wrong secret (when one is set);
  - 404 when Bunny is not configured;
  - 500 when the status read fails.
- Produces, from `tests/e2e/bunny-values.ts`: `E2E_BUNNY = { port: 3998, url: "http://localhost:3998", libraryId: "424242", apiKey: "e2e-bunny-api-key", tokenKey: "e2e-bunny-token-key", webhookSecret: "e2e-bunny-webhook-secret" }`.
- Produces, from `tests/e2e/fake-bunny.ts`, the fake's endpoints:
  - `GET /health`;
  - `GET /_fake/state` → `{ videos: { guid, status, length }[]; deleted: string[] }`;
  - the Bunny API, tus, and `/embed/<lib>/<video>` (Player.js, with the button "Mängi lõpuni").

- [ ] **Step 1: Write the failing DB tests** `tests/db/lesson-videos.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessons } from "@/db/schema";
import { bunnyConfig, tusSignature, UPLOAD_TTL_SEC, type BunnyApi } from "@/server/bunny";
import { refreshLessonVideo, startLessonVideo, sweepStuckUploads } from "@/server/lesson-videos";
import { makeTestDb } from "./helpers";

const NOW = new Date("2026-10-06T10:00:00Z");
const CONFIG = bunnyConfig({ BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "test-api-key", BUNNY_TOKEN_KEY: "test-token-key" }, false)!;
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A Bunny that remembers videos: created at status 0, deleted ones gone. */
function fakeBunny(videos: Record<string, { status: number; length: number }> = {}) {
  let n = 100;
  const titles: string[] = [];
  const deleted: string[] = [];
  const api: BunnyApi = {
    createVideo: vi.fn(async (title: string) => {
      titles.push(title);
      const id = guid(++n);
      videos[id] = { status: 0, length: 0 };
      return id;
    }),
    getVideo: vi.fn(async (id: string) => videos[id] ?? null),
    deleteVideo: vi.fn(async (id: string) => {
      deleted.push(id);
      delete videos[id];
    }),
  };
  return { api, videos, titles, deleted };
}

let db: Db;
let lessonId: number;
const row = async () => (await db.select().from(lessons).where(eq(lessons.id, lessonId)))[0];
beforeEach(async () => {
  db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" } }).returning();
  const [m] = await db.insert(courseModules).values({ courseId: c.id, position: 1, title: { et: "M" } }).returning();
  [{ id: lessonId }] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Esimene" } }).returning();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createLessonVideo's work", () => {
  test("a first upload: a Bunny video titled course · lesson and a tus ticket signed for 6 hours; the lesson is uploading", async () => {
    const b = fakeBunny();
    const ticket = await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    if (ticket === "notFound") throw new Error("lesson");
    const expires = Math.floor(NOW.getTime() / 1000) + UPLOAD_TTL_SEC;
    expect(ticket).toEqual({
      videoId: guid(101), libraryId: "12345", expires, endpoint: "https://video.bunnycdn.com/tusupload", title: "Veebikursus · Esimene",
      signature: await tusSignature("12345", "test-api-key", expires, guid(101)),
    });
    expect(b.titles).toEqual(["Veebikursus · Esimene"]);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: null, videoStartedAt: NOW });
  });

  test("an unknown lesson, or a text lesson (it has no video): notFound, and no Bunny video is made", async () => {
    const b = fakeBunny();
    expect(await startLessonVideo(db, b.api, CONFIG, 999999, NOW)).toBe("notFound");
    await db.update(lessons).set({ kind: "text" }).where(eq(lessons.id, lessonId));
    expect(await startLessonVideo(db, b.api, CONFIG, lessonId, NOW)).toBe("notFound");
    expect(b.api.createVideo).not.toHaveBeenCalled();
  });

  test("“Asenda video”: the ready video keeps playing until the new one is ready, then it is deleted from Bunny", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 300 } });
    await db.update(lessons).set({ videoId: guid(1), videoStatus: "ready", durationSec: 300 }).where(eq(lessons.id, lessonId));
    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300 });
    b.videos[guid(101)] = { status: 3, length: 0 };
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "processing", durationSec: 300, replacing: true });
    expect(b.deleted).toEqual([]);
    b.videos[guid(101)] = { status: 4, length: 754 };
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(101) })).toEqual({ status: "ready", durationSec: 754, replacing: false });
    expect(b.deleted).toEqual([guid(1)]);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "ready", replacedVideoId: null, durationSec: 754 });
  });

  test("“Lae uuesti üles” after a failure deletes the failed video and keeps a replaced one", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(2), videoStatus: "failed", replacedVideoId: guid(1), durationSec: 300 }).where(eq(lessons.id, lessonId));
    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(b.deleted).toEqual([guid(2)]);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: guid(1) });
  });
});

describe("refreshLessonVideo", () => {
  test("asks Bunny only about an upload in progress; Bunny not knowing the video is a failure; another video is ignored", async () => {
    const b = fakeBunny();
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "none", durationSec: null, replacing: false });
    expect(b.api.getVideo).not.toHaveBeenCalled();
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading" }).where(eq(lessons.id, lessonId));
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "failed", durationSec: null, replacing: false });
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(77) })).toBeNull();
    expect(await refreshLessonVideo(db, b.api, { lessonId: 999999 })).toBeNull();
  });

  test("Bunny 0 (created) keeps it uploading, 1–3 are processing, 5 is failed", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 0, length: 0 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading" }).where(eq(lessons.id, lessonId));
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.status).toBe("uploading");
    b.videos[guid(5)].status = 1;
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.status).toBe("processing");
    b.videos[guid(5)].status = 5;
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.status).toBe("failed");
  });
});

describe("sweepStuckUploads (the daily cron)", () => {
  test("an upload older than 24 h is deleted from Bunny: the replaced video comes back, or the lesson has none; a younger one stays", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300, videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(b.deleted).toEqual([guid(9)]);
    expect(await row()).toMatchObject({ videoId: guid(1), videoStatus: "ready", replacedVideoId: null, durationSec: 300, videoStartedAt: null });

    await db.update(lessons).set({ videoId: guid(10), videoStatus: "uploading", replacedVideoId: null, durationSec: null, videoStartedAt: new Date(NOW.getTime() - 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(0);
    expect(await row()).toMatchObject({ videoId: guid(10), videoStatus: "uploading" });
  });

  test("a Bunny failure leaves the row as it is, for the next day", async () => {
    const b = fakeBunny();
    b.api.deleteVideo = vi.fn(async () => {
      throw new Error("down");
    });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(0);
    expect((await row()).videoStatus).toBe("uploading");
  });
});
```

  And `tests/db/bunny-webhook.test.ts` (the pattern of `tests/db/cron-sweep.test.ts`):

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessons } from "@/db/schema";
import { stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { POST } from "@/app/api/bunny/webhook/route";

const VIDEO = "11111111-2222-4333-8444-555555555555";
const OLD = "99999999-2222-4333-8444-555555555555";
const call = (body: unknown, secret: string | null = "hook-secret") =>
  POST(new Request(`https://mslab.example/api/bunny/webhook${secret === null ? "" : `?secret=${secret}`}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

let db: Db;
let lessonId: number;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("BUNNY_LIBRARY_ID", "12345");
  vi.stubEnv("BUNNY_API_KEY", "test-api-key");
  vi.stubEnv("BUNNY_TOKEN_KEY", "test-token-key");
  vi.stubEnv("BUNNY_WEBHOOK_SECRET", "hook-secret");
  const [c] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "V" }, summary: { et: "" }, body: { et: "" } }).returning();
  const [m] = await db.insert(courseModules).values({ courseId: c.id, position: 1, title: { et: "M" } }).returning();
  [{ id: lessonId }] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "L" }, videoId: VIDEO, videoStatus: "processing", replacedVideoId: OLD, durationSec: 100 }).returning();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a wrong or missing secret is 401 and asks Bunny nothing", async () => {
  const f = stubFetch();
  expect((await call({ VideoLibraryId: 12345, VideoGuid: VIDEO, Status: 3 }, "wrong")).status).toBe(401);
  expect((await call({ VideoLibraryId: 12345, VideoGuid: VIDEO, Status: 3 }, null)).status).toBe(401);
  expect(f.calls).toHaveLength(0);
});

test("our video: the status is read from Bunny's API (not the payload); ready stores the length and deletes the replaced video", async () => {
  const f = stubFetch((_url, init) => (init?.method === "DELETE" ? Response.json({ success: true }) : Response.json({ guid: VIDEO, status: 4, length: 754 })));
  const res = await call({ VideoLibraryId: 12345, VideoGuid: VIDEO, Status: 5 }); // the payload says "failed"; the API says ready
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(f.calls.map((c) => [c.method, c.url])).toEqual([
    ["GET", `https://video.bunnycdn.com/library/12345/videos/${VIDEO}`],
    ["DELETE", `https://video.bunnycdn.com/library/12345/videos/${OLD}`],
  ]);
  expect((await db.select().from(lessons).where(eq(lessons.id, lessonId)))[0]).toMatchObject({ videoStatus: "ready", durationSec: 754, replacedVideoId: null });
});

test("another library, an unknown video or a guid of another shape: 200 and nothing asked; a body that is not JSON: 400", async () => {
  const f = stubFetch();
  expect((await call({ VideoLibraryId: 777, VideoGuid: VIDEO, Status: 3 })).status).toBe(200);
  expect((await call({ VideoLibraryId: 12345, VideoGuid: "00000000-0000-4000-8000-000000000000", Status: 3 })).status).toBe(200);
  expect((await call({ VideoLibraryId: 12345, VideoGuid: "../../x", Status: 3 })).status).toBe(200);
  expect((await call("not json")).status).toBe(400);
  expect(f.calls).toHaveLength(0);
});
```

  (An unknown guid makes no Bunny call: `refreshLessonVideo` finds no lesson with that `video_id` and stops.)

- [ ] **Step 2: Run them — expect FAIL.**

- [ ] **Step 3: Implement `src/server/lesson-videos.ts`:**

```ts
import { and, asc, eq, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseModules, courses, lessons, type VideoStatus } from "@/db/schema";
import { abandonUpload, settleVideo, startUpload, type VideoFields } from "@/domain/lessons";
import { pick } from "@/i18n/field";
import { lessonVideoStatus, tusSignature, UPLOAD_TTL_SEC, type BunnyApi, type BunnyConfig } from "./bunny";
import { deleteBunnyVideos } from "./lesson-media";
import { logFailure } from "./log";

// A lesson's Bunny video (spec 3a sections 4 and 7): the start of an upload (createLessonVideo), the status read (the editor's poll
// every 5 s and Bunny's webhook, which is only a trigger), and the daily sweep of uploads left unfinished. What changes is decided
// by domain/lessons.ts startUpload / settleVideo / abandonUpload; here are the database rows and the Bunny calls.

export type UploadTicket = { videoId: string; libraryId: string; expires: number; signature: string; endpoint: string; title: string };
export type AdminVideo = { status: VideoStatus; durationSec: number | null; replacing: boolean };
export type VideoTicketResult = { ok: true; ticket: UploadTicket } | { ok: false; error: "setup" | "notFound" | "server" };
export type VideoCheckResult = { ok: true; video: AdminVideo } | { ok: false; error: "setup" | "notFound" | "server" };

/** An upload this old is given up by the daily sweep (spec 7). */
const STUCK_MS = 24 * 3600_000;

const VIDEO_COLUMNS = { videoId: lessons.videoId, videoStatus: lessons.videoStatus, replacedVideoId: lessons.replacedVideoId, durationSec: lessons.durationSec };
const adminVideo = (v: VideoFields): AdminVideo => ({ status: v.videoStatus, durationSec: v.durationSec, replacing: v.replacedVideoId !== null });

/**
 * A new Bunny video for the lesson (titled "<course> · <lesson>") and the signed tus upload of it, valid for 6 hours; the API key
 * stays here. The lesson becomes "uploading"; a ready video keeps playing as the replaced one; an unfinished or failed earlier
 * upload is deleted from Bunny. "notFound" for an unknown lesson or a text lesson (no Bunny video is made).
 */
export async function startLessonVideo(db: Db, api: BunnyApi, config: BunnyConfig, lessonId: number, now: Date): Promise<UploadTicket | "notFound"> {
  const [lesson] = await db
    .select({ title: lessons.title, kind: lessons.kind, course: courses.title })
    .from(lessons)
    .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
    .innerJoin(courses, eq(courseModules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .limit(1);
  if (!lesson || lesson.kind !== "video") return "notFound"; // a text lesson has no video field
  const title = `${pick(lesson.course, "et")} · ${pick(lesson.title, "et")}`.slice(0, 200);
  const videoId = await api.createVideo(title);
  const obsolete = await db.transaction(async (tx) => {
    const [current] = await tx.select(VIDEO_COLUMNS).from(lessons).where(eq(lessons.id, lessonId)).for("update");
    if (!current) return null;
    const change = startUpload(current, videoId);
    await tx.update(lessons).set({ ...change.next, videoStartedAt: now }).where(eq(lessons.id, lessonId));
    return change.obsolete;
  });
  if (obsolete === null) {
    await deleteBunnyVideos(api, [videoId]); // the lesson was deleted meanwhile
    return "notFound";
  }
  await deleteBunnyVideos(api, obsolete);
  const expires = Math.floor(now.getTime() / 1000) + UPLOAD_TTL_SEC;
  return { videoId, libraryId: config.libraryId, expires, signature: await tusSignature(config.libraryId, config.apiKey, expires, videoId), endpoint: config.tusEndpoint, title };
}

/**
 * Reads the status of a lesson's current upload from Bunny's API and stores it. The lesson is named by its id (the editor's poll)
 * or by the video's id (the webhook; any other video is ignored). Only an upload in progress (uploading, processing) is asked
 * about. Ready stores the length and deletes a replaced video; a video Bunny no longer knows counts as failed. null: no such lesson.
 */
export async function refreshLessonVideo(db: Db, api: BunnyApi, target: { lessonId: number } | { videoId: string }): Promise<AdminVideo | null> {
  const where = "lessonId" in target ? eq(lessons.id, target.lessonId) : eq(lessons.videoId, target.videoId);
  const [row] = await db.select({ id: lessons.id, ...VIDEO_COLUMNS }).from(lessons).where(where).limit(1);
  if (!row) return null;
  if (!row.videoId || (row.videoStatus !== "uploading" && row.videoStatus !== "processing")) return adminVideo(row);
  const videoId = row.videoId;
  const bunny = await api.getVideo(videoId);
  const status = bunny ? lessonVideoStatus(bunny.status) : "failed";
  const change = await db.transaction(async (tx) => {
    const [current] = await tx.select(VIDEO_COLUMNS).from(lessons).where(eq(lessons.id, row.id)).for("update");
    if (!current) return null;
    const settled = settleVideo(current, videoId, status, bunny?.length ?? 0);
    if (!settled) return { next: current, obsolete: [] as string[] }; // a newer upload began meanwhile
    await tx.update(lessons).set(settled.next).where(eq(lessons.id, row.id));
    return settled;
  });
  if (!change) return null;
  await deleteBunnyVideos(api, change.obsolete);
  return adminVideo(change.next);
}

/**
 * The daily cron's part (spec 7): uploads still "uploading" more than 24 h after they began are deleted from Bunny; the lesson gets
 * its replaced video back, or has none again. A Bunny failure leaves the row for the next day. Answers the number of lessons reset.
 */
export async function sweepStuckUploads(db: Db, api: BunnyApi, now: Date): Promise<number> {
  const stuck = await db
    .select({ id: lessons.id, ...VIDEO_COLUMNS })
    .from(lessons)
    .where(and(eq(lessons.videoStatus, "uploading"), lt(lessons.videoStartedAt, new Date(now.getTime() - STUCK_MS))))
    .orderBy(asc(lessons.id));
  let swept = 0;
  for (const row of stuck) {
    const { next, obsolete } = abandonUpload(row);
    try {
      for (const id of obsolete) await api.deleteVideo(id);
    } catch (e) {
      logFailure("[video] stuck upload not deleted", e);
      continue;
    }
    const reset = await db
      .update(lessons)
      .set({ ...next, videoStartedAt: null })
      .where(and(eq(lessons.id, row.id), eq(lessons.videoStatus, "uploading"), eq(lessons.videoId, row.videoId ?? "")))
      .returning({ id: lessons.id });
    swept += reset.length;
  }
  return swept;
}
```

- [ ] **Step 4: Implement the webhook** `src/app/api/bunny/webhook/route.ts`:

```ts
import { getDb } from "@/db/client";
import { bunnyApi, bunnyConfig } from "@/server/bunny";
import { refreshLessonVideo } from "@/server/lesson-videos";
import { logFailure } from "@/server/log";
import { keyMatches } from "@/server/review-key";

export const dynamic = "force-dynamic";
// Bunny is given 10 s to answer (server/bunny.ts)
export const maxDuration = 30;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MAX = 4096;

/**
 * POST /api/bunny/webhook?secret=<BUNNY_WEBHOOK_SECRET> — Bunny Stream's webhook ({ VideoLibraryId, VideoGuid, Status },
 * bunny.net/docs/stream/webhooks). Only a trigger: for a video of our library that a lesson is uploading, the status is read from
 * Bunny's API and stored (lesson-videos.ts refreshLessonVideo). The payload's Status is never used, so spoofing is harmless.
 * 401 with a wrong secret (when one is set); 404 when Bunny is not set up; 400 for a body that is no JSON object; else 200.
 */
export async function POST(request: Request): Promise<Response> {
  const config = bunnyConfig();
  if (!config) return json(404, { ok: false });
  if (config.webhookSecret && !(await keyMatches(new URL(request.url).searchParams.get("secret"), config.webhookSecret))) return json(401, { ok: false });
  let body: unknown = null;
  try {
    const text = await request.text();
    body = text.length <= BODY_MAX ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json(400, { ok: false });
  const { VideoLibraryId, VideoGuid } = body as { VideoLibraryId?: unknown; VideoGuid?: unknown };
  if (typeof VideoGuid !== "string" || !GUID.test(VideoGuid) || String(VideoLibraryId) !== config.libraryId) return json(200, { ok: true });
  try {
    await refreshLessonVideo(getDb(), bunnyApi(config), { videoId: VideoGuid });
    return json(200, { ok: true });
  } catch (e) {
    logFailure("[bunny] webhook status read failed", e);
    return json(500, { ok: false });
  }
}
```

- [ ] **Step 5: Add the two actions** to `src/server/actions/admin-lessons.ts`. Add `import { refreshLessonVideo, startLessonVideo, type VideoCheckResult, type VideoTicketResult } from "../lesson-videos";` to the imports, and append:

```ts
/**
 * "Vali video" / "Asenda video" / "Proovi uuesti" / "Lae uuesti üles": a new Bunny video for the lesson and the signed tus upload
 * (the API key never reaches the browser). `setup` when Bunny is not configured ("Video seadistamata").
 */
export const createLessonVideo = adminAction(async (_admin, lessonId: number): Promise<VideoTicketResult> => {
  const config = bunnyConfig();
  if (!config) return { ok: false, error: "setup" };
  if (!Number.isInteger(lessonId) || lessonId <= 0) return { ok: false, error: "notFound" };
  try {
    const ticket = await startLessonVideo(getDb(), bunnyApi(config), config, lessonId, new Date());
    return ticket === "notFound" ? { ok: false, error: "notFound" } : { ok: true, ticket };
  } catch (e) {
    logFailure("[admin] video create failed", e);
    return { ok: false, error: "server" };
  }
});

/** The editor's poll (every 5 s while a video is processing): the lesson's video state, read from Bunny for an upload in progress. */
export const checkLessonVideo = adminAction(async (_admin, lessonId: number): Promise<VideoCheckResult> => {
  const config = bunnyConfig();
  if (!config) return { ok: false, error: "setup" };
  if (!Number.isInteger(lessonId) || lessonId <= 0) return { ok: false, error: "notFound" };
  try {
    const video = await refreshLessonVideo(getDb(), bunnyApi(config), { lessonId });
    return video ? { ok: true, video } : { ok: false, error: "notFound" };
  } catch (e) {
    logFailure("[admin] video check failed", e);
    return { ok: false, error: "server" };
  }
});
```

  In `tests/unit/admin-guards.test.ts`, append `"createLessonVideo", "checkLessonVideo"` to `lessonExports`.

- [ ] **Step 6: Run** the two DB test files and the guard test — expect PASS.

- [ ] **Step 7: Add the dependency.** Run `cd app && npm install tus-js-client@4.3.1`. `package.json` then has `"tus-js-client": "^4.3.1"` under `dependencies`. Only `LessonVideoField.tsx` imports it, and only with `await import("tus-js-client")`.

- [ ] **Step 8: Add the texts** under `lessons` in `src/i18n/dict/admin.ts`:

```ts
    video: {
      title: "Video",
      hint: "Video laaditakse otse videoteenusesse. Hoia leht lahti, kuni üleslaadimine on lõppenud.",
      choose: "Vali video",
      // shown while a video lesson has no video students can watch (none, uploading, processing, failed, and no old one playing)
      waitingHint: "Õpilased näevad „Video lisandub peagi“ ja järgmine õppetund jääb lukku, kuni video on valmis.",
      uploading: "Laen üles… {percent} %",
      processing: "Töötlemisel…",
      ready: "Valmis · {duration}",
      replace: "Asenda video",
      replaceHint: "Vana video jääb õpilastele nähtavaks, kuni uus on valmis.",
      interrupted: "Üleslaadimine katkes",
      retry: "Proovi uuesti",
      failed: "Töötlemine ebaõnnestus",
      reupload: "Lae uuesti üles",
      notSetUp: "Video seadistamata",
      notSetUpHint: "Videoteenuse seaded puuduvad — anna arendajale teada.",
      type: "Vali videofail.",
      error: "Video üleslaadimine ei õnnestunud. Proovi uuesti.",
    },
```

- [ ] **Step 9: Write the failing DOM test** `tests/unit/lesson-video-field.test.ts` (`// @vitest-environment happy-dom`, with the setup of `tests/unit/account-ecourse.test.ts`).
  - Mock `@/server/actions/admin-lessons` (`createLessonVideo` and `checkLessonVideo` as `vi.fn()`) and `next/navigation` (`useRouter: () => ({ refresh })`).
  - Mock `tus-js-client` with a `FakeUpload` class that records its `(file, options)` and has `start`/`abort` spies.
  - Render `<LessonVideoField lessonId={7} bunnyReady video={…} />`.
  - Cases:
    1. `bunnyReady={false}` → "Video seadistamata" and its hint; no file input.
    2. `{ status: "none", durationSec: null, replacing: false }` → "Vali video" (the file input's label), the hint, and "Õpilased näevad „Video lisandub peagi“ ja järgmine õppetund jääb lukku, kuni video on valmis.". The same waiting hint shows for `uploading`, `processing` and `failed`, and **not** for `ready`, nor while `replacing` (the old video still plays).
    3. `{ status: "ready", durationSec: 754, replacing: false }` → "Valmis · 12:34", "Asenda video" and the replace hint; no waiting hint.
    4. `{ status: "failed", … }` → "Töötlemine ebaõnnestus" and "Lae uuesti üles".
    5. `{ status: "uploading", … }` with no upload in this page → "Üleslaadimine katkes" and "Proovi uuesti"; `checkLessonVideo(7)` is called once on mount.
    6. `{ status: "processing", … }` with fake timers:
       - `checkLessonVideo` is called on mount and again every 5 000 ms;
       - when it answers `{ ok: true, video: { status: "ready", durationSec: 125, replacing: false } }`, the text becomes "Valmis · 2:05";
       - the polling then stops and `refresh` is called once.
    7. An upload:
       - picking `new File([new Uint8Array(10)], "tund.mp4", { type: "video/mp4" })` calls `createLessonVideo(7)`, which answers `{ ok: true, ticket: { videoId: "v", libraryId: "424242", expires: 99, signature: "sig", endpoint: "https://tus.example/tusupload", title: "K · L" } }`;
       - `FakeUpload` got `endpoint`, `headers: { AuthorizationSignature: "sig", AuthorizationExpire: "99", VideoId: "v", LibraryId: "424242" }` and `metadata: { filetype: "video/mp4", title: "K · L" }`, and `start()` was called;
       - `options.onProgress(5, 10)` → "Laen üles… 50 %";
       - `options.onSuccess()` → "Töötlemisel…" and a `checkLessonVideo` call.
    8. A picked `text/plain` file → "Vali videofail." and no `createLessonVideo` call.
    9. `createLessonVideo` answering `{ ok: false, error: "server" }`, or `options.onError(new Error("x"))`, → "Video üleslaadimine ei õnnestunud. Proovi uuesti." (`role="alert"`).

- [ ] **Step 10: Implement `LessonVideoField.tsx`** (`"use client"`; `<section data-lesson-video={status}>` with the heading `t.title`, where `t = adminEt.lessons.video`):
  - **State.** The server's `video` (from props, then from `checkLessonVideo`) and a local phase: `idle`, `starting`, `uploading` with `percent`, or `error` with a text.
  - **`!bunnyReady`:** only `t.notSetUp` (`role="status"`) and `t.notSetUpHint`. Nothing else.
  - **`starting` / `uploading`:** a `<progress max={100} value={percent}>` and `fill(t.uploading, { percent })`. A `beforeunload` warning is active (`e.preventDefault()`, as `CourseEditor` does). On unmount the tus upload is `abort()`ed.
  - **Otherwise, by `video.status`:**
    - `none` → the file button `t.choose` and `t.hint`;
    - `uploading` (no upload in this page) → `t.interrupted` + the file button `t.retry`;
    - `processing` → `t.processing` (`role="status"`);
    - `ready` → `fill(t.ready, { duration: formatDuration(durationSec) })` + the file button `t.replace` + `t.replaceHint`;
    - `failed` → `t.failed` + the file button `t.reupload`;
    - with `video.replacing` and a status other than `ready`, `t.replaceHint` too;
    - `t.waitingHint` (`data-video-waiting`) whenever the status is not `ready` and nothing is `replacing` (also during an upload in this page): students see "Video lisandub peagi" and the next lesson stays locked.
  - **The file button** is the `ImageUpload` pattern: a visually hidden `<input type="file" accept="video/*">` with `<label className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}>`. Reset the input after each pick.
  - **A pick:**
    1. A file that is not `video/*` → phase `error` with `t.type`.
    2. Else phase `starting` → `createLessonVideo(lessonId)`. On failure, phase `error` with `t.error` (`setup` shows the not-set-up texts instead).
    3. Then `const { Upload } = await import("tus-js-client")` and `new Upload(file, {…}).start()` with these options:
       - `endpoint: ticket.endpoint`, `retryDelays: [0, 3000, 5000, 10000, 20000, 60000]`, `storeFingerprintForResuming: false`;
       - `headers: { AuthorizationSignature: ticket.signature, AuthorizationExpire: String(ticket.expires), VideoId: ticket.videoId, LibraryId: ticket.libraryId }`;
       - `metadata: { filetype: file.type, title: ticket.title }`;
       - `onProgress(sent, total)` → phase `uploading` with `Math.floor((sent / total) * 100)`;
       - `onError` → phase `error` (`t.error`);
       - `onSuccess` → phase `idle`, `video.status = "processing"`, and an immediate check.
  - **Polling:**
    - On mount, when the status is `uploading` or `processing`, call `checkLessonVideo` once.
    - While the status is `processing`, call it again every 5 000 ms. Stop when it is `ready`, `failed` or `none`, or on unmount.
    - On a change of status, call `router.refresh()` once, so the tag in the list follows.
    - A failed poll is ignored; the next one tries again.
  - Put `{lesson.kind === "video" && <LessonVideoField lessonId={lesson.id} bunnyReady={bunnyReady} video={{ status: lesson.videoStatus, durationSec: lesson.durationSec, replacing: lesson.replacing }} />}` into `LessonDrawer` as its section 3, after "Õppetunni liik". A text lesson has no video field; switching it to "Video" shows the field with "Vali video".

- [ ] **Step 11: Build the fake Bunny and wire it into the e2e run.**
  - **`tests/e2e/bunny-values.ts`:**

```ts
/** The e2e run's Bunny Stream: a fake on this machine (fake-bunny.ts) with made-up keys; the app's server is started with these. */
export const E2E_BUNNY = {
  port: 3998,
  url: "http://localhost:3998",
  libraryId: "424242",
  apiKey: "e2e-bunny-api-key",
  tokenKey: "e2e-bunny-token-key",
  webhookSecret: "e2e-bunny-webhook-secret",
} as const;
```

  - **`tests/e2e/fake-bunny.ts`:**

```ts
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { E2E_BUNNY } from "./bunny-values";

// A stand-in for Bunny Stream in the e2e run: the app's server gets BUNNY_FAKE_URL = this address (tests/local-secrets.ts,
// server/bunny.ts). It speaks what the app uses, with the checks Bunny makes:
// - the API: POST/GET/DELETE /library/<id>/videos[/<guid>] with the AccessKey;
// - tus: POST /tusupload (AuthorizationSignature = sha256(library + key + expiry + video), not expired), HEAD and PATCH
//   /tusupload/<id>, with CORS for the admin page. A finished upload reads as status 3 (transcoding) once, then 4 (ready, 125 s);
// - the player: GET /embed/<library>/<video>?token&expires[&t] (token = sha256(token key + video + expiry), not expired), a page that
//   speaks Player.js: "ready" at once; "Mängi lõpuni" sends timeupdate up to the length (to subscribed events only), then pause, ended;
// - GET /_fake/state (the videos and the deleted ids, for the tests) and GET /health.
// Run: npx tsx tests/e2e/fake-bunny.ts (Playwright starts it: tests/e2e/server.ts).

type Video = { guid: string; status: number; length: number };
const videos = new Map<string, Video>();
const deleted: string[] = [];
const uploads = new Map<string, { videoId: string; length: number; offset: number }>();
const LENGTH = 125;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, HEAD, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, Content-Type, AuthorizationSignature, AuthorizationExpire, VideoId, LibraryId, X-Requested-With, X-HTTP-Method-Override",
  "access-control-expose-headers": "Location, Upload-Offset, Upload-Length, Tus-Resumable",
};

function send(res: ServerResponse, status: number, body: unknown = "", headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, "cache-control": "no-store", ...(typeof body === "string" ? {} : { "content-type": "application/json" }), ...headers });
  res.end(text);
}
const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

/** Bunny's tus check: the signature of library + key + expiry + video, and an expiry in the future. */
function tusAllowed(req: IncomingMessage, videoId: string): boolean {
  const expire = Number(req.headers["authorizationexpire"]);
  return (
    req.headers["libraryid"] === E2E_BUNNY.libraryId &&
    req.headers["videoid"] === videoId &&
    expire > Date.now() / 1000 &&
    req.headers["authorizationsignature"] === sha(`${E2E_BUNNY.libraryId}${E2E_BUNNY.apiKey}${expire}${videoId}`)
  );
}

function player(start: number): string {
  return `<!doctype html><html lang="et"><meta charset="utf-8"><title>Fake player</title>
<body style="margin:0;background:#111;color:#fff;font:16px sans-serif">
<button type="button" data-fake-play style="min-height:44px;margin:12px">Mängi lõpuni</button>
<p data-fake-time>${start}</p>
<script>
const duration = ${LENGTH}; let current = ${start}; const listeners = {};
const post = (m) => parent.postMessage(JSON.stringify({ context: "player.js", version: "0.0.11", ...m }), "*");
addEventListener("message", (e) => {
  let m; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
  if (!m || m.context !== "player.js") return;
  if (m.method === "addEventListener") listeners[m.value] = m.listener ?? m.value;
  if (m.method === "setCurrentTime") current = Number(m.value);
});
const emit = (event, value) => { if (event in listeners) post({ event, value, listener: listeners[event] }); };
document.querySelector("[data-fake-play]").onclick = async () => {
  emit("play");
  while (current < duration) {
    current = Math.min(duration, current + Math.ceil(duration / 10));
    emit("timeupdate", { seconds: current, duration });
    document.querySelector("[data-fake-time]").textContent = String(current);
    await new Promise((r) => setTimeout(r, 40));
  }
  emit("pause");
  emit("ended");
};
post({ event: "ready", value: { src: location.href, events: ["ready", "play", "pause", "ended", "timeupdate"], methods: ["play", "pause", "setCurrentTime", "getCurrentTime", "addEventListener"] } });
</script></body></html>`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", E2E_BUNNY.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204);
  if (path === "/health") return send(res, 200, "ok");
  if (path === "/_fake/state") return send(res, 200, { videos: [...videos.values()], deleted });

  const api = /^\/library\/([^/]+)\/videos(?:\/([^/]+))?$/.exec(path);
  if (api) {
    if (api[1] !== E2E_BUNNY.libraryId) return send(res, 404, { message: "library" });
    if (req.headers["accesskey"] !== E2E_BUNNY.apiKey) return send(res, 401, { message: "key" });
    if (req.method === "POST" && !api[2]) {
      const guid = randomUUID();
      videos.set(guid, { guid, status: 0, length: 0 });
      return send(res, 200, { guid, videoLibraryId: Number(E2E_BUNNY.libraryId), status: 0, length: 0 });
    }
    const video = api[2] ? videos.get(api[2]) : undefined;
    if (!video) return send(res, 404, { message: "video" });
    if (req.method === "DELETE") {
      videos.delete(video.guid);
      deleted.push(video.guid);
      return send(res, 200, { success: true });
    }
    if (req.method === "GET") {
      if (video.status === 1) video.status = 3; // uploaded → transcoding (one read)
      else if (video.status === 3) Object.assign(video, { status: 4, length: LENGTH }); // → finished
      return send(res, 200, { guid: video.guid, status: video.status, length: video.length });
    }
  }

  if (path === "/tusupload" && req.method === "POST") {
    const videoId = String(req.headers["videoid"] ?? "");
    if (!videos.has(videoId) || !tusAllowed(req, videoId)) return send(res, 401, "unauthorized");
    const id = randomUUID();
    uploads.set(id, { videoId, length: Number(req.headers["upload-length"]), offset: 0 });
    return send(res, 201, "", { location: `${E2E_BUNNY.url}/tusupload/${id}`, "tus-resumable": "1.0.0" });
  }
  const tus = /^\/tusupload\/([^/]+)$/.exec(path);
  const upload = tus ? uploads.get(tus[1]) : undefined;
  if (tus && !upload) return send(res, 404, "upload");
  if (upload && !tusAllowed(req, upload.videoId)) return send(res, 401, "unauthorized");
  if (upload && req.method === "HEAD") return send(res, 200, "", { "upload-offset": String(upload.offset), "upload-length": String(upload.length), "tus-resumable": "1.0.0" });
  if (upload && req.method === "PATCH") {
    upload.offset += (await read(req)).length;
    if (upload.offset >= upload.length) videos.get(upload.videoId)!.status = 1;
    return send(res, 204, "", { "upload-offset": String(upload.offset), "tus-resumable": "1.0.0" });
  }

  const embed = /^\/embed\/([^/]+)\/([^/]+)$/.exec(path);
  if (embed && req.method === "GET") {
    const [, library, videoId] = embed;
    const expires = Number(url.searchParams.get("expires"));
    const fine = library === E2E_BUNNY.libraryId && expires > Date.now() / 1000 && url.searchParams.get("token") === sha(`${E2E_BUNNY.tokenKey}${videoId}${expires}`);
    if (!fine) return send(res, 403, "token");
    return send(res, 200, player(Number(url.searchParams.get("t") ?? 0)), { "content-type": "text/html; charset=utf-8" });
  }
  return send(res, 404, "not found");
}

/** Starts the fake on `port` (the e2e run's web server). */
export function startFakeBunny(port: number = E2E_BUNNY.port) {
  return createServer((req, res) => void handle(req, res).catch(() => send(res, 500, "error"))).listen(port);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/e2e/fake-bunny.ts")) startFakeBunny();
```

  - **`tests/local-secrets.ts`.** Import `E2E_BUNNY` from `./e2e/bunny-values` and add to `LOCAL_ENV`:

```ts
  BUNNY_LIBRARY_ID: E2E_BUNNY.libraryId,
  BUNNY_API_KEY: E2E_BUNNY.apiKey,
  BUNNY_TOKEN_KEY: E2E_BUNNY.tokenKey,
  BUNNY_WEBHOOK_SECRET: E2E_BUNNY.webhookSecret,
  BUNNY_FAKE_URL: E2E_BUNNY.url,
```

    Add `BUNNY_API_KEY: "the video tests would create videos in the real Bunny library"` to `FORBIDDEN_SETTINGS`, and extend the `LOCAL_ENV` comment: the Bunny settings point at the fake.
  - **`tests/e2e/server.ts`.** In both local modes, `e2eWebServer()` returns an array: the app server as today, plus `{ command: "npx tsx tests/e2e/fake-bunny.ts", url: `${E2E_BUNNY.url}/health`, reuseExistingServer: !process.env.CI, timeout: 30_000 }`. For a deployment it still returns `undefined`.
  - **`tests/unit/e2e-local-secrets.test.ts`.** The expected `FORBIDDEN_SETTINGS` keys gain `"BUNNY_API_KEY"`. Add this (import `bunnyConfig` and `serverEnv`):

```ts
  test("the Bunny settings point at the fake on this machine (never the real library)", () => {
    expect(LOCAL_ENV.BUNNY_FAKE_URL).toBe("http://localhost:3998");
    expect(bunnyConfig(serverEnv(LOCAL_ENV, false), false)).toMatchObject({ apiBase: "http://localhost:3998", embedBase: "http://localhost:3998/embed" });
  });
```

- [ ] **Step 12: Write the e2e test** `tests/e2e/admin-video.spec.ts` (desktop only: the same flow on a phone adds nothing; `submitsForms()`; skip unless `LOCAL_FIXTURES`).
  - **Fixture:** Task 5's own-course fixture (slug through `accountCourseSlug(clientEmail("vid", project))`), with one module and one lesson inserted by SQL; `removeClientRows` afterwards.
  - **Steps:**
    1. Sign in as admin and open `/admin/koolitused/<course>?oppetund=<lesson>` → `[data-lesson-video]` shows "Vali video" and the waiting hint "Õpilased näevad „Video lisandub peagi“ ja järgmine õppetund jääb lukku, kuni video on valmis.".
    2. `setInputFiles` on its `input[type=file]` with `{ name: "tund.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(256 * 1024, 7) }` → "Töötlemisel…", then "Valmis · 2:05" (allow 20 s), and the waiting hint is gone. The `lessons` row is `ready`, 125 s, and its `video_id` is one of `/_fake/state`'s videos.
    3. "Asenda video" with a second file → "Valmis · 2:05" again. `/_fake/state`'s `deleted` contains the first `video_id`; the row has the new one and `replaced_video_id` null.
    4. "Õppetunni liik" → "Tekst" → "Video kustutatakse. Jätkan?" → "Ei": the radio is back on "Video" and nothing changed. "Tekst" again → "Jah, jätka" → `[data-lesson-video]` is gone; the row is `kind = 'text'`, `video_status = 'none'`, `video_id` null; `/_fake/state`'s `deleted` contains the second `video_id`. "Video" again → the video field shows "Vali video".
    5. The webhook, through the page's `request`:
       - `POST /api/bunny/webhook?secret=wrong` with `{ VideoLibraryId: 424242, VideoGuid: <new id>, Status: 3 }` → 401;
       - with `secret=${E2E_BUNNY.webhookSecret}` → 200 `{ ok: true }`.

- [ ] **Step 13: Run** unit + DB (`npx vitest run`), `tsc` and lint. Then run `npx playwright test admin-video admin-lessons` under `next dev` and with `E2E_PROD_BUILD=1`, the whole e2e suite, and `next build`.

- [ ] **Step 14: Commit.**

```bash
git add app/package.json app/package-lock.json app/src app/tests
git commit -m "feat(admin): lesson video upload to Bunny with tus, status polling, webhook, fake Bunny for e2e

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Student API — the course with lessons, one lesson, progress, "tehtud", files

Spec sections 3, 5, 6 and 7. The account API gains the lesson endpoints. The e-course view gains its lessons, their states and the counts.

The order of the checks is binding: session → active access (404) → a visible lesson of that course (404) → terms (the lesson page only; 403 `terms`) → lesson order (403 `locked`). After the session (`requireClient`), it lives in one place, `openLesson` in `lesson-data.ts`. All four lesson functions start with it; only `loadLesson` asks it for the terms check.

**Files:**
- Create: `app/src/server/lesson-outline.ts`, `app/src/server/lesson-data.ts`
- Modify: `app/src/server/client-data.ts` (`activeAccess` exported, `termsState`, `EcourseView` with modules + lessons + progress)
- Modify: `app/src/server/account-input.ts` (`parseProgress`), `app/src/server/account-api.ts` (deps, `fileAnswer`, `lessonRef`, four handlers, the router)
- Modify: `app/src/app/api/konto/[[...path]]/route.ts` (deps `files`, `bunny`)
- Modify: `app/src/components/account/EcourseView.tsx` (compiles against the new shape; Task 9 rebuilds it)
- Test: `app/tests/db/lesson-api.test.ts` (new), `app/tests/unit/account-input.test.ts`, `app/tests/unit/account-guards.test.ts`
- Update: `app/tests/db/client-data.test.ts`, `app/tests/db/account-api.test.ts`, `app/tests/unit/account-ecourse.test.ts`

**Interfaces:**
- Consumes:
  - the tables (Task 1);
  - `lessonStates`, `courseProgress`, `nextLessonAfter`, `isWatched`, `resumeAt`, `playableVideo`, `completion`, `type CourseProgress`, `type LessonState` (Task 2);
  - `signedEmbedUrl`, `EMBED_TTL_SEC`, `type BunnyConfig`, `bunnyConfig` (Task 3);
  - `type FileStore`, `mediaStore`, `attachmentHeader`, `FILE_URL_TTL_SEC` (Task 4);
  - `parseRowId(raw: string): number | null` (`src/lib/row-id.ts`, Task 5);
  - `requireClient`, `clientResponse`, `badInput`, `withinClientLimit`, `readObject`, `parseSlug` (`account-api.ts` / `account-input.ts`).
- Produces, from `src/server/lesson-outline.ts`:
  - `type OutlineLesson = { id: number; moduleId: number; title: I18n; state: LessonState }`
  - `type OutlineModule = { id: number; title: I18n; lessons: OutlineLesson[] }`
  - `type CourseOutline = { modules: OutlineModule[]; lessons: OutlineLesson[]; progress: CourseProgress }`
  - `courseOutline(db: Db, courseId: number, clientId: number): Promise<CourseOutline>`
- Produces, from `src/server/client-data.ts`:
  - `EcourseView = { course: { slug: string; title: I18n; modules: OutlineModule[] }; access: { expiresAt: string }; terms: { version: string; accepted: boolean; text: I18n | null }; progress: CourseProgress }`
  - `activeAccess(db: Db, clientId: number, slug: string, now: Date): Promise<{ course: { id: number; slug: string; title: I18n }; expiresAt: Date } | null>`
  - `termsState(db: Db, clientId: number, courseId: number): Promise<EcourseView["terms"]>`
- Produces, from `src/server/lesson-data.ts`:
  - `type LessonVideo = { state: "ready"; embedUrl: string; expires: number; resumeAt: number; durationSec: number } | { state: "soon" }`
  - `type LessonView = { course: { slug: string; title: I18n }; module: { title: I18n }; lesson: { id: number; title: I18n; body: I18n | null; done: boolean; textOnly: boolean }; video: LessonVideo | null; files: { id: number; name: string; size: number }[]; next: number | null; watermark: string }`
  - `type LessonRefusal = { kind: "notFound" } | { kind: "terms" } | { kind: "locked"; next: number | null }` (`terms` only when asked for)
  - `type LessonRow` (the visible lesson with its module's title and the client's progress) and `type OpenedLesson = { kind: "open"; access: Access; row: LessonRow; outline: CourseOutline }`, where `Access` is `activeAccess`'s non-null result
  - `openLesson(db: Db, clientId: number, slug: string, lessonId: number, now: Date, opts?: { terms?: boolean }): Promise<OpenedLesson | LessonRefusal>` — the binding order in one place
  - `type LessonResult = { kind: "lesson"; view: LessonView } | LessonRefusal`
  - `loadLesson(db: Db, bunny: BunnyConfig | null, clientId: number, slug: string, lessonId: number, now: Date): Promise<LessonResult>`
  - `type ProgressResult = { kind: "saved"; done: boolean; next: number | null } | { kind: "video" } | { kind: "range" } | LessonRefusal`
  - `saveProgress(db: Db, clientId: number, slug: string, lessonId: number, watchedSec: number, now: Date): Promise<ProgressResult>`
  - `type DoneResult = { kind: "saved"; next: number | null } | { kind: "video" } | LessonRefusal`
  - `markTextLessonDone(db: Db, clientId: number, slug: string, lessonId: number, now: Date): Promise<DoneResult>`
  - `type LessonFileRef = { kind: "file"; key: string; name: string; contentType: string }`
  - `lessonFileFor(db: Db, clientId: number, slug: string, lessonId: number, fileId: number, now: Date): Promise<LessonFileRef | LessonRefusal>`
- Produces, from `account-input.ts`: `parseProgress(body: unknown): Input<{ watchedSec: number }>`; `LIMITS.watchedSec = 172_800`. Ids are parsed with `parseRowId` from `src/lib/row-id.ts` (Task 5), not here.
- Produces, in `account-api.ts` (module-private): `lessonRef(rawSlug: string, rawLesson: string): { slug: string; lessonId: number } | null` — the one slug + lesson id parse step of the four handlers.
- Produces, from `account-api.ts`: `AccountDeps` gains `files?: FileStore | null` and `bunny?: BunnyConfig | null`. The endpoints are:

| Method + path | Body | Success | Errors |
|---|---|---|---|
| GET `/api/konto/kursus/:slug` | — | `EcourseView` (now with `progress` and modules with lessons) | 404 |
| GET `/api/konto/kursus/:slug/:lesson` | — | `LessonView` | 403 `{ ok: false, error: "terms" }`; 403 `{ ok: false, error: "locked", next }`; 404 `{ ok: false }` |
| POST `…/:lesson/progress` | `{ watchedSec }` | `{ ok: true, done, next }` | 400 `{ error: "watchedSec" }`; 403 locked; 404; 409 `{ error: "video" }` (a text lesson, or a video lesson with nothing to play: `completion` is not "watch"); 429 `{ error: "rate" }` (12 a minute per student) |
| POST `…/:lesson/tehtud` | — | `{ ok: true, done: true, next }` | 403 locked; 404; 409 `{ error: "video" }` (any video lesson, ready or not: `completion` is not "mark") |

`LessonView.lesson.textOnly` is `kind === "text"`. A video lesson with nothing to play cannot be completed, so the lesson after it stays locked; the admin can still open it ("Ava järgmine õppetund", Task 10).
| GET `…/:lesson/fail/:file` | — | 302 to a 300 s signed R2 URL, or (local store) the bytes with `content-disposition: attachment` | 403 `{ error: "locked" }`; 404 |

- [ ] **Step 1: Write the failing DB test** `tests/db/lesson-api.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courseModules, courses, lessonFiles, lessonProgress, lessons, pages, termsAcceptances } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { bunnyConfig } from "@/server/bunny";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// Phase 3a (spec section 6): the lesson endpoints of the account API — the course with its lessons and their states, one lesson
// (a signed embed URL for an open lesson with a ready video, 403 locked or terms, 404 without access), progress (kept at its highest,
// done at 90 %, 12 a minute), "tehtud" for a text lesson, and the file download (the bytes, or a 302 to a signed address).

const NOW = new Date("2026-10-06T10:00:00Z");
const SITE = "https://mslab.example";
const BUNNY = bunnyConfig({ BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "test-api-key", BUNNY_TOKEN_KEY: "test-token-key" }, false)!;
const VIDEO_1 = "11111111-1111-4111-8111-111111111111";
const VIDEO_3 = "33333333-3333-4333-8333-333333333333";
const FILE_KEY = "lessons/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.pdf";
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

/**
 * An e-course of two modules: "Video" (lesson 1, a video lesson with a ready video of 100 s; a hidden lesson; lesson 2, a text lesson)
 * and "Lõpp" (lesson 3, a video lesson with a ready video of 200 s, with a PDF); a client signed in (one live session) with six
 * months of access; no terms text stored. Lessons are video lessons unless they say `kind: "text"` (the column default).
 */
async function world(access: Partial<typeof courseAccess.$inferInsert> = {}) {
  const [course] = await db.insert(courses).values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500 }).returning();
  const [m1] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Video" } }).returning();
  const [m2] = await db.insert(courseModules).values({ courseId: course.id, position: 2, title: { et: "Lõpp" } }).returning();
  const [l1] = await db.insert(lessons).values({ moduleId: m1.id, position: 1, title: { et: "Esimene" }, videoId: VIDEO_1, videoStatus: "ready", durationSec: 100 }).returning();
  const [hidden] = await db.insert(lessons).values({ moduleId: m1.id, position: 2, title: { et: "Peidus" }, hidden: true }).returning();
  const [l2] = await db.insert(lessons).values({ moduleId: m1.id, position: 3, title: { et: "Tekst" }, body: { et: "Loe see läbi." }, kind: "text" }).returning();
  const [l3] = await db.insert(lessons).values({ moduleId: m2.id, position: 1, title: { et: "Kolmas" }, videoId: VIDEO_3, videoStatus: "ready", durationSec: 200 }).returning();
  const [file] = await db.insert(lessonFiles).values({ lessonId: l3.id, position: 1, name: "Juhend.pdf", r2Key: FILE_KEY, size: 5, contentType: "application/pdf" }).returning();
  const [client] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
  await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * 86_400_000), ...access });
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { course, l1, l2, l3, hidden, file, client, cookie: `__Host-mslab_client=${raw}` };
}

function deps(over: Partial<AccountDeps> = {}): AccountDeps {
  return {
    db,
    env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
    now: NOW,
    siteUrl: SITE,
    later: () => {},
    dev: false,
    files: fakeMediaStore({ [FILE_KEY]: { bytes: PDF, contentType: "application/pdf" } }),
    bunny: BUNNY,
    ...over,
  };
}

/** GET (no body) or POST (a JSON body) to /api/konto<path> with the session cookie. */
const call = async (d: AccountDeps, cookie: string, path: string, body?: unknown) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), d))!;
const lessonPath = (id: number, rest = "") => `/kursus/veebikursus/${id}${rest}`;

test("the e-course lists its modules with the visible lessons and their states, the counts and where Jätka goes", async () => {
  const w = await world();
  const res = await call(deps(), w.cookie, "/kursus/veebikursus");
  expect(res.status).toBe(200);
  const view = await res.json();
  expect(view.progress).toEqual({ done: 0, total: 3, next: w.l1.id });
  expect(view.course.modules.map((m: { title: { et: string }; lessons: { title: { et: string }; state: string }[] }) => [m.title.et, m.lessons.map((l) => [l.title.et, l.state])])).toEqual([
    ["Video", [["Esimene", "current"], ["Tekst", "locked"]]],
    ["Lõpp", [["Kolmas", "locked"]]],
  ]);
});

test("an open lesson with a ready video: Bunny's URL signed for 4 hours, from the start, the e-mail as watermark; the next one is 403 locked", async () => {
  const w = await world();
  const res = await call(deps(), w.cookie, lessonPath(w.l1.id));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const view = await res.json();
  const expires = Math.floor(NOW.getTime() / 1000) + 4 * 3600;
  expect(view.video).toEqual({
    state: "ready",
    embedUrl: expect.stringMatching(new RegExp(`^https://player\\.mediadelivery\\.net/embed/12345/${VIDEO_1}\\?token=[0-9a-f]{64}&expires=${expires}&autoplay=false$`)),
    expires,
    resumeAt: 0,
    durationSec: 100,
  });
  expect(view).toMatchObject({
    course: { slug: "veebikursus", title: { et: "Veebikursus" } },
    module: { title: { et: "Video" } },
    lesson: { id: w.l1.id, title: { et: "Esimene" }, body: null, done: false, textOnly: false },
    files: [],
    next: w.l2.id,
    watermark: "kati@example.test",
  });
  const locked = await call(deps(), w.cookie, lessonPath(w.l2.id));
  expect(locked.status).toBe(403);
  expect(await locked.json()).toEqual({ ok: false, error: "locked", next: w.l1.id });
});

test("progress is kept at its highest; at 90 % the lesson is done and the next one opens; a done lesson starts from the beginning", async () => {
  const w = await world();
  const d = deps();
  const post = (watchedSec: unknown) => call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec });
  expect(await (await post(50)).json()).toEqual({ ok: true, done: false, next: w.l2.id });
  expect(await (await post(20)).json()).toEqual({ ok: true, done: false, next: w.l2.id });
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(50);
  expect(await (await post(89.9)).json()).toMatchObject({ done: false });
  expect(await (await post(90)).json()).toEqual({ ok: true, done: true, next: w.l2.id });
  expect((await call(d, w.cookie, lessonPath(w.l2.id))).status).toBe(200);
  expect((await (await call(d, w.cookie, lessonPath(w.l1.id))).json()).video.resumeAt).toBe(0);
});

test("a lesson begun: the player starts at the saved second (t=…)", async () => {
  const w = await world();
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l1.id, watchedSec: 42 });
  const view = await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json();
  expect(view.video.resumeAt).toBe(42);
  expect(new URL(view.video.embedUrl).searchParams.get("t")).toBe("42");
});

test("progress refuses: no number (400), past the length + 5 s (400), a locked lesson (403), a hidden or unknown one (404), a text lesson (kind 'text', 409)", async () => {
  const w = await world();
  const d = deps();
  const post = (id: number, body: unknown) => call(d, w.cookie, lessonPath(id, "/progress"), body);
  expect(await (await post(w.l1.id, { watchedSec: "50" })).json()).toEqual({ ok: false, error: "watchedSec" });
  const tooFar = await post(w.l1.id, { watchedSec: 106 });
  expect(tooFar.status).toBe(400);
  expect(await tooFar.json()).toEqual({ ok: false, error: "watchedSec" });
  const locked = await post(w.l3.id, { watchedSec: 1 });
  expect([locked.status, await locked.json()]).toEqual([403, { ok: false, error: "locked", next: w.l1.id }]);
  expect((await post(w.hidden.id, { watchedSec: 1 })).status).toBe(404);
  expect((await post(999999, { watchedSec: 1 })).status).toBe(404);
  expect((await post(w.l1.id, { watchedSec: 105 })).status).toBe(200); // the length + 5 s is fine (and done)
  const text = await post(w.l2.id, { watchedSec: 1 });
  expect([text.status, await text.json()]).toEqual([409, { ok: false, error: "video" }]);
});

test("“Märgi tehtuks” is for a text lesson (kind 'text') only; it opens the next one", async () => {
  const w = await world();
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l1.id, watchedSec: 100, doneAt: NOW });
  const d = deps();
  expect((await call(d, w.cookie, lessonPath(w.l1.id, "/tehtud"), {})).status).toBe(409);
  expect((await (await call(d, w.cookie, lessonPath(w.l2.id))).json()).lesson).toMatchObject({ textOnly: true, done: false });
  expect((await (await call(d, w.cookie, lessonPath(w.l2.id))).json()).video).toBeNull();
  expect(await (await call(d, w.cookie, lessonPath(w.l2.id, "/tehtud"), {})).json()).toEqual({ ok: true, done: true, next: w.l3.id });
  expect((await (await call(d, w.cookie, "/kursus/veebikursus")).json()).progress).toEqual({ done: 2, total: 3, next: w.l3.id });
  expect((await call(d, w.cookie, lessonPath(w.l3.id, "/tehtud"), {})).status).toBe(409); // a video lesson is done by watching
});

test("a video lesson whose video is not uploaded or not ready: 'Video lisandub peagi'; progress and “tehtud” are 409; the next lesson stays locked", async () => {
  const w = await world();
  const d = deps();
  for (const videoStatus of ["none", "uploading", "processing", "failed"] as const) {
    await db.update(lessons).set({ videoStatus, videoId: videoStatus === "none" ? null : VIDEO_1, durationSec: null }).where(eq(lessons.id, w.l1.id));
    const view = await (await call(d, w.cookie, lessonPath(w.l1.id))).json();
    expect([view.video, view.lesson.textOnly], videoStatus).toEqual([{ state: "soon" }, false]);
    expect((await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 1 })).status, videoStatus).toBe(409);
    expect((await call(d, w.cookie, lessonPath(w.l1.id, "/tehtud"), {})).status, videoStatus).toBe(409);
    expect((await call(d, w.cookie, lessonPath(w.l2.id))).status, videoStatus).toBe(403);
  }
  expect(await db.select().from(lessonProgress)).toHaveLength(0);
  expect((await (await call(d, w.cookie, "/kursus/veebikursus")).json()).progress).toEqual({ done: 0, total: 3, next: w.l1.id });
});

test("a lesson an admin opened is open without the one before; a hidden lesson neither counts nor blocks, and is 404", async () => {
  const w = await world();
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l3.id, unlockedBy: "admin@example.test" });
  const view = await (await call(deps(), w.cookie, "/kursus/veebikursus")).json();
  expect(view.course.modules.flatMap((m: { lessons: { state: string }[] }) => m.lessons.map((l) => l.state))).toEqual(["current", "locked", "current"]);
  expect((await call(deps(), w.cookie, lessonPath(w.l3.id))).status).toBe(200);
  expect((await call(deps(), w.cookie, lessonPath(w.hidden.id))).status).toBe(404);
});

test.each([
  ["ended", { expiresAt: new Date(NOW.getTime() - 1000) }],
  ["revoked", { revokedAt: NOW }],
])("access %s: every lesson endpoint answers 404", async (_, access) => {
  const w = await world(access);
  const d = deps();
  expect((await call(d, w.cookie, lessonPath(w.l1.id))).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 1 })).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l2.id, "/tehtud"), {})).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${w.file.id}`))).status).toBe(404);
});

test("a file: 403 while its lesson is locked; open → the bytes as a download (local store) or a 302 to a 5-minute signed address (R2); another lesson's file → 404", async () => {
  const w = await world();
  const path = lessonPath(w.l3.id, `/fail/${w.file.id}`);
  expect((await call(deps(), w.cookie, path)).status).toBe(403);
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l3.id, unlockedBy: "admin@example.test" });
  const local = await call(deps(), w.cookie, path);
  expect(local.status).toBe(200);
  expect(local.headers.get("content-type")).toBe("application/pdf");
  expect(local.headers.get("content-disposition")).toBe(`attachment; filename="Juhend.pdf"; filename*=UTF-8''Juhend.pdf`);
  expect(local.headers.get("cache-control")).toBe("private, no-store");
  expect([...new Uint8Array(await local.arrayBuffer())]).toEqual(PDF);
  const signedGetUrl = vi.fn(async () => "https://r2.example/signed");
  const r2 = await call(deps({ files: { ...fakeMediaStore(), signedGetUrl } }), w.cookie, path);
  expect(r2.status).toBe(302);
  expect(r2.headers.get("location")).toBe("https://r2.example/signed");
  expect(signedGetUrl).toHaveBeenCalledWith(FILE_KEY, { expiresSec: 300 });
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id, `/fail/${w.file.id}`))).status).toBe(404);
  expect((await call(deps({ files: null }), w.cookie, path)).status).toBe(404);
});

test("terms not accepted: the lesson answers 403 terms; once accepted it opens", async () => {
  const w = await world();
  await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Ligipääs on isiklik." } });
  const res = await call(deps(), w.cookie, lessonPath(w.l1.id));
  expect([res.status, await res.json()]).toEqual([403, { ok: false, error: "terms" }]);
  await db.insert(termsAcceptances).values({ clientId: w.client.id, courseId: w.course.id, termsVersion: "1" });
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id))).status).toBe(200);
});

test("one order of checks (openLesson): a hidden lesson is 404 before anything; terms come before the lock, on the lesson page only", async () => {
  const w = await world();
  await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Ligipääs on isiklik." } });
  const d = deps();
  expect((await call(d, w.cookie, lessonPath(w.hidden.id))).status).toBe(404);
  expect(await (await call(d, w.cookie, lessonPath(w.l3.id))).json()).toEqual({ ok: false, error: "terms" }); // locked too, but terms first
  expect(await (await call(d, w.cookie, lessonPath(w.l3.id, "/progress"), { watchedSec: 1 })).json()).toEqual({ ok: false, error: "locked", next: w.l1.id });
  expect(await (await call(d, w.cookie, lessonPath(w.l2.id, "/tehtud"), {})).json()).toEqual({ ok: false, error: "locked", next: w.l1.id });
  expect(await (await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${w.file.id}`))).json()).toEqual({ ok: false, error: "locked" });
});

test("progress: at most 12 reports a minute per student (429 after)", async () => {
  const w = await world();
  const d = deps();
  for (let i = 1; i <= 12; i++) expect((await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: i })).status).toBe(200);
  const res = await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 13 });
  expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
});

test("no video to play yet ('Video lisandub peagi'): an upload on its way, or Bunny not set up; during a replacement the old video plays", async () => {
  const w = await world();
  await db.update(lessons).set({ videoStatus: "processing" }).where(eq(lessons.id, w.l1.id));
  expect((await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video).toEqual({ state: "soon" });
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 1 })).status).toBe(409);
  await db.update(lessons).set({ videoId: "44444444-4444-4444-8444-444444444444", videoStatus: "uploading", replacedVideoId: VIDEO_1 }).where(eq(lessons.id, w.l1.id));
  expect((await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video.embedUrl).toContain(`/embed/12345/${VIDEO_1}?`);
  expect((await (await call(deps({ bunny: null }), w.cookie, lessonPath(w.l1.id))).json()).video).toEqual({ state: "soon" });
});

test("ids that cannot be ids are 404; a GET of …/progress or a POST of a lesson is 404", async () => {
  const w = await world();
  for (const path of ["/kursus/veebikursus/0", "/kursus/veebikursus/01", "/kursus/veebikursus/abc", `/kursus/veebikursus/${w.l1.id}/fail/x`, `/kursus/veebikursus/${w.l1.id}/progress`])
    expect((await call(deps(), w.cookie, path)).status, path).toBe(404);
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id), {})).status).toBe(404);
});
```

  Extend `tests/unit/account-input.test.ts` (import `parseProgress`; the id parser has its own test, `tests/unit/row-id.test.ts`, Task 5):

```ts
test("progress: a number of seconds, 0 … two days", () => {
  expect(parseProgress({ watchedSec: 12.5 })).toEqual({ ok: true, data: { watchedSec: 12.5 } });
  expect(parseProgress({ watchedSec: "x" })).toEqual({ ok: false, error: "watchedSec" });
  for (const bad of [{ watchedSec: "12" }, { watchedSec: -1 }, { watchedSec: 172_801 }, {}, null]) expect(parseProgress(bad).ok, JSON.stringify(bad)).toBe(false);
});
```

- [ ] **Step 2: Run them — expect FAIL.**

- [ ] **Step 3: Implement `src/server/lesson-outline.ts`:**

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseModules, lessonProgress, lessons } from "@/db/schema";
import { courseProgress, lessonStates, type CourseProgress, type LessonState, type OrderedLesson } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";

// One student's view of a course's lessons: the modules in order (empty ones too), the visible lessons in course order with their
// state (domain/lessons.ts: done, current, locked), and the counts. Read by the e-course page (client-data.ts loadEcourse), the lesson
// endpoints (lesson-data.ts) and the admin's student drawer (admin-clients.ts). Two queries; no access check here (callers make it).

export type OutlineLesson = { id: number; moduleId: number; title: I18n; state: LessonState };
export type OutlineModule = { id: number; title: I18n; lessons: OutlineLesson[] };
export type CourseOutline = { modules: OutlineModule[]; lessons: OutlineLesson[]; progress: CourseProgress };

export async function courseOutline(db: Db, courseId: number, clientId: number): Promise<CourseOutline> {
  const [mods, rows] = await Promise.all([
    db.select({ id: courseModules.id, title: courseModules.title }).from(courseModules).where(eq(courseModules.courseId, courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)),
    db
      .select({
        id: lessons.id,
        moduleId: lessons.moduleId,
        title: lessons.title,
        done: sql<boolean>`${lessonProgress.doneAt} is not null`,
        unlocked: sql<boolean>`${lessonProgress.unlockedBy} is not null`,
      })
      .from(lessons)
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .leftJoin(lessonProgress, and(eq(lessonProgress.lessonId, lessons.id), eq(lessonProgress.clientId, clientId)))
      .where(and(eq(courseModules.courseId, courseId), eq(lessons.hidden, false)))
      .orderBy(asc(courseModules.position), asc(courseModules.id), asc(lessons.position), asc(lessons.id)),
  ]);
  const ordered: OrderedLesson[] = rows.map((r) => ({ id: r.id, done: Boolean(r.done), unlockedByAdmin: Boolean(r.unlocked) }));
  const states = lessonStates(ordered);
  const list: OutlineLesson[] = rows.map((r, i) => ({ id: r.id, moduleId: r.moduleId, title: r.title, state: states[i] }));
  return {
    modules: mods.map((m) => ({ id: m.id, title: m.title, lessons: list.filter((l) => l.moduleId === m.id) })),
    lessons: list,
    progress: courseProgress(ordered),
  };
}
```

- [ ] **Step 4: Change `src/server/client-data.ts`:**
  - **Types.** Import `courseOutline` and `type OutlineModule` from `./lesson-outline`, and `type CourseProgress` from `@/domain/lessons`. Drop the `listModuleTitles` import that Task 1 added. `EcourseView` becomes:

```ts
export type EcourseView = {
  course: { slug: string; title: I18n; modules: OutlineModule[] };
  access: { expiresAt: string };
  /** (unchanged comment) */
  terms: { version: string; accepted: boolean; text: I18n | null };
  /** "5 / 24 õppetundi tehtud" and where "Jätka" goes (domain/lessons.ts courseProgress). */
  progress: CourseProgress;
};
```

  - **`activeAccess`** becomes `export async function activeAccess(…)`, unchanged otherwise. Its comment gains: "Also the lesson endpoints' first check (lesson-data.ts)."
  - **`termsState`.** Move the terms part of `loadEcourse` into it:

```ts
/**
 * The terms notice of an e-course for this client: the current version, whether nothing is left to accept, and the text while
 * something is. The version is read BEFORE the text (see loadEcourse).
 */
export async function termsState(db: Db, clientId: number, courseId: number): Promise<EcourseView["terms"]> {
  const versionThenText = async () => {
    const current = await courseTermsVersion(db);
    return [current, await db.select({ body: pages.body }).from(pages).where(eq(pages.key, TERMS_PAGE_KEY)).limit(1)] as const;
  };
  const [[version, page], accepted] = await Promise.all([
    versionThenText(),
    db.select({ version: termsAcceptances.termsVersion }).from(termsAcceptances).where(and(eq(termsAcceptances.clientId, clientId), eq(termsAcceptances.courseId, courseId))),
  ]);
  const text = termsText(page[0]?.body);
  const isAccepted = text === null || accepted.some((row) => row.version === version);
  return { version, accepted: isAccepted, text: isAccepted ? null : text };
}
```

  - **`loadEcourse`** becomes (keep its doc comment, and add "with its modules, the visible lessons and their states, and the counts"):

```ts
export async function loadEcourse(db: Db, clientId: number, slug: string, now: Date): Promise<EcourseView | null> {
  const access = await activeAccess(db, clientId, slug, now);
  if (!access) return null;
  const [terms, outline] = await Promise.all([termsState(db, clientId, access.course.id), courseOutline(db, access.course.id, clientId)]);
  return {
    course: { slug: access.course.slug, title: access.course.title, modules: outline.modules },
    access: { expiresAt: iso(access.expiresAt) },
    terms,
    progress: outline.progress,
  };
}
```

- [ ] **Step 5: Implement `src/server/lesson-data.ts`:**

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, courseModules, lessonFiles, lessonProgress, lessons } from "@/db/schema";
import { completion, isWatched, nextLessonAfter, playableVideo, resumeAt } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";
import { EMBED_TTL_SEC, signedEmbedUrl, type BunnyConfig } from "./bunny";
import { activeAccess, termsState } from "./client-data";
import { courseOutline, type CourseOutline } from "./lesson-outline";

// The lesson endpoints' work (spec 3a sections 5 and 6), for account-api.ts: one lesson, progress, "Märgi tehtuks", a file. The
// client is always the session's. Each starts with openLesson, the one place of the checks' binding order: active access to the
// course (none: notFound) → a visible lesson of that course (else notFound) → (the lesson page only) the terms accepted → the lesson
// order (locked).
// How a lesson is completed follows its kind (domain/lessons.ts completion): a text lesson by "Märgi tehtuks", a video lesson only
// by watching 90 % of a playable video — a video lesson waiting for its video cannot be completed, so the next one stays locked.

export type LessonVideo = { state: "ready"; embedUrl: string; expires: number; resumeAt: number; durationSec: number } | { state: "soon" };
export type LessonView = {
  course: { slug: string; title: I18n };
  module: { title: I18n };
  /** `textOnly`: a text lesson (kind "text"), done with "Märgi tehtuks". */
  lesson: { id: number; title: I18n; body: I18n | null; done: boolean; textOnly: boolean };
  /** null: a text lesson; "soon": a video lesson whose video is not ready yet, or Bunny not set up ("Video lisandub peagi"). */
  video: LessonVideo | null;
  files: { id: number; name: string; size: number }[];
  /** The next visible lesson ("Järgmine õppetund", open once this one is done); null after the last. */
  next: number | null;
  /** The student's e-mail, for the watermark over the video. */
  watermark: string;
};
/** Why a lesson cannot be opened: not this client's (no access, no such visible lesson), terms to accept (asked for), not open yet. */
export type LessonRefusal = { kind: "notFound" } | { kind: "terms" } | { kind: "locked"; next: number | null };
export type LessonResult = { kind: "lesson"; view: LessonView } | LessonRefusal;
/** `terms` never comes back here: only the lesson page asks openLesson for the terms check. */
export type ProgressResult = { kind: "saved"; done: boolean; next: number | null } | { kind: "video" } | { kind: "range" } | LessonRefusal;
export type DoneResult = { kind: "saved"; next: number | null } | { kind: "video" } | LessonRefusal;
export type LessonFileRef = { kind: "file"; key: string; name: string; contentType: string };

/** A visible lesson of the course, with its module's title and this client's progress; null when it is not one. */
async function visibleLesson(db: Db, courseId: number, clientId: number, lessonId: number) {
  const [row] = await db
    .select({
      id: lessons.id,
      title: lessons.title,
      body: lessons.body,
      kind: lessons.kind,
      moduleTitle: courseModules.title,
      videoId: lessons.videoId,
      videoStatus: lessons.videoStatus,
      replacedVideoId: lessons.replacedVideoId,
      durationSec: lessons.durationSec,
      watchedSec: sql<number>`coalesce(${lessonProgress.watchedSec}, 0)`.mapWith(Number),
      done: sql<boolean>`${lessonProgress.doneAt} is not null`,
    })
    .from(lessons)
    .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
    .leftJoin(lessonProgress, and(eq(lessonProgress.lessonId, lessons.id), eq(lessonProgress.clientId, clientId)))
    .where(and(eq(lessons.id, lessonId), eq(courseModules.courseId, courseId), eq(lessons.hidden, false)))
    .limit(1);
  return row ? { ...row, done: Boolean(row.done) } : null;
}

export type LessonRow = NonNullable<Awaited<ReturnType<typeof visibleLesson>>>;
type Access = NonNullable<Awaited<ReturnType<typeof activeAccess>>>;
export type OpenedLesson = { kind: "open"; access: Access; row: LessonRow; outline: CourseOutline };

/**
 * The checks of every lesson endpoint, in the binding order (Global Constraints; spec 6), in this one place: active access to the course
 * → a visible lesson of that course → with `terms: true` (the lesson page only) the course's terms accepted → the lesson order. Answers
 * the course access, the lesson row and the client's outline of the course, or the refusal.
 */
export async function openLesson(db: Db, clientId: number, slug: string, lessonId: number, now: Date, opts: { terms?: boolean } = {}): Promise<OpenedLesson | LessonRefusal> {
  const access = await activeAccess(db, clientId, slug, now);
  if (!access) return { kind: "notFound" };
  const [row, outline, terms] = await Promise.all([
    visibleLesson(db, access.course.id, clientId, lessonId),
    courseOutline(db, access.course.id, clientId),
    opts.terms ? termsState(db, clientId, access.course.id) : null,
  ]);
  if (!row) return { kind: "notFound" };
  if (terms && !terms.accepted) return { kind: "terms" };
  if (outline.lessons.find((l) => l.id === lessonId)?.state === "locked") return { kind: "locked", next: outline.progress.next };
  return { kind: "open", access, row, outline };
}

/** The video part of a lesson: null for a text lesson; ready with a URL signed for 4 hours (from the resume point); else soon. */
async function videoOf(row: LessonRow, bunny: BunnyConfig | null, now: Date): Promise<LessonVideo | null> {
  if (row.kind === "text") return null;
  const videoId = playableVideo(row);
  if (!videoId || !bunny || !row.durationSec) return { state: "soon" };
  const expires = Math.floor(now.getTime() / 1000) + EMBED_TTL_SEC;
  const start = resumeAt(row.watchedSec, row.durationSec, row.done);
  return { state: "ready", embedUrl: await signedEmbedUrl(bunny, videoId, expires, start), expires, resumeAt: start, durationSec: row.durationSec };
}

/** GET a lesson (spec 6): the only endpoint with the terms check. */
export async function loadLesson(db: Db, bunny: BunnyConfig | null, clientId: number, slug: string, lessonId: number, now: Date): Promise<LessonResult> {
  const opened = await openLesson(db, clientId, slug, lessonId, now, { terms: true });
  if (opened.kind !== "open") return opened;
  const { access, row, outline } = opened;
  const [files, [client]] = await Promise.all([
    db.select({ id: lessonFiles.id, name: lessonFiles.name, size: lessonFiles.size }).from(lessonFiles).where(eq(lessonFiles.lessonId, lessonId)).orderBy(asc(lessonFiles.position), asc(lessonFiles.id)),
    db.select({ email: clients.email }).from(clients).where(eq(clients.id, clientId)).limit(1),
  ]);
  if (!client) return { kind: "notFound" };
  return {
    kind: "lesson",
    view: {
      course: { slug: access.course.slug, title: access.course.title },
      module: { title: row.moduleTitle },
      lesson: { id: row.id, title: row.title, body: row.body, done: row.done, textOnly: row.kind === "text" },
      video: await videoOf(row, bunny, now),
      files,
      next: nextLessonAfter(outline.lessons, lessonId),
      watermark: client.email,
    },
  };
}

/**
 * POST progress: kept at its highest (one upsert); done once it reaches 90 % of the length. A video lesson with a playable video
 * only ("watch"): a text lesson, and a video lesson still waiting for its video, are "video" (409).
 */
export async function saveProgress(db: Db, clientId: number, slug: string, lessonId: number, watchedSec: number, now: Date): Promise<ProgressResult> {
  const opened = await openLesson(db, clientId, slug, lessonId, now);
  if (opened.kind !== "open") return opened;
  const { row, outline } = opened;
  if (completion(row) !== "watch" || row.durationSec === null) return { kind: "video" };
  if (watchedSec > row.durationSec + 5) return { kind: "range" };
  const watched = Math.floor(watchedSec);
  const [saved] = await db
    .insert(lessonProgress)
    .values({ clientId, lessonId, watchedSec: watched, doneAt: isWatched(watched, row.durationSec) ? now : null, updatedAt: now })
    .onConflictDoUpdate({
      target: [lessonProgress.clientId, lessonProgress.lessonId],
      set: {
        watchedSec: sql`greatest(${lessonProgress.watchedSec}, excluded.watched_sec)`,
        doneAt: sql`coalesce(${lessonProgress.doneAt}, excluded.done_at)`,
        updatedAt: now,
      },
    })
    .returning({ doneAt: lessonProgress.doneAt });
  return { kind: "saved", done: saved.doneAt !== null, next: nextLessonAfter(outline.lessons, lessonId) };
}

/** POST tehtud ("Märgi tehtuks"): a text lesson (kind "text") only — any video lesson is "video" (409); done once (a second time changes nothing). */
export async function markTextLessonDone(db: Db, clientId: number, slug: string, lessonId: number, now: Date): Promise<DoneResult> {
  const opened = await openLesson(db, clientId, slug, lessonId, now);
  if (opened.kind !== "open") return opened;
  const { row, outline } = opened;
  if (completion(row) !== "mark") return { kind: "video" };
  await db
    .insert(lessonProgress)
    .values({ clientId, lessonId, doneAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [lessonProgress.clientId, lessonProgress.lessonId], set: { doneAt: sql`coalesce(${lessonProgress.doneAt}, excluded.done_at)`, updatedAt: now } });
  return { kind: "saved", next: nextLessonAfter(outline.lessons, lessonId) };
}

/** GET a file: the store key, name and type of a file of an open lesson (a file of another lesson is notFound); locked before the lesson opens. */
export async function lessonFileFor(db: Db, clientId: number, slug: string, lessonId: number, fileId: number, now: Date): Promise<LessonFileRef | LessonRefusal> {
  const opened = await openLesson(db, clientId, slug, lessonId, now);
  if (opened.kind !== "open") return opened;
  const [file] = await db
    .select({ key: lessonFiles.r2Key, name: lessonFiles.name, contentType: lessonFiles.contentType })
    .from(lessonFiles)
    .where(and(eq(lessonFiles.id, fileId), eq(lessonFiles.lessonId, lessonId)))
    .limit(1);
  return file ? { kind: "file", ...file } : { kind: "notFound" };
}
```

- [ ] **Step 6: Change `account-input.ts`.** Set `LIMITS` to `{ name: 120, phone: 40, message: 1000, slug: 200, mergeSlugs: 100, version: 64, watchedSec: 172_800 } as const`, and add:

```ts
const progress = z.object({ watchedSec: z.number().min(0).max(LIMITS.watchedSec) });
export type ProgressInput = z.infer<typeof progress>;
export const parseProgress = (body: unknown) => parse(progress, body);
```

  (No id parser here: a path's lesson and file ids go through `parseRowId` of `src/lib/row-id.ts`.)

  Extend the file's top comment: watchedSec is 0 … 172 800 (the real bound is the video's length + 5 s, checked with the lesson).

- [ ] **Step 7: Change `account-api.ts`.**
  1. **Imports:** `parseProgress` from `./account-input`; `parseRowId` from `@/lib/row-id`; `type BunnyConfig` from `./bunny`; `attachmentHeader`, `FILE_URL_TTL_SEC` from `./lesson-files`; `loadLesson`, `lessonFileFor`, `markTextLessonDone`, `saveProgress` from `./lesson-data`; `type FileStore` from `./media`.
  2. **`AccountDeps`** gains:

```ts
  /** The store of the lesson files (media-store.ts mediaStore()); absent or null: no downloads (404). */
  files?: FileStore | null;
  /** Bunny Stream (bunny.ts bunnyConfig()); absent or null: a lesson's video is "soon" ("Video lisandub peagi"). */
  bunny?: BunnyConfig | null;
```

  3. **The constant** `const PROGRESS_PER_MINUTE = 12;`, documented: "progress reports a student may send per minute (spec 6: it caps the writes; the player sends about 4)".
  4. **`fileAnswer`.** Add it **between `clientResponse` and `me`**, outside the section the guard test reads:

```ts
/**
 * A lesson file for the signed-in client: a 302 to a 5-minute signed R2 address (R2 answers with the name and type the file was
 * stored with), or, from the local folder of `next dev` and the e2e run, the bytes themselves as a download. The cookies of a renewed
 * session go with it, as with clientResponse. null when the store does not have the object.
 */
async function fileAnswer(session: ClientSession, store: FileStore, file: { key: string; name: string; contentType: string }): Promise<Response | null> {
  let res: Response;
  if (store.signedGetUrl) {
    res = new Response(null, { status: 302, headers: { ...BASE_HEADERS, location: await store.signedGetUrl(file.key, { expiresSec: FILE_URL_TTL_SEC }) } });
  } else {
    const object = await store.get(file.key);
    if (!object) return null;
    res = new Response(object.body, { headers: { ...BASE_HEADERS, "content-type": file.contentType, "content-disposition": attachmentHeader(file.name), "x-content-type-options": "nosniff" } });
  }
  for (const cookie of session.cookies) res.headers.append("set-cookie", cookie);
  return res;
}

/** The slug and lesson id of a lesson path (the one parse step of the four lesson handlers); null when either cannot be one (404). */
const lessonRef = (rawSlug: string, rawLesson: string): { slug: string; lessonId: number } | null => {
  const slug = parseSlug(rawSlug);
  const lessonId = parseRowId(rawLesson);
  return slug === null || lessonId === null ? null : { slug, lessonId };
};
```

     Put `lessonRef` next to `fileAnswer`, also outside the guarded section.

  5. **The handlers.** Add these right after `ecourse` (inside the section; each with its doc comment directly above `async function`, as the guard test splits on that):

```ts
/**
 * GET /kursus/:slug/:lesson: one lesson (lesson-data.ts LessonView) — the embed URL of a ready video (signed for 4 hours, from the
 * saved second), the short text, the files, the next lesson, the e-mail for the watermark. 403 `{ error: "terms" }` while the course's
 * terms are not accepted (the page sends the student to the notice); 403 `{ error: "locked", next }` for a lesson not open yet
 * (`next`: where "Jätka" goes); 404 without active access, or for anything that is not a visible lesson of that course.
 */
async function lesson(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  const result = ref ? await loadLesson(deps.db, deps.bunny ?? null, session.clientId, ref.slug, ref.lessonId, deps.now) : null;
  if (result?.kind === "lesson") return clientResponse(session, result.view);
  if (result?.kind === "terms") return clientResponse(session, { ok: false, error: "terms" }, 403);
  if (result?.kind === "locked") return clientResponse(session, { ok: false, error: "locked", next: result.next }, 403);
  return clientResponse(session, { ok: false }, 404);
}

/**
 * POST /kursus/:slug/:lesson/progress `{ watchedSec }`: how far the student has watched (the player sends it about every 15 s and at
 * pause and end). Kept at its highest; at 90 % of the length the lesson is done. 200 `{ ok, done, next }`; 400 `{ error: "watchedSec" }`
 * (no number, or past the length + 5 s); 403 locked; 404; 409 `{ error: "video" }` (a text lesson, or a video lesson still waiting for its
 * video: it cannot be completed, so the next lesson stays locked); 429 `{ error: "rate" }` after
 * 12 in a minute.
 */
async function progress(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  if (ref === null) return clientResponse(session, { ok: false }, 404);
  const input = parseProgress(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  if (!(await withinClientLimit(deps, session.clientId, "client-progress", PROGRESS_PER_MINUTE, 60))) {
    console.info("[account] progress rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await saveProgress(deps.db, session.clientId, ref.slug, ref.lessonId, input.data.watchedSec, deps.now);
  if (result.kind === "saved") return clientResponse(session, { ok: true, done: result.done, next: result.next });
  if (result.kind === "locked") return clientResponse(session, { ok: false, error: "locked", next: result.next }, 403);
  if (result.kind === "video") return clientResponse(session, { ok: false, error: "video" }, 409);
  if (result.kind === "range") return badInput(session, "watchedSec");
  return clientResponse(session, { ok: false }, 404); // notFound (terms is never asked for here)
}

/** POST /kursus/:slug/:lesson/tehtud: "Märgi tehtuks" for a text lesson (kind "text"). 200 `{ ok, done: true, next }`; 403 locked; 404; 409 `{ error: "video" }` (a video lesson). */
async function lessonDone(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  const result = ref ? await markTextLessonDone(deps.db, session.clientId, ref.slug, ref.lessonId, deps.now) : null;
  if (result?.kind === "saved") return clientResponse(session, { ok: true, done: true, next: result.next });
  if (result?.kind === "locked") return clientResponse(session, { ok: false, error: "locked", next: result.next }, 403);
  if (result?.kind === "video") return clientResponse(session, { ok: false, error: "video" }, 409);
  return clientResponse(session, { ok: false }, 404);
}

/** GET /kursus/:slug/:lesson/fail/:file: a file of an open lesson (fileAnswer: a signed R2 address or the bytes). 403 `{ error: "locked" }`; 404. */
async function lessonFile(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string, rawFile: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  const fileId = parseRowId(rawFile);
  const file = ref && fileId !== null ? await lessonFileFor(deps.db, session.clientId, ref.slug, ref.lessonId, fileId, deps.now) : null;
  if (file?.kind === "locked") return clientResponse(session, { ok: false, error: "locked" }, 403);
  const answer = file?.kind === "file" && deps.files ? await fileAnswer(session, deps.files, file) : null;
  return answer ?? clientResponse(session, { ok: false }, 404);
}
```

  6. **The router.** Below `COURSE_PATH` add the lesson path. The end of `dataRoute` becomes:

```ts
/** A lesson's paths: /kursus/<slug>/<lesson>, …/progress, …/tehtud, …/fail/<file>. */
const LESSON_PATH = /^\/kursus\/([^/]+)\/([^/]+)(?:\/(progress|tehtud)|\/fail\/([^/]+))?$/;
```

```ts
  const course = request.method === "GET" ? COURSE_PATH.exec(path) : null;
  if (course) return ecourse(request, deps, course[1]);
  const lessonPath = LESSON_PATH.exec(path);
  if (lessonPath) {
    const [, slug, id, action, file] = lessonPath;
    if (request.method === "GET" && action === undefined && file === undefined) return lesson(request, deps, slug, id);
    if (request.method === "POST" && action === "progress") return progress(request, deps, slug, id);
    if (request.method === "POST" && action === "tehtud") return lessonDone(request, deps, slug, id);
    if (request.method === "GET" && file !== undefined) return lessonFile(request, deps, slug, id, file);
  }
  return accountResponse({ ok: false }, 404);
```

     Extend the file's top comment with the four lesson endpoints.
- **The route** `api/konto/[[...path]]/route.ts`: in `deps()` add `files: mediaStore(),` and `bunny: bunnyConfig(env),` (import them from `@/server/media-store` and `@/server/bunny`).
- **`tests/unit/account-guards.test.ts`:**
  - Both handler lists become `["dashboard", "ecourse", "lesson", "progress", "lessonDone", "lessonFile", "favouriteCourses", "favourite", "mergeFavouriteList", "profile", "newsletter", "changeRequest", "terms", "deleteAccount"]`.
  - Rename the router test to "… only GET /kursus/:slug and the lesson paths are matched by pattern", and add `expect(router).toContain("LESSON_PATH.exec(path)");`.

- [ ] **Step 8: Keep the e-course page compiling** (Task 9 rebuilds it). In `components/account/EcourseView.tsx`, use `const modules = data.course.modules.map((m) => pick(m.title, locale));` instead of `pickList(...)`, and drop the unused import. Then update the fixtures and expectations of the new shape:
  - **`tests/db/client-data.test.ts`, "the e-course view…":** expect `course: { slug: "veebikursus", title: { et: "Veebikursus" }, modules: [{ id: expect.any(Number), title: { et: "Sissejuhatus" }, lessons: [] }, { id: expect.any(Number), title: { et: "Praktika", ru: "Практика" }, lessons: [] }] }` and `progress: { done: 0, total: 0, next: null }`.
  - **`tests/db/account-api.test.ts`:** the same change for its e-course answer (modules `Sissejuhatus`, `Praktika`).
  - **`tests/unit/account-ecourse.test.ts`:** `view()` gives `modules: [{ id: 1, title: { et: "Sissejuhatus", ru: "Введение" }, lessons: [] }, { id: 2, title: { et: "Praktika" }, lessons: [] }]` and `progress: { done: 0, total: 0, next: null }`. Its assertions stay as they are in this task.

- [ ] **Step 9: Run** `npx vitest run` (all), `tsc`, lint, and the account e2e specs (`npx playwright test account-`) — expect PASS. The e-course page looks as before.

- [ ] **Step 10: Commit.**

```bash
git add app/src app/tests
git commit -m "feat(learning): lesson API — course outline with states, lesson, progress, tehtud, files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The player — Bunny's iframe, our fullscreen, the watermark, progress

Spec section 5 ("Player") and section 7 ("Bunny unavailable").

The page talks to Bunny's iframe with the Player.js protocol: JSON strings with `context: "player.js"`. Bunny posts `ready` by itself; every other event needs an `addEventListener` command first (https://github.com/embedly/player.js/blob/master/SPEC.rst, https://bunny.net/docs/stream/playback-api). The listener must be attached **before** the iframe loads, so the iframe is rendered only after it is.

The iframe gets no `allowfullscreen`, and no `picture-in-picture` in `allow`: both would show the video without the watermark. Our own fullscreen enlarges the wrapper that holds the iframe and the watermark. An iPhone without the Fullscreen API gets a window-filling wrapper instead. The accepted limit stays: iPhone's native video fullscreen shows no watermark.

**Files:**
- Create: `app/src/components/account/player-js.ts`, `app/src/components/account/LessonPlayer.tsx`, `app/src/components/account/LessonPlayer.module.css`
- Modify: `app/src/components/account/texts.ts` (`LessonTexts`, `lessonTexts`)
- Modify: `app/src/i18n/dict/et.ts`, `ru.ts` (the whole `account.lesson` section; Task 9 uses the rest of it)
- Modify: `app/tests/unit/colour-tokens.test.ts` (+ `LessonPlayer.module.css`)
- Test: `app/tests/unit/player-js.test.ts`, `app/tests/unit/lesson-player.test.ts` (happy-dom)

**Interfaces:**
- Consumes: the `LessonView.video` "ready" shape (Task 7); `POST /api/konto/kursus/:slug/:lesson/progress` (Task 7); `fill` (`i18n/format`); `ui.btnOutline`.
- Produces, from `player-js.ts`:
  - `PLAYERJS_CONTEXT = "player.js"`, `PLAYERJS_VERSION = "0.0.11"`;
  - `type PlayerMessage = { event: string; value: unknown }`;
  - `readPlayerMessage(data: unknown): PlayerMessage | null`;
  - `playerCommand(method: string, value?: unknown, listener?: string): string`;
  - `secondsOf(value: unknown): number | null`;
  - `PLAYER_EVENTS = ["timeupdate", "pause", "ended"] as const`.
- Produces, from `LessonPlayer.tsx`:
  - `PROGRESS_EVERY_MS = 15_000`, `WATERMARK_MOVE_MS = 60_000`, `READY_TIMEOUT_MS = 20_000`;
  - `LessonPlayer(props: { slug: string; lessonId: number; title: string; video: { embedUrl: string; durationSec: number; resumeAt: number }; watermark: string; done: boolean; t: LessonTexts; onProgress(answer: { done: boolean; next: number | null }): void })`.
- Produces, from `texts.ts`: `type LessonTexts = Dict["account"]["lesson"] & { resume: string; lockedHint: string; loader: LoaderTexts }`; `lessonTexts(d: Dict): LessonTexts`.
  - `resume` and `lockedHint` come from `account.ecourse`, which Task 9 extends. Until then `lessonTexts` reads them from there; see step 3.
- Produces, in the dictionaries, `account.lesson` with exactly these keys:
  `back`, `next`, `files`, `download`, `downloadFile`, `soon`, `videoError`, `done`, `markDone`, `saving`, `failed`, `notFound`, `fullscreen`, `exitFullscreen`, `video`.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/unit/player-js.test.ts`:**

```ts
import { expect, test } from "vitest";
import { playerCommand, readPlayerMessage, secondsOf } from "@/components/account/player-js";

test("a Player.js event: a JSON string (or an object) with context player.js; anything else is nothing", () => {
  expect(readPlayerMessage(JSON.stringify({ context: "player.js", version: "0.0.11", event: "timeupdate", value: { seconds: 3.2, duration: 100 } }))).toEqual({ event: "timeupdate", value: { seconds: 3.2, duration: 100 } });
  expect(readPlayerMessage({ context: "player.js", event: "ready" })).toEqual({ event: "ready", value: undefined });
  for (const other of ["{bad json", JSON.stringify({ context: "other", event: "ready" }), JSON.stringify({ context: "player.js" }), null, 42, "ready"]) expect(readPlayerMessage(other)).toBeNull();
});

test("a command for the iframe: a JSON string with context, version, method, value and listener", () => {
  expect(JSON.parse(playerCommand("addEventListener", "timeupdate", "mslab-timeupdate"))).toEqual({ context: "player.js", version: "0.0.11", method: "addEventListener", value: "timeupdate", listener: "mslab-timeupdate" });
  expect(JSON.parse(playerCommand("play"))).toEqual({ context: "player.js", version: "0.0.11", method: "play" });
});

test("the seconds of a timeupdate (a number, or a numeric string some players send), else null", () => {
  expect(secondsOf({ seconds: 12.5, duration: 100 })).toBe(12.5);
  expect(secondsOf({ seconds: "7" })).toBe(7);
  for (const bad of [{ seconds: -1 }, { seconds: "x" }, {}, null, 5]) expect(secondsOf(bad)).toBeNull();
});
```

  - **`tests/unit/lesson-player.test.ts`:**

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LessonPlayer } from "@/components/account/LessonPlayer";
import { lessonTexts } from "@/components/account/texts";
import { getDict } from "@/i18n/locales";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "https://player.mediadelivery.net";
const VIDEO = { embedUrl: `${ORIGIN}/embed/12345/v1?token=t&expires=1&autoplay=false`, durationSec: 100, resumeAt: 0 };
let container: HTMLDivElement;
let root: Root;
const posted: { method?: string; value?: unknown; context?: string; version?: string }[] = [];
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const onProgress = vi.fn();

/** A message from the player's iframe (a Player.js JSON string), from `origin`. */
const fromPlayer = (event: string, value?: unknown, origin = ORIGIN) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent("message", { origin, data: JSON.stringify({ context: "player.js", version: "0.0.11", event, value }) }));
  });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const progressPosts = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/progress")).map(([, init]) => JSON.parse(String(init!.body)));

beforeEach(async () => {
  vi.useFakeTimers();
  // happy-dom must not try to load Bunny's page into the iframe
  const happy = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM;
  if (happy) happy.settings.disableIframePageLoading = true;
  fetchMock.mockReset().mockResolvedValue(Response.json({ ok: true, done: false, next: 8 }));
  vi.stubGlobal("fetch", fetchMock);
  posted.length = 0;
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", { configurable: true, get: () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(String(m))) }) });
  onProgress.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(LessonPlayer, { slug: "veebikursus", lessonId: 7, title: "Esimene", video: VIDEO, watermark: "kati@example.test", done: false, t: lessonTexts(getDict("et")), onProgress })),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("the iframe: Bunny's signed URL, no fullscreen and no picture-in-picture allowed, the origin-only referrer, a title", () => {
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe(VIDEO.embedUrl);
  expect(frame.getAttribute("allow")).toBe("autoplay; encrypted-media");
  expect(frame.hasAttribute("allowfullscreen")).toBe(false);
  expect(frame.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  expect(frame.getAttribute("title")).toBe("Video: Esimene");
});

test("on ready it asks for timeupdate, pause and ended; a message from another origin is ignored", async () => {
  await fromPlayer("ready", {}, "https://evil.example");
  expect(posted).toEqual([]);
  await fromPlayer("ready", {});
  expect(posted.map((m) => [m.method, m.value])).toEqual([["addEventListener", "timeupdate"], ["addEventListener", "pause"], ["addEventListener", "ended"]]);
  expect(posted[0]).toMatchObject({ context: "player.js", version: "0.0.11" });
});

test("progress: the furthest second every 15 s (only when it moved), and at pause and end; the answer reaches the page", async () => {
  await fromPlayer("ready", {});
  await fromPlayer("timeupdate", { seconds: 12.4, duration: 100 });
  await tick(15_000);
  expect(progressPosts()).toEqual([{ watchedSec: 12 }]);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/kursus/veebikursus/7/progress");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin" });
  await tick(15_000);
  expect(progressPosts()).toHaveLength(1); // nothing new to say
  await fromPlayer("timeupdate", { seconds: 40, duration: 100 });
  await fromPlayer("timeupdate", { seconds: 20, duration: 100 }); // a jump back does not lower it
  await fromPlayer("pause");
  await tick(0);
  expect(progressPosts().at(-1)).toEqual({ watchedSec: 40 });
  fetchMock.mockResolvedValue(Response.json({ ok: true, done: true, next: 8 }));
  await fromPlayer("ended");
  await tick(0);
  expect(progressPosts().at(-1)).toEqual({ watchedSec: 100 });
  expect(onProgress).toHaveBeenLastCalledWith({ done: true, next: 8 });
});

test("pause and ended back to back: the second report waits for the first and is still sent", async () => {
  let release: (r: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
  await fromPlayer("ready", {});
  await fromPlayer("timeupdate", { seconds: 50, duration: 100 });
  await fromPlayer("pause");
  await fromPlayer("ended");
  expect(progressPosts()).toEqual([{ watchedSec: 50 }]);
  release(Response.json({ ok: true, done: false, next: 8 }));
  await tick(0);
  expect(progressPosts()).toEqual([{ watchedSec: 50 }, { watchedSec: 100 }]);
});

test("the watermark: the e-mail over the video, hidden from screen readers, in another corner every 60 s", async () => {
  const mark = container.querySelector("[data-watermark]")!;
  expect(mark.textContent).toBe("kati@example.test");
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  const first = mark.getAttribute("data-corner");
  await tick(60_000);
  expect(mark.getAttribute("data-corner")).not.toBe(first);
});

test("our fullscreen enlarges the wrapper (with the watermark); without the Fullscreen API it fills the window and Escape closes it", async () => {
  const wrapper = container.querySelector("[data-player]") as HTMLElement & { requestFullscreen?: () => Promise<void> };
  const request = vi.fn(async () => {});
  wrapper.requestFullscreen = request;
  const button = container.querySelector("[data-fullscreen]") as HTMLButtonElement;
  expect(button.textContent).toBe("Täisekraan");
  await act(async () => button.click());
  expect(request).toHaveBeenCalledOnce();
  wrapper.requestFullscreen = undefined;
  await act(async () => button.click());
  expect(wrapper.hasAttribute("data-expanded")).toBe(true);
  expect(button.textContent).toBe("Välju täisekraanist");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(wrapper.hasAttribute("data-expanded")).toBe(false);
});

test("no word from the player for 20 s: 'Video ei lae. Proovi hiljem uuesti.'", async () => {
  await tick(20_000);
  expect(container.querySelector("[data-player-error]")?.textContent).toBe("Video ei lae. Proovi hiljem uuesti.");
});
```

- [ ] **Step 2: Run them — expect FAIL** (the modules and texts are missing).

- [ ] **Step 3: Add the texts.**
  - In `src/i18n/dict/et.ts`, after `account.ecourse`:

```ts
    // one lesson /konto/kursus/<slug>/<lesson> (components/account/LessonPage.tsx, LessonPlayer.tsx): one button, "Järgmine õppetund"
    // (or "Märgi tehtuks" in its place while a text lesson is not done), and a quiet way back. {name} is a file's name, {title} the lesson's.
    lesson: {
      back: "Tagasi koolitusele",
      next: "Järgmine õppetund",
      files: "Failid",
      download: "Lae alla",
      downloadFile: "Lae alla: {name}",
      soon: "Video lisandub peagi",
      videoError: "Video ei lae. Proovi hiljem uuesti.",
      done: "Õppetund tehtud ✓",
      markDone: "Märgi tehtuks",
      saving: "Salvestan…",
      failed: "Ei õnnestunud salvestada. Proovi uuesti.",
      notFound: "Seda õppetundi ei leitud.",
      fullscreen: "Täisekraan",
      exitFullscreen: "Välju täisekraanist",
      video: "Video: {title}",
    },
```

  - In `ru.ts`:

```ts
    lesson: {
      back: "Назад к курсу",
      next: "Следующий урок",
      files: "Файлы",
      download: "Скачать",
      downloadFile: "Скачать: {name}",
      soon: "Видео скоро появится",
      videoError: "Видео не загружается. Попробуйте позже.",
      done: "Урок пройден ✓",
      markDone: "Отметить пройденным",
      saving: "Сохраняю…",
      failed: "Не удалось сохранить. Попробуйте ещё раз.",
      notFound: "Урок не найден.",
      fullscreen: "Во весь экран",
      exitFullscreen: "Выйти из полноэкранного режима",
      video: "Видео: {title}",
    },
```

  - In `src/components/account/texts.ts`:

```ts
/** One lesson's page: the account.lesson strings, "Jätka" and the lock sentence (account.ecourse), AccountLoader's. */
export type LessonTexts = Dict["account"]["lesson"] & { resume: string; lockedHint: string; loader: LoaderTexts };

export const lessonTexts = (d: Dict): LessonTexts => ({ ...d.account.lesson, resume: d.account.ecourse.resume, lockedHint: d.account.ecourse.lockedHint, loader: loaderTexts(d) });
```

    `account.ecourse.resume` and `account.ecourse.lockedHint` are added here too, so this compiles now. In `et.ts`'s `account.ecourse` add `resume: "Jätka",` and `lockedHint: "Avaneb, kui eelmine õppetund on tehtud.",`. In `ru.ts` add `resume: "Продолжить",` and `lockedHint: "Откроется, когда предыдущий урок будет пройден.",`. Task 9 adds the rest of the e-course page's keys.

- [ ] **Step 4: Implement `player-js.ts`:**

```ts
// The Player.js protocol (github.com/embedly/player.js SPEC.rst), which Bunny's iframe player speaks (bunny.net/docs/stream/playback-api):
// messages are JSON strings with context "player.js". The player posts "ready" by itself, at load; every other event comes only
// after the page asks for it with addEventListener. These few lines replace the playerjs script: no new dependency, and no
// third-party script on the student's page.

export const PLAYERJS_CONTEXT = "player.js";
export const PLAYERJS_VERSION = "0.0.11";
/** The events the lesson page asks for. */
export const PLAYER_EVENTS = ["timeupdate", "pause", "ended"] as const;

export type PlayerMessage = { event: string; value: unknown };

/** The Player.js event in a message's data (a JSON string, or an object), or null for anything else. */
export function readPlayerMessage(data: unknown): PlayerMessage | null {
  let message: unknown = data;
  if (typeof data === "string") {
    try {
      message = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof message !== "object" || message === null) return null;
  const { context, event, value } = message as { context?: unknown; event?: unknown; value?: unknown };
  return context === PLAYERJS_CONTEXT && typeof event === "string" ? { event, value } : null;
}

/** A command for the iframe, as the protocol sends it (a JSON string). */
export function playerCommand(method: string, value?: unknown, listener?: string): string {
  return JSON.stringify({ context: PLAYERJS_CONTEXT, version: PLAYERJS_VERSION, method, ...(value === undefined ? {} : { value }), ...(listener ? { listener } : {}) });
}

/** The seconds a timeupdate reports (`{ seconds, duration }`; some players send numbers as strings), or null. */
export function secondsOf(value: unknown): number | null {
  const s = (value as { seconds?: unknown } | null)?.seconds;
  const n = typeof s === "number" ? s : typeof s === "string" ? Number(s) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
```

- [ ] **Step 5: Implement `LessonPlayer.tsx`:**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import ui from "@/components/site/ui.module.css";
import { fill } from "@/i18n/format";
import { PLAYER_EVENTS, playerCommand, readPlayerMessage, secondsOf } from "./player-js";
import type { LessonTexts } from "./texts";
import styles from "./LessonPlayer.module.css";

/** How often the furthest point reached is reported (spec 5: about every 15 s), besides at pause and end. */
export const PROGRESS_EVERY_MS = 15_000;
/** The watermark moves to another corner this often (spec 5: about every 60 s). */
export const WATERMARK_MOVE_MS = 60_000;
/** No "ready" from the player in this time: "Video ei lae. Proovi hiljem uuesti." (spec 7). */
export const READY_TIMEOUT_MS = 20_000;

type Props = {
  slug: string;
  lessonId: number;
  title: string;
  video: { embedUrl: string; durationSec: number; resumeAt: number };
  watermark: string;
  /** Already done: nothing more is reported. */
  done: boolean;
  t: LessonTexts;
  /** The server's answer to a report: done (the page shows "Õppetund tehtud ✓") and the next lesson. */
  onProgress(answer: { done: boolean; next: number | null }): void;
};

/**
 * One lesson's video (spec 5): Bunny's iframe (adaptive quality, speed, phone friendly), signed for 4 hours, started at the saved
 * second. Over it the student's e-mail as a faint watermark that moves between the corners (it does not take clicks). The iframe may
 * not go fullscreen or picture-in-picture on its own (either would drop the watermark): our button enlarges the wrapper, iframe and
 * watermark together (an iPhone without the Fullscreen API gets the wrapper over the whole window; its native video fullscreen still
 * shows no watermark — accepted). Progress: the furthest second reached, reported every 15 s when it moved, and at pause and end.
 */
export function LessonPlayer({ slug, lessonId, title, video, watermark, done, t, onProgress }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const furthest = useRef(video.resumeAt);
  const reported = useRef(video.resumeAt);
  const finished = useRef(done);
  const answered = useRef(onProgress);
  const [listening, setListening] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [corner, setCorner] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const origin = new URL(video.embedUrl).origin;
  const progressUrl = `/api/konto/kursus/${encodeURIComponent(slug)}/${lessonId}/progress`;

  useEffect(() => {
    answered.current = onProgress;
  });

  // The Player.js listener and the reports. Attached before the iframe exists: the player posts "ready" once, when it loads.
  useEffect(() => {
    let sending = false;
    let again = false;
    const report = async (): Promise<void> => {
      const watchedSec = Math.floor(furthest.current);
      if (finished.current || watchedSec <= reported.current) return;
      if (sending) {
        again = true;
        return;
      }
      sending = true;
      try {
        const res = await fetch(progressUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ watchedSec }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { done?: unknown; next?: unknown } | null;
          reported.current = watchedSec;
          const answer = { done: body?.done === true, next: typeof body?.next === "number" ? body.next : null };
          if (answer.done) finished.current = true;
          answered.current(answer);
        }
      } catch {
        // no answer: the next report tries again
      } finally {
        sending = false;
        if (again) {
          again = false;
          void report();
        }
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const message = readPlayerMessage(e.data);
      if (!message) return;
      if (message.event === "ready") {
        setReady(true);
        setFailed(false);
        for (const event of PLAYER_EVENTS) frame.current?.contentWindow?.postMessage(playerCommand("addEventListener", event, `mslab-${event}`), origin);
      } else if (message.event === "timeupdate") {
        const seconds = secondsOf(message.value);
        if (seconds !== null && seconds > furthest.current) furthest.current = Math.min(seconds, video.durationSec);
      } else if (message.event === "pause") {
        void report();
      } else if (message.event === "ended") {
        furthest.current = video.durationSec;
        void report();
      }
    };
    // leaving the page: the last point, sent even as the page goes away
    const onLeave = () => {
      const watchedSec = Math.floor(furthest.current);
      if (finished.current || watchedSec <= reported.current) return;
      void fetch(progressUrl, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ watchedSec }) }).catch(() => {});
    };
    const timer = setInterval(() => void report(), PROGRESS_EVERY_MS);
    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", onLeave);
    setListening(true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [origin, progressUrl, video.durationSec]);

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    const timer = setInterval(() => setCorner((c) => (c + 1) % 4), WATERMARK_MOVE_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapper.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // the window-filling wrapper (no Fullscreen API): Escape closes it, the page behind does not scroll
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      html.style.overflow = overflow;
    };
  }, [expanded]);

  const toggle = () => {
    const el = wrapper.current;
    if (!el) return;
    if (fullscreen) void document.exitFullscreen?.();
    else if (expanded) setExpanded(false);
    else if (typeof el.requestFullscreen === "function") void el.requestFullscreen().catch(() => setExpanded(true));
    else setExpanded(true);
  };
  const big = fullscreen || expanded;

  return (
    <div ref={wrapper} className={styles.player} data-player="" data-expanded={expanded ? "" : undefined}>
      <div className={styles.frame}>
        {listening && (
          <iframe
            ref={frame}
            src={video.embedUrl}
            title={fill(t.video, { title })}
            allow="autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
            loading="eager"
          />
        )}
        <span className={styles.mark} data-watermark="" data-corner={corner} aria-hidden="true">
          {watermark}
        </span>
        {failed && !ready && (
          <p className={styles.failed} role="status" data-player-error="">
            {t.videoError}
          </p>
        )}
      </div>
      <div className={styles.bar}>
        <button type="button" className={ui.btnOutline} onClick={toggle} data-fullscreen="">
          {big ? t.exitFullscreen : t.fullscreen}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Style it** (`LessonPlayer.module.css`, tokens only; add the file to `COURSE_CSS` in `tests/unit/colour-tokens.test.ts`):
  - **`.player`:** a column with a `var(--r-card)` radius and `overflow: hidden`.
  - **`.frame`:** `position: relative; aspect-ratio: 16 / 9; background: var(--ink)`. The iframe fills it (`position: absolute; inset: 0; width: 100%; height: 100%; border: 0`).
  - **`.mark`:**
    - `position: absolute; pointer-events: none; user-select: none; opacity: 0.3; color: var(--paper)`;
    - `font: 600 clamp(11px, 1.6vw, 15px)/1.2 var(--font-body)`;
    - `text-shadow: 0 0 2px var(--ink)`, so it reads on a light frame too;
    - `[data-corner="0"]` top left, `"1"` top right, `"2"` bottom right, `"3"` bottom left, each 4 % from its edges. The bottom ones stay above Bunny's control bar: `bottom: 18%`.
  - **`.failed`:** centred over the frame, `color: var(--paper)`.
  - **`.bar`:** `display: flex; justify-content: flex-end; padding: 8px 0`. The button is `ui.btnOutline` (≥ 44 px).
  - **In fullscreen** (`.player:fullscreen`, and `.player[data-expanded]` = `position: fixed; inset: 0; z-index: 1000; background: var(--ink)`), `.frame` fills the space left above `.bar` (`flex: 1; aspect-ratio: auto`) and `.bar` uses `color: var(--paper)`.
  - **Motion:** no animation and no transition; the watermark jumps between corners, so `prefers-reduced-motion` has nothing to turn off.

- [ ] **Step 7: Run** the two test files, then `npx vitest run` (the i18n parity, placeholder and colour tests included), `tsc` and lint. Expect PASS.

- [ ] **Step 8: Commit.**

```bash
git add app/src/components/account app/src/i18n/dict app/tests/unit
git commit -m "feat(learning): lesson player — Bunny iframe, watermark, own fullscreen, progress reports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8b: Video shape — upright and mixed videos (Dim, 06.10.2026)

Maria may record lessons upright on a phone, or mix shapes. The player and the watermark must fit each video's own shape, not assume 16:9.

**Files:**
- Create: `app/drizzle/0004_video_shape.sql` (+ meta snapshot/journal via `drizzle-kit generate`)
- Modify: `app/src/db/schema.ts` (`lessons.video_width`, `lessons.video_height`: integer, nullable)
- Modify: `app/src/domain/lessons.ts` (`settleVideo` takes the shape; stores it only on ready; `dropVideo` clears it)
- Modify: `app/src/server/bunny.ts` (`BunnyVideo` gains `width`, `height`; parsed from the get-video answer — Bunny's video object fields `width` and `height`, verify at https://docs.bunny.net/reference/video_getvideo)
- Modify: `app/src/server/lesson-videos.ts` (pass the shape to `settleVideo`; the compare-and-set write includes the two columns)
- Modify: `app/src/server/lesson-data.ts` (the lesson answer's ready video carries `shape: { width, height } | null`)
- Modify: `app/src/components/account/LessonPlayer.tsx` + `.module.css` (frame aspect from the shape, 16:9 when null)
- Modify: `app/tests/e2e/fake-bunny.ts` (returns `width`/`height`; a way to make one video upright, e.g. 1080×1920)
- Test: `app/tests/unit/lessons.test.ts`, `app/tests/unit/bunny.test.ts`, `app/tests/db/lesson-videos.test.ts` (or where settle writes are tested), `app/tests/db/lesson-api.test.ts`, `app/tests/unit/lesson-player.test.ts`, `app/tests/e2e/lesson-player.spec.ts`

**Rules:**
1. Migration 0004 is additive only (two nullable integer columns). It is applied on Railway before the deploy (Task 12); the drop of `courses.modules` becomes migration 0008 after the deploy (Task 12 text is updated by the controller).
2. Shape = `{ width, height }` of the video that PLAYS. `settleVideo(v, videoId, status, lengthSec, shape?)`: on a transition to `ready`, store the shape when both are integers 1…10000, else store null for both. While a replacement uploads/processes, the old (playing) video's stored shape stays untouched; when the new one settles ready, its shape replaces it. `dropVideo` sets both to null. `abandonUpload` keeps the stored shape (it belongs to the replaced video that keeps playing) — and for a first upload there is none.
3. `getVideo` parses `width`/`height` as numbers (missing/invalid → 0); it does not throw for a missing shape (older or still-processing videos).
4. API: `video: { embedUrl, expires, resumeAt, shape: { width, height } | null }` for a ready video. Nothing else changes.
5. Player:
   - Normal size: the frame's `aspect-ratio` is `width / height` (16 / 9 when shape is null). A landscape video fills the column width. An upright (or square) video is centred and its height is capped (e.g. `max-height: min(80svh, 720px)`, width from the aspect ratio), so it never runs off the screen.
   - Enlarged (fullscreen and window-filling): the frame is the largest box of the video's own aspect that fits the stage, centred (generalise the current `min(100cqw, 100cqh * 16 / 9)` to the video's aspect, e.g. via a CSS custom property `--aspect` set inline as a number).
   - The watermark corners stay relative to the frame (unchanged), so they sit on the picture for any shape.
   - The player keys/remounts as today; the shape only comes from the lesson answer.
6. Tests:
   - Domain: ready stores a valid shape; invalid (0, negative, NaN, >10000, fractional) → null; non-ready settle leaves the shape; replacement keeps the old shape until the new is ready, then switches; `dropVideo` clears.
   - Bunny: parses width/height; missing → 0, no throw.
   - DB: the settle write stores the shape; a stale write cannot overwrite it (existing compare-and-set tests extended).
   - API: ready video includes `shape`; null when unknown.
   - DOM: the frame gets the video's aspect (inline style or custom property); null shape → 16:9.
   - E2E (both projects, dev): an upright video (fake 1080×1920): at 390×844 and 1440×900, normal size, the frame is upright, its height ≤ 80 % of the viewport, centred; in window-filling (390×844 and 844×390) and real fullscreen the frame is the largest upright box that fits, centred, and the watermark box lies inside the frame (the existing `expectWatermarkOnPicture` generalised to the aspect). Keep the existing 16:9 cases.
7. Commit: `feat(learning): lessons keep each video's shape; the player and watermark fit it`.

---

### Task 9: Student pages — the e-course with progress, the lesson page, routing, cache

Spec sections 5 and 6.

**The e-course page** shows, in this order:
- the terms notice (unchanged);
- the title and "Ligipääs kuni …";
- "5 / 24 õppetundi tehtud" with a thin bar;
- one button "Jätka" ("Alusta" before the first lesson) to the next lesson that is open and not done;
- the modules, with each lesson ✓ done, ▶ open, or 🔒 locked;
- "Avaneb, kui eelmine õppetund on tehtud." under the first locked lesson.

On phones the modules collapse, and the module of the next lesson starts open.

**The lesson page** is a new static shell. It shows:
- the module and lesson titles;
- the player, or "Video lisandub peagi";
- the short text;
- the files ("Lae alla");
- one button and a quiet "Tagasi koolitusele".

A locked lesson shows the lock sentence with "Jätka".

**Files:**
- Modify: `app/src/components/account/EcourseView.tsx` (+ `EcourseView.module.css`; `"use client"`, `readOnly`), `app/src/components/account/useAccount.ts` (the `forbidden` state), `app/src/components/account/AccountLoader.tsx` (the `forbidden` prop), `app/src/components/account/texts.ts` (`EcourseTexts` unchanged in form; it gains the new keys through the dictionary)
- Create: `app/src/components/account/LessonPage.tsx` (+ `LessonPage.module.css`), `app/src/app/[locale]/(site)/konto/kursus/[slug]/[lesson]/page.tsx`
- Modify: `app/src/lib/site-routing.ts` (the lesson page, its id through `parseRowId`), `app/src/i18n/format.ts` (`formatSize`), `app/src/i18n/dict/et.ts`, `ru.ts` (`account.ecourse` keys), `app/src/components/admin/LessonFiles.tsx` (use `formatSize`)
- Modify: `app/tests/unit/colour-tokens.test.ts` (+ `LessonPage.module.css`)
- Create: `app/tests/e2e/lessons.ts` (fixtures), `app/tests/e2e/account-lessons.spec.ts`
- Test: `app/tests/unit/site-routing.test.ts`, `app/tests/unit/use-account.test.ts`, `app/tests/unit/account-ecourse.test.ts`, `app/tests/unit/account-lesson.test.ts` (new, happy-dom), `app/tests/unit/i18n.test.ts` (`formatSize`), `app/tests/e2e/account-ecourse.spec.ts`, `app/tests/e2e/cache.spec.ts`

**Interfaces:**
- Consumes: `EcourseView`, `LessonView`, the endpoints (Task 7); `LessonPlayer`, `lessonTexts`, `account.lesson` (Task 8); `parseRowId` (`src/lib/row-id.ts`) and `smallTargets` (`tests/e2e/targets.ts`), both Task 5; `paragraphs(text)` (`domain/catalogue.ts`); `ModuleList`'s look (`CourseLists.module.css`); `Icon` (`check`, `play`, `lock`, `arrow`).
- Produces, from `useAccount.ts`:
  - `AccountState` gains `"forbidden"`;
  - `type Refusal = { error: string; next: number | null }`;
  - the options gain `forbidden?: boolean`;
  - the result gains `refusal: Refusal | null`.
- Produces, from `AccountLoader`: the prop `forbidden?: (refusal: Refusal) => React.ReactNode`.
- Produces, from `EcourseView`: the props `{ data: EcourseView; locale: Locale; t: EcourseTexts; focusHeading?: boolean; readOnly?: boolean }` (Task 10 renders it read-only).
- Produces, from `LessonPage`: `LessonPage({ slug, lessonId, locale, t }: { slug: string; lessonId: number; locale: Locale; t: LessonTexts })`.
- Produces, from `site-routing.ts`: `isKnownPage` knows `/konto/kursus/<slug>/<lessonId>`, where the id passes `parseRowId` (Task 5, `src/lib/row-id.ts`): the route pattern stays a regex, and the id's ≤ 2 147 483 647 rule comes from the one parser. The shell page parses the id with `parseRowId` too (no separate `isLessonId`).
- Produces, from `i18n/format.ts`: `formatSize(bytes: number, l: Locale): string` ("820 kB", "1,4 MB"; RU "820 КБ", "1,4 МБ").
- Produces, from `tests/e2e/lessons.ts`:
  - `type LessonCourse = { clientId: number; slug: string; lessons: { video: number; text: number; last: number }; fileId: number; fileName: string }`
  - `insertLessonCourse(email: string, opts?: { locale?: "et" | "ru" }): Promise<LessonCourse>`

- [ ] **Step 1: Write the failing unit tests.**
  - **`tests/unit/site-routing.test.ts`:**
    - In "the known pages are exactly the pages of app/[locale]/(site)", add `"/konto/kursus/[slug]/[lesson]"` to the expected list.
    - In "the client account's pages are known…", add `/konto/kursus/kulmude-lami/12` (both locales) to the known pages, and `/et/konto/kursus/x/0`, `/et/konto/kursus/x/012`, `/et/konto/kursus/x/12/y` and `/et/konto/kursus/X/12` to the unknown ones. Keep `/et/konto/kursus/x/y` unknown.
    - Add `expect(route("/konto/kursus/kulmude-lami/12?viga=1")).toEqual({ kind: "shellRedirect", location: "/konto/kursus/kulmude-lami/12#viga=1" });` and `expect(route("/ru/konto/kursus/kulmude-lami/12")).toEqual({ kind: "page", page: "/ru/konto/kursus/kulmude-lami/12", rewritten: false });`.
  - **`tests/unit/use-account.test.ts`.** Follow its harness and add:
    1. With `{ forbidden: true }`, a 403 `{ ok: false, error: "locked", next: 9 }` gives `state === "forbidden"` and `refusal` `{ error: "locked", next: 9 }`; `next` that is no number gives `null`.
    2. Without the option, the same 403 is `"error"`.
    3. A 403 without JSON is `"error"` either way.
  - **`tests/unit/i18n.test.ts`:**

```ts
test("formatSize: kB under a megabyte (at least 1), MB with one decimal, in the page's language", () => {
  expect(formatSize(820_000, "et")).toBe("820 kB");
  expect(formatSize(12, "et")).toBe("1 kB");
  expect(formatSize(1_400_000, "et")).toBe("1,4 MB");
  expect(formatSize(1_400_000, "ru")).toBe("1,4 МБ");
  expect(formatSize(820_000, "ru")).toBe("820 КБ");
});
```

  - **`tests/unit/account-ecourse.test.ts`.** Rewrite the "course view" cases for the new markup (keep the terms cases). The `view()` fixture gains lessons: module 1 "Sissejuhatus" with lesson 11 (done) and lesson 12 (current), module 2 "Praktika" with lesson 21 (locked) and lesson 22 (locked), and `progress: { done: 1, total: 4, next: 12 }`. Assertions:
    1. `[data-ecourse-progress]` reads "1 / 4 õppetundi tehtud".
    2. `[role=progressbar]` has `aria-valuenow="1"` and `aria-valuemax="4"`.
    3. `[data-ecourse-next]` reads "Jätka" and links to `/konto/kursus/veebikursus/12`.
    4. With `progress.done = 0` it reads "Alusta".
    5. `[data-lesson="11"][data-state="done"]` and `[data-lesson="12"][data-state="current"]` are links to their lesson pages. `[data-lesson="21"][data-state="locked"]` is not a link and has the label "Lukustatud".
    6. Exactly one `[data-locked-hint]`, under lesson 21, reads "Avaneb, kui eelmine õppetund on tehtud.".
    7. Stub `window.matchMedia` for `(min-width: 768px)`. With `matches: false` (a phone), the `details` of module 1 (it holds the next lesson) is open and module 2's is closed. With `matches: true`, both are open.
    8. With no lessons at all (`total: 0`): no progress line, no button, `[data-ecourse-soon]` "Sisu lisandub peagi.", and the module titles are listed.
    9. When every lesson is done (`next: null`): no button.
    10. `readOnly`: no `<a>` inside `[data-ecourse]`; the button and the lesson titles carry `aria-disabled="true"`.
    11. RU: "Пройдено уроков: 1 / 4", "Продолжить".
  - **`tests/unit/account-lesson.test.ts`** (new; happy-dom, with `fetch` answered as in `account-ecourse.test.ts`; `LessonPlayer` mocked with `vi.mock("@/components/account/LessonPlayer", () => ({ LessonPlayer: (p: { video: { embedUrl: string } }) => createElement("div", { "data-player-mock": p.video.embedUrl }) }))`). Mount `LessonPage` for `veebikursus`, lesson 7. Cases:
    1. **A video lesson, not done:**
       - the eyebrow is the module title and `h1` the lesson title;
       - the player mock gets the embed URL;
       - the short text is in paragraphs;
       - files are listed as links `href="/api/konto/kursus/veebikursus/7/fail/<id>"` with the label "Lae alla: Juhend.pdf", the text "Lae alla", and the size "1 kB";
       - `[data-lesson-next]` "Järgmine õppetund" is `aria-disabled="true"` and not a link;
       - "Tagasi koolitusele" links to `/konto/kursus/veebikursus`.
    2. **The same with `lesson.done`:** "Õppetund tehtud ✓" (`role="status"`), and `[data-lesson-next]` is a link to `/konto/kursus/veebikursus/<next>`.
    3. **`next: null` and done:** no `[data-lesson-next]`.
    4. **A text lesson (`textOnly: true`, `video: null`), not done:**
       - "Märgi tehtuks" stands in the button slot and there is no "Järgmine õppetund";
       - a click POSTs `/api/konto/kursus/veebikursus/7/tehtud`;
       - the answer `{ ok: true, done: true, next: 8 }` shows "Õppetund tehtud ✓" and "Järgmine õppetund" linking to lesson 8, and the focus moves to the done line;
       - a 500 answer shows "Ei õnnestunud salvestada. Proovi uuesti." (`role="alert"`) and keeps the button.
    5. **A video lesson whose video is not ready (`textOnly: false`, `video: { state: "soon" }`), not done:**
       - "Video lisandub peagi", no player;
       - the button slot is empty: no "Märgi tehtuks" and no `[data-lesson-next]`;
       - only the quiet "Tagasi koolitusele" link.
       The same view with `lesson.done: true` (done before, e.g. the video is being set up again) shows "Õppetund tehtud ✓" and the "Järgmine õppetund" link.
    6. **A 403 `{ ok: false, error: "locked", next: 5 }`:** a notice titled "Avaneb, kui eelmine õppetund on tehtud." with a link "Jätka" to `/konto/kursus/veebikursus/5`. With `next: null` the link is "Tagasi koolitusele" to the course page.
    7. **A 403 `{ ok: false, error: "terms" }`:** `location.replace` is called with `/konto/kursus/veebikursus` (stub `window.location.replace`).
    8. **A 404:** "Seda õppetundi ei leitud." with "Tagasi koolitusele".
    9. **RU:** "Следующий урок", "Скачать".

- [ ] **Step 2: Run them — expect FAIL.**

- [ ] **Step 3: Routing.** In `src/lib/site-routing.ts`:

```ts
import { parseRowId } from "./row-id";

/** One lesson of an e-course in the account (phase 3a): /konto/kursus/<slug>/<lesson id>; the id is checked by parseRowId (lib/row-id.ts). */
const LESSON_PAGE = /^\/konto\/kursus\/[a-z0-9]+(?:-[a-z0-9]+)*\/([1-9][0-9]{0,9})$/;

/** Is `rest` (a page without its locale) one lesson's address, with an id the database can hold (≤ 2 147 483 647)? */
const isLessonPage = (rest: string): boolean => {
  const m = LESSON_PAGE.exec(rest);
  return m !== null && parseRowId(m[1]) !== null;
};
```

  `isKnownPage` also accepts `isLessonPage(rest)`. `ACCOUNT_SHELL` already covers the path, so a query on it gets the 303 into the fragment. Extend the `STATIC_PAGES` comment. In `tests/unit/site-routing.test.ts` (step 1) also expect `/et/konto/kursus/x/2147483648` to be unknown, and `/et/konto/kursus/x/2147483647` known.

- [ ] **Step 4: `formatSize`** in `src/i18n/format.ts`:

```ts
/** A file's size for people: "820 kB" under a megabyte (at least 1), else "1,4 MB" (one decimal); Russian units in Russian. */
export function formatSize(bytes: number, l: Locale): string {
  const number = (n: number, digits: number) => new Intl.NumberFormat(l === "ru" ? "ru-RU" : "et-EE", { maximumFractionDigits: digits }).format(n);
  const [kb, mb] = l === "ru" ? ["КБ", "МБ"] : ["kB", "MB"];
  return bytes < 1_000_000 ? `${number(Math.max(1, Math.round(bytes / 1000)), 0)} ${kb}` : `${number(bytes / 1_000_000, 1)} ${mb}`;
}
```

  In `components/admin/LessonFiles.tsx`, replace Task 5's temporary size text with `formatSize(size, "et")`.

- [ ] **Step 5: The texts.**
  - In `et.ts`, `account.ecourse` gains (next to `resume` and `lockedHint` from Task 8):

```ts
      begin: "Alusta",
      progress: "{done} / {total} õppetundi tehtud",
      stateDone: "Tehtud",
      stateCurrent: "Avatud",
```

  - In `ru.ts`:

```ts
      begin: "Начать",
      progress: "Пройдено уроков: {done} / {total}",
      stateDone: "Пройден",
      stateCurrent: "Открыт",
```

  - Extend the `account.ecourse` comment in `et.ts`: the course page's one button "Jätka" ("Alusta" before the first lesson), the lesson states as icons with these labels for screen readers, and the lock sentence under the first locked lesson.

- [ ] **Step 6: `useAccount` and `AccountLoader`.**
  - **In `useAccount.ts`:**
    - `export type AccountState = "loading" | "ready" | "signedOut" | "replaced" | "notFound" | "forbidden" | "error";`
    - `export type Refusal = { error: string; next: number | null };`
    - `Loaded<T>` gains `refusal?: Refusal | null`.
    - The options gain `forbidden?: boolean` (`const wantsForbidden = options.forbidden === true;`, added to the effect's dependencies).
    - After the 404 branch:

```ts
      if (res.status === 403 && wantsForbidden && isObject && (body as { ok?: unknown }).ok === false && typeof (body as { error?: unknown }).error === "string") {
        const { error, next } = body as { error: string; next?: unknown };
        setLoaded({ state: "forbidden", data: null, refusal: { error, next: typeof next === "number" ? next : null } });
        return settle(n, true);
      }
```

    - The hook returns `refusal: loaded.refusal ?? null` too.
    - Extend its doc comment: a 403 with the API's JSON, asked for with `forbidden: true` (a locked lesson, terms not accepted), is "forbidden" with the API's reason and `next`.
  - **`AccountLoader`** gains the prop `forbidden?: (refusal: Refusal) => React.ReactNode`. It passes `forbidden: forbidden !== undefined` to `useAccount`, and renders `if (state === "forbidden" && forbidden && refusal) return forbidden(refusal);` before the error branch.

- [ ] **Step 7: Rebuild `EcourseView.tsx`** (add `"use client"` at the top, because the admin's read-only page renders it from a server component, Task 10). The markup is binding (the tests read these attributes):
  - **The wrapper** `<div className={`${ui.wrap} ${page.page}`} data-ecourse="">`, with:
    - `<h1>` (focus as today);
    - `[data-ecourse-access]` (as today).
  - **When `progress.total > 0`:**
    - `<p data-ecourse-progress>{fill(t.progress, { done, total })}</p>`;
    - `<div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={that text}><span style={{ width: `${(done / total) * 100}%` }} /></div>` — 4 px high, `var(--line)` track, `var(--ink)` fill, rounded;
    - when `progress.next !== null`: `<Link className={ui.btn} href={href(locale, `/konto/kursus/${slug}/${next}`)} data-ecourse-next="">{done === 0 ? t.begin : t.resume}<Icon name="arrow" /></Link>`. Read-only, it is a `<span className={ui.btn} aria-disabled="true" data-ecourse-next="">` with the same content.
  - **The modules** are `<ol className={styles.modules} data-modules="">`, the numbered look of `ModuleList` (`CourseLists.module.css` `.modules`, `.num`, `.moduleTitle`). Each `<li data-module={m.id}>`:
    - **without lessons:** the number and title only;
    - **with lessons:** `<details open={wide || m.lessons.some((l) => l.id === progress.next)}>`. The summary holds the number, the title and `{doneInModule}/{m.lessons.length}`; it is ≥ 44 px tall and hides the marker with the site's look. Inside is `<ol className={styles.lessons}>` with one `<li data-lesson={l.id} data-state={l.state}>` per lesson:
      - the icon: `check` for done, `play` for current, `lock` for locked, `aria-hidden`;
      - the screen-reader label (`ui.srOnly`): `t.stateDone`, `t.stateCurrent` or `t.locked`;
      - the title: a `<Link href={href(locale, `/konto/kursus/${slug}/${l.id}`)}>` for done and current (a `<span aria-disabled="true">` when read-only), a plain `<span>` for locked;
      - under the **first** locked lesson of the course only: `<p className={styles.hint} data-locked-hint="">{t.lockedHint}</p>`.
    - `wide` is `useState(() => readOnly || (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches))`: on a phone only the module of the next lesson starts open, on a wider screen all of them do.
  - **When `progress.total === 0`:** `<p data-ecourse-soon>{t.soon}</p>`, as before.
  - **Look.** Rows ≥ 44 px, the site's tokens, no new colours. The lesson rows are indented under the module title, and on phones their titles wrap.

- [ ] **Step 8: Implement `LessonPage.tsx`** (`"use client"`):
  - **Loading.** It loads `/api/konto/kursus/${encodeURIComponent(slug)}/${lessonId}` through `<AccountLoader<LessonView>>` with:
    - the skeleton `<GreetingSkeleton />` (as `EcoursePage`);
    - `notFound`: a `Notice` titled `t.notFound` with a `ui.btn` link `t.back` to the course page;
    - `forbidden={(r) => r.error === "terms" ? <GoToCourse href={course} /> : <Notice title={t.lockedHint}>{link}</Notice>}`:
      - `GoToCourse` runs `window.location.replace(href)` in an effect and renders the waiting look;
      - the link is `ui.btn` `t.resume` to `/konto/kursus/<slug>/<r.next>` when `r.next !== null`, else `t.back` to the course page.
  - **`render(view)`**, inside `<div className={`${ui.wrap} ${styles.page}`} data-lesson-page={view.lesson.id}>`:
    1. `<p className={ui.eyebrow} data-lesson-module="">{pick(view.module.title, locale)}</p>` and `<h1>{pick(view.lesson.title, locale)}</h1>`.
    2. The video:
       - `video?.state === "ready"`: `<LessonPlayer slug lessonId title={pick(lesson.title)} video={video} watermark={view.watermark} done={done} t={t} onProgress={(a) => { if (a.done) setDone(true); setNext(a.next ?? next); }} />`;
       - `"soon"` (a video lesson whose video is not ready, or Bunny not set up): `<p className={styles.soon} data-lesson-soon="">{t.soon}</p>`;
       - `null` (a text lesson, `view.lesson.textOnly`): nothing.
    3. The short text: `paragraphs(pick(view.lesson.body, locale))` as `<p>`s (none when there is no body).
    4. The files, when there are any: `<section data-lesson-files>` with `<h2>{t.files}</h2>` and a list. Each item is `<a className={ui.btnOutline} href={`/api/konto/kursus/${encodeURIComponent(slug)}/${view.lesson.id}/fail/${f.id}`} aria-label={fill(t.downloadFile, { name: f.name })} data-lesson-file={f.id}>{t.download}</a>`, the name, and `formatSize(f.size, locale)`.
    5. The actions, `<div data-lesson-actions>`:
       - when `done`: `<p role="status" tabIndex={-1} data-lesson-done="">{t.done}</p>`;
       - the one button (the first rule that applies):
         - a text lesson (`view.lesson.textOnly`) not done → `<button className={ui.btn} data-mark-done="">{saving ? t.saving : t.markDone}</button>`. It POSTs `…/tehtud` (`credentials: "same-origin"`, an `aria-disabled` while it runs, no second press). On 200 it sets `done` and `next` and focuses `[data-lesson-done]`; otherwise it shows `<p role="alert">{t.failed}</p>`. "Märgi tehtuks" never shows on a video lesson.
         - a video lesson not done whose video is `"soon"` → nothing: the slot stays empty (nothing can complete it yet; only the quiet link below).
         - otherwise, when `next !== null` → when done `<Link className={ui.btn} href={href(locale, `/konto/kursus/${slug}/${next}`)} data-lesson-next="">{t.next}<Icon name="arrow" /></Link>`, else `<span className={ui.btn} aria-disabled="true" data-lesson-next="">{t.next}</span>`.
    6. `<Link className={ui.link} href={href(locale, `/konto/kursus/${slug}`)} data-lesson-back="">{t.back}</Link>`.
  - **State.** `done` and `next` start from the view and follow the player's and "Märgi tehtuks"'s answers.
  - **Look.** The page uses the e-course page's width and spacing (`EcoursePage.module.css`'s `.page`); the player spans the content width. At 390 px nothing overflows and every control is ≥ 44 px.

- [ ] **Step 9: The lesson shell** `app/[locale]/(site)/konto/kursus/[slug]/[lesson]/page.tsx`, the pattern of the e-course shell:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { LessonPage } from "@/components/account/LessonPage";
import { lessonTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";
import { parseRowId } from "@/lib/row-id";
import { isSlug } from "@/lib/slug";

type Props = { params: Promise<{ locale: string; slug: string; lesson: string }> };

/** Rendered on the first visit of a lesson's address and then cached, like the e-course shell (app/[locale]/layout.tsx). */
export function generateStaticParams(): { slug: string; lesson: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.shell.courses} — ${d.common.siteName}` };
}

/**
 * One lesson of an e-course in the account (phase 3a): a static shell, the same for every visitor of this address (no cookies,
 * headers or query read here, no database: the CDN serves it without a render, and nothing personal can enter its cache). The
 * browser loads the lesson from GET /api/konto/kursus/:slug/:lesson (LessonPage): the video, the text and the files, or the lock,
 * or a way to the terms notice. An address that cannot be a slug and a lesson id is a 404.
 */
export default async function LessonShellPage({ params }: Props) {
  const { locale, slug, lesson } = await params;
  const lessonId = parseRowId(lesson);
  if (!isLocale(locale) || !isSlug(slug) || lessonId === null) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <LessonPage slug={slug} lessonId={lessonId} locale={locale} t={lessonTexts(d)} />
    </AccountShell>
  );
}
```

- [ ] **Step 10: Run the unit tests** — expect PASS. Run `next build`: `/[locale]/konto/kursus/[slug]/[lesson]` must be listed as prerendered (● / ○), not ƒ.

- [ ] **Step 11: The e2e fixtures** `tests/e2e/lessons.ts`:

```ts
import { join } from "node:path";
import { localStore } from "../../src/server/media-local";
import { accountCourseSlug, onLocalDb } from "./fixtures";
import { E2E_BUNNY } from "./bunny-values";

/** The local database for rows no public page shows. */
const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

export type LessonCourse = { clientId: number; slug: string; lessons: { video: number; text: number; last: number }; fileId: number; fileName: string };

/** A small PDF the student downloads (the local store of the e2e run's server: app/.media-local). */
const PDF = new TextEncoder().encode("%PDF-1.4\n% e2e lesson file\n");

/**
 * A client with six months of access to an e-course of her own (`e2e-konto-<label>-<project>`, not published; removeClientRows deletes
 * it with its modules, lessons, files and progress), the terms of version "1" accepted (takeTerms sets that version):
 * - module "Alustame": lesson 1, a video lesson with a ready video of 125 s on the fake Bunny (any id: the fake's player checks only
 *   the token); lesson 2, a text lesson (kind 'text'), with the PDF "Juhend.pdf";
 * - module "Edasi": lesson 3, a text lesson.
 */
export async function insertLessonCourse(email: string, opts: { locale?: "et" | "ru" } = {}): Promise<LessonCourse> {
  const slug = accountCourseSlug(email);
  const key = `lessons/${crypto.randomUUID()}.pdf`;
  await localStore(join(process.cwd(), ".media-local")).put(key, PDF.buffer.slice(0) as ArrayBuffer, "application/pdf");
  return localDb(async (sql) => {
    const [client] = await sql<{ id: number }[]>`insert into clients (email, locale) values (${email}, ${opts.locale ?? "et"}) returning id`;
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price, access_months, published)
      values (${slug}, 'e_learning', 'basic', ${sql.json({ et: "E2E õppetunnid", ru: "E2E уроки" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`;
    const [m1] = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values (${course.id}, 1, ${sql.json({ et: "Alustame", ru: "Начинаем" })}) returning id`;
    const [m2] = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values (${course.id}, 2, ${sql.json({ et: "Edasi", ru: "Дальше" })}) returning id`;
    const [video] = await sql<{ id: number }[]>`
      insert into lessons (module_id, position, title, body, kind, video_id, video_status, duration_sec)
      values (${m1.id}, 1, ${sql.json({ et: "Esimene tund", ru: "Первый урок" })}, ${sql.json({ et: "Vaata video lõpuni." })}, 'video', ${crypto.randomUUID()}, 'ready', 125) returning id`;
    const [text] = await sql<{ id: number }[]>`
      insert into lessons (module_id, position, title, body, kind) values (${m1.id}, 2, ${sql.json({ et: "Teine tund" })}, ${sql.json({ et: "Loe juhend läbi.\n\nSiis märgi tehtuks." })}, 'text') returning id`;
    const [last] = await sql<{ id: number }[]>`insert into lessons (module_id, position, title, kind) values (${m2.id}, 1, ${sql.json({ et: "Kolmas tund" })}, 'text') returning id`;
    const [file] = await sql<{ id: number }[]>`
      insert into lesson_files (lesson_id, position, name, r2_key, size, content_type) values (${text.id}, 1, 'Juhend.pdf', ${key}, ${PDF.length}, 'application/pdf') returning id`;
    await sql`insert into course_access (client_id, course_id, granted_by, expires_at) values (${client.id}, ${course.id}, 'e2e', now() + interval '6 months')`;
    await sql`insert into terms_acceptances (client_id, course_id, terms_version) values (${client.id}, ${course.id}, '1')`;
    return { clientId: client.id, slug, lessons: { video: video.id, text: text.id, last: last.id }, fileId: file.id, fileName: "Juhend.pdf" };
  });
}

/** The fake Bunny's address (the player's frame comes from there). */
export const FAKE_PLAYER_ORIGIN = E2E_BUNNY.url;
```

- [ ] **Step 12: Write the e2e test** `tests/e2e/account-lessons.spec.ts` (desktop and phone; `submitsForms()`; skip unless `LOCAL_FIXTURES`).
  - **Setup.** Each test takes the terms with `takeTerms()` (version "1"; give it back in `finally`), uses `clientEmail("les-<label>", project)`, and calls `removeClientRows` before and after.
  - **Tests:**
    1. **The course.** Sign in (`signInAsClient`), open `/konto/kursus/<slug>`:
       - "0 / 3 õppetundi tehtud" and "Alusta" linking to lesson 1;
       - lesson 1 `data-state="current"`, lessons 2 and 3 `locked`;
       - "Avaneb, kui eelmine õppetund on tehtud." once;
       - `/konto/kursus/<slug>/<text>` shows that sentence as a notice with "Jätka" linking to lesson 1.
    2. **The player and the watermark.** Open lesson 1:
       - the `iframe` comes from `http://localhost:3998/embed/…`;
       - `[data-watermark]` reads the e-mail;
       - "Järgmine õppetund" is `aria-disabled`.
       Then click "Mängi lõpuni" (`page.frameLocator("[data-player] iframe").getByRole("button", { name: "Mängi lõpuni" })`):
       - "Õppetund tehtud ✓" appears and "Järgmine õppetund" becomes a link;
       - follow it → lesson 2's page; back on the course page "1 / 3 õppetundi tehtud" and "Jätka".
    3. **The text lesson and the file.** With lesson 1 done by SQL (`insert into lesson_progress … done_at now()`), open lesson 2:
       - "Juhend.pdf" with "Lae alla" → `page.waitForEvent("download")` gives the suggested name "Juhend.pdf";
       - a `request.get` of the file URL **without** the cookie answers 401;
       - the same URL with another signed-in client's cookies (a second context) answers 404;
       - "Märgi tehtuks" → "Õppetund tehtud ✓" → "Järgmine õppetund" to lesson 3.
    3a. **A video lesson whose video is not uploaded yet blocks the course.** Set lesson 1 to `video_status = 'none', video_id = null, duration_sec = null` by SQL, then open lesson 1:
       - "Video lisandub peagi", no `iframe`, no "Märgi tehtuks", no `[data-lesson-next]`; only "Tagasi koolitusele";
       - `page.request.post` of `…/<video>/progress` with `{ watchedSec: 1 }` and of `…/<video>/tehtud` both answer 409 `{ ok: false, error: "video" }`;
       - lesson 2's address shows the lock notice, and the course page still says "0 / 3 õppetundi tehtud" with lesson 2 `locked`.
    4. **Phone (390 px).**
       - Module "Alustame" (with the current lesson) is open and "Edasi" closed; tapping its summary opens it.
       - No horizontal overflow; every visible control ≥ 44 px: `expect(await smallTargets(page.locator("main"))).toEqual([])` (`import { smallTargets } from "./targets"`) on the course page and on a lesson page.
       - The fullscreen button of the player puts the wrapper over the page (`[data-expanded]` or `document.fullscreenElement`), with the watermark still inside it.
    5. **RU.** `/ru/konto/kursus/<slug>` shows "Пройдено уроков: 0 / 3" and "Начать".
  - **`tests/e2e/account-ecourse.spec.ts`.** Update the course-view test: the own course has two modules and no lessons, so assert `[data-module]` count = `c.modules.length` with their titles, `[data-ecourse-soon]` "Sisu lisandub peagi.", and no `[data-ecourse-progress]` or `[data-ecourse-next]`. Drop the `[data-modules] [data-locked]` assertions.
  - **`tests/e2e/cache.spec.ts`.** Add `${ECOURSE_SHELL}/1` and `/ru${ECOURSE_SHELL}/1` to `ACCOUNT_SHELLS`, and update the comment above it: the lesson shell, rendered on its first visit and then cached per address.

- [ ] **Step 13: Run** `npx vitest run`, `tsc`, lint, and `next build` (check the lesson route is prerendered). Then run `npx playwright test account-lessons account-ecourse` under `next dev`, `E2E_PROD_BUILD=1 npx playwright test cache account-lessons`, and the whole e2e suite.

- [ ] **Step 14: Commit.**

```bash
git add app/src app/tests
git commit -m "feat(learning): e-course progress and lesson states, the lesson page, Jätka, lesson shell routing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Admin Õpilased — progress, "Ava järgmine õppetund", the read-only course view

Spec section 4 ("Student panel"):
- per e-course in the student's drawer, "5/24 tehtud";
- the button "Ava järgmine õppetund", which records the admin as `unlocked_by` on the first locked lesson, with the inline confirm pattern;
- "Vaata tema vaadet" for that course: the student's course page with its lesson states, read-only.

**Files:**
- Modify: `app/src/server/admin-clients.ts` (`ClientAccessRow.progress`, `nextLocked`; `unlockNext`, `unlockNextForm`, `clientViewInfo`), `app/src/server/actions/admin-clients.ts` (`unlockNextLesson`)
- Modify: `app/src/components/admin/ClientDrawer.tsx` (the access row), `app/src/components/admin/ClientForms.tsx` (`UnlockNextLesson`), `app/src/i18n/dict/admin.ts`
- Create: `app/src/app/admin/(panel)/opilased/[id]/vaade/[slug]/page.tsx`
- Test: `app/tests/db/admin-progress.test.ts` (new), `app/tests/unit/admin-guards.test.ts`, `app/tests/e2e/admin-clients.spec.ts` (extend)

**Interfaces:**
- Consumes: `courseOutline` (Task 7); `lessonProgress` (Task 1); `loadEcourse`, `EcourseView` (Task 7); `EcourseView` component with `readOnly` (Task 9); `parseRowId(raw: string): number | null` (`src/lib/row-id.ts`, Task 5); `smallTargets` (`tests/e2e/targets.ts`, Task 5); `AccountShell` with `readOnly` / `banner`; `ecourseTexts`, `shellTexts`; `requireAdmin`, `adminAction`.
- Produces, from `admin-clients.ts`:
  - `ClientAccessRow` gains `progress: { done: number; total: number }` and `nextLocked: { id: number; title: I18n } | null`;
  - `unlockNext(db: Db, input: { clientId: number; courseId: number; lessonId: number; by: string; now: Date }): Promise<ClientResult>`;
  - `unlockNextForm(db: Db, formData: FormData, by: string, now: Date): Promise<ClientResult>` (fields `clientId`, `courseId`, `lessonId`);
  - `clientViewInfo(db: Db, id: number): Promise<{ label: string; locale: "et" | "ru" } | null>`.
- Produces, from `actions/admin-clients.ts`: `unlockNextLesson(prev: ClientResult | null, formData: FormData): Promise<ClientResult>`.
- Produces the page `/admin/opilased/<id>/vaade/<slug>`.

- [ ] **Step 1: Write the failing DB test** `tests/db/admin-progress.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseAccess, courseModules, courses, lessonProgress, lessons } from "@/db/schema";
import { clientDetail, clientViewInfo, unlockNext, unlockNextForm } from "@/server/admin-clients";
import { makeTestDb } from "./helpers";

const NOW = new Date("2026-10-06T10:00:00Z");
let db: Db;
let w: Awaited<ReturnType<typeof world>>;

/** A student with access to an e-course of three lessons (the first done), and a contact course. */
async function world() {
  const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
  const [course] = await db.insert(courses).values({ ...base, slug: "veeb", type: "e_learning", title: { et: "Veeb" } }).returning();
  const [contact] = await db.insert(courses).values({ ...base, slug: "kontakt", type: "contact", title: { et: "Kontakt" } }).returning();
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "M" } }).returning();
  const [l1] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Üks" } }).returning();
  const [l2] = await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "Kaks" } }).returning();
  const [l3] = await db.insert(lessons).values({ moduleId: m.id, position: 3, title: { et: "Kolm" } }).returning();
  const [client] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati", locale: "ru" }).returning();
  await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 86_400_000) });
  await db.insert(lessonProgress).values({ clientId: client.id, lessonId: l1.id, watchedSec: 100, doneAt: NOW });
  return { course, contact, l1, l2, l3, client };
}

beforeEach(async () => {
  db = await makeTestDb();
  w = await world();
});

const unlock = (over: Partial<Parameters<typeof unlockNext>[1]> = {}) =>
  unlockNext(db, { clientId: w.client.id, courseId: w.course.id, lessonId: w.l3.id, by: "admin@example.test", now: NOW, ...over });

test("the drawer: done of total per e-course, and its first locked lesson", async () => {
  const detail = await clientDetail(db, w.client.id, NOW);
  expect(detail!.access[0]).toMatchObject({ courseId: w.course.id, progress: { done: 1, total: 3 }, nextLocked: { id: w.l3.id, title: { et: "Kolm" } } });
});

test("“Ava järgmine õppetund” opens exactly that lesson (unlocked_by = the admin); then nothing is locked", async () => {
  expect(await unlock()).toEqual({ ok: true });
  const [p] = await db.select().from(lessonProgress).where(and(eq(lessonProgress.clientId, w.client.id), eq(lessonProgress.lessonId, w.l3.id)));
  expect([p.unlockedBy, p.doneAt, p.watchedSec]).toEqual(["admin@example.test", null, 0]);
  expect((await clientDetail(db, w.client.id, NOW))!.access[0].nextLocked).toBeNull();
});

test("a lesson that is open by now changes nothing; unknown lesson or student: notFound; a contact course: course; bad fields: invalid", async () => {
  expect(await unlock({ lessonId: w.l2.id })).toEqual({ ok: true });
  expect(await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, w.l2.id))).toHaveLength(0);
  expect(await unlock({ lessonId: 999999 })).toEqual({ ok: false, error: "notFound" });
  expect(await unlock({ clientId: 999999 })).toEqual({ ok: false, error: "notFound" });
  expect(await unlock({ courseId: w.contact.id })).toEqual({ ok: false, error: "course" });
  const fd = new FormData();
  fd.set("clientId", String(w.client.id));
  fd.set("courseId", "x");
  fd.set("lessonId", String(w.l3.id));
  expect(await unlockNextForm(db, fd, "admin@example.test", NOW)).toEqual({ ok: false, error: "invalid" });
});

test("the read-only course view's banner name and language", async () => {
  expect(await clientViewInfo(db, w.client.id)).toEqual({ label: "Kati", locale: "ru" });
  expect(await clientViewInfo(db, 999999)).toBeNull();
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** in `src/server/admin-clients.ts` (import `lessonProgress` and `courseOutline` from `./lesson-outline`):
  - `ClientAccessRow` gains `progress: { done: number; total: number }; nextLocked: { id: number; title: I18n } | null;`.
  - In `clientDetail`, after the `Promise.all`:

```ts
  // each e-course's lessons for her: done of total, and the first lesson she cannot open yet ("Ava järgmine õppetund")
  const outlines = await Promise.all(access.map((a) => courseOutline(db, a.courseId, id)));
```

    The returned `access` becomes:

```ts
    access: access.map((a, i) => {
      const locked = outlines[i].lessons.find((l) => l.state === "locked");
      return { ...a, state: accessState(a, now), progress: { done: outlines[i].progress.done, total: outlines[i].progress.total }, nextLocked: locked ? { id: locked.id, title: locked.title } : null };
    }),
```

  - Add:

```ts
/**
 * "Ava järgmine õppetund" (spec 3a section 4): opens one lesson the student cannot open yet — the drawer's first locked lesson of that
 * e-course, sent back as `lessonId` — by recording the admin on her progress row (lesson_progress.unlocked_by). Only that lesson
 * opens, not the ones after it. A lesson that is open or done by now changes nothing (ok). notFound: no such student, or not a
 * visible lesson of the course; course: not an e-course.
 */
export async function unlockNext(db: Db, input: { clientId: number; courseId: number; lessonId: number; by: string; now: Date }): Promise<ClientResult> {
  const [[client], [course]] = await Promise.all([
    db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.clientId)).limit(1),
    db.select({ type: courses.type }).from(courses).where(eq(courses.id, input.courseId)).limit(1),
  ]);
  if (!client) return fail("notFound");
  if (course?.type !== "e_learning") return fail("course");
  const target = (await courseOutline(db, input.courseId, input.clientId)).lessons.find((l) => l.id === input.lessonId);
  if (!target) return fail("notFound");
  if (target.state !== "locked") return { ok: true };
  await db
    .insert(lessonProgress)
    .values({ clientId: input.clientId, lessonId: input.lessonId, unlockedBy: input.by, updatedAt: input.now })
    .onConflictDoUpdate({ target: [lessonProgress.clientId, lessonProgress.lessonId], set: { unlockedBy: input.by, updatedAt: input.now } });
  return { ok: true };
}

/** Fields: clientId, courseId, lessonId. `by`: the signed-in admin's e-mail. */
export async function unlockNextForm(db: Db, formData: FormData, by: string, now: Date): Promise<ClientResult> {
  const clientId = idSchema.safeParse(field(formData, "clientId"));
  const courseId = idSchema.safeParse(field(formData, "courseId"));
  const lessonId = idSchema.safeParse(field(formData, "lessonId"));
  if (!clientId.success || !courseId.success || !lessonId.success) return fail("invalid");
  return unlockNext(db, { clientId: clientId.data, courseId: courseId.data, lessonId: lessonId.data, by, now });
}

/** A student's name for the read-only course view's banner (as clientLabel) and her language (the page's), or null. */
export async function clientViewInfo(db: Db, id: number): Promise<{ label: string; locale: "et" | "ru" } | null> {
  const [row] = await db.select({ email: clients.email, name: NAME, locale: clients.locale }).from(clients).where(eq(clients.id, id)).limit(1);
  return row ? { label: row.name.trim() || row.email, locale: row.locale } : null;
}
```

  - **In `actions/admin-clients.ts`** (import `unlockNextForm`):

```ts
/** Drawer, "Ava järgmine õppetund" (after its confirmation): fields clientId, courseId, lessonId. The admin's e-mail is recorded. */
export const unlockNextLesson = adminAction(async ({ email }, _prev: ClientResult | null, formData: FormData) =>
  run("unlock lesson", (db) => unlockNextForm(db, formData, email, new Date())),
);
```

  - **In `tests/unit/admin-guards.test.ts`:** `clientExports` becomes `["addStudent", "grantCourseAccess", "revokeCourseAccess", "unlockNextLesson"]`. Add `"app/admin/(panel)/opilased/[id]/vaade/[slug]/page.tsx"` to the first test's list.

- [ ] **Step 4: Run** the DB and guard tests — expect PASS.

- [ ] **Step 5: The texts** in `src/i18n/dict/admin.ts`:
  - `clients.drawer` gains `progress: "{done}/{total} tehtud"`, `viewCourse: "Vaata tema vaadet"` and `viewCourseLabel: "Vaata tema vaadet: {course}"`.
  - Add `clients.unlock`:

```ts
    unlock: {
      button: "Ava järgmine õppetund",
      confirm: "Kas avan õpilasele õppetunni „{lesson}“? Ta saab selle kohe vaadata.",
      yes: "Jah, ava",
      no: "Ei",
      done: "Õppetund „{lesson}“ on avatud.",
    },
```

  - `viewAs` gains `courseTitle: "Õpilase vaade: e-koolitus"`.

- [ ] **Step 6: The drawer and the view.**
  - **`ClientDetailView`.** In each access row, after the state tag and when `a.progress.total > 0`:
    - `<p className={styles.meta} data-access-progress="">{fill(t.progress, a.progress)}</p>`;
    - only when `a.state === "active"` (the view page answers 404 without active access, as her own page does): `<Link className={ui.link} href={`/admin/opilased/${c.id}/vaade/${a.slug}`} aria-label={fill(t.viewCourseLabel, { course: title })} data-view-course={a.courseId}>{t.viewCourse}</Link>`;
    - when `a.state === "active" && a.nextLocked`: `<UnlockNextLesson clientId={c.id} courseId={a.courseId} lesson={{ id: a.nextLocked.id, title: pick(a.nextLocked.title, "et") }} t={{ ...adminEt.clients.unlock, saving: adminEt.common.saving, error: adminEt.common.saveError }} />`.
  - **`UnlockNextLesson`** in `ClientForms.tsx` follows `RevokeAccess` exactly:
    - a `ui.btn ui.secondary ui.smallBtn` button `t.button` (`data-unlock-next`);
    - the confirm step `fill(t.confirm, { lesson: lesson.title })` with `t.yes` / `t.no` (the question takes the focus; "Ei" returns it to the opener);
    - the form posts hidden `clientId`, `courseId` and `lessonId` to `unlockNextLesson`;
    - after an ok answer: a `role="status"` line `fill(t.done, { lesson: <the title it opened> })`, kept in local state because the page refresh moves `nextLocked` on;
    - after an error: `t.error` (`role="alert"`).
  - **The page `app/admin/(panel)/opilased/[id]/vaade/[slug]/page.tsx`.** It follows the existing `vaade/page.tsx`:
    - `export const dynamic = "force-dynamic"`; metadata title `adminTitle(adminEt.viewAs.courseTitle)`;
    - `const email = await requireAdmin()`; the id is parsed with `parseRowId` (`src/lib/row-id.ts`, Task 5) and the slug must pass `isSlug`, else `notFound()`;
    - `const [data, info] = await Promise.all([loadEcourse(getDb(), id, slug, now), clientViewInfo(getDb(), id)])`; a missing one → `notFound()` (no active access is a 404 too, as for her);
    - it renders `<Shell email={email} active="clients">` with the back link to `/admin/opilased?id=${id}` (`adminEt.viewAs.back` / `backLabel`), and `<div className={view.preview} lang={info.locale} data-view-as={id}>` (import `view` from `../view.module.css`);
    - inside that, `<AccountShell tab="courses" locale={info.locale} t={shellTexts(d)} readOnly banner={<span lang="et">{fill(adminEt.viewAs.banner, { nimi: info.label })}</span>}>`, wrapping `<EcourseView data={data} locale={info.locale} t={ecourseTexts(d)} readOnly />`;
    - the terms notice is not shown: the admin looks at the course, and nothing is accepted;
    - no client session is read, made or ended.

- [ ] **Step 7: Extend the e2e** `tests/e2e/admin-clients.spec.ts` with one test (desktop). Take the terms with `takeTerms()`. The student comes from `insertLessonCourse(clientEmail("adm-prog", project))` (`tests/e2e/lessons.ts`), with lesson 1 done by SQL.
  1. The admin opens her drawer → the e-course row reads "1/3 tehtud".
  2. "Ava järgmine õppetund" → "Kas avan õpilasele õppetunni „Kolmas tund“? Ta saab selle kohe vaadata." → "Jah, ava" → "Õppetund „Kolmas tund“ on avatud.". The `lesson_progress` row of lesson 3 has `unlocked_by` = the admin's address.
  3. In the student's own browser (`studentBrowser`), `/konto/kursus/<slug>` shows lesson 3 `data-state="current"`.
  4. In the drawer, "Vaata tema vaadet" for the course → the read-only course: the banner, "1 / 3 õppetundi tehtud", the states, no link inside `[data-ecourse]`, the button `aria-disabled`. Afterwards the student's session still works (her next `/api/konto/me` is 200).
  5. "Lõpeta ligipääs" on that course → the row still reads "1/3 tehtud", but `[data-view-course]` and "Ava järgmine õppetund" are gone from it.
  6. At 1440 and 390 px, the access row's controls are ≥ 44 px (`smallTargets` from `tests/e2e/targets.ts`).

- [ ] **Step 8: Run** unit + DB, `tsc`, lint, `npx playwright test admin-clients` (dev and `E2E_PROD_BUILD=1`), the whole e2e suite, and `next build`.

- [ ] **Step 9: Commit.**

```bash
git add app/src app/tests
git commit -m "feat(admin): lesson progress in Õpilased, Ava järgmine õppetund, read-only course view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The daily sweep of stuck uploads, and the docs

Spec sections 7, 8 and 10. The daily cron also gives up Bunny uploads stuck for more than 24 h. `docs/deploy.md` gets the Bunny library setup Dim follows, the new variables and the new log line. `docs/launch-checklist.md` gets the 3a items.

**Files:**
- Modify: `app/src/app/api/cron/sweep/route.ts`, `docs/deploy.md`, `docs/launch-checklist.md`
- Test: `app/tests/db/cron-sweep.test.ts`

**Interfaces:**
- Consumes: `sweepStuckUploads(db, api, now)` (Task 6), `bunnyConfig`, `bunnyApi` (Task 3).
- Produces: the cron's answer `{ ok: true, deleted, logins, sessions, mailDays, uploads }` and the log line `[cron] sweep: N expired kv entries, N login codes, N sessions, N mail counters, N stuck video uploads deleted`.

- [ ] **Step 1: Write the failing test.**
  - In `tests/db/cron-sweep.test.ts`, every expected answer gains `uploads: 0`. Add:

```ts
  test("with Bunny set up, an upload stuck for more than a day is deleted from Bunny and the lesson has no video again (uploads: 1)", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("BUNNY_LIBRARY_ID", "12345");
    vi.stubEnv("BUNNY_API_KEY", "test-api-key");
    vi.stubEnv("BUNNY_TOKEN_KEY", "test-token-key");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = stubFetch(() => Response.json({ success: true }));
    const [course] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "V" }, summary: { et: "" }, body: { et: "" } }).returning();
    const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "M" } }).returning();
    const stuck = "11111111-2222-4333-8444-555555555555";
    const [l] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "L" }, videoId: stuck, videoStatus: "uploading", videoStartedAt: new Date(Date.now() - 25 * 3600_000) }).returning();
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, deleted: 1, logins: 0, sessions: 0, mailDays: 0, uploads: 1 });
    expect(f.calls.map((c) => [c.method, c.url])).toEqual([["DELETE", `https://video.bunnycdn.com/library/12345/videos/${stuck}`]]);
    expect((await db.select().from(lessons).where(eq(lessons.id, l.id)))[0]).toMatchObject({ videoId: null, videoStatus: "none" });
    expect(info).toHaveBeenCalledWith("[cron] sweep: 1 expired kv entries, 0 login codes, 0 sessions, 0 mail counters, 1 stuck video uploads deleted");
    f.restore();
  });
```

    (Import `courses`, `courseModules`, `lessons`, `stubFetch` and `eq`. `deleted: 1` is the expired kv row the file's `beforeEach` inserts.)
  - Update any test of this file that asserts the log line to the new wording.

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** in `src/app/api/cron/sweep/route.ts` (import `bunnyApi`, `bunnyConfig` from `@/server/bunny` and `sweepStuckUploads` from `@/server/lesson-videos`). Inside the `try`:

```ts
    const db = getDb();
    const now = new Date();
    const bunny = bunnyConfig();
    const [deleted, accounts, uploads] = await Promise.all([
      sweepExpired(db, now),
      sweepClientRows(db, now),
      bunny ? sweepStuckUploads(db, bunnyApi(bunny), now) : Promise.resolve(0),
    ]);
    console.info(
      `[cron] sweep: ${deleted} expired kv entries, ${accounts.logins} login codes, ${accounts.sessions} sessions, ${accounts.mailDays} mail counters, ${uploads} stuck video uploads deleted`,
    );
    return json(200, { ok: true, deleted, ...accounts, uploads });
```

  Extend the doc comment: Bunny uploads still "uploading" a day after they began are deleted from Bunny, and the lesson gets back its replaced video or has none (`lesson-videos.ts`); the count is `uploads`.

- [ ] **Step 4: Run** the test and the whole `npx vitest run` — expect PASS.

- [ ] **Step 5: `docs/deploy.md`.**
  1. **Section 2, the optional variables table.** Add:

| Name | What it is for |
|---|---|
| `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` | The lesson videos on Bunny Stream (section 10): the library's id, its API key and its embed token-authentication key. All three or none: without them the admin's video field says "Video seadistamata" and students see "Video lisandub peagi". The two keys are sensitive and never reach a browser. |
| `BUNNY_WEBHOOK_SECRET` | The query secret of Bunny's webhook URL (`/api/bunny/webhook?secret=…`). Optional (the webhook only triggers a status read from Bunny's API), but set it. Sensitive. |

     "Local only, never on Vercel" gains `BUNNY_FAKE_URL` (the e2e run's fake Bunny; ignored when `VERCEL` is set).
  2. **Section 5.** The log line becomes `[cron] sweep: N expired kv entries, N login codes, N sessions, N mail counters, N stuck video uploads deleted`. Describe the new part in one sentence.
  3. **Section 9** gains: "A student watching a lesson posts her progress about every 15 s (about 240 function calls an hour of video); 500 hours watched a month is about 120 000 calls."
  4. **A new section `## 10. Bunny Stream (lesson videos)`.** Write it as numbered steps for Dim (names as in bunny.net/docs on 05.10.2026; the dashboard may word them a little differently):
     1. bunny.net → Stream → **Add Video Library**: name `mslab`, an EU storage region, no extra replication.
     2. The library's **API** page: the **Video Library ID** → `BUNNY_LIBRARY_ID`; the **API Key** → `BUNNY_API_KEY`.
     3. **Security:**
        - **Embed view token authentication** on (API field `PlayerTokenAuthenticationEnabled`); its key → `BUNNY_TOKEN_KEY`. CDN token authentication is a separate setting: leave it as it is, because the iframe player uses the embed token.
        - **Allowed domains** (domain restriction; `AllowedReferrers`): `mslab.diipsolutions.eu`, and `mslab.ee` at the launch.
        - **Block direct URL file access** on.
        - **MP4 fallback** off (`EnableMP4Fallback`), so there is no downloadable MP4.
        - **Direct play** off (`AllowDirectPlay`).
        - Leave **early play** (`AllowEarlyPlay`), **JIT encoding** and **DRM** off: the app treats a video as ready at status 4 (Finished).
     4. **Webhook URL** of the library: `https://mslab.diipsolutions.eu/api/bunny/webhook?secret=<BUNNY_WEBHOOK_SECRET>`, where the secret is a long random string (`openssl rand -hex 32`). The URL with its secret ends up in Vercel's request logs; it only lets someone ask the app to re-read a video's status.
     5. Vercel → Settings → Environment Variables → **Production**: the three variables `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` (+ the optional `BUNNY_WEBHOOK_SECRET`; never `BUNNY_FAKE_URL`). They reach the site with the next deployment.
     6. Check after the deployment: admin → an e-course → a lesson → the video field offers "Vali video" (not "Video seadistamata").

     Then add:
     - **What the app uses:** the API `https://video.bunnycdn.com/library/<id>/videos`, tus `https://video.bunnycdn.com/tusupload` (straight from Maria's browser), and the player `https://player.mediadelivery.net/embed/<id>/<video>?token=…&expires=…`. The CDN hostname of the library is not needed (no thumbnails or direct files in 3a).
     - **Costs:** pay-as-you-go, about €5–15 a month at about 500 h (spec 8).
     - **Moving to Maria's Bunny account later:** a new library, new variables, and the videos uploaded again (or moved with Bunny's help). The `lessons.video_id` values then change.
- [ ] **Step 6: `docs/launch-checklist.md`.** Add `## 8. Phase 3a (lessons and video)`:

```
- [ ] Dim creates the Bunny Stream library and sets the three variables BUNNY_LIBRARY_ID, BUNNY_API_KEY, BUNNY_TOKEN_KEY (+ the optional BUNNY_WEBHOOK_SECRET) in Vercel (deploy.md §10) before the 3a deploy.
- [ ] mslab.ee launch: add mslab.ee to the Bunny library's allowed domains (deploy.md §10) and the webhook URL's host.
- [ ] Migration 0008 (drop courses.modules) after 3a has run without a rollback for a few days — code first, then the migration (plan 2026-10-05-phase3a, Task 12).
- [ ] Watch the Bunny bill monthly, and Vercel's function invocations (progress reports: about 240 an hour of watching).
- [ ] Accepted limits: iPhone's native video fullscreen shows no watermark; a student can fake progress (it only opens her own lessons).
- [ ] Bunny's embed host is player.mediadelivery.net (the old iframe.mediadelivery.net player goes in early 2027): nothing to do, noted.
```

- [ ] **Step 7: Commit.**

```bash
git add app/src/app/api/cron/sweep/route.ts app/tests/db/cron-sweep.test.ts docs/deploy.md docs/launch-checklist.md
git commit -m "feat(video): the daily sweep gives up stuck uploads; Bunny setup and launch items in the docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deploy, live checks and migration 0008 (controller)

Spec section 10. This task is run by the controller, not a subagent. It is the first that writes to Railway, pushes, or deploys.

**Files:**
- Modify: `tools/cache-smoke.mjs` (repo root). Add `/konto/kursus/kulmumeistri-e-koolitus/1` to part C's list of shells. Commit it on the branch before the merge.
- Later (step 11): `app/src/db/schema.ts`, `app/src/db/seed-data.ts`, `app/drizzle/0008_*.sql`.

- [ ] **Step 1 (read-only): Railway before.** Put the public TCP proxy URL in the shell only (`docs/deploy.md` section 6). Read:
  - `select count(*) from drizzle.__drizzle_migrations` → 3 (0000–0002);
  - `select to_regclass('public.course_modules')` → null;
  - `select coalesce(sum(jsonb_array_length(modules)), 0) from courses` → note the number (N).
  Print counts only.
- [ ] **Step 2: Branch checks.** Run, and record the outcome in the ledger (`.superpowers/sdd/2026-10-05-phase3a-lessons-video/progress.md`):
  - full `npx vitest run`, `tsc`, lint;
  - `next build`: `/[locale]/konto/kursus/[slug]/[lesson]` is prerendered;
  - e2e under `next dev` and with `E2E_PROD_BUILD=1`, and visual;
  - the `tools/cache-smoke.mjs` change committed.
- [ ] **Step 3: Bunny (Dim).** Dim creates the library and sets the three variables `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` (+ the optional `BUNNY_WEBHOOK_SECRET`, which Dim sets too) in Vercel Production, following `docs/deploy.md` section 10. Check with `vercel env ls production` that the names are there (no values printed).
- [ ] **Step 4: Migrations 0003 and 0004 on Railway.** Before it, Dim tells Maria (and himself) not to edit any course's modules or programme in the admin from now until step 7 is done. Migrate first, then deploy. 0003 and 0004 (video shape, Task 8b) are additive, so the live code is unaffected:
  1. `DATABASE_URL='…?sslmode=require' npm run db:migrate` (from `app/`).
  2. Check that `count(*)` of the migrations table is 5, and `select count(*) from course_modules` = N from step 1.
  3. Check that `select c.slug from courses c where c.modules <> coalesce((select jsonb_agg(m.title order by m.position, m.id) from course_modules m where m.course_id = c.id), '[]'::jsonb)` returns no rows.
- [ ] **Step 4b: Video shape check (Task 8b), after the first real upload in step 8.** Upload one short clip filmed upright on a phone. Read `select video_width, video_height from lessons where video_id = '<guid>'` and look at the player: an upright clip must give width < height and an upright frame. If it comes out 16:9 with an upright picture inside, Bunny already reports the rotated size: delete the quarter-turn swap in `shownSize` (`app/src/server/bunny.ts`) and the `bunny.test.ts` cases that pin it, then redeploy. Also confirm a ready video got a non-null shape (a null shape plays as 16:9).
- [ ] **Step 5: Deploy.** Merge `feat/phase3a-lessons` into `main` and push `main`: that push is the production deployment. Do not push the feature branch itself.
- [ ] **Step 6: READY.** Confirm the deployment is READY and holds the production alias (`vercel ls mslab` / `vercel inspect <url>`).
- [ ] **Step 7: The titles edited between steps 4 and 6.** Run this right after step 6 reports READY, and **before anyone opens the new "Moodulid ja õppetunnid" editor**: until it is done, Dim and Maria do not edit modules (step 4).
  1. Run the drift query of step 4 again. Each slug it lists had its module titles edited in the old editor during the window (spec 10).
  2. For each listed slug, copy that course's titles again with the block below (replace `<slug>`, both places). It is one statement, so it runs as one transaction: it raises, and changes nothing, if the course has any lesson. Only a course with no lessons is re-copied. A course that has lessons by then is left as it is; Dim compares its titles by hand.

```sql
do $$
declare
  cid integer;
begin
  select id into strict cid from courses where slug = '<slug>';
  if exists (select 1 from lessons l join course_modules m on m.id = l.module_id where m.course_id = cid) then
    raise exception 'course <slug> has lessons: module titles not re-copied';
  end if;
  delete from course_modules where course_id = cid;
  insert into course_modules (course_id, position, title)
  select c.id, m.ord::int, m.value
  from courses c
  cross join lateral jsonb_array_elements(case when jsonb_typeof(c.modules) = 'array' then c.modules else '[]'::jsonb end) with ordinality as m(value, ord)
  where c.id = cid;
end $$;
```

  3. Run the drift query once more: it must return no rows (except a course left by hand in 2).

- [ ] **Step 8: Read-only acceptance on https://mslab.diipsolutions.eu.**
  - `node tools/cache-smoke.mjs` passes parts A, B and C, the lesson shell included.
  - The remote read-only e2e + visual are green (`E2E_BASE_URL=… E2E_ALLOW_REMOTE=1`, 1–2 workers).
  - `curl -s -X POST 'https://mslab.diipsolutions.eu/api/bunny/webhook?secret=wrong' -d '{}'` → 401.
- [ ] **Step 9: Live check with a sample client.** Sign the sample client in as in phase 2a Task 11 step 7: a token row in Railway for a `*.naidis@example.test` address, then `/api/konto/verify?t=…`.
  1. **Admin setup.** In the admin, on the published sample e-course `kulmumeistri-e-koolitus`:
     - a module "Test 3a";
     - lesson A with **one real short video** (under a minute) → "Töötlemisel…" → "Valmis · m:ss";
     - lesson B, "Õppetunni liik" → "Tekst", with a small PDF.
     Grant the sample client access ("Ava ligipääs").
  2. **As the client:**
     - "Alusta" → lesson A plays from `player.mediadelivery.net` with a `token` and `expires`;
     - the watermark shows the address, faint, and moves after a minute;
     - "Täisekraan" keeps the watermark;
     - Bunny's own controls offer no download and no fullscreen;
     - the embed URL without its query, opened in a private window, is refused by Bunny.
  3. **Lock and progress:**
     - while lesson A's video is still "Töötlemisel…", lesson A shows "Video lisandub peagi" with no button and lesson B stays 🔒;
     - lesson B is 🔒 until lesson A is watched past 90 %, then "Õppetund tehtud ✓" and "Järgmine õppetund";
     - in lesson B, "Lae alla" downloads the PDF with its name (a 302 to R2), and "Märgi tehtuks" works;
     - "Asenda video" on lesson A: the old one plays until the new one is "Valmis", then it is gone from Bunny's library list.
  4. **Õpilased:** the drawer shows "2/2 tehtud"; the read-only course view matches.
  5. **Webhook:** the Vercel runtime logs show `POST /api/bunny/webhook` 200 during the upload.
  6. **Clean-up, by SQL and the admin:**
     - delete the sample client's `lesson_progress` rows (`delete from lesson_progress where client_id = …`);
     - in the admin delete lessons A and B ("Kustuta õppetund": it removes the Bunny videos and R2 files) and the module;
     - "Lõpeta ligipääs";
     - then delete the client's login tokens and the client row by SQL (phase 2a Task 11 step 7).
- [ ] **Step 10: Durations.** From the runtime logs, note the max and median duration of `/api/konto/kursus/*` (the lesson GET, `progress`, `fail`) in the ledger.
- [ ] **Step 11 (later — at least a few days after step 6, with no rollback planned): migration 0008 drops `courses.modules`.**
  - (Phase 2c took 0005, phase 2b 0006 and the protocols 0007 for their own additive migrations; the drop is 0008.)
  - **The order is code first, then the migration.** Drizzle names every column it knows in its selects; a live deployment still knowing `modules` would fail once the column is gone.
  1. A branch `chore/drop-courses-modules` from `main`:
     - remove `modules` (and its legacy comment) from `courses` in `src/db/schema.ts`;
     - in `src/db/seed-data.ts`, `SeedCourse` gains `modules?: I18n[]` explicitly (the seed's titles feed `course_modules`);
     - `tests/db/migration-0003.test.ts` needs no change: it stops at `0003_lessons` and touches `courses.modules` only by plain SQL.
  2. `npx drizzle-kit generate --name drop_course_modules`. The SQL must be exactly `ALTER TABLE "courses" DROP COLUMN "modules";`.
  3. Run `npx vitest run`, `tsc` and `next build`, and the e2e under `next dev`. Apply locally with `npm run db:migrate`.
  4. Merge into `main` and push (deploy). Wait for READY: the live code no longer knows the column.
  5. **Then** apply 0008 on Railway (`npm run db:migrate` with the Railway URL). Check that `select column_name from information_schema.columns where table_name = 'courses' and column_name = 'modules'` returns nothing, and that the migrations count is 9.
  6. Run `node tools/cache-smoke.mjs` again. Record the outcome in the ledger.
