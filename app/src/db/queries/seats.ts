import { and, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Q, Tx } from "../client";
import { registrations } from "../schema";

// The one seat count (phase 2b, spec 5.3, D2): a registration takes a seat when it is confirmed, or when it is awaiting its prepayment and
// its hold (seat_hold_until, set when the prepayment starts) has not ended. Every counter uses this expression: the registration form's full
// check (server/submit.ts), the public calendar and course page (db/queries/public.ts), the admin's calendar and overview
// (db/queries/admin.ts), and the payment's own checks (server/payments). domain/sessions.ts holdsSeat is the same rule for one row in memory.

/** The condition "this registration takes a seat at `now`", for a query on `registrations`. */
export function takesSeat(now: Date): SQL {
  return sql`(${registrations.status} = 'confirmed' or (${registrations.status} = 'awaiting_prepayment' and ${registrations.seatHoldUntil} > ${now.toISOString()}::timestamptz))`;
}

/**
 * The seats taken at `now` per session id; sessions with none are absent. `except`: leave this registration out (a payment checks the seats
 * of the others: her own hold, live or ended, is not in her way).
 */
export async function seatsTaken(q: Q, sessionIds: number[], now: Date = new Date(), opts: { except?: number } = {}): Promise<Map<number, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await q
    .select({ sessionId: registrations.courseSessionId, taken: sql<number>`count(*) filter (where ${takesSeat(now)})`.mapWith(Number) })
    .from(registrations)
    .where(and(inArray(registrations.courseSessionId, sessionIds), opts.except === undefined ? undefined : ne(registrations.id, opts.except)))
    .groupBy(registrations.courseSessionId);
  return new Map(rows.flatMap((r) => (r.sessionId == null ? [] : [[r.sessionId, r.taken] as const])));
}

/** Is a seat free in `session` at `now`, counting everybody but `except`? */
export async function hasFreeSeat(q: Q, session: { id: number; capacity: number }, now: Date, except?: number): Promise<boolean> {
  const taken = (await seatsTaken(q, [session.id], now, { except })).get(session.id) ?? 0;
  return taken < session.capacity;
}

// ---------- the lock order of every payment path ----------
// course_sessions → registrations → payments, always in this order and never the other way. The start of a payment (server/payments/start.ts)
// locks the session, then the registration, then writes the payment row; a settlement that took the payment row first and the registration
// after it would deadlock with a re-send of the same payment. And the seats of a session are counted under the session's lock, so that two
// late payers, or a late payer and a new registration, cannot both be given the last seat. A path takes the locks it needs, in this order:
// a subset is safe (freeing a seat, failPayment, needs the registration's lock only: it cannot overbook).
//
// Maria's own changes in the admin take no session lock and count no seats: her status change (admin.ts setRegistrationStatus, one
// conditional UPDATE) and her recorded transfer (recordRegistrationPayment, the registration's row lock only) can confirm a place while a
// late payer or a new registration takes the last seat at the same moment, and the session then has one more than its capacity. That is
// accepted: a confirmation by hand is Maria's decision about her own course (D2 checks the seats only for what happens without her: a
// registration, an online payment), the admin's calendar shows her the count, and both take a subset of the order above (the registration
// alone), so they can wait for a payment path or make it wait, but never deadlock with it.
//
// An e-course purchase (phase 2b) has no session and no registration, and its paid transaction takes another order: its purchase's advisory
// lock (server/payments/start.ts lockEcoursePurchase, the start's own: instalments Task 4, so that a late järelmaks's look for a paid purchase
// cannot miss one being settled), its payment row, then the address lock (client-auth.ts lockAddress, through addClient), then the rows linked
// to the address (registrations, requests, subscribers, the client, course_access). The purchase's lock is the first of both paths that take it
// (the start, which then holds that row only, and the settlement), and no other path takes it. That cannot close a cycle with the order above,
// because the two sets of paths share no lock they wait for:
// - the payment rows are disjoint. The registration paths above lock a payment row of kind prepayment or balance (registration_id set);
//   an e-course payment row (kind ecourse, registration_id null) is written only by the e-course's own start (its advisory lock, server/
//   payments/start.ts lockEcoursePurchase, and that row) and its settlement;
// - no writer that holds the address lock waits for an e-course payment row in flight. The logins, addClient, the password and the
//   newsletter write tokens, clients, sessions and the linked records, not payments. The one exception, the deletion of an account
//   (client-data.ts deleteClient), reaches payments through ON DELETE SET NULL, and only those already linked to the client: an e-course
//   payment in flight has no client_id until its own grant writes it, after the address lock.
// So whoever waits on a row the e-course path holds holds neither the address lock nor a row the e-course path waits for (settle.ts openCourse).

/** Locks the registration (FOR UPDATE) until the caller's transaction ends. A registration that does not exist locks nothing. */
export async function lockRegistration(tx: Tx, registrationId: number): Promise<void> {
  await tx.execute(sql`select 1 from registrations where id = ${registrationId} for update`);
}

/**
 * Locks one session row (FOR UPDATE) until the caller's transaction ends. A new registration has no row to lock yet, so server/submit.ts
 * handleRegistration locks its session alone, counts the seats under that lock and inserts the registration (the first lock of the order).
 */
export async function lockSession(tx: Tx, sessionId: number): Promise<void> {
  await tx.execute(sql`select 1 from course_sessions where id = ${sessionId} for update`);
}

/**
 * The locks a payment of a registration needs before it writes anything (settle.ts paid; Tasks 4 and 8 call it first too): the registration's
 * session, then the registration. A registration with no session (an individual course) or none at all locks what there is. Runs in the
 * caller's transaction.
 */
export async function lockForPayment(tx: Tx, registrationId: number): Promise<void> {
  await tx.execute(sql`select 1 from course_sessions where id = (select course_session_id from registrations where id = ${registrationId}) for update`);
  await lockRegistration(tx, registrationId);
}
