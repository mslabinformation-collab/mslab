import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { lessonFiles } from "@/db/schema";
import { PURGE_AFTER_MS } from "@/domain/undo";
import { logFailure } from "./log";
import type { FileStore } from "./media";

// The purge of removed lesson files (admin UX pass piece 3a, R-f). A lesson file's „Eemalda“ only sets lesson_files.removed_at, so that the
// UndoBar (8 s) can bring the file back by clearing it; every reader leaves a marked file out. Once the mark is at least PURGE_AFTER_MS old (domain/undo.ts)
// the row and its R2 object go: after each lesson-file action (server/actions/admin-lessons.ts: „Eemalda“ and „Võta tagasi“) and each read of the
// course editor (app/admin/(panel)/koolitused/[id]/page.tsx), both in `after()` so no answer waits for R2, and by the daily sweep (app/api/cron/sweep)
// as the backstop for the last removal of a session. 10 s is a minimum: a purge never takes a file whose UndoBar could still be open, and a late
// purge only costs a few bytes of storage. One run takes at most PURGE_BATCH files (Task 2 review: the R2 deletes were unbounded); what is left
// goes with the next one. The daily sweep drains instead (drainRemovedLessonFiles, Task 10 review M3): batch after batch until none is due,
// within PURGE_MAX_BATCHES batches and its deadline, so that a backlog cannot build behind the cap.

/** The most files one run takes (each is one R2 delete, one after the other): the oldest marks first. */
export const PURGE_BATCH = 20;

/**
 * The DELETE of one batch: the rows `candidates` (a select of ids, read on the statement's snapshot) names that are still marked, and
 * marked `due` (an ISO time) or earlier. The mark is checked here again, outside the subquery, on purpose: under read committed a row
 * that another transaction is changing is waited for and then re-checked against the outer WHERE only, never the subquery. So a file
 * „Võta tagasi“ brings back (removed_at cleared) while this DELETE waits on its row is not deleted. Exported for
 * tests/db/lesson-file-purge.test.ts only.
 */
export function deleteDueFiles(db: Db, candidates: SQL, due: string) {
  return db
    .delete(lessonFiles)
    .where(sql`${lessonFiles.id} in (${candidates}) and ${lessonFiles.removedAt} is not null and ${lessonFiles.removedAt} <= ${due}::timestamptz`)
    .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
}

/**
 * Deletes the rows of at most `limit` files removed `PURGE_AFTER_MS` or more before `now` (the oldest marks first), and then their R2 objects (the
 * row first: a mark that came back with a failed object delete would show a file nobody can download). Answers how many rows went. Without a
 * store (R2 not set up) only the rows go; an object that cannot be deleted is logged (no key) and the others go on — an orphan only costs
 * storage. Two runs at once never delete one object twice: each deletes only the rows its own DELETE took. Never throws: a database that fails is
 * logged (class and code only) and answers 0, so no lesson-file action, page or sweep fails because of it.
 */
export async function purgeRemovedLessonFiles(db: Db, files: FileStore | null, now: Date, limit: number = PURGE_BATCH): Promise<number> {
  try {
    const due = new Date(now.getTime() - PURGE_AFTER_MS).toISOString();
    const batch = Math.max(0, Math.floor(limit));
    // (one statement, the batch in a subquery: the oldest marks first, by id among equals)
    const rows = await deleteDueFiles(
      db,
      sql`select ${lessonFiles.id} from ${lessonFiles} where ${lessonFiles.removedAt} is not null and ${lessonFiles.removedAt} <= ${due}::timestamptz order by ${lessonFiles.removedAt}, ${lessonFiles.id} limit ${batch}`,
      due,
    );
    if (files)
      for (const { r2Key: key } of rows) {
        try {
          await files.delete(key);
        } catch (e) {
          logFailure("[lesson-files] a removed file's object was not deleted", e); // never the key
        }
      }
    return rows.length;
  } catch (e) {
    logFailure("[lesson-files] removed files not purged", e);
    return 0;
  }
}

/** The most batches one drain runs (the daily sweep): 25 × PURGE_BATCH = 500 files; what is left waits for the next run. */
export const PURGE_MAX_BATCHES = 25;

/** What a drain did: the rows purged, and whether a bound (the batch count, the deadline) ended it while files may still be due. */
export type PurgeDrain = { purged: number; stopped: boolean };

/**
 * Runs purgeRemovedLessonFiles batch after batch until a batch comes back short (nothing more is due), so that a backlog cannot build behind
 * the one-batch cap (Task 10 review M3: the sweep purged 20 a day). Bounded twice: `maxBatches` batches (PURGE_MAX_BATCHES), and no new batch
 * once `until` (epoch ms) has passed; a batch that has begun is finished (its rows are deleted, so its objects are too). `stopped` is true when a
 * bound ended the drain (some files may be left for the next run), false when it ran out of due files. Never throws (the purge logs a failed database
 * and answers 0, which ends the loop).
 */
export async function drainRemovedLessonFiles(
  db: Db,
  files: FileStore | null,
  now: Date,
  { until = Infinity, maxBatches = PURGE_MAX_BATCHES, limit = PURGE_BATCH }: { until?: number; maxBatches?: number; limit?: number } = {},
): Promise<PurgeDrain> {
  let purged = 0;
  for (let batches = 0; ; batches += 1) {
    if (batches >= maxBatches || Date.now() > until) return { purged, stopped: true };
    const took = await purgeRemovedLessonFiles(db, files, now, limit);
    purged += took;
    if (took === 0 || took < limit) return { purged, stopped: false };
  }
}
