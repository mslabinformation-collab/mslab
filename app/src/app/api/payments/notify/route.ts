import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { paymentProvider } from "@/server/payments/montonio";
import { handleNotify } from "@/server/payments/routes";
import { revalidatePublic } from "@/server/public-cache";
import { subscriberSync } from "@/server/resend-marketing";

export const dynamic = "force-dynamic";
/** A token in doubt asks Montonio (15 s at most): the function must not hang for the plan's default 300 s. */
export const maxDuration = 30;

/**
 * POST /api/payments/notify — Montonio's webhook (server/payments/routes.ts handleNotify). POST only (any other method is Next.js's 405); it
 * goes through the coming-soon gate (lib/site-gate.ts) and is never redirected (an /api address: lib/site-routing.ts). The mail links use
 * SITE_URL: the request comes from Montonio, not from a visitor. A missing setting is a 503, so Montonio tries again.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const env = { ...serverEnv(), KV: serverKv() };
    const db = getDb();
    return await handleNotify(request, {
      db,
      env,
      now: new Date(),
      siteUrl: env.SITE_URL,
      later: (task) => after(() => task().catch((e) => logFailure("[payments] background task failed", e))),
      changed: revalidatePublic,
      montonio: paymentProvider(),
      // a paid e-course purchase's newsletter box: its sync to Resend (newsletter campaigns); none without the newsletter's key
      newsletterSync: subscriberSync(db, env),
    });
  } catch (e) {
    logFailure("[payments] webhook failed", e);
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
