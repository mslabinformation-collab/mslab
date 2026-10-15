import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { studentProtocol } from "@/db/queries/protocols";
import { readSetting } from "@/db/queries/public";
import { clients } from "@/db/schema";
import { certificateDownloadHeaders } from "@/domain/certificate";
import { PHOTO_LIMITS, TEST_LIMITS } from "@/domain/completion";
import { isEmail, isSampleAddress, normalizeEmail } from "@/domain/email";
import { FEEDBACK_TEXT_MAX } from "@/domain/protocols";
import type { Locale } from "@/i18n/locales";
import { LOGIN_MARK } from "@/lib/account-marks";
import { parseRowId } from "@/lib/row-id";
import { deletionMail, loginMail, passwordChangedMail, verifyLink } from "./account-mail";
import {
  LIMITS, parseChangeRequest, parseDeletion, parseFavourite, parseFeedbackHide, parseFeedbackPost, parseMerge, parseNewsletter, parsePassword, parsePayStart, parseProfile,
  parseProgress, parseSlug, parseTerms,
} from "./account-input";
import { isCrossSite } from "./auth";
import type { BunnyConfig } from "./bunny";
import { certificateForStudent, certificatePdf, issueCertificate } from "./certificates";
import {
  CLIENT_COOKIE, CLIENT_SESSION_TTL_MS, HINT_COOKIE, endClientSession, getClientSession, issueClientLogin, redeemClientCode,
  redeemClientLink, redeemClientPassword, reserveLoginMail, type PasswordGate,
} from "./client-auth";
import {
  acceptTerms, createChangeRequest, deleteClient, loadDashboard, loadEcourse, loadFavouriteCards, mergeFavourites, setFavourite, setNewsletter, updateProfile,
} from "./client-data";
import { removeClientPassword, setClientPassword } from "./client-password";
import { queueCompletionMail } from "./completion";
import { feedbackState, hideFeedback, notifyFeedback, submitFeedback } from "./course-feedback";
import { PgKv } from "./kv";
import { lessonFileFor, loadLesson, markTextLessonDone, saveProgress } from "./lesson-data";
import { attachmentHeader, FILE_URL_TTL_SEC } from "./lesson-files";
import { logFailure, logNote } from "./log";
import type { FileStore } from "./media";
import { changeRequestSummary } from "./messages";
import { clientNewsletter, sendWelcome } from "./newsletter";
import { adminUrl, notifyMaria, sendMail, type Env } from "./notify";
import type { Montonio } from "./payments/montonio";
import { PAY_STARTS_PER_IP, startRegistrationPayment } from "./payments/start";
import { addPhoto, photoFor, practicalView, removeKeys, removePhoto, submitPractical, type PhotoInput, type PracticalDeps } from "./practical";
import { isPrefetch } from "./prefetch";
import { privateFileAnswer } from "./private-file";
import { belowLimit, clientIp, countFailure, rateKey, rateLimit, releaseSlot, reserveSlot, windowKey } from "./ratelimit";
import { resubmitAnswers, submitAttempt, testView, type SubmitResult } from "./test-attempts";
import { sha256 } from "./token";

// The client account's JSON API (/api/konto/*) without Next.js: app/api/konto/[[...path]]/route.ts builds the dependencies
// (database, settings, Postgres KV store, after()) and calls handleAccountApi; the tests call it with PGlite and fakes.
//
// Sign-in: POST login ({ email, locale }) e-mails a 6-digit code and a link (e-mail goes out after the response); POST code
// ({ email, code, locale }) or GET verify (?t=<link token>&l=<locale>) uses the login once and starts the session (the
// one-device rule is in client-auth.ts). The login page's language travels with the login (`locale`, the link's `l`): an
// account the login creates speaks it, and a failed link opens the login page in it. POST parool-login ({ email, password, locale }) does the same
// with the password set in Minu andmed (phase 2c): one answer for every failure, and a lock after 5 failures for an address or 20 from an IP in
// 15 minutes. The session is the `__Host-mslab_client` cookie (HttpOnly) plus `mslab_in=1`, a hint the static pages
// read to show "Minu konto" instead of "Logi sisse" (it grants nothing). The login answer is the same for every address.
// Every answer is `private, no-store`: it is one visitor's data, never kept by a CDN or a shared cache.
//
// Behind a session (the data endpoints, at the bottom): GET / the dashboard, GET /kursus/:slug an e-course with its lessons and their states,
// GET /kursus/:slug/:lesson one lesson (an open one with a signed video URL; 403 terms or locked), POST …/:lesson/progress how far a video has
// been watched, POST …/:lesson/tehtud "Märgi tehtuks" for a text lesson, GET …/:lesson/fail/:file a lesson file, GET /kursus/:slug/test the knowledge test with POST /kursus/:slug/test an attempt and POST …/test/uuesti the "Paranda" answers rewritten (e-course completion), GET /lemmikud the
// favourites as course cards, POST /lemmikud and /lemmikud/merge favourites, PATCH /andmed the profile, POST /uudiskiri the newsletter, POST /muutmine a request to cancel or
// move a registration (Maria is told after the response), POST /maksa an online payment of one of her registrations (phase 2b: the prepayment due, or the rest), GET /protokoll?id= the protocol Maria sent for one of her registrations (phase protocols), GET /tagasiside?id=, POST /tagasiside and POST /tagasiside/peida the course feedback form of one of her registrations (its state, her answers once, 'Ei soovi'), POST /tingimused the e-course terms, GET /kursus/:slug/praktiline the practical work of an e-course (e-course completion: her points, her photos and Maria's sent assessment), POST …/praktiline/foto one photo (multipart, made smaller in the browser), DELETE …/praktiline/foto/:id one photo of the round being prepared, POST …/praktiline/saada "Saada hindamiseks" / "Saada uuesti", GET /praktiline/foto/:id and …/:id/pisi one of her photos (a 302 to a signed address), POST /kursus/:slug/tunnistus the certificate of her completed e-course with the name she confirmed and GET /tunnistus/:id its PDF (phase 3d), POST /kustuta account deletion, POST /parool and DELETE /parool the optional password (each change mailed; 5 changes an hour between them).
// Each one starts with requireClient and answers through clientResponse (a renewed session's cookies reach the browser); the
// client is always the session's, never a value from the request. A body that is not what the endpoint expects is 400
// { ok: false, error: "<field>" } (account-input.ts), a record that is not the client's is 404.

export type AccountDeps = {
  db: Db;
  /** The settings plus `KV`, the rate-limit store (Postgres `kv_entries`). */
  env: Env;
  now: Date;
  /** Base of the links in e-mails: the request's Host when it is one of ours (site.ts linkBase), else SITE_URL. */
  siteUrl: string;
  /** Runs work after the response has been sent: next/server after() in production, collected and awaited in tests. */
  later: (task: () => Promise<unknown>) => void;
  /** A local development request (non-production build and a local Host): the login code and link come back in the answer and nothing is mailed. */
  dev: boolean;
  /** The store of the lesson files (media-store.ts mediaStore()); absent or null: no downloads (404). */
  files?: FileStore | null;
  /** Bunny Stream (bunny.ts bunnyConfig()); absent or null: a lesson's video is "soon" ("Video lisandub peagi"). */
  bunny?: BunnyConfig | null;
  /** Online payments (phase 2b, payments/montonio.ts paymentProvider); absent or null: no "Maksa" on the cards, and POST /maksa is 503. */
  montonio?: Montonio | null;
};

const SESSION_MAX_AGE = CLIENT_SESSION_TTL_MS / 1000;
const RATE_WINDOW_SEC = 10 * 60;
const LOGIN_RATE_LIMIT = 10;
const CODE_RATE_LIMIT = 20;
/** Request bodies here are a few dozen bytes; anything bigger is refused unread by the parser. */
const MAX_BODY_CHARS = 4096;
/** A favourites merge carries up to 100 slugs of up to 200 characters each. */
const MERGE_BODY_CHARS = LIMITS.mergeSlugs * (LIMITS.slug + 4) + 64;
/** Change requests a client may send per hour: each one e-mails Maria (and pings her on Telegram). */
const CHANGE_REQUESTS_PER_HOUR = 5;
/** Progress reports a student may send per clock minute, across lessons (spec 6: it caps the writes; the player sends about 4). */
const PROGRESS_PER_MINUTE = 12;
/** Failed password logins per address, and per IP, within PASSWORD_LOCK_SEC before the lock (phase 2c, spec 7). */
const PASSWORD_FAILURES_PER_ADDRESS = 5;
const PASSWORD_FAILURES_PER_IP = 20;
const PASSWORD_LOCK_SEC = 15 * 60;
/** Password changes a client may make per hour: each one mails her. */
const PASSWORD_CHANGES_PER_HOUR = 5;
/** Feedback submits and "Ei soovi"s a client may send per hour, together: each submit mails Maria. */
const FEEDBACK_PER_HOUR = 10;
/** A feedback body: two free texts at their limit, JSON-escaped, and the rest. */
const FEEDBACK_BODY_CHARS = 2 * FEEDBACK_TEXT_MAX * 2 + 2048;
/** Test submits and rewrites a student may send per hour, together (e-course completion, spec §7): each one is graded at once. */
const TEST_SUBMITS_PER_HOUR = 10;
/** A test's body: every question's answer at its limit (an open one JSON-escaped, or a choice's option ids) and the rest. */
const TEST_BODY_CHARS = TEST_LIMITS.questions * (TEST_LIMITS.answer * 2 + 512) + 2048;
/**
 * Photo uploads a student may send per hour (e-course completion, spec §7): 1–3 photos for each point, retries and removals' new picks included.
 * Counted in a fixed hour (withinClientWindow): a student working steadily through a long course starts again each hour, never locked out
 * until she pauses.
 */
const PHOTOS_PER_HOUR = 120;
/** "Saada hindamiseks" / "Saada uuesti" per hour: each one that is accepted mails Maria. */
const PRACTICAL_SUBMITS_PER_HOUR = 20;
/** Room for the multipart boundaries and the three small fields around the two files (as the admin's upload routes). */
const PHOTO_ENVELOPE = 64 * 1024;
/** The largest photo upload: both files at their limits and the envelope. One announced larger is 413 unread (Vercel refuses 4.5 MB). */
const PHOTO_BODY_BYTES = PHOTO_LIMITS.fullBytes + PHOTO_LIMITS.thumbBytes + PHOTO_ENVELOPE;
/** Certificate issues a student may ask for per hour (phase 3d, spec §5): one is enough, a double tap or a retry after a refused name more. */
const CERTIFICATE_ISSUES_PER_HOUR = 10;
/** Certificate downloads per hour (spec §5): each one renders the PDF, a few tens of milliseconds of the function. */
const CERTIFICATE_FILES_PER_HOUR = 10;
/** The issue's body, `{ name }`: a name of at most 80 characters, with room for its JSON escapes. */
const CERTIFICATE_BODY_CHARS = 1024;

/** The feedback's own limit, the submits and the "Ei soovi"s together: null within it, else the 429 to answer. */
async function feedbackLimited(deps: AccountDeps, session: ClientSession): Promise<Response | null> {
  if (await withinClientLimit(deps, session.clientId, "client-feedback", FEEDBACK_PER_HOUR, 60 * 60)) return null;
  logNote("[account] feedback rate limited");
  return clientResponse(session, { ok: false, error: "rate" }, 429);
}

/** The test's own limit, the submits and the rewrites together: null within it, else the 429 to answer. */
async function testLimited(deps: AccountDeps, session: ClientSession): Promise<Response | null> {
  if (await withinClientLimit(deps, session.clientId, "client-test", TEST_SUBMITS_PER_HOUR, 60 * 60)) return null;
  logNote("[account] test submits rate limited");
  return clientResponse(session, { ok: false, error: "rate" }, 429);
}

const BASE_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" } as const;

/** A JSON answer (`private, no-store`, not for search engines) with the given Set-Cookie lines. */
export function accountResponse(body: unknown, status = 200, cookies: string[] = []): Response {
  const res = Response.json(body, { status, headers: BASE_HEADERS });
  for (const cookie of cookies) res.headers.append("set-cookie", cookie);
  return res;
}

const SESSION_COOKIE_LINE = (raw: string) => `${CLIENT_COOKIE}=${raw}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
const HINT_COOKIE_LINE = `${HINT_COOKIE}=1; Path=/; Max-Age=${SESSION_MAX_AGE}; Secure; SameSite=Lax`;
const CLEARED_SESSION_COOKIE = `${CLIENT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const CLEARED_HINT_COOKIE = `${HINT_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;

/** The two cookies of a started session: the session id (HttpOnly) and the readable `mslab_in` hint. */
export const sessionCookies = (raw: string): string[] => [SESSION_COOKIE_LINE(raw), HINT_COOKIE_LINE];

/** Both cookies cleared (logout, account deletion). */
export const clearedCookies = (): string[] => [CLEARED_SESSION_COOKIE, CLEARED_HINT_COOKIE];

/** The value of cookie `name` in a Cookie header, or undefined. */
function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const sep = part.indexOf("=");
    if (sep > 0 && part.slice(0, sep).trim() === name) return part.slice(sep + 1).trim();
  }
  return undefined;
}

/** The JSON object in the request body; null for anything else (not JSON, an array, a number, longer than `max`). Never throws. */
async function readObject(request: Request, max = MAX_BODY_CHARS): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > max) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The visitor's rate limit bucket: the address of the request (ratelimit.ts clientIp), `next dev` without one uses a single "local"
 * bucket, and null (production, which always has the header on Vercel) means no bucket: one shared bucket would lock everybody out.
 */
const visitorBucket = (request: Request, deps: AccountDeps): string | null => clientIp(request.headers) ?? (deps.dev ? "local" : null);

/**
 * A rate limit that fails open: when the store is unavailable (or over its write quota) students can still sign in. No
 * address (never on Vercel, whose edge sets x-forwarded-for) is not limited either: one shared bucket would lock everybody out.
 * `next dev` without the header uses one local bucket. The daily e-mail cap in login() never fails open.
 */
async function withinRateLimit(request: Request, deps: AccountDeps, form: string, limit: number): Promise<boolean> {
  const ip = visitorBucket(request, deps);
  if (ip === null) return true;
  try {
    return await rateLimit(deps.env.KV, rateKey(form, ip), limit, RATE_WINDOW_SEC);
  } catch (e) {
    logFailure("[account] rate limit unavailable, allowing", e);
    return true;
  }
}

/** The same fail-open limit for a signed-in client, counted per client (not per address): `limit` in `windowSec`. */
async function withinClientLimit(deps: AccountDeps, clientId: number, form: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    return await rateLimit(deps.env.KV, rateKey(form, String(clientId)), limit, windowSec);
  } catch (e) {
    logFailure("[account] rate limit unavailable, allowing", e);
    return true;
  }
}

/**
 * A fail-open limit for a signed-in client of `limit` per fixed window of `windowSec` (ratelimit.ts windowKey: the count starts again at
 * every window). withinClientLimit's window restarts with each accepted request, which for a steady sender (the player's report every
 * 15 s) means one that never ends; this is for those. Up to twice `limit` can pass across a window's edge.
 */
async function withinClientWindow(deps: AccountDeps, clientId: number, form: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    return await rateLimit(deps.env.KV, windowKey(rateKey(form, String(clientId)), deps.now, windowSec), limit, 2 * windowSec);
  } catch (e) {
    logFailure("[account] rate limit unavailable, allowing", e);
    return true;
  }
}

/** A page language sent by the browser (`locale` in a body, `l` in the login link): "et" or "ru", anything else is no language. */
const pageLocaleOf = (value: unknown): Locale | undefined => (value === "et" || value === "ru" ? value : undefined);

/** The language of the login e-mail: the client's own when the address has an account, else the page the visitor asked from. */
async function mailLocale(db: Db, address: string, pageLocale: unknown): Promise<Locale> {
  const [client] = await db.select({ locale: clients.locale }).from(clients).where(eq(clients.email, address)).limit(1);
  return client?.locale ?? (pageLocale === "ru" ? "ru" : "et");
}

/**
 * POST /login `{ email, locale }`: a login (code + link) for the address, e-mailed after the response. `locale` is the login
 * page's language: the e-mail's language when the address has no account yet, and the link's `l` (the page the link opens
 * on a failure, and the language of an account the link creates). The answer is
 * `{ ok: true }` for every well-formed address: unknown, over the per-address cap (3 live logins) or over the daily e-mail
 * cap look the same. 400 `{ error: "email" }`, 429 `{ error: "rate" }` (10 per 10 minutes per IP). In development the
 * answer carries `devCode` and `devLink` (and nothing is mailed); a sample address (`@example.test`) outside development
 * gets the login row but no mail and no count against the daily cap.
 */
async function login(request: Request, deps: AccountDeps): Promise<Response> {
  const body = await readObject(request);
  const address = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isEmail(address)) return accountResponse({ ok: false, error: "email" }, 400);
  if (!(await withinRateLimit(request, deps, "client-login", LOGIN_RATE_LIMIT))) {
    console.info("[account] login request rate limited");
    return accountResponse({ ok: false, error: "rate" }, 429);
  }

  const page = pageLocaleOf(body?.locale) ?? "et";
  const issued = await issueClientLogin(deps.db, address, deps.now);
  if (issued && !deps.dev && !isSampleAddress(address)) {
    // The language is read before the daily counter is raised, so a database failure in between cannot count a mail that is never queued.
    const mail = loginMail(deps.siteUrl, address, issued.token, issued.code, await mailLocale(deps.db, address, page), page);
    if (await reserveLoginMail(deps.db, deps.now)) {
      deps.later(() => sendMail(deps.env, mail));
    } else {
      logNote("[account] daily login mail cap reached");
    }
  }
  // Tests and local development have no mailbox: the code and link come back in the answer (and are never e-mailed as well).
  return accountResponse(issued && deps.dev ? { ok: true, devCode: issued.code, devLink: verifyLink(deps.siteUrl, issued.token, page) } : { ok: true });
}

/**
 * POST /code `{ email, code, locale? }`: the 6 digits from the e-mail. Starts the session (200 `{ ok: true, locale }` + cookies,
 * `locale` the client's own). `locale` ("et" / "ru", anything else ignored) is the login page's language, kept by an account
 * this login creates; an existing account keeps its own.
 * 400 `{ error: "code" }` for a wrong or malformed code (5 wrong tries end the login), 400 `{ error: "expired" }` when the
 * address has no live login, 429 `{ error: "rate" }` (20 per 10 minutes per IP).
 */
async function code(request: Request, deps: AccountDeps): Promise<Response> {
  const body = await readObject(request);
  const address = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  // A code typed or pasted as "123 456" is the same code.
  const digits = typeof body?.code === "string" && body.code.length <= 32 ? body.code.replace(/\s+/g, "") : "";
  if (!isEmail(address) || !/^\d{6}$/.test(digits)) return accountResponse({ ok: false, error: "code" }, 400);
  if (!(await withinRateLimit(request, deps, "client-code", CODE_RATE_LIMIT))) {
    console.info("[account] code request rate limited");
    return accountResponse({ ok: false, error: "rate" }, 429);
  }

  const result = await redeemClientCode(deps.db, address, digits, deps.now, pageLocaleOf(body?.locale));
  if (result === "wrong") return accountResponse({ ok: false, error: "code" }, 400);
  if (result === null) return accountResponse({ ok: false, error: "expired" }, 400);
  return accountResponse({ ok: true, locale: result.locale }, 200, sessionCookies(result.sessionRaw));
}

/** The KV key of the password lock for this IP (rateKey "pw-ip"); null without a bucket (visitorBucket). */
function passwordIpKey(request: Request, deps: AccountDeps): string | null {
  const ip = visitorBucket(request, deps);
  return ip === null ? null : rateKey("pw-ip", ip);
}

/**
 * POST /parool-login `{ email, password, locale? }` (phase 2c): the e-mail and the password set in Minu andmed start the session as a code
 * does (the one-device rule): 200 `{ ok: true, locale }` + cookies, `locale` the account's own (the one in the body is ignored: a password
 * login never creates an account). Every failure — unknown address, no password, wrong password, a body
 * that cannot be a login — is the same 400 `{ error: "password" }` ("E-post või parool ei sobi."), and takes as long (client-auth.ts
 * redeemClientPassword). After 5 failures for an address or 20 from an IP within 15 minutes: 429 `{ error: "locked" }`, the right password
 * too, until 15 minutes after the last failure (a locked attempt is not counted). Failures count whether or not the address
 * exists. The address's counter (a KV row under the address's hash) is read and counted under the address lock, in the login's own
 * transaction (the gate): attempts sent in parallel go one after another, and none passes the 5 alongside the others; a database
 * failure there fails the login (500), never opens the lock.
 *
 * The IP's 20 are slots taken BEFORE the transaction and scrypt, each in one statement (kv.ts PgKv.reserve): a burst sent at once from one
 * IP, at any number of addresses, gets 20 checked and the rest 429, so a sprayer is stopped before it holds a pooled connection or a hash
 * thread. No slot left: 429, nothing counted. The slot is the failure's count: it stays for a plain failure (400) and is given back
 * (PgKv.release) when the attempt turns out not to be one, a success or a locked address. An attempt that ends in an error keeps it. A store
 * that fails lets the attempt through (as the other limits) and is logged without the IP or the address.
 */
async function passwordLogin(request: Request, deps: AccountDeps): Promise<Response> {
  const body = await readObject(request);
  const address = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" && body.password.length <= LIMITS.passwordInput ? body.password : "";
  const locked = () => {
    logNote("[account] password login locked");
    return accountResponse({ ok: false, error: "locked" }, 429);
  };
  // The IP's slot is taken before the transaction and scrypt: a sprayer is stopped at the door, and a burst cannot pass it together.
  const ipKey = passwordIpKey(request, deps);
  let slot: string | null = null;
  if (ipKey !== null) {
    try {
      if (!(await reserveSlot(deps.env.KV, ipKey, PASSWORD_FAILURES_PER_IP, PASSWORD_LOCK_SEC))) return locked();
      slot = ipKey;
    } catch (e) {
      logFailure("[account] rate limit unavailable, allowing", e);
    }
  }
  const giveSlotBack = async () => {
    if (slot === null) return;
    try {
      await releaseSlot(deps.env.KV, slot, PASSWORD_LOCK_SEC);
    } catch (e) {
      logFailure("[account] rate limit unavailable", e);
    }
  };
  const addressKey = `rl:pw-mail:${await sha256(address)}`;
  // the address's lock, on the login's transaction (no sweep inside it: kv.ts)
  const gate: PasswordGate = (t) => {
    const kv = new PgKv(t, () => deps.now, { sweep: false });
    return { open: () => belowLimit(kv, addressKey, PASSWORD_FAILURES_PER_ADDRESS), failed: () => countFailure(kv, addressKey, PASSWORD_LOCK_SEC) };
  };
  const session = isEmail(address) && password ? await redeemClientPassword(deps.db, address, password, deps.now, gate) : null;
  if (session === "locked") {
    await giveSlotBack(); // refused, not a failure of this IP
    return locked();
  }
  if (!session) return accountResponse({ ok: false, error: "password" }, 400); // the slot stays: that is the count
  await giveSlotBack();
  return accountResponse({ ok: true, locale: session.locale }, 200, sessionCookies(session.sessionRaw));
}

/** A redirect (303) that carries no body: `target` is made absolute against this request's origin. */
function redirect(url: URL, target: string, cookies: string[] = []): Response {
  const res = new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, location: new URL(target, url.origin).toString(), "referrer-policy": "no-referrer" }, // the token is in this URL
  });
  for (const cookie of cookies) res.headers.append("set-cookie", cookie);
  return res;
}

/**
 * GET /verify?t=<token>&l=<et|ru>: the link in the login e-mail. Uses the login once, starts the session and goes to the
 * client's own page (/konto#sisse, /ru/konto#sisse, by the client's language: the fragment tells the browser to forget the copy of
 * the favourites a previous session left, lib/account-marks.ts LOGIN_MARK). With `p=<registration id>` (the protocol mail's button, phase
 * protocols) it goes to that protocol instead: /konto/protokoll#sisse&id=<id> (the mark first, the id after it, both in the fragment).
 * `l` is the language of the page the login was asked from
 * (absent: Estonian; anything but "et" / "ru" is ignored): an account this link creates gets it, and the login page of that
 * language is where the link goes when it fails. A token that is unknown, used, expired or dead goes to
 * /konto/sisene#viga=link (/ru/konto/sisene#viga=link); a database failure to #viga=server (the link is still usable then,
 * as for the admin). A prefetch or prerender goes to the login page without touching the token.
 */
async function verify(request: Request, url: URL, deps: AccountDeps): Promise<Response> {
  const page = pageLocaleOf(url.searchParams.get("l"));
  const login = page === "ru" ? "/ru/konto/sisene" : "/konto/sisene";
  if (isPrefetch(request.headers)) return redirect(url, login);
  try {
    const session = await redeemClientLink(deps.db, url.searchParams.get("t") ?? "", deps.now, page);
    if (!session) return redirect(url, `${login}#viga=link`);
    const home = session.locale === "ru" ? "/ru/konto" : "/konto";
    // the protocol mail's button: its protocol, the id after the login mark (components/account/useAccount.ts takes the mark and keeps the id)
    const protocolId = parseRowId(url.searchParams.get("p") ?? "");
    return redirect(url, protocolId === null ? `${home}#${LOGIN_MARK}` : `${home}/protokoll#${LOGIN_MARK}&id=${protocolId}`, sessionCookies(session.sessionRaw));
  } catch (e) {
    logFailure("[account] verify failed", e); // never the message: it holds the token hash and the e-mail
    return redirect(url, `${login}#viga=server`);
  }
}

/** POST /logout: ends the session this cookie holds (no matter which, or none) and clears both cookies. */
async function logout(request: Request, deps: AccountDeps): Promise<Response> {
  await endClientSession(deps.db, cookieValue(request.headers.get("cookie"), CLIENT_COOKIE), deps.now);
  return accountResponse({ ok: true }, 200, clearedCookies());
}

export type SessionEnd = "none" | "replaced" | "logout" | "expired";

/** 401 `{ reason }` for a request without a live session; clears the hint cookie so the pages stop showing "Minu konto". */
export const unauthorized = (reason: SessionEnd): Response => accountResponse({ ok: false, reason }, 401, [CLEARED_HINT_COOKIE]);

/** A signed-in request: the client, and the cookies the answer must carry (none, or the session's two cookies when it was just renewed). */
export type ClientSession = { clientId: number; cookies: string[] };

/**
 * The client of this request's session cookie, or the 401 answer to return (`reason`: no cookie or an unknown session,
 * or why the session ended: another device signed in, logout, 180 days unused). Every endpoint behind a session starts with
 * this and answers with `clientResponse(session, body)`: the session is renewed in the database at most once a day, and
 * then the cookies are sent again with a fresh Max-Age, or the browser would drop them 180 days after the login.
 */
export async function requireClient(request: Request, deps: AccountDeps): Promise<ClientSession | Response> {
  const raw = cookieValue(request.headers.get("cookie"), CLIENT_COOKIE);
  const session = await getClientSession(deps.db, raw, deps.now);
  if (!session) return unauthorized("none");
  if (session.ended) return unauthorized(session.ended);
  return { clientId: session.clientId, cookies: session.renewed && raw ? sessionCookies(raw) : [] };
}

/** The answer for a signed-in client: `body` plus the cookies of a renewed session (see requireClient). */
export const clientResponse = (session: ClientSession, body: unknown, status = 200): Response => accountResponse(body, status, session.cookies);

/**
 * A lesson file for the signed-in client: a 302 to a 5-minute signed R2 address (R2 answers with the name and type the file was
 * stored with), or, from the local folder of `next dev` and the e2e run, the bytes themselves as a download. The cookies of a renewed
 * session go with it, as with clientResponse. null when the store does not have the object.
 */
async function fileAnswer(session: ClientSession, store: FileStore, file: { key: string; name: string; contentType: string }): Promise<Response | null> {
  const base = { ...BASE_HEADERS, "referrer-policy": "no-referrer" }; // the lesson's address is not passed on to R2 (next.config.ts has the same rule for this path: a header set there replaces this one)
  let res: Response;
  if (store.signedGetUrl) {
    res = new Response(null, { status: 302, headers: { ...base, location: await store.signedGetUrl(file.key, { expiresSec: FILE_URL_TTL_SEC }) } });
  } else {
    const object = await store.get(file.key);
    if (!object) return null;
    res = new Response(object.body, { headers: { ...base, "content-type": file.contentType, "content-disposition": attachmentHeader(file.name), "x-content-type-options": "nosniff" } });
  }
  for (const cookie of session.cookies) res.headers.append("set-cookie", cookie);
  return res;
}

/**
 * A practical work's photo for its owner (e-course completion, R5): private-file.ts privateFileAnswer's 302 to a 5-minute signed R2
 * address, or, from the local folder of `next dev` and the e2e run, the JPEG itself shown inline. `private, no-store`, not for search
 * engines, and no Referer passed on to R2 (next.config.ts has the same rule for these paths: a header set there replaces this one); the
 * cookies of a renewed session go with it, as with clientResponse. null when the store does not have the object.
 */
async function photoAnswer(session: ClientSession, store: FileStore, key: string): Promise<Response | null> {
  const res = await privateFileAnswer(store, key, { contentType: "image/jpeg", headers: { ...BASE_HEADERS, "referrer-policy": "no-referrer" } });
  if (!res) return null;
  for (const cookie of session.cookies) res.headers.append("set-cookie", cookie);
  return res;
}

/**
 * A certificate's PDF for its owner (phase 3d, spec §5, §7): the bytes as a download named by her certificate's number (domain/certificate.ts
 * certificateDownloadHeaders), `private, no-store` and not for search engines (BASE_HEADERS), nosniff; the cookies of a renewed session go
 * with it, as with clientResponse. The handlers never build a Response of their own.
 * (The cast: the PDF's bytes are a Uint8Array<ArrayBufferLike>, which TypeScript does not take as a BlobPart as it stands.)
 */
function pdfAnswer(session: ClientSession, bytes: Uint8Array, cert: { year: number; seq: number }): Response {
  const res = new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
    headers: { ...BASE_HEADERS, ...certificateDownloadHeaders(cert.year, cert.seq) },
  });
  for (const cookie of session.cookies) res.headers.append("set-cookie", cookie);
  return res;
}

/** The practical work's server (server/practical.ts) gets the account's own dependencies; no store means no photos (503 "storage"). */
const practicalDeps = (deps: AccountDeps): PracticalDeps => ({
  db: deps.db,
  env: deps.env,
  siteUrl: deps.siteUrl,
  now: deps.now,
  later: deps.later,
  files: deps.files ?? null,
});

/** A number field of the photo form: digits without a leading zero (0 itself is one), at most five; null for anything else. */
function formNumber(form: FormData, name: string): number | null {
  const value = form.get(name);
  return typeof value === "string" && /^(0|[1-9][0-9]{0,4})$/.test(value) ? Number(value) : null;
}

/**
 * The fields of a photo upload (multipart, e-course completion spec §7): `stage` (the point, 0-based), `width` and `height` of the full
 * photo, and the two JPEG files `full` and `thumb`. The body is read here, once; what the files hold, their sizes, the point's range and the
 * photo's shape are server/practical.ts addPhoto's checks. A body that is no form is "form"; a missing or unreadable field is its name.
 */
async function readPhotoForm(request: Request): Promise<{ ok: true; data: PhotoInput } | { ok: false; error: string }> {
  const form = await request.formData().catch(() => null);
  if (!form) return { ok: false, error: "form" };
  const stage = formNumber(form, "stage");
  const width = formNumber(form, "width");
  const height = formNumber(form, "height");
  const full = form.get("full");
  const thumb = form.get("thumb");
  if (stage === null) return { ok: false, error: "stage" };
  if (width === null) return { ok: false, error: "width" };
  if (height === null) return { ok: false, error: "height" };
  if (!(full instanceof File)) return { ok: false, error: "full" };
  if (!(thumb instanceof File)) return { ok: false, error: "thumb" };
  return { ok: true, data: { stage, width, height, full, thumb } };
}

/** The slug and lesson id of a lesson path (the one parse step of the four lesson handlers); null when either cannot be one (404). */
const lessonRef = (rawSlug: string, rawLesson: string): { slug: string; lessonId: number } | null => {
  const slug = parseSlug(rawSlug);
  const lessonId = parseRowId(rawLesson);
  return slug === null || lessonId === null ? null : { slug, lessonId };
};

/** The registration id of a request's `?id=` (lib/row-id.ts), or null: the protocol's and the feedback form's endpoints read it so. */
const queryId = (request: Request): number | null => parseRowId(new URL(request.url).searchParams.get("id") ?? "");

/**
 * The answer to a test submit or rewrite (test-attempts.ts SubmitResult): 200 `{ ok: true, ...TestView }` with the outcome; 409 `changed` (the
 * questions changed since the page loaded) or `closed`; 400 `incomplete` or `tooLong`; 404.
 */
function testAnswer(session: ClientSession, result: SubmitResult): Response {
  switch (result.kind) {
    case "submitted":
      return clientResponse(session, { ok: true, ...result.view });
    case "changed":
    case "closed":
      return clientResponse(session, { ok: false, error: result.kind }, 409);
    case "invalid":
      return clientResponse(session, { ok: false, error: result.error }, 400);
    default:
      return clientResponse(session, { ok: false }, 404);
  }
}

/** The attempt id of a rewrite's body: a positive integer the database can hold, or null. */
const attemptIdOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null);

/**
 * "Sinu MS LABi konto parool on muudetud." after the response (phase 2c), with Maria's address from Seaded when there is one (and without
 * it when Seaded cannot be read): never in development, never to a sample address. A failure is logged by `later` (route.ts), never the address.
 */
function mailPasswordChange(deps: AccountDeps, to: { email: string; locale: Locale }): void {
  if (deps.dev || isSampleAddress(to.email)) return;
  deps.later(async () => {
    // The mail is the only warning when somebody else's session sets a password: it goes out without Maria's address if Seaded cannot be read.
    const contact = await readSetting(deps.db, "contact").catch((e) => {
      logFailure("[account] contact setting unavailable for the password mail", e);
      return null;
    });
    const email = (contact as { email?: unknown } | null)?.email;
    await sendMail(deps.env, passwordChangedMail(to.email, to.locale, typeof email === "string" ? email.trim() : ""));
  });
}

/** GET /me: `{ ok: true, email, name }` of the signed-in client. */
async function me(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const [client] = await deps.db.select({ email: clients.email, name: clients.name }).from(clients).where(eq(clients.id, session.clientId)).limit(1);
  return client ? clientResponse(session, { ok: true, email: client.email, name: client.name }) : unauthorized("none");
}

/** 400 for a body the endpoint cannot use, answered like every other signed-in answer. */
const badInput = (session: ClientSession, field: string): Response => clientResponse(session, { ok: false, error: field }, 400);

/** GET /: the client's dashboard (`Dashboard` in client-data.ts): profile, the cards, favourites, the prepayment instructions. */
async function dashboard(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const data = await loadDashboard(deps.db, session.clientId, deps.now);
  // the client was deleted since the session was checked; with online payments the cards offer "Maksa" (phase 2b)
  return data ? clientResponse(session, deps.montonio ? { ...data, payOnline: true } : data) : unauthorized("none");
}

/**
 * GET /kursus/:slug: the e-course page's data (`EcourseView`), or 404 without active access (or for a slug that cannot be one). The load
 * completes an access whose steps are all done and whose date is still unset (e-course completion: it heals a completion that was missed);
 * the "completed" mail of the load that did it goes after the answer.
 */
async function ecourse(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  const view = slug === null ? null : await loadEcourse(deps.db, session.clientId, slug, deps.now, (accessId) => queueCompletionMail(deps, accessId));
  return view ? clientResponse(session, view) : clientResponse(session, { ok: false }, 404);
}

/**
 * GET /kursus/:slug/:lesson: one lesson (lesson-data.ts LessonView) — the embed URL of a ready video (signed for 4 hours, from the
 * saved second), the short text, the files, the next lesson, the e-mail for the watermark. 403 `{ error: "terms" }` while the course's
 * terms are not accepted (the page sends the student to the notice); 403 `{ error: "locked", next }` for a lesson not open yet
 * (`next`: where "Jätka" goes); 404 without active access, or for anything that is not a visible lesson of that course.
 */
async function lesson(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  const result = ref ? await loadLesson(deps.db, deps.bunny ?? null, session.clientId, ref.slug, ref.lessonId, deps.now) : null;
  if (result?.kind === "lesson") return clientResponse(session, result.view);
  if (result?.kind === "terms") return clientResponse(session, { ok: false, error: "terms" }, 403);
  if (result?.kind === "locked") return clientResponse(session, { ok: false, error: "locked", next: result.next }, 403);
  return clientResponse(session, { ok: false }, 404);
}

/**
 * POST /kursus/:slug/:lesson/progress `{ watchedSec }`: how far the student has watched (the player sends it about every 15 s and at
 * pause and end). Kept at its highest; at 90 % of the length the lesson is done. 200 `{ ok, done, next }`; 400 `{ error: "watchedSec" }`
 * (no number, or past the length + 5 s); 403 locked; 404; 409 `{ error: "video" }` (a text lesson, or a video lesson still waiting for its
 * video: it cannot be completed, so the next lesson stays locked); 429 `{ error: "rate" }` after
 * 12 in one clock minute (a fixed window, so the player's steady report every 15 s always fits). The report that makes the course's last lesson
 * done may complete the course (completion.ts): its "completed" mail goes after the answer.
 */
async function progress(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  if (ref === null) return clientResponse(session, { ok: false }, 404);
  const input = parseProgress(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  if (!(await withinClientWindow(deps, session.clientId, "client-progress", PROGRESS_PER_MINUTE, 60))) {
    logNote("[account] progress rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await saveProgress(deps.db, session.clientId, ref.slug, ref.lessonId, input.data.watchedSec, deps.now);
  if (result.kind === "saved") {
    if (result.completed) queueCompletionMail(deps, result.accessId); // the course's last step (e-course completion, spec §4.4, §6)
    return clientResponse(session, { ok: true, done: result.done, next: result.next });
  }
  if (result.kind === "locked") return clientResponse(session, { ok: false, error: "locked", next: result.next }, 403);
  if (result.kind === "video") return clientResponse(session, { ok: false, error: "video" }, 409);
  if (result.kind === "range") return badInput(session, "watchedSec");
  return clientResponse(session, { ok: false }, 404); // notFound (terms is never asked for here)
}

/** POST /kursus/:slug/:lesson/tehtud: "Märgi tehtuks" for a text lesson (kind "text"). 200 `{ ok, done: true, next }` (the course's last step queues its "completed" mail after the answer); 403 locked; 404; 409 `{ error: "video" }` (a video lesson). */
async function lessonDone(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  const result = ref ? await markTextLessonDone(deps.db, session.clientId, ref.slug, ref.lessonId, deps.now) : null;
  if (result?.kind === "saved") {
    if (result.completed) queueCompletionMail(deps, result.accessId); // the course's last step (e-course completion, spec §4.4, §6)
    return clientResponse(session, { ok: true, done: true, next: result.next });
  }
  if (result?.kind === "locked") return clientResponse(session, { ok: false, error: "locked", next: result.next }, 403);
  if (result?.kind === "video") return clientResponse(session, { ok: false, error: "video" }, 409);
  return clientResponse(session, { ok: false }, 404);
}

/** GET /kursus/:slug/:lesson/fail/:file: a file of an open lesson (fileAnswer: a signed R2 address or the bytes). 403 `{ error: "locked" }`; 404. */
async function lessonFile(request: Request, deps: AccountDeps, rawSlug: string, rawLesson: string, rawFile: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const ref = lessonRef(rawSlug, rawLesson);
  const fileId = parseRowId(rawFile);
  const file = ref && fileId !== null ? await lessonFileFor(deps.db, session.clientId, ref.slug, ref.lessonId, fileId, deps.now) : null;
  if (file?.kind === "locked") return clientResponse(session, { ok: false, error: "locked" }, 403);
  const answer = file?.kind === "file" && deps.files ? await fileAnswer(session, deps.files, file) : null;
  return answer ?? clientResponse(session, { ok: false }, 404);
}

/**
 * GET /kursus/:slug/test (e-course completion, spec §4.2): the student's knowledge test (test-attempts.ts TestView) — the course's questions
 * without their answer key, the state and the tries left, her newest attempt (its own copy of the questions, her answers, the score, the
 * numbers of the choice questions she got wrong, Maria's review). 404 without the access (a revoked one too), for a contact course and for
 * a course without questions.
 */
async function testPage(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  const view = slug === null ? null : await testView(deps.db, session.clientId, slug, deps.now);
  return view ? clientResponse(session, { ok: true, ...view }) : clientResponse(session, { ok: false }, 404);
}

/**
 * POST /kursus/:slug/test `{ answers }` (spec §4.2): a new attempt, graded at once (test-attempts.ts submitAttempt, under the access's lock:
 * a double tap or a second device makes one try; the newest attempt's own answers sent again to unchanged questions are that attempt: its
 * view, nothing written). 200 `{ ok: true, ...TestView }` with the outcome; 409 `{ error: "changed" }` (Maria changed
 * the questions since the page loaded: no try used, nothing stored) or `{ error: "closed" }` (locked, waiting for Maria, passed, out of
 * tries, or the access has ended); 400 `{ error: "incomplete" | "tooLong" | "answers" }`; 429 `{ error: "rate" }` after 10 in an hour; 404.
 */
async function submitTest(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  if (slug === null) return clientResponse(session, { ok: false }, 404);
  const body = await readObject(request, TEST_BODY_CHARS);
  if (body === null) return badInput(session, "answers");
  const limited = await testLimited(deps, session);
  if (limited) return limited;
  return testAnswer(session, await submitAttempt(deps, session.clientId, slug, body.answers));
}

/**
 * POST /kursus/:slug/test/uuesti `{ attemptId, answers }` (spec §4.2): the answers Maria marked "Paranda" rewritten (test-attempts.ts
 * resubmitAnswers: the same attempt back to her review, no try used). The answers as POST /kursus/:slug/test's, and 400 `{ error:
 * "attemptId" }`.
 */
async function resubmitTest(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  if (slug === null) return clientResponse(session, { ok: false }, 404);
  const body = await readObject(request, TEST_BODY_CHARS);
  if (body === null) return badInput(session, "answers");
  const attemptId = attemptIdOf(body.attemptId);
  if (attemptId === null) return badInput(session, "attemptId");
  const limited = await testLimited(deps, session);
  if (limited) return limited;
  return testAnswer(session, await resubmitAnswers(deps, session.clientId, slug, attemptId, body.answers));
}

/**
 * GET /kursus/:slug/praktiline (e-course completion, spec §4.3): the practical work of one of her e-courses (server/practical.ts
 * PracticalView): the points with Maria's sent verdicts and notes, the photos of the round being prepared and the earlier ones, the status.
 * 200 `{ ok: true, ...PracticalView }`; 404 `{ ok: false }` without access (a revoked one too), for a contact course, and for an e-course
 * without points whose notes Maria has not sent.
 */
async function practicalPage(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  const view = slug === null ? null : await practicalView(deps.db, session.clientId, slug, deps.now);
  return view ? clientResponse(session, { ok: true, ...view }) : clientResponse(session, { ok: false }, 404);
}

/**
 * POST /kursus/:slug/praktiline/foto (spec §4.3, §7): one photo for a point, as multipart `stage`, `width`, `height`, `full` (a JPEG of at
 * most 2 MB) and `thumb` (at most 200 KB), made smaller in the browser (lib/shrink-image.ts). A body announced larger than both files and
 * the envelope is 413 `{ error: "size" }` before it is read. 200 `{ ok: true, photo }`; 400 `{ error }` (a field of the form, or
 * server/practical.ts's refusal: type, size, content, stage, shape); 409 `{ error: "full" }` (3 on that point in this round) or "closed"
 * (not open for photos now); 429 `{ error: "rate" }` after 120 in an hour; 503 `{ error: "storage" }`; 404.
 */
async function uploadPhoto(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  if (slug === null) return clientResponse(session, { ok: false }, 404);
  if (Number(request.headers.get("content-length") ?? 0) > PHOTO_BODY_BYTES) return clientResponse(session, { ok: false, error: "size" }, 413);
  if (!(await withinClientWindow(deps, session.clientId, "client-photo", PHOTOS_PER_HOUR, 60 * 60))) {
    logNote("[account] photo uploads rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const input = await readPhotoForm(request);
  if (!input.ok) return badInput(session, input.error);
  const result = await addPhoto(practicalDeps(deps), session.clientId, slug, input.data);
  switch (result.kind) {
    case "added":
      return clientResponse(session, { ok: true, photo: result.photo });
    case "full":
    case "closed":
      return clientResponse(session, { ok: false, error: result.kind }, 409);
    case "invalid":
      return badInput(session, result.error);
    case "storage":
      return clientResponse(session, { ok: false, error: "storage" }, 503);
    default:
      return clientResponse(session, { ok: false }, 404);
  }
}

/** DELETE /kursus/:slug/praktiline/foto/:id: one of her photos of the round being prepared. 200 `{ ok: true }`; 409 `{ error: "closed" }` (sent, or an approved point); 404. */
async function deletePhoto(request: Request, deps: AccountDeps, rawSlug: string, rawId: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  const id = parseRowId(rawId);
  const result = slug !== null && id !== null ? await removePhoto(practicalDeps(deps), session.clientId, slug, id) : null;
  if (result?.kind === "removed") return clientResponse(session, { ok: true });
  if (result?.kind === "closed") return clientResponse(session, { ok: false, error: "closed" }, 409);
  return clientResponse(session, { ok: false }, 404);
}

/**
 * POST /kursus/:slug/praktiline/saada: "Saada hindamiseks" (every point has a photo of the new round) or "Saada uuesti" (every "Paranda"
 * point has one); Maria is told after the response (server/practical.ts). 200 `{ ok: true, ...PracticalView }` (waiting); 409 `{ error:
 * "missing", points }` (0-based), `{ error: "already" }` (sent already: another device, a double tap) or `{ error: "closed" }`; 429 `{ error:
 * "rate" }` after 20 in an hour; 404.
 */
async function submitWork(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  if (slug === null) return clientResponse(session, { ok: false }, 404);
  if (!(await withinClientLimit(deps, session.clientId, "client-practical", PRACTICAL_SUBMITS_PER_HOUR, 60 * 60))) {
    logNote("[account] practical submits rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await submitPractical(practicalDeps(deps), session.clientId, slug);
  switch (result.kind) {
    case "submitted":
      return clientResponse(session, { ok: true, ...result.view });
    case "missing":
      return clientResponse(session, { ok: false, error: "missing", points: result.points }, 409);
    case "already":
    case "closed":
      return clientResponse(session, { ok: false, error: result.kind }, 409);
    default:
      return clientResponse(session, { ok: false }, 404);
  }
}

/** GET /praktiline/foto/:id and …/:id/pisi (R5): one of her practical photos, or its thumbnail (photoAnswer: a signed address or the bytes). 404 for any other id. */
async function photo(request: Request, deps: AccountDeps, rawId: string, thumb: boolean): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = parseRowId(rawId);
  const keys = id === null ? null : await photoFor(deps.db, { clientId: session.clientId }, id);
  const answer = keys && deps.files ? await photoAnswer(session, deps.files, thumb ? keys.thumbKey : keys.key) : null;
  return answer ?? clientResponse(session, { ok: false }, 404);
}

/**
 * POST /kursus/:slug/tunnistus `{ name }` (phase 3d, spec §5): the certificate of her completed e-course, with the name she confirmed. It is
 * made by certificates.ts issueCertificate, under the access's lock and then the number series' lock, one per access.
 * - 200 `{ ok: true, certificate }`.
 * - 409 `{ error: "already", certificate }`: made already, by a double tap or another device; the answer is the one there is.
 * - 409 `{ error: "notCompleted" }`.
 * - 400 `{ error: "name", reason: "length" | "letters" }`: the name rules. A body that is no `{ name }` counts as an empty name.
 * - 429 `{ error: "rate" }` after 10 in an hour.
 * - 404 without the access (a revoked one too), and for a contact course.
 */
async function issueCertificateRoute(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  if (slug === null) return clientResponse(session, { ok: false }, 404);
  const body = await readObject(request, CERTIFICATE_BODY_CHARS);
  if (!(await withinClientLimit(deps, session.clientId, "client-certificate", CERTIFICATE_ISSUES_PER_HOUR, 60 * 60))) {
    logNote("[account] certificate issues rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await issueCertificate(deps.db, session.clientId, slug, typeof body?.name === "string" ? body.name : "", deps.now);
  switch (result.kind) {
    case "issued":
      return clientResponse(session, { ok: true, certificate: result.certificate });
    case "already":
      return clientResponse(session, { ok: false, error: "already", certificate: result.certificate }, 409);
    case "notCompleted":
      return clientResponse(session, { ok: false, error: "notCompleted" }, 409);
    case "invalid":
      return clientResponse(session, { ok: false, error: "name", reason: result.error }, 400);
    default:
      return clientResponse(session, { ok: false }, 404);
  }
}

/**
 * GET /tunnistus/:id (phase 3d, spec §5, §7): her certificate as a PDF (certificates.ts certificatePdf, rendered from the frozen row on each
 * download), via pdfAnswer as `attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`. Only her own access's certificate, and only while
 * that access is not revoked; an ended (expired) access keeps it. 404 `{ ok: false }` for any other id; 429 `{ error: "rate" }` after 10
 * in an hour (a 404 counts too, so ids cannot be probed).
 */
async function certificateFile(request: Request, deps: AccountDeps, rawId: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = parseRowId(rawId);
  if (id === null) return clientResponse(session, { ok: false }, 404);
  if (!(await withinClientLimit(deps, session.clientId, "client-certificate-pdf", CERTIFICATE_FILES_PER_HOUR, 60 * 60))) {
    logNote("[account] certificate downloads rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const cert = await certificateForStudent(deps.db, session.clientId, id);
  if (!cert) return clientResponse(session, { ok: false }, 404);
  const bytes = await certificatePdf(deps.db, cert, deps.now);
  return pdfAnswer(session, bytes, cert);
}

/**
 * GET /lemmikud?l=<et|ru>: the Lemmikud tab, `{ ok, favourites, cards }` (client-data.ts FavouriteCards): the client's published favourites
 * as the catalogue's course cards, newest first, in the page's language `l` (anything but "ru" is Estonian).
 */
async function favouriteCourses(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const locale = pageLocaleOf(new URL(request.url).searchParams.get("l")) ?? "et";
  return clientResponse(session, { ok: true, ...(await loadFavouriteCards(deps.db, session.clientId, locale, deps.now)) });
}

/** POST /lemmikud `{ slug, on }`: hearts or un-hearts a published course. 200 `{ ok, favourites }`; 404 `{ error: "slug" }` for a course that is not published. */
async function favourite(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseFavourite(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  const favourites = await setFavourite(deps.db, session.clientId, input.data.slug, input.data.on);
  return favourites ? clientResponse(session, { ok: true, favourites }) : clientResponse(session, { ok: false, error: "slug" }, 404);
}

/** POST /lemmikud/merge `{ slugs }` (at most 100): the browser's favourites join the account's; unknown slugs are ignored. 200 `{ ok, favourites }`. */
async function mergeFavouriteList(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseMerge(await readObject(request, MERGE_BODY_CHARS));
  if (!input.ok) return badInput(session, input.error);
  return clientResponse(session, { ok: true, favourites: await mergeFavourites(deps.db, session.clientId, input.data.slugs) });
}

/** PATCH /andmed `{ name, phone, locale }`. 200 `{ ok: true }`. */
async function profile(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseProfile(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  return (await updateProfile(deps.db, session.clientId, input.data)) ? clientResponse(session, { ok: true }) : unauthorized("none");
}

/**
 * POST /uudiskiri `{ on }`: the account's address subscribes (confirmed: the login proved it) or unsubscribes. 200 `{ ok: true }`. Switched
 * on and confirmed now for the first time: the welcome mail after the response (phase 2c; one step since 09.10, with Seaded's code when
 * there is one and always with the unsubscribe link; server/newsletter.ts sendWelcome: once per address, never in development, never to a
 * sample address). The row is confirmed at once, as the public forms' sign-up is: no confirmation mail on this path either.
 */
async function newsletter(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseNewsletter(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  const before = input.data.on ? await clientNewsletter(deps.db, session.clientId) : null;
  if (!(await setNewsletter(deps.db, session.clientId, input.data.on, deps.now))) return unauthorized("none");
  if (before && before.state !== "yes" && !deps.dev) deps.later(() => sendWelcome(deps, { email: before.email, locale: before.locale }));
  return clientResponse(session, { ok: true });
}

/** Takes one of the hour's 5 password changes (a set, a change or a removal: each one mails her); false: they are used up. */
const withinPasswordLimit = (deps: AccountDeps, clientId: number) => withinClientLimit(deps, clientId, "client-password", PASSWORD_CHANGES_PER_HOUR, 60 * 60);

/** 429 `{ error: "rate" }` for a password change over the hour's limit. */
function passwordRateLimited(session: ClientSession): Response {
  logNote("[account] password change rate limited");
  return clientResponse(session, { ok: false, error: "rate" }, 429);
}

/**
 * POST /parool `{ password }` (phase 2c): sets or changes the account's password (client-password.ts). 200 `{ ok: true, passwordSetAt }`;
 * 400 `{ error: "password" }` (no usable string), `"short"` / `"long"` (10 … 200 characters) or `"email"` (the address itself); 429
 * `{ error: "rate" }` after 5 changes in an hour (a removal counts too, see removePassword). The session goes on; the change is mailed to her after the response.
 */
async function setPassword(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parsePassword(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  if (!(await withinPasswordLimit(deps, session.clientId))) return passwordRateLimited(session);
  const result = await setClientPassword(deps.db, session.clientId, input.data.password, deps.now);
  if (result.kind === "gone") return unauthorized("none");
  if (result.kind === "problem") return badInput(session, result.problem);
  mailPasswordChange(deps, result);
  return clientResponse(session, { ok: true, passwordSetAt: result.changedAt.toISOString() });
}

/**
 * DELETE /parool (phase 2c): removes the password; the e-mail code works as always. 200 `{ ok: true }`; the change is mailed when there was
 * one. It counts in the same 5 changes an hour as POST (a removal mails her too, and each one would otherwise be free): 429 `{ error: "rate" }`.
 */
async function removePassword(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  if (!(await withinPasswordLimit(deps, session.clientId))) return passwordRateLimited(session);
  const removed = await removeClientPassword(deps.db, session.clientId);
  if (!removed) return unauthorized("none");
  if (removed.had) mailPasswordChange(deps, removed);
  return clientResponse(session, { ok: true });
}

/**
 * POST /muutmine `{ registrationId, kind, message }`: a request to cancel (`cancel`) or move (`change`) one of the client's own
 * registrations. It changes nothing itself: it is stored for the admin's inbox and Maria is told after the response. 404
 * `{ error: "registration" }` for a registration that is not the client's (or is cancelled, past or called off), 429 `{ error: "rate" }` after 5 in an hour.
 */
async function changeRequest(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseChangeRequest(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  if (!(await withinClientLimit(deps, session.clientId, "client-change", CHANGE_REQUESTS_PER_HOUR, 60 * 60))) {
    console.info("[account] change request rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const { registrationId, kind, message } = input.data;
  const info = await createChangeRequest(deps.db, session.clientId, registrationId, kind, message, deps.now);
  if (!info) return clientResponse(session, { ok: false, error: "registration" }, 404);
  const summary = changeRequestSummary({ ...info, kind, message }, adminUrl(deps.siteUrl));
  deps.later(() => notifyMaria(deps.env, summary.subject, summary.text, { short: summary.short, replyTo: info.email, siteUrl: deps.siteUrl }));
  return clientResponse(session, { ok: true });
}

/**
 * POST /maksa `{ registrationId }` (phase 2b, spec 6.3): starts the online payment of one of the client's own registrations — the prepayment
 * still due, or the rest after it — with the /maksa page's checks (server/payments/start.ts). 200 `{ ok: true, paymentUrl }` (the card sends
 * the browser there); 404 `{ error: "registration" }` (not hers, or none); 409 `{ error: "nothing" }` (nothing to pay now) or `"full"` (no
 * free seat, D2); 429 `{ error: "rate" }` (5 starts from this IP in 10 minutes, shared with the /maksa page, or 5 of this registration in an
 * hour); 503 `{ error: "unavailable" }` without online payments or when Montonio says no. A throw is the router's 500.
 */
async function payRegistration(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parsePayStart(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  if (!(await withinRateLimit(request, deps, "pay", PAY_STARTS_PER_IP))) {
    logNote("[account] payment starts rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await startRegistrationPayment({ db: deps.db, now: deps.now, siteUrl: deps.siteUrl, notifyBase: deps.env.SITE_URL, montonio: deps.montonio ?? null }, { registrationId: input.data.registrationId, clientId: session.clientId });
  switch (result.kind) {
    case "started":
      return clientResponse(session, { ok: true, paymentUrl: result.paymentUrl });
    case "notFound":
      return clientResponse(session, { ok: false, error: "registration" }, 404);
    case "nothing":
    case "full":
      return clientResponse(session, { ok: false, error: result.kind }, 409);
    case "rate":
      return clientResponse(session, { ok: false, error: "rate" }, 429);
    default:
      return clientResponse(session, { ok: false, error: "unavailable" }, 503);
  }
}

/**
 * GET /protokoll?id=<registration id> (phase protocols, spec §5): the protocol Maria sent for one of the client's own registrations (the
 * dashboard's rule: linked to her account) — the course, its date and place, the stages with their notes and the general notes, as last sent,
 * never the draft. 200 `{ ok: true, course, session, sentAt, stages, generalNote }`; 404 `{ ok: false }` for any other id, and for one with
 * no sent protocol.
 */
async function protocol(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = queryId(request);
  const view = id === null ? null : await studentProtocol(deps.db, session.clientId, id);
  return view ? clientResponse(session, { ok: true, ...view }) : clientResponse(session, { ok: false }, 404);
}

/**
 * GET /tagasiside?id=<registration id> (phase protocols, spec §7): the feedback form of one of her registrations — its course, and whether she
 * has answered already (`sent`). 404 `{ ok: false }` when it is not hers, or the form is not open (spec §3) and she has sent nothing.
 */
async function feedbackForm(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = queryId(request);
  const state = id === null ? null : await feedbackState(deps.db, session.clientId, id, deps.now);
  return state ? clientResponse(session, { ok: true, ...state }) : clientResponse(session, { ok: false }, 404);
}

/**
 * POST /tagasiside `{ registrationId, locale, answers }` (spec §7): her answers, once per registration; Maria is told after the response ("Uus
 * tagasiside: …", mail and Telegram). 200 `{ ok: true }`; 400 `{ error }` (a field, a question's key, "answers" or "empty"); 404 `{ error:
 * "registration" }` (not hers, or not open); 409 `{ error: "sent" }` (answered already); 429 `{ error: "rate" }` after 10 in an hour.
 */
async function sendFeedback(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseFeedbackPost(await readObject(request, FEEDBACK_BODY_CHARS));
  if (!input.ok) return badInput(session, input.error);
  const limited = await feedbackLimited(deps, session);
  if (limited) return limited;
  const result = await submitFeedback(deps.db, { clientId: session.clientId, ...input.data }, deps.now);
  if (result.kind === "notFound") return clientResponse(session, { ok: false, error: "registration" }, 404);
  if (result.kind === "sent") return clientResponse(session, { ok: false, error: "sent" }, 409);
  const notice = result.notice;
  deps.later(() => notifyFeedback(deps.env, deps.siteUrl, notice));
  return clientResponse(session, { ok: true });
}

/**
 * POST /tagasiside/peida `{ registrationId }` ("Ei soovi", spec §7): the dashboard's card is gone for good; the form itself still takes her
 * answers later. 200 `{ ok: true }`; 404 `{ error: "registration" }` (not hers, or not open); 429 (with the submits, 10 an hour).
 */
async function dismissFeedback(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseFeedbackHide(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  const limited = await feedbackLimited(deps, session);
  if (limited) return limited;
  const hidden = await hideFeedback(deps.db, { clientId: session.clientId, registrationId: input.data.registrationId }, deps.now);
  return hidden ? clientResponse(session, { ok: true }) : clientResponse(session, { ok: false, error: "registration" }, 404);
}

/**
 * POST /tingimused `{ slug, version }`: the client accepts the e-course terms, the version the page showed (`terms.version` of the e-course view).
 * 404 `{ error: "slug" }` without active access to that course; 409 `{ error: "version" }` when the terms have changed since the page was loaded
 * (nothing is stored: the page loads the course again and shows the new text).
 */
async function terms(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseTerms(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  const result = await acceptTerms(deps.db, session.clientId, input.data.slug, input.data.version, deps.now);
  if (result === "accepted") return clientResponse(session, { ok: true });
  return result === "stale" ? clientResponse(session, { ok: false, error: "version" }, 409) : clientResponse(session, { ok: false, error: "slug" }, 404);
}

/**
 * POST /kustuta `{ confirm: true }`: deletes the account (client-data.ts deleteClient: registrations stay with Maria) and answers with
 * both cookies cleared, the one answer that does not go through clientResponse. The confirmation e-mail goes out after the
 * response, never to a sample address (`@example.test`) and never in development. Her practical work's photo files (e-course completion,
 * listed by deleteClient) leave the store after the response too.
 */
async function deleteAccount(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseDeletion(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  const gone = await deleteClient(deps.db, session.clientId);
  // her practical work's photo files (e-course completion): listed in the deletion's transaction, removed from the store after the answer
  if (gone && gone.photoKeys.length > 0) {
    const keys = gone.photoKeys;
    deps.later(() => removeKeys(deps.files ?? null, keys, `[practical] client ${session.clientId}`));
  }
  if (gone && !deps.dev && !isSampleAddress(gone.email)) {
    const mail = deletionMail(gone.email, gone.locale);
    deps.later(() => sendMail(deps.env, mail));
  }
  return accountResponse({ ok: true }, 200, clearedCookies());
}

/** The path of one e-course: /kursus/<slug>. */
const COURSE_PATH = /^\/kursus\/([^/]+)$/;
/** A lesson's paths: /kursus/<slug>/<lesson>, …/progress, …/tehtud, …/fail/<file>. */
const LESSON_PATH = /^\/kursus\/([^/]+)\/([^/]+)(?:\/(progress|tehtud)|\/fail\/([^/]+))?$/;
/** The knowledge test's paths (e-course completion): /kursus/<slug>/test and …/test/uuesti. Tried before LESSON_PATH, which would read "test" as a lesson id. */
const TEST_PATH = /^\/kursus\/([^/]+)\/test(\/uuesti)?$/;
/** The practical work of one e-course (e-course completion): /kursus/<slug>/praktiline, …/foto, …/foto/<id>, …/saada. */
const PRACTICAL_PATH = /^\/kursus\/([^/]+)\/praktiline(?:\/(foto|saada)(?:\/([^/]+))?)?$/;
/** One of her practical photos (R5: the id in the path, never a query): /praktiline/foto/<id>, its thumbnail …/<id>/pisi. */
const PHOTO_PATH = /^\/praktiline\/foto\/([^/]+)(\/pisi)?$/;
/** The certificate of one e-course (phase 3d): POST /kursus/<slug>/tunnistus. Tried before LESSON_PATH, which would read "tunnistus" as a lesson id. */
const CERT_PATH = /^\/kursus\/([^/]+)\/tunnistus$/;
/** A certificate's PDF (phase 3d; the id in the path, never a query): GET /tunnistus/<id>. */
const CERT_FILE_PATH = /^\/tunnistus\/([^/]+)$/;

/** The endpoints behind a session; any other method and path is unknown (404, with or without a session). */
async function dataRoute(request: Request, path: string, deps: AccountDeps): Promise<Response> {
  switch (`${request.method} ${path}`) {
    case "GET /": return dashboard(request, deps);
    case "GET /lemmikud": return favouriteCourses(request, deps);
    case "POST /lemmikud": return favourite(request, deps);
    case "POST /lemmikud/merge": return mergeFavouriteList(request, deps);
    case "PATCH /andmed": return profile(request, deps);
    case "POST /uudiskiri": return newsletter(request, deps);
    case "POST /parool": return setPassword(request, deps);
    case "DELETE /parool": return removePassword(request, deps);
    case "POST /muutmine": return changeRequest(request, deps);
    case "POST /maksa": return payRegistration(request, deps);
    case "GET /protokoll": return protocol(request, deps);
    case "GET /tagasiside": return feedbackForm(request, deps);
    case "POST /tagasiside": return sendFeedback(request, deps);
    case "POST /tagasiside/peida": return dismissFeedback(request, deps);
    case "POST /tingimused": return terms(request, deps);
    case "POST /kustuta": return deleteAccount(request, deps);
  }
  const course = request.method === "GET" ? COURSE_PATH.exec(path) : null;
  if (course) return ecourse(request, deps, course[1]);
  const testPath = TEST_PATH.exec(path);
  if (testPath) {
    const [, slug, rewrite] = testPath;
    if (request.method === "GET" && rewrite === undefined) return testPage(request, deps, slug);
    if (request.method === "POST" && rewrite === undefined) return submitTest(request, deps, slug);
    if (request.method === "POST" && rewrite !== undefined) return resubmitTest(request, deps, slug);
    return accountResponse({ ok: false }, 404); // never on to the lessons
  }
  // the practical work's paths (e-course completion): before the lesson paths, which would read "praktiline" as a lesson (and answer 404)
  const practical = PRACTICAL_PATH.exec(path);
  if (practical) {
    const [, slug, part, id] = practical;
    if (request.method === "GET" && part === undefined) return practicalPage(request, deps, slug);
    if (request.method === "POST" && part === "foto" && id === undefined) return uploadPhoto(request, deps, slug);
    if (request.method === "DELETE" && part === "foto" && id !== undefined) return deletePhoto(request, deps, slug, id);
    if (request.method === "POST" && part === "saada" && id === undefined) return submitWork(request, deps, slug);
    return accountResponse({ ok: false }, 404);
  }
  const photoPath = request.method === "GET" ? PHOTO_PATH.exec(path) : null;
  if (photoPath) return photo(request, deps, photoPath[1], photoPath[2] !== undefined);
  // the certificate (phase 3d): its path before the lesson paths, which would read "tunnistus" as a lesson; POST only
  const certPath = CERT_PATH.exec(path);
  if (certPath) return request.method === "POST" ? issueCertificateRoute(request, deps, certPath[1]) : accountResponse({ ok: false }, 404);
  const certFile = request.method === "GET" ? CERT_FILE_PATH.exec(path) : null;
  if (certFile) return certificateFile(request, deps, certFile[1]);
  const lessonPath = LESSON_PATH.exec(path);
  if (lessonPath) {
    const [, slug, id, action, file] = lessonPath;
    if (request.method === "GET" && action === undefined && file === undefined) return lesson(request, deps, slug, id);
    if (request.method === "POST" && action === "progress") return progress(request, deps, slug, id);
    if (request.method === "POST" && action === "tehtud") return lessonDone(request, deps, slug, id);
    if (request.method === "GET" && file !== undefined) return lessonFile(request, deps, slug, id, file);
  }
  return accountResponse({ ok: false }, 404);
}

/** The router: `null` when the path is not `/api/konto/…`. Every failure is a JSON answer; nothing it throws reaches the framework. */
export async function handleAccountApi(request: Request, deps: AccountDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/api\/konto(\/.*)?$/);
  if (!m) return null;
  const path = m[1] ?? "/";
  // The cookie is SameSite=Lax already; this is the second layer (as withAdmin for the admin API).
  if (request.method !== "GET" && request.method !== "HEAD" && isCrossSite(request)) return accountResponse({ ok: false }, 403);
  try {
    switch (`${request.method} ${path}`) {
      case "POST /login": return await login(request, deps);
      case "POST /code": return await code(request, deps);
      case "POST /parool-login": return await passwordLogin(request, deps);
      case "GET /verify": return await verify(request, url, deps);
      case "POST /logout": return await logout(request, deps);
      case "GET /me": return await me(request, deps);
      default: return await dataRoute(request, path, deps);
    }
  } catch (e) {
    logFailure("[account] request failed", e);
    return accountResponse({ ok: false, error: "server" }, 500);
  }
}
