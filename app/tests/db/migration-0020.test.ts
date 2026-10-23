import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courseModules, courses, lessonFiles, lessons } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0020 (admin UX pass, piece 3a, Task 2: B18, R-e, R-f, R-g) as the Railway database goes through it: 0000–0019 applied, with a
// published e-course, a module, a lesson and a lesson file in it, then 0020. It is four `ALTER TABLE … ADD COLUMN`s and nothing else:
//   course_modules.unpublished boolean not null default false  — a new module of a published course, hidden from students and the public until „Avalda muudatused“;
//   lessons.unpublished        boolean not null default false  — the same for a lesson;
//   lessons.video_progress     smallint null                   — Bunny's encode progress in percent, written while a video is processing;
//   lesson_files.removed_at    timestamptz null                — „Eemalda“ is a soft delete the UndoBar can undo; purged after 10 s or more.
// Every row keeps what it had (flags false, the other two null), so a student sees the same course before and after.

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const NEW_COLUMNS = [
  { table_name: "course_modules", column_name: "unpublished", data_type: "boolean", is_nullable: "NO", column_default: "false" },
  { table_name: "lesson_files", column_name: "removed_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
  { table_name: "lessons", column_name: "unpublished", data_type: "boolean", is_nullable: "NO", column_default: "false" },
  { table_name: "lessons", column_name: "video_progress", data_type: "smallint", is_nullable: "YES", column_default: null },
];
const isNew = (c: Column) => NEW_COLUMNS.some((n) => n.table_name === c.table_name && n.column_name === c.column_name);

test("0020 adds exactly four columns (two flags default false, video_progress and removed_at null), keeps every row as it was, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0019_payments_replaced");
  // (raw SQL for the three tables 0020 changes: the schema's tables already have the columns this migration adds)
  const [course] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "Veeb" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500 }).returning();
  await db.execute(sql`insert into course_modules (course_id, position, title) values (${course.id}, 1, '{"et":"Algus"}'::jsonb)`);
  await db.execute(sql`insert into lessons (module_id, position, title, hidden, video_id, video_status, duration_sec) select id, 1, '{"et":"Esimene"}'::jsonb, true, 'vid-1', 'processing', 120 from course_modules`);
  await db.execute(sql`insert into lesson_files (lesson_id, position, name, r2_key, size, content_type) select id, 1, 'Juhend.pdf', 'lessons/a.pdf', 5, 'application/pdf' from lessons`);

  const columns = async () =>
    (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows;
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  // (keys, foreign keys, checks and unique constraints; not the NOT NULLs, which newer Postgres lists here too: the columns' is_nullable says them)
  const constraints = async () => (await db.execute<{ conname: string }>(sql`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by conname`)).rows;
  const rowsOf = async (table: "course_modules" | "lessons" | "lesson_files") => (await db.execute<Record<string, unknown>>(sql.raw(`select * from ${table} order by id`))).rows;

  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), constraints: await constraints(), modules: await rowsOf("course_modules"), lessons: await rowsOf("lessons"), files: await rowsOf("lesson_files") };
  expect(before.columns.filter(isNew)).toEqual([]);
  expect([before.modules.length, before.lessons.length, before.files.length]).toEqual([1, 1, 1]);

  await through("0020_course_drafts");

  // the shape: the four columns, as they are described above; no table, index or constraint changed, no other column changed
  const after = await columns();
  expect(after.filter(isNew)).toEqual(NEW_COLUMNS);
  expect(after.filter((c) => !isNew(c))).toEqual(before.columns);
  expect(await tables()).toEqual(before.tables);
  expect(await indexes()).toEqual(before.indexes);
  expect(await constraints()).toEqual(before.constraints);

  // every row is what it was, with the flags false and the other two null
  const same = (rows: Record<string, unknown>[], extra: Record<string, unknown>) => rows.map((r) => ({ ...r, ...extra }));
  expect(await rowsOf("course_modules")).toEqual(same(before.modules, { unpublished: false }));
  expect(await rowsOf("lessons")).toEqual(same(before.lessons, { unpublished: false, video_progress: null }));
  expect(await rowsOf("lesson_files")).toEqual(same(before.files, { removed_at: null }));

  // the new columns work through the schema: defaults on an insert that does not name them, and the values stored when it does
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 2, title: { et: "Uus" } }).returning();
  expect(m.unpublished).toBe(false);
  const [hiddenModule] = await db.insert(courseModules).values({ courseId: course.id, position: 3, title: { et: "Peidus" }, unpublished: true }).returning();
  expect(hiddenModule.unpublished).toBe(true);
  const [l] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Uus" } }).returning();
  expect([l.unpublished, l.videoProgress]).toEqual([false, null]);
  const [progress] = await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "Kodeerimisel" }, unpublished: true, videoStatus: "processing", videoProgress: 42 }).returning();
  expect([progress.unpublished, progress.videoProgress]).toEqual([true, 42]);
  const removedAt = new Date("2026-10-23T09:00:00Z");
  const [f] = await db.insert(lessonFiles).values({ lessonId: l.id, position: 1, name: "b.pdf", r2Key: "lessons/b.pdf", size: 1, contentType: "application/pdf", removedAt }).returning();
  expect(f.removedAt).toEqual(removedAt);
});
