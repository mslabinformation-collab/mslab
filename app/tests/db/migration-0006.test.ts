import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses, courseSessions, payments, registrations } from "@/db/schema";
import { isTokenShape } from "@/server/token";
import { migrationsThrough } from "./helpers";

// Migration 0006 (phase 2b) as the Railway database goes through it: 0000–0005 applied, three registrations written by the live code (which
// knows no pay_token), then 0006. Each of them gets its own "Maksa" token in the shape of newToken(), no seat hold, and the payments table is
// there, empty, with its rules: a positive amount, a unique reference, a unique Montonio uuid (many payments may have none), and a payment kept
// (unlinked) when its registration is deleted. A rule that fails is checked by the name of the constraint in the database's own error
// (drizzle puts it in `cause`), so that another failure cannot pass for it.

/** The statement fails, and the database names `constraint` in its error. */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0006 gives every registration its own pay token, no hold, and adds the payments table with its rules", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0005_phase2c");
  const [course] = await db
    .insert(courses)
    .values({ slug: "k", type: "contact", level: "basic", title: { et: "K" }, summary: { et: "" }, body: { et: "" }, priceGroup: 35000 })
    .returning();
  const [session] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" }).returning();
  // the live code's insert: it knows no pay_token or seat_hold_until (raw SQL: drizzle would name the new columns)
  for (const email of ["a@example.test", "b@example.test", "c@example.test"])
    await db.execute(sql`insert into registrations (course_id, course_session_id, kind, name, email, payment_choice) values (${course.id}, ${session.id}, 'group', 'X', ${email}, 'half')`);

  await through("0006_phase2b_payments");

  const rows = await db.select({ token: registrations.payToken, hold: registrations.seatHoldUntil }).from(registrations);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.token)).size).toBe(3);
  for (const r of rows) {
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isTokenShape(r.token)).toBe(true);
    expect(r.hold).toBeNull();
  }
  // an insert that names no token (the e2e fixtures' SQL) still gets one, a different one
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) values (${course.id}, 'individual', 'Y', 'y@example.test', 'full')`);
  const tokens = await db.select({ email: registrations.email, token: registrations.payToken }).from(registrations);
  expect(new Set(tokens.map((r) => r.token)).size).toBe(4);
  // the token is unique: giving one registration another's token fails on registrations_pay_token
  const [first, second] = tokens;
  await violates(db.update(registrations).set({ payToken: first.token }).where(eq(registrations.email, second.email)), "registrations_pay_token");

  // payments: the amount is positive, the reference unique, and a deleted registration leaves its payment (unlinked) for the books
  const [reg] = await db.select({ id: registrations.id }).from(registrations).where(eq(registrations.email, "a@example.test"));
  const base = { kind: "prepayment" as const, registrationId: reg.id, courseId: course.id, email: "a@example.test", name: "A", amountCents: 17500 };
  expect(await db.select().from(payments)).toEqual([]);
  await violates(db.insert(payments).values({ ...base, reference: "MSLAB-M0", amountCents: 0 }), "payments_amount_positive");
  await violates(db.insert(payments).values({ ...base, reference: "MSLAB-M0", amountCents: -100 }), "payments_amount_positive");
  const [p] = await db.insert(payments).values({ ...base, reference: "MSLAB-M1" }).returning();
  expect(p).toMatchObject({ status: "pending", locale: "et", method: "", bank: "", newsletter: false, providerUuid: null, paidAt: null, clientId: null });
  await violates(db.insert(payments).values({ ...base, reference: "MSLAB-M1" }), "payments_reference");
  // Montonio's uuid is unique when there is one; payments without one (not sent yet) may be many
  await db.insert(payments).values({ ...base, reference: "MSLAB-M2" });
  expect((await db.select({ reference: payments.reference }).from(payments).where(isNull(payments.providerUuid))).map((p) => p.reference).sort()).toEqual(["MSLAB-M1", "MSLAB-M2"]);
  await db.insert(payments).values({ ...base, reference: "MSLAB-M3", providerUuid: "uuid-1" });
  await violates(db.insert(payments).values({ ...base, reference: "MSLAB-M4", providerUuid: "uuid-1" }), "payments_provider_uuid");
  await db.delete(registrations).where(eq(registrations.id, reg.id));
  expect((await db.select().from(payments).where(eq(payments.reference, "MSLAB-M1")))[0]).toMatchObject({ reference: "MSLAB-M1", registrationId: null, courseId: course.id, email: "a@example.test" });
});
