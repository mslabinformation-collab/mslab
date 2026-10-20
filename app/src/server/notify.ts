import { Resend } from "resend";
import type { Q } from "@/db/client";
import { normalizeEmail } from "@/domain/email";
import { countSentMail } from "./client-auth";
import { errorSummary } from "./log";
import type { TextKv } from "./ratelimit";

// Outgoing notifications: e-mail through Resend and a Telegram ping to Maria (until launch: to Dim, see MARIA_EMAIL in
// the Vercel project's settings). Both are best effort — callers store the submission first and never fail a request because of a
// notification. Without the secrets (local `next dev` has no RESEND_API_KEY / TELEGRAM_BOT_TOKEN) nothing is sent
// and a console note says so. Logs never contain addresses, message text, tokens or provider error messages.

/** The settings and secrets notifications use (part of server/env.ts plus the KV store; secrets are optional). */
export type Env = {
  KV: TextKv;
  MAIL_FROM: string;
  MARIA_EMAIL: string;
  SITE_URL: string;
  RESEND_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  /** Optional override of the chat; otherwise the chat id stored in KV under `tg:chat` (copied from the old review site's KV by db:copy-kv). */
  TELEGRAM_CHAT_ID?: string;
};

/** A file a mail carries (an invoice's PDF, invoices Task 4): its name as the reader sees it, its bytes and its media type. */
export type MailAttachment = { filename: string; content: Buffer; contentType: string };

/**
 * `text` is always there; `html`, when given, is the same message for clients that show HTML (the text stays as the fallback);
 * `attachments`, when given, the files it carries; `headers`, when given and not empty, extra headers of the message (a campaign mail's
 * List-Unsubscribe and List-Unsubscribe-Post, the mail program's own unsubscribe button).
 */
export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  headers?: Record<string, string>;
};

/**
 * What a send may be given besides the mail. `count`: the database of the day's mail count; a mail Resend accepted is added to it
 * (client-auth.ts countSentMail, best effort). Without it nothing is counted, so a caller that has a database passes it.
 */
export type SendOptions = { count?: Q };

const TELEGRAM_MAX = 3900;
export const TG_CHAT_KEY = "tg:chat";
/** A hung provider call must not hold the function after the response (next/server after()). */
export const NOTIFY_TIMEOUT_MS = 8000;

/** How long sendMail waits before trying once more after Resend answered 429 (its default limit is about 2 requests a second). */
export const RATE_LIMIT_RETRY_MS = 1000;

class TimeoutError extends Error {}

/** Resolves or rejects like `p`, or rejects with a TimeoutError after `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Is e-mail configured (RESEND_API_KEY)? When it is not (local `next dev`, the e2e run), says so in the log, as sendMail does for
 * a mail it skips: a caller that would otherwise spend something on a mail first (a login, a quota) asks before.
 */
export function mailConfigured(env: Env): boolean {
  if (env.RESEND_API_KEY) return true;
  console.info("[notify] RESEND_API_KEY is not set: e-mail skipped");
  return false;
}

/** Did Resend refuse this send for sending too fast? (A used-up daily or monthly quota is also a 429, and waiting a second does not help it.) */
const rateLimited = (e: { name?: string | null; statusCode?: number | null }): boolean =>
  e.name === "rate_limit_exceeded" || (e.statusCode === 429 && !/quota/.test(e.name ?? ""));

/**
 * Why a send did not go (sendMailResult), for a caller that must tell the outcomes apart: a newsletter campaign maps each one to one status of its
 * delivery (the simple newsletter, spec §3 "at most once"; newsletter-campaigns.ts runBatch).
 * - `address`: Resend refused this recipient's address itself (a `validation_error` whose message names the `to` field): nothing went, and another
 *   try would not help.
 * - `quota`: Resend's daily or monthly limit is reached (`daily_quota_exceeded`, `monthly_quota_exceeded`, both 429): nothing went.
 * - `refused`: any other refusal, a 4xx that is not this address's fault: the key (`invalid_api_key`, `restricted_api_key`, `missing_api_key`), the
 *   account in Resend's testing mode or an unverified domain (a `validation_error` that does not name `to`), another field, `security_error`, the
 *   rate limit still after its one retry; and RESEND_API_KEY not set at all. Nothing went.
 * - `unknown`: no answer that says: a timeout (NOTIFY_TIMEOUT_MS), a 5xx (`internal_server_error`, or the SDK's `application_error` with the status),
 *   the network (the SDK's `application_error` with no status), anything thrown. The mail may or may not have gone.
 */
export type MailFailure = "address" | "quota" | "refused" | "unknown";
export type MailOutcome = { ok: true } | { ok: false; kind: MailFailure };

/** The SDK's error names (resend 6.31 RESEND_ERROR_CODE_KEY) of the two limits of the account. */
const QUOTA_ERRORS = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);

/**
 * Does a validation error concern the recipient? Resend's message names the field in backquotes ("Invalid `to` field. The email address needs to
 * follow the …"); its testing-mode refusal ("You can only send testing emails to your own email address …") names no field: it is the account's,
 * so it is `refused`, never `address` (that would fail every subscriber in turn). The message is only read here, never logged: it can quote the address.
 */
const namesRecipient = (message: unknown): boolean => typeof message === "string" && /`to`|\bto field\b/i.test(message);

/** The outcome of an error answer of Resend (the SDK's ErrorResponse: name, statusCode, message). */
function failureOf(e: { name?: string | null; statusCode?: number | null; message?: string | null }): MailFailure {
  if (QUOTA_ERRORS.has(e.name ?? "")) return "quota";
  const status = e.statusCode;
  if (typeof status !== "number" || status < 400 || status >= 500) return "unknown";
  if (e.name === "validation_error" && namesRecipient(e.message)) return "address";
  return "refused";
}

/**
 * Maria's inbox for a mail that has no Reply-To of its own, unless the mail goes to her (spec D8): a student who answers a mail from the
 * sending-only send.mslab.ee address reaches Maria. The addresses are compared trimmed and in lower case; undefined when MARIA_EMAIL is empty.
 */
export function defaultReplyTo(env: Pick<Env, "MARIA_EMAIL">, to: string): string | undefined {
  const maria = env.MARIA_EMAIL.trim();
  if (!maria || normalizeEmail(maria) === normalizeEmail(to)) return undefined;
  return maria;
}

/**
 * Sends one e-mail: plain text, plus HTML when `mail.html` is set. true = Resend accepted it (sendMailResult's `ok`; every other outcome is
 * false).
 */
export async function sendMail(env: Env, mail: Mail, opts: SendOptions = {}): Promise<boolean> {
  return (await sendMailResult(env, mail, { count: opts.count })).ok;
}

/**
 * Sends one e-mail as sendMail does, and says which outcome it had (MailOutcome: accepted, or why not). When Resend answers that it is being asked
 * too often (429; its default limit is about 2 requests a second) the send is tried once more after RATE_LIMIT_RETRY_MS, never a third time.
 * The Reply-To is the mail's own, else Maria's inbox (defaultReplyTo), else none. The mail's attachments go with it, each file's bytes as
 * Base64 (one of the two forms Resend takes, and the smaller one in the request's JSON). The mail's headers go as they are. A mail Resend
 * accepted is added to the day's count when `opts.count` is given (SendOptions); a refused or failed one never is, and a count that fails does
 * not change the answer. So a mail whose answer never came (`unknown`: a timeout) is not counted either, though it may have gone: the day's count
 * can be a little low, and a campaign's room (CAMPAIGN_DAILY_ROOM) is soft by those few. That is accepted: such answers are rare, and Resend's own
 * daily limit is still 30 mails above the room.
 */
export async function sendMailResult(env: Env, mail: Mail, opts: SendOptions = {}): Promise<MailOutcome> {
  if (!mailConfigured(env)) return { ok: false, kind: "refused" }; // (nothing was asked of Resend)
  const replyTo = mail.replyTo ?? defaultReplyTo(env, mail.to);
  try {
    const send = () =>
      withTimeout(
        new Resend(env.RESEND_API_KEY).emails.send({
          from: env.MAIL_FROM,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          ...(mail.html ? { html: mail.html } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(mail.attachments?.length
            ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), contentType: a.contentType })) }
            : {}),
          ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
        }),
        NOTIFY_TIMEOUT_MS,
      );
    let result = await send();
    if (result.error && rateLimited(result.error)) {
      console.info("[notify] Resend asks for fewer requests: the e-mail is tried once more");
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
      result = await send();
    }
    const { data, error } = result;
    if (error) {
      // error.message can quote the recipient: only the error name and HTTP status are logged.
      console.error(`[notify] Resend rejected the e-mail: ${errorSummary(error)}`);
      return { ok: false, kind: failureOf(error) };
    }
    console.info(`[notify] Resend accepted the e-mail: ${data?.id ?? "?"}`);
    if (opts.count) await countSentMail(opts.count);
    return { ok: true };
  } catch (e) {
    console.error(`[notify] Resend request failed: ${errorSummary(e)}`);
    return { ok: false, kind: "unknown" };
  }
}

/**
 * The chat for notifications: TELEGRAM_CHAT_ID if set, otherwise the id stored in KV `tg:chat`. The app never binds a
 * chat itself (no getUpdates, no KV writes): whoever writes to the bot must not start receiving submissions.
 */
export async function chatId(env: Env): Promise<string | null> {
  if (env.TELEGRAM_CHAT_ID) return env.TELEGRAM_CHAT_ID;
  return (await env.KV.get(TG_CHAT_KEY)) || null;
}

/** Sends a plain-text Telegram message. true = Telegram answered ok. */
export async function sendTelegram(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.info("[notify] TELEGRAM_BOT_TOKEN is not set: Telegram skipped");
    return false;
  }
  try {
    const chat = await chatId(env);
    if (!chat) {
      console.info("[notify] no Telegram chat (TELEGRAM_CHAT_ID / KV tg:chat): Telegram skipped");
      return false;
    }
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, TELEGRAM_MAX), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!r.ok) console.error(`[notify] Telegram sendMessage failed: status ${r.status}`);
    else console.info("[notify] Telegram accepted the message");
    return r.ok;
  } catch (e) {
    // A fetch error can contain the URL, which holds the bot token: class and code only.
    console.error(`[notify] Telegram request failed: ${errorSummary(e)}`);
    return false;
  }
}

/** Link to the admin area in the notifications (the admin itself arrives in a later task). */
export const adminUrl = (base: string) => `${base.replace(/\/+$/, "")}/admin`;

/**
 * Tells Maria about a new submission: the full plain-text summary by e-mail (reply goes to the visitor when
 * `replyTo` is given) and a short Telegram ping (`short`, default the subject) with the admin link under `siteUrl`
 * (default SITE_URL). `count`: the database of the day's mail count (SendOptions) for her e-mail; the Telegram ping is no mail.
 */
export async function notifyMaria(
  env: Env,
  subject: string,
  text: string,
  opts: { short?: string; replyTo?: string; siteUrl?: string; count?: Q } = {},
): Promise<{ mail: boolean; telegram: boolean }> {
  const [mail, telegram] = await Promise.all([
    sendMail(env, { to: env.MARIA_EMAIL, subject, text, replyTo: opts.replyTo }, { count: opts.count }),
    sendTelegram(env, `${opts.short ?? subject}\n\n${adminUrl(opts.siteUrl ?? env.SITE_URL)}`),
  ]);
  return { mail, telegram };
}
