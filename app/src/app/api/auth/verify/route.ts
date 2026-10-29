import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { adminReturnPath } from "@/lib/admin-return";
import { SESSION_COOKIE, SESSION_TTL_MS, redeemLoginToken, sessionCookieOptions } from "@/server/auth";
import { serverEnv } from "@/server/env";
import { logFailure } from "@/server/log";
import { isPrefetch } from "@/server/prefetch";
import { setPreviewCookie } from "@/server/preview";

/**
 * The link in the login e-mail (`?t=<token>`): uses the token (single use, 15 minutes), starts a session of 30 days in
 * the `__Host-mslab_admin` cookie (with the coming-soon gate's preview cookie `mslab_preview` next to it, server/preview.ts)
 * and sends the admin to /admin, or to the admin page of `&tagasi=` (B19: the page she opened signed out). The link's
 * tagasi was checked when the link was made and is checked again here (lib/admin-return.ts): one that is not an admin page
 * of this site lands on /admin without a word. Using the token and creating the session are one transaction, so a database failure in
 * between leaves the link usable. Anything else goes to /admin/login:
 * ?viga=link (unknown, expired or used token, or an address that is no longer allowed), =server (the database failed), both
 * with the checked way back as &tagasi= (so asking for a new link still lands her there);
 * a prefetch goes there without a notice and without touching the token.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const back = adminReturnPath(url.searchParams.get("tagasi"), url.origin);
  /** The login page's notice, with the way back (none for the panel's front page, where a sign-in lands anyway). */
  const notice = (viga: "link" | "server") => `/admin/login?viga=${viga}${back && back !== "/admin" ? `&tagasi=${encodeURIComponent(back)}` : ""}`;
  let session: string | null = null;
  let target = "/admin/login";
  if (!isPrefetch(request.headers)) {
    try {
      // The allow-list is checked again inside: an address taken off the list since the link was sent does not get in.
      session = await redeemLoginToken(getDb(), url.searchParams.get("t") ?? "", serverEnv().ADMIN_EMAILS);
      target = session ? (back ?? "/admin") : notice("link");
    } catch (e) {
      logFailure("[auth] verify failed", e); // never the message: it holds the token hash and the e-mail
      target = notice("server");
    }
  }
  const res = NextResponse.redirect(new URL(target, url.origin), 303);
  if (session) {
    res.cookies.set(SESSION_COOKIE, session, { ...sessionCookieOptions, maxAge: SESSION_TTL_MS / 1000 });
    await setPreviewCookie(res); // the pass through the coming-soon gate, for as long as the session (server/preview.ts)
  }
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer"); // the token is in this URL
  return res;
}

/** Mail scanners and link previews often send HEAD first; Next would run GET for it and use up the token. */
export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
}
