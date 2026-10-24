import { sql } from "drizzle-orm";
import type { Q } from "@/db/client";

// A read's stamp (admin UX pass piece 3a, Task 9 review M-1): the database's own clock in microseconds since 1970 — one clock for every server
// instance of the site; Postgres' clock_timestamp(), the moment of the statement itself, not of its transaction. The course editor's page takes it
// before it reads anything (app/admin/(panel)/koolitused/[id]/page.tsx); „Avalda muudatused“, „Loobu muudatustest“ and the switches take it after
// their commit and answer with it. A page read whose stamp is at or past an answer's began after that commit, so it shows it (READ COMMITTED: each
// statement sees what was committed before it began); an older one may have read before it (components/admin/course/SavedCourse.tsx starts the cards
// over only from the former). About 1.8e15 now: a safe integer for a long time. No Next.js here.

/** The database's clock now, in microseconds since 1970. */
export async function readStamp(q: Q): Promise<number> {
  const result: unknown = await q.execute(sql`select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as t`);
  // (postgres.js answers the rows, PGlite an object with them)
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return Number((rows[0] as { t: string }).t);
}

/** readStamp, or null when it cannot be read: an answer that went through is never turned into a failure by its stamp (the editor then takes the next read). */
export const stampOrNull = (q: Q): Promise<number | null> => readStamp(q).catch(() => null);
