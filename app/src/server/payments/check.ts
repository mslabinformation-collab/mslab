import { expireStalePending, holdsEnded, pendingToCheck } from "@/db/queries/payments";
import { logFailure, logNote } from "../log";
import { factsOf, settlePayment, type SettleDeps } from "./settle";

// The daily check of pending payments (phase 2b, spec 6.6), run by the daily cron (app/api/cron/sweep). The webhook is retried for 48 hours
// and the return happens only when the payer comes back, so a payment whose webhook never got through, or whose payer closed the bank's page,
// is settled here: Montonio is asked (GET /orders/:uuid) and its answer goes through the one door (settle.ts). Counts only in the answer and
// the log: no reference, no address. No lock or transaction is open while Montonio is asked: every database step is its own short
// transaction (the door's, and failPayment's), taken in the order of every payment path (db/queries/seats.ts).

/** At most this many GET /orders a run, and at most this many stale rows failed (the run's other parts share its time). */
export const CHECK_BATCH = 50;

const DAY_MS = 86_400_000;

/**
 * What the check did: payments asked about (`checked`), settled to another status (`settled`), not answered (`unanswered`, asked again
 * tomorrow), failed for good without asking (`expired`), still to do (`left`, at least: stale rows beyond the batch, and payments still to ask
 * about); `outOfTime`: the deadline came first; `holdsEnded`: holds that ended in the last day (the seats were revalidated).
 */
export type PaymentSweep = { checked: number; settled: number; unanswered: number; expired: number; left: number; outOfTime: boolean; holdsEnded: number };

/** The check without payments (no keys): nothing. */
export const NO_PAYMENT_SWEEP: PaymentSweep = { checked: 0, settled: 0, unanswered: 0, expired: 0, left: 0, outOfTime: false, holdsEnded: 0 };

/**
 * Runs the check (spec 6.6): pending rows of 14 days and orders never created (no uuid after CHECK_AFTER_MS) fail, through failPayment
 * (db/queries/payments.ts expireStalePending: at most CHECK_BATCH, oldest first); then each pending payment older than CHECK_AFTER_MS and
 * younger than 14 days, oldest first, at most CHECK_BATCH, is asked about and settled — no new one after `until` (epoch ms, by `clock`; a
 * request begun is finished: it has 15 s at most). Last, when holds ended in the last day, or a failed row released one, the seats are
 * revalidated (the calendar's "Täis" of a hold that ended). A failing database throws (the cron answers 500, and what is not done waits for
 * tomorrow; so does a payment whose settlement met a transient error, settle.ts openCourse); Montonio not answering is only counted.
 */
export async function checkPendingPayments(deps: SettleDeps, until: number, clock: () => number = () => Date.now()): Promise<PaymentSweep> {
  const stale = await expireStalePending(deps.db, deps.now, CHECK_BATCH);
  const rows = await pendingToCheck(deps.db, deps.now, CHECK_BATCH + 1);
  let checked = 0;
  let settled = 0;
  let unanswered = 0;
  let outOfTime = false;
  for (const row of rows.slice(0, CHECK_BATCH)) {
    if (clock() > until) {
      outOfTime = true;
      break;
    }
    checked++;
    const snapshot = await deps.montonio.fetchOrder(row.providerUuid ?? "");
    if (!snapshot) {
      unanswered++;
      continue;
    }
    if (snapshot.reference !== row.reference) {
      logNote(`[payments] payment ${row.id}: Montonio's order is not this payment's; nothing changes`);
      continue;
    }
    const after = await settlePayment(deps, row, factsOf(snapshot));
    if (after.status !== row.status) settled++;
  }
  const ended = await holdsEnded(deps.db, new Date(deps.now.getTime() - DAY_MS), deps.now);
  if (ended > 0 || stale.released > 0) {
    try {
      await deps.changed?.({ kind: "seats" });
    } catch (e) {
      // the payments are settled: a calendar that cannot be told now catches up with its own revalidate
      logFailure("[payments] revalidating the seats failed", e);
    }
  }
  return { checked, settled, unanswered, expired: stale.failed, left: rows.length - checked + stale.left, outOfTime, holdsEnded: ended };
}
