import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// The page cache of the e2e run's production build (tests/e2e/page-cache.cjs): a page stored before the time in the switch file counts as not
// cached. The file is rewritten in place by every worker that writes to the database (prod-build.ts revalidateLocalPages), which leaves it EMPTY
// for a moment, and a read in that moment used to mean "nothing was ever revalidated": every page passed as fresh, and a page stored before a
// test's change was served after it. Over ten runs of the edit phase that made the home page's popup and the trainer page tests fail in three
// (the cache logged eight such reads). These tests run the real handler over a stand-in for Next's file cache.

const req = createRequire(import.meta.url);
const FILE_CACHE = req.resolve("next/dist/server/lib/incremental-cache/file-system-cache.js");
const HANDLER = req.resolve("../e2e/page-cache.cjs");

type Entry = { lastModified: number; value: unknown };
type Handler = new () => { get(key: string): Promise<Entry | null> };

let dir: string;
let file: string;
let stored: Entry;
let original: NodeJS.Module | undefined;
const saved = { cache: process.env.E2E_PAGE_CACHE, runtime: process.env.NEXT_RUNTIME };

/** The handler over a stand-in file cache that holds one entry (`stored`); a new copy of the module each time (it remembers the newest time it read). */
function handler(): Handler {
  delete req.cache[HANDLER];
  req.cache[FILE_CACHE] = {
    id: FILE_CACHE,
    filename: FILE_CACHE,
    loaded: true,
    exports: { default: class { async get(): Promise<Entry> { return stored; } } },
  } as unknown as NodeJS.Module;
  return req(HANDLER) as Handler;
}

const served = async (h: Handler, lastModified: number): Promise<boolean> => {
  stored = { lastModified, value: "page" };
  return (await new h().get("key")) !== null;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mslab-page-cache-"));
  file = join(dir, "e2e-stale-pages");
  process.env.E2E_PAGE_CACHE = file;
  delete process.env.NEXT_RUNTIME;
  original = req.cache[FILE_CACHE];
});
afterEach(() => {
  if (original) req.cache[FILE_CACHE] = original;
  else delete req.cache[FILE_CACHE];
  delete req.cache[HANDLER];
  if (saved.cache === undefined) delete process.env.E2E_PAGE_CACHE;
  else process.env.E2E_PAGE_CACHE = saved.cache;
  if (saved.runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = saved.runtime;
  rmSync(dir, { recursive: true, force: true });
});

describe("the e2e page cache and its switch file", () => {
  test("a page stored before the time in the file is not served; one stored after it is", async () => {
    writeFileSync(file, "2000");
    const h = handler();
    expect(await served(h, 1000)).toBe(false);
    expect(await served(h, 3000)).toBe(true);
  });

  test("no file yet, or no switch configured: every page is served", async () => {
    expect(await served(handler(), 1000)).toBe(true);
    delete process.env.E2E_PAGE_CACHE;
    expect(await served(handler(), 1000)).toBe(true);
  });

  test("the file empty for a moment (a writer between truncating and writing it) is not 'nothing was revalidated': the newest time seen before stands", async () => {
    writeFileSync(file, "2000");
    const h = handler();
    expect(await served(h, 1000)).toBe(false);
    writeFileSync(file, ""); // the moment between the writer's truncate and write
    expect(await served(h, 1000)).toBe(false);
    expect(await served(h, 3000)).toBe(true);
    writeFileSync(file, "2500"); // the writer is done
    expect(await served(h, 2400)).toBe(false);
  });

  test("a time written late and older than one already seen does not take a revalidation back", async () => {
    writeFileSync(file, "2000");
    const h = handler();
    expect(await served(h, 1500)).toBe(false);
    writeFileSync(file, "1000");
    expect(await served(h, 1500)).toBe(false);
  });

  test("a file that was never anything but empty or not a time counts as no mark (and is read again a few times first)", async () => {
    writeFileSync(file, "");
    expect(await served(handler(), 1000)).toBe(true);
    writeFileSync(file, "soon");
    expect(await served(handler(), 1000)).toBe(true);
  });
});
