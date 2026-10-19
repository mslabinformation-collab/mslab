import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { localDatabaseUrl } from "./fixtures";
import { assertLocalDatabases } from "./local-db";

// A scratch database for a race spec that must not touch the local test database's rows (newsletter campaigns, Task 5: the sync writes the
// subscribers and the settings of the whole table, which the other specs read). It is made on the same server as the local test database (so
// only ever a database on this machine, local-db.ts), migrated with the app's own migrations, and dropped when the spec is done. Every name
// starts with SCRATCH_PREFIX, and only a name that matches NAME is ever created or dropped: nothing else on the server can be reached through here.

/** Every scratch database's name starts with this. */
export const SCRATCH_PREFIX = "mslab_race_";
const NAME = /^mslab_race_[a-z0-9_]{1,40}$/;

export type Scratch = {
  name: string;
  /** The address of the scratch database (the local server's, as the local test database's). */
  url: string;
  /** Drops it, ending any connection still open to it; safe to call twice. */
  drop(): Promise<void>;
};

/** The local test database's server, another database on it. */
export function urlOfDatabase(name: string): string {
  const url = new URL(localDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/** One connection to the local server's own database (the one the local test database lives on), for CREATE and DROP DATABASE. */
const adminConnection = () => postgres(localDatabaseUrl(), { max: 1, connect_timeout: 20, onnotice: () => {} });

const quoted = (name: string): string => {
  if (!NAME.test(name)) throw new Error(`e2e: "${name}" is not a scratch database name`);
  return `"${name}"`;
};

/**
 * Makes a scratch database named after `label` (letters, digits and underscores), runs the app's migrations in it and returns it. Scratch databases
 * an interrupted run left (no connection to them any more) are dropped first.
 */
export async function createScratchDatabase(label: string): Promise<Scratch> {
  const name = `${SCRATCH_PREFIX}${label}_${process.pid}_${Date.now().toString(36)}`;
  const url = urlOfDatabase(name);
  assertLocalDatabases([{ source: "scratch database", url }]);
  const admin = adminConnection();
  try {
    const left = await admin<{ datname: string }[]>`
      select datname from pg_database
      where datname like ${`${SCRATCH_PREFIX.replace(/_/g, "\\_")}%`}
        and not exists (select 1 from pg_stat_activity a where a.datname = pg_database.datname)`;
    for (const { datname } of left) if (NAME.test(datname)) await admin.unsafe(`drop database if exists ${quoted(datname)}`);
    await admin.unsafe(`create database ${quoted(name)}`);
  } finally {
    await admin.end();
  }
  const scratch: Scratch = {
    name,
    url,
    async drop() {
      const other = adminConnection();
      try {
        await other.unsafe(`drop database if exists ${quoted(name)} with (force)`);
      } finally {
        await other.end();
      }
    },
  };
  const one = postgres(url, { max: 1, connect_timeout: 20, onnotice: () => {} });
  try {
    await migrate(drizzle(one), { migrationsFolder: "./drizzle" });
  } catch (e) {
    await one.end();
    await scratch.drop();
    throw e;
  }
  await one.end();
  return scratch;
}
