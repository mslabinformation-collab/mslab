import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { invoices, payments } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0012 (invoices, the final review's wave) as a database at 0011 goes through it: 0000–0011 applied, an invoice and a payment
// started for it written by the code of 0011 (which knows no footer column), then 0012. The invoice is untouched and its new footer is empty
// (an invoice issued before 0012 printed the footer of its download's day; it now prints none); a new invoice may freeze one; and the
// payments get an index on invoice_id, which the R14 read and an invoice's deletion use. Nothing else changes: the migration only adds.

test("0012 adds invoices.footer, empty for the invoices already there, and the index payments_invoice; it only adds", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0011_invoices");
  // the code of 0011's rows (raw SQL: drizzle would name the column 0012 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000)`);
  const [{ id: courseId }] = await db.execute<{ id: number }>(sql`select id from courses where slug = 'k'`).then((r) => r.rows);
  await db.execute(sql`
    insert into invoices (number, prefix, year, seq, kind, course_id, amount_cents, line, seller, buyer, reference, issued_at, due_at)
    values ('MSL2026-001', 'MSL', 2026, 1, 'prepayment', ${courseId}, 17500,
            '{"course":"K","session":"","part":"Ettemaks 50%"}',
            '{"company":"MS LAB OÜ","registryCode":"1","address":"A","vatNumber":"","receiver":"MS LAB OÜ","iban":"EE00","bank":"Pank"}',
            '{"name":"Kati Kask","email":"kati@example.test","address":"","company":"","companyCode":"","companyAddress":""}',
            'MSLAB-1', '2026-10-15T09:00:00Z', '2026-10-22T09:00:00Z')`);
  const [{ id: invoiceId }] = await db.execute<{ id: number }>(sql`select id from invoices`).then((r) => r.rows);
  await db.execute(sql`insert into payments (reference, kind, course_id, email, name, amount_cents, invoice_id) values ('MSLAB-L1', 'prepayment', ${courseId}, 'kati@example.test', 'Kati Kask', 17500, ${invoiceId})`);
  const columnsBefore = await db.execute<{ table_name: string; column_name: string }>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);

  await through("0012_invoice_footer");

  // one column more, invoices.footer, text not null default '' — nothing removed, nothing else added
  const columnsAfter = await db.execute<{ table_name: string; column_name: string }>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  expect(columnsAfter.rows.filter((c) => !columnsBefore.rows.some((b) => b.table_name === c.table_name && b.column_name === c.column_name))).toEqual([{ table_name: "invoices", column_name: "footer" }]);
  expect(columnsBefore.rows.filter((b) => !columnsAfter.rows.some((c) => b.table_name === c.table_name && b.column_name === c.column_name))).toEqual([]);
  const footer = await db.execute<{ data_type: string; is_nullable: string; column_default: string }>(
    sql`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'invoices' and column_name = 'footer'`,
  );
  expect(footer.rows).toEqual([{ data_type: "text", is_nullable: "NO", column_default: "''::text" }]);

  // the invoice already there: as it was, with an empty footer; the payment still points at it
  const [kept] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  expect(kept).toMatchObject({ number: "MSL2026-001", status: "unpaid", amountCents: 17500, reference: "MSLAB-1", footer: "" });
  expect(await db.select({ invoiceId: payments.invoiceId }).from(payments)).toEqual([{ invoiceId }]);

  // a new invoice freezes its footer; one that names none has the empty default
  const copy = { ...kept, id: undefined, createdAt: undefined };
  const [withFooter] = await db.insert(invoices).values({ ...copy, number: "MSL2026-002", seq: 2, footer: "Täname!" }).returning();
  expect(withFooter.footer).toBe("Täname!");
  const [{ footer: none }] = await db.execute<{ footer: string }>(
    sql`insert into invoices (number, prefix, year, seq, kind, amount_cents, line, seller, buyer, issued_at) select 'MSL2026-003', prefix, year, 3, kind, amount_cents, line, seller, buyer, issued_at from invoices where id = ${invoiceId} returning footer`,
  ).then((r) => r.rows);
  expect(none).toBe("");

  // (the rest runs on the schema as it stands: drizzle's insert names every column of payments, among them payments.contract_snapshot, which migration 0013 adds)
  await migrate(db, { migrationsFolder: "./drizzle" });

  // the index on payments.invoice_id, a plain one (an invoice may have been started for by more than one payment)
  const index = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where tablename = 'payments' and indexname = 'payments_invoice'`);
  expect(index.rows).toHaveLength(1);
  expect(index.rows[0].indexdef).toMatch(/^CREATE INDEX payments_invoice ON public\.payments USING btree \(invoice_id\)$/);
  // a second payment for the same invoice is allowed, and the invoice's deletion still sets them null
  await db.insert(payments).values({ reference: "MSLAB-L2", kind: "prepayment", courseId, email: "kati@example.test", name: "Kati Kask", amountCents: 17500, invoiceId });
  await db.delete(invoices).where(eq(invoices.id, invoiceId));
  expect(await db.select({ invoiceId: payments.invoiceId }).from(payments)).toEqual([{ invoiceId: null }, { invoiceId: null }]);
});
