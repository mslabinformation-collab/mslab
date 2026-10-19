"use server";

import { refresh } from "next/cache";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { FullSyncBusy, fullSync, keyRefused, MarketingUnavailable, marketingConfigured, type FullSyncReport } from "../resend-marketing";
import { ADMIN_SYNC_BUDGET_MS, adminMarketingDeps } from "../send-deps";

// Maria's newsletter actions (newsletter campaigns, Task 3, spec D2, §5): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// resend-marketing.ts fullSync; here it is run with an interactive time budget (it is a press, not the daily cron), its refusals get a code that
// the page turns into Estonian words (adminEt.newsletter.sync.errors), and a sync that ran refreshes the open page, so that its counts are the new ones.
// The action's own time is the page's (uudiskiri/page.tsx maxDuration).

/**
 * „Sünkrooni Resendiga“: the full sync of the subscribers with Resend's contacts (resend-marketing.ts fullSync: Resend-side unsubscribes pulled, the
 * suppression list read, contacts put right), for at most ADMIN_SYNC_BUDGET_MS. Ran: the sync's report as it is (`finished: false` when the time
 * ran out and the rest waits for the next run), and the open page is refreshed. Not run, in a code: `notConfigured` (no marketing key: nothing is
 * asked of Resend), `busy` (another full sync holds the lease, fullSync: the cron, another tab; not an error, so not logged as one),
 * `permission` (the key can only send, or is not accepted: a full-access key is needed), `unavailable` (Resend does not answer), `server`
 * (anything else, such as the database: logged by the error's class, never its message).
 */
export const fullSyncAction = adminAction(
  async (): Promise<FullSyncReport | { error: "notConfigured" | "busy" | "permission" | "unavailable" | "server" }> => {
    try {
      const deps = adminMarketingDeps(ADMIN_SYNC_BUDGET_MS);
      if (!marketingConfigured(deps.env)) return { error: "notConfigured" };
      const report = await fullSync(deps);
      refresh();
      return report;
    } catch (e) {
      if (e instanceof FullSyncBusy) return { error: "busy" }; // (fullSync logged it)
      logFailure("[newsletter-sync] the admin's sync failed", e);
      if (e instanceof MarketingUnavailable) return { error: keyRefused(e) ? "permission" : "unavailable" };
      return { error: "server" };
    }
  },
);
