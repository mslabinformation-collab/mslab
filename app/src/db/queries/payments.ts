import { and, asc, count, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { orderReference } from "@/domain/payments";
import type { I18n } from "@/i18n/field";
import type { Db, Q } from "../client";
import * as schema from "../schema";
import { courses, courseSessions, payments, registrations, type Payment, type PaymentKind } from "../schema";
import { lockRegistration } from "./seats";

// The payments table (phase 2b, spec 5.1): one row per online payment attempt. The rows are written here and by server/payments/settle.ts
// (the status changes, each a conditional UPDATE). Nothing here logs (a caller that wants an error logged passes a callback).

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
 * releaseHold for a caller that holds no lock (server/submit.ts, after a start that left no attempt): a small transaction of its own that takes
 * the registration's lock first, then runs the conditional UPDATE. Without the lock the UPDATE's "no other payment is pending" test reads the
 * database as it was when the statement began, while the row it changes is read as it is after a concurrent start has committed (a /maksa
 * page and the dashboard, or two tabs, can start one registration at once): the start's new hold would be cleared though its payment is
 * pending. Behind the lock the statement begins after that start has committed, and sees its payment. The registration's lock alone is a
 * subset of the order (db/queries/seats.ts) and freeing a seat cannot overbook; failPayment does the same. True when a live hold was ended.
 */
export async function releaseHoldLocked(db: Db, registrationId: number, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockRegistration(tx, registrationId);
    return releaseHold(tx, registrationId, 0, now);
  });
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

/** The daily check asks about a pending payment once Montonio's 30-minute window is surely over, and gives up on it after 14 days (spec 6.6). */
export const CHECK_AFTER_MS = 45 * 60_000;
export const GIVE_UP_MS = 14 * 86_400_000;

/** The daily check stops a run of work after this many errors in a row (a dead database must not burn the whole batch), not before. */
export const MAX_CONSECUTIVE_ERRORS = 3;

/** The pending payments the daily check asks Montonio about: with an order, older than 45 minutes and younger than 14 days; oldest first. */
export async function pendingToCheck(db: Db, now: Date, limit: number): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.status, "pending"),
        isNotNull(payments.providerUuid),
        lte(payments.createdAt, new Date(now.getTime() - CHECK_AFTER_MS)),
        gt(payments.createdAt, new Date(now.getTime() - GIVE_UP_MS)),
      ),
    )
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(limit);
}

/**
 * What the daily check does to the pending payments that will not be paid any more: 14 days old, or 45 minutes old without an order (its
 * creation broke off: there is nothing to ask about). Each becomes failed through failPayment, one transaction a row, oldest first, at most
 * `limit` a run (the rest wait for the next): a prepayment's failure ends its seat hold, and failPayment takes the registration's lock
 * before it writes the payment row, as every payment path does (the order course_sessions → registrations → payments, db/queries/seats.ts).
 * One bulk UPDATE would write the payment rows with no registration lock at all. That also frees a hold that such a row was keeping for a
 * later, failed attempt of the same registration (releaseHold counts every pending row). No lock is held after the call.
 * A row whose failing throws is its own failure: `onError(id, error)` is told, it is counted in `errors`, and the next row goes on (a stale
 * row stays in this set until it can be failed, so one that always throws must not stop the rows behind it). MAX_CONSECUTIVE_ERRORS errors in
 * a row stop the run: a dead database would only throw on the rest.
 * `failed`: rows failed (one that was paid or failed meanwhile is left as it is and not counted); `released`: holds ended with them (the
 * seats are free again); `left`: at least this many stale rows were not looked at (over the bound, or after the stop) and wait for the next run.
 */
export async function expireStalePending(
  db: Db,
  now: Date,
  limit: number,
  onError: (paymentId: number, error: unknown) => void,
): Promise<{ failed: number; released: number; left: number; errors: number }> {
  const stale = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.status, "pending"),
        or(lte(payments.createdAt, new Date(now.getTime() - GIVE_UP_MS)), and(isNull(payments.providerUuid), lte(payments.createdAt, new Date(now.getTime() - CHECK_AFTER_MS)))),
      ),
    )
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(limit + 1);
  let failed = 0;
  let released = 0;
  let errors = 0;
  let inARow = 0;
  let looked = 0;
  for (const { id } of stale.slice(0, limit)) {
    looked++;
    try {
      const done = await failPayment(db, id, now);
      inARow = 0;
      if (!done) continue;
      failed++;
      if (done.released) released++;
    } catch (e) {
      errors++;
      inARow++;
      onError(id, e);
      if (inARow >= MAX_CONSECUTIVE_ERRORS) break;
    }
  }
  return { failed, released, left: Math.max(0, stale.length - looked), errors };
}

/** How many unpaid registrations' holds ended between `since` and `now` (cached pages may still count them as taken). */
export async function holdsEnded(db: Db, since: Date, now: Date): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(registrations)
    .where(
      and(
        eq(registrations.status, "awaiting_prepayment"),
        sql`${registrations.seatHoldUntil} > ${since.toISOString()}::timestamptz`,
        sql`${registrations.seatHoldUntil} <= ${now.toISOString()}::timestamptz`,
      ),
    );
  return Number(n);
}
