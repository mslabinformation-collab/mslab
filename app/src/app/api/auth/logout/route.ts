import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/db/client";
import { PREVIEW_COOKIE } from "@/lib/preview-cookie";
import { SESSION_COOKIE, deleteSession, isCrossSite, sessionCookieOptions } from "@/server/auth";
import { logFailure } from "@/server/log";
import { clearPreviewCookie, endDraftMode } from "@/server/preview";

/**
 * Logout (POST from the button in the admin area): deletes the session row, clears the `__Host-mslab_admin` cookie and
 * the coming-soon gate's preview cookie (`mslab_preview`, server/preview.ts), and sends the browser to /admin/login. POST
 * only, so that a link or an image on another site cannot sign anybody out, and a POST from another site (Origin) is
 * refused with 403.
 *
 * Deliberately not wrapped in withAdmin: a session that has expired, or whose address has left the allow-list, must still
 * be able to clear its cookies and get to the login page instead of a JSON 401. A request without the cookies just gets
 * the redirect (a cross-site POST does not carry them, SameSite=Lax); each cookie the request carries is cleared, the
 * preview cookie also without a session. Next's draft-mode cookie (the draft preview, api/admin/eelvaade) ends with it, whether or not a session
 * is left to end (an expired one, or none), and only after the session: a failure there is logged and never keeps a session alive (final review
 * P6-1). The static check in tests/unit/admin-guards.test.ts covers app/admin and app/api/admin; this route lives under app/api/auth because it
 * is part of signing in and out.
 */
export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  const res = NextResponse.redirect(new URL("/admin/login", new URL(request.url).origin), 303);
  res.headers.set("cache-control", "no-store");
  if (jar.get(PREVIEW_COOKIE) !== undefined) clearPreviewCookie(res); // the gate's pass ends with the session
  if (raw) {
    try {
      await deleteSession(getDb(), raw);
    } catch (e) {
      logFailure("[auth] logout failed to delete the session", e); // the cookie is cleared all the same
    }
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  }
  // and so does the draft preview, whether or not a session was left to end
  try {
    await endDraftMode();
  } catch (e) {
    logFailure("[auth] logout failed to end the draft preview", e); // the session has ended all the same
  }
  return res;
}
