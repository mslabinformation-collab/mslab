import type { TestInfo } from "@playwright/test";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, snapshotRows } from "./fixtures";
import { revalidateLocalPages } from "./prod-build";
import { PROD_BUILD, PROD_URL } from "./target";
import { expect } from "./test";

// Järelmaks (Inbank) in the e2e run (instalments, Task 6): the toggle of Seaded → „Järelmaks (Inbank)“ is one shared setting (settings key `financing`), and
// the desktop and phone projects, and the specs that assert its absence (course.spec.ts), run side by side. So every test that needs the toggle in a
// known state takes its turn here (a Postgres advisory lock, as the prepayment setting and the e-course terms do), writes the state straight to the LOCAL
// database, and puts the row back afterwards (a snapshot, which global setup restores too when a run was interrupted).

/** The turn the toggle's tests take. A test that also needs the e-course terms (the cart) takes this one first, then holdTerms(). */
export const FINANCING_LOCK = "e2e-financing-setting";

/**
 * The cached pages of the production build that read the toggle and that financing.spec.ts opens, with what each one holds while it is on: the quiet line
 * „Võimalik tasuda ka järelmaksuga (Inbank).“ (the course page's beside its group price, the e-course page's beside its price), or the cart's choice of
 * Järelmaks (Inbank).
 */
const FINANCING_PAGES = [
  { path: "/koolitused/kulmumeistri-baaskoolitus", on: "data-financing-line" },
  { path: "/ru/koolitused/kulmumeistri-baaskoolitus", on: "data-financing-line" },
  { path: "/koolitused/kulmumeistri-e-koolitus", on: "data-financing-line" },
  { path: "/ru/koolitused/kulmumeistri-e-koolitus", on: "data-financing-line" },
  { path: "/ostukorv?kursus=kulmumeistri-e-koolitus", on: 'value="hirePurchase"' },
] as const;

/**
 * Waits until the production build serves each of FINANCING_PAGES with the toggle `enabled` (under `next dev` every request renders, so nothing waits).
 * The write marked the cached pages stale (prod-build.ts), but a page another worker was rendering at that moment, from the toggle read before the
 * write, is stored after the mark and so passes as fresh — or it is the very render that a request for the page joins (Next.js answers requests for one
 * page that overlap with one render). The test's first look would then find the old toggle: „Inbank says no“ once found no Järelmaks (Inbank) on the
 * course page and waited for it until its time ran out. So each round marks the pages stale again and asks for them, until each one has come from a
 * render that began after the write. (A later request cannot get an older render: while one runs, a request for the page joins it.)
 */
async function pagesShowFinancing(enabled: boolean): Promise<void> {
  if (!PROD_BUILD) return;
  await expect
    .poll(
      async () => {
        revalidateLocalPages();
        const old: string[] = [];
        for (const { path, on } of FINANCING_PAGES) if ((await (await fetch(`${PROD_URL}${path}`)).text()).includes(on) !== enabled) old.push(path);
        return old;
      },
      { message: `the pages that show Järelmaks (Inbank) ${enabled ? "on" : "off"}`, timeout: 60_000 },
    )
    .toEqual([]);
}

/**
 * Takes the toggle's turn, sets Seaded's toggle to `enabled` in the LOCAL database, waits until the cached pages show it (pagesShowFinancing) and
 * returns what puts the row back and gives the turn up. The wait for the turn is not taken from the test's own time.
 */
export async function takeFinancing(info: TestInfo, enabled: boolean): Promise<() => Promise<void>> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const unlock = await holdLocalLock(FINANCING_LOCK);
  try {
    const restore = await snapshotRows("settings", { column: "key", value: "financing" });
    try {
      await setFinancing(enabled);
      await pagesShowFinancing(enabled);
    } catch (e) {
      await restore();
      throw e;
    }
    return async () => {
      try {
        await restore();
      } finally {
        await unlock();
      }
    };
  } catch (e) {
    await unlock();
    throw e;
  }
}

/** Writes the toggle ({ enabled }) to the LOCAL database, as Seaded's save would; the cached pages of a production build are marked stale. */
export async function setFinancing(enabled: boolean): Promise<void> {
  await onLocalDb(async (sql) => {
    await sql`delete from settings where key = 'financing'`;
    await sql`insert into settings (key, value) values ('financing', ${sql.json({ enabled })})`;
  });
}
