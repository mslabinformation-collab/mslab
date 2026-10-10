import { after } from "next/server";
import { getDb, type Db } from "@/db/client";
import { bunnyApi, bunnyConfig, type BunnyConfig } from "@/server/bunny";
import { sweepClientRows } from "@/server/client-auth";
import { serverEnv } from "@/server/env";
import { serverKv, sweepExpired } from "@/server/kv";
import { sweepStuckVideos, type VideoSweep } from "@/server/lesson-videos";
import { logFailure } from "@/server/log";
import { checkPendingPayments, NO_PAYMENT_SWEEP, type PaymentSweep } from "@/server/payments/check";
import { paymentProvider } from "@/server/payments/montonio";
import { revalidatePublic } from "@/server/public-cache";
import { keyMatches } from "@/server/review-key";

export const dynamic = "force-dynamic";
// Hobby's functions may run up to 300 s; 60 is our own guard. The Bunny part stays inside it: no new row is started after
// SWEEP_DEADLINE_MS (35 s) of the run, and a row begun is finished, which takes at most about 20 s (getVideo 10 s, then one delete
// 10 s), so 35 s + 20 s is under 60. (SWEEP_BATCH rows of each kind bound the work as well.) The payments' part (phase 2b) keeps to the same
// deadline: no new GET /orders after it, and one begun has 15 s at most (REQUEST_TIMEOUT_MS), so 35 s + 15 s and its settlement is under 60 too.
// The parts run side by side, so their times do not add up.
export const maxDuration = 60;
const SWEEP_DEADLINE_MS = 35_000;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The Bunny part of the sweep: uploads first, then processing (one after the other, so the Bunny calls stay few at a time), until `until` (epoch ms). Nothing without Bunny's settings. */
async function sweepVideos(db: Db, bunny: BunnyConfig | null, now: Date, until: number): Promise<VideoSweep> {
  if (!bunny) return { uploads: 0, processingReady: 0, processingFailed: 0, left: 0, outOfTime: false };
  return sweepStuckVideos(db, bunnyApi(bunny), now, until);
}

/**
 * The payments' part (phase 2b, server/payments/check.ts): null without online payments (then no log line: the existing tests count the
 * sweep's log lines, and a line of zeros would only be noise). Mails of a payment it settles go after the response.
 */
async function sweepPayments(db: Db, now: Date, until: number): Promise<PaymentSweep | null> {
  const montonio = paymentProvider();
  if (!montonio) return null;
  const env = { ...serverEnv(), KV: serverKv() };
  return checkPendingPayments(
    { db, env, now, siteUrl: env.SITE_URL, later: (task) => after(() => task().catch((e) => logFailure("[payments] background task failed", e))), changed: revalidatePublic, montonio },
    until,
  );
}

/**
 * GET /api/cron/sweep — Vercel's daily cron (vercel.json), one invocation that deletes:
 * - the expired kv_entries rows, so the forms' rate limit counters (which hold visitors' addresses) are gone a day after their
 *   window at the latest, also when no submission comes to sweep them (server/kv.ts);
 * - the client accounts' old rows (server/client-auth.ts sweepClientRows): login codes past their 30 minutes (they hold the
 *   address in plain text), sessions over for more than 30 days, and the mail counters of days more than a week ago;
 * - with Bunny set up (server/lesson-videos.ts), the lesson videos left unfinished for a day, at most SWEEP_BATCH of each kind a run and
 *   no new row after SWEEP_DEADLINE_MS (what is left waits for the next run: `videosLeft`, and a line in the log when time ran out):
 *   uploads still "uploading" a day after they began are deleted from Bunny (`uploads`), and the lesson gets back its replaced
 *   video or has none; videos still "processing" a day after are asked about and settled, ready (`processingReady`) or failed
 *   (`processingFailed`, so the editor offers "Lae uuesti üles"). A ready video is never destroyed, and a replaced video that
 *   still plays is only deleted once the new one is ready.
 * - with online payments set up (server/payments/check.ts, phase 2b), the pending payments: those older than 45 minutes and younger than 14
 *   days are asked about at Montonio (at most 50, none after SWEEP_DEADLINE_MS) and settled; older ones, and orders never created, fail
 *   (at most 50 a run, through failPayment: the registration's lock first); holds that ended in the last day revalidate the seats;
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` when the project has the CRON_SECRET variable; anything else, and every
 * request while CRON_SECRET is not set, is a 401.
 * 200 `{ ok: true, deleted, logins, sessions, mailDays, uploads, processingReady, processingFailed, videosLeft, paymentsChecked,
 * paymentsSettled, paymentsExpired, paymentsLeft }` (counts; `deleted` is the kv entries; the payment counts are zeros without online
 * payments); 500 `{ ok: false }` when the database fails. The log line has the counts only, no ids.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = serverEnv().CRON_SECRET;
  if (!secret || !(await keyMatches(request.headers.get("authorization"), `Bearer ${secret}`))) return json(401, { ok: false });
  try {
    const db = getDb();
    const now = new Date();
    const until = now.getTime() + SWEEP_DEADLINE_MS;
    const [deleted, accounts, videos, checked] = await Promise.all([sweepExpired(db, now), sweepClientRows(db, now), sweepVideos(db, bunnyConfig(), now, until), sweepPayments(db, now, until)]);
    console.info(
      `[cron] sweep: ${deleted} expired kv entries, ${accounts.logins} login codes, ${accounts.sessions} sessions, ${accounts.mailDays} mail counters, ${videos.uploads} stuck video uploads deleted, ${videos.processingReady} stuck processing videos found ready, ${videos.processingFailed} marked failed, ${videos.left} video rows left for the next run`,
    );
    if (videos.outOfTime) console.info(`[cron] sweep: no new video row started after ${SWEEP_DEADLINE_MS / 1000} s`);
    // the payments' line only with online payments set up: without them the existing log lines are all there is (tests/db/cron-sweep.test.ts
    // counts them: toHaveBeenCalledTimes(1), the exact list of two), and the answer's payment counts are zeros
    if (checked) {
      console.info(
        `[cron] sweep: payments ${checked.checked} checked at Montonio, ${checked.settled} settled, ${checked.unanswered} not answered, ${checked.expired} failed as stale, ${checked.left} left for the next run, ${checked.holdsEnded} seat holds ended`,
      );
      if (checked.outOfTime) console.info(`[cron] sweep: no new payment asked about after ${SWEEP_DEADLINE_MS / 1000} s`);
    }
    const paid = checked ?? NO_PAYMENT_SWEEP;
    return json(200, {
      ok: true,
      deleted,
      ...accounts,
      uploads: videos.uploads,
      processingReady: videos.processingReady,
      processingFailed: videos.processingFailed,
      videosLeft: videos.left,
      paymentsChecked: paid.checked,
      paymentsSettled: paid.settled,
      paymentsExpired: paid.expired,
      paymentsLeft: paid.left,
    });
  } catch (e) {
    logFailure("[cron] sweep failed", e);
    return json(500, { ok: false });
  }
}
