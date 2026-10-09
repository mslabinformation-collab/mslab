import { and, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Q } from "../client";
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
