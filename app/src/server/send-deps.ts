import { headers } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "./env";
import { serverKv } from "./kv";
import { logFailure } from "./log";
import { campaignMailSend } from "./mail-outbox";
import type { SendDeps as CampaignSendDeps } from "./newsletter-campaigns";
import type { SendDeps } from "./protocols";
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

/**
 * The deps of a newsletter campaign's send (newsletter-campaigns.ts SendDeps): the press and „Saada proov“ (actions/admin-newsletter.ts), the daily job
 * (api/cron/uudiskiri). The base of every link in the mails is SITE_URL, never the request's address (a campaign's mail is kept long after the
 * request, and the daily job has no visitor's address at all), so this reads no headers. `budgetMs`: the run's own time, from now (no new mail after
 * it); the send is notify.ts sendMailResult, except on the e2e run's own servers, where it is the outbox's (mail-outbox.ts: E2E_MAIL_OUTBOX, a file the
 * mails are written to, never sent; ignored on Vercel).
 */
export function campaignSendDeps(budgetMs: number): CampaignSendDeps {
  const env = { ...serverEnv(), KV: serverKv() };
  const send = campaignMailSend(env);
  return { db: getDb(), env, siteUrl: env.SITE_URL, now: () => new Date(), deadline: Date.now() + budgetMs, ...(send ? { send } : {}) };
}
