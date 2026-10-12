import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROD_BUILD, PROD_URL } from "./target";

// The switches of the e2e run's production build (E2E_PROD_BUILD=1, tests/e2e/target.ts). It is started with the local
// settings (tests/local-secrets.ts LOCAL_ENV) and these.

/**
 * The file the build's page cache reads (tests/e2e/page-cache.cjs): the pages stored before the time in it count as not
 * cached. In the build's own folder, which `next build` empties.
 */
export const STALE_PAGES_FILE = resolve(".next", "e2e-stale-pages");

/** The review comment list's key on the production build, which never accepts the dev key. A placeholder, local only. */
export const E2E_REVIEW_KEY = "e2e-review-key";

/**
 * On top of LOCAL_ENV: its own address as the site's (links in comments and e-mails; `next dev` on localhost:3000 is
 * allow-listed instead, server/site.ts), the page cache with the tests' switch (next.config.ts), uploads kept in the
 * local folder as under `next dev` (server/media-store.ts; a production build has no store without R2), the comment
 * list's key, and the fake Montonio, which a production build takes only with this explicit flag (server/payments/montonio.ts).
 */
export const PROD_ENV = {
  SITE_URL: PROD_URL,
  E2E_PAGE_CACHE: STALE_PAGES_FILE,
  MEDIA_LOCAL: "1",
  ADMIN_KEY: E2E_REVIEW_KEY,
  PAYMENT_MOCK_IN_PRODUCTION: "1",
};

/**
 * Marks every cached page of the local production build stale (nothing to do against `next dev`, which renders every
 * request): what a test wrote straight to the database shows on the next page view.
 */
export function revalidateLocalPages(): void {
  if (!PROD_BUILD) return;
  writeStaleMark(STALE_PAGES_FILE);
}

/** The width of the time in the file: milliseconds since 1970 have 13 digits until the year 2286. */
const MARK_WIDTH = 13;

/**
 * Writes "now" into the switch file at `file`. The workers write it side by side while the server reads it on every page lookup, so it is never
 * emptied: the new time is written OVER the old one in place (flag "r+": no truncating), at a fixed width, so the file keeps its length and a reader
 * sees the old time or the new one, never an empty file. Only a file that is not there yet is created (the first mark of a build; page-cache.cjs
 * reads an empty or unreadable file again). The mark only moves forward: a worker that was late must not put an older time over a newer one.
 */
export function writeStaleMark(file: string, now: number = Date.now()): void {
  mkdirSync(dirname(file), { recursive: true });
  let newest = 0;
  try {
    newest = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    // none yet
  }
  const text = String(Math.max(now, newest)).padStart(MARK_WIDTH, "0");
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, text, { flag: "r+" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    try {
      writeFileSync(file, text, { flag: "wx" }); // not there yet: this worker creates it
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw e; // another worker created it first: over it, once
    }
  }
}
