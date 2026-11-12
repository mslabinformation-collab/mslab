import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { discountCodeCourses, discountCodes, discountRedemptions, payments, registrations } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0025 (discount codes; spec 2026-11-11-discount-codes) as the Railway database goes through it: 0000–0024 applied, then 0025. It adds
//   discount_codes, discount_code_courses, discount_redemptions   — Maria's codes, the courses of a code, and the uses of a code (frozen);
//   registrations.discount_cents / discount_code, payments.discount_cents / discount_code  — the discount frozen on a booking or an order;
// with their checks and indexes, and its data step makes the welcome row of `discount_codes` from the `newsletter` setting (welcomeCode, discountPercent
// or the old discountLabel, codeDays). The setting is not changed. Nothing else changes: every existing row keeps what it had.

type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const NEW_TABLES = ["discount_code_courses", "discount_codes", "discount_redemptions"];
const int0 = (table_name: string, column_name: string): Column => ({ table_name, column_name, data_type: "integer", is_nullable: "NO", column_default: "0" });
const text0 = (table_name: string, column_name: string): Column => ({ table_name, column_name, data_type: "text", is_nullable: "NO", column_default: "''::text" });
const NEW_COLUMNS_ON_OLD_TABLES = [
  int0("payments", "discount_cents"), text0("payments", "discount_code"),
  int0("registrations", "discount_cents"), text0("registrations", "discount_code"),
];
const isNewColumn = (c: Column) => NEW_TABLES.includes(c.table_name) || NEW_COLUMNS_ON_OLD_TABLES.some((n) => n.table_name === c.table_name && n.column_name === c.column_name);

const NEW_INDEXES = [
  "discount_code_courses_code_id_course_id_pk", "discount_codes_code", "discount_codes_one_welcome", "discount_codes_pkey",
  "discount_redemptions_code", "discount_redemptions_code_email", "discount_redemptions_payment", "discount_redemptions_pkey", "discount_redemptions_registration",
];
const NEW_CONSTRAINTS = [
  "discount_code_courses_code_id_course_id_pk", "discount_code_courses_code_id_discount_codes_id_fk", "discount_code_courses_course_id_courses_id_fk",
  "discount_codes_amount_positive", "discount_codes_code_shape", "discount_codes_dates_order", "discount_codes_days", "discount_codes_max_uses_positive",
  "discount_codes_one_value", "discount_codes_percent_range", "discount_codes_pkey", "discount_codes_welcome_rules",
  "discount_redemptions_cents_positive", "discount_redemptions_client_id_clients_id_fk", "discount_redemptions_code_id_discount_codes_id_fk",
  "discount_redemptions_course_id_courses_id_fk", "discount_redemptions_payment_id_payments_id_fk", "discount_redemptions_pkey",
  "discount_redemptions_registration_id_registrations_id_fk",
  "payments_discount_not_negative", "registrations_discount_not_negative",
];

function newDb() {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { db, through };
}

/** A database at 0024 whose `newsletter` setting is `value`, migrated to 0025; the rows of discount_codes, read back raw, and the setting. */
async function welcomeRowsFor(value: unknown) {
  const { db, through } = newDb();
  await through("0024_course_areas");
  await db.execute(sql`insert into settings (key, value) values ('newsletter', ${JSON.stringify(value)}::jsonb)`);
  await through("0025_discount_codes");
  const rows = (await db.execute<Record<string, unknown>>(sql`select code, welcome, percent, amount_cents, scope, audience, once_per_person, days_after_signup, active from discount_codes order by id`)).rows;
  const setting = (await db.execute<{ value: unknown }>(sql`select value from settings where key = 'newsletter'`)).rows;
  return { rows, setting };
}

test("0025 adds the discount tables and columns and nothing else", async () => {
  const { db, through } = newDb();
  await through("0024_course_areas");
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, published, price) values ('kulmud', 'contact', 'basic', '{"et":"Kulmud"}', '{"et":""}', '{"et":""}', true, 12000)`);
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) select id, 'group', 'Test', 'a@example.test', 'full' from courses`);
  await db.execute(sql`insert into payments (reference, kind, email, name, amount_cents) values ('R1', 'ecourse', 'a@example.test', 'Test', 9500)`);

  const columns = async () => (await db.execute<Column>(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows;
  const tables = async () => (await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows.map((r) => r.table_name);
  const indexes = async () => (await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public' order by indexname`)).rows.map((r) => r.indexname);
  const constraints = async () => (await db.execute<{ conname: string }>(sql`select conname from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by conname`)).rows.map((r) => r.conname);
  const enums = async () => (await db.execute<{ typname: string }>(sql`select typname from pg_type where typtype = 'e' order by typname`)).rows.map((r) => r.typname);
  const oldRows = async () => ({
    registrations: (await db.execute<Record<string, unknown>>(sql`select * from registrations order by id`)).rows,
    payments: (await db.execute<Record<string, unknown>>(sql`select * from payments order by id`)).rows,
  });

  const before = { columns: await columns(), tables: await tables(), indexes: await indexes(), constraints: await constraints(), enums: await enums(), rows: await oldRows() };
  expect(before.rows.registrations).toHaveLength(1);
  expect(before.rows.payments).toHaveLength(1);

  await through("0025_discount_codes");

  const after = await columns();
  expect(after.filter((c) => !NEW_TABLES.includes(c.table_name) && isNewColumn(c))).toEqual(NEW_COLUMNS_ON_OLD_TABLES);
  expect([...new Set(after.filter((c) => NEW_TABLES.includes(c.table_name)).map((c) => c.table_name))]).toEqual(NEW_TABLES);
  expect(after.filter((c) => !isNewColumn(c))).toEqual(before.columns);
  expect((await tables()).filter((t) => !before.tables.includes(t))).toEqual(NEW_TABLES);
  expect((await tables()).filter((t) => before.tables.includes(t))).toEqual(before.tables);
  expect((await indexes()).filter((i) => !before.indexes.includes(i))).toEqual(NEW_INDEXES);
  expect((await indexes()).filter((i) => before.indexes.includes(i))).toEqual(before.indexes);
  expect((await constraints()).filter((c) => !before.constraints.includes(c))).toEqual(NEW_CONSTRAINTS);
  expect((await constraints()).filter((c) => before.constraints.includes(c))).toEqual(before.constraints);
  expect((await enums()).filter((e) => !before.enums.includes(e))).toEqual(["discount_audience", "discount_scope", "redemption_via"]);

  // the existing rows are what they were, with no discount
  const rows = await oldRows();
  expect(rows.registrations).toEqual(before.rows.registrations.map((r) => ({ ...r, discount_cents: 0, discount_code: "" })));
  expect(rows.payments).toEqual(before.rows.payments.map((r) => ({ ...r, discount_cents: 0, discount_code: "" })));
  // no newsletter setting: no welcome row
  expect((await db.execute(sql`select 1 from discount_codes`)).rows).toHaveLength(0);

  // each new column works through the schema
  const [reg] = await db.select().from(registrations);
  await db.update(registrations).set({ discountCents: 1200, discountCode: "TERE10" });
  await db.update(payments).set({ discountCents: 950, discountCode: "TERE10" });
  expect((await db.select({ c: registrations.discountCents, k: registrations.discountCode }).from(registrations))[0]).toEqual({ c: 1200, k: "TERE10" });
  expect((await db.select({ c: payments.discountCents, k: payments.discountCode }).from(payments))[0]).toEqual({ c: 950, k: "TERE10" });
  const [code] = await db.insert(discountCodes).values({ code: "TERE10", percent: 10 }).returning();
  expect(code).toMatchObject({ welcome: false, scope: "all", audience: "all", oncePerPerson: true, note: "", active: true, startsOn: null, endsOn: null, maxUses: null, daysAfterSignup: null, amountCents: null });
  await db.insert(discountCodeCourses).values({ codeId: code.id, courseId: reg.courseId });
  const [use] = await db.insert(discountRedemptions).values({ codeId: code.id, email: "a@example.test", courseId: reg.courseId, registrationId: reg.id, listCents: 12000, discountCents: 1200, via: "form" }).returning();
  expect(use).toMatchObject({ clientId: null, paymentId: null, listCents: 12000, discountCents: 1200, via: "form" });
});

test("a code with a percent and days becomes the welcome row", async () => {
  const { rows, setting } = await welcomeRowsFor({ welcomeCode: "TERE10", discountPercent: 15, codeDays: 30 });
  expect(rows).toEqual([{ code: "TERE10", welcome: true, percent: 15, amount_cents: null, scope: "all", audience: "first", once_per_person: true, days_after_signup: 30, active: true }]);
  expect(setting).toEqual([{ value: { welcomeCode: "TERE10", discountPercent: 15, codeDays: 30 } }]);
});

// (one database per case: each goes through all the migrations, and the DB tests share a busy machine)
test.each([
  ["the number of the old discountLabel", { welcomeCode: "TERE", discountLabel: "-15%" }, { percent: 15, days_after_signup: null }],
  ["10 when the old discountLabel has no number", { welcomeCode: "TERE", discountLabel: "tervitus" }, { percent: 10, days_after_signup: null }],
  ["10 when the percent is a string and the label has no number", { welcomeCode: "TERE", discountPercent: "abc", discountLabel: "x" }, { percent: 10 }],
  ["the label when the percent is a string", { welcomeCode: "TERE", discountPercent: "abc", discountLabel: "-20%" }, { percent: 20 }],
  ["the label when the percent is 0", { welcomeCode: "TERE", discountPercent: 0, discountLabel: "-20%" }, { percent: 20 }],
  ["10 when the percent has decimals", { welcomeCode: "TERE", discountPercent: 15.5 }, { percent: 10 }],
  ["no days when codeDays is a string", { welcomeCode: "TERE", codeDays: "x" }, { percent: 10, days_after_signup: null }],
  ["no days when codeDays is 0", { welcomeCode: "TERE", codeDays: 0 }, { days_after_signup: null }],
  ["no days when codeDays is 366", { welcomeCode: "TERE", codeDays: 366 }, { days_after_signup: null }],
  ["365 days when codeDays is 365", { welcomeCode: "TERE", codeDays: 365 }, { days_after_signup: 365 }],
])("the welcome row takes %s, without an error", async (_name, setting, expected) => {
  expect((await welcomeRowsFor(setting)).rows).toMatchObject([{ code: "TERE", ...expected }]);
});

test.each([
  ["an empty code", { welcomeCode: "", discountPercent: 10 }],
  ["a code of the wrong shape", { welcomeCode: "tere 10" }],
  ["a code of dashes only", { welcomeCode: "---" }],
  ["no code", { discountPercent: 10 }],
])("%s makes no row", async (_name, setting) => {
  expect((await welcomeRowsFor(setting)).rows).toEqual([]);
});

test("the checks refuse what the rules forbid", async () => {
  const { db, through } = newDb();
  await through("0025_discount_codes");
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body) values ('kulmud', 'contact', 'basic', '{"et":"Kulmud"}', '{"et":""}', '{"et":""}')`);
  const [course] = await db.select({ id: schema.courses.id }).from(schema.courses);
  const [reg] = await db.insert(registrations).values({ courseId: course.id, kind: "group", name: "Test", email: "a@example.test", paymentChoice: "full" }).returning();
  const [ok] = await db.insert(discountCodes).values({ code: "OK10", percent: 10 }).returning();
  const use = { codeId: ok.id, email: "a@example.test", listCents: 12000, discountCents: 1200, via: "form" as const };
  await db.insert(discountRedemptions).values({ ...use, registrationId: reg.id });

  /** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`), so that another failure cannot pass for it (P5). */
  const rejects = async (name: string, constraint: string, run: () => Promise<unknown>) => {
    const error = await run().then(
      () => null,
      (e: unknown) => e as { message?: string; cause?: { message?: string } },
    );
    expect(error, name).not.toBeNull();
    expect(error!.cause?.message ?? error!.message, name).toContain(`"${constraint}"`);
  };
  let n = 0;
  const code = (name: string, constraint: string, v: Partial<typeof discountCodes.$inferInsert>) =>
    rejects(name, constraint, () => db.insert(discountCodes).values({ code: `T${++n}`, percent: 10, ...v }));
  await code("percent 100", "discount_codes_percent_range", { percent: 100 });
  await code("percent 0", "discount_codes_percent_range", { percent: 0 });
  await code("both percent and amount", "discount_codes_one_value", { percent: 10, amountCents: 500 });
  await code("neither", "discount_codes_one_value", { percent: null });
  await code("amount zero", "discount_codes_amount_positive", { percent: null, amountCents: 0 });
  await code("ends before it starts", "discount_codes_dates_order", { startsOn: "2026-12-10", endsOn: "2026-12-09" });
  await code("max uses zero", "discount_codes_max_uses_positive", { maxUses: 0 });
  await code("lower case", "discount_codes_code_shape", { code: "tere" });
  await code("only dashes", "discount_codes_code_shape", { code: "---" });
  await code("too long", "discount_codes_code_shape", { code: "A".repeat(31) });
  await code("days on a non-welcome row", "discount_codes_days", { daysAfterSignup: 7 });
  await code("welcome with audience all", "discount_codes_welcome_rules", { welcome: true, audience: "all" });
  await code("welcome not once per person", "discount_codes_welcome_rules", { welcome: true, audience: "first", oncePerPerson: false });
  await code("a second row of the same code", "discount_codes_code", { code: "OK10" });
  await code("welcome days 366", "discount_codes_days", { welcome: true, audience: "first", daysAfterSignup: 366 });
  // the same rules, accepted where they should be (a one-day code; a welcome row with days)
  await db.insert(discountCodes).values({ code: "WELCOME", welcome: true, audience: "first", percent: 10, daysAfterSignup: 30, startsOn: "2026-12-09", endsOn: "2026-12-09" });
  await code("two welcome rows", "discount_codes_one_welcome", { welcome: true, audience: "first" });

  await rejects("a redemption with discount_cents 0", "discount_redemptions_cents_positive", () => db.insert(discountRedemptions).values({ ...use, discountCents: 0 }));
  await rejects("a redemption with list_cents 0", "discount_redemptions_cents_positive", () => db.insert(discountRedemptions).values({ ...use, listCents: 0 }));
  await rejects("a second redemption on one registration", "discount_redemptions_registration", () => db.insert(discountRedemptions).values({ ...use, registrationId: reg.id }));
  await rejects("deleting a code that has a redemption", "discount_redemptions_code_id_discount_codes_id_fk", () => db.delete(discountCodes).where(sql`id = ${ok.id}`));
  await rejects("a negative discount on a registration", "registrations_discount_not_negative", () => db.update(registrations).set({ discountCents: -1 }));
  await rejects("a negative discount on a payment", "payments_discount_not_negative", () =>
    db.insert(payments).values({ reference: "R1", kind: "ecourse", email: "a@example.test", name: "T", amountCents: 100, discountCents: -1 }),
  );

  // a payment carries at most one use, and redemptions without a registration or payment may be many
  const [pay] = await db.insert(payments).values({ reference: "R2", kind: "ecourse", email: "a@example.test", name: "T", amountCents: 100 }).returning();
  await db.insert(discountRedemptions).values({ ...use, paymentId: pay.id });
  await rejects("a second redemption on one payment", "discount_redemptions_payment", () => db.insert(discountRedemptions).values({ ...use, paymentId: pay.id }));
  await db.insert(discountRedemptions).values(use);
  await db.insert(discountRedemptions).values(use);
});
