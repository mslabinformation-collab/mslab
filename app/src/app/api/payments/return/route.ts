import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { paymentProvider } from "@/server/payments/montonio";
import { handleReturn, returnPending } from "@/server/payments/routes";
import { revalidatePublic } from "@/server/public-cache";
import { subscriberSync } from "@/server/resend-marketing";
import { hostOrigin, linkBase } from "@/server/site";

export const dynamic = "force-dynamic";
/** A token in doubt asks Montonio (15 s at most): the function must not hang for the plan's default 300 s. */
export const maxDuration = 30;

/**
 * GET /api/payments/return?order-token=… — Montonio's returnUrl (server/payments/routes.ts handleReturn): the payer's browser lands here from
 * the bank and is sent on to the static /makse page with the result in the fragment. Behind the coming-soon gate like the rest of the site
 * (spec 10: an admin with the preview cookie only, before the launch; the webhook is the one payment address that is not). The mail links use
 * the request's own origin when it is one of ours. Whatever fails here, the payer lands on /makse as "pooleli": never an error page.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const env = { ...serverEnv(), KV: serverKv() };
    const db = getDb();
    return await handleReturn(request, {
      db,
      env,
      now: new Date(),
      siteUrl: linkBase(hostOrigin(request.headers), env.SITE_URL),
      later: (task) => after(() => task().catch((e) => logFailure("[payments] background task failed", e))),
      changed: revalidatePublic,
      montonio: paymentProvider(),
      // a paid e-course purchase's newsletter box: its sync to Resend (newsletter campaigns); none without the newsletter's key
      newsletterSync: subscriberSync(db, env),
    });
  } catch (e) {
    logFailure("[payments] return failed", e);
    return returnPending();
  }
}
