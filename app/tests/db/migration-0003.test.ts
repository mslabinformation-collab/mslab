import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courseModules, courses } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0003 copies every course's module titles (courses.modules, jsonb) into course_modules, in their order, and keeps the
// column (the live code reads it until the 3a deploy). Checked as the Railway database goes through it: 0000–0002 applied, courses
// with titles, then 0003. courses.modules is written and read by plain SQL, and the test stops at 0003, so it stays true after
// migration 0010 drops the column from the schema and the database (Task 12; 0004 adds the lessons' video shape).

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
