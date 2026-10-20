import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { not, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect } from "vitest";
import * as schema from "@/db/schema";
import type { Db } from "@/db/client";
import { courseModules, mailQuota, type CourseModule } from "@/db/schema";
import type { I18n } from "@/i18n/field";

export async function makeTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

/**
 * The version of `kind`'s contract text as a page shows it now (contracts, ruling R6): what the registration form and the cart send with the
 * box, which the server compares with the current one. Imported when it is asked for, so that the other DB tests do not load the contracts.
 */
export async function shownContractVersion(db: Db, kind: "contact" | "ecourse" = "contact"): Promise<string> {
  const { contractTemplate } = await import("@/server/contracts");
  return (await contractTemplate(db, kind, "et")).version;
}

/**
 * The `mail_quota` rows of the caps: the logins' and confirmations' "<day>", the newsletter's "<day>:nl". Without "<day>:all", the day's count of every
 * mail the site sent (client-auth.ts countSentMail), to which each mail Resend accepted adds, whatever its kind: a test of what takes a place of a cap
 * reads these rows.
 */
export const capRows = (db: Db) => db.select().from(mailQuota).where(not(like(mailQuota.day, "%:all")));

/** How many mails the site has counted as sent (the "<day>:all" rows together; the day is the one the mails went on). */
export async function countedMails(db: Db): Promise<number> {
  return (await db.select().from(mailQuota).where(like(mailQuota.day, "%:all"))).reduce((n, r) => n + r.sent, 0);
}

/** Module rows for a course (course_modules), positions 1…n in the given order. */
export async function addModules(db: Db, courseId: number, titles: I18n[]): Promise<CourseModule[]> {
  return titles.length ? db.insert(courseModules).values(titles.map((title, i) => ({ courseId, position: i + 1, title }))).returning() : [];
}

/** A copy of ./drizzle whose journal ends with `tag` (the migrator applies what the journal lists, by its time stamps); the caller removes it. */
export function migrationsThrough(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mslab-migrations-"));
  cpSync("./drizzle", dir, { recursive: true });
  const path = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  expect(at, tag).toBeGreaterThanOrEqual(0);
  journal.entries = journal.entries.slice(0, at + 1);
  writeFileSync(path, JSON.stringify(journal));
  return dir;
}
