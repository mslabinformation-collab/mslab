import type { TestInfo } from "@playwright/test";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, snapshotRows } from "./fixtures";

// Järelmaks (Inbank) in the e2e run (instalments, Task 6): the toggle of Seaded → „Järelmaks (Inbank)“ is one shared setting (settings key `financing`), and
// the desktop and phone projects, and the specs that assert its absence (course.spec.ts), run side by side. So every test that needs the toggle in a
// known state takes its turn here (a Postgres advisory lock, as the prepayment setting and the e-course terms do), writes the state straight to the LOCAL
// database, and puts the row back afterwards (a snapshot, which global setup restores too when a run was interrupted).

/** The turn the toggle's tests take. A test that also needs the e-course terms (the cart) takes this one first, then holdTerms(). */
export const FINANCING_LOCK = "e2e-financing-setting";

/**
 * Takes the toggle's turn, sets Seaded's toggle to `enabled` in the LOCAL database and returns what puts the row back and gives the turn up. The wait
 * for the turn is not taken from the test's own time.
 */
export async function takeFinancing(info: TestInfo, enabled: boolean): Promise<() => Promise<void>> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const unlock = await holdLocalLock(FINANCING_LOCK);
  try {
    const restore = await snapshotRows("settings", { column: "key", value: "financing" });
    await setFinancing(enabled);
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
