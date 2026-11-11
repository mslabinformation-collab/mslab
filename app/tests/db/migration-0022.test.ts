import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0022 („Pealkiri tunnistusel“) as the Railway database goes through it: 0000–0021 applied, with a published e-course and a contact
// course, then 0022. It is one `ALTER TABLE … ADD COLUMN` and nothing else:
//   courses.certificate_title  text not null default ''  — the title printed on the e-course's certificate; empty: the course's Estonian title.
// Every course keeps what it had (certificate_title ''), so every certificate is issued with the same title before and after.

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const NEW_COLUMNS = [{ table_name: "courses", column_name: "certificate_title", data_type: "text", is_nullable: "NO", column_default: "''::text" }];
const isNew = (c: Column) => NEW_COLUMNS.some((n) => n.table_name === c.table_name && n.column_name === c.column_name);

test("0022 adds exactly one column (courses.certificate_title, empty), keeps every row as it was, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0021_reviews_removed_at");
  // (raw SQL for the courses: the schema's table already has the column this migration adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price, certificate_volume) values ('e-kulm', 'e_learning', 'basic', '{"et":"E-kulm"}', '{"et":""}', '{"et":""}', true, 9500, '10 akadeemilist tundi')`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price) values ('kulmud', 'contact', 'basic', '{"et":"Kulmud"}', '{"et":""}', '{"et":""}', true, 12000)`);

  const columns = async () =>
    (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows;
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string; indexdef: string }>(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  // (keys, foreign keys, checks and unique constraints; not the NOT NULLs, which newer Postgres lists here too: the columns' is_nullable says them)
  const constraints = async () => (await db.execute<{ conname: string }>(sql`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by conname`)).rows;
  const rows = async () => (await db.execute<Record<string, unknown>>(sql`select * from courses order by id`)).rows;

  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), constraints: await constraints(), courses: await rows() };
  expect(before.columns.filter(isNew)).toEqual([]);
  expect(before.courses).toHaveLength(2);

  await through("0022_course_certificate_title");

  const after = await columns();
  expect(after.filter(isNew)).toEqual(NEW_COLUMNS);
  expect(after.filter((c) => !isNew(c))).toEqual(before.columns);
  expect(await tables()).toEqual(before.tables);
  expect(await indexes()).toEqual(before.indexes);
  expect(await constraints()).toEqual(before.constraints);

  // every course is what it was, with an empty certificate title
  expect(await rows()).toEqual(before.courses.map((r) => ({ ...r, certificate_title: "" })));

  // the column works: empty on an insert that does not name it, and the text stored when it does (raw SQL, read back by its column: the schema's
  // table has the column 0023 adds, which this database does not have yet)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body) values ('uus-1', 'e_learning', 'basic', '{"et":"Uus"}', '{"et":""}', '{"et":""}')`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, certificate_title) values ('uus-2', 'e_learning', 'basic', '{"et":"Uus"}', '{"et":""}', '{"et":""}', 'Kulmumeistri baaskoolitus')`);
  expect(await db.select({ slug: courses.slug, certificateTitle: courses.certificateTitle }).from(courses).where(inArray(courses.slug, ["uus-1", "uus-2"])).orderBy(courses.slug)).toEqual([
    { slug: "uus-1", certificateTitle: "" },
    { slug: "uus-2", certificateTitle: "Kulmumeistri baaskoolitus" },
  ]);
});
