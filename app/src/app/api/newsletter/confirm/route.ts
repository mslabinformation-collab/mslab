import { after, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { welcomeFragment } from "@/domain/welcome-code";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { confirmNewsletter } from "@/server/newsletter";
import { isPrefetch } from "@/server/prefetch";
import { linkBase } from "@/server/site";

/**
 * The confirmation link of the old newsletter double opt-in (`?t=<token>`): since 09.10 the sign-up is one step and nothing creates a new
 * confirmation mail, but links already sent are still in mailboxes and keep working. Confirms the subscriber and sends the visitor to the
 * home page in their language, which shows a notice: ?uudiskiri=kinnitatud (confirmed), =vigane (unknown token), =viga (the database
 * could not be reached). The first confirmation with a welcome code set (Seaded "Tervituskood", phase 2c) also mails the code after
 * the response and carries it in the fragment (#kood=<CODE>): the cached home page shows it from there, and no server or cache sees it.
 * The link is single-use in effect (the first click earns the welcome), so what only looks at it must not use it up: a prefetch or
 * prerender (Sec-Purpose / Purpose) goes home without confirming or a notice, and HEAD (below) does nothing.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (isPrefetch(request.headers)) return redirectTo(new URL("/", url.origin));
  let outcome: "kinnitatud" | "vigane" | "viga" = "vigane";
  let page = "/";
  let code: string | null = null;
  try {
    const env = { ...serverEnv(), KV: serverKv() };
    const result = await confirmNewsletter(
      {
        db: getDb(),
        env,
        now: new Date(),
        siteUrl: linkBase(url.origin, env.SITE_URL), // the base of the unsubscribe link in the welcome mail
        later: (task) => after(() => task().catch((e) => logFailure("[newsletter] welcome e-mail failed", e))),
      },
      url.searchParams.get("t") ?? "",
    );
    outcome = result.outcome;
    if (result.locale === "ru") page = "/ru";
    code = result.code;
  } catch (e) {
    logFailure("[newsletter] confirm failed", e); // never the message: it would contain the token
    outcome = "viga";
  }
  const target = new URL(page, url.origin);
  target.searchParams.set("uudiskiri", outcome);
  if (code) target.hash = welcomeFragment(code);
  return redirectTo(target);
}

/** The redirect, never cached (it answers one link with one outcome). */
function redirectTo(target: URL): Response {
  const res = NextResponse.redirect(target, 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

/** Mail scanners and link previews often send HEAD first; Next would run GET for it and use up the first confirmation. Nothing happens here. */
export function HEAD(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
