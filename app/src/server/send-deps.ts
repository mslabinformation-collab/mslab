import { headers } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "./env";
import { serverKv } from "./kv";
import { logFailure } from "./log";
import type { SendDeps } from "./protocols";
import type { MarketingDeps } from "./resend-marketing";
import { linkBase, requestOrigin } from "./site";

// What an admin action's send needs (the protocol screen's sends, server/actions/admin-protocols.ts; Maria's assessment, the test review and
// "Ava test uuesti", server/actions/admin-assessment.ts): the database, the mail's settings, the base of the mail's links (the address Maria
// works on, mslab.ee, or SITE_URL), the time, and `later`, which runs the mail after the answer (next/server after()). Only a server action
// calls it (it reads the request's headers).

/** The send deps of one admin action; `log` prefixes the line of a mail that failed after the answer ("[protocols]", "[assessment]", …). */
export async function adminSendDeps(log: string): Promise<SendDeps> {
  const env = { ...serverEnv(), KV: serverKv() };
  return {
    db: getDb(),
    env,
    // the mail's links: the address Maria works on (mslab.ee), or SITE_URL
    siteUrl: linkBase(requestOrigin(await headers()), env.SITE_URL),
    now: new Date(),
    later: (task) => after(() => task().catch((e) => logFailure(`${log} a mail failed`, e))),
  };
}

/** The interactive time budget of Maria's „Sünkrooni Resendiga“: no new Resend call after it. A call begun at its end has 8 s, and once more after a 429, so the page's maxDuration (60 s) holds. */
export const ADMIN_SYNC_BUDGET_MS = 25_000;

/**
 * The deps of the newsletter's Resend work in the admin (Maria's „Uudiskiri“: the page's count, „Sünkrooni Resendiga“; resend-marketing.ts), built as the
 * daily sweep builds them. The base of the unsubscribe link in each contact is SITE_URL, never the request's address (the link is kept in Resend and
 * mailed long after this request), so this reads no headers and, unlike adminSendDeps, needs no request. `budgetMs`: the full sync's time budget
 * (none: no limit).
 */
export function adminMarketingDeps(budgetMs?: number): MarketingDeps {
  const env = { ...serverEnv(), KV: serverKv() };
  return { db: getDb(), env, siteUrl: env.SITE_URL, now: new Date(), ...(budgetMs === undefined ? {} : { budgetMs }) };
}
