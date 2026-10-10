import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { handlePayPage } from "@/server/pay-page";
import { paymentProvider } from "@/server/payments/montonio";
import { clientIp } from "@/server/ratelimit";
import { hostOrigin, linkBase } from "@/server/site";

export const dynamic = "force-dynamic";
/** The button's POST asks Montonio for an order (15 s at most). */
export const maxDuration = 30;

type Ctx = { params: Promise<{ token: string }> };

/**
 * /maksa/<pay_token> — the "Maksa" link of the registration mail (phase 2b, server/pay-page.ts). GET shows the page; its button's POST starts
 * the payment. It goes through the coming-soon gate (lib/site-gate.ts) and is served as it is by the routing (lib/site-routing.ts). Its
 * headers besides the type and the cache are next.config.ts's: noindex, and Referrer-Policy same-origin — never no-referrer, or the
 * button's POST carries `Origin: null` and is refused.
 */
async function answer(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  try {
    const h = request.headers;
    const siteUrl = serverEnv().SITE_URL;
    return await handlePayPage(request, token, {
      db: getDb(),
      kv: serverKv(),
      now: new Date(),
      siteUrl: linkBase(hostOrigin(h), siteUrl),
      notifyBase: siteUrl,
      montonio: paymentProvider(),
      // without x-forwarded-for (never on Vercel) `next dev` uses one local bucket
      ip: clientIp(h) ?? (process.env.NODE_ENV === "development" ? "local" : null),
    });
  } catch (e) {
    logFailure("[payments] pay page failed", e); // never the message: the token is in the address
    return new Response("", { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const GET = answer;
export const POST = answer;

/** Mail scanners and link previews often send HEAD first; Next would run GET for it. Nothing happens here. */
export function HEAD(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
