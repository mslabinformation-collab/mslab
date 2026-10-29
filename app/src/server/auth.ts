import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, count, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { cache } from "react";
import { getDb, type Db } from "@/db/client";
import { adminSessions, authTokens } from "@/db/schema";
import type * as schema from "@/db/schema";
import { ADMIN_PATH_HEADER, adminLoginHref } from "@/lib/admin-return";
import { serverEnv } from "./env";
import { logFailure } from "./log";
import { isTokenShape, newToken, sha256 } from "./token";

// Admin sign-in by magic link. Only the e-mails in ADMIN_EMAILS can sign in. A login link holds a random token that is
// valid for 15 minutes and works once; opening it starts a session of 30 days, kept in the `__Host-mslab_admin` cookie.
// The database holds only the SHA-256 hashes of tokens and session ids, never the values themselves.
//
// The functions up to `adminFirstName` take a Db and a clock and run without Next.js (tests/db/auth.test.ts); the
// guards below them read the cookie and the environment.

/** `__Host-`: browsers accept the cookie only with Secure, Path=/ and no Domain, so a sibling subdomain cannot plant or shadow it. */
export const SESSION_COOKIE = "__Host-mslab_admin";
export const TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** At most this many unused login links per address may have been issued within the last LOGIN_CAP_WINDOW_MS. */
export const LOGIN_TOKEN_CAP = 3;
export const LOGIN_CAP_WINDOW_MS = 10 * 60_000;

/** Attributes of the session cookie (Max-Age is added when it is set; 0 clears it). */
export const sessionCookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Is `email` in the comma-separated allow-list `allow` (the setting ADMIN_EMAILS)? Whole addresses only,
 * case-insensitive, trimmed. No allow-list (the secret not set): nobody.
 */
export function isAllowedAdmin(email: string, allow: string | undefined): boolean {
  const wanted = normalize(email);
  if (!wanted) return false;
  return (allow ?? "").split(",").some((entry) => normalize(entry) === wanted);
}

/**
 * Greeting name of an admin from `names` (the setting ADMIN_NAMES: "<address>=<name>,…"), or "" when the
 * address has none there (the admin pages then greet without a name). The addresses live in the settings, never here.
 */
export function adminFirstName(email: string, names: string | undefined): string {
  const wanted = normalize(email);
  if (!wanted) return "";
  for (const entry of (names ?? "").split(",")) {
    const at = entry.lastIndexOf("=");
    if (at > 0 && normalize(entry.slice(0, at)) === wanted) return entry.slice(at + 1).trim();
  }
  return "";
}

/**
 * A login token for `email`: returns the raw token (for the link), stores its hash and an expiry 15 minutes ahead.
 * Tokens that have expired are swept on the way, so the table does not grow.
 */
export async function createLoginToken(db: Db, email: string, now: Date = new Date()): Promise<string> {
  await db.delete(authTokens).where(lt(authTokens.expiresAt, now));
  const raw = newToken();
  await db.insert(authTokens).values({ hash: await sha256(raw), email: normalize(email), expiresAt: new Date(now.getTime() + TOKEN_TTL_MS) });
  return raw;
}

/** Runs `fn` in one database transaction (everything commits or nothing does); `tx` is used like the Db. */
async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return (db as PostgresJsDatabase<typeof schema>).transaction((tx) => fn(tx as unknown as Db));
}

/**
 * A login token for `email` unless that address already has LOGIN_TOKEN_CAP unused tokens issued within the last 10
 * minutes: then null, and the caller answers as usual but creates and sends nothing. This is what bounds the mail
 * one address can be sent, whatever the visitor's IP (the per-IP limit in KV is only the first, approximate line).
 * Requests for the same address are serialised by a transaction-scoped advisory lock, so a burst cannot count the same
 * rows and all slip under the cap. The tokens' age is read from their expiry (created = expires - 15 minutes).
 */
export async function issueLoginToken(db: Db, email: string, now: Date = new Date()): Promise<string | null> {
  const address = normalize(email);
  return inTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"login-token:" + address}))`);
    const issuedSince = new Date(now.getTime() + TOKEN_TTL_MS - LOGIN_CAP_WINDOW_MS);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(authTokens)
      .where(and(eq(authTokens.email, address), isNull(authTokens.usedAt), gt(authTokens.expiresAt, issuedSince)));
    return n >= LOGIN_TOKEN_CAP ? null : createLoginToken(tx, address, now);
  });
}

/**
 * Uses a login token: the address it was issued for, or null when it is unknown, expired or already used. One
 * UPDATE both checks and burns it, so two simultaneous clicks cannot both get in.
 */
export async function consumeLoginToken(db: Db, raw: string, now: Date = new Date()): Promise<string | null> {
  if (!isTokenShape(raw)) return null;
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.hash, await sha256(raw)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .returning();
  return row?.email ?? null;
}

/** A session for `email`: the raw session id for the cookie; its hash is stored, expiring in 30 days. Expired sessions are swept. */
export async function createSession(db: Db, email: string, now: Date = new Date()): Promise<string> {
  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, now));
  const raw = newToken();
  await db.insert(adminSessions).values({ idHash: await sha256(raw), email: normalize(email), expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  return raw;
}

/** The e-mail of a live session, or null (no cookie, unknown id, expired). */
export async function getSessionEmail(db: Db, raw: string | undefined, now: Date = new Date()): Promise<string | null> {
  if (!isTokenShape(raw)) return null;
  const [row] = await db
    .select({ email: adminSessions.email })
    .from(adminSessions)
    .where(and(eq(adminSessions.idHash, await sha256(raw)), gt(adminSessions.expiresAt, now)))
    .limit(1);
  return row?.email ?? null;
}

/**
 * The login link's last step: uses the token and starts the session in ONE transaction, so a failure while creating the
 * session (database error) rolls the token back and the link still works. Returns the raw session id, or null when the
 * token is unknown, expired or used, or its address is no longer in `allow` (that token is used up).
 */
export async function redeemLoginToken(db: Db, rawToken: string, allow: string, now: Date = new Date()): Promise<string | null> {
  return inTransaction(db, async (tx) => {
    const email = await consumeLoginToken(tx, rawToken, now);
    return email && isAllowedAdmin(email, allow) ? createSession(tx, email, now) : null;
  });
}

/** Ends a session (logout). An unknown or missing id is ignored. */
export async function deleteSession(db: Db, raw: string | undefined): Promise<void> {
  if (!isTokenShape(raw)) return;
  await db.delete(adminSessions).where(eq(adminSessions.idHash, await sha256(raw)));
}

// ---------- guards (cookie + environment) ----------

/** The greeting name of a signed-in admin (the environment variable ADMIN_NAMES), or "". */
export function adminName(email: string): string {
  return adminFirstName(email, serverEnv().ADMIN_NAMES);
}

/**
 * The signed-in admin of this request, or null. The session must be live and its e-mail still in ADMIN_EMAILS (taking
 * an address off the list ends its access without touching the sessions). Memoised per request, so the layout and the
 * page share one lookup. A failing database is logged without details and thrown as a plain error (a 500, never a
 * redirect that looks like a logout).
 */
export const currentAdminEmail = cache(async (): Promise<string | null> => {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const email = await getSessionEmail(getDb(), raw);
    return email && isAllowedAdmin(email, serverEnv().ADMIN_EMAILS) ? email : null;
  } catch (e) {
    logFailure("[auth] session lookup failed", e);
    throw new Error("admin session lookup failed");
  }
});

/**
 * For admin pages, layouts and server actions: the signed-in admin's e-mail, or a redirect to /admin/login with the page asked for as ?tagasi=
 * (B19: the middleware hands its path and query on in x-mslab-path; an action posts to its page's address), so the sign-in lands her back on it.
 * A layout is not re-rendered when the visitor navigates between its pages, so every admin page (and action) calls
 * this itself; the layout's call is the first line of defence, not the only one.
 */
export async function requireAdmin(): Promise<string> {
  const email = await currentAdminEmail();
  if (!email) redirect(adminLoginHref((await headers()).get(ADMIN_PATH_HEADER)));
  return email;
}

/**
 * The signed-in admin's e-mail, or throws a 401 Response (for code that needs the e-mail outside a handler's own
 * arguments). Route handlers should use withAdmin() below, which also refuses cross-site writes and cannot be forgotten.
 */
export async function requireAdminEmail(): Promise<string> {
  const email = await currentAdminEmail();
  if (!email) {
    throw new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return email;
}

// ---------- route handlers and server actions ----------
// Every admin route handler is wrapped in withAdmin and every admin server action in adminAction, so a new one cannot
// forget the check (tests/unit/admin-guards.test.ts reads the source files and fails when one does).

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A request whose Origin header names another site (a missing Origin is not cross-site: not every client sends one). */
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true; // "null" (sandboxed frames, some redirects) or garbage
  }
}

/**
 * Is this form POST from another site? isCrossSite (the Origin header), except that `Origin: null` with `Sec-Fetch-Site: same-origin` is this
 * site's own page: the browser sends that pair when the page's referrer policy is strict, and only a browser can say it (the header is
 * forbidden to scripts). A named foreign site is cross-site whatever Sec-Fetch-Site says. The standalone pages' buttons use it: the
 * unsubscribe page (api/newsletter/loobu) and the pay page (/maksa/<token>, phase 2b).
 */
export function crossSiteFormPost(request: Request): boolean {
  if (request.headers.get("origin") === "null" && request.headers.get("sec-fetch-site") === "same-origin") return false;
  return isCrossSite(request);
}

const denied = (status: 401 | 403, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Wraps an admin route handler: 403 for a POST / PUT / PATCH / DELETE whose Origin is another site (the cookie is
 * SameSite=Lax already; this is the second layer), 401 JSON without a live session of an allowed admin, otherwise the
 * handler runs with the admin's e-mail. `export const POST = withAdmin(async (request, ctx, { email }) => …)`.
 */
export function withAdmin<Ctx = unknown>(handler: (request: Request, ctx: Ctx, admin: { email: string }) => Response | Promise<Response>) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    if (MUTATING.has(request.method.toUpperCase()) && isCrossSite(request)) return denied(403, "forbidden");
    const email = await currentAdminEmail();
    if (!email) return denied(401, "unauthorized");
    return handler(request, ctx, { email });
  };
}

/**
 * Wraps an admin server action: requireAdmin() first (redirect to /admin/login without a session), then `fn` with the
 * admin's e-mail as its first argument; callers pass only the rest. Next.js itself refuses action calls from other
 * origins. `export const saveCourse = adminAction(async ({ email }, formData: FormData) => …)`.
 */
export function adminAction<A extends unknown[], R>(fn: (admin: { email: string }, ...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => fn({ email: await requireAdmin() }, ...args);
}
