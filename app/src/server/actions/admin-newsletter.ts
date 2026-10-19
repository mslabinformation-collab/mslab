"use server";

import { refresh } from "next/cache";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { fullSync, MarketingUnavailable, marketingConfigured, type FullSyncReport } from "../resend-marketing";
import { ADMIN_SYNC_BUDGET_MS, adminMarketingDeps } from "../send-deps";

// Maria's newsletter actions (newsletter campaigns, Task 3, spec D2, §5): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// resend-marketing.ts fullSync; here it is run with an interactive time budget (it is a press, not the daily cron), its refusals get a code that
// the page turns into Estonian words (adminEt.newsletter.sync.errors), and a sync that ran refreshes the open page, so that its counts are the new ones.
// The action's own time is the page's (uudiskiri/page.tsx maxDuration).

/** The names a Resend error has when the key itself is refused (the SDK passes the API's `name` and `statusCode` on as they come). */
const KEY_ERRORS: ReadonlySet<string> = new Set(["restricted_api_key", "invalid_api_key", "missing_api_key"]);

/**
 * Did Resend refuse the key, rather than fail? A key that can only send (RESEND_API_KEY of the welcome mails) answers every contact, segment and
 * broadcast call with 401 `restricted_api_key` ("This API key is restricted to only send emails"); a key it does not know is 403 `invalid_api_key`.
 * Any other 401 or 403 counts too, except a 403 `validation_error`, which is how Resend words refusals that are not about the key.
 */
function keyRefused(e: MarketingUnavailable): boolean {
  if (e.code !== undefined && KEY_ERRORS.has(e.code)) return true;
  return (e.statusCode === 401 || e.statusCode === 403) && e.code !== "validation_error";
}

/**
 * „Sünkrooni Resendiga“: the full sync of the subscribers with Resend's contacts (resend-marketing.ts fullSync: Resend-side unsubscribes pulled, the
 * suppression list read, contacts put right), for at most ADMIN_SYNC_BUDGET_MS. Ran: the sync's report as it is (`finished: false` when the time
 * ran out and the rest waits for the next run), and the open page is refreshed. Not run, in a code: `notConfigured` (no marketing key: nothing is
 * asked of Resend), `permission` (the key can only send, or is not accepted: a full-access key is needed), `unavailable` (Resend does not answer),
 * `server` (anything else, such as the database: logged by the error's class, never its message).
 */
export const fullSyncAction = adminAction(async (): Promise<FullSyncReport | { error: "notConfigured" | "permission" | "unavailable" | "server" }> => {
  try {
    const deps = adminMarketingDeps(ADMIN_SYNC_BUDGET_MS);
    if (!marketingConfigured(deps.env)) return { error: "notConfigured" };
    const report = await fullSync(deps);
    refresh();
    return report;
  } catch (e) {
    logFailure("[newsletter-sync] the admin's sync failed", e);
    if (e instanceof MarketingUnavailable) return { error: keyRefused(e) ? "permission" : "unavailable" };
    return { error: "server" };
  }
});
