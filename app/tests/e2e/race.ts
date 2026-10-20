import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { localDatabaseUrl, onLocalDb } from "./fixtures";
import { expect } from "./test";

// What the real-Postgres race specs share (invoices-race, certificate-race, completion-race, protocols-race, contracts-race): a pool of the local
// Postgres for the app's own calls, in the spec's process, under a name of the spec's own (`application`, its pg_stat_activity.application_name),
// and the proof that calls meet at a lock: the spec holds the lock on another connection and reads this pool's backends waiting for it in
// pg_stat_activity, instead of sleeping and hoping.

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pool of the local Postgres that connects under `application` (so the spec finds its own backends in pg_stat_activity and no one else's), and the app's db on it.
 * `url`: another database of the same server (a spec's scratch database, scratch-db.ts); the local test database by default. `max`: the pool's
 * connections (6; the app's own pool has 5, db/client.ts).
 */
export function racePool(application: string, url: string = localDatabaseUrl(), max = 6): { pool: postgres.Sql; db: Db } {
  const pool = postgres(url, { max, connect_timeout: 20, onnotice: () => {}, connection: { application_name: application } });
  return { pool, db: drizzle(pool, { schema }) as unknown as Db };
}

/** Where the lock is held: a connection to the database the calls work on (the local test database by default; a scratch database passes its own). */
export type OnDb = <T>(work: (sql: postgres.Sql) => Promise<T>) => Promise<T>;
const onLocalDbQuietly: OnDb = (work) => onLocalDb(work, { marksPages: false });

export type Waiting = { query: string; wait_event: string | null };
/**
 * The backends of the pool named `application` that wait for a lock (pg_stat_activity by its application_name: nothing another test or process
 * waits for is read as this one's), asked again every 50 ms until there are `n` of them, or `gone()` says the work it waits for is over, or `ms`
 * have passed: a test proves the wait instead of sleeping and hoping.
 */
export async function lockWaits(application: string, n: number, gone: () => boolean, ms = 15_000): Promise<Waiting[]> {
  const until = Date.now() + ms;
  for (;;) {
    const waiting = await onLocalDb(
      (other) => other<Waiting[]>`select query, wait_event from pg_stat_activity where application_name = ${application} and wait_event_type = 'Lock'`,
      { marksPages: false },
    );
    if (waiting.length >= n || gone() || Date.now() > until) return waiting;
    await pause(50);
  }
}

/**
 * Two calls in flight at the same moment on the pool named `application`, `first` started before `second`. Another connection holds a lock
 * (`hold`: a row the calls lock first, or a transaction lock) while they start; the test starts `first`, waits until the pool shows it waiting,
 * starts `second`, waits until it shows both waiting, and only then lets the lock go (its transaction ends). A call that ran its whole
 * transaction before the other began would never be seen waiting beside it. They stand in the lock's queue in the order started (a lock queue
 * is first come, first served), so which of the two goes first is fixed by the test, and the outcome that follows is the locks', not the
 * timing's. Their results, in the order started.
 */
export async function inFlight<A, B>(
  application: string,
  hold: (tx: postgres.TransactionSql) => Promise<unknown>,
  first: () => Promise<A>,
  second: () => Promise<B>,
  on: OnDb = onLocalDbQuietly,
): Promise<[A, B]> {
  let settled = 0;
  const started: Promise<unknown>[] = [];
  const start = <T,>(call: () => Promise<T>): Promise<T> => {
    const running = call();
    started.push(running);
    void running.then(
      () => settled++,
      () => settled++,
    );
    return running;
  };
  let a!: Promise<A>;
  let b!: Promise<B>;
  try {
    await on((sql) =>
      sql.begin(async (tx) => {
        await hold(tx);
        a = start(first);
        expect((await lockWaits(application, 1, () => settled > 0)).length, "the first call waits for the held lock").toBe(1);
        b = start(second);
        const waiting = await lockWaits(application, 2, () => settled > 0);
        expect(settled, "a call went past the held lock while it was held").toBe(0);
        expect(waiting.length, `both calls wait for the lock (${waiting.map((w) => w.query.slice(0, 60)).join(" | ")})`).toBe(2);
      }),
    );
  } finally {
    await Promise.allSettled(started); // a failure above lets the lock go too: what is on its way finishes before the clean-up
  }
  return [await a, await b];
}
