import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, not, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ContractSnapshot } from "@/domain/contract";
import { FINANCING_ATTEMPT_MS, isHirePurchase } from "@/domain/financing";
import { PAGE_SIZE } from "@/domain/paging";
import { orderReference } from "@/domain/payments";
import { SEAT_HOLD_MS } from "@/domain/sessions";
import type { I18n } from "@/i18n/field";
import type { Db, Q } from "../client";
import { dbErrorCode } from "../safe-error";
import * as schema from "../schema";
import { courses, courseSessions, payments, registrations, type Payment, type PaymentKind, type PaymentStatus } from "../schema";
import { paged, type Paged } from "./paged";
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
  /** The unpaid invoice it is started to pay (invoices, spec D5: „Maksa" of a registration with one); none: null or left out. */
  invoiceId?: number | null;
  /** An e-course purchase: the contract the cart showed, filled (contracts, §4); none: null or left out. */
  contractSnapshot?: ContractSnapshot | null;
  /**
   * The Montonio method the attempt is started with (instalments, D5): "paymentInitiation" (the bank link) or "hirePurchase" (Järelmaks
   * (Inbank)). Its re-send window, its seat hold and the daily check's age follow it (server/payments/start.ts, checkAfterMs); when it is
   * paid, settle.ts never replaces a recorded hirePurchase, while any other row takes the method Montonio reports (card, Apple Pay, …). Left
   * out: none ('', as every row before the methods), which reads as the bank.
   */
  method?: string;
};

/** A method (a column, or an aliased one) that is the järelmaks, by domain/financing.ts isHirePurchase's rule (case and spaces aside). */
const isHirePurchaseSql = (method: SQL) => sql`lower(btrim(${method})) = 'hirepurchase'`;

/**
 * A payment row whose method is the järelmaks (instalments, D5), by domain/financing.ts isHirePurchase's rule (case and spaces aside): every
 * other row, one with no method recorded too, is a bank attempt.
 */
export const hirePurchaseRow = isHirePurchaseSql(sql`${payments.method}`);

/**
 * A new pending payment row with its reference <prefix><id> (spec 5.1: written right after the insert, in the same transaction; a
 * savepoint inside the caller's when `q` is one). `prefix` is this environment's (the store's: server/payments/montonio.ts, MSLAB-M in
 * production). The insert's own placeholder reference is never seen outside it.
 */
export async function insertPayment(q: Q, input: NewPayment, now: Date, prefix: string): Promise<Payment> {
  return (q as Db).transaction(async (tx) => {
    const [row] = await tx
      .insert(payments)
      .values({ ...input, newsletter: input.newsletter ?? false, reference: `new-${crypto.randomUUID()}`, status: "pending", createdAt: now, updatedAt: now })
      .returning();
    const [named] = await tx.update(payments).set({ reference: orderReference(row.id, prefix) }).where(eq(payments.id, row.id)).returning();
    return named;
  });
}

/** The payment Montonio knows by `reference` (its merchantReference), or null. */
export async function paymentByReference(q: Q, reference: string): Promise<Payment | null> {
  const [row] = await q.select().from(payments).where(eq(payments.reference, reference)).limit(1);
  return row ?? null;
}

/** The payment whose order at Montonio is `providerUuid` (its latest: a re-send may have replaced it, start.ts), or null. */
export async function paymentByProviderUuid(q: Q, providerUuid: string): Promise<Payment | null> {
  if (!providerUuid) return null;
  const [row] = await q.select().from(payments).where(eq(payments.providerUuid, providerUuid)).limit(1);
  return row ?? null;
}

/**
 * The statuses of an order that may still be paid at Montonio: `pending`, and `replaced` (B22: an older open order of a registration that a
 * newer attempt took the place of — „Asendatud“ is ours only, Montonio still takes its money). The daily check asks about both, both fail
 * when Montonio ends them, and both hold the registration's seat for their window.
 */
export const OPEN_ORDER: readonly PaymentStatus[] = ["pending", "replaced"];

/** OPEN_ORDER as a list of SQL values, for raw SQL (releaseHold's look at the other open attempts). */
const OPEN_ORDER_SQL = sql.join(
  OPEN_ORDER.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * One open order per registration (B22, admin UX pass piece 2): every other `pending` payment of `registrationId` — whatever its kind or
 * method, a loan application too — becomes `replaced` („Asendatud“), the open attempt `keepId` excepted. Only the status changes: the row keeps
 * its order, its reference and its last sending (`updated_at`), so its seat window (attemptEnds) and its daily-check age stay its own. It stays
 * payable at Montonio and settles as any open order (settle.ts: counted, or held as „Topeltmakse — tagasta“ when the registration is paid in
 * full by then). Run by startRegistrationPayment in its transaction, under the registration's lock (lockForPayment): right after a new
 * attempt's row is inserted, and when a replaced attempt pressed again inside its window is restored (start.ts liveAttempt); a re-send of
 * the open attempt replaces nothing. The number of rows replaced.
 */
export async function replaceOlderOrders(q: Q, registrationId: number, keepId: number): Promise<number> {
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const rows = await (q as unknown as PostgresJsDatabase<typeof schema>)
    .update(payments)
    .set({ status: "replaced" })
    .where(and(eq(payments.registrationId, registrationId), eq(payments.status, "pending"), ne(payments.id, keepId)))
    .returning({ id: payments.id });
  return rows.length;
}

/** Montonio's uuid of a payment's order, once it is created (never replacing one the row has). */
export async function attachOrder(db: Db, id: number, providerUuid: string, now: Date): Promise<void> {
  await db.update(payments).set({ providerUuid, updatedAt: now }).where(and(eq(payments.id, id), isNull(payments.providerUuid)));
}

/**
 * The end of an open attempt's window, for the payment row aliased `p`: its last sending (`updated_at`: the insert or the last re-send —
 * nothing else touches a pending row, and its replacement leaves it as it is: replaceOlderOrders) and its method's window
 * (domain/financing.ts attemptWindowMs: 60 minutes for a järelmaks, the bank's 30).
 */
const attemptEnds = sql`p.updated_at + (case when ${isHirePurchaseSql(sql.raw("p.method"))} then ${FINANCING_ATTEMPT_MS}::integer else ${SEAT_HOLD_MS}::integer end) * interval '1 millisecond'`;

/**
 * The seat hold of an unpaid registration after one of its payments failed (phase 2b; instalments, Task 4): it is what the registration's
 * other open attempts still hold — the latest end of their windows (attemptEnds) among its other open orders (OPEN_ORDER: pending, and a
 * replaced one, B22, whose order may still be paid — a loan application she left for the bank may still be signed), a start whose order is
 * being made included — or none at all when no attempt is open any more, so the seat is free again at once instead of after the failed
 * attempt's window. So a järelmaks whose first sending failed (an order that never was) leaves no 60 minutes behind it: an open bank attempt
 * keeps its own 30. The hold only ever ends or gets shorter here, and only a live one is touched (a confirmed registration's, or one kept for
 * want of a seat, has none). One conditional UPDATE. True when a live hold was ended.
 */
export async function releaseHold(q: Q, registrationId: number, exceptPaymentId: number, now: Date): Promise<boolean> {
  const at = sql`${now.toISOString()}::timestamptz`;
  // the latest window still open, or null (no other attempt is pending, or every one's window is over)
  const open = sql`(select max(${attemptEnds}) from payments p where p.registration_id = ${registrationId} and p.status in (${OPEN_ORDER_SQL}) and p.id <> ${exceptPaymentId} having max(${attemptEnds}) > ${at})`;
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const rows = await (q as unknown as PostgresJsDatabase<typeof schema>)
    .update(registrations)
    .set({ seatHoldUntil: sql`${open}` })
    .where(
      and(
        eq(registrations.id, registrationId),
        eq(registrations.status, "awaiting_prepayment"),
        sql`${registrations.seatHoldUntil} > ${at}`,
        sql`(${open} is null or ${open} < ${registrations.seatHoldUntil})`,
      ),
    )
    .returning({ seatHoldUntil: registrations.seatHoldUntil });
  return rows.some((r) => r.seatHoldUntil === null);
}

/**
 * releaseHold for a caller that holds no lock (server/submit.ts, after a start that left no attempt): a small transaction of its own that takes
 * the registration's lock first, then runs the conditional UPDATE. Without the lock the UPDATE's look at the other pending payments reads the
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
 * An open payment (pending, or replaced: OPEN_ORDER) that will not be paid (its order was refused, or Montonio said ABANDONED/FAILED, or the
 * daily check gave up on it): `failed`, and the hold its start took ends, or is cut back to what the registration's other open attempts hold
 * (releaseHold: an unconfirmed registration's, whatever the payment paid — a prepayment, or an invoice's rest: server/payments/start.ts), in
 * one transaction. Null when it was not open (paid is a floor: settle.ts). The lock order of every payment path (db/queries/seats.ts): the
 * registration is locked before the payment row is written, as a re-send of the same payment locks it. Freeing a seat cannot overbook, so the
 * session is not locked (a subset of the locks, in the same order, is safe).
 */
export async function failPayment(db: Db, id: number, now: Date): Promise<{ payment: Payment; released: boolean } | null> {
  return db.transaction(async (tx) => {
    // (read without a lock: kind and registration never change, and the conditional UPDATE below decides)
    const [known] = await tx.select({ registrationId: payments.registrationId }).from(payments).where(eq(payments.id, id)).limit(1);
    if (known?.registrationId != null) await lockRegistration(tx, known.registrationId);
    const [payment] = await tx.update(payments).set({ status: "failed", updatedAt: now }).where(and(eq(payments.id, id), inArray(payments.status, OPEN_ORDER))).returning();
    if (!payment) return null;
    // (releaseHold ends only an unconfirmed registration's live hold, so a confirmed registration's rest releases nothing)
    const released = payment.kind !== "ecourse" && payment.registrationId !== null ? await releaseHold(tx, payment.registrationId, payment.id, now) : false;
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

/**
 * The daily check asks about an open payment (pending or replaced: OPEN_ORDER) once its order's window is surely over — the attempt's window
 * (domain/financing.ts attemptWindowMs) and 15 minutes: 45 minutes for a bank attempt (Montonio's 30), 75 for a järelmaks (its 60,
 * instalments D5) — and gives up on it after 14 days (spec 6.6). An order never created is failed after the same age.
 */
export const CHECK_AFTER_MS = 45 * 60_000;
export const FINANCING_CHECK_AFTER_MS = 75 * 60_000;
export const GIVE_UP_MS = 14 * 86_400_000;

/** The daily check's age for a payment of this method (CHECK_AFTER_MS, or FINANCING_CHECK_AFTER_MS for `hirePurchase`). */
export const checkAfterMs = (method: string): number => (isHirePurchase(method) ? FINANCING_CHECK_AFTER_MS : CHECK_AFTER_MS);

/** A payment row old enough for the daily check at `now` (checkAfterMs by its method, in the one query: hirePurchaseRow). */
const oldEnoughToCheck = (now: Date) =>
  or(
    and(hirePurchaseRow, lte(payments.createdAt, new Date(now.getTime() - FINANCING_CHECK_AFTER_MS))),
    and(not(hirePurchaseRow), lte(payments.createdAt, new Date(now.getTime() - CHECK_AFTER_MS))),
  );

/**
 * The daily check stops one of its loops (the stale rows, the asking) after this many connection errors in a row (isConnectionError: a dead
 * database must not burn the whole batch), not before. Any other error of a row is counted and the loop goes on, within its batch and its
 * time: poison rows at the head of the queue never stop the rows behind them.
 */
export const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * The driver's own codes of a lost connection (postgres.js) and Node's socket errors; and the SQLSTATEs of a server that is going or not there
 * yet: 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now (a restart, as Railway's), 53300 too_many_connections.
 */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  "57P01", "57P02", "57P03", "53300",
]);

/**
 * Is this a lost or refused connection to the database — SQLSTATE class 08 (connection exception), a server shutting down, starting up or
 * full (CONNECTION_CODES), or the driver's connection error — and so one the next row would only meet again? The code is on the error or
 * down its `cause` (drizzle's wrapper: db/safe-error.ts dbErrorCode).
 */
export function isConnectionError(e: unknown): boolean {
  const code = dbErrorCode(e);
  return code !== null && (CONNECTION_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code));
}

/**
 * The open payments the daily check asks Montonio about (pending, and replaced ones, B22: a replaced order paid while its webhook failed is
 * found here or nowhere): with an order, older than 45 minutes (75 for a järelmaks: checkAfterMs) and younger than 14 days; oldest first.
 */
export async function pendingToCheck(db: Db, now: Date, limit: number): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(and(inArray(payments.status, OPEN_ORDER), isNotNull(payments.providerUuid), oldEnoughToCheck(now), gt(payments.createdAt, new Date(now.getTime() - GIVE_UP_MS))))
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(limit);
}

/**
 * What the daily check does to the open payments (pending or replaced: OPEN_ORDER) that will not be paid any more: 14 days old, or 45
 * minutes old (75 for a järelmaks: checkAfterMs) without an order (its creation broke off: there is nothing to ask about). Each becomes failed through failPayment, one
 * transaction a row, oldest first, at most `limit` a run (the rest wait for the next): a prepayment's failure ends its seat hold, and
 * failPayment takes the registration's lock before it writes the payment row, as every payment path does (the order course_sessions →
 * registrations → payments, db/queries/seats.ts).
 * One bulk UPDATE would write the payment rows with no registration lock at all. That also frees a hold that such a row was keeping for a
 * later, failed attempt of the same registration (releaseHold reads the window of every other pending row). No lock is held after the call.
 * A row whose failing throws is its own failure: `onError(id, error)` is told, it is counted in `errors`, and the next row goes on (a stale
 * row stays in this set until it can be failed, so one that always throws must not stop the rows behind it). MAX_CONSECUTIVE_ERRORS
 * connection errors in a row (isConnectionError) stop that loop: a dead database would only throw on the rest.
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
        inArray(payments.status, OPEN_ORDER),
        or(lte(payments.createdAt, new Date(now.getTime() - GIVE_UP_MS)), and(isNull(payments.providerUuid), oldEnoughToCheck(now))),
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
      onError(id, e);
      // only a lost connection counts towards the stop: any other error is this row's own
      inARow = isConnectionError(e) ? inARow + 1 : 0;
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

// ---------- the admin's lists (phase 2b, spec 8) ----------

/** A payment with what it was for: the course's title and slug (null when the course is gone) and its registration's session day. */
export type PaymentRow = Payment & { courseTitle: I18n | null; courseSlug: string | null; startsAt: Date | null };

/** "Maksed"'s filter: every payment, or one status. */
export type PaymentFilter = "all" | PaymentStatus;

const rowFields = { payment: payments, courseTitle: courses.title, courseSlug: courses.slug, startsAt: courseSessions.startsAt };

function rowQuery(db: Db) {
  return db
    .select(rowFields)
    .from(payments)
    .leftJoin(courses, eq(payments.courseId, courses.id))
    .leftJoin(registrations, eq(payments.registrationId, registrations.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id));
}

const toRow = (r: { payment: Payment; courseTitle: I18n | null; courseSlug: string | null; startsAt: Date | null }): PaymentRow => ({ ...r.payment, courseTitle: r.courseTitle, courseSlug: r.courseSlug, startsAt: r.startsAt });

/**
 * The day "Maksed" shows and sorts a payment by (its "Kuupäev"): the day it was paid, else the day it was started (the owner's default of
 * 10.10: a payment paid later shows its pay day, as Maria's bank statement does). A voided one keeps its paid_at, so it shows its pay day too.
 * The page shows the same day (app/admin/(panel)/maksed/page.tsx).
 */
const listedAt = sql`coalesce(${payments.paidAt}, ${payments.createdAt})`;

/** One page of "Maksed": newest first by listedAt, `size` (50) a page, all or one status. */
export async function pagePayments(db: Db, filter: PaymentFilter, page: number, size: number = PAGE_SIZE): Promise<Paged<PaymentRow>> {
  const where = filter === "all" ? undefined : eq(payments.status, filter);
  return paged(
    page,
    size,
    async () => Number((await db.select({ n: count() }).from(payments).where(where))[0].n),
    async (range) => (await rowQuery(db).where(where).orderBy(desc(listedAt), desc(payments.id)).limit(range.limit).offset(range.offset)).map(toRow),
  );
}

/**
 * The payments of one registration (its drawer), or of one student (the Õpilased drawer): hers, and those of her registrations — a payment
 * made before she had an account carries no client of its own, its registration was linked to her later. Newest first. A replaced order
 * („Asendatud“, B22) is kept for the books and shown in Maksed, but left out here (the drawer's Raha card shows only the latest open order),
 * unless `includeReplaced`.
 */
export async function listPaymentsOf(db: Db, of: ({ registrationId: number } | { clientId: number }) & { includeReplaced?: boolean }): Promise<PaymentRow[]> {
  const whose =
    "registrationId" in of
      ? eq(payments.registrationId, of.registrationId)
      : or(eq(payments.clientId, of.clientId), sql`${payments.registrationId} in (select r.id from registrations r where r.client_id = ${of.clientId})`);
  const where = of.includeReplaced ? whose : and(whose, ne(payments.status, "replaced"));
  return (await rowQuery(db).where(where).orderBy(desc(payments.createdAt), desc(payments.id))).map(toRow);
}
