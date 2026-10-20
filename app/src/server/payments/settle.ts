import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { addRegistrationPayment, type RegistrationPaid } from "@/db/queries/admin";
import { failPayment, isConnectionError, paymentByProviderUuid, paymentByReference, paymentContext, type PaymentContext } from "@/db/queries/payments";
import { lockForPayment } from "@/db/queries/seats";
import { dbErrorCode } from "@/db/safe-error";
import { payments, type Contract, type Invoice, type Payment } from "@/db/schema";
import { contractStudent } from "@/domain/contract";
import { isSampleAddress } from "@/domain/email";
import { invoiceFileName } from "@/domain/invoice";
import { referenceId } from "@/domain/payments";
import { registrationPrice } from "@/domain/registration";
import { pick } from "@/i18n/field";
import { contractAttachment, ecourseOpenMail, registrationPaidMail } from "../account-mail";
import type { PublicChange } from "../cache-targets";
import { issueClientLogin } from "../client-auth";
import { accessContractFields, contractForAccess, contractPdfForMail, markContractSent } from "../contracts";
import { invoiceForPaidPayment, invoicePdf } from "../invoices";
import { logFailure, logNote } from "../log";
import { overpaymentSummary, paymentAlertSummary, paymentSummary, recordedAfterAlertSummary, stuckPaymentSummary, type PaymentNotice } from "../messages";
import { adminUrl, mailConfigured, notifyMaria, sendMail, type Env, type MailAttachment } from "../notify";
import { forgetKey, releaseSlot, reserveSlot } from "../ratelimit";
import type { SubscriberSync } from "../resend-marketing";
import { subscribeLater } from "../submit";
import { grantPurchase, type Grant } from "./grant";
import type { Montonio, MontonioStatus, OrderSnapshot, OrderToken, RefundToken } from "./montonio";

// The one door of every paid path (phase 2b, spec 6.2, 7.3, 7.4; Rempire's settle/apply/token-guard, ported). The webhook and the return
// (routes.ts) bring an order token, the daily check (check.ts) and a refund notice (settleRefund) Montonio's own answer; all of them end in
// settlePayment:
// - PAID with the row's exact amount in EUR moves the row pending|failed → paid in ONE conditional UPDATE (paid_at null: a payment voided
//   after paid never comes back). Only the winner of that update does the once-only work, in the same transaction: the amount is added to
//   the registration (db/queries/admin.ts addRegistrationPayment: confirmed from 50 %, unless the course is full, D2), or, for an e-course, its
//   client is found or created and the course opened (grant.ts, in a savepoint: a grant that throws is rolled back alone, the row stays paid
//   and Maria is told at once that nothing was opened, unless the error is a transient database one, which rolls everything back and leaves
//   the row pending for the next call; openCourse also says why this order of locks cannot deadlock). After it: the seats are revalidated, and
//   the payer's mail and Maria's notice go out after the response (an e-course's with a login code, and the newsletter sign-up when it was
//   ticked), Maria's "Ülemakse" when the payment took the registration's paid sum over its price (alertIfOverpaid), and "Makse on nüüd kirja
//   pandud" when she had been told "Makse vajab kontrolli" about it (followUpUnsettled: she may have recorded it by hand). Every other caller
//   finds the row paid and does nothing.
//   The winner's transaction also gives the payment its invoice (invoices, spec D5, §6.1; server/invoices.ts invoiceForPaidPayment, once, after
//   the amount is added or the course opened): the unpaid invoice it was started for is paid, else one is born paid (none while Seaded's
//   seller is empty). It runs in a savepoint (invoiceStep, ruling R13): an invoice that cannot be made never undoes the payment, which then
//   waits in „Arveta maksed" for its catch-up. The payer's mail carries the invoice's PDF and „Arve on lisatud." (no invoice, or a PDF that
//   fails to render: the mail goes without both).
//   An e-course's winner also freezes the purchase's contract beside the grant (contracts, §4; contractStep, in a savepoint as the invoice
//   step): the copy the cart showed, kept on the row since the start. A contract that cannot be made never undoes the payment or the grant: the
//   terms gate asks her later. The paid mail carries its PDF after the invoice's, with „Leping on lisatud.“.
// - PAID with another amount or currency (or none that can be read): held. Nothing is confirmed or opened; Maria is alerted.
// - failed: a pending row fails, and a prepayment's hold ends (the seat is free again). paid is a floor: a later ABANDONED or FAILED changes
//   nothing; a VOIDED (the bank took a paid payment back) is stored as failed with its paid_at and alerts Maria, who decides.
// - refunded: stored and alerted; paidCents, the status and access stay (Maria refunds in Montonio's dashboard and adjusts in the admin).
// - pending: nothing.
// The row a caller holds may be old (the webhook, the return and the daily check run at the same moment): every change is a conditional UPDATE
// that names the status it expects, and what loses is answered with the row as the database has it.
// A token in doubt — another accessKey or none, a uuid that is not the row's, or expired beyond the tolerance — is confirmed with
// GET /orders/:uuid about the order the token names (the row's own when it names none), and Montonio's answer is used; no answer:
// "unconfirmed" (the webhook's 503: Montonio retries). That order may be one the row has since replaced: a retry while the attempt is open
// re-sends its merchantReference (start.ts) and Montonio may answer a new uuid, which the row then carries. A replaced order moves the row
// only with money (paid, and the row takes that order's uuid), never with its end: the row follows its newer order.
// A second order's "Topeltmakse" is sent once: the return's signed token can be reloaded and the webhook retried for 48 hours, and each of them
// brings the same paid second order here again. The order's uuid is recorded in the KV when the alert is taken (pay:double:<payment>:<uuid>, 14
// days) and an alert that reached no one gives its record back, so the next call tells Maria.
// These mails follow real payments only: they are not counted in the daily caps, and a sample address is never mailed. Logs carry the payment
// id and its status only: no address, no token, no key.

export type SettleDeps = {
  db: Db;
  /** The settings and the KV store (Telegram's chat id), for the mails and Maria's notice. */
  env: Env;
  now: Date;
  /** The base of the links in the mails: SITE_URL for the webhook and the daily check, the request's own origin for the return. */
  siteUrl: string;
  /** Runs work after the response: the mails and Maria's notice (next/server after(); collected and awaited in the tests). */
  later: (task: () => Promise<unknown>) => void;
  /** Told when a payment changed the seats, so the calendar and the course page render again (server/public-cache.ts). */
  changed?: (change: PublicChange) => Promise<void> | void;
  montonio: Montonio;
  /** The newsletter's sync to Resend of a purchase's "Soovin MS LABi uudiseid" (submit.ts Deps.newsletterSync); absent: none. */
  newsletterSync?: SubscriberSync;
};

/** What Montonio says about a payment: from a token, or from GET /orders/:uuid (factsOf). */
export type Facts = { uuid: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string; bank: string };

/** unknown: no row has this reference (logged, the webhook's 200); unconfirmed: in doubt and Montonio did not answer (the webhook's 503). */
export type SettleResult = { kind: "unknown" } | { kind: "unconfirmed"; payment: Payment } | { kind: "done"; payment: Payment };

/** GET /orders/:uuid's answer as facts. The bank's name is only in a token: `bank` keeps the one a token gave. */
export const factsOf = (s: OrderSnapshot, bank = ""): Facts => ({ uuid: s.uuid, status: s.status, rawStatus: s.rawStatus, amountCents: s.amountCents, currency: s.currency, method: s.method, bank });

/**
 * The once-only work's outcome: the paid row, and what it did to its registration, or the e-course it opened (phase 2b Task 7) with its contract
 * (contracts, §4); its invoice.
 */
type Won = { payment: Payment; registration: RegistrationPaid | null; grant: Grant | null; contract: Contract | null; invoice: Invoice | null };

/**
 * The door of an order token (the webhook, the return). A reference without this environment's prefix (Montonio.referencePrefix: a local
 * run's MSLAB-L<id> on the sandbox store production shares, its webhook signed with the same keys) is no payment of ours: unknown, before
 * the database or Montonio is asked, and logged without the reference.
 */
export async function settleToken(deps: SettleDeps, token: OrderToken): Promise<SettleResult> {
  if (referenceId(token.reference, deps.montonio.referencePrefix) === null) {
    logNote("[payments] an order token for a reference of another environment: nothing to settle");
    return { kind: "unknown" };
  }
  const row = await paymentByReference(deps.db, token.reference);
  if (!row) {
    logNote("[payments] an order token for an unknown reference: nothing to settle");
    return { kind: "unknown" };
  }
  const facts: Facts = { uuid: token.uuid, status: token.status, rawStatus: token.rawStatus, amountCents: token.amountCents, currency: token.currency, method: token.method, bank: token.bank };
  const doubt = token.accessKey !== deps.montonio.accessKey || (row.providerUuid !== null && token.uuid !== row.providerUuid) || token.expired;
  // a pending token moves nothing, so there is nothing to ask about
  if (!doubt || token.status === "pending") return { kind: "done", payment: await settlePayment(deps, row, facts) };
  // the order the token names (it may be one this row has replaced since: start.ts re-sends an open attempt); none named: the row's own
  const snapshot = await deps.montonio.fetchOrder(token.uuid || row.providerUuid || "");
  if (!snapshot) {
    logNote(`[payments] payment ${row.id}: a token in doubt, and Montonio did not answer`);
    return { kind: "unconfirmed", payment: row };
  }
  if (snapshot.reference !== row.reference) {
    logNote(`[payments] payment ${row.id}: Montonio's order is not this payment's; nothing changes`);
    return { kind: "done", payment: row };
  }
  // an order the row has replaced counts only with its money: its end (ABANDONED, …) is not the end of the row's newer order
  if (row.providerUuid !== null && snapshot.uuid !== row.providerUuid && snapshot.status !== "paid") {
    logNote(`[payments] payment ${row.id}: an order it has replaced says ${snapshot.status}; nothing changes`);
    return { kind: "done", payment: row };
  }
  return { kind: "done", payment: await settlePayment(deps, row, factsOf(snapshot, token.bank)) };
}

/**
 * The door of a refund notice (the webhook's `{ refundToken }`, routes.ts). The token says which order a refund is about, and nothing in it
 * is trusted for the status (its refundStatus and refundAmount are the refund's, not the order's): the payment whose order that is
 * (provider_uuid) is found, Montonio is asked (GET /orders/:uuid), and its answer goes through settlePayment like the daily check's.
 * REFUNDED or PARTIALLY_REFUNDED then make the payment refunded, with Maria's alert (once: refunded() is a conditional UPDATE); a refund that
 * is still pending, or was rejected, leaves the order PAID, which changes nothing. No payment has that order (a second order Maria refunds
 * after a "Topeltmakse" is no payment's): unknown, logged with no id. Montonio does not answer: unconfirmed (the webhook's 503, retried).
 */
export async function settleRefund(deps: SettleDeps, token: RefundToken): Promise<SettleResult> {
  const row = await paymentByProviderUuid(deps.db, token.orderUuid);
  if (!row) {
    logNote("[payments] a refund notice for an unknown order: nothing to settle");
    return { kind: "unknown" };
  }
  const snapshot = await deps.montonio.fetchOrder(token.orderUuid);
  if (!snapshot) {
    logNote(`[payments] payment ${row.id}: a refund notice, and Montonio did not answer`);
    return { kind: "unconfirmed", payment: row };
  }
  if (snapshot.reference !== row.reference) {
    logNote(`[payments] payment ${row.id}: Montonio's order is not this payment's; nothing changes`);
    return { kind: "done", payment: row };
  }
  return { kind: "done", payment: await settlePayment(deps, row, factsOf(snapshot)) };
}

/** The door itself: `facts` applied to `row` (see the top of the file). Answers the row as it is afterwards. */
export async function settlePayment(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  switch (facts.status) {
    case "paid":
      return paid(deps, row, facts);
    case "failed":
      return failed(deps, row, facts);
    case "refunded":
      return refunded(deps, row, facts);
    default:
      return row;
  }
}

/** The row as the database has it now (after a conditional update another caller won). */
const current = async (deps: SettleDeps, row: Payment): Promise<Payment> => (await paymentByReference(deps.db, row.reference)) ?? row;

/**
 * A paid or held update that was not won: the row as the database has it. If that row took money before, under another order than the one
 * that is told now (the replaced order and the live one of a re-sent payment were both paid), this order's money arrived unrecorded: it is not
 * counted twice and the row is not changed, but Maria is told ("Topeltmakse") and refunds one of them in Montonio. A fact with no order id
 * says nothing about another order.
 */
async function lost(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  const latest = await current(deps, row);
  if (latest.paidAt !== null && latest.providerUuid !== null && facts.uuid !== "" && facts.uuid !== latest.providerUuid) alert(deps, latest, "double", facts);
  return latest;
}

/**
 * What a settlement writes besides the status: the uuid of the order that was paid (it differs from the row's only when a retry had replaced
 * that order: settleToken), and the way of paying and the bank when `facts` has them (a daily check's answer has no bank: the row keeps the
 * one a token gave).
 */
const detailsOf = (facts: Facts) => ({
  providerUuid: sql`coalesce(nullif(${facts.uuid}, ''), ${payments.providerUuid})`,
  method: sql`coalesce(nullif(${facts.method}, ''), ${payments.method})`,
  bank: sql`coalesce(nullif(${facts.bank}, ''), ${payments.bank})`,
});

/** Tells the public pages the seats changed. A failure here never undoes a payment or loses its mails: it is logged and the pages catch up. */
async function seatsChanged(deps: SettleDeps, course: string): Promise<void> {
  try {
    await deps.changed?.({ kind: "seats", course });
  } catch (e) {
    logFailure("[payments] revalidating the seats failed", e);
  }
}

async function paid(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  // an amount that could not be read (null) is no amount: it never equals the row's, and never reads as zero
  if (facts.amountCents !== row.amountCents || facts.currency !== "EUR") return held(deps, row, facts);
  const won = await deps.db.transaction(async (tx): Promise<Won | null> => {
    // the lock order of every payment path, course_sessions → registrations → payments (db/queries/seats.ts): the locks come first, whatever the
    // conditional UPDATE then finds. (An e-course's payment has no registration.)
    if (row.kind !== "ecourse" && row.registrationId !== null) await lockForPayment(tx, row.registrationId);
    const [payment] = await tx
      .update(payments)
      .set({ status: "paid", paidAt: deps.now, updatedAt: deps.now, ...detailsOf(facts) })
      .where(and(eq(payments.id, row.id), inArray(payments.status, ["pending", "failed"]), isNull(payments.paidAt)))
      .returning();
    if (!payment) return null;
    const registration = payment.kind !== "ecourse" && payment.registrationId !== null ? await addRegistrationPayment(tx, payment.registrationId, payment.amountCents, deps.now) : null;
    // an e-course's payment opens the course instead, in this same transaction: only the winner of the update above gets here
    const grant = payment.kind === "ecourse" ? await openCourse(tx, payment, deps.now) : null;
    const paidRow = grant ? { ...payment, clientId: grant.clientId } : payment;
    // the purchase's contract beside the grant, in a savepoint (contracts, §4): the copy the cart showed, frozen now; null when it failed
    // (the gate asks her later) or when nothing was opened. Its locks are the access row's, which the grant holds already.
    const contract = grant ? await contractStep(tx, paidRow, grant, deps.now) : null;
    // its invoice, once, here and only here (the winner's), in a savepoint: the linked unpaid one paid (its amount is added above, not again),
    // or one born paid; null without Seaded's seller, or when the step failed. The locks it takes (the invoice row, the number series, the
    // setting) come after this path's own.
    const invoice = await invoiceStep(tx, paidRow, deps.now);
    return { payment: paidRow, registration, grant, contract, invoice };
  });
  if (!won) return lost(deps, row, facts);
  console.info(`[payments] payment ${won.payment.id}: paid`);
  // queued before anything that could fail after the commit: the payment is paid for good, and this is the only time its mails are sent
  deps.later(async () => {
    if (won.registration) await mailRegistrationPaid(deps, won.payment, won.registration, won.invoice);
    if (won.grant) await mailEcourseOpen(deps, won.payment, won.grant, won.invoice, won.contract);
    try {
      await tellMaria(deps, won.payment, outcomeOf(won));
    } finally {
      // the cart's "Soovin MS LABi uudiseid ja pakkumisi": the one-step sign-up, acted on now that it is paid (spec 6.2.3); it never throws,
      // and a failing notice to Maria does not skip it
      if (won.payment.kind === "ecourse" && won.payment.newsletter)
        await subscribeLater({ db: deps.db, env: deps.env, ip: null, siteUrl: deps.siteUrl, now: deps.now, later: deps.later, newsletterSync: deps.newsletterSync }, "ecourse", { email: won.payment.email, locale: won.payment.locale });
    }
  });
  if (won.registration) alertIfOverpaid(deps, won.payment, won.registration);
  // after "Makse vajab kontrolli" Maria may have recorded it by hand: she is told it is recorded now (once: only the winner gets here)
  deps.later(() => followUpUnsettled(deps, won.payment));
  if (won.registration) await seatsChanged(deps, won.registration.course.slug);
  return won.payment;
}

/**
 * The backstop of the double-payment rule (start.ts): when this payment took the registration's paid sum over the course's price (two
 * orders of one registration both paid), Maria gets one "Ülemakse" alert, after the response. It is part of the winner's once-only work, so it
 * goes out once per payment; the payment is recorded as any other.
 */
function alertIfOverpaid(deps: SettleDeps, p: Payment, r: RegistrationPaid): void {
  const price = registrationPrice(r.course, r.registration.kind);
  if (price === null || r.registration.paidCents <= price) return;
  logNote(`[payments] payment ${p.id}: over the price, Maria is alerted`);
  deps.later(async () => {
    const s = overpaymentSummary(
      { kind: p.kind, name: p.name, email: p.email, amountCents: p.amountCents, course: pick(r.course.title, "et"), startsAt: r.session?.startsAt ?? null, reference: p.reference, providerUuid: p.providerUuid, paidCents: r.registration.paidCents, priceCents: price },
      adminUrl(deps.siteUrl),
    );
    await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: p.email, siteUrl: deps.siteUrl });
  });
}

/**
 * The grant of a paid e-course purchase (grant.ts), in a savepoint of the paid transaction. If it throws, only the grant is rolled back (a
 * client it had made with it): the payment stays paid, which is the truth (the money is at Montonio), and the outcome is "not opened", so Maria
 * is told at once to open the course by hand or refund, instead of the whole payment staying pending with nobody told while the webhook retries.
 * The one exception is a transient database error (a serialization failure, a deadlock, a lock not available, a statement timeout, a
 * connection error, the database restarting or full: isTransient): that is no verdict on the course, so it is thrown on, the whole paid transaction rolls back and the payment
 * stays pending until Montonio's retry, the return or the daily check settles it again. The log has the class and the code only.
 *
 * The locks of this path (the e-course has no session and no registration): its payment row (the conditional UPDATE above), then the address
 * lock (addClient: client-auth.ts lockAddress), then the rows linked to the address: registrations, requests, subscribers, the client and her
 * course_access. That is not the order of db/queries/seats.ts, and cannot make a cycle with it: (1) the payment rows are disjoint. A
 * registration's payment paths (start, settle, failPayment, the daily check) lock the session, the registration and a payment row of kind
 * prepayment or balance, never an e-course payment row, and an e-course payment row is written only by the e-course's own start (which holds
 * its advisory lock and that row, nothing else) and settlement. (2) No writer that holds the address lock waits for an e-course payment row
 * in flight: the logins, addClient, the password and the newsletter take the address lock and write tokens, clients, sessions and the linked
 * records, not payments; the deletion of an account (client-data.ts deleteClient) is the one exception, and the payments its ON DELETE SET
 * NULL reaches are rows already linked to the client, which an e-course payment in flight never is (the grant writes its client_id, after the
 * address lock). So whoever waits on a row this path holds holds neither the address lock nor a row this path waits for.
 */
async function openCourse(tx: Tx, payment: Payment, now: Date): Promise<Grant | null> {
  try {
    return await (tx as unknown as Db).transaction((savepoint) => grantPurchase(savepoint, payment, now));
  } catch (e) {
    // a transient database error says nothing about the course: it is thrown on, the whole paid transaction rolls back and the payment stays
    // pending (nobody is told), to be settled by Montonio's retry, the return or the daily check; only any other error is "not opened"
    if (isTransient(e)) throw e;
    logFailure(`[payments] payment ${payment.id}: the course could not be opened`, e);
    return null;
  }
}

/**
 * The paid payment's invoice (server/invoices.ts invoiceForPaidPayment) in a savepoint of the paid transaction (ruling R13): a failure there
 * never undoes the payment's recording. Whatever it throws — a transient database error too, unlike openCourse: the invoice is no reason to
 * leave real money unrecorded, and the catch-up makes it later — only the invoice step is rolled back; the payment stays paid with no invoice,
 * listed in „Arveta maksed" (uninvoicedPayments), whose „Koosta arve" makes it (catchUpInvoice: the linked invoice paid, or one born paid), and
 * the payer's mail goes without a PDF. Logged `[invoices] payment N: no invoice: <class>` at error level. (A lost connection fails the whole
 * transaction all the same, and the payment stays pending for the next call, as before.)
 */
async function invoiceStep(tx: Tx, payment: Payment, now: Date): Promise<Invoice | null> {
  try {
    return await (tx as unknown as Db).transaction((savepoint) => invoiceForPaidPayment(savepoint, payment, now));
  } catch (e) {
    logFailure(`[invoices] payment ${payment.id}: no invoice`, e);
    return null;
  }
}

/**
 * The purchase's contract (contracts, D1, §4; rulings R3, R4, R7, R8) in a savepoint of the paid transaction, beside the grant: the copy the cart
 * showed (payments.contract_snapshot, kept when the purchase started), frozen as it is as the opened access's contract by `purchase`, with the paid
 * price in its fields, the student the snapshot was filled with (the payment's name and address, so its {nimi} and its „Pooled“ agree), and the
 * press of „Maksa“ that filled it as its acceptance (the snapshot's `acceptedAt`; the payment's start for a snapshot without one). It supersedes the
 * access's current contract (a free grant's, a gate's, an earlier purchase's) at `now`, the settlement's time, never before it exists. Whatever
 * it throws — a transient database error too, as the invoice step: the contract is no reason to leave real money unrecorded — only the contract
 * is rolled back: the payment and the grant stand, the log has the payment's id and the error's class, and the terms gate asks her later
 * (`terms`), as it does for a payment that kept no copy (one started before contracts existed).
 */
async function contractStep(tx: Tx, payment: Payment, grant: Grant, now: Date): Promise<Contract | null> {
  const shown = payment.contractSnapshot;
  if (!shown || payment.courseId === null) {
    console.info(`[contracts] payment ${payment.id}: no contract kept with it, the terms gate asks`);
    return null;
  }
  const courseId = payment.courseId;
  // the press that filled the snapshot (R7); a snapshot kept before it carried one: the payment's start
  const pressed = shown.acceptedAt ? new Date(shown.acceptedAt) : null;
  const acceptedAt = pressed && !Number.isNaN(pressed.getTime()) ? pressed : payment.createdAt;
  try {
    return await (tx as unknown as Db).transaction(async (savepoint) => {
      const access = await accessContractFields(savepoint, grant.accessId, payment.id, shown.locale);
      if (!access) throw new Error(`access ${grant.accessId} is gone`); // ids only
      // the student as the snapshot was filled with her: the name and the address the cart's payment carries (R8), not the account's
      const fields = { ...access, student: contractStudent(payment.name, payment.email) };
      return contractForAccess(savepoint, {
        accessId: grant.accessId,
        clientId: grant.clientId,
        courseId,
        paymentId: payment.id,
        snapshotOrTemplate: shown,
        fields,
        via: "purchase",
        now,
        acceptedAt,
      });
    });
  } catch (e) {
    logFailure(`[contracts] payment ${payment.id}: no contract`, e);
    return null;
  }
}

/** The SQLSTATEs of errors that pass by themselves: a serialization failure, a deadlock, a lock not available, a statement timeout. */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"]);

/**
 * A database error that a retry can get past: one of TRANSIENT_SQLSTATES, or a connection lost, refused or not there yet (db/queries/payments.ts
 * isConnectionError: class 08, a restart, too many connections, the driver's own). The code is on the error itself, or down its `cause` when
 * drizzle wrapped the driver's error (db/safe-error.ts dbErrorCode).
 */
export function isTransient(e: unknown): boolean {
  const code = dbErrorCode(e);
  return (code !== null && TRANSIENT_SQLSTATES.has(code)) || isConnectionError(e);
}

/** What the payment did, for Maria's notice. An e-course's is told in its own words (messages.ts): opened until a day, or not opened. */
function outcomeOf(won: Won): Pick<PaymentNotice, "outcome" | "restCents" | "until"> {
  if (won.payment.kind === "ecourse") return won.grant ? { outcome: "opened", until: won.grant.expiresAt } : { outcome: "notOpened" };
  const r = won.registration;
  if (!r) return { outcome: "received" };
  if (r.full) return { outcome: "full" };
  if (r.registration.status !== "confirmed") return { outcome: "received" };
  const total = registrationPrice(r.course, r.registration.kind);
  return { outcome: "confirmed", restCents: total === null ? 0 : Math.max(0, total - r.registration.paidCents) };
}

async function held(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  const [payment] = await deps.db
    .update(payments)
    .set({ status: "held", updatedAt: deps.now, ...detailsOf(facts) })
    .where(and(eq(payments.id, row.id), inArray(payments.status, ["pending", "failed"]), isNull(payments.paidAt)))
    .returning();
  if (!payment) return lost(deps, row, facts);
  alert(deps, payment, "held", facts);
  return payment;
}

async function failed(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  // the row in hand may be old: a pending one is failed by a conditional UPDATE, and whoever lost finds the row as it is now
  if (row.status !== "paid") {
    const done = await failPayment(deps.db, row.id, deps.now);
    if (done) {
      console.info(`[payments] payment ${row.id}: failed`);
      if (done.released) {
        const ctx = await contextOf(deps, row.id);
        if (ctx.course) await seatsChanged(deps, ctx.course.slug);
      }
      return done.payment;
    }
  }
  const latest = row.status === "paid" ? row : await current(deps, row);
  if (latest.status !== "paid" || facts.rawStatus !== "VOIDED") return latest; // paid is a floor: only the bank taking the payment back moves it
  const [voided] = await deps.db.update(payments).set({ status: "failed", updatedAt: deps.now }).where(and(eq(payments.id, row.id), eq(payments.status, "paid"))).returning();
  if (!voided) return current(deps, row);
  alert(deps, voided, "voided", facts);
  return voided;
}

async function refunded(deps: SettleDeps, row: Payment, facts: Facts): Promise<Payment> {
  const [payment] = await deps.db.update(payments).set({ status: "refunded", updatedAt: deps.now }).where(and(eq(payments.id, row.id), ne(payments.status, "refunded"))).returning();
  if (!payment) return current(deps, row);
  alert(deps, payment, "refunded", facts);
  return payment;
}

/** What a payment was for. A failure to read it must not lose Maria's notice: she gets it without the course. */
async function contextOf(deps: SettleDeps, paymentId: number): Promise<PaymentContext> {
  try {
    return await paymentContext(deps.db, paymentId);
  } catch (e) {
    logFailure(`[payments] payment ${paymentId}: its course could not be read`, e);
    return { course: null, session: null, payToken: null };
  }
}

/** The course's Estonian title for Maria. Gone: "—" for a registration's course, "" for an e-course's (messages.ts then writes "E-koolitus" alone). */
const courseName = (ctx: PaymentContext, kind: Payment["kind"]): string => (ctx.course ? pick(ctx.course.title, "et") : kind === "ecourse" ? "" : "—");

/** How long a second order's "Topeltmakse" is remembered (Montonio retries a webhook for 48 hours; a payer can reload the return for as long). */
const DOUBLE_ALERT_TTL_SECONDS = 14 * 24 * 3600;

/** The KV record that Maria was told about this second order of this payment. */
const doubleAlertKey = (paymentId: number, uuid: string): string => `pay:double:${paymentId}:${uuid}`;

/** How long the daily check's "Makse vajab kontrolli" of a payment is remembered (it asks about a pending payment for 14 days). */
const STUCK_ALERT_TTL_SECONDS = 30 * 24 * 3600;

/** The KV record that Maria was told Montonio says this payment is paid but it could not be recorded. */
const stuckAlertKey = (paymentId: number): string => `pay:stuck:${paymentId}`;

/**
 * Takes the record of a once-only alert in one step (two calls at the same moment cannot both take it). A store that fails answers true: a
 * repeated alert is better than a lost one.
 */
async function takeAlertRecord(deps: SettleDeps, key: string, ttlSeconds: number): Promise<boolean> {
  try {
    return await reserveSlot(deps.env.KV, key, 1, ttlSeconds);
  } catch (e) {
    logFailure("[payments] the record of an alert could not be taken", e);
    return true;
  }
}

/** Gives the record back when the alert reached no one, so the next call tells Maria. */
async function releaseAlertRecord(deps: SettleDeps, key: string, ttlSeconds: number): Promise<void> {
  try {
    await releaseSlot(deps.env.KV, key, ttlSeconds);
  } catch (e) {
    logFailure("[payments] the record of an alert could not be given back", e);
  }
}

/**
 * Maria's "Kontrolli Montonios", after the response. "Topeltmakse" goes out once per second order (its uuid is recorded: see the top of the
 * file); `facts` is what that order paid, and the alert says so.
 */
function alert(deps: SettleDeps, p: Payment, kind: "held" | "voided" | "refunded" | "double", facts: Facts): void {
  logNote(`[payments] payment ${p.id}: ${kind}, Maria is alerted`);
  deps.later(async () => {
    const record = kind === "double" ? doubleAlertKey(p.id, facts.uuid) : null;
    if (record && !(await takeAlertRecord(deps, record, DOUBLE_ALERT_TTL_SECONDS))) {
      logNote(`[payments] payment ${p.id}: Maria was told about this second order before`);
      return;
    }
    let told = false;
    try {
      const ctx = await contextOf(deps, p.id);
      const s = paymentAlertSummary(
        { alert: kind, kind: p.kind, name: p.name, email: p.email, amountCents: p.amountCents, course: courseName(ctx, p.kind), startsAt: ctx.session?.startsAt ?? null, reference: p.reference, providerUuid: p.providerUuid, otherUuid: kind === "double" ? facts.uuid : null, rawStatus: facts.rawStatus, paidCents: facts.amountCents, currency: facts.currency },
        adminUrl(deps.siteUrl),
      );
      const r = await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: p.email, siteUrl: deps.siteUrl });
      told = r.mail || r.telegram;
    } finally {
      if (record && !told) await releaseAlertRecord(deps, record, DOUBLE_ALERT_TTL_SECONDS);
    }
  });
}

/**
 * The daily check's "Makse vajab kontrolli" (check.ts), after the response: Montonio says `row` is paid (`snapshot`), but settling it threw,
 * so the money is recorded nowhere. Once per payment: the record pay:stuck:<payment> is taken in the KV (30 days, past the check's 14 days
 * of asking), and an alert that reached no one gives it back, so the next run tells Maria. A row the webhook or the return settled before
 * the alert went out gets none (its record is given back too). The log has the payment's id only.
 */
export function alertUnsettled(deps: SettleDeps, row: Payment, snapshot: OrderSnapshot): void {
  logNote(`[payments] payment ${row.id}: Montonio says paid but it could not be recorded, Maria is alerted`);
  deps.later(async () => {
    const record = stuckAlertKey(row.id);
    if (!(await takeAlertRecord(deps, record, STUCK_ALERT_TTL_SECONDS))) {
      logNote(`[payments] payment ${row.id}: Maria was told about it before`);
      return;
    }
    let told = false;
    try {
      // the webhook or the return may have settled the row since the check's try. The record is taken before the row is read again, so a
      // winner either committed before this read (no alert), or its follow-up (followUpUnsettled) reads the record after it was taken and
      // follows this alert up. A row no longer pending gets no alert, and the record is given back (the finally below): a record left set
      // would make a winner whose follow-up runs later tell Maria about an alert she never got
      if (!(await stillPending(deps, row))) {
        logNote(`[payments] payment ${row.id}: settled before Maria was alerted, no alert`);
        return;
      }
      const ctx = await contextOf(deps, row.id);
      const s = stuckPaymentSummary(
        { kind: row.kind, name: row.name, email: row.email, amountCents: row.amountCents, course: courseName(ctx, row.kind), startsAt: ctx.session?.startsAt ?? null, reference: row.reference, providerUuid: row.providerUuid, paidCents: snapshot.amountCents, currency: snapshot.currency },
        adminUrl(deps.siteUrl),
      );
      const r = await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: row.email, siteUrl: deps.siteUrl });
      told = r.mail || r.telegram;
    } finally {
      if (!told) await releaseAlertRecord(deps, record, STUCK_ALERT_TTL_SECONDS);
    }
  });
}

/** Whether `row` is still pending as the database has it now. A failure to read it must not lose Maria's alert: it counts as pending (logged). */
async function stillPending(deps: SettleDeps, row: Payment): Promise<boolean> {
  try {
    return (await current(deps, row)).status === "pending";
  } catch (e) {
    logFailure(`[payments] payment ${row.id}: it could not be read again before the alert`, e);
    return true;
  }
}

/**
 * The follow-up of "Makse vajab kontrolli" (alertUnsettled), after the response: the payment `p` was just recorded, and the record
 * pay:stuck:<payment> says Maria was told it could not be (a record given back, "0", is an alert that reached no one or was not sent: nothing to follow up).
 * She may have recorded it by hand meanwhile, so she gets "Makse on nüüd kirja pandud" once, and the record is removed. A store that fails
 * to answer loses the follow-up (logged): the payment itself is recorded. The log has the payment's id only.
 */
async function followUpUnsettled(deps: SettleDeps, p: Payment): Promise<void> {
  const record = stuckAlertKey(p.id);
  let told: boolean;
  try {
    told = Number(await deps.env.KV.get(record)) > 0;
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the record of an earlier alert could not be read`, e);
    return;
  }
  if (!told) return;
  logNote(`[payments] payment ${p.id}: recorded after Maria was told it could not be, she is told now`);
  try {
    const ctx = await contextOf(deps, p.id);
    const s = recordedAfterAlertSummary(
      { kind: p.kind, name: p.name, email: p.email, amountCents: p.amountCents, course: courseName(ctx, p.kind), startsAt: ctx.session?.startsAt ?? null, reference: p.reference, providerUuid: p.providerUuid },
      adminUrl(deps.siteUrl),
    );
    await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: p.email, siteUrl: deps.siteUrl });
  } finally {
    try {
      await forgetKey(deps.env.KV, record);
    } catch (e) {
      logFailure("[payments] the record of an alert could not be removed", e);
    }
  }
}

/** Maria's "Uus makse: …" (mail and Telegram). */
async function tellMaria(deps: SettleDeps, p: Payment, outcome: Pick<PaymentNotice, "outcome" | "restCents" | "until">): Promise<void> {
  const ctx = await contextOf(deps, p.id);
  const s = paymentSummary(
    { kind: p.kind, name: p.name, email: p.email, amountCents: p.amountCents, course: courseName(ctx, p.kind), startsAt: ctx.session?.startsAt ?? null, method: p.method, bank: p.bank, reference: p.reference, providerUuid: p.providerUuid, ...outcome },
    adminUrl(deps.siteUrl),
  );
  const r = await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: p.email, siteUrl: deps.siteUrl });
  console.info(`[payments] payment ${p.id}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
}

/**
 * The paid mail's attachment (invoices, spec §4): the PDF of the payment's invoice (server/invoices.ts invoicePdf, rendered now), named by its
 * number (domain/invoice.ts invoiceFileName). null without an invoice, and when the PDF fails to render: the mail then goes without it (and
 * without its line), and the log has the invoice's number and the error's class.
 */
async function invoiceAttachment(deps: SettleDeps, invoice: Invoice | null): Promise<MailAttachment | null> {
  if (!invoice) return null;
  try {
    const pdf = await invoicePdf(invoice);
    return { filename: invoiceFileName(invoice.number), content: Buffer.from(pdf), contentType: "application/pdf" };
  } catch (e) {
    logFailure(`[invoices] ${invoice.number}: the paid mail went without its PDF`, e);
    return null;
  }
}

/**
 * "E-koolitus on avatud — …" with a live login (spec 6.2.4), after the response: never to a sample address, not counted in the daily caps (it
 * follows a real payment). The login is a normal client login (client-auth.ts issueClientLogin), made only now and sent only in this mail; an
 * address that has its 3 live logins already gets the mail without a code ("Ava minu konto"). Nothing here signs anyone in. The purchase's
 * invoice goes with it as a PDF, with „Arve on lisatud." (invoiceAttachment), and its contract as the second PDF, with „Leping on lisatud.“
 * (contracts, D7), whose `sent_at` is then recorded (a failure of that record alone is logged as such: the mail went).
 */
async function mailEcourseOpen(deps: SettleDeps, p: Payment, g: Grant, invoice: Invoice | null, contract: Contract | null): Promise<void> {
  if (isSampleAddress(p.email) || !mailConfigured(deps.env)) return;
  try {
    const attachment = await invoiceAttachment(deps, invoice);
    // the purchase's contract, the second attachment (contracts, D7); none when there is no contract or its PDF failed (logged by its id)
    const contractFile = contract ? await contractPdfForMail(contract) : null;
    const login = await issueClientLogin(deps.db, p.email, deps.now);
    const mail = ecourseOpenMail({
      siteUrl: deps.siteUrl, email: p.email, name: p.name, locale: p.locale, course: g.courseTitle, expiresAt: g.expiresAt, login,
      invoiceAttached: attachment !== null, contractAttached: contractFile !== null,
    });
    const attachments = [...(attachment ? [attachment] : []), ...(contract && contractFile ? [contractAttachment(contract.id, contractFile)] : [])];
    const sent = await sendMail(deps.env, attachments.length ? { ...mail, attachments } : mail);
    console.info(`[payments] payment ${p.id}: the e-course mail sent: ${sent}`);
    // the mail is out once Resend took it: a failure to record that (sent_at) is logged on its own, as contracts.ts mailContract logs it
    if (sent && contract && contractFile) {
      try {
        await markContractSent(deps.db, contract.id, deps.now);
      } catch (e) {
        logFailure(`[contracts] contract ${contract.id}: mailed, but the send was not recorded`, e);
      }
    }
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the e-course mail failed`, e);
  }
}

/**
 * The payer's mail after a paid registration: never to a sample address, not counted in the daily caps (it follows a real payment; nor is
 * the invoice it carries: the controller's ruling for invoice mails). The payment's invoice goes with it as a PDF, with „Arve on lisatud."
 * (invoiceAttachment).
 */
async function mailRegistrationPaid(deps: SettleDeps, p: Payment, r: RegistrationPaid, invoice: Invoice | null): Promise<void> {
  if (isSampleAddress(p.email) || !mailConfigured(deps.env)) return;
  try {
    const total = registrationPrice(r.course, r.registration.kind);
    const attachment = await invoiceAttachment(deps, invoice);
    const mail = registrationPaidMail({
      siteUrl: deps.siteUrl,
      email: p.email,
      name: p.name,
      locale: p.locale,
      course: r.course.title,
      session: r.session ? { startsAt: r.session.startsAt, city: r.session.city, venue: r.session.venue } : null,
      paidCents: p.amountCents,
      restCents: total === null ? 0 : Math.max(0, total - r.registration.paidCents),
      confirmed: r.registration.status === "confirmed",
      full: r.full,
      invoiceAttached: attachment !== null,
    });
    const sent = await sendMail(deps.env, attachment ? { ...mail, attachments: [attachment] } : mail);
    console.info(`[payments] payment ${p.id}: the payer's mail sent: ${sent}`);
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the payer's mail failed`, e);
  }
}
