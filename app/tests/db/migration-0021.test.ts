import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses, reviews } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0021 (admin UX pass, piece 4c, Task 1: spec §7, R-b) as the Railway database goes through it: 0000–0020 applied, with a published course
// and three reviews of it (a student's waiting, a student's published and on the home page, and one Maria added), then 0021. It is one
// `ALTER TABLE … ADD COLUMN` and nothing else:
//   reviews.removed_at  timestamptz null  — „Kustuta“ on a review Maria added is a soft delete the UndoBar can undo; purged after 10 s or more.
// Every row keeps what it had (removed_at null), so every page shows the same reviews before and after.

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const NEW_COLUMNS = [{ table_name: "reviews", column_name: "removed_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }];
const isNew = (c: Column) => NEW_COLUMNS.some((n) => n.table_name === c.table_name && n.column_name === c.column_name);

test("0021 adds exactly one column (reviews.removed_at, null), keeps every row as it was, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0020_course_drafts");
  // (raw SQL for the reviews: the schema's table already has the column this migration adds)
  const [course] = await db.insert(courses).values({ slug: "kulmud", type: "contact", level: "basic", title: { et: "Kulmud" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500 }).returning();
  await db.execute(sql`insert into reviews (course_id, kind, text, name, locale, written_at, status) values (${course.id}, 'student', 'Soovitan.', 'Mari M.', 'et', '2026-10-13T08:00:00Z', 'pending')`);
  await db.execute(sql`insert into reviews (course_id, kind, text, name, locale, written_at, status, featured, decided_at) values (${course.id}, 'student', 'Väga hea.', 'Kati K.', 'ru', '2026-10-14T08:00:00Z', 'published', true, '2026-10-15T08:00:00Z')`);
  await db.execute(sql`insert into reviews (course_id, kind, text, name, locale, written_at, status, decided_at, note) values (${course.id}, 'manual', 'Tore.', 'Anu A.', 'et', '2026-09-19T21:00:00Z', 'published', '2026-10-16T08:00:00Z', 'paberil')`);

  const columns = async () =>
    (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows;
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string; indexdef: string }>(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  // (keys, foreign keys, checks and unique constraints; not the NOT NULLs, which newer Postgres lists here too: the columns' is_nullable says them)
  const constraints = async () => (await db.execute<{ conname: string }>(sql`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by conname`)).rows;
  const rows = async () => (await db.execute<Record<string, unknown>>(sql`select * from reviews order by id`)).rows;

  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), constraints: await constraints(), reviews: await rows() };
  expect(before.columns.filter(isNew)).toEqual([]);
  expect(before.reviews).toHaveLength(3);

  await through("0021_reviews_removed_at");

  // the shape: the one column, as described above; no table, index or constraint changed, no other column changed
  const after = await columns();
  expect(after.filter(isNew)).toEqual(NEW_COLUMNS);
  expect(after.filter((c) => !isNew(c))).toEqual(before.columns);
  expect(await tables()).toEqual(before.tables);
  expect(await indexes()).toEqual(before.indexes);
  expect(await constraints()).toEqual(before.constraints);

  // every row is what it was, with removed_at null
  expect(await rows()).toEqual(before.reviews.map((r) => ({ ...r, removed_at: null })));

  // the column works through the schema: null on an insert that does not name it, and the value stored when it does
  const base = { courseId: course.id, kind: "manual" as const, text: "Uus.", name: "Liis L.", locale: "et" as const, writtenAt: new Date("2026-10-20T08:00:00Z"), status: "published" as const, note: "kiri" };
  const [kept] = await db.insert(reviews).values(base).returning();
  expect(kept.removedAt).toBeNull();
  const removedAt = new Date("2026-10-27T09:00:00Z");
  const [removed] = await db.insert(reviews).values({ ...base, removedAt }).returning();
  expect(removed.removedAt).toEqual(removedAt);
});
