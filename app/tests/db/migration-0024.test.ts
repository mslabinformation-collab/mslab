import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courseAreas, courses } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0024 (course areas, „Valdkonnad“; spec 2026-11-11-course-areas-filter-design.md §3) as the Railway database goes through it: 0000–0023
// applied (0023: the certificate designs), with a published contact course and an e-course, then 0024. It is additive and nothing else:
//   course_areas           id serial pk, name jsonb not null ({ et, ru }), sort integer not null default 0 — Maria's list (Seaded → Valdkonnad);
//   courses.area_id        integer null, references course_areas(id) on delete restrict — null: no area, the course shows only under „Kõik“;
// and its data step seeds the two areas of Maria's message, „Kulmukoolitused“ (sort 1) and „Ripsmekoolitused“ (sort 2), with their Russian names.
// No course gets an area: every course keeps what it had (area_id null), so the site shows no area filter until Maria picks them.

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const NEW_COLUMNS: Column[] = [
  { table_name: "course_areas", column_name: "id", data_type: "integer", is_nullable: "NO", column_default: "nextval('course_areas_id_seq'::regclass)" },
  { table_name: "course_areas", column_name: "name", data_type: "jsonb", is_nullable: "NO", column_default: null },
  { table_name: "course_areas", column_name: "sort", data_type: "integer", is_nullable: "NO", column_default: "0" },
  { table_name: "courses", column_name: "area_id", data_type: "integer", is_nullable: "YES", column_default: null },
];
const isNew = (c: Column) => NEW_COLUMNS.some((n) => n.table_name === c.table_name && n.column_name === c.column_name);

test("0024 adds the course_areas table with Maria's two areas and courses.area_id (null for every course), and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0023_certificate_designs");
  // (raw SQL for the courses: the schema's table already has the column this migration adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price_group) values ('kulmud', 'contact', 'basic', '{"et":"Kulmud"}', '{"et":""}', '{"et":""}', true, 35000)`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price) values ('e-ripsmed', 'e_learning', 'basic', '{"et":"E-ripsmed"}', '{"et":""}', '{"et":""}', true, 15000)`);

  const columns = async () =>
    (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows.map((r) => r.table_name);
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string; indexdef: string }>(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  // (keys, foreign keys, checks and unique constraints; not the NOT NULLs, which newer Postgres lists here too: the columns' is_nullable says them)
  const constraints = async () => (await db.execute<{ conname: string }>(sql`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by conname`)).rows.map((r) => r.conname);
  const rows = async () => (await db.execute<Record<string, unknown>>(sql`select * from courses order by id`)).rows;

  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), constraints: await constraints(), courses: await rows() };
  expect(before.columns.filter(isNew)).toEqual([]);
  expect(before.tables).not.toContain("course_areas");
  expect(before.courses).toHaveLength(2);

  await through("0024_course_areas");

  const after = await columns();
  expect(after.filter(isNew)).toEqual(NEW_COLUMNS);
  expect(after.filter((c) => !isNew(c))).toEqual(before.columns);
  expect(await tables()).toEqual([...before.tables, "course_areas"].sort());
  // the new table's key is its only index (no other table gets one)
  expect((await indexes()).filter((i) => !before.indexes.some((b) => b.indexname === i.indexname)).map((i) => i.indexname)).toEqual(["course_areas_pkey"]);
  expect((await indexes()).filter((i) => i.indexname !== "course_areas_pkey")).toEqual(before.indexes);
  expect(await constraints()).toEqual([...before.constraints, "course_areas_pkey", "courses_area_id_course_areas_id_fk"].sort());

  // the data step: Maria's two areas in her order, each with its Russian name
  const areas = (await db.execute<{ id: number; name: unknown; sort: number }>(sql`select id, name, sort from course_areas order by sort, id`)).rows;
  expect(areas).toEqual([
    { id: 1, name: { et: "Kulmukoolitused", ru: "Курсы по бровям" }, sort: 1 },
    { id: 2, name: { et: "Ripsmekoolitused", ru: "Курсы по ресницам" }, sort: 2 },
  ]);

  // every course is what it was, with no area: nothing changes on the site until Maria picks them
  expect(await rows()).toEqual(before.courses.map((r) => ({ ...r, area_id: null })));

  // the column works through the schema, and an area a course uses cannot be deleted (on delete restrict)
  const [next] = await db.insert(courseAreas).values({ name: { et: "Meigikoolitused", ru: "Курсы макияжа" }, sort: 3 }).returning();
  expect(next.id).toBe(3);
  await db.update(courses).set({ areaId: next.id }).where(sql`slug = 'kulmud'`);
  await expect(db.execute(sql`delete from course_areas where id = ${next.id}`)).rejects.toThrow();
  expect((await db.execute<{ area_id: number | null }>(sql`select area_id from courses order by id`)).rows).toEqual([{ area_id: 3 }, { area_id: null }]);
  await db.update(courses).set({ areaId: null }).where(sql`slug = 'kulmud'`);
  await db.execute(sql`delete from course_areas where id = ${next.id}`);
  // a course that names no area does not exist
  await expect(db.execute(sql`update courses set area_id = 99 where slug = 'kulmud'`)).rejects.toThrow();
});
