import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { certificateDesigns, certificates, courses } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0023 (certificate designs, 2026-11-11 spec §3) as the Railway database goes through it: 0000–0022 applied, with a published e-course, a
// contact course and an issued certificate, all written by the live code (raw SQL: the schema has the columns 0023 adds), then 0023. It adds:
//   certificate_designs (id, name, tone light|dark, background_key '' by default, sort 0 by default) with „Hele“ (light, sort 1) and „Tume“
//   (dark, sort 2), neither with a photo;
//   courses.certificate_design_id  integer null, a foreign key to certificate_designs (on delete restrict);
//   certificates.design            jsonb null.
// Every course keeps what it had with no pick (null: the first design, „Hele“), and every certificate issued before keeps no design (null: today's
// dark page). Nothing else changes. A rule that fails is checked by the name of the constraint in the database's own error.

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const NEW_COLUMNS = [
  { table_name: "certificate_designs", column_name: "background_key", data_type: "text", is_nullable: "NO", column_default: "''::text" },
  { table_name: "certificate_designs", column_name: "id", data_type: "integer", is_nullable: "NO", column_default: "nextval('certificate_designs_id_seq'::regclass)" },
  { table_name: "certificate_designs", column_name: "name", data_type: "text", is_nullable: "NO", column_default: null },
  { table_name: "certificate_designs", column_name: "sort", data_type: "integer", is_nullable: "NO", column_default: "0" },
  { table_name: "certificate_designs", column_name: "tone", data_type: "text", is_nullable: "NO", column_default: null },
  { table_name: "certificates", column_name: "design", data_type: "jsonb", is_nullable: "YES", column_default: null },
  { table_name: "courses", column_name: "certificate_design_id", data_type: "integer", is_nullable: "YES", column_default: null },
];
const isNew = (c: Column) => NEW_COLUMNS.some((n) => n.table_name === c.table_name && n.column_name === c.column_name);
const NEW_CONSTRAINTS = ["certificate_designs_pkey", "certificate_designs_tone", "courses_certificate_design_id_certificate_designs_id_fk"];

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0023 adds the designs („Hele“ and „Tume“), the course's pick (none) and the certificate's design (none), keeps every row as it was, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0022_course_certificate_title");
  // the live code's rows (raw SQL: the schema's tables have the columns this migration adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price, certificate_title) values ('e-kulm', 'e_learning', 'basic', '{"et":"E-kulm"}', '{"et":""}', '{"et":""}', true, 9500, 'Kulmumeistri baaskoolitus')`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price_group) values ('kulmud', 'contact', 'basic', '{"et":"Kulmud"}', '{"et":""}', '{"et":""}', true, 12000)`);
  await db.execute(sql`insert into clients (email) values ('kati@example.test')`);
  await db.execute(
    sql`insert into course_access (client_id, course_id, granted_by, expires_at, completed_at) select c.id, k.id, 'payment', '2027-04-13T00:00:00Z', '2026-10-14T10:00:00Z' from clients c, courses k where k.slug = 'e-kulm'`,
  );
  await db.execute(
    sql`insert into certificates (access_id, number, year, seq, name, course_title, skills, practical_line, place, registry_code, issued_at) select id, 'MS LAB 2026-03', 2026, 3, 'Kati Kask', 'Kulmumeistri baaskoolitus', '["Kulmude kuju"]', 'Praktiline töö', 'Pärnu linn', '16346048', '2026-10-15T09:00:00Z' from course_access`,
  );

  const columns = async () =>
    (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows;
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string; indexdef: string }>(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  // (keys, foreign keys, checks and unique constraints; not the NOT NULLs, which newer Postgres lists here too: the columns' is_nullable says them)
  const constraints = async () => (await db.execute<{ conname: string }>(sql`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by conname`)).rows;
  const rows = async (table: "courses" | "certificates") => (await db.execute<Record<string, unknown>>(sql`select * from ${sql.identifier(table)} order by id`)).rows;

  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), constraints: await constraints(), courses: await rows("courses"), certificates: await rows("certificates") };
  expect(before.columns.filter(isNew)).toEqual([]);
  expect([before.courses.length, before.certificates.length]).toEqual([2, 1]);

  await through("0023_certificate_designs");

  const after = await columns();
  expect(after.filter(isNew)).toEqual(NEW_COLUMNS);
  expect(after.filter((c) => !isNew(c))).toEqual(before.columns);
  expect(await tables()).toEqual([...before.tables, { table_name: "certificate_designs" }].sort((a, b) => a.table_name.localeCompare(b.table_name)));
  expect((await indexes()).filter((i) => i.tablename !== "certificate_designs")).toEqual(before.indexes);
  expect((await indexes()).filter((i) => i.tablename === "certificate_designs").map((i) => i.indexname)).toEqual(["certificate_designs_pkey"]);
  expect((await constraints()).map((c) => c.conname)).toEqual([...before.constraints.map((c) => c.conname), ...NEW_CONSTRAINTS].sort());

  // every course is what it was, with no pick; every certificate is what it was, with no design (today's dark page)
  expect(await rows("courses")).toEqual(before.courses.map((r) => ({ ...r, certificate_design_id: null })));
  expect(await rows("certificates")).toEqual(before.certificates.map((r) => ({ ...r, design: null })));

  // the two designs, light first, neither with a photo
  expect(await db.select().from(certificateDesigns).orderBy(certificateDesigns.sort)).toEqual([
    { id: expect.any(Number), name: "Hele", tone: "light", backgroundKey: "", sort: 1 },
    { id: expect.any(Number), name: "Tume", tone: "dark", backgroundKey: "", sort: 2 },
  ]);
  const [hele, tume] = await db.select().from(certificateDesigns).orderBy(certificateDesigns.sort);

  // the rules: a tone is light or dark; a pick names a design; a design a course picks cannot be deleted, one no course picks can
  await violates(db.insert(certificateDesigns).values({ name: "Hall", tone: "grey" as "light" }), "certificate_designs_tone");
  const [plain] = await db.insert(certificateDesigns).values({ name: "Uus", tone: "dark" }).returning();
  expect(plain).toMatchObject({ backgroundKey: "", sort: 0 });
  const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.slug, "e-kulm"));
  await violates(db.update(courses).set({ certificateDesignId: 999_999 }).where(eq(courses.id, course.id)), "courses_certificate_design_id_certificate_designs_id_fk");
  await db.update(courses).set({ certificateDesignId: tume.id }).where(eq(courses.id, course.id));
  await violates(db.delete(certificateDesigns).where(eq(certificateDesigns.id, tume.id)), "courses_certificate_design_id_certificate_designs_id_fk");
  await db.delete(certificateDesigns).where(eq(certificateDesigns.id, plain.id));

  // the certificate's copy works through the schema
  await db.update(certificates).set({ design: { tone: "light", backgroundKey: "" } });
  expect((await db.select({ design: certificates.design }).from(certificates))[0].design).toEqual({ tone: "light", backgroundKey: "" });
  expect(hele.id).toBeLessThan(tume.id);
});
