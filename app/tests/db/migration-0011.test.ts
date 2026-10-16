import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { invoices, payments, registrations } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0011 (invoices, phase 4) as the Railway database goes through it: 0000–0010 applied, a registration and a paid payment written
// by the live code (which knows neither the invoices table nor payments.invoice_id), then 0011. The table is there, empty; the payment's
// new column is null; the rules fail by the name of their constraint (the database's own error, so that another failure cannot pass for
// it); and a registration's or a payment's deletion keeps the invoice with the link set null (accounting records outlive their owners).

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0011 adds invoices, empty, with their rules, and payments.invoice_id, null; deleting the owners keeps the invoice", async () => {
  const db = drizzle(new PGlite(), { schema });
  const dir = migrationsThrough("0010_drop_courses_modules");
  try {
    await migrate(db, { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the live code's rows (raw SQL: drizzle would name the column 0011 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000)`);
  const [{ id: courseId }] = await db.execute<{ id: number }>(sql`select id from courses where slug = 'k'`).then((r) => r.rows);
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice, status, paid_cents) values (${courseId}, 'group', 'Kati Kask', 'kati@example.test', 'half', 'confirmed', 17500)`);
  const [{ id: registrationId }] = await db.execute<{ id: number }>(sql`select id from registrations`).then((r) => r.rows);
  await db.execute(sql`insert into payments (reference, kind, registration_id, course_id, email, name, amount_cents, status, paid_at) values ('MSLAB-L1', 'prepayment', ${registrationId}, ${courseId}, 'kati@example.test', 'Kati Kask', 17500, 'paid', '2026-10-15T09:00:00Z')`);

  await migrate(db, { migrationsFolder: "./drizzle" });

  // what was there is untouched; the new table is empty and the payment's new column is null
  expect(await db.select().from(invoices)).toEqual([]);
  const paid = await db.select({ id: payments.id, status: payments.status, invoiceId: payments.invoiceId }).from(payments);
  expect(paid).toEqual([{ id: paid[0].id, status: "paid", invoiceId: null }]);
  const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'payments' and column_name = 'invoice_id'`);
  expect(columns.rows).toHaveLength(1);
  const [payment] = paid;

  // an invoice: unpaid by default, no reference, not sent, not a paid mark that added to the registration, its creation stamped
  const copy = {
    number: "MSL2026-001", prefix: "MSL", year: 2026, seq: 1, kind: "prepayment" as const, registrationId, courseId, amountCents: 17500, vatRate: null,
    line: { course: "K", session: "14.11.2026 Tallinn", part: "Ettemaks 50%" },
    seller: { company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1", vatNumber: "", receiver: "MS LAB OÜ", iban: "EE000000000000000000", bank: "Pank" },
    buyer: { name: "Kati Kask", email: "kati@example.test", address: "", company: "", companyCode: "", companyAddress: "" },
    issuedAt: new Date("2026-10-15T09:00:00Z"),
  };
  const [first] = await db.insert(invoices).values(copy).returning();
  expect(first).toMatchObject({
    ...copy, paymentId: null, clientId: null, status: "unpaid", reference: "", dueAt: null, paidAt: null, paidMethod: null, paidAdds: false,
    sentAt: null, sentNote: "", cancelledAt: null,
  });
  expect(first.createdAt).toBeInstanceOf(Date);

  // one per number, one per prefix + year + seq, one born paid per payment, a positive amount, a seq from 1
  const other = { ...copy, number: "MSL2026-002", seq: 2 };
  await violates(db.insert(invoices).values({ ...other, seq: 2, number: "MSL2026-001" }), "invoices_number");
  await violates(db.insert(invoices).values({ ...other, number: "MSL2026-002", seq: 1 }), "invoices_series");
  await violates(db.insert(invoices).values({ ...other, amountCents: 0 }), "invoices_amount_positive");
  await violates(db.insert(invoices).values({ ...other, amountCents: -5 }), "invoices_amount_positive");
  await violates(db.insert(invoices).values({ ...other, number: "MSL2026-000", seq: 0 }), "invoices_seq_positive");
  await violates(db.insert(invoices).values({ ...other, registrationId: 999_999 }), "invoices_registration_id_registrations_id_fk");
  await violates(db.insert(invoices).values({ ...other, paymentId: 999_999 }), "invoices_payment_id_payments_id_fk");
  const [born] = await db.insert(invoices).values({ ...other, paymentId: payment.id, status: "paid" }).returning();
  await violates(db.insert(invoices).values({ ...other, number: "MSL2026-003", seq: 3, paymentId: payment.id }), "invoices_payment");
  // the same sequence under another prefix, or in another year, is another invoice; two unpaid invoices have no payment between them
  await db.insert(invoices).values({ ...copy, number: "AB2026-001", prefix: "AB" });
  await db.insert(invoices).values({ ...copy, number: "MSL2027-001", year: 2027 });
  await db.insert(invoices).values({ ...copy, number: "MSL2026-004", seq: 4 });

  // the payment can point at the unpaid invoice it was started for; deleting that invoice sets the pointer null
  await db.update(payments).set({ invoiceId: first.id }).where(eq(payments.id, payment.id));
  await violates(db.update(payments).set({ invoiceId: 999_999 }).where(eq(payments.id, payment.id)), "payments_invoice_id_invoices_id_fk");
  await db.delete(invoices).where(eq(invoices.id, first.id));
  expect(await db.select({ invoiceId: payments.invoiceId }).from(payments)).toEqual([{ invoiceId: null }]);

  // the registration's and the payment's deletion keep the invoice, the link set null
  await db.delete(payments).where(eq(payments.id, payment.id));
  expect(await db.select({ paymentId: invoices.paymentId }).from(invoices).where(eq(invoices.id, born.id))).toEqual([{ paymentId: null }]);
  await db.delete(registrations).where(eq(registrations.id, registrationId));
  const kept = await db.select({ id: invoices.id, number: invoices.number, registrationId: invoices.registrationId, buyer: invoices.buyer }).from(invoices).where(eq(invoices.id, born.id));
  expect(kept).toEqual([{ id: born.id, number: "MSL2026-002", registrationId: null, buyer: copy.buyer }]);
});
