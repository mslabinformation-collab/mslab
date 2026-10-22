import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses, registrations, settings } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0018 (instalments, Task 1: spec §3) as the Railway database goes through it: 0000–0017 applied, with a course, registrations of both
// choices and a settings row in it, then 0018. It is additive: the enum `payment_choice` gains the value `financing` (Järelmaks (Inbank), always the
// full price), after „full“ and „half“, and nothing else changes: no table, column or index is added or dropped, and the rows are what they were.

type Column = { table_name: string; column_name: string };

test("0018 adds the payment choice 'financing' to the enum, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0017_content_drafts");
  const [course] = await db.insert(courses).values({ slug: "kulmud", type: "contact", level: "basic", title: { et: "Kulmud" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
  const register = (paymentChoice: "full" | "half" | "financing", name: string) =>
    db.insert(registrations).values({ courseId: course.id, kind: "individual", name, email: `${name.toLowerCase()}@example.test`, paymentChoice }).returning();
  await register("full", "Anna");
  await register("half", "Berta");
  await db.insert(settings).values({ key: "contact", value: { email: "info@example.test" } });

  const labels = async () => (await db.execute<{ enumlabel: string }>(sql`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'payment_choice' order by e.enumsortorder`)).rows.map((r) => r.enumlabel);
  const columns = async () => (await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows;
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  const registrationRows = async () => (await db.execute<Record<string, unknown>>(sql`select * from registrations order by id`)).rows;

  // before: the two choices, and the third is refused by the database
  expect(await labels()).toEqual(["full", "half"]);
  const refused = await register("financing", "Cecilia").then(() => null, (e: { message?: string; cause?: { message?: string } }) => e);
  expect(refused, "'financing' refused before 0018").not.toBeNull();
  expect(refused!.cause?.message ?? refused!.message).toContain("payment_choice");
  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), registrations: await registrationRows() };
  expect(before.registrations).toHaveLength(2);

  await through("0018_financing");

  // the enum: the third value, after the two
  expect(await labels()).toEqual(["full", "half", "financing"]);
  // the shape: no table, column or index changed, and the rows are what they were
  expect(await columns()).toEqual(before.columns);
  expect(await tables()).toEqual(before.tables);
  expect(await indexes()).toEqual(before.indexes);
  expect(await registrationRows()).toEqual(before.registrations);
  expect((await db.select().from(settings)).map((s) => [s.key, s.value])).toEqual([["contact", { email: "info@example.test" }]]);

  // a registration with 'financing' succeeds, and 'full' and 'half' still work
  const [financing] = await register("financing", "Cecilia");
  expect(financing.paymentChoice).toBe("financing");
  expect((await register("full", "Dora"))[0].paymentChoice).toBe("full");
  expect((await register("half", "Eva"))[0].paymentChoice).toBe("half");
  const stored = await db.execute<{ name: string; payment_choice: string }>(sql`select name, payment_choice from registrations order by id`);
  expect(stored.rows.map((r) => [r.name, r.payment_choice])).toEqual([["Anna", "full"], ["Berta", "half"], ["Cecilia", "financing"], ["Dora", "full"], ["Eva", "half"]]);
  // any other word is still refused
  await expect(db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) values (${course.id}, 'individual', 'X', 'x@example.test', 'thirds')`)).rejects.toThrow();
});
