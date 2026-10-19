import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { subscribers } from "@/db/schema";
import { logNote } from "./log";
import { withTimeout } from "./notify";
import { marketingConfigured, readContactCount, type ContactCountRead, type MarketingDeps } from "./resend-marketing";

// What Maria's „Uudiskiri“ page tells its sync part (newsletter campaigns, Task 3; spec D2, D8, §5): whether the newsletter's Resend side is set up,
// Resend's own count of the account's contacts beside the site's, and how many recipients have no contact. Without Next.js (tests/db/newsletter-page.test.ts);
// the page (app/admin/(panel)/uudiskiri) and the sync part (components/admin/NewsletterSync.tsx) take it from here.

/**
 * `resend`: Resend's own count of the account's contacts (null: not answered, or not in time). `refused`: Resend refused the key for that count (a key
 * that can only send): the page says so at once, not only after a press. `site`: the subscribers that have a contact (the rows the sync has made one
 * for), the count the site's own limit check uses. `missing`: confirmed subscribers, sample addresses (`@example.test`, never mailed) left out, that
 * have no contact yet: the limit line's number.
 */
export type SyncState = { configured: false } | { configured: true; resend: number | null; refused: boolean; site: number; missing: number };

/**
 * How long the page waits for Resend's count. A call has 8 s (NOTIFY_TIMEOUT_MS), and once more after a 429, and a slow Resend must not hold Maria's
 * list that long: past this the page shows the site's count alone.
 */
export const COUNT_WAIT_MS = 4000;

/** Resend's count, or none when it does not come within `waitMs` (readContactCount itself answers none when Resend fails). */
async function countWithin(deps: MarketingDeps, waitMs: number): Promise<ContactCountRead> {
  try {
    return await withTimeout(readContactCount(deps), waitMs);
  } catch {
    logNote("[newsletter-sync] Resend's contact count did not answer in time");
    return { count: null, refused: false };
  }
}

/** The two counts of the rows, in one query. */
async function rowCounts(db: Db): Promise<{ site: number; missing: number }> {
  const [r] = await db
    .select({
      site: sql<number>`(count(*) filter (where ${subscribers.resendContactId} is not null))::int`,
      missing: sql<number>`(count(*) filter (where ${subscribers.confirmedAt} is not null and ${subscribers.resendContactId} is null and lower(${subscribers.email}) not like '%@example.test'))::int`,
    })
    .from(subscribers);
  return r;
}

/** The sync part's state. Without the newsletter's key: `{ configured: false }`, and Resend is not asked. Never throws for Resend (a count it cannot give is null). */
export async function syncState(deps: MarketingDeps, waitMs: number = COUNT_WAIT_MS): Promise<SyncState> {
  if (!marketingConfigured(deps.env)) return { configured: false };
  const [count, rows] = await Promise.all([countWithin(deps, waitMs), rowCounts(deps.db)]);
  return { configured: true, resend: count.count, refused: count.refused, ...rows };
}
