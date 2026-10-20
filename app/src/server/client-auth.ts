import { and, count, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Db, Q } from "@/db/client";
import * as schema from "@/db/schema";
import { clientLoginTokens, clients, clientSessions, mailQuota, registrations, requests, subscribers } from "@/db/schema";
import { normalizeEmail } from "@/domain/email";
import { logFailure } from "./log";
import { DUMMY_HASH, verifyPassword } from "./password";
import { isTokenShape, newToken, sha256 } from "./token";

export const CLIENT_COOKIE = "__Host-mslab_client";
export { HINT_COOKIE } from "@/lib/account-cookies";
export const LOGIN_TTL_MS = 30 * 60_000;
export const CLIENT_SESSION_TTL_MS = 180 * 86_400_000;
export const CODE_ATTEMPTS = 5;
export const CLIENT_LOGIN_CAP = 3;
/**
 * The day's mails to visitors are counted on two `mail_quota` counters (Resend Free sends 100 a day, form notifications to Maria
 * included, so the caps leave room for them):
 * - the shared one, the row "<day>": a login e-mail or a confirmation that carries a login code stops at 60, a confirmation without a
 *   code (registrations and requests, with the prepayment details) at 30. Every confirmation comes with Maria's own notification of the
 *   same submission, which this counter does not see, so 30 confirmations are about 60 mails; the last 30 of the 60 are left for sign-ins;
 * - the newsletter's own, the row "<day>:nl": the welcome mail (one for each sign-up) takes its 25 places, so a rush of sign-ups
 *   can never use up the places the registrations' and requests' confirmations and the logins need, nor the other way round. 60 + 25 = 85 is the most the two counters let out in a day, under Resend's 100.
 *
 * A third row, "<day>:all", only counts: every mail Resend accepted, whatever its kind (countSentMail, mailsSentToday). A newsletter campaign reads
 * it to stay under its room; it stops no other mail.
 */
export const LOGIN_MAIL_DAILY_CAP = 60;
export const CONFIRMATION_MAIL_DAILY_CAP = 30;
export const NEWSLETTER_MAIL_DAILY_CAP = 25;
/** What follows the date in the `mail_quota` row of the newsletter's counter. */
const NEWSLETTER_QUOTA_SUFFIX = ":nl";
/**
 * What follows the date in the `mail_quota` row that counts every mail the site sends in a day (sendMail adds to it when Resend accepted a mail): the
 * mails above, the invoices, contracts, protocols, Maria's notices, the welcome mails and the newsletter campaigns. It limits nothing by itself: a
 * campaign sends only while it is below its room (domain/newsletter-campaign.ts CAMPAIGN_DAILY_ROOM).
 */
const ALL_MAIL_QUOTA_SUFFIX = ":all";
/** Renew the session expiry at most once a day (fewer writes). */
const RENEW_AFTER_MS = 86_400_000;

export type ClientLogin = { sessionRaw: string; clientId: number; locale: "et" | "ru"; isNew: boolean };

const tx = <T>(db: Db, fn: (t: Db) => Promise<T>) =>
  (db as PostgresJsDatabase<typeof schema>).transaction((t) => fn(t as unknown as Db));

/**
 * Serialises everything that counts or starts a login for one address, until the transaction ends: parallel code
 * guesses are counted one after another (so 5 wrong tries really end the token), and two logins cannot both create the
 * client or both leave a session open (the one-device rule). Re-entrant within a transaction, so taking it again is harmless.
 * Always taken before any token row is locked (lock order address, then row), so a link and a code for one token cannot deadlock.
 */
export async function lockAddress(t: Db, address: string): Promise<void> {
  await t.execute(sql`select pg_advisory_xact_lock(hashtext(${"client-login:" + address}))`);
}

/** Six digits, uniform (rejection sampling). */
function sixDigits(): string {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4_294_000_000);
  return String(a[0] % 1_000_000).padStart(6, "0");
}

/** A login for `email` (link token + code), or null when the address already has CLIENT_LOGIN_CAP live logins. */
export async function issueClientLogin(db: Db, email: string, now = new Date()): Promise<{ token: string; code: string } | null> {
  const address = normalizeEmail(email);
  return tx(db, async (t) => {
    await lockAddress(t, address);
    await t.delete(clientLoginTokens).where(lt(clientLoginTokens.expiresAt, now));
    const [{ n }] = await t.select({ n: count() }).from(clientLoginTokens)
      .where(and(eq(clientLoginTokens.email, address), isNull(clientLoginTokens.usedAt), gt(clientLoginTokens.expiresAt, now)));
    if (n >= CLIENT_LOGIN_CAP) return null;
    const token = newToken();
    const code = sixDigits();
    const hash = await sha256(token);
    await t.insert(clientLoginTokens).values({
      hash, codeHash: await sha256(`${hash}:${code}`), email: address, expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
    });
    return { token, code };
  });
}

/**
 * Creates the client if new, ends its other sessions, links its records and starts a session. `newClientLocale` (the
 * language of the page the login was asked for) is the language of a client created here; an existing client keeps its own.
 */
async function startSession(t: Db, address: string, now: Date, newClientLocale?: "et" | "ru"): Promise<ClientLogin> {
  await lockAddress(t, address); // the three callers (link, code, password) hold it already (re-entrant, no wait); kept so no future caller can skip it
  const [existing] = await t.select().from(clients).where(eq(clients.email, address)).limit(1);
  const client = existing ?? (await t.insert(clients).values({ email: address, ...(newClientLocale ? { locale: newClientLocale } : {}) }).returning())[0];
  await t.update(clientSessions).set({ endedAt: now, endReason: "replaced" })
    .where(and(eq(clientSessions.clientId, client.id), isNull(clientSessions.endedAt)));
  const sessionRaw = newToken();
  await t.insert(clientSessions).values({
    idHash: await sha256(sessionRaw), clientId: client.id, createdAt: now, expiresAt: new Date(now.getTime() + CLIENT_SESSION_TTL_MS),
  });
  await linkClientRecords(t, client.id, address);
  return { sessionRaw, clientId: client.id, locale: client.locale, isNew: !existing };
}

/** The session for a login link (once); `newClientLocale` as in startSession. Null: unknown, used, expired or dead. */
export async function redeemClientLink(db: Db, token: string, now = new Date(), newClientLocale?: "et" | "ru"): Promise<ClientLogin | null> {
  if (!isTokenShape(token)) return null;
  return tx(db, async (t) => {
    const hash = await sha256(token);
    // The address lock comes before the token row is locked by the UPDATE below: a code redeem for the same token
    // (lock, then row) would otherwise wait for this row while this waits for its lock.
    const [peek] = await t.select({ email: clientLoginTokens.email }).from(clientLoginTokens).where(eq(clientLoginTokens.hash, hash)).limit(1);
    if (!peek) return null;
    await lockAddress(t, peek.email);
    const [row] = await t.update(clientLoginTokens).set({ usedAt: now })
      .where(and(eq(clientLoginTokens.hash, hash), isNull(clientLoginTokens.usedAt), gt(clientLoginTokens.expiresAt, now),
        lt(clientLoginTokens.attempts, CODE_ATTEMPTS)))
      .returning();
    return row ? startSession(t, row.email, now, newClientLocale) : null;
  });
}

/**
 * The session for a right code; "wrong" (attempts counted on every live token of the address); null when none is live.
 * `newClientLocale` as in startSession.
 */
export async function redeemClientCode(db: Db, email: string, code: string, now = new Date(), newClientLocale?: "et" | "ru"): Promise<ClientLogin | "wrong" | null> {
  const address = normalizeEmail(email);
  if (!/^\d{6}$/.test(code)) return "wrong";
  return tx(db, async (t) => {
    await lockAddress(t, address); // before reading the attempts: parallel guesses are counted one after another
    const live = await t.select().from(clientLoginTokens)
      .where(and(eq(clientLoginTokens.email, address), isNull(clientLoginTokens.usedAt), gt(clientLoginTokens.expiresAt, now),
        lt(clientLoginTokens.attempts, CODE_ATTEMPTS)));
    if (!live.length) return null;
    for (const row of live) {
      if ((await sha256(`${row.hash}:${code}`)) === row.codeHash) {
        await t.update(clientLoginTokens).set({ usedAt: now }).where(eq(clientLoginTokens.hash, row.hash));
        return startSession(t, address, now, newClientLocale);
      }
    }
    // Counts against the live tokens just read (under the lock), never the expired rows a parallel purge may be deleting.
    await t.update(clientLoginTokens).set({ attempts: sql`${clientLoginTokens.attempts} + 1` })
      .where(inArray(clientLoginTokens.hash, live.map((row) => row.hash)));
    return "wrong";
  });
}

/**
 * Runs `fn` in a transaction that holds the login lock of `address` (normalised already) until it ends: whatever changes what a login
 * for that address reads or does (the password's set and removal, client-password.ts) takes its turn with the logins, never in the
 * middle of one.
 */
export async function underAddressLock<T>(db: Db, address: string, fn: (t: Db) => Promise<T>): Promise<T> {
  return tx(db, async (t) => {
    await lockAddress(t, address);
    return fn(t);
  });
}

/**
 * The password login's lock for one address (account-api.ts passwordLogin, phase 2c): its counter, on the login's transaction `t`.
 * `open()`: may this attempt be checked; `failed()`: count it as a failure.
 */
export type PasswordGate = (t: Db) => { open(): Promise<boolean>; failed(): Promise<void> };

/**
 * The session for an e-mail and the password set in Minu andmed (phase 2c); null: an unknown address, no password set and a wrong
 * password alike; "locked": the gate is shut. The gate is required: there is no way to ask for a password check that is not counted
 * and limited. Everything runs in one transaction under the address lock, so the attempts for one address go one after another, and
 * attempts sent in parallel cannot pass the gate together: the gate is asked first (a locked attempt checks nothing and counts
 * nothing), then scrypt runs every time — against a fixed dummy hash when there is no password to check — so the answer takes as
 * long whatever the address, and a failure is counted before the lock is let go. The session is the code's (startSession: the
 * one-device rule). Never a new client.
 */
export async function redeemClientPassword(db: Db, email: string, password: string, now: Date, gate: PasswordGate): Promise<ClientLogin | "locked" | null> {
  const address = normalizeEmail(email);
  return tx(db, async (t) => {
    await lockAddress(t, address);
    const lock = gate(t);
    if (!(await lock.open())) return "locked";
    const [row] = await t.select({ hash: clients.passwordHash }).from(clients).where(eq(clients.email, address)).limit(1);
    const stored = row?.hash ?? null;
    const matches = await verifyPassword(password, stored ?? DUMMY_HASH);
    if (matches && stored !== null) return startSession(t, address, now);
    await lock.failed();
    return null;
  });
}

/**
 * The session of a cookie value: its client, or why it is over (`ended`). A live session is renewed (180 days from now) at most
 * once a day; `renewed` says it was, and then the caller must send the cookies again (api: account-api.ts requireClient), or the
 * browser drops them 180 days after the login however often the student comes back.
 */
export async function getClientSession(db: Db, raw: string | undefined, now = new Date()) {
  if (!isTokenShape(raw)) return null;
  const idHash = await sha256(raw);
  const [row] = await db.select().from(clientSessions).where(eq(clientSessions.idHash, idHash)).limit(1);
  if (!row) return null;
  if (row.endedAt) return { ended: row.endReason ?? "logout" } as const;
  if (row.expiresAt <= now) return { ended: "expired" } as const;
  let renewed = false;
  if (row.expiresAt.getTime() - now.getTime() < CLIENT_SESSION_TTL_MS - RENEW_AFTER_MS) {
    // Only an open session is renewed: a logout or a newer login between the read and this write keeps it ended, and then
    // no fresh cookies go out. (The cast: on the Db union, returning(fields) has no common overload.)
    const done = await (db as PostgresJsDatabase<typeof schema>).update(clientSessions)
      .set({ expiresAt: new Date(now.getTime() + CLIENT_SESSION_TTL_MS) })
      .where(and(eq(clientSessions.idHash, idHash), isNull(clientSessions.endedAt)))
      .returning({ one: sql<number>`1` });
    renewed = done.length > 0;
  }
  return { clientId: row.clientId, renewed } as const;
}

export async function endClientSession(db: Db, raw: string | undefined, now = new Date()): Promise<void> {
  if (!isTokenShape(raw)) return;
  await db.update(clientSessions).set({ endedAt: now, endReason: "logout" })
    .where(and(eq(clientSessions.idHash, await sha256(raw)), isNull(clientSessions.endedAt)));
}

/** An ended or run-out session is kept this long: its device is told "Sinu konto avati teises seadmes" (`replaced`) meanwhile. */
const ENDED_SESSION_KEEP_MS = 30 * 86_400_000;
/** The day's mail counter is kept this many days (a week of history to look at; the counter only ever reads today's). */
const MAIL_QUOTA_KEEP_DAYS = 7;

/**
 * The daily sweep's part for the client accounts (app/api/cron/sweep), counts only (a constant per row: nothing leaves the database):
 * - `logins`: login codes and links past their 30 minutes. They hold the address in plain text; issueClientLogin deletes them too,
 *   but only when somebody asks for a login;
 * - `sessions`: sessions ended (logout, replaced) or run out more than 30 days ago;
 * - `mailDays`: the `mail_quota` rows of days more than a week before today (UTC, as the counter's own day), the newsletter's
 *   "<day>:nl" rows and the day's count of all mails "<day>:all" with them (the date is the row's first 10 characters).
 * A failing database throws.
 */
export async function sweepClientRows(db: Db, now: Date = new Date()): Promise<{ logins: number; sessions: number; mailDays: number }> {
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const q = db as PostgresJsDatabase<typeof schema>;
  const one = { one: sql<number>`1` };
  const before = new Date(now.getTime() - ENDED_SESSION_KEEP_MS);
  const oldestDay = new Date(now.getTime() - MAIL_QUOTA_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [logins, sessions, mailDays] = await Promise.all([
    q.delete(clientLoginTokens).where(lte(clientLoginTokens.expiresAt, now)).returning(one),
    q.delete(clientSessions).where(or(lt(clientSessions.endedAt, before), lt(clientSessions.expiresAt, before))).returning(one),
    q.delete(mailQuota).where(lt(sql`left(${mailQuota.day}, 10)`, oldestDay)).returning(one),
  ]);
  return { logins: logins.length, sessions: sessions.length, mailDays: mailDays.length };
}

/** One more place of the `mail_quota` row `key`, unless `cap` is reached (the row cannot fail open like the rate limits). */
async function reserveMailPlace(db: Q, key: string, cap: number): Promise<boolean> {
  const rows = await db.insert(mailQuota).values({ day: key, sent: 1 })
    .onConflictDoUpdate({ target: mailQuota.day, set: { sent: sql`${mailQuota.sent} + 1` }, setWhere: sql`${mailQuota.sent} < ${cap}` })
    .returning();
  return rows.length > 0;
}

const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** One more place of today's shared counter (a login e-mail, a confirmation of a registration or request), unless `cap` is reached. */
export async function reserveLoginMail(db: Q, now = new Date(), cap = LOGIN_MAIL_DAILY_CAP): Promise<boolean> {
  return reserveMailPlace(db, dayOf(now), cap);
}

/** One more place of today's newsletter counter (the welcome mail), unless `cap` is reached. */
export async function reserveNewsletterMail(db: Q, now = new Date(), cap = NEWSLETTER_MAIL_DAILY_CAP): Promise<boolean> {
  return reserveMailPlace(db, dayOf(now) + NEWSLETTER_QUOTA_SUFFIX, cap);
}

/**
 * One more mail in today's count of every mail the site sends (the row "<UTC day>:all"; a place is not reserved, the mail has gone already). Best
 * effort, like the notifications themselves: a database that fails is logged (the class and the code, never the message) and the mail stays sent,
 * so this never throws.
 */
export async function countSentMail(db: Q, now = new Date()): Promise<void> {
  try {
    await db.insert(mailQuota).values({ day: dayOf(now) + ALL_MAIL_QUOTA_SUFFIX, sent: 1 })
      .onConflictDoUpdate({ target: mailQuota.day, set: { sent: sql`${mailQuota.sent} + 1` } });
  } catch (e) {
    logFailure("[mail] the day's mail count not written", e);
  }
}

/** How many mails the site has sent in the UTC day of `now` (the row "<day>:all"): 0 for a day with no mail. A failing database throws. */
export async function mailsSentToday(db: Q, now = new Date()): Promise<number> {
  const [row] = await db.select({ sent: mailQuota.sent }).from(mailQuota).where(eq(mailQuota.day, dayOf(now) + ALL_MAIL_QUOTA_SUFFIX)).limit(1);
  return row?.sent ?? 0;
}

/**
 * The id of the account of `address` (normalised already), or null: the value of `client_id` in the INSERT of a new registration,
 * request or newsletter row (server/submit.ts), so the record belongs to the account from the start (spec §2 "new ones link at
 * creation time": a signed-in student sees what she has just booked without logging in again). A read needs no address lock.
 * FOR KEY SHARE settles a race with the account's deletion (client-data.ts deleteClient): a deletion that has not reached the
 * client row yet waits until the insert commits and then unlinks the new row as it unlinks the others (ON DELETE SET NULL); a
 * deletion that has removed the row already makes this read skip it once that deletion commits, so the record is stored unlinked.
 * Without the lock the insert's foreign key check would meet the deleted row and fail the submission (23503).
 */
export const accountOf = (address: string) =>
  sql<number | null>`(select ${clients.id} from ${clients} where ${clients.email} = ${address} for key share)`;

/** The name and phone a linked record gives (a request's are in its payload: the waitlist form has no phone, the cart neither). */
export type ContactSource = { name: string | null; phone: string | null; at: Date };

/** The longest name and phone a client keeps (the forms' and Minu andmed's limits). */
const NAME_MAX = 120;
const PHONE_MAX = 40;

/**
 * Fills the client's name and phone where they are still empty, each from the newest of `records` that has one (spec 2.1 rule 4:
 * no set-up, the name and phone come from the registration). A name or phone the client has, saved in Minu andmed or filled
 * before, is never replaced.
 */
export async function fillClientContact(db: Q, clientId: number, records: ContactSource[]): Promise<void> {
  const newestFirst = [...records].sort((a, b) => b.at.getTime() - a.at.getTime());
  const newest = (of: (r: ContactSource) => string | null, max: number): string =>
    newestFirst.map((r) => (of(r) ?? "").trim()).find((v) => v !== "")?.slice(0, max) ?? "";
  const name = newest((r) => r.name, NAME_MAX);
  const phone = newest((r) => r.phone, PHONE_MAX);
  if (!name && !phone) return;
  await db
    .update(clients)
    .set({
      name: sql`case when ${clients.name} = '' then ${name} else ${clients.name} end`,
      phone: sql`case when ${clients.phone} = '' then ${phone} else ${clients.phone} end`,
    })
    .where(and(eq(clients.id, clientId), or(eq(clients.name, ""), eq(clients.phone, ""))));
}

/**
 * Links registrations, requests (payload e-mail) and the newsletter row of `email` to the client, and fills the client's empty
 * name and phone from the records linked NOW (fillClientContact): a new client gets them from her newest registration or request,
 * and a field she emptied in Minu andmed is not filled again from records that were linked before.
 */
export async function linkClientRecords(db: Q, clientId: number, email: string): Promise<void> {
  const address = normalizeEmail(email);
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const q = db as unknown as PostgresJsDatabase<typeof schema>;
  const regs = await q
    .update(registrations)
    .set({ clientId })
    .where(and(isNull(registrations.clientId), sql`lower(${registrations.email}) = ${address}`))
    .returning({ name: registrations.name, phone: registrations.phone, at: registrations.createdAt });
  const reqs = await q
    .update(requests)
    .set({ clientId })
    .where(and(isNull(requests.clientId), sql`lower(${requests.payload}->>'email') = ${address}`))
    .returning({ name: sql<string | null>`${requests.payload}->>'name'`, phone: sql<string | null>`${requests.payload}->>'phone'`, at: requests.createdAt });
  await db.update(subscribers).set({ clientId }).where(and(isNull(subscribers.clientId), sql`lower(${subscribers.email}) = ${address}`));
  await fillClientContact(db, clientId, [...regs, ...reqs]);
}
