// The page cache of the e2e run's production build (E2E_PROD_BUILD=1; next.config.ts sets it as `cacheHandler` when
// E2E_PAGE_CACHE is set): Next.js's own file cache, with one switch for the tests. The app revalidates only what its own
// saves change; a test that writes to the database directly (seat fixtures, snapshots put back) writes the time into
// the file E2E_PAGE_CACHE names (tests/e2e/prod-build.ts). A page stored before that time then counts as not cached,
// and its next request renders it again: as if every page had been revalidated (revalidatePath("/", "layout")).
// Loaded by `next build` and `next start` from node_modules' Next.js, so it is plain CommonJS.
//
// Next.js also bundles the cache handler into the edge runtime of src/middleware.ts, which never uses it but cannot
// load node:fs: there this file exports an empty class and loads nothing. (So the requires stay inside the branch.)
/* eslint-disable @typescript-eslint/no-require-imports */

if (process.env.NEXT_RUNTIME === "edge") {
  module.exports = class E2EPageCacheUnused {};
} else {
  const { readFileSync } = require("node:fs");
  const FileSystemCache = require("next/dist/server/lib/incremental-cache/file-system-cache.js").default;

  /** The newest time read from the file so far: the mark only moves forward (a writer that was late with an older time cannot undo a newer one). */
  let seen = 0;

  /**
   * The time written by the last revalidation of every page, or 0 (none yet, or no switch file configured).
   * The file is rewritten in place (writeFileSync truncates it, then writes), so a read that comes between the two sees it EMPTY. That read must
   * not count as "nothing was ever revalidated": every page would pass as fresh for that request, and a page stored before a test's change would
   * be served after it (the newsletter popup test, once in about three runs of the edit phase). An empty file is read again a moment later; if it
   * stays empty, the newest time seen before stands.
   */
  const staleBefore = () => {
    const file = process.env.E2E_PAGE_CACHE;
    if (!file) return 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const at = Number(readFileSync(file, "utf8"));
        if (at > 0) return (seen = Math.max(seen, at));
      } catch (e) {
        if (e && e.code === "ENOENT") return seen; // no revalidation yet
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); // (the writer is between truncating and writing: a moment)
    }
    return seen;
  };

  module.exports = class E2EPageCache extends FileSystemCache {
    async get(...args) {
      const data = await super.get(...args);
      if (data && typeof data.lastModified === "number" && data.lastModified >= 0 && data.lastModified < staleBefore()) return null;
      return data;
    }
  };
}
