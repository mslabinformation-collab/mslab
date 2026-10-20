import { serverEnv } from "@/server/env";
import { logFailure } from "@/server/log";
import { CRON_BUDGET_MS, runDueCampaigns } from "@/server/newsletter-campaigns";
import { keyMatches } from "@/server/review-key";
import { campaignSendDeps } from "@/server/send-deps";

export const dynamic = "force-dynamic";
// Hobby's functions may run up to 300 s, and this one uses them: a batch sends one mail about every 0.6 s (SEND_GAP_MS), up to the day's room. No
// new mail after CRON_BUDGET_MS (270 s) of the run; one begun has 8 s, and once more after a 429 (notify.ts), so 270 s + 17 s and the queries stay
// under 300. A claim older than STALE_CLAIM_MS (6 minutes) can then only be a dead runner's (newsletter-campaigns.ts).
export const maxDuration = 300;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * GET /api/cron/uudiskiri — the newsletter's daily job (vercel.json, 04:00 UTC, an hour after the sweep; the simple newsletter, spec §3 "Where the
 * batches run"): the campaign going out, if any, gets one batch (newsletter-campaigns.ts runDueCampaigns: stale claims `unknown` first, then its
 * waiting rows while the day's room and the run's time last). The links in the mails are SITE_URL's (send-deps.ts campaignSendDeps), whatever
 * address this request came to.
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` when the project has the CRON_SECRET variable; anything else, and every request while
 * CRON_SECRET is not set, is a 401 and nothing is done.
 * 200 `{ ok: true, campaignId: null }` when nothing is going out; `{ ok: true, campaignId, stopped, total, sent, waiting, failed, unknown, skipped }`
 * after a batch (`stopped`: why rows still wait — `room`, `refused`, `time` — or null); 500 `{ ok: false }` when the database fails. The log line has
 * the campaign's id and the counts only.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = serverEnv().CRON_SECRET;
  if (!secret || !(await keyMatches(request.headers.get("authorization"), `Bearer ${secret}`))) return json(401, { ok: false });
  try {
    const run = await runDueCampaigns(campaignSendDeps(CRON_BUDGET_MS));
    if (run.campaignId === null || !run.progress) {
      console.info("[cron] uudiskiri: no campaign is going out");
      return json(200, { ok: true, campaignId: null });
    }
    const p = run.progress;
    console.info(
      `[cron] uudiskiri: campaign ${run.campaignId}: ${p.sent} sent of ${p.total}, ${p.waiting} waiting, ${p.failed} failed, ${p.unknown} unknown, ${p.skipped} skipped${run.stopped ? `; stopped (${run.stopped})` : ""}`,
    );
    return json(200, { ok: true, campaignId: run.campaignId, stopped: run.stopped, ...p });
  } catch (e) {
    logFailure("[cron] uudiskiri failed", e);
    return json(500, { ok: false });
  }
}
