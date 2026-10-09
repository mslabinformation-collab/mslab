import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { crossSiteFormPost } from "@/server/auth";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { subscriberLocale, unsubscribeByToken } from "@/server/newsletter";
import { unsubscribePage } from "@/server/unsubscribe-page";
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
 * - HEAD (below) does nothing.
 * The page's headers other than the type and the cache are next.config.ts's (headers() replaces a route's own): noindex, and Referrer-Policy
 * same-origin. That must never become no-referrer: a form posted from such a document carries `Origin: null`.
 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
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

export async function POST(request: Request): Promise<Response> {
  if (crossSiteFormPost(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  let token = "";
  try {
    const field = (await request.formData()).get("t");
    if (typeof field === "string") token = field;
  } catch {
    // not a form: no token
  }
  const url = new URL(request.url);
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
