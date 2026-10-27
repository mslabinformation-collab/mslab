import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { reviews } from "@/db/schema";
import { PURGE_AFTER_MS } from "@/domain/undo";
import { logFailure } from "./log";

// The purge of the reviews Maria removed (admin UX pass piece 4c, R-b), on the model of the lesson files' (lesson-file-purge.ts). „Kustuta“ on a
// review she added only sets reviews.removed_at (server/reviews.ts removeManualReview), so that the UndoBar (8 s) can bring it back by clearing
// it; every reader leaves a marked review out. Once the mark is at least PURGE_AFTER_MS old (domain/undo.ts: the UndoBar's 8 s and a margin, as for
// the lesson files) the row goes: after each „Kustuta“ (server/actions/admin-reviews.ts, in `after()`, so the answer never waits for it) and by the daily
// sweep (app/api/cron/sweep) as the backstop for the last removal of a session. A review is a row only, so one run is one DELETE; a late purge
// costs nothing, as nobody sees a marked review. Nothing to revalidate either: the public pages left it out from the moment it was marked. Only a
// review Maria added is ever purged (`kind = 'manual'`, in the candidates and again in the DELETE): a student's review goes only by her own
// withdrawal, so a mark set on one by mistake can never delete her words behind her back (review M-3).

/** The most reviews one run takes, the oldest marks first; what is left goes with the next run. Maria adds reviews by hand: a run rarely has one. */
export const REVIEW_PURGE_BATCH = 100;

/**
 * The DELETE of one batch: the rows `candidates` (a select of ids, read on the statement's snapshot) names that are Maria's, still marked, and marked
 * `due` (an ISO time) or earlier. The mark is checked here again, outside the subquery, on purpose: under read committed a row that another
 * transaction is changing is waited for and then re-checked against the outer WHERE only, never the subquery. So a review „Võta tagasi“ brings
 * back (removed_at cleared, under the row's lock: restoreManualReview) while this DELETE waits on its row is not deleted. Exported for
 * tests/db/reviews.test.ts only.
 */
export function deleteDueReviews(db: Db, candidates: SQL, due: string) {
  return db
    .delete(reviews)
    .where(sql`${reviews.id} in (${candidates}) and ${reviews.kind} = 'manual' and ${reviews.removedAt} is not null and ${reviews.removedAt} <= ${due}::timestamptz`)
    .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
}

/**
 * Deletes at most `limit` reviews removed PURGE_AFTER_MS or more before `now` (the oldest marks first) and answers how many went. Never throws: a
 * database that fails is logged (class and code only) and answers 0, so neither „Kustuta“ nor the sweep fails because of it.
 */
export async function purgeRemovedReviews(db: Db, now: Date, limit: number = REVIEW_PURGE_BATCH): Promise<number> {
  try {
    const due = new Date(now.getTime() - PURGE_AFTER_MS).toISOString();
    const batch = Math.max(0, Math.floor(limit));
    // (one statement, the batch in a subquery: the oldest marks first, by id among equals)
    const rows = await deleteDueReviews(
      db,
      sql`select ${reviews.id} from ${reviews} where ${reviews.kind} = 'manual' and ${reviews.removedAt} is not null and ${reviews.removedAt} <= ${due}::timestamptz order by ${reviews.removedAt}, ${reviews.id} limit ${batch}`,
      due,
    );
    return rows.length;
  } catch (e) {
    logFailure("[reviews] removed reviews not purged", e);
    return 0;
  }
}
