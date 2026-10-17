import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { clients, contracts, courseAccess, courses, payments, registrations } from "@/db/schema";
import type { ContractFields, ContractSnapshot } from "@/domain/contract";
import { migrationsThrough } from "./helpers";

// Migration 0013 (contracts, phase 4 piece 3) as the Railway database goes through it: 0000–0012 applied, a registration, an e-course access and
// a paid payment written by the code of 0012 (which knows none of 0013's columns), then 0013. The new table is there, empty; the registration's
// and the payment's new columns are null; nothing else changes (the migration only adds). The rules fail by the name of their constraint or
// index (the database's own error, so that another failure cannot pass for it): at most one current contract per registration and per access,
// a superseded one letting a new one in; and a registration's, an access's, a payment's, a course's or an account's deletion keeps the
// contract with the link set null (the accepted text outlives its owners).

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

test("0013 adds contracts, empty, with their rules, registrations.contract_requested_at and payments.contract_snapshot, null; deleting the owners keeps the contract", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0012_invoice_footer");
  // the code of 0012's rows (raw SQL: drizzle would name the columns 0013 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000)`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price) values ('e', 'e_learning', 'basic', '{"et":"E"}', '{"et":""}', '{"et":""}', 9900)`);
  const id = Object.fromEntries((await db.select({ id: courses.id, slug: courses.slug }).from(courses)).map((c) => [c.slug, c.id]));
  await db.execute(sql`insert into clients (email, name) values ('kati@example.test', 'Kati Kask'), ('mari@example.test', 'Mari Mänd')`);
  const who = Object.fromEntries((await db.select({ id: clients.id, email: clients.email }).from(clients)).map((c) => [c.email, c.id]));
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice, status, paid_cents, client_id) values (${id.k}, 'group', 'Kati Kask', 'kati@example.test', 'half', 'confirmed', 17500, ${who["kati@example.test"]})`);
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) values (${id.k}, 'group', 'Mari Mänd', 'mari@example.test', 'full')`);
  const regs = Object.fromEntries((await db.select({ id: registrations.id, email: registrations.email }).from(registrations)).map((r) => [r.email, r.id]));
  await db.execute(
    sql`insert into course_access (client_id, course_id, granted_by, expires_at) values (${who["kati@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z'), (${who["mari@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z')`,
  );
  const access = Object.fromEntries((await db.select({ id: courseAccess.id, clientId: courseAccess.clientId }).from(courseAccess)).map((a) => [a.clientId, a.id]));
  await db.execute(sql`insert into payments (reference, kind, registration_id, course_id, email, name, amount_cents, status, paid_at) values ('MSLAB-L1', 'prepayment', ${regs["kati@example.test"]}, ${id.k}, 'kati@example.test', 'Kati Kask', 17500, 'paid', '2026-10-15T09:00:00Z')`);
  const [{ id: paymentId }] = await db.execute<{ id: number }>(sql`select id from payments`).then((r) => r.rows);
  const columnsBefore = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const tablesBefore = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);

  await through("0013_contracts");

  // the migration only adds: the new table's columns, registrations.contract_requested_at and payments.contract_snapshot, nothing removed
  const columnsAfter = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const isNew = (c: Column) => !columnsBefore.rows.some((b) => b.table_name === c.table_name && b.column_name === c.column_name);
  expect(columnsAfter.rows.filter(isNew).map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
    "contracts.accepted_at", "contracts.accepted_via", "contracts.access_id", "contracts.body", "contracts.client_id", "contracts.course_id",
    "contracts.created_at", "contracts.fields", "contracts.id", "contracts.kind", "contracts.locale", "contracts.payment_id", "contracts.registration_id",
    "contracts.sent_at", "contracts.superseded_at", "contracts.title", "contracts.version",
    "payments.contract_snapshot", "registrations.contract_requested_at",
  ]);
  expect(columnsBefore.rows.filter((b) => !columnsAfter.rows.some((c) => b.table_name === c.table_name && b.column_name === c.column_name))).toEqual([]);
  const tablesAfter = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  expect(tablesAfter.rows.filter((t) => !tablesBefore.rows.some((b) => b.table_name === t.table_name))).toEqual([{ table_name: "contracts" }]);

  // the types and defaults of the new columns: the two nullable ones, and the table's required ones
  const info = await db.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'contracts' order by column_name`,
  );
  expect(Object.fromEntries(info.rows.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"}`]))).toEqual({
    access_id: "integer null", accepted_at: "timestamp with time zone not null", accepted_via: "text not null", body: "text not null",
    client_id: "integer null", course_id: "integer null", created_at: "timestamp with time zone not null", fields: "jsonb not null",
    id: "integer not null", kind: "text not null", locale: "text not null", payment_id: "integer null", registration_id: "integer null",
    sent_at: "timestamp with time zone null", superseded_at: "timestamp with time zone null", title: "text not null", version: "text not null",
  });
  const added = await db.execute<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    sql`select table_name, column_name, data_type, is_nullable from information_schema.columns where (table_name = 'registrations' and column_name = 'contract_requested_at') or (table_name = 'payments' and column_name = 'contract_snapshot') order by table_name`,
  );
  expect(added.rows).toEqual([
    { table_name: "payments", column_name: "contract_snapshot", data_type: "jsonb", is_nullable: "YES" },
    { table_name: "registrations", column_name: "contract_requested_at", data_type: "timestamp with time zone", is_nullable: "YES" },
  ]);

  // (the rest runs on the schema as it stands, so that a later migration does not break what this one checks)
  await migrate(db, { migrationsFolder: "./drizzle" });

  // what was there is untouched; the new table is empty and the new columns are null
  expect(await db.select().from(contracts)).toEqual([]);
  const regRows = await db.select({ id: registrations.id, status: registrations.status, paidCents: registrations.paidCents, requested: registrations.contractRequestedAt }).from(registrations).orderBy(registrations.id);
  expect(regRows).toEqual([
    { id: regs["kati@example.test"], status: "confirmed", paidCents: 17500, requested: null },
    { id: regs["mari@example.test"], status: "awaiting_prepayment", paidCents: 0, requested: null },
  ]);
  expect(await db.select({ id: payments.id, status: payments.status, snapshot: payments.contractSnapshot }).from(payments)).toEqual([{ id: paymentId, status: "paid", snapshot: null }]);

  // the named indexes: three plain ones, and the two partial unique ones "current" (not superseded, and linked)
  const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'contracts' and indexname not like '%_pkey' order by indexname`);
  expect(indexes.rows.map((i) => i.indexdef.replace("public.", ""))).toEqual([
    "CREATE INDEX contracts_access ON contracts USING btree (access_id)",
    "CREATE INDEX contracts_client ON contracts USING btree (client_id)",
    "CREATE UNIQUE INDEX contracts_current_access ON contracts USING btree (access_id) WHERE ((superseded_at IS NULL) AND (access_id IS NOT NULL))",
    "CREATE UNIQUE INDEX contracts_current_registration ON contracts USING btree (registration_id) WHERE ((superseded_at IS NULL) AND (registration_id IS NOT NULL))",
    "CREATE INDEX contracts_registration ON contracts USING btree (registration_id)",
  ]);

  // a contract: the frozen copy, not sent, not superseded, its creation stamped
  const fields: ContractFields = {
    school: { company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1, Tallinn" },
    student: { name: "Kati Kask", email: "kati@example.test" },
    course: "K", session: "14.11.2026, Tallinn", price: "350,00 €", payment: "50% registreerimisel + 50% koolituspäeval",
  };
  const copy = {
    kind: "contact" as const, courseId: id.k, clientId: who["kati@example.test"], version: "1", locale: "et" as const, title: "Leping", body: "Kati Kask osaleb.",
    fields, acceptedAt: new Date("2026-10-15T09:00:00Z"), acceptedVia: "form" as const,
  };
  const kati = regs["kati@example.test"];
  const [first] = await db.insert(contracts).values({ ...copy, registrationId: kati }).returning();
  expect(first).toMatchObject({ ...copy, registrationId: kati, accessId: null, paymentId: null, sentAt: null, supersededAt: null });
  expect(first.createdAt).toBeInstanceOf(Date);

  // at most one current contract per registration: a second one fails on contracts_current_registration ...
  await violates(db.insert(contracts).values({ ...copy, registrationId: kati, acceptedVia: "account" }), "contracts_current_registration");
  // ... another registration has its own, and contracts of no registration are many
  const mari = regs["mari@example.test"];
  await db.insert(contracts).values({ ...copy, registrationId: mari, clientId: who["mari@example.test"] });
  await db.insert(contracts).values({ ...copy, registrationId: null });
  await db.insert(contracts).values({ ...copy, registrationId: null });
  // ... and once the old one is superseded, a new one is let in; the old one stays beside it
  await db.update(contracts).set({ supersededAt: new Date("2026-10-16T09:00:00Z") }).where(eq(contracts.id, first.id));
  const [second] = await db.insert(contracts).values({ ...copy, registrationId: kati, acceptedVia: "account", acceptedAt: new Date("2026-10-16T10:00:00Z") }).returning();
  expect(second.supersededAt).toBeNull();
  await violates(db.insert(contracts).values({ ...copy, registrationId: kati }), "contracts_current_registration");
  expect((await db.select({ id: contracts.id, supersededAt: contracts.supersededAt }).from(contracts).where(eq(contracts.registrationId, kati)).orderBy(contracts.id)).map((c) => c.supersededAt !== null)).toEqual([true, false]);
  // a second superseded one is no hindrance either
  await db.insert(contracts).values({ ...copy, registrationId: kati, supersededAt: new Date("2026-10-16T11:00:00Z") });

  // the same per e-course access: contracts_current_access
  const ecourse = { ...copy, kind: "ecourse" as const, courseId: id.e, acceptedVia: "terms" as const, registrationId: null };
  const katiAccess = access[who["kati@example.test"]];
  const [bought] = await db.insert(contracts).values({ ...ecourse, accessId: katiAccess, acceptedVia: "purchase", paymentId }).returning();
  expect(bought).toMatchObject({ kind: "ecourse", accessId: katiAccess, paymentId, acceptedVia: "purchase" });
  await violates(db.insert(contracts).values({ ...ecourse, accessId: katiAccess }), "contracts_current_access");
  await db.insert(contracts).values({ ...ecourse, accessId: access[who["mari@example.test"]] });
  await db.insert(contracts).values({ ...ecourse, accessId: null });
  await db.update(contracts).set({ supersededAt: new Date("2026-10-16T09:00:00Z") }).where(eq(contracts.id, bought.id));
  const [again] = await db.insert(contracts).values({ ...ecourse, accessId: katiAccess }).returning();
  expect(again.supersededAt).toBeNull();
  await violates(db.insert(contracts).values({ ...ecourse, accessId: katiAccess }), "contracts_current_access");

  // the links must name something
  await violates(db.insert(contracts).values({ ...copy, registrationId: 999_999 }), "contracts_registration_id_registrations_id_fk");
  await violates(db.insert(contracts).values({ ...ecourse, accessId: 999_999 }), "contracts_access_id_course_access_id_fk");
  await violates(db.insert(contracts).values({ ...copy, courseId: 999_999 }), "contracts_course_id_courses_id_fk");
  await violates(db.insert(contracts).values({ ...copy, clientId: 999_999 }), "contracts_client_id_clients_id_fk");
  await violates(db.insert(contracts).values({ ...copy, paymentId: 999_999 }), "contracts_payment_id_payments_id_fk");

  // the payment's snapshot: the contract an e-course purchase showed, kept on the payment until it is paid
  const snapshot: ContractSnapshot = { version: "3", locale: "ru", title: "Договор", body: "Текст" };
  await db.update(payments).set({ contractSnapshot: snapshot }).where(eq(payments.id, paymentId));
  expect(await db.select({ snapshot: payments.contractSnapshot }).from(payments)).toEqual([{ snapshot }]);
  // the registration's reminder that Maria asked again (D4)
  await db.update(registrations).set({ contractRequestedAt: new Date("2026-10-17T09:00:00Z") }).where(eq(registrations.id, mari));
  expect((await db.select({ requested: registrations.contractRequestedAt }).from(registrations).where(eq(registrations.id, mari)))[0].requested).toEqual(new Date("2026-10-17T09:00:00Z"));

  // a registration's deletion keeps its contracts, the link set null (the frozen text and parties are all that is left of it)
  await db.delete(registrations).where(eq(registrations.id, kati));
  const keptContract = await db.select({ id: contracts.id, registrationId: contracts.registrationId, body: contracts.body, fields: contracts.fields, courseId: contracts.courseId }).from(contracts).where(eq(contracts.id, second.id));
  expect(keptContract).toEqual([{ id: second.id, registrationId: null, body: "Kati Kask osaleb.", fields, courseId: id.k }]);
  expect(await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.registrationId, kati))).toEqual([]);
  // (Mari's own contract is untouched)
  expect((await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.registrationId, mari))).length).toBe(1);

  // a payment's deletion keeps the e-course contract, the payment link null
  await db.delete(payments).where(eq(payments.id, paymentId));
  expect(await db.select({ paymentId: contracts.paymentId }).from(contracts).where(eq(contracts.id, bought.id))).toEqual([{ paymentId: null }]);

  // the account's deletion takes its access (cascade) and keeps the contracts: the access and the client links null
  await db.delete(clients).where(eq(clients.id, who["kati@example.test"]));
  expect(await db.select({ id: courseAccess.id }).from(courseAccess).where(eq(courseAccess.id, katiAccess))).toEqual([]);
  expect(await db.select({ accessId: contracts.accessId, clientId: contracts.clientId, kind: contracts.kind }).from(contracts).where(eq(contracts.id, again.id))).toEqual([{ accessId: null, clientId: null, kind: "ecourse" }]);
  expect(await db.select({ accessId: contracts.accessId, clientId: contracts.clientId }).from(contracts).where(eq(contracts.id, second.id))).toEqual([{ accessId: null, clientId: null }]);
  expect((await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.clientId, who["kati@example.test"]))).length).toBe(0);

  // a course's deletion keeps the contracts too (the e-course's access goes with the course)
  expect((await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.courseId, id.e))).length).toBe(4);
  expect((await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.accessId, access[who["mari@example.test"]]))).length).toBe(1);
  await db.delete(courses).where(eq(courses.id, id.e));
  expect(await db.select({ id: courseAccess.id }).from(courseAccess)).toEqual([]);
  const ecourseRows = await db.select({ accessId: contracts.accessId, courseId: contracts.courseId }).from(contracts).where(eq(contracts.kind, "ecourse"));
  expect(ecourseRows).toHaveLength(4);
  expect(ecourseRows.every((c) => c.accessId === null && c.courseId === null)).toBe(true);
});
