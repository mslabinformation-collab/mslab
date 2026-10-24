import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { lessonFiles } from "@/db/schema";
import { logFailure } from "./log";
import type { FileStore } from "./media";

// The purge of removed lesson files (admin UX pass piece 3a, R-f). A lesson file's „Eemalda“ only sets lesson_files.removed_at, so that the
// UndoBar (8 s) can bring the file back by clearing it; every reader leaves a marked file out. Once the mark is at least PURGE_AFTER_MS old
// the row and its R2 object go: after each lesson-file action (server/actions/admin-lessons.ts: „Eemalda“ and „Võta tagasi“) and each read of the
// course editor (app/admin/(panel)/koolitused/[id]/page.tsx), both in `after()` so no answer waits for R2, and by the daily sweep (app/api/cron/sweep)
// as the backstop for the last removal of a session. 10 s is a minimum: a purge never takes a file whose UndoBar could still be open, and a late
// purge only costs a few bytes of storage. One run takes at most PURGE_BATCH files (Task 2 review: the R2 deletes were unbounded); what is left
// goes with the next one.

/** How old the mark must be before a file is purged: the UndoBar's 8 s and a margin. Never less. */
export const PURGE_AFTER_MS = 10_000;
/** The most files one run takes (each is one R2 delete, one after the other): the oldest marks first. */
export const PURGE_BATCH = 20;

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
    const rows = await db
      .delete(lessonFiles)
      .where(
        sql`${lessonFiles.id} in (select ${lessonFiles.id} from ${lessonFiles} where ${lessonFiles.removedAt} is not null and ${lessonFiles.removedAt} <= ${due}::timestamptz order by ${lessonFiles.removedAt}, ${lessonFiles.id} limit ${batch})`,
      )
      .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
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
