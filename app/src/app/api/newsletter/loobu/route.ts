import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { crossSiteFormPost } from "@/server/auth";
import { serverKv } from "@/server/kv";
import { logFailure, logNote } from "@/server/log";
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
 *   One-click is judged by its body, never by how the sender typed it or where it comes from (the final review's M1: she must not stay subscribed while her
 *   mail program thinks she left): the Content-Type may be any or none (text/plain, JSON, multipart), and an Origin header, a web mail client's or the
 *   provider's, does not refuse it: the cross-site check guards the button's form, which has nothing but the page it came from, while here the token in the
 *   address is the whole capability. So does a POST with an empty body and the token in the address, unless it is a browser's own form post
 *   (Sec-Fetch-Mode: navigate: the button always carries its field `t`). Each one is logged with the row's id, never the token or the address
 *   ("one-click unsubscribe: subscriber 12", or that no row was found: a used or a made-up token), and a POST with a token in the address and a body it cannot
 *   read is noted too: nothing is lost without a line in the log.
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

/** What a POST's body says: whether it has none, whether it is RFC 8058's one-click body, and the button's own form field "t" ("" when there is none). */
type Body = { empty: boolean; oneClick: boolean; field: string };

/**
 * The body, read once as text and judged by what it says rather than by its Content-Type: a form (urlencoded or multipart) gives its fields, any other
 * type is read as a urlencoded string (the sender may send none, or text/plain). "List-Unsubscribe=One-Click" counts under any type; the button's field "t"
 * only from a form body (a text/plain "t=..." is what a cross-site form with enctype="text/plain" can send, and it never unsubscribes).
 */
async function readBody(request: Request): Promise<Body> {
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    // an unreadable body is no body
  }
  const type = request.headers.get("content-type") ?? "";
  const multipart = /^multipart\/form-data/i.test(type);
  const form = multipart || /^application\/x-www-form-urlencoded/i.test(type);
  let get: (name: string) => string | null = () => null;
  if (multipart) {
    try {
      const data = await new Response(raw, { headers: { "content-type": type } }).formData();
      get = (name) => {
        const value = data.get(name);
        return typeof value === "string" ? value : null;
      };
    } catch {
      // not a form after all: no fields
    }
  } else {
    const params = new URLSearchParams(raw.trim());
    get = (name) => params.get(name);
  }
  return { empty: raw.trim() === "", oneClick: get("List-Unsubscribe")?.trim() === "One-Click", field: form ? (get("t") ?? "") : "" };
}

/** A one-click unsubscribe by the address's token: 200 whatever the token (the log holds the row's id when there was one, never the token), 500 when the database failed. */
async function unsubscribeOneClick(token: string): Promise<Response> {
  try {
    const gone = await unsubscribeByToken(getDb(), serverKv(), token);
    console.info(gone ? `[newsletter] one-click unsubscribe: subscriber ${gone.id}` : "[newsletter] one-click unsubscribe: no subscriber for the token");
  } catch (e) {
    logFailure("[newsletter] one-click unsubscribe failed", e); // never the message: it would contain the token
    return plain(500);
  }
  return plain(200);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = await readBody(request);
  const inAddress = url.searchParams.get("t");
  // the mail program's button: by its body, whatever its Content-Type and whatever its Origin; or a body-less POST to the address with the token (and not a browser's form post)
  if (body.oneClick || (body.empty && inAddress !== null && request.headers.get("sec-fetch-mode") !== "navigate")) return unsubscribeOneClick(inAddress ?? "");
  if (crossSiteFormPost(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  const token = body.field;
  if (inAddress !== null && token === "" && !body.empty) {
    logNote("[newsletter] unsubscribe POST: a token in the address and a body that is neither the button's nor one-click's; nothing deleted");
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
