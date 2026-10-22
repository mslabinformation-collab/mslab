import { and, count, desc, eq, gt, isNull, not, or, sql } from "drizzle-orm";
import type { Db, Q, Tx } from "@/db/client";
import { attachOrder, failPayment, hirePurchaseRow, insertPayment } from "@/db/queries/payments";
import { readSetting } from "@/db/queries/public";
import { hasFreeSeat, lockForPayment } from "@/db/queries/seats";
import { courses, courseSessions, payments, registrations, type Payment } from "@/db/schema";
import type { ContractSnapshot } from "@/domain/contract";
import { normalizeEmail } from "@/domain/email";
import { attemptWindowMs, billingAddressOf, FINANCING_KEY, financingRefusal, isHirePurchase, readFinancingSettings, type BillingAddress, type FinancingRefusal } from "@/domain/financing";
import { payableDue } from "@/domain/payments";
import { registrationPrice } from "@/domain/registration";
import { holdUntil } from "@/domain/sessions";
import { unpaidInvoiceOf } from "../invoices";
import { logNote } from "../log";
import { MontonioError, type Montonio, type OrderMethod } from "./montonio";

// Every way an online payment starts (phase 2b, spec 6.1, 6.3, 6.4): a pending payment row (a new MSLAB-M<id> for each new attempt, the
// prefix this environment's: montonio.ts), then Montonio's order outside any transaction (a 15 s call must not hold a row lock), then the page
// to send the payer to. When Montonio says no or cannot be reached, a new attempt's row is failed and a prepayment's hold ends
// (db/queries/payments.ts failPayment): nothing breaks, the registration stands; a re-send's row stays pending (see order). A start while the
// same attempt is still open (the same registration, kind and invoice, or the same e-course and address, the same amount and method, its
// order inside its window: Montonio's 30 minutes for the bank, 60 for a järelmaks) re-sends that attempt instead of making a second order (the
// double-payment rule): POST /orders with the same merchantReference overwrites the unpaid order at Montonio (spec 4), so the payer never has
// two orders open to pay. Every start has its method (instalments, D5, §4): the bank link by default, or Järelmaks (Inbank), Montonio's
// `hirePurchase`, only while it is allowed (financingAllowed: Seaded's toggle, read in the start's transaction, the price, nothing paid, the
// whole price due; for a registration, its choice „Järelmaks (Inbank)“). The row records it (`method`); a press of the other method while an
// attempt is open starts a new attempt and never re-sends or overwrites the open one, so a bank payment never replaces a loan application.
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
 * of this registration in the last hour. notFound: no such registration (or not this client's). financing: a järelmaks start that is not
 * allowed now (instalments, §4: Seaded's toggle is off, the price is out of 100–5000 €, something is paid or a part is due, or the
 * registration was booked with another choice): nothing started, she is told to pick another way. `reason` is the sentence she is told
 * (domain/financing.ts financingRefusal): "range" („Järelmaks on võimalik 100–5000 € hinnaga koolitusele.“) when the price is outside the range,
 * else "off" („Järelmaks pole praegu saadaval. Saad maksta pangalingiga.“): switched off, a part paid or due, another choice. It changes the sentence only.
 */
export type StartResult =
  | { kind: "started"; paymentUrl: string }
  | { kind: "off" }
  | { kind: "failed" }
  | { kind: "nothing" }
  | { kind: "full" }
  | { kind: "rate" }
  | { kind: "notFound" }
  | { kind: "financing"; reason: FinancingRefusal };

/** How a start pays: Montonio's method, the bank link ("paymentInitiation") by default, or Järelmaks (Inbank) ("hirePurchase"). */
export type StartOptions = { method?: OrderMethod };

/**
 * May a järelmaks start now (instalments, §4 "Which amount may go to Inbank")? Seaded's toggle as stored right now — read in the start's own
 * transaction, so a toggle switched off a moment ago refuses new loans (an open order finishes as it is) — and financingAllowed's rules on
 * the price, what is paid and what is due. Payments are on: the start has Montonio. null: it may start; else why not (financingRefusal), which
 * decides the sentence she is told and nothing else.
 */
async function financingRefusedNow(q: Q, o: { priceCents: number | null; paidCents: number; dueCents: number }): Promise<FinancingRefusal | null> {
  const { enabled } = readFinancingSettings(await readSetting(q, FINANCING_KEY));
  return financingRefusal({ enabled, paymentsOn: true, ...o });
}

/** The method a stored row is sent with: the järelmaks for a `hirePurchase` row, else the bank (a row from before the methods too). */
const methodOfRow = (p: Payment): OrderMethod => (isHirePurchase(p.method) ? "hirePurchase" : "paymentInitiation");

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
 * The open attempt of what is being paid now (the double-payment rule): the newest `pending` row of the same registration, kind and invoice
 * (the unpaid invoice it was started for, or none: invoices, D5) — or the same e-course and address — with this amount and this method (a
 * `hirePurchase` row for a järelmaks, any other for the bank: hirePurchaseRow), whose order is still inside its window (attemptWindowMs:
 * Montonio's 30 minutes for the bank, the järelmaks' 60; `updated_at` is the row's insert or its last re-send: nothing else touches a pending
 * row). null: there is none, and the start is a new attempt — also while an attempt of the other method is open (instalments, §4).
 */
async function liveAttempt(
  q: Q,
  of: { registrationId: number; kind: "prepayment" | "balance"; invoiceId: number | null } | { courseId: number; email: string },
  amountCents: number,
  method: OrderMethod,
  now: Date,
): Promise<Payment | null> {
  const which =
    "registrationId" in of
      ? and(
          eq(payments.registrationId, of.registrationId),
          eq(payments.kind, of.kind),
          of.invoiceId === null ? isNull(payments.invoiceId) : eq(payments.invoiceId, of.invoiceId),
        )
      : and(eq(payments.kind, "ecourse"), isNull(payments.registrationId), eq(payments.courseId, of.courseId), eq(payments.email, of.email));
  const sameMethod = method === "hirePurchase" ? hirePurchaseRow : not(hirePurchaseRow);
  const [row] = await q
    .select()
    .from(payments)
    .where(and(which, sameMethod, eq(payments.status, "pending"), eq(payments.amountCents, amountCents), gt(payments.updatedAt, new Date(now.getTime() - attemptWindowMs(method)))))
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
 * The order is the row's method (methodOfRow): a järelmaks row's carries `billing` (her details for Inbank's form, D8), its first sending and
 * every re-send alike; a bank row's never does.
 */
async function order(deps: StartDeps & { montonio: Montonio }, payment: Payment, again: boolean, billing: BillingAddress | null): Promise<StartResult> {
  const method = methodOfRow(payment);
  let created: { uuid: string; paymentUrl: string };
  try {
    created = await deps.montonio.createOrder({
      reference: payment.reference,
      amountCents: payment.amountCents,
      locale: payment.locale,
      ...paymentUrls(deps.siteUrl, deps.notifyBase),
      method,
      ...(method === "hirePurchase" && billing ? { billing } : {}),
    });
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
 * payableDue: the prepayment, or the rest after it, amountDue; or, while the registration has an unpaid invoice, exactly that invoice's
 * amount, on the course day too: invoices, D5), checked under the session's and the registration's locks (lockForPayment, first; the
 * registration is found by an unlocked read, then locked and read again, and its latest unpaid invoice read under them). The payment row
 * records the invoice it pays (`invoice_id`): settle.ts then pays that invoice instead of making one. An unconfirmed registration's payment
 * (amountDue's prepayment, or an invoice's prepayment or rest) needs a free seat — the others' seats counted, confirmed or held, hers not —
 * and holds it for the attempt's window from now (D2: 30 minutes for the bank, 60 for a järelmaks: attemptWindowMs), never ending a longer
 * hold sooner (her open järelmaks attempt's, when she presses the bank meanwhile); a confirmed registration's needs none and holds nothing.
 * The open attempt of the same amount, invoice and method, when there is one, is sent again instead of a new one (liveAttempt; not counted
 * in STARTS_PER_HOUR). `target`: the registration (with `clientId`: only when it is that client's) or its "Maksa" token.
 * `opts.method`: the bank link by default; "hirePurchase" (Järelmaks (Inbank), instalments §4) only for a registration booked with that
 * choice and while financingRefusedNow allows it, else `financing` — the bank stays open to every registration, a järelmaks one included (she
 * pays the whole price by bank). A järelmaks order carries her name, e-mail and (an Estonian) phone for Inbank's form (billingAddressOf, D8).
 */
export async function startRegistrationPayment(
  deps: StartDeps,
  target: { registrationId: number; clientId?: number } | { payToken: string },
  opts: StartOptions = {},
): Promise<StartResult> {
  const montonio = deps.montonio;
  if (!montonio) return { kind: "off" };
  const method: OrderMethod = opts.method ?? "paymentInitiation";
  const which =
    "payToken" in target
      ? eq(registrations.payToken, target.payToken)
      : and(eq(registrations.id, target.registrationId), target.clientId === undefined ? undefined : eq(registrations.clientId, target.clientId));
  const ready = await deps.db.transaction(async (tx): Promise<StartResult | { kind: "ready"; payment: Payment; again: boolean; billing: BillingAddress | null }> => {
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
    const priceCents = registrationPrice(course, r.kind);
    // (unpaidInvoiceOf is a plain read: every change of the registration's invoices takes lockForPayment first, so it cannot change before
    // this commits)
    const due = payableDue(
      { status: r.status, paymentChoice: r.paymentChoice, priceCents, paidCents: r.paidCents, startsAt: session?.startsAt ?? null, sessionCancelled: session?.status === "cancelled" },
      await unpaidInvoiceOf(tx, r.id),
      deps.now,
    );
    if (due.kind === "none") return { kind: "nothing" };
    // a järelmaks only for a registration booked with that choice, and only while it is allowed now: the toggle, the price, nothing paid and
    // the whole price due (an invoice of a part, or a part recorded by hand, is paid by bank)
    if (method === "hirePurchase") {
      const refusal = await financingRefusedNow(tx, { priceCents, paidCents: r.paidCents, dueCents: due.cents });
      // (a registration booked with another choice, with the rules otherwise met: the price is necessarily within the range, so "not available now")
      if (r.paymentChoice !== "financing" || refusal !== null) return { kind: "financing", reason: refusal ?? "off" };
    }
    // the invoice this payment pays, when payableDue charged one
    const invoiceId = "invoiceId" in due ? due.invoiceId : null;
    // the open attempt of this amount (and invoice) and method is sent again, not doubled; it is no new attempt, so it is not counted here
    const live = await liveAttempt(tx, { registrationId: r.id, kind: due.kind, invoiceId }, due.cents, method, deps.now);
    if (!live) {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(payments)
        .where(and(eq(payments.registrationId, r.id), gt(payments.createdAt, new Date(deps.now.getTime() - 60 * 60_000))));
      if (Number(n) >= STARTS_PER_HOUR) return { kind: "rate" };
    }
    // an unconfirmed registration's payment, whatever it pays (amountDue's prepayment, or an invoice's prepayment or rest), would confirm her
    // place: it needs a free seat and holds it; a confirmed one holds its place already
    if (r.status === "awaiting_prepayment") {
      if (session && !(await hasFreeSeat(tx, session, deps.now, r.id))) return { kind: "full" };
      // for this attempt's window from now; a hold that ends later is kept (her järelmaks attempt's 60 minutes, still open when she presses
      // the bank: the bank's 30 must not end it before the loan's own window)
      const until = holdUntil(deps.now, attemptWindowMs(method));
      const seatHoldUntil = r.seatHoldUntil !== null && r.seatHoldUntil.getTime() > until.getTime() ? r.seatHoldUntil : until;
      await tx.update(registrations).set({ seatHoldUntil }).where(eq(registrations.id, r.id));
    }
    // her details for Inbank's form (D8): a järelmaks order's only
    const billing = method === "hirePurchase" ? billingAddressOf({ name: r.name, email: r.email, phone: r.phone }) : null;
    if (live) {
      // its window starts again now (and a start at the same moment, waiting for this row lock, finds it open)
      await tx.update(payments).set({ updatedAt: deps.now }).where(and(eq(payments.id, live.id), eq(payments.status, "pending")));
      return { kind: "ready", payment: { ...live, updatedAt: deps.now }, again: true, billing };
    }
    const payment = await insertPayment(
      tx,
      { kind: due.kind, registrationId: r.id, courseId: course.id, clientId: r.clientId, email: r.email, name: r.name, locale: r.locale === "ru" ? "ru" : "et", amountCents: due.cents, invoiceId, method },
      deps.now,
      montonio.referencePrefix,
    );
    return { kind: "ready", payment, again: false, billing };
  });
  if (ready.kind !== "ready") return ready;
  return order({ ...deps, montonio }, ready.payment, ready.again, ready.billing);
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
 * insert of a new one are then one step for every press at the same moment. Re-entrant within a transaction. The settlement of a PAID
 * purchase takes it too, first (settle.ts paid: a late järelmaks looks for a paid purchase of the same course and address under it).
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
 * `contract` (contracts, §4) is the contract the cart showed, filled (submit.ts handleEcoursePurchase): the row keeps it (`contract_snapshot`), a
 * re-send keeps this press's, and settle freezes it when the payment is paid. None (a caller without a cart): the terms gate asks her later.
 * `method` (instalments, §4): the bank link by default; "hirePurchase" (Järelmaks (Inbank)) only while financingRefusedNow allows it for this
 * price, else `financing` (no row, no order), after the alreadyPaid check. Its re-send window is the järelmaks' 60 minutes, a press of the
 * other method is another purchase (liveAttempt), and its order carries her name and e-mail for Inbank's form (the cart asks for no phone, D8).
 */
export async function startEcoursePayment(
  deps: StartDeps,
  input: { courseId: number; amountCents: number; email: string; name: string; locale: "et" | "ru"; newsletter: boolean; contract?: ContractSnapshot | null; method?: OrderMethod },
): Promise<EcourseStartResult> {
  const montonio = deps.montonio;
  if (!montonio) return { kind: "off" };
  const method: OrderMethod = input.method ?? "paymentInitiation";
  const email = normalizeEmail(input.email);
  const ready = await deps.db.transaction(async (tx): Promise<{ payment: Payment; again: boolean } | { alreadyPaid: true } | { financing: FinancingRefusal }> => {
    await lockEcoursePurchase(tx, input.courseId, email);
    if (await paidRecently(tx, input.courseId, email, deps.now)) return { alreadyPaid: true };
    // a järelmaks only while it is allowed for this price (nothing of it is paid: a purchase is paid whole or not at all)
    if (method === "hirePurchase") {
      const refusal = await financingRefusedNow(tx, { priceCents: input.amountCents, paidCents: 0, dueCents: input.amountCents });
      if (refusal !== null) return { financing: refusal };
    }
    const live = await liveAttempt(tx, { courseId: input.courseId, email }, input.amountCents, method, deps.now);
    if (live) {
      // its window starts again now, and what she typed this time replaces what she typed before (the contract this press showed too)
      const fresh = { name: input.name, locale: input.locale, newsletter: input.newsletter, contractSnapshot: input.contract ?? null, updatedAt: deps.now };
      await tx.update(payments).set(fresh).where(and(eq(payments.id, live.id), eq(payments.status, "pending")));
      return { payment: { ...live, ...fresh }, again: true };
    }
    const payment = await insertPayment(
      tx,
      { kind: "ecourse", registrationId: null, courseId: input.courseId, clientId: null, email, name: input.name, locale: input.locale, amountCents: input.amountCents, newsletter: input.newsletter, contractSnapshot: input.contract ?? null, method },
      deps.now,
      montonio.referencePrefix,
    );
    return { payment, again: false };
  });
  if ("alreadyPaid" in ready) return { kind: "alreadyPaid" };
  if ("financing" in ready) return { kind: "financing", reason: ready.financing };
  // her details for Inbank's form (D8), as she typed them this time: a järelmaks order's only
  const billing = method === "hirePurchase" ? billingAddressOf({ name: input.name, email }) : null;
  return order({ ...deps, montonio }, ready.payment, ready.again, billing);
}
