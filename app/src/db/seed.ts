// CLI: DATABASE_URL=postgres://... npm run db:seed -- [--target local|railway] [--reset [--force]]
// Plain postgres + drizzle (no Cloudflare bindings). Prints row counts only, never the connection string.
//
// --target says which database is meant, and the address must agree (as in fill-ru.ts): "local" only on this machine,
// "railway" only on a Railway host. It is required for --reset (which deletes the content and the registrations), and
// for any database that is not on this machine. Only adding the missing rows to a local database works without it.
// --reset also refuses (--force does not help) while any lesson progress, course access, lesson video or lesson file exists: the
// cascade would delete the students' progress and access, and the Bunny videos and R2 files would be left behind with nobody able
// to delete them. Any refusal is printed as it is (SeedRefusal); every other error prints only a database error code.
import { existsSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { localStore } from "@/server/media-local";
import * as schema from "./schema";
import { targetMatches } from "./fill-ru";
import { safeDbError } from "./safe-error";
import { applySeed, SeedRefusal, type SeedOptions } from "./seed-apply";
import { SEED_BACKGROUND_FILE } from "./seed-data";

/** Why the seed must not run against `url` with these arguments, or null when it may. Never names the address. */
export function seedRefusal(url: string, args: string[]): string | null {
  const t = args.indexOf("--target");
  const target = t >= 0 ? args[t + 1] : undefined;
  if (t >= 0 && target !== "local" && target !== "railway") return "Say which database is meant: --target local | --target railway";
  if (target === "local" || target === "railway") {
    return targetMatches(url, target) ? null : `Refusing: DATABASE_URL is not a ${target === "local" ? "local" : "Railway"} database (--target ${target}).`;
  }
  if (args.includes("--reset")) return "Refusing to reset without --target: say which database is meant (--target local | --target railway).";
  if (!targetMatches(url, "local")) return "Refusing: DATABASE_URL is not a local database. For Railway, add --target railway.";
  return null;
}

/**
 * „Hele“'s test background for a database on this machine (2026-11-11 certificate designs, spec §3): our test JPEG, in the local media folder that
 * `next dev` and the e2e build read (server/media-local.ts). None for any other database (Railway: Maria uploads hers in the admin).
 */
function localBackground(url: string): SeedOptions["background"] {
  if (!targetMatches(url, "local") || !existsSync(SEED_BACKGROUND_FILE)) return undefined;
  return { store: localStore(), bytes: new Uint8Array(readFileSync(SEED_BACKGROUND_FILE)) };
}

/** Applies the seed to the database at `url`: one connection, closed afterwards. */
async function applyToDatabase(url: string, opts: SeedOptions): Promise<Record<string, number>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await applySeed(drizzle(sql, { schema }), { ...opts, background: localBackground(url) });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The whole run of the CLI: what it prints and its exit code. `apply` is the database part (tests pass one on a test database).
 * A refusal of the seed (SeedRefusal: counts and advice, never a row's content) is printed as it is; any other error is a
 * database error and prints only its code (safeDbError).
 */
export async function runSeed(
  url: string | undefined,
  args: string[],
  apply: (url: string, opts: SeedOptions) => Promise<Record<string, number>> = applyToDatabase,
): Promise<number> {
  if (!url) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }
  const refusal = seedRefusal(url, args);
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  const reset = args.includes("--reset");
  try {
    const counts = await apply(url, { reset, force: args.includes("--force") });
    console.log(`Seed done${reset ? " (content tables reset first)" : " (missing rows inserted, existing rows untouched)"}. Row counts:`);
    for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
    return 0;
  } catch (err) {
    console.error(err instanceof SeedRefusal ? err.text : `Seed failed: ${safeDbError(err)}.`);
    return 1;
  }
}

// run as the CLI only (tests import seedRefusal)
if (process.argv[1] && /(^|\/)seed\.ts$/.test(process.argv[1].replaceAll("\\", "/"))) {
  runSeed(process.env.DATABASE_URL, process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
