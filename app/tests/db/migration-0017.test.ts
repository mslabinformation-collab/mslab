import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { contentDrafts, courses, settings } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0017 (admin UX pass, the draft layer: spec §7, behaviours.md B2) as the Railway database goes through it: 0000–0016 applied, with a
// course and a settings row in it, then 0017. It is additive: it adds the table `content_drafts` (one row per entity, row and part: an unpublished
// change of a published thing, laid over the live row only in draft mode) and changes nothing else. Its rules fail by the name of their index or
// column (the database's own error, so that another failure cannot pass for it): one draft per entity, row and part; every column but the
// defaulted ones is required.

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

type Column = { table_name: string; column_name: string };
type Info = { column_name: string; data_type: string; is_nullable: string; column_default: string | null };
const shape = (rows: Info[]) => Object.fromEntries(rows.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"}`]));

test("0017 adds content_drafts with its unique (entity, entity_id, part), and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0016_newsletter_simple");
  const [course] = await db.insert(courses).values({ slug: "kulmud", type: "contact", level: "basic", title: { et: "Kulmud" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
  await db.insert(settings).values({ key: "contact", value: { email: "info@example.test" } });
  const coursesBefore = (await db.execute<Record<string, unknown>>(sql`select * from courses order by id`)).rows;
  const columnsBefore = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const tablesBefore = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const indexesBefore = await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`);

  await through("0017_content_drafts");

  // the tables: content_drafts is the only one added, none removed
  const tablesAfter = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const names = (rows: { table_name: string }[]) => rows.map((t) => t.table_name);
  expect(names(tablesAfter.rows).filter((t) => !names(tablesBefore.rows).includes(t))).toEqual(["content_drafts"]);
  expect(names(tablesBefore.rows).filter((t) => !names(tablesAfter.rows).includes(t))).toEqual([]);

  // the columns: only the new table's are added, none dropped
  const columnsAfter = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const label = (c: Column) => `${c.table_name}.${c.column_name}`;
  expect(columnsBefore.rows.map(label).filter((c) => !columnsAfter.rows.map(label).includes(c))).toEqual([]);
  expect(columnsAfter.rows.map(label).filter((c) => !columnsBefore.rows.map(label).includes(c))).toEqual([
    "content_drafts.base_version", "content_drafts.entity", "content_drafts.entity_id", "content_drafts.id", "content_drafts.part",
    "content_drafts.updated_at", "content_drafts.updated_by", "content_drafts.value", "content_drafts.version",
  ]);

  // the indexes: the new table's key and its one unique index; no other changed
  const indexesAfter = await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`);
  const indexLabel = (i: { tablename: string; indexname: string }) => `${i.tablename}.${i.indexname}`;
  expect(indexesBefore.rows.map(indexLabel).filter((i) => !indexesAfter.rows.map(indexLabel).includes(i))).toEqual([]);
  expect(indexesAfter.rows.map(indexLabel).filter((i) => !indexesBefore.rows.map(indexLabel).includes(i))).toEqual([
    "content_drafts.content_drafts_entity_entity_id_part", "content_drafts.content_drafts_pkey",
  ]);

  // the rows: the course and the settings are what they were
  expect((await db.execute<Record<string, unknown>>(sql`select * from courses order by id`)).rows).toEqual(coursesBefore);
  expect((await db.select().from(settings)).map((s) => [s.key, s.value])).toEqual([["contact", { email: "info@example.test" }]]);

  // content_drafts: empty; the columns and their types, every one required; the defaults are 1 (version) and now() (the stamp), none else
  expect(await db.select().from(contentDrafts)).toEqual([]);
  const info = await db.execute<Info>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'content_drafts' order by column_name`);
  expect(shape(info.rows)).toEqual({
    base_version: "text not null", entity: "text not null", entity_id: "integer not null", id: "integer not null", part: "text not null",
    updated_at: "timestamp with time zone not null", updated_by: "text not null", value: "jsonb not null", version: "integer not null",
  });
  expect(Object.fromEntries(info.rows.filter((c) => c.column_default !== null && c.column_name !== "id").map((c) => [c.column_name, c.column_default]))).toEqual({
    updated_at: "now()", version: "1",
  });
  const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'content_drafts' and indexname not like '%_pkey' order by indexname`);
  expect(indexes.rows.map((i) => i.indexdef.replace("public.", ""))).toEqual([
    "CREATE UNIQUE INDEX content_drafts_entity_entity_id_part ON content_drafts USING btree (entity, entity_id, part)",
  ]);

  // a draft as the store writes it: version 1, stamped; its value is any JSON
  const [draft] = await db
    .insert(contentDrafts)
    .values({ entity: "course", entityId: course.id, part: "summary", value: { summary: { et: "Uus" } }, baseVersion: "a".repeat(32), updatedBy: "maria@example.test" })
    .returning();
  expect(draft).toMatchObject({ entity: "course", entityId: course.id, part: "summary", value: { summary: { et: "Uus" } }, baseVersion: "a".repeat(32), version: 1, updatedBy: "maria@example.test" });
  expect(draft.updatedAt).toBeInstanceOf(Date);
  // one draft per entity, row and part: a second of the same is refused; another part, another row or another entity is fine
  await violates(
    db.insert(contentDrafts).values({ entity: "course", entityId: course.id, part: "summary", value: {}, baseVersion: "b", updatedBy: "dim@example.test" }),
    "content_drafts_entity_entity_id_part",
  );
  await db.insert(contentDrafts).values([
    { entity: "course", entityId: course.id, part: "price", value: { priceCents: 29000 }, baseVersion: "c", updatedBy: "maria@example.test" },
    { entity: "course", entityId: course.id + 1, part: "summary", value: {}, baseVersion: "c", updatedBy: "maria@example.test" },
    { entity: "home", entityId: course.id, part: "summary", value: [], baseVersion: "c", updatedBy: "maria@example.test" },
  ]);
  expect(await db.select({ id: contentDrafts.id }).from(contentDrafts)).toHaveLength(4);
  // the entity, the row, the part, the value, the base version and who saved it are required (not null, no default)
  await violates(db.execute(sql`insert into content_drafts (entity_id, part, value, base_version, updated_by) values (1, 'p', '{}', 'v', 'x')`), "entity");
  await violates(db.execute(sql`insert into content_drafts (entity, part, value, base_version, updated_by) values ('e', 'p', '{}', 'v', 'x')`), "entity_id");
  await violates(db.execute(sql`insert into content_drafts (entity, entity_id, value, base_version, updated_by) values ('e', 1, '{}', 'v', 'x')`), "part");
  await violates(db.execute(sql`insert into content_drafts (entity, entity_id, part, base_version, updated_by) values ('e', 1, 'p', 'v', 'x')`), "value");
  await violates(db.execute(sql`insert into content_drafts (entity, entity_id, part, value, updated_by) values ('e', 1, 'p', '{}', 'x')`), "base_version");
  await violates(db.execute(sql`insert into content_drafts (entity, entity_id, part, value, base_version) values ('e', 1, 'p', '{}', 'v')`), "updated_by");
});
