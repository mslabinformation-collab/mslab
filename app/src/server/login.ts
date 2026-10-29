import { z } from "zod";
import type { Db } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { adminReturnPath } from "@/lib/admin-return";
import { LOGIN_CAP_WINDOW_MS, LOGIN_TOKEN_CAP, isAllowedAdmin, issueLoginToken } from "./auth";
import { logFailure } from "./log";
import { sendMail, type Env } from "./notify";
import { RATE_LIMIT, RATE_WINDOW_SEC, hashedKey, rateKey, rateLimit, reserveSlot } from "./ratelimit";
import { isLocalHost } from "./site";

// POST /api/auth/request without Next.js: api/auth/request/route.ts builds the dependencies (database, settings,
// visitor IP, after()) and calls handleLoginRequest; the tests call it with PGlite and fakes.
//
// The answer never tells whether an address is allowed: an allowed and a not allowed address get the same
// `{ ok: true }` (the e-mail goes out after the response), and both limits count every well-formed request alike:
// 5 per 10 minutes per IP (429 `rate`), and 3 per 10 minutes per typed address, allowed or not (B20, ruling R-g: the 4th
// answers 429 `address`, so the page says so instead of claiming a link was sent). Behind them an address that already
// has 3 unused links from the last 10 minutes gets the neutral answer and no new token or mail (issueLoginToken's cap).
//
// B19 (ruling R-f): `tagasi`, the admin page she opened signed out, goes into the link as &tagasi= once checked
// (lib/admin-return.ts); api/auth/verify checks it again and lands her there.

export type LoginEnv = Env & { ADMIN_EMAILS: string };

export type LoginDeps = {
  db: Db;
  env: LoginEnv;
  /** The visitor's address (rate limit key); null when the request carries none (then it is not rate limited). */
  ip: string | null;
  /** Base of the link in the e-mail: the request's Host when it is one of ours (site.ts hostOrigin + linkBase), else SITE_URL. */
  siteUrl: string;
  /** The request's Host header; devLink is only ever returned for a local one. */
  host: string | null;
  now: Date;
  /** Runs work after the response has been sent: next/server after() in production, collected and awaited in tests. */
  later: (task: () => Promise<unknown>) => void;
};

export type LoginResult =
  | { status: 200; body: { ok: true; devLink?: string } }
  | { status: 400; body: { ok: false; error: "email" } }
  | { status: 429; body: { ok: false; error: "rate" | "address" } };

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(200)),
  // the way back (B19): anything but a string is no way back, and never a 400; adminReturnPath checks the string
  tagasi: z.string().optional().catch(undefined),
});

/** The link in the login e-mail; with `back` (a checked way back, B19) it carries &tagasi=, one encoded value with its #fragment. */
export const verifyUrl = (siteUrl: string, token: string, back: string | null = null) =>
  `${siteUrl.replace(/\/+$/, "")}/api/auth/verify?t=${encodeURIComponent(token)}${back ? `&tagasi=${encodeURIComponent(back)}` : ""}`;

/** A rate limit that fails open: when KV is unavailable (or over its write quota) the admins can still sign in. */
async function withinRateLimit(deps: LoginDeps): Promise<boolean> {
  if (deps.ip === null) return true; // never on Vercel (x-forwarded-for); one shared bucket would lock everybody out
  try {
    return await rateLimit(deps.env.KV, rateKey("login", deps.ip), RATE_LIMIT, RATE_WINDOW_SEC);
  } catch (e) {
    logFailure("[auth] rate limit unavailable, allowing", e);
    return true;
  }
}

/**
 * B20: one of the typed address's 3 slots in 10 minutes (the numbers „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ names), taken for
 * every address, allowed or not, so the answers are the same for both. The key is the SHA-256 of the normalised address: the KV table never holds
 * an address. Fails open as the per-IP limit does; the token cap of issueLoginToken still holds then.
 */
async function addressSlot(deps: LoginDeps, email: string): Promise<boolean> {
  try {
    return await reserveSlot(deps.env.KV, await hashedKey("login-addr", email), LOGIN_TOKEN_CAP, LOGIN_CAP_WINDOW_MS / 1000);
  } catch (e) {
    logFailure("[auth] address limit unavailable, allowing", e);
    return true;
  }
}

/**
 * Validation → rate limit (5 per 10 min per IP) → the address's limit (3 per 10 min) → token and e-mail for an allowed address, with the checked
 * way back in its link. Throws when the database fails.
 */
export async function handleLoginRequest(deps: LoginDeps, input: unknown): Promise<LoginResult> {
  const parsed = bodySchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { ok: false, error: "email" } };
  if (!(await withinRateLimit(deps))) {
    console.info("[auth] login request rate limited");
    return { status: 429, body: { ok: false, error: "rate" } };
  }

  const { email } = parsed.data;
  if (!(await addressSlot(deps, email))) {
    console.info("[auth] login request over the per-address limit: nothing created, nothing sent");
    return { status: 429, body: { ok: false, error: "address" } };
  }
  if (!isAllowedAdmin(email, deps.env.ADMIN_EMAILS)) {
    console.info("[auth] login request for an address outside the allow-list: nothing sent");
    return { status: 200, body: { ok: true } };
  }

  const token = await issueLoginToken(deps.db, email, deps.now);
  if (token === null) {
    console.info("[auth] login request over the per-address cap: nothing created, nothing sent");
    return { status: 200, body: { ok: true } };
  }
  // the way back, checked (B19); none for the panel's front page, where a sign-in lands anyway
  const back = adminReturnPath(parsed.data.tagasi ?? null, deps.siteUrl);
  const link = verifyUrl(deps.siteUrl, token, back === "/admin" ? null : back);
  // Tests and local development have no mailbox to read: the link comes back in the answer. Two gates: a non-production
  // build (production builds replace process.env.NODE_ENV with "production", so the branch is gone from them) AND a
  // request that came to localhost / 127.0.0.1, so a preview or staging deploy built in development mode cannot leak it.
  const dev = process.env.NODE_ENV !== "production" && isLocalHost(deps.host);
  // A link handed back in the answer is never e-mailed as well: a local dev server or test run that happens to have a
  // RESEND_API_KEY in its environment still sends nobody a mail (the e2e tests sign in many times per run).
  if (dev) return { status: 200, body: { ok: true, devLink: link } };
  deps.later(async () => {
    const sent = await sendMail(deps.env, { to: email, subject: adminEt.mail.subject, text: fill(adminEt.mail.text, { link }) }, { count: deps.db });
    console.info(`[auth] login link e-mailed: ${sent}`);
  });
  return { status: 200, body: { ok: true } };
}
