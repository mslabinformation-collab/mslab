import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courses, courseSessions, payments, registrations } from "@/db/schema";
import { isTokenShape } from "@/server/token";
import { migrationsThrough } from "./helpers";

// Migration 0006 (phase 2b) as the Railway database goes through it: 0000–0005 applied, three registrations written by the live code (which
// knows no pay_token), then 0006. Each of them gets its own "Maksa" token in the shape of newToken(), no seat hold, and the payments table is
// there, empty, with its rules: a positive amount, a unique reference, and a payment kept (unlinked) when its registration is deleted.

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
  expect(new Set((await db.select({ token: registrations.payToken }).from(registrations)).map((r) => r.token)).size).toBe(4);

  // payments: the amount is positive, the reference unique, and a deleted registration leaves its payment (unlinked) for the books
  const [reg] = await db.select({ id: registrations.id }).from(registrations).where(eq(registrations.email, "a@example.test"));
  const base = { kind: "prepayment" as const, registrationId: reg.id, courseId: course.id, email: "a@example.test", name: "A", amountCents: 17500 };
  expect(await db.select().from(payments)).toEqual([]);
  await expect(db.insert(payments).values({ ...base, reference: "MSLAB-M0", amountCents: 0 })).rejects.toThrow();
  const [p] = await db.insert(payments).values({ ...base, reference: "MSLAB-M1" }).returning();
  expect(p).toMatchObject({ status: "pending", locale: "et", method: "", bank: "", newsletter: false, providerUuid: null, paidAt: null, clientId: null });
  await expect(db.insert(payments).values({ ...base, reference: "MSLAB-M1" })).rejects.toThrow();
  await db.delete(registrations).where(eq(registrations.id, reg.id));
  expect((await db.select().from(payments))[0]).toMatchObject({ reference: "MSLAB-M1", registrationId: null, courseId: course.id, email: "a@example.test" });
});
