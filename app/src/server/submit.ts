import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, Q, Tx } from "@/db/client";
import { releaseHoldLocked } from "@/db/queries/payments";
import { readSetting } from "@/db/queries/public";
import { lockSession, seatsTaken } from "@/db/queries/seats";
import { courses, courseSessions, practicePackages, registrations, requests, subscribers } from "@/db/schema";
import type { Contract, Course, CourseSession, Registration } from "@/db/schema";
import { PREPAYMENT_KEY, parsePrepayment } from "@/domain/account-cards";
import { contractCourseName, filledContract } from "@/domain/contract";
import { isSampleAddress, normalizeEmail } from "@/domain/email";
import { registrationPrice } from "@/domain/registration";
import { holdUntil, seatState } from "@/domain/sessions";
import { pick } from "@/i18n/field";
import {
  isSpam,
  parseContact,
  parseEcoursePurchase,
  parseGroupRegistration,
  parseIndividual,
  parsePractice,
  parsePurchaseInterest,
  parseSubscribe,
  parseWaitlist,
  type Parsed,
  type RegistrationInput,
} from "./forms";
import {
  contactSummary,
  individualSummary,
  practiceSummary,
  purchaseInterestSummary,
  registrationSummary,
  waitlistSummary,
  type Summary,
} from "./messages";
import { contractAttachment, payLinkUrl, registrationConfirmationMail, requestConfirmationMail, type LoginCode } from "./account-mail";
import { CONFIRMATION_MAIL_DAILY_CAP, LOGIN_MAIL_DAILY_CAP, accountOf, fillClientContact, issueClientLogin, reserveLoginMail } from "./client-auth";
import { contractForRegistration, contractPdfForMail, contractTemplate, markContractSent, registrationContractFields, shownVersionHolds } from "./contracts";
import { logFailure, logNote } from "./log";
import { adminUrl, mailConfigured, notifyMaria, sendMail, type Env, type Mail } from "./notify";
import type { Montonio } from "./payments/montonio";
import { startEcoursePayment, startRegistrationPayment } from "./payments/start";
import { RATE_LIMIT, RATE_WINDOW_SEC, rateKey, rateLimit } from "./ratelimit";
import type { SubscriberSync } from "./resend-marketing";
import type { PublicChange } from "./cache-targets";
import { sendWelcome } from "./newsletter";
import { newToken, sha256 } from "./token";
import { upcomingFrom } from "@/domain/calendar";

// The public form submissions without Next.js: actions/public.ts builds the dependencies (database, settings,
// visitor IP, after()) and calls these, and the tests call them with PGlite and fakes.
//
// Every submission: honeypot → validation → rate limit (5 per 10 min per form and IP) → checks against the database
// → storage → notifications after the response. Storage is the contract; a failed e-mail or Telegram ping is logged
// and never fails the request.

/** `paymentUrl` (phase 2b): a group registration's prepayment, or an e-course purchase, has started; the form sends the browser there. */
export type ActionResult = { ok: true; paymentUrl?: string } | { ok: false; errors: Record<string, string> };

export type Deps = {
  db: Db;
  env: Env;
  /** The visitor's address (rate limit key); null when the request carries none (then it is not rate limited). */
  ip: string | null;
  /** Base of the links in outgoing e-mails and Telegram messages (allow-listed request origin, else SITE_URL). */
  siteUrl: string;
  now: Date;
  /** Runs work after the response has been sent: next/server after() in production, collected and awaited in tests. */
  later: (task: () => Promise<unknown>) => void;
  /**
   * Told when a stored submission changes what public pages show, before the answer, so the very next request already
   * renders those pages again (revalidatePath(); public-cache.ts).
   */
  changed?: (change: PublicChange) => Promise<void> | void;
  /** Online payments (phase 2b, server/payments/montonio.ts paymentProvider); absent or null: the forms of today. */
  montonio?: Montonio | null;
  /**
   * Syncs an address whose subscriber row a sign-up changed to Resend (newsletter campaigns, spec D2; resend-marketing.ts subscriberSync), run
   * in the work after the response. Absent (no marketing key, the tests of other things): nothing is synced, and the full sync catches up.
   */
  newsletterSync?: SubscriberSync;
};

export type FormName = "contact" | "subscribe" | "register" | "individual" | "interest" | "ecourse" | "practice" | "waitlist";

const OK: ActionResult = { ok: true };
const fail = (errors: Record<string, string>): ActionResult => ({ ok: false, errors });

/** Welcome e-mails per address and day (an address that unsubscribed and signs up again is a new sign-up each time; this stops mail-bombing an address). */
const CONFIRM_MAILS_PER_DAY = 3;
/** The same for the confirmations to a visitor who registered or sent a request: the public forms must not mail any address at will. */
const VISITOR_MAILS_PER_ADDRESS_PER_DAY = 3;

/**
 * The confirmation to the visitor of a stored registration or request. `prepare` reads what the mail needs from the database
 * (the prepayment setting) and returns the builder of the mail, which takes the live login the mail carries (null: none). It runs
 * in the deferred work, before any login or quota is spent, so nothing here can fail the stored submission or waste a quota.
 */
type Confirmation = {
  email: string;
  wantsAccount: boolean;
  prepare: () => Promise<(login: LoginCode | null) => Mail>;
  /** After Resend took the mail: what it records (a registration's contract: its `sent_at`, when the PDF went with it). Never fails the mail. */
  sent?: () => Promise<void>;
};

/**
 * What a handler stored and what follows the answer. `subscribe`: "Soovin MS LABi uudiseid ja pakkumisi" was ticked on a registration
 * form (phase 2c), so the newsletter's own sign-up runs after the response (subscribeLater). `welcome`: the newsletter's own forms stored
 * the sign-up before the answer (subscribeAddress), and the welcome mail it left due goes after it.
 */
type Stored = {
  result: ActionResult;
  notify?: Summary & { replyTo?: string };
  confirm?: Confirmation;
  subscribe?: { email: string; locale: "et" | "ru" };
  welcome?: WelcomeDue;
  /** The address whose subscriber row the newsletter's own forms changed: synced to Resend after the welcome mail (syncSubscriber). */
  synced?: string;
};

/** A rate limit that fails open: when KV is unavailable (or over its daily write quota) the submission goes through. */
async function allowed(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    return await rateLimit(env.KV, key, limit, windowSec);
  } catch (e) {
    logFailure("[forms] rate limit unavailable, allowing", e);
    return true;
  }
}

let warnedNoIp = false;

/** Rate limit per form and visitor. Without a visitor address (never on Vercel) the request is let through:
 *  one shared bucket would lock everybody out after five submissions. */
async function withinRateLimit(deps: Deps, form: FormName): Promise<boolean> {
  if (deps.ip === null) {
    if (!warnedNoIp) {
      warnedNoIp = true;
      console.warn("[forms] request without a visitor address (x-forwarded-for): not rate limited");
    }
    return true;
  }
  return allowed(deps.env, rateKey(form, deps.ip), RATE_LIMIT, RATE_WINDOW_SEC);
}

async function submission<T>(
  deps: Deps,
  form: FormName,
  formData: FormData,
  parse: (fd: FormData) => Parsed<T>,
  store: (data: T) => Promise<Stored>,
): Promise<ActionResult> {
  if (isSpam(formData)) {
    console.info(`[forms] ${form}: honeypot filled, nothing stored`);
    return OK;
  }
  const parsed = parse(formData);
  if (!parsed.ok) return fail(parsed.errors);
  if (!(await withinRateLimit(deps, form))) {
    console.info(`[forms] ${form}: rate limited`);
    return fail({ form: "rate" });
  }
  const out = await store(parsed.data);
  const { notify, confirm } = out;
  if (notify) {
    deps.later(async () => {
      const r = await notifyMaria(deps.env, notify.subject, notify.text, { short: notify.short, replyTo: notify.replyTo, siteUrl: deps.siteUrl });
      console.info(`[forms] ${form}: stored; Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
    });
  }
  // One task, in this order: the visitor's own confirmation (it carries the prepayment details) first, then the newsletter's mail (the
  // welcome mail of a marketing sign-up), then the sign-up's sync to Resend (newsletter campaigns). The two mails count on different daily
  // counters, so they do not compete for a place; the order stays so that the transactional mail is always the first out, and the mails go
  // before the sync's calls to the same account. sendConfirmation, subscribeLater, welcomeLater and syncSubscriber each catch their own
  // failures, but whatever either does one day, a throw from the confirmation must never skip the sign-up the visitor ticked: it is caught
  // here and logged (the error class and code only, never an address).
  const wish = out.subscribe;
  const welcome = out.welcome;
  const synced = out.synced;
  if (confirm || wish || welcome || synced) {
    deps.later(async () => {
      if (confirm) {
        try {
          await sendConfirmation(deps, form, confirm);
        } catch (e) {
          logFailure(`[forms] ${form}: confirmation e-mail task failed`, e);
        }
      }
      if (wish) await subscribeLater(deps, form, wish);
      if (welcome) await welcomeLater(deps, form, welcome);
      if (synced) await syncSubscriber(deps, form, synced);
    });
  }
  return out.result;
}

/**
 * A live login for the confirmation of a visitor who ticked "Loo mulle kohe konto", or null: the address already has its 3
 * live logins (client-auth.ts CLIENT_LOGIN_CAP) or the database failed. Then the confirmation goes out without a code.
 */
async function liveLogin(deps: Deps, form: FormName, email: string): Promise<LoginCode | null> {
  try {
    const issued = await issueClientLogin(deps.db, email, deps.now);
    if (!issued) console.info(`[forms] ${form}: this address has its live logins already: confirmation without a code`);
    return issued;
  } catch (e) {
    logFailure(`[forms] ${form}: login code unavailable, confirmation without it`, e);
    return null;
  }
}

/**
 * Mails the visitor the confirmation of what was stored, after the response (queued like Maria's notification; either may fail
 * without the other). It spends nothing on a mail that will not go out, and each step ends it quietly when it says no:
 * 1. a sample address (`@example.test`) is skipped, and so is a deployment without Resend (local development, the e2e run);
 * 2. at most 3 confirmations per address and day (the newsletter's pattern: a KV counter under the hash of the address, which
 *    fails open like the other rate limits);
 * 3. the mail's content is read (the prepayment setting), so a database failure here costs no login and no quota;
 * 4. "Loo mulle kohe konto" ticked: a live login (none when the address has its 3, or on a database failure: no code then);
 * 5. one unit of the day's counter, the `mail_quota` row, which never fails open: the login cap (60) for a mail with a code, the
 *    confirmation cap (30) without one; over the cap, or with the database failing, there is no mail;
 * 6. sent (sendMail), and once Resend took it, what the confirmation records (`sent`: a registration's contract went with it).
 * Never throws: the submission is stored, and a failure is logged without addresses or texts.
 */
async function sendConfirmation(deps: Deps, form: FormName, confirm: Confirmation): Promise<void> {
  const address = normalizeEmail(confirm.email);
  if (isSampleAddress(address)) {
    console.info(`[forms] ${form}: stored; confirmation e-mail skipped (sample address)`);
    return;
  }
  if (!mailConfigured(deps.env)) return;
  try {
    if (!(await allowed(deps.env, `rl:visitor-confirm:${await sha256(address)}`, VISITOR_MAILS_PER_ADDRESS_PER_DAY, 24 * 60 * 60))) {
      console.info(`[forms] ${form}: confirmation e-mails for this address are paused for today`);
      return;
    }
    const build = await confirm.prepare();
    const login = confirm.wantsAccount ? await liveLogin(deps, form, address) : null;
    if (!(await reserveLoginMail(deps.db, deps.now, login ? LOGIN_MAIL_DAILY_CAP : CONFIRMATION_MAIL_DAILY_CAP))) {
      logNote(`[forms] ${form}: daily mail cap reached: no confirmation e-mail to the visitor`);
      return;
    }
    const sent = await sendMail(deps.env, build(login));
    console.info(`[forms] ${form}: stored; confirmation e-mail to the visitor sent: ${sent}`);
    if (sent && confirm.sent) {
      try {
        await confirm.sent();
      } catch (e) {
        logFailure(`[forms] ${form}: the confirmation was sent, but not recorded`, e);
      }
    }
  } catch (e) {
    logFailure(`[forms] ${form}: confirmation e-mail failed`, e);
  }
}

const admin = (deps: Deps) => adminUrl(deps.siteUrl);

/**
 * Runs one form handler with the dependencies from `makeDeps`. Any failure (bindings, database) is logged without
 * personal data — the error class and SQLSTATE only, never the message, which holds the query parameters — and
 * answered with form "server" (the forms show their generic error).
 */
export async function runSubmission(
  form: FormName,
  makeDeps: () => Deps | Promise<Deps>,
  handler: (deps: Deps, formData: FormData) => Promise<ActionResult>,
  formData: FormData,
): Promise<ActionResult> {
  try {
    return await handler(await makeDeps(), formData);
  } catch (e) {
    logFailure(`[forms] ${form}: not stored`, e);
    return fail({ form: "server" });
  }
}

// ---------- registrations ----------

/**
 * A registration to store: the form's fields, and (phase 2b) the end of the seat hold it starts with. `seatHoldUntil` is written in the
 * insert, so a registration that is stored under the session's lock already holds its seat when the lock is let go.
 */
export type NewRegistration = RegistrationInput & { seatHoldUntil?: Date | null };

/** Stores a contact-course registration. The status is always `awaiting_prepayment` (a place is confirmed only
 *  after at least 50% prepayment, P15) and nothing has been paid. Its "Maksa" token is a fresh newToken() (phase 2b).
 *  An address with an account is linked to it at once
 *  (client-auth.ts accountOf), and the account's empty name and phone are filled from it, in the same transaction. A caller
 *  that counts seats first (handleRegistration) passes its own transaction. */
export async function createRegistration(q: Q, input: NewRegistration): Promise<Registration> {
  const email = normalizeEmail(input.email);
  // (inside the caller's transaction, when `q` is one, this is a savepoint of it)
  return (q as Db).transaction(async (tx) => {
    const [row] = await tx
      .insert(registrations)
      .values({
        courseId: input.courseId,
        courseSessionId: input.courseSessionId ?? null,
        kind: input.kind,
        name: input.name.trim(),
        email,
        clientId: accountOf(email),
        phone: input.phone.trim(),
        paymentChoice: input.paymentChoice,
        wantsModelHelp: input.wantsModelHelp,
        wantsAccount: input.wantsAccount,
        preferredPeriod: input.preferredPeriod.trim(),
        message: input.message.trim(),
        locale: input.locale,
        status: "awaiting_prepayment",
        paidCents: 0,
        seatHoldUntil: input.seatHoldUntil ?? null,
        payToken: newToken(),
      })
      .returning();
    if (row.clientId !== null) await fillClientContact(tx, row.clientId, [{ name: row.name, phone: row.phone, at: row.createdAt }]);
    return row;
  });
}

/** A published contact course by slug. */
async function contactCourse(db: Db, slug: string): Promise<Course | null> {
  const [row] = await db
    .select()
    .from(courses)
    .where(and(eq(courses.slug, slug), eq(courses.published, true), eq(courses.type, "contact")))
    .limit(1);
  return row ?? null;
}

/**
 * Ends the seat hold a registration was stored with (phase 2b) when the payment start left no attempt to keep it: the start said "full",
 * "nothing", "rate" or "notFound", or it threw. One conditional UPDATE of the registration (db/queries/payments.ts releaseHold: only while
 * it is unpaid and no payment of it is still pending), run behind the registration's lock in a transaction of its own (releaseHoldLocked): a
 * start of the same registration from the /maksa page or the dashboard may run at once, and must not have its new hold cleared. It holds no
 * other lock, so it is within the lock order. A failed order needs none: failPayment ends the hold with the row. Never throws: the
 * registration is stored, and the hold ends by itself after its 30 minutes. (The /maksa page and POST /api/konto/maksa store no hold before
 * their start: what a start refreshes it refreshes together with a pending payment, so they have nothing to release.)
 */
async function releaseStoredHold(deps: Deps, registrationId: number): Promise<void> {
  try {
    await releaseHoldLocked(deps.db, registrationId, deps.now);
  } catch (e) {
    logFailure("[forms] register: the seat hold was not released", e);
  }
}

/** A session with the seats taken at `now` (confirmed and live holds, db/queries/seats.ts), counted now: the page the visitor saw may be out of date. */
async function sessionWithSeats(db: Q, id: number, now: Date): Promise<(CourseSession & { taken: number }) | null> {
  const [session] = await db.select().from(courseSessions).where(eq(courseSessions.id, id)).limit(1);
  if (!session) return null;
  return { ...session, taken: (await seatsTaken(db, [id], now)).get(id) ?? 0 };
}

/**
 * The contract of a registration just stored, in its transaction (contracts, D1, §4): the box she ticked is the acceptance, `form`, at the
 * submit's time. The text is the contact contract the form showed (contracts.ts contractTemplate, read now), filled with the stored
 * registration (registrationContractFields). It throws when it cannot be made, and the whole registration rolls back with it: a booking never
 * stands without its contract (D1, Review Focus 1). The registration's row is the transaction's own, so the lock it takes waits for no one.
 * The text must be the one her page showed (ruling R6): `shown`, the version the form sent, is the current one before and after the text is
 * read (shownVersionHolds), or ContractChanged rolls the registration back and she is asked to read it again.
 */
async function registrationContract(tx: Tx, registration: Registration, shown: string | undefined, now: Date): Promise<Contract> {
  const made = await registrationContractFields(tx, registration.id);
  if (!made) throw new Error(`[contracts] registration ${registration.id}: not found in its own transaction`); // ids only
  if (!(await shownVersionHolds(tx, "contact", registration.locale === "ru" ? "ru" : "et", made.template, shown))) throw new ContractChanged();
  return contractForRegistration(tx, {
    registrationId: registration.id,
    clientId: registration.clientId,
    courseId: registration.courseId,
    template: made.template,
    fields: made.fields,
    prepaymentText: made.prepaymentText,
    via: "form",
    now,
  });
}

/** The contract text a form's page showed is not the current one any more (ruling R6): nothing is stored, and the form shows the new text. */
class ContractChanged extends Error {
  constructor() {
    super("the contract's text changed since the page was loaded");
    this.name = "ContractChanged";
  }
}

/** The answer to a form whose page showed another contract text than the current one (R6): terms "changed" (the form re-shows the text, the box cleared). */
const CONTRACT_CHANGED: ActionResult = { ok: false, errors: { terms: "changed" } };

/**
 * Group registration for one session of a contact course (P12–P16). With online payments (phase 2b) the prepayment starts at once and the
 * answer carries its page (`paymentUrl`). The box is the contract (contracts, D1): it is frozen with the registration, in the same transaction,
 * and a contract that cannot be stored fails the submit (form "server", nothing stored). The confirmation mail carries its PDF. A form whose
 * page showed another contract text than the current one (its `contractVersion`, ruling R6; none from a page cached before it) stores nothing
 * and is answered terms "changed": the form shows the new text and asks for the box again.
 */
export function handleRegistration(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "register", formData, parseGroupRegistration, async ({ course: slug, courseSessionId, terms: _terms, wantsNewsletter, contractVersion, ...data }) => {
    void _terms;
    const course = await contactCourse(deps.db, slug);
    if (!course || course.priceGroup == null) return { result: fail({ form: "invalid" }) };
    // One transaction under the session's lock (the first lock of the order course_sessions → registrations → payments, db/queries/seats.ts):
    // the full check and the insert see the same seats as a payment that starts or settles meanwhile, which takes the same lock. With online
    // payments the registration is stored already holding its seat (30 minutes): whoever is queued on the lock behind it then counts that seat,
    // and "full" is told to the one who really finds none, instead of a second registration being stored for a seat that is held.
    const stored = await deps.db
      .transaction(async (tx) => {
        await lockSession(tx, courseSessionId);
        const session = await sessionWithSeats(tx, courseSessionId, deps.now);
        // Another course's session, a cancelled one or one that has begun cannot be booked (upcomingFrom: the same
        // "upcoming" as the calendar and the course page, so they offer exactly the dates that can be booked).
        if (!session || session.courseId !== course.id || session.status !== "scheduled" || session.startsAt < upcomingFrom(deps.now)) return { status: "refused" as const, result: fail({ session: "unavailable" }) };
        if (seatState(session, session.taken) === "full") return { status: "refused" as const, result: fail({ session: "full" }) };
        const seatHoldUntil = deps.montonio ? holdUntil(deps.now) : null;
        const registration = await createRegistration(tx, { ...data, courseId: course.id, courseSessionId: session.id, kind: "group", preferredPeriod: "", seatHoldUntil });
        // the contract, from the text her page showed (R6: ContractChanged otherwise, which rolls the registration back)
        const contract = await registrationContract(tx, registration, contractVersion, deps.now);
        return { status: "stored" as const, session, registration, contract };
      })
      .catch((e: unknown) => {
        // the registration rolled back with the contract it could not make from the text her page showed
        if (e instanceof ContractChanged) return { status: "refused" as const, result: CONTRACT_CHANGED };
        throw e;
      });
    if (stored.status === "refused") {
      if (stored.result === CONTRACT_CHANGED) console.info("[forms] register: the contract's text changed since the page was loaded: nothing stored");
      return { result: stored.result };
    }
    const { session, registration, contract } = stored;
    // Phase 2b (spec 6.1): the prepayment starts at once — the seat is held already (stored with the registration), then a payment row and
    // Montonio's order. Without payments, or when it does not start, the registration stands and the answer is today's ("Maksa" is offered
    // later, in the mail and Minu koolitused). A failure here never fails the stored registration: it is logged and the answer is today's.
    // The hold is kept only by a live attempt: when the start leaves none (it said full / nothing / rate / notFound, or it threw), it ends
    // here; a failed order has ended it already (failPayment).
    let paymentUrl: string | undefined;
    if (deps.montonio) {
      let attempt = false;
      try {
        const started = await startRegistrationPayment({ db: deps.db, now: deps.now, siteUrl: deps.siteUrl, notifyBase: deps.env.SITE_URL, montonio: deps.montonio }, { registrationId: registration.id });
        if (started.kind === "started") paymentUrl = started.paymentUrl;
        attempt = started.kind === "started" || started.kind === "failed";
      } catch (e) {
        logFailure("[forms] register: the payment did not start", e);
      }
      if (!attempt) await releaseStoredHold(deps, registration.id);
    }
    await deps.changed?.({ kind: "seats", course: course.slug });
    const summary = registrationSummary(
      { ...data, course: pick(course.title, "et"), startsAt: session.startsAt, city: session.city, venue: session.venue },
      admin(deps),
    );
    // the contract's PDF, rendered with the confirmation's content (none until then, and none when it failed)
    let pdf: Uint8Array | null = null;
    const confirm: Confirmation = {
      email: data.email,
      wantsAccount: data.wantsAccount,
      // the content first (the prepayment setting, the contract's PDF): a PDF that fails to render leaves the mail without it (logged)
      prepare: async () => {
        const prepayment = parsePrepayment(await readSetting(deps.db, PREPAYMENT_KEY));
        pdf = await contractPdfForMail(contract);
        const attached = pdf;
        return (login) => {
          const mail = registrationConfirmationMail({
            siteUrl: deps.siteUrl,
            email: registration.email,
            name: registration.name,
            locale: data.locale,
            registrationId: registration.id,
            course: course.title,
            session: { startsAt: session.startsAt, city: session.city ?? "", venue: session.venue ?? "" },
            paymentChoice: data.paymentChoice,
            priceCents: registrationPrice(course, "group"),
            prepayment,
            payLink: deps.montonio ? payLinkUrl(deps.siteUrl, registration.payToken) : null,
            login,
            contractAttached: attached !== null,
          });
          return attached ? { ...mail, attachments: [contractAttachment(contract.id, attached)] } : mail;
        };
      },
      // the PDF reached her: the contract's `sent_at` (D7)
      sent: async () => {
        if (pdf) await markContractSent(deps.db, contract.id, deps.now);
      },
    };
    return { result: paymentUrl ? { ok: true, paymentUrl } : OK, notify: { ...summary, replyTo: data.email }, confirm, subscribe: wantsNewsletter ? { email: data.email, locale: data.locale } : undefined };
  });
}

// ---------- requests ----------

type RequestKind = (typeof requests.$inferInsert)["kind"];
type Payload = Record<string, string | number | boolean>;

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Stores a request. An address with an account is linked to it at once (client-auth.ts accountOf), and the account's empty name
 * and phone are filled from the request's, in the same transaction.
 */
async function storeRequest(db: Db, kind: RequestKind, payload: Payload & { email: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(requests).values({ kind, payload, clientId: accountOf(normalizeEmail(payload.email)) }).returning();
    if (row.clientId !== null) await fillClientContact(tx, row.clientId, [{ name: textOf(payload.name), phone: textOf(payload.phone), at: row.createdAt }]);
  });
}

/** Individual contact course: a request to Maria with the preferred period; no payment choice (P12). */
export function handleIndividual(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "individual", formData, parseIndividual, async ({ course: slug, terms: _terms, wantsNewsletter, ...data }) => {
    void _terms;
    const course = await contactCourse(deps.db, slug);
    if (!course || course.priceIndividual == null) return { result: fail({ form: "invalid" }) };
    await storeRequest(deps.db, "individual", { course: slug, courseId: course.id, ...data });
    const summary = individualSummary({ ...data, course: pick(course.title, "et") }, admin(deps));
    const confirm: Confirmation = {
      email: data.email,
      wantsAccount: data.wantsAccount,
      prepare: async () => (login) => requestConfirmationMail({ siteUrl: deps.siteUrl, email: data.email, name: data.name, locale: data.locale, kind: "individual", title: course.title, login }),
    };
    return { result: OK, notify: { ...summary, replyTo: data.email }, confirm, subscribe: wantsNewsletter ? { email: data.email, locale: data.locale } : undefined };
  });
}

/** Message to Maria (home page, /kontakt). */
export function handleContact(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "contact", formData, parseContact, async (data) => {
    await storeRequest(deps.db, "contact", data);
    return { result: OK, notify: { ...contactSummary(data, admin(deps)), replyTo: data.email } };
  });
}

/** E-learning cart before payment exists (P9): a contact request { course, intent: "purchase", email }. */
export function handlePurchaseInterest(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "interest", formData, parsePurchaseInterest, async ({ course: slug, email, locale, wantsNewsletter }) => {
    const [course] = await deps.db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, slug), eq(courses.published, true), eq(courses.type, "e_learning")))
      .limit(1);
    if (!course) return { result: fail({ form: "invalid" }) };
    await storeRequest(deps.db, "contact", { course: slug, intent: "purchase", email, locale });
    return {
      result: OK,
      notify: { ...purchaseInterestSummary({ course: pick(course.title, "et"), email, locale }, admin(deps)), replyTo: email },
      subscribe: wantsNewsletter ? { email, locale } : undefined,
    };
  });
}

/**
 * The e-course cart's "Maksa {hind}" (phase 2b, spec 6.4): the forms' pipeline (honeypot, validation, 5 per 10 minutes per IP), a published
 * e-course with a price, then a payment row (`ecourse`; its time is the terms box's acceptance) and Montonio's order: `{ ok: true, paymentUrl }`.
 * The price is the course's own, read here: the browser sends none. Nothing else before the payment: no account, no access, no newsletter, no
 * mail (server/payments/settle.ts does that when it is paid). Without payments, or when Montonio says no: form "unavailable", and the cart
 * shows its purchase-interest form instead. An address that paid this course in the last 30 minutes starts nothing: form "alreadyPaid" (the
 * cart says "Makse on juba tehtud — vaata oma e-posti."; Back from the bank would otherwise charge a second time).
 * The box is the e-course contract (contracts, D1, §4): the payment keeps the contract the cart showed (`contract_snapshot`), the e-course text
 * in her language filled with the name and the address she typed, the course and its price (domain/contract.ts filledContract, the cart's own
 * fill), with its version and language and the time of this press (its acceptance, R7); settle freezes that very copy when the payment is paid,
 * whatever Maria edits in between. The cart sends the version it showed (`contractVersion`, ruling R6): when it is not the current one (or there
 * is none: a cart cached before it), nothing starts — no payment, no order — and the answer is terms "changed" (the cart shows the new text).
 * Without payments nothing is read for the contract at all: form "unavailable", as before.
 */
export function handleEcoursePurchase(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "ecourse", formData, parseEcoursePurchase, async ({ course: slug, name, email, locale, wantsNewsletter, terms: _terms, contractVersion }) => {
    void _terms;
    const [course] = await deps.db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, slug), eq(courses.published, true), eq(courses.type, "e_learning")))
      .limit(1);
    if (!course || course.price == null || course.price <= 0) return { result: fail({ form: "invalid" }) };
    if (!deps.montonio) return { result: fail({ form: "unavailable" }) };
    const template = await contractTemplate(deps.db, "ecourse", locale);
    if (!(await shownVersionHolds(deps.db, "ecourse", locale, template, contractVersion))) {
      console.info("[forms] ecourse: the contract's text changed since the cart was loaded: nothing started");
      return { result: CONTRACT_CHANGED };
    }
    const shown = filledContract(template, { name, email, course: contractCourseName(course.title, template.locale), session: null, priceCents: course.price, choice: null, locale: template.locale });
    const started = await startEcoursePayment(
      { db: deps.db, now: deps.now, siteUrl: deps.siteUrl, notifyBase: deps.env.SITE_URL, montonio: deps.montonio },
      {
        courseId: course.id,
        amountCents: course.price,
        email,
        name,
        locale,
        newsletter: wantsNewsletter,
        contract: { version: template.version, locale: template.locale, ...shown, acceptedAt: deps.now.toISOString() },
      },
    );
    if (started.kind === "alreadyPaid") return { result: fail({ form: "alreadyPaid" }) };
    return { result: started.kind === "started" ? { ok: true, paymentUrl: started.paymentUrl } : fail({ form: "unavailable" }) };
  });
}

/** Practice request (/praktika): Maria agrees the time afterwards; nothing is booked. */
export function handlePractice(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "practice", formData, parsePractice, async (data) => {
    const [pkg] = await deps.db.select().from(practicePackages).where(eq(practicePackages.code, data.package)).limit(1);
    if (!pkg) return { result: fail({ package: "required" }) };
    await storeRequest(deps.db, "practice", { ...data, package: pkg.code });
    const summary = practiceSummary({ ...data, package: `${pick(pkg.name, "et")} (${pkg.code})` }, admin(deps));
    // the practice form has no "Loo mulle kohe konto": its confirmation never carries a login code
    const confirm: Confirmation = {
      email: data.email,
      wantsAccount: false,
      prepare: async () => () => requestConfirmationMail({ siteUrl: deps.siteUrl, email: data.email, name: data.name, locale: data.locale, kind: "practice", title: pkg.name }),
    };
    return { result: OK, notify: { ...summary, replyTo: data.email }, confirm };
  });
}

/** Waitlist for a (full) calendar session. */
export function handleWaitlist(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "waitlist", formData, parseWaitlist, async ({ session: sessionId, wantsNewsletter, ...data }) => {
    const [row] = await deps.db
      .select({ session: courseSessions, course: courses })
      .from(courseSessions)
      .innerJoin(courses, eq(courseSessions.courseId, courses.id))
      .where(and(eq(courseSessions.id, sessionId), eq(courses.published, true)))
      .limit(1);
    // As for a registration: a cancelled session or one that has begun takes no waitlist entries (upcomingFrom: the
    // calendar's own "upcoming", so it never offers the form for such a date).
    if (!row || row.session.status !== "scheduled" || row.session.startsAt < upcomingFrom(deps.now)) return { result: fail({ form: "invalid" }) };
    const { session, course } = row;
    await storeRequest(deps.db, "waitlist", { session: session.id, course: course.slug, ...data });
    await deps.changed?.({ kind: "seats", course: course.slug });
    const summary = waitlistSummary(
      { ...data, course: pick(course.title, "et"), startsAt: session.startsAt, city: session.city, venue: session.venue },
      admin(deps),
    );
    // the waitlist form has no "Loo mulle kohe konto" either
    const confirm: Confirmation = {
      email: data.email,
      wantsAccount: false,
      prepare: async () => () =>
        requestConfirmationMail({
          siteUrl: deps.siteUrl,
          email: data.email,
          name: data.name,
          locale: data.locale,
          kind: "waitlist",
          title: course.title,
          session: { startsAt: session.startsAt, city: session.city ?? "", venue: session.venue ?? "" },
        }),
    };
    return { result: OK, notify: { ...summary, replyTo: data.email }, confirm, subscribe: wantsNewsletter ? { email: data.email, locale: data.locale } : undefined };
  });
}

// ---------- newsletter (one step) ----------

/**
 * A welcome mail that a sign-up has left due: the address that was subscribed just now (a new row, or a row of the old double opt-in
 * confirmed by this sign-up) and its language. Nothing is due for an address that was subscribed already.
 */
type WelcomeDue = { email: string; locale: "et" | "ru" };

/**
 * The newsletter's own sign-up of `email` (lower-cased by the forms), shared by handleSubscribe (the footer, the popup, the coming-soon
 * page) and subscribeLater (the registration forms' box). Since the owner's decision of 09.10 it is one step: the sign-up itself is the
 * consent and the subscription. A new address is stored confirmed (`confirmedAt` = `consentAt` = the time of the submission); a row of the
 * old double opt-in that was never confirmed is confirmed now, with its language; an address that is confirmed already is left exactly as
 * it is, but for its Resend mark: signing up again is a fresh consent (newsletter campaigns, spec D3), so the row is marked unsynced and the
 * sync after the answer sets her contact back to subscribed, should she have unsubscribed in Resend meanwhile (ruling R1). Returns what is due
 * after that — the welcome mail (welcomeLater) — or null when nothing is: the address was subscribed already. Every case leaves the address to
 * be synced (syncSubscriber). `form` is the calling form's name, for the log lines. The answer to the visitor is the same whichever it was.
 */
async function subscribeAddress(deps: Deps, form: FormName, email: string, locale: "et" | "ru"): Promise<WelcomeDue | null> {
  const [created] = await deps.db
    .insert(subscribers)
    .values({ email, locale, token: newToken(), consentAt: deps.now, confirmedAt: deps.now, clientId: accountOf(normalizeEmail(email)) })
    .onConflictDoNothing({ target: subscribers.email })
    .returning();
  if (created) return { email, locale };
  // Confirmed in one statement, so that two sign-ups of an unconfirmed row at once cannot both think they were the one that subscribed it.
  const [confirmed] = await deps.db
    .update(subscribers)
    .set({ consentAt: deps.now, confirmedAt: deps.now, locale })
    .where(and(eq(subscribers.email, email), isNull(subscribers.confirmedAt)))
    .returning();
  if (confirmed) return { email, locale };
  await deps.db.update(subscribers).set({ syncedAt: null }).where(sql`lower(${subscribers.email}) = ${normalizeEmail(email)}`);
  console.info(`[forms] ${form}: already subscribed, nothing changed (marked for the Resend sync)`);
  return null;
}

/**
 * The address's sync to Resend after a sign-up changed its row (deps.newsletterSync: absent, nothing). Never throws: the sign-up is stored, and
 * a failure is logged without the address (the row keeps its "not synced" mark for the next sync).
 */
async function syncSubscriber(deps: Deps, form: FormName, email: string): Promise<void> {
  if (!deps.newsletterSync) return;
  try {
    await deps.newsletterSync(email);
  } catch (e) {
    logFailure(`[forms] ${form}: newsletter sync failed`, e);
  }
}

/**
 * The welcome mail of a sign-up (subscribeAddress left it due), after the response. The guards run in this order and each ends the work
 * quietly, so each of them still leaves the address subscribed:
 * 1. a sample address (`@example.test`) is never mailed (the live checks register one);
 * 2. a deployment without Resend (local development, the e2e run) has nothing to send with;
 * 3. at most 3 welcome e-mails per address and day (a KV counter under the hash of the address, which fails open);
 * 4. server/newsletter.ts sendWelcome: the once-a-year mark of the address (removed again when the send fails) and one place of the
 *    newsletter's own daily counter (the `mail_quota` row "<day>:nl", 25 a day, which never fails open; the logins' and the registrations'
 *    confirmations count elsewhere, client-auth.ts) — while the coming-soon gate is on, the sign-up is the only public form, and without the
 *    cap anyone could make the site mail every address they type. Over the cap, or with the quota failing, there is no e-mail.
 * Never throws: the sign-up is stored, and a failure is logged without the address.
 */
async function welcomeLater(deps: Deps, form: FormName, due: WelcomeDue): Promise<void> {
  try {
    const address = normalizeEmail(due.email);
    if (isSampleAddress(address)) {
      console.info(`[forms] ${form}: stored; welcome e-mail skipped (sample address)`);
      return;
    }
    if (!mailConfigured(deps.env)) return;
    if (!(await allowed(deps.env, `rl:confirm:${await sha256(address)}`, CONFIRM_MAILS_PER_DAY, 24 * 60 * 60))) {
      console.info(`[forms] ${form}: welcome e-mails for this address are paused for today`);
      return;
    }
    await sendWelcome(deps, { email: address, locale: due.locale });
  } catch (e) {
    logFailure(`[forms] ${form}: welcome e-mail failed`, e);
  }
}

/**
 * "Soovin MS LABi uudiseid ja pakkumisi" ticked on a registration form (phase 2c): the newsletter's own sign-up (subscribeAddress, then
 * its welcome mail with all the guards, then the address's sync to Resend) after the answer. Never throws: the registration is stored whatever
 * happens here, and a failure is logged without the address. settle.ts calls it too, when a paid e-course purchase had the box ticked (phase 2b).
 */
export async function subscribeLater(deps: Deps, form: FormName, wish: { email: string; locale: "et" | "ru" }): Promise<void> {
  try {
    const due = await subscribeAddress(deps, form, wish.email, wish.locale);
    if (due) await welcomeLater(deps, form, due);
    await syncSubscriber(deps, form, wish.email);
  } catch (e) {
    logFailure(`[forms] ${form}: newsletter sign-up failed`, e);
  }
}

/**
 * Newsletter sign-up, in one step. The visitor types the address and presses "Liitu", and is subscribed: the row is stored before the
 * answer, confirmed, with the time of the submission as the consent (there is no consent box and no confirmation link). The answer is
 * always the same "thank you, we sent you a welcome mail", so the form never tells whether an address was subscribed already; a
 * subscribed address is left as it is and gets no mail. The welcome mail follows after the response (welcomeLater): none to a sample
 * address (`@example.test`) or from a deployment without Resend, neither of which takes a place; at most 3 per address and day; once a
 * year per address; and one place of the newsletter's daily cap. Over the cap, or with the quota failing, the address is subscribed and
 * the answer is the same, with no e-mail. The welcome code, when Seaded has one, travels in the mail only, never in the answer.
 */
export function handleSubscribe(deps: Deps, formData: FormData): Promise<ActionResult> {
  return submission(deps, "subscribe", formData, parseSubscribe, async ({ email, locale }) => {
    const welcome = await subscribeAddress(deps, "subscribe", email, locale);
    return welcome ? { result: OK, welcome, synced: email } : { result: OK, synced: email };
  });
}
