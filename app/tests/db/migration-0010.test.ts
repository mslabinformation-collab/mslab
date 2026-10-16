import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0010 (the legacy column of phase 3a) as the Railway database goes through it: 0000–0009 applied, a course written by the
// live code with its module titles in course_modules and the old courses.modules column still holding a list, then 0010. The column is
// gone, the course and its module titles are untouched, and the schema no longer names it (a select of every column still works).

test("0010 drops courses.modules and keeps the course and its course_modules rows", async () => {
  const db = drizzle(new PGlite(), { schema });
  const dir = migrationsThrough("0009_certificates");
  try {
    await migrate(db, { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the live code's rows (raw SQL: the old column is written as the 3a code left it)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price, modules) values ('e', 'e_learning', 'basic', '{"et":"E"}', '{"et":""}', '{"et":""}', 9900, '[{"et":"Vana moodul"}]')`);
  await db.execute(sql`insert into course_modules (course_id, position, title) select id, 1, '{"et":"Moodul 1"}' from courses where slug = 'e'`);

  await migrate(db, { migrationsFolder: "./drizzle" });

  const columns = await db.execute(sql`select column_name from information_schema.columns where table_name = 'courses' and column_name = 'modules'`);
  expect(columns.rows).toEqual([]);
  const rows = await db.select().from(schema.courses);
  expect(rows.map((c) => c.slug)).toEqual(["e"]);
  expect("modules" in rows[0]).toBe(false);
  const modules = await db.select().from(schema.courseModules);
  expect(modules.map((m) => m.title)).toEqual([{ et: "Moodul 1" }]);
});
