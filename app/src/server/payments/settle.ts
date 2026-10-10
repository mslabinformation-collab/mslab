import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { addRegistrationPayment, type RegistrationPaid } from "@/db/queries/admin";
import { failPayment, paymentByReference, paymentContext, type PaymentContext } from "@/db/queries/payments";
import { lockForPayment } from "@/db/queries/seats";
import { payments, type Payment } from "@/db/schema";
import { isSampleAddress } from "@/domain/email";
import { registrationPrice } from "@/domain/registration";
import { pick } from "@/i18n/field";
import { ecourseOpenMail, registrationPaidMail } from "../account-mail";
import type { PublicChange } from "../cache-targets";
import { issueClientLogin } from "../client-auth";
import { logFailure, logNote } from "../log";
import { overpaymentSummary, paymentAlertSummary, paymentSummary, type PaymentNotice } from "../messages";
import { adminUrl, mailConfigured, notifyMaria, sendMail, type Env } from "../notify";
import { releaseSlot, reserveSlot } from "../ratelimit";
import { subscribeLater } from "../submit";
import { grantPurchase, type Grant } from "./grant";
import type { Montonio, MontonioStatus, OrderSnapshot, OrderToken } from "./montonio";

// The one door of every paid path (phase 2b, spec 6.2, 7.3, 7.4; Rempire's settle/apply/token-guard, ported). The webhook and the return
// (routes.ts) bring an order token, the daily check (check.ts) Montonio's own answer; all of them end in settlePayment:
// - PAID with the row's exact amount in EUR moves the row pending|failed → paid in ONE conditional UPDATE (paid_at null: a payment voided
//   after paid never comes back). Only the winner of that update does the once-only work, in the same transaction: the amount is added to
//   the registration (db/queries/admin.ts addRegistrationPayment: confirmed from 50 %, unless the course is full, D2), or, for an e-course, its
//   client is found or created and the course opened (grant.ts, in a savepoint: a grant that throws is rolled back alone, the row stays paid
//   and Maria is told at once that nothing was opened, unless the error is a transient database one, which rolls everything back and leaves
//   the row pending for the next call; openCourse also says why this order of locks cannot deadlock). After it: the seats are revalidated, and
//   the payer's mail and Maria's notice go out after the response (an e-course's with a login code, and the newsletter sign-up when it was
//   ticked), and Maria's "Ülemakse" when the payment took the registration's paid sum over its price (alertIfOverpaid). Every other caller
//   finds the row paid and does nothing.
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
};

/** What Montonio says about a payment: from a token, or from GET /orders/:uuid (factsOf). */
export type Facts = { uuid: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string; bank: string };

/** unknown: no row has this reference (logged, the webhook's 200); unconfirmed: in doubt and Montonio did not answer (the webhook's 503). */
export type SettleResult = { kind: "unknown" } | { kind: "unconfirmed"; payment: Payment } | { kind: "done"; payment: Payment };

/** GET /orders/:uuid's answer as facts. The bank's name is only in a token: `bank` keeps the one a token gave. */
export const factsOf = (s: OrderSnapshot, bank = ""): Facts => ({ uuid: s.uuid, status: s.status, rawStatus: s.rawStatus, amountCents: s.amountCents, currency: s.currency, method: s.method, bank });

/** The once-only work's outcome: the paid row, and what it did to its registration, or the e-course it opened (phase 2b Task 7). */
type Won = { payment: Payment; registration: RegistrationPaid | null; grant: Grant | null };

/** The door of an order token (the webhook, the return). */
export async function settleToken(deps: SettleDeps, token: OrderToken): Promise<SettleResult> {
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
    return { payment: grant ? { ...payment, clientId: grant.clientId } : payment, registration, grant };
  });
  if (!won) return lost(deps, row, facts);
  console.info(`[payments] payment ${won.payment.id}: paid`);
  // queued before anything that could fail after the commit: the payment is paid for good, and this is the only time its mails are sent
  deps.later(async () => {
    if (won.registration) await mailRegistrationPaid(deps, won.payment, won.registration);
    if (won.grant) await mailEcourseOpen(deps, won.payment, won.grant);
    try {
      await tellMaria(deps, won.payment, outcomeOf(won));
    } finally {
      // the cart's "Soovin MS LABi uudiseid ja pakkumisi": the one-step sign-up, acted on now that it is paid (spec 6.2.3); it never throws,
      // and a failing notice to Maria does not skip it
      if (won.payment.kind === "ecourse" && won.payment.newsletter)
        await subscribeLater({ db: deps.db, env: deps.env, ip: null, siteUrl: deps.siteUrl, now: deps.now, later: deps.later }, "ecourse", { email: won.payment.email, locale: won.payment.locale });
    }
  });
  if (won.registration) alertIfOverpaid(deps, won.payment, won.registration);
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
 * connection error: isTransient): that is no verdict on the course, so it is thrown on, the whole paid transaction rolls back and the payment
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

/** The SQLSTATEs of errors that pass by themselves: a serialization failure, a deadlock, a lock not available, a statement timeout. (Class 08, a connection, is added in isTransient.) */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"]);

/** Is this SQLSTATE one of a transient failure (see TRANSIENT_SQLSTATES), or of class 08 (connection exception)? */
const transientCode = (code: unknown): boolean => typeof code === "string" && (TRANSIENT_SQLSTATES.has(code) || (code.length === 5 && code.startsWith("08")));

/** A database error that a retry can get past. The SQLSTATE is on the error itself, or on its `cause` when drizzle wrapped the driver's error. */
function isTransient(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, cause } = e as { code?: unknown; cause?: unknown };
  return transientCode(code) || (typeof cause === "object" && cause !== null && transientCode((cause as { code?: unknown }).code));
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

/**
 * Takes the record of a second order's alert in one step (two calls at the same moment cannot both take it). A store that fails answers
 * true: a repeated alert is better than a lost one.
 */
async function takeDoubleAlert(deps: SettleDeps, key: string): Promise<boolean> {
  try {
    return await reserveSlot(deps.env.KV, key, 1, DOUBLE_ALERT_TTL_SECONDS);
  } catch (e) {
    logFailure("[payments] the record of a second order's alert could not be taken", e);
    return true;
  }
}

/** Gives the record back when the alert reached no one, so the next call tells Maria. */
async function releaseDoubleAlert(deps: SettleDeps, key: string): Promise<void> {
  try {
    await releaseSlot(deps.env.KV, key, DOUBLE_ALERT_TTL_SECONDS);
  } catch (e) {
    logFailure("[payments] the record of a second order's alert could not be given back", e);
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
    if (record && !(await takeDoubleAlert(deps, record))) {
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
      if (record && !told) await releaseDoubleAlert(deps, record);
    }
  });
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
 * "E-koolitus on avatud — …" with a live login (spec 6.2.4), after the response: never to a sample address, not counted in the daily caps (it
 * follows a real payment). The login is a normal client login (client-auth.ts issueClientLogin), made only now and sent only in this mail; an
 * address that has its 3 live logins already gets the mail without a code ("Ava minu konto"). Nothing here signs anyone in.
 */
async function mailEcourseOpen(deps: SettleDeps, p: Payment, g: Grant): Promise<void> {
  if (isSampleAddress(p.email) || !mailConfigured(deps.env)) return;
  try {
    const login = await issueClientLogin(deps.db, p.email, deps.now);
    const sent = await sendMail(deps.env, ecourseOpenMail({ siteUrl: deps.siteUrl, email: p.email, name: p.name, locale: p.locale, course: g.courseTitle, expiresAt: g.expiresAt, login }));
    console.info(`[payments] payment ${p.id}: the e-course mail sent: ${sent}`);
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the e-course mail failed`, e);
  }
}

/** The payer's mail after a paid registration: never to a sample address, not counted in the daily caps (it follows a real payment). */
async function mailRegistrationPaid(deps: SettleDeps, p: Payment, r: RegistrationPaid): Promise<void> {
  if (isSampleAddress(p.email) || !mailConfigured(deps.env)) return;
  try {
    const total = registrationPrice(r.course, r.registration.kind);
    const sent = await sendMail(
      deps.env,
      registrationPaidMail({
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
      }),
    );
    console.info(`[payments] payment ${p.id}: the payer's mail sent: ${sent}`);
  } catch (e) {
    logFailure(`[payments] payment ${p.id}: the payer's mail failed`, e);
  }
}
