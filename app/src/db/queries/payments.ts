import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { orderReference } from "@/domain/payments";
import type { I18n } from "@/i18n/field";
import type { Db, Q } from "../client";
import * as schema from "../schema";
import { courses, courseSessions, payments, registrations, type Payment, type PaymentKind } from "../schema";
import { lockRegistration } from "./seats";

// The payments table (phase 2b, spec 5.1): one row per online payment attempt. The rows are written here and by server/payments/settle.ts
// (the status changes, each a conditional UPDATE). Nothing here logs.

/** A payment about to start: the payer as entered, what it is for and how much. */
export type NewPayment = {
  kind: PaymentKind;
  registrationId: number | null;
  courseId: number;
  clientId: number | null;
  email: string;
  name: string;
  locale: "et" | "ru";
  amountCents: number;
  newsletter?: boolean;
};

/**
 * A new pending payment row with its reference MSLAB-M<id> (spec 5.1: written right after the insert, in the same transaction; a
 * savepoint inside the caller's when `q` is one). The insert's own placeholder reference is never seen outside it.
 */
export async function insertPayment(q: Q, input: NewPayment, now: Date): Promise<Payment> {
  return (q as Db).transaction(async (tx) => {
    const [row] = await tx
      .insert(payments)
      .values({ ...input, newsletter: input.newsletter ?? false, reference: `new-${crypto.randomUUID()}`, status: "pending", createdAt: now, updatedAt: now })
      .returning();
    const [named] = await tx.update(payments).set({ reference: orderReference(row.id) }).where(eq(payments.id, row.id)).returning();
    return named;
  });
}

/** The payment Montonio knows by `reference` (its merchantReference), or null. */
export async function paymentByReference(q: Q, reference: string): Promise<Payment | null> {
  const [row] = await q.select().from(payments).where(eq(payments.reference, reference)).limit(1);
  return row ?? null;
}

/** Montonio's uuid of a payment's order, once it is created (never replacing one the row has). */
export async function attachOrder(db: Db, id: number, providerUuid: string, now: Date): Promise<void> {
  await db.update(payments).set({ providerUuid, updatedAt: now }).where(and(eq(payments.id, id), isNull(payments.providerUuid)));
}

/**
 * Ends the seat hold of an unpaid registration when no other payment of it is still pending (phase 2b): its prepayment failed, so the seat
 * is free again at once instead of after its 30 minutes. True when a live hold was ended.
 */
export async function releaseHold(q: Q, registrationId: number, exceptPaymentId: number, now: Date): Promise<boolean> {
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const rows = await (q as unknown as PostgresJsDatabase<typeof schema>)
    .update(registrations)
    .set({ seatHoldUntil: null })
    .where(
      and(
        eq(registrations.id, registrationId),
        eq(registrations.status, "awaiting_prepayment"),
        sql`${registrations.seatHoldUntil} > ${now.toISOString()}::timestamptz`,
        sql`not exists (select 1 from payments p where p.registration_id = ${registrationId} and p.status = 'pending' and p.id <> ${exceptPaymentId})`,
      ),
    )
    .returning({ id: registrations.id });
  return rows.length > 0;
}

/**
 * A pending payment that will not be paid (its order was refused, or Montonio said ABANDONED/FAILED): `failed`, and a prepayment's hold ends
 * (releaseHold), in one transaction. Null when it was not pending (paid is a floor: settle.ts). The lock order of every payment path
 * (db/queries/seats.ts): the registration is locked before the payment row is written, as a re-send of the same payment locks it. Freeing a
 * seat cannot overbook, so the session is not locked (a subset of the locks, in the same order, is safe).
 */
export async function failPayment(db: Db, id: number, now: Date): Promise<{ payment: Payment; released: boolean } | null> {
  return db.transaction(async (tx) => {
    // (read without a lock: kind and registration never change, and the conditional UPDATE below decides)
    const [known] = await tx.select({ registrationId: payments.registrationId }).from(payments).where(eq(payments.id, id)).limit(1);
    if (known?.registrationId != null) await lockRegistration(tx, known.registrationId);
    const [payment] = await tx.update(payments).set({ status: "failed", updatedAt: now }).where(and(eq(payments.id, id), eq(payments.status, "pending"))).returning();
    if (!payment) return null;
    const released = payment.kind === "prepayment" && payment.registrationId !== null ? await releaseHold(tx, payment.registrationId, payment.id, now) : false;
    return { payment, released };
  });
}

/** What a payment was for: the course, the session of its registration, and that registration's "Maksa" token (the return's "Proovi uuesti"). */
export type PaymentContext = {
  course: { title: I18n; slug: string } | null;
  session: { startsAt: Date; city: string; venue: string } | null;
  payToken: string | null;
};

export async function paymentContext(q: Q, paymentId: number): Promise<PaymentContext> {
  const [row] = await q
    .select({ title: courses.title, slug: courses.slug, startsAt: courseSessions.startsAt, city: courseSessions.city, venue: courseSessions.venue, payToken: registrations.payToken })
    .from(payments)
    .leftJoin(courses, eq(payments.courseId, courses.id))
    .leftJoin(registrations, eq(payments.registrationId, registrations.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(payments.id, paymentId))
    .limit(1);
  return {
    course: row?.title && row.slug ? { title: row.title, slug: row.slug } : null,
    session: row?.startsAt ? { startsAt: row.startsAt, city: row.city ?? "", venue: row.venue ?? "" } : null,
    payToken: row?.payToken ?? null,
  };
}
