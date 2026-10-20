import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { crossSiteFormPost } from "@/server/auth";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { subscriberLocale, unsubscribeByToken } from "@/server/newsletter";
import { testUnsubscribePage, unsubscribePage } from "@/server/unsubscribe-page";
import { isTokenShape } from "@/server/token";

/**
 * The unsubscribe link of the welcome mail (`?t=<the subscriber's token>`, one-step newsletter, 09.10), in two steps so that a mail gateway
 * that opens every link of a mail (Mimecast, Proofpoint, some Defender setups) unsubscribes no one:
 * - GET only shows a page with one button (server/unsubscribe-page.ts), in the row's language when the token belongs to a row, else in
 *   Estonian; it changes nothing, whoever or whatever fetches it, so no prefetch special case is needed. A token that cannot be one gets
 *   the page without the form.
 * - POST (the button's form field `t`) is the only thing that deletes the row, and sends the visitor to the home page in the row's language
 *   with the notice ?uudiskiri=loobutud. Unsubscribing is idempotent and reveals nothing: an unknown or malformed token, or a button pressed
 *   twice, gets the very same answer in Estonian. Only when the database could not be reached is the visitor told so (?uudiskiri=viga),
 *   never that she is unsubscribed when she is not. A cross-site POST is refused with 403, like the other routes' writes. The row's
 *   once-a-year welcome mark goes with it, so signing up again later gets a fresh welcome.
 * - POST with the body `List-Unsubscribe=One-Click` (RFC 8058: the mail program's own unsubscribe button, for a mail that carries the headers
 *   List-Unsubscribe and List-Unsubscribe-Post; the simple newsletter, spec §3) is a server-to-server call, no browser: the token is only in the
 *   address (`?t=`), nothing is redirected, and the answer is 200 with a tiny plain body, the same for a token that is unknown, used or malformed
 *   (nothing is revealed and nothing else is deleted). Only a database that cannot be reached is told apart (500): she is not unsubscribed then.
 *   The form field `t` of such a body counts for nothing, and the address's `t` counts for nothing in the button's own POST.
 * - HEAD (below) does nothing.
 * - GET with `?proov` (newsletter campaigns ruling R4) is the link of „Saada proov“'s mail to an address that is no subscriber: a page that says
 *   it is a test („Proovikiri — päris kirjas viib see link loobumisele.“), without a form, whatever else the address carries; it changes nothing.
 * The page's headers other than the type and the cache are next.config.ts's (headers() replaces a route's own): noindex, and Referrer-Policy
 * same-origin. That must never become no-referrer: a form posted from such a document carries `Origin: null`.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // a test campaign's link (newsletter campaigns ruling R4: „Saada proov“ to an address that is no subscriber): it says so and changes nothing
  if (params.has("proov")) return new Response(testUnsubscribePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const token = params.get("t") ?? "";
  let locale: "et" | "ru" = "et";
  try {
    locale = (await subscriberLocale(getDb(), token)) ?? "et";
  } catch (e) {
    logFailure("[newsletter] unsubscribe page: language unavailable", e); // the page is shown all the same; never the message: it would contain the token
  }
  return new Response(unsubscribePage(locale, isTokenShape(token) ? token : null), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The one-click answer: a few plain characters and a status, never cached; nothing in it depends on the token. */
const plain = (status: 200 | 500) =>
  new Response(status === 200 ? "OK" : "Error", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  if (crossSiteFormPost(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  const url = new URL(request.url);
  let token = "";
  let oneClick = false;
  try {
    const form = await request.formData();
    oneClick = form.get("List-Unsubscribe") === "One-Click";
    const field = form.get("t");
    if (typeof field === "string") token = field;
  } catch {
    // not a form: no token
  }
  if (oneClick) {
    try {
      await unsubscribeByToken(getDb(), serverKv(), url.searchParams.get("t") ?? "");
    } catch (e) {
      logFailure("[newsletter] one-click unsubscribe failed", e); // never the message: it would contain the token
      return plain(500);
    }
    return plain(200);
  }
  let page = "/";
  let outcome = "loobutud";
  try {
    const gone = await unsubscribeByToken(getDb(), serverKv(), token);
    if (gone?.locale === "ru") page = "/ru";
  } catch (e) {
    logFailure("[newsletter] unsubscribe failed", e); // never the message: it would contain the token
    outcome = "viga";
  }
  const target = new URL(page, url.origin);
  target.searchParams.set("uudiskiri", outcome);
  const res = NextResponse.redirect(target, 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

/** Mail scanners and link previews often send HEAD first; Next would run GET for it. Nothing happens here. */
export function HEAD(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
