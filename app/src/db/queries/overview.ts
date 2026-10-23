import { asc, count, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { payments, registrations, requestKind, requests, reviews } from "../schema";
import { isCheckReason, type CheckReason } from "@/domain/payments";
import type { RequestKind } from "./admin";
import { assessmentQueue } from "./assessment";
import { NEEDS_CHECK, UNINVOICED_PAID } from "./payment-checks";

// „Sinu järjekord“ on the overview (admin UX pass piece 2, A1; README A1, P-1): what waits for Maria, one number per source, and for the sources
// whose hint names one, the oldest row that waits (when, and whose). The rules are the menu badges' (admin.ts adminCounts; payment-checks.ts
// for the two payment sources), counted here with a name beside them. Callers have checked the admin session; nothing here does authorization.

/** The row that has waited longest: when it started to wait, and whose it is (a registration's, a payer's or a reviewer's name). */
export type Oldest = { at: Date; name: string };

export type OverviewQueue = {
  /** Registrations that wait for their prepayment (status awaiting_prepayment), oldest by when it was made. */
  awaiting: { count: number; oldest: Oldest | null };
  /** What waits in Hindamine, per group: practical works, test answers, students out of tries (db/queries/assessment.ts). */
  assessment: { count: number; practical: number; test: number; triesUsed: number };
  /** Requests not marked done, per kind: „Muutmine“ (change_request) included, as the menu badge counts it. */
  requests: { count: number; byKind: Record<RequestKind, number> };
  /** Paid payments no invoice names (UNINVOICED_PAID), oldest by the day it was paid. A held or voided payment is never here: it is `check`. */
  unbilled: { count: number; oldest: Oldest | null };
  /** Reviews waiting for „Avalda“ (status pending), oldest by when it was written. */
  reviews: { count: number; oldest: Oldest | null };
  /**
   * Payments Maria must look at in Montonio (NEEDS_CHECK: held, or voided after they were paid), oldest by the day it was paid (a held one with
   * no pay day: by when it was made). `reason`: why the oldest one waits, when it has a reason this code knows („Topeltmakse — tagasta“).
   */
  check: { count: number; oldest: Oldest | null; reason: CheckReason | null };
};

/** `count(*)` of the whole selection, repeated on each row: with `limit 1` one query gives the oldest row and how many there are. */
const total = sql<number>`count(*) over ()`.mapWith(Number);

/**
 * What waits for Maria. `now` is the overview's own instant, as every read of the page takes one (the page and the tests pass it): nothing of the
 * queue depends on the time (an old row is not a row that stopped waiting), so the numbers are the same whenever they are read.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the agreed shape (db, now), see above
export async function overviewQueue(db: Db, now: Date): Promise<OverviewQueue> {
  const [awaiting, assessment, byKind, unbilled, reviewsWaiting, check] = await Promise.all([
    awaitingPrepayment(db),
    assessmentQueue(db),
    db.select({ kind: requests.kind, n: count() }).from(requests).where(eq(requests.handled, false)).groupBy(requests.kind),
    unbilledPayments(db),
    pendingReviews(db),
    paymentsToCheck(db),
  ]);
  const perKind = Object.fromEntries(requestKind.enumValues.map((kind) => [kind, 0])) as Record<RequestKind, number>;
  for (const row of byKind) perKind[row.kind] = Number(row.n);
  return {
    awaiting,
    assessment: {
      count: assessment.practicals.length + assessment.tests.length + assessment.triesUsed.length,
      practical: assessment.practicals.length,
      test: assessment.tests.length,
      triesUsed: assessment.triesUsed.length,
    },
    requests: { count: Object.values(perKind).reduce((a, b) => a + b, 0), byKind: perKind },
    unbilled,
    reviews: reviewsWaiting,
    check,
  };
}

async function awaitingPrepayment(db: Db): Promise<OverviewQueue["awaiting"]> {
  const [row] = await db
    .select({ n: total, at: registrations.createdAt, name: registrations.name })
    .from(registrations)
    .where(eq(registrations.status, "awaiting_prepayment"))
    .orderBy(asc(registrations.createdAt), asc(registrations.id))
    .limit(1);
  return row ? { count: row.n, oldest: { at: row.at, name: row.name } } : { count: 0, oldest: null };
}

async function pendingReviews(db: Db): Promise<OverviewQueue["reviews"]> {
  const [row] = await db
    .select({ n: total, at: reviews.writtenAt, name: reviews.name })
    .from(reviews)
    .where(eq(reviews.status, "pending"))
    .orderBy(asc(reviews.writtenAt), asc(reviews.id))
    .limit(1);
  return row ? { count: row.n, oldest: { at: row.at, name: row.name } } : { count: 0, oldest: null };
}

/** The oldest payment `where` selects (by its pay day, else by when it was made) and how many there are. */
async function oldestPayment(db: Db, where: SQL) {
  const [row] = await db
    .select({ n: total, paidAt: payments.paidAt, createdAt: payments.createdAt, name: payments.name, reason: payments.checkReason })
    .from(payments)
    .where(where)
    .orderBy(asc(sql`coalesce(${payments.paidAt}, ${payments.createdAt})`), asc(payments.id))
    .limit(1);
  return row ? { count: row.n, oldest: { at: row.paidAt ?? row.createdAt, name: row.name }, reason: row.reason } : null;
}

async function unbilledPayments(db: Db): Promise<OverviewQueue["unbilled"]> {
  const found = await oldestPayment(db, UNINVOICED_PAID);
  return found ? { count: found.count, oldest: found.oldest } : { count: 0, oldest: null };
}

async function paymentsToCheck(db: Db): Promise<OverviewQueue["check"]> {
  const found = await oldestPayment(db, NEEDS_CHECK);
  if (!found) return { count: 0, oldest: null, reason: null };
  return { count: found.count, oldest: found.oldest, reason: isCheckReason(found.reason) ? found.reason : null };
}
