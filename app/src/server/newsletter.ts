import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { clients, subscribers } from "@/db/schema";
import type { Subscriber } from "@/db/schema";
import { isSampleAddress, normalizeEmail } from "@/domain/email";
import { welcomeCodeOf } from "@/domain/welcome-code";
import { welcomeMail } from "./account-mail";
import { reserveNewsletterMail } from "./client-auth";
import { logFailure, logNote } from "./log";
import { mailConfigured, sendMail, type Env } from "./notify";
import { forgetKey, type TextKv } from "./ratelimit";
import { isTokenShape, sha256 } from "./token";

// The newsletter after the sign-up (phase 2c, spec 5; one step since 09.10): where an address stands (the admin's drawer, Minu andmed), the
// welcome mail with Seaded's "Tervituskood" and the unsubscribe link, and the work of the two links a mailbox may hold: the unsubscribe link
// of the welcome mail and the confirmation link of the old double opt-in. Without Next.js: the routes and the account API build the
// dependencies; the tests pass PGlite, an in-memory KV and a stubbed Resend.

/** An address's newsletter: confirmed ("yes"), waiting for its confirmation ("pending": only a row of the old flow), or no row ("no"). */
export type NewsletterState = "yes" | "pending" | "no";

/** The newsletter state of an address (a row may hold it in any case). */
export async function newsletterState(db: Q, email: string): Promise<NewsletterState> {
  const [row] = await db.select({ confirmedAt: subscribers.confirmedAt }).from(subscribers).where(sql`lower(${subscribers.email}) = ${normalizeEmail(email)}`).limit(1);
  return !row ? "no" : row.confirmedAt ? "yes" : "pending";
}

/** A client's address, language and newsletter state; null when the client is gone. */
export async function clientNewsletter(db: Db, clientId: number): Promise<{ email: string; locale: "et" | "ru"; state: NewsletterState } | null> {
  const [client] = await db.select({ email: clients.email, locale: clients.locale }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return client ? { ...client, state: await newsletterState(db, client.email) } : null;
}

/** `siteUrl`: the base of the links in the mail (the allow-listed request origin, else SITE_URL; server/site.ts linkBase). */
export type WelcomeDeps = { db: Db; env: Env; now: Date; siteUrl: string };

/** The unsubscribe link of the welcome mail: the subscriber's own token, on the site's address (GET /api/newsletter/loobu opens a page with a button; the button's POST unsubscribes). */
export const unsubscribeUrl = (siteUrl: string, token: string) => `${siteUrl.replace(/\/+$/, "")}/api/newsletter/loobu?t=${encodeURIComponent(token)}`;

/** The token of an address's subscriber row (the address may be stored in any case), or null: no row. */
async function subscriberToken(db: Db, address: string): Promise<string | null> {
  const [row] = await db.select({ token: subscribers.token }).from(subscribers).where(sql`lower(${subscribers.email}) = ${address}`).limit(1);
  return row?.token ?? null;
}

/** A welcome mail is sent to an address at most once in this many seconds (a KV mark under the hash of the address). */
const WELCOME_ONCE_SEC = 365 * 24 * 60 * 60;

/** The KV key of an address's "had its welcome" mark (`address` normalised already). */
const welcomeMarkKey = async (address: string) => `rl:welcome:${await sha256(address)}`;

/**
 * The welcome mail to a newly subscribed address (the sign-up, "Saada mulle uudiskirja", the old confirmation link): the greeting, Seaded's
 * welcome code when there is one (without a code the mail still goes out), and the unsubscribe link of the address's row. Never throws, and
 * logs no address, no token and no code. No mail when: the address is a sample one; Resend is not set up; the address has no subscriber row
 * (it unsubscribed meanwhile: there is no link to give); the address had its welcome this year (a KV mark, read first and written only once
 * the day's quota has a place for the mail; a store that fails lets the mail go, as the other limits do); the newsletter's daily cap is
 * reached (its own mail_quota row, which never fails open — a capped day writes no mark). A send that Resend refuses or that fails takes the
 * mark away again, so that address can still get its welcome (the place of the day's cap it spent stays spent).
 */
export async function sendWelcome(deps: WelcomeDeps, to: { email: string; locale: string }): Promise<void> {
  try {
    const address = normalizeEmail(to.email);
    if (isSampleAddress(address) || !mailConfigured(deps.env)) return;
    const token = await subscriberToken(deps.db, address);
    if (!token) {
      console.info("[newsletter] welcome e-mail skipped: the address is no longer subscribed");
      return;
    }
    const code = welcomeCodeOf(await readSetting(deps.db, "newsletter")) || null;
    const mark = await welcomeMarkKey(address);
    try {
      if (await deps.env.KV.get(mark)) {
        console.info("[newsletter] welcome e-mail sent to this address before: not again");
        return;
      }
    } catch (e) {
      logFailure("[newsletter] welcome mark unavailable, sending", e);
    }
    if (!(await reserveNewsletterMail(deps.db, deps.now))) {
      logNote("[newsletter] daily mail cap reached: no welcome e-mail");
      return;
    }
    try {
      await deps.env.KV.put(mark, "1", { expirationTtl: WELCOME_ONCE_SEC });
    } catch (e) {
      logFailure("[newsletter] welcome mark not written", e);
    }
    let sent = false;
    try {
      sent = await sendMail(deps.env, welcomeMail(address, code, to.locale === "ru" ? "ru" : "et", unsubscribeUrl(deps.siteUrl, token)));
    } catch (e) {
      logFailure("[newsletter] welcome e-mail failed to send", e);
    }
    console.info(`[newsletter] welcome e-mail sent: ${sent}`);
    if (!sent) {
      // Resend refused or failed: the mark must not keep her from the welcome for a year (the Minu andmed path loses the mail, too). The
      // cap place spent above stays spent: the attempt did reach Resend, and a mail that keeps failing must not be retried without limit.
      try {
        await forgetKey(deps.env.KV, mark);
      } catch (e) {
        logFailure("[newsletter] welcome mark not removed", e);
      }
    }
  } catch (e) {
    logFailure("[newsletter] welcome e-mail failed", e);
  }
}

/**
 * The language of the row a token belongs to (the page behind the unsubscribe link is shown in it), or null: a malformed token or no such row.
 * Only reads.
 */
export async function subscriberLocale(db: Db, token: string): Promise<"et" | "ru" | null> {
  if (!isTokenShape(token)) return null;
  const [row] = await db.select({ locale: subscribers.locale }).from(subscribers).where(eq(subscribers.token, token)).limit(1);
  return row ? (row.locale === "ru" ? "ru" : "et") : null;
}

/**
 * The button of the unsubscribe page (POST /api/newsletter/loobu, the only thing that unsubscribes): deletes the subscriber's row, forgets
 * the address's once-a-year welcome mark (so a later sign-up gets a fresh welcome, with a link for its new row), and says which language she
 * gets the answer in. null = no such row (an unknown or malformed token, or the button pressed before): nothing is deleted or forgotten,
 * and the caller answers the same. A store that cannot forget is logged and does not undo the unsubscribing.
 */
export async function unsubscribeByToken(db: Db, kv: TextKv, token: string): Promise<{ locale: "et" | "ru" } | null> {
  if (!isTokenShape(token)) return null;
  const [gone] = await db.delete(subscribers).where(eq(subscribers.token, token)).returning();
  if (!gone) return null;
  try {
    await forgetKey(kv, await welcomeMarkKey(normalizeEmail(gone.email)));
  } catch (e) {
    logFailure("[newsletter] welcome mark not forgotten", e);
  }
  return { locale: gone.locale === "ru" ? "ru" : "et" };
}

/**
 * The confirmation link of the old double opt-in (links already sent are still in mailboxes): sets `confirmedAt` once (later clicks keep the
 * first time). `first` is true for the click that confirmed it (the welcome mail follows that one only, confirmNewsletter). null = unknown token.
 */
export async function confirmSubscriber(db: Db, token: string, now: Date): Promise<{ sub: Subscriber; first: boolean } | null> {
  if (!isTokenShape(token)) return null;
  const [confirmed] = await db.update(subscribers).set({ confirmedAt: now }).where(and(eq(subscribers.token, token), isNull(subscribers.confirmedAt))).returning();
  if (confirmed) return { sub: confirmed, first: true };
  const [row] = await db.select().from(subscribers).where(eq(subscribers.token, token)).limit(1);
  return row ? { sub: row, first: false } : null;
}

/**
 * The confirmation link of the old flow (/api/newsletter/confirm): the subscriber confirmed; on the first confirmation with a welcome code set,
 * the welcome mail after the response (`later`) and the code for the confirmed page (the redirect's fragment). Without a code set nothing is
 * mailed here, as before. A repeat confirmation gives no code and sends nothing. `locale`: the subscriber's, for the home page it lands on.
 */
export async function confirmNewsletter(
  deps: WelcomeDeps & { later: (task: () => Promise<unknown>) => void },
  token: string,
): Promise<{ outcome: "kinnitatud" | "vigane"; locale: "et" | "ru"; code: string | null }> {
  const confirmed = await confirmSubscriber(deps.db, token, deps.now);
  if (!confirmed) return { outcome: "vigane", locale: "et", code: null };
  const locale = confirmed.sub.locale === "ru" ? "ru" : "et";
  if (!confirmed.first) return { outcome: "kinnitatud", locale, code: null };
  // The confirmation has stood by now, and the next click is no longer "first": a failing settings read must not turn this answer into
  // an error or drop the welcome mail. The page then shows no code (the mail still carries it: sendWelcome reads the setting itself).
  let code = "";
  try {
    code = welcomeCodeOf(await readSetting(deps.db, "newsletter"));
    if (!code) return { outcome: "kinnitatud", locale, code: null }; // read fine, no code set: no mail either
  } catch (e) {
    logFailure("[newsletter] settings unavailable after the confirmation, no code on the page", e);
  }
  const to = { email: confirmed.sub.email, locale };
  deps.later(() => sendWelcome(deps, to));
  return { outcome: "kinnitatud", locale, code: code || null };
}
