import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses, registrations } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0019 (admin UX pass, piece 2, Task 2: B22, spec §7) as the Railway database goes through it: 0000–0018 applied, with a course, a
// registration and payments of every status in it, then 0019. It is additive: the enum `payment_status` gains the value `replaced` („Asendatud“:
// an older open order a new attempt took the place of), after the five there are, and `payments` gains the nullable text column `check_reason`
// (why a held payment waits for Maria: 'double', „Topeltmakse — tagasta“). Nothing else changes, and every row keeps what it had (its reason
// null).

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string };

test("0019 adds the payment status 'replaced' and the nullable column payments.check_reason, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0018_financing");
  const [course] = await db.insert(courses).values({ slug: "kulmud", type: "contact", level: "basic", title: { et: "Kulmud" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
  const [r] = await db.insert(registrations).values({ courseId: course.id, kind: "individual", name: "Anna", email: "anna@example.test", paymentChoice: "full" }).returning();
  // (raw SQL: the schema's payments already has the column this migration adds)
  const pay = (n: number, status: string) =>
    db.execute(sql`insert into payments (reference, kind, registration_id, course_id, email, name, amount_cents, status) values (${`MSLAB-M${n}`}, 'prepayment', ${r.id}, ${course.id}, 'anna@example.test', 'Anna', 17500, ${status}::payment_status)`);
  for (const [n, status] of ["pending", "paid", "failed", "refunded", "held"].entries()) await pay(n + 1, status);

  const labels = async () => (await db.execute<{ enumlabel: string }>(sql`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'payment_status' order by e.enumsortorder`)).rows.map((x) => x.enumlabel);
  const columns = async () => (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows;
  const indexes = async () => (await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`)).rows;
  const paymentRows = async () => (await db.execute<Record<string, unknown>>(sql`select * from payments order by id`)).rows;

  // before: the five statuses, and 'replaced' is refused by the database
  expect(await labels()).toEqual(["pending", "paid", "failed", "refunded", "held"]);
  const refused = await pay(9, "replaced").then(() => null, (e: { message?: string; cause?: { message?: string } }) => e);
  expect(refused, "'replaced' refused before 0019").not.toBeNull();
  expect(refused!.cause?.message ?? refused!.message).toContain("payment_status");
  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), payments: await paymentRows() };
  expect(before.payments).toHaveLength(5);
  expect(before.columns.some((c) => c.column_name === "check_reason")).toBe(false);

  await through("0019_payments_replaced");

  // the enum: the sixth value, after the five
  expect(await labels()).toEqual(["pending", "paid", "failed", "refunded", "held", "replaced"]);
  // the shape: one column more (payments.check_reason, text, nullable); no table or index changed
  const after = await columns();
  const isReason = (c: Column) => c.table_name === "payments" && c.column_name === "check_reason";
  expect(after.filter(isReason)).toEqual([{ table_name: "payments", column_name: "check_reason", data_type: "text", is_nullable: "YES" }]);
  expect(after.filter((c) => !isReason(c))).toEqual(before.columns);
  expect(await tables()).toEqual(before.tables);
  expect(await indexes()).toEqual(before.indexes);
  // every row is what it was, its reason null
  expect(await paymentRows()).toEqual(before.payments.map((p) => ({ ...p, check_reason: null })));

  // a replaced row, and a held one with its reason, are stored; the five statuses still work; any other word is still refused
  await pay(6, "replaced");
  await db.execute(sql`update payments set check_reason = 'double' where status = 'held'`);
  const stored = await db.execute<{ reference: string; status: string; check_reason: string | null }>(sql`select reference, status, check_reason from payments order by id`);
  expect(stored.rows.map((x) => [x.reference, x.status, x.check_reason])).toEqual([
    ["MSLAB-M1", "pending", null],
    ["MSLAB-M2", "paid", null],
    ["MSLAB-M3", "failed", null],
    ["MSLAB-M4", "refunded", null],
    ["MSLAB-M5", "held", "double"],
    ["MSLAB-M6", "replaced", null],
  ]);
  await expect(pay(7, "superseded")).rejects.toThrow();
});
