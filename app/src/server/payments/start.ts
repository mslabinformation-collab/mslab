import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db, Q, Tx } from "@/db/client";
import { attachOrder, failPayment, insertPayment } from "@/db/queries/payments";
import { hasFreeSeat, lockForPayment } from "@/db/queries/seats";
import { courses, courseSessions, payments, registrations, type Payment } from "@/db/schema";
import { normalizeEmail } from "@/domain/email";
import { amountDue } from "@/domain/payments";
import { registrationPrice } from "@/domain/registration";
import { holdUntil, SEAT_HOLD_MS } from "@/domain/sessions";
import { logNote } from "../log";
import { MontonioError, type Montonio } from "./montonio";

// Every way an online payment starts (phase 2b, spec 6.1, 6.3, 6.4): a pending payment row (a new MSLAB-M<id> for each new attempt), then
// Montonio's order outside any transaction (a 15 s call must not hold a row lock), then the page to send the payer to. When Montonio says no
// or cannot be reached, a new attempt's row is failed and a prepayment's hold ends (db/queries/payments.ts failPayment): nothing breaks, the
// registration stands; a re-send's row stays pending (see order). A start while the same attempt is still open (the same registration and
// kind, or the same e-course and address, the same amount, its order inside Montonio's 30-minute window) re-sends that attempt instead of
// making a second order (the double-payment rule): POST /orders with the same merchantReference overwrites the unpaid order at Montonio
// (spec 4), so the payer never has two orders open to pay.
// The locks are the one order of every payment path (db/queries/seats.ts): the session, then the registration (lockForPayment, taken first),
// then the payment row. Nothing is held across Montonio's call: the transaction commits first, and only then are the order made and the row
// given its uuid (attachOrder) or failed (failPayment, which takes the registration's lock in its own transaction). An e-course purchase has
// no registration to lock: startEcoursePayment serialises the presses of one course and address with an advisory lock (the payment row only).

export type StartDeps = {
  db: Db;
  now: Date;
  /** The base of the payer's way back (the returnUrl): this request's own origin when it is one of ours (server/site.ts linkBase), else SITE_URL. */
  siteUrl: string;
  /**
   * SITE_URL as configured: the base of Montonio's webhook (the notificationUrl), never a request's Origin or Host. Montonio calls it from
   * outside, for up to 48 hours: an allow-listed origin of the moment (the local dev server, a deployment's own Vercel address) may not be
   * reachable then, or not be the production app at all.
   */
  notifyBase: string;
  montonio: Montonio | null;
};

/**
 * started: send the payer to `paymentUrl`. off: no online payments. failed: Montonio said no or did not answer. nothing: nothing to pay now
 * (paid enough, cancelled, past, no price). full: an unconfirmed registration's session has no free seat (D2). rate: STARTS_PER_HOUR starts
 * of this registration in the last hour. notFound: no such registration (or not this client's).
 */
export type StartResult =
  | { kind: "started"; paymentUrl: string }
  | { kind: "off" }
  | { kind: "failed" }
  | { kind: "nothing" }
  | { kind: "full" }
  | { kind: "rate" }
  | { kind: "notFound" };

/**
 * New payment attempts of one registration per hour (spec 10): each one is an order at Montonio and, for a prepayment, a seat hold. A re-send
 * of the open attempt is not a new one (no new row, no second order): the per-IP limit of the /maksa page and the account API counts it.
 */
export const STARTS_PER_HOUR = 5;

/** Payment starts per visitor IP in RATE_WINDOW_SEC (10 minutes), as the forms (spec 10): the /maksa page and POST /api/konto/maksa share the counter. */
export const PAY_STARTS_PER_IP = 5;

/**
 * Montonio's way back: the return (api/payments/return, to the /makse page) on `returnBase`, the address the payer started from when it is one
 * of ours; the webhook (api/payments/notify) always on `notifyBase`, SITE_URL (StartDeps).
 */
export function paymentUrls(returnBase: string, notifyBase: string): { returnUrl: string; notificationUrl: string } {
  const trim = (url: string) => url.replace(/\/+$/, "");
  return { returnUrl: `${trim(returnBase)}/api/payments/return`, notificationUrl: `${trim(notifyBase)}/api/payments/notify` };
}

/**
 * The open attempt of what is being paid now (the double-payment rule): the newest `pending` row of the same registration and kind — or the
 * same e-course and address — with this amount, whose order is still inside Montonio's 30-minute window (SEAT_HOLD_MS; `updated_at` is the
 * row's insert or its last re-send: nothing else touches a pending row). null: there is none, and the start is a new attempt.
 */
async function liveAttempt(
  q: Q,
  of: { registrationId: number; kind: "prepayment" | "balance" } | { courseId: number; email: string },
  amountCents: number,
  now: Date,
): Promise<Payment | null> {
  const which =
    "registrationId" in of
      ? and(eq(payments.registrationId, of.registrationId), eq(payments.kind, of.kind))
      : and(eq(payments.kind, "ecourse"), isNull(payments.registrationId), eq(payments.courseId, of.courseId), eq(payments.email, of.email));
  const [row] = await q
    .select()
    .from(payments)
    .where(and(which, eq(payments.status, "pending"), eq(payments.amountCents, amountCents), gt(payments.updatedAt, new Date(now.getTime() - SEAT_HOLD_MS))))
    .orderBy(desc(payments.id))
    .limit(1);
  return row ?? null;
}

/**
 * Montonio's order for a stored pending row, called with no transaction open. A first sending that gets no order fails the row (and its
 * hold ends). `again`: the row is an open attempt sent again (same reference): Montonio overwrites the unpaid order and may answer a new
 * uuid, which the row takes only while it is still unpaid (status pending, paid_at null: a replaced uuid that landed after a PAID would make a
 * repeat of the paid order look like a double payment, settle.ts). When that UPDATE loses, the row was settled meanwhile: Montonio is not
 * called again, and the answer is "nothing to pay" (or "failed" when the row was failed meanwhile: no one is sent to the replaced order). A
 * token of the order the row had before is settle.ts's doubt case.
 * A re-send that gets no order (Montonio refused it, or did not answer in time) is "failed" too, but its row is NOT failed: the order under
 * that reference may be paid already, its webhook late (Montonio refuses to overwrite a paid order), or the timed-out call may have replaced
 * it after all. The row stays pending with the hold its start refreshed, so the next press re-sends the same reference again — a failed row
 * would make the next press a new attempt with a new reference, a second order she could pay as well. Its webhook, the return or the daily
 * check settles it; failing it is left to them (ABANDONED) and to the daily check's 14 days.
 */
async function order(deps: StartDeps & { montonio: Montonio }, payment: Payment, again = false): Promise<StartResult> {
  let created: { uuid: string; paymentUrl: string };
  try {
    created = await deps.montonio.createOrder({ reference: payment.reference, amountCents: payment.amountCents, locale: payment.locale, ...paymentUrls(deps.siteUrl, deps.notifyBase) });
  } catch (e) {
    logNote(`[payments] payment ${payment.id}: no order${again ? " for the re-send, the payment stays pending" : ""} (${e instanceof MontonioError ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : "error"})`);
    // after the start's commit: failPayment locks the registration in a transaction of its own
    if (!again) await failPayment(deps.db, payment.id, deps.now);
    return { kind: "failed" };
  }
  if (again) {
    const [kept] = await deps.db
      .update(payments)
      .set({ providerUuid: created.uuid, updatedAt: deps.now })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "pending"), isNull(payments.paidAt)))
      .returning();
    if (!kept) {
      const [now] = await deps.db.select({ status: payments.status }).from(payments).where(eq(payments.id, payment.id)).limit(1);
      console.info(`[payments] payment ${payment.id}: settled while it was sent again`);
      return now?.status === "failed" ? { kind: "failed" } : { kind: "nothing" };
    }
  } else await attachOrder(deps.db, payment.id, created.uuid, deps.now);
  console.info(`[payments] payment ${payment.id}: ${again ? "sent again" : "started"}`);
  return { kind: "started", paymentUrl: created.paymentUrl };
}

/**
 * Starts the online payment of a registration (spec 6.1 "Registreeru", 6.3 /maksa and Minu koolitused): what is due now (domain/payments.ts
 * amountDue: the prepayment, or the rest after it), checked under the session's and the registration's locks (lockForPayment, first; the
 * registration is found by an unlocked read, then locked and read again). A prepayment needs a free seat — the others'
 * seats counted, confirmed or held, hers not — and holds it for 30 minutes from now (D2); the rest needs none and holds nothing. The open
 * attempt of the same amount, when there is one, is sent again instead of a new one (liveAttempt; not counted in STARTS_PER_HOUR). `target`:
 * the registration (with `clientId`: only when it is that client's) or its "Maksa" token.
 */
export async function startRegistrationPayment(deps: StartDeps, target: { registrationId: number; clientId?: number } | { payToken: string }): Promise<StartResult> {
  const montonio = deps.montonio;
  if (!montonio) return { kind: "off" };
  const which =
    "payToken" in target
      ? eq(registrations.payToken, target.payToken)
      : and(eq(registrations.id, target.registrationId), target.clientId === undefined ? undefined : eq(registrations.clientId, target.clientId));
  const ready = await deps.db.transaction(async (tx): Promise<StartResult | { kind: "ready"; payment: Payment; again: boolean }> => {
    // (the registration is found by an unlocked read, which locks nothing: the session's lock must come before the registration's)
    const [found] = await tx.select({ id: registrations.id }).from(registrations).where(which).limit(1);
    if (!found) return { kind: "notFound" };
    await lockForPayment(tx, found.id);
    // read again, under both locks: what is due and the seats are decided on what the database holds now
    const [row] = await tx
      .select({ registration: registrations, course: courses, session: courseSessions })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .where(and(eq(registrations.id, found.id), which));
    if (!row) return { kind: "notFound" };
    const { registration: r, course, session } = row;
    const due = amountDue(
      { status: r.status, paymentChoice: r.paymentChoice, priceCents: registrationPrice(course, r.kind), paidCents: r.paidCents, startsAt: session?.startsAt ?? null, sessionCancelled: session?.status === "cancelled" },
      deps.now,
    );
    if (due.kind === "none") return { kind: "nothing" };
    // the open attempt of this amount is sent again, not doubled; it is no new attempt, so it is not counted here
    const live = await liveAttempt(tx, { registrationId: r.id, kind: due.kind }, due.cents, deps.now);
    if (!live) {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(payments)
        .where(and(eq(payments.registrationId, r.id), gt(payments.createdAt, new Date(deps.now.getTime() - 60 * 60_000))));
      if (Number(n) >= STARTS_PER_HOUR) return { kind: "rate" };
    }
    if (due.kind === "prepayment") {
      if (session && !(await hasFreeSeat(tx, session, deps.now, r.id))) return { kind: "full" };
      await tx.update(registrations).set({ seatHoldUntil: holdUntil(deps.now) }).where(eq(registrations.id, r.id));
    }
    if (live) {
      // its window starts again now (and a start at the same moment, waiting for this row lock, finds it open)
      await tx.update(payments).set({ updatedAt: deps.now }).where(and(eq(payments.id, live.id), eq(payments.status, "pending")));
      return { kind: "ready", payment: { ...live, updatedAt: deps.now }, again: true };
    }
    const payment = await insertPayment(
      tx,
      { kind: due.kind, registrationId: r.id, courseId: course.id, clientId: r.clientId, email: r.email, name: r.name, locale: r.locale === "ru" ? "ru" : "et", amountCents: due.cents },
      deps.now,
    );
    return { kind: "ready", payment, again: false };
  });
  if (ready.kind !== "ready") return ready;
  return order({ ...deps, montonio }, ready.payment, ready.again);
}

/**
 * The class of the e-course purchase's advisory lock: the first int of a two-int key (`pg_advisory_xact_lock(int, int)`), whose key space is
 * separate from the one-bigint keys that client-auth.ts lockAddress ("client-login:<address>") and server/auth.ts ("login-token:<address>")
 * take with `hashtext(…)`. A hash collision of a purchase's key with an address's cannot make a purchase wait for a login, or the reverse.
 * Any other two-int lock of the app must use another class.
 */
export const ECOURSE_BUY_LOCK_CLASS = 2_011_001;

/**
 * Serialises the presses of one purchase (one course and address) until the caller's transaction ends: the look for the open attempt and the
 * insert of a new one are then one step for every press at the same moment. Re-entrant within a transaction.
 */
export async function lockEcoursePurchase(tx: Tx, courseId: number, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ECOURSE_BUY_LOCK_CLASS}::int, hashtext(${`${courseId}:${email}`}))`);
}

/**
 * How long after an e-course was paid the same address cannot start another payment for it (Dim's decision of 10.10): Back from the bank
 * brings the cart back with "Maksa" ready, and a press then would charge her a second time. After this time a deliberate second purchase works
 * as before (its payment renews the access: domain/client-access.ts purchaseExpiryDate).
 */
export const ECOURSE_REPAY_WINDOW_MS = 30 * 60_000;

/** What an e-course start can answer: StartResult's, and `alreadyPaid` (the address paid this course in the last ECOURSE_REPAY_WINDOW_MS). */
export type EcourseStartResult = StartResult | { kind: "alreadyPaid" };

/**
 * Did this address pay this e-course in the last ECOURSE_REPAY_WINDOW_MS? A `paid` row counts from its paid_at, a `held` one (the money is at
 * Montonio, Maria is checking) from the moment it was held; a pending, failed or refunded one does not. `email` is normalised already.
 */
async function paidRecently(q: Q, courseId: number, email: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ECOURSE_REPAY_WINDOW_MS);
  const [row] = await q
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.kind, "ecourse"),
        eq(payments.courseId, courseId),
        sql`lower(${payments.email}) = ${email}`,
        or(and(eq(payments.status, "paid"), gt(payments.paidAt, since)), and(eq(payments.status, "held"), gt(payments.updatedAt, since))),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Starts an e-course purchase (spec 6.4): a pending `ecourse` row of the course's price, with the payer as entered and her newsletter wish
 * (acted on when it is paid), and Montonio's order. No account and no access before the payment: an abandoned purchase leaves only this row.
 * The same purchase pressed again while its order is open (the same course, address and price: liveAttempt) is sent again with the latest
 * name, language and newsletter box, never a second order (the double-payment rule). A registration has its own row to lock for that; a
 * purchase has none, so the look for the open attempt and the insert of a new one run under an advisory lock of this course and address
 * (lockEcoursePurchase, in a transaction of its own that ends before Montonio is called): two presses at the same moment find one row, not two.
 * Under the same lock, before any of that: an address that paid this course in the last 30 minutes (paidRecently) starts nothing — `alreadyPaid`,
 * no row and no call to Montonio. It tells her only that, never an amount or a name.
 */
export async function startEcoursePayment(
  deps: StartDeps,
  input: { courseId: number; amountCents: number; email: string; name: string; locale: "et" | "ru"; newsletter: boolean },
): Promise<EcourseStartResult> {
  const montonio = deps.montonio;
  if (!montonio) return { kind: "off" };
  const email = normalizeEmail(input.email);
  const ready = await deps.db.transaction(async (tx): Promise<{ payment: Payment; again: boolean } | { alreadyPaid: true }> => {
    await lockEcoursePurchase(tx, input.courseId, email);
    if (await paidRecently(tx, input.courseId, email, deps.now)) return { alreadyPaid: true };
    const live = await liveAttempt(tx, { courseId: input.courseId, email }, input.amountCents, deps.now);
    if (live) {
      // its window starts again now, and what she typed this time replaces what she typed before
      const fresh = { name: input.name, locale: input.locale, newsletter: input.newsletter, updatedAt: deps.now };
      await tx.update(payments).set(fresh).where(and(eq(payments.id, live.id), eq(payments.status, "pending")));
      return { payment: { ...live, ...fresh }, again: true };
    }
    const payment = await insertPayment(
      tx,
      { kind: "ecourse", registrationId: null, courseId: input.courseId, clientId: null, email, name: input.name, locale: input.locale, amountCents: input.amountCents, newsletter: input.newsletter },
      deps.now,
    );
    return { payment, again: false };
  });
  if ("alreadyPaid" in ready) return { kind: "alreadyPaid" };
  return order({ ...deps, montonio }, ready.payment, ready.again);
}
