import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { certificates, clients, courseAccess, courses } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0009 (the certificate, phase 3d) as the Railway database goes through it: 0000–0008 applied, a contact course and an e-course
// with a completed access, all written by the live code (which knows none of 0009's columns), then 0009. Every course gets no certificate
// lines and no volume, and the new table is there, empty, with its rules: one certificate per access, one per number and one per year and
// number, the number from 1, the access required, and the account's deletion takes the access and its certificate with it. A rule that
// fails is checked by the name of the constraint in the database's own error, so that another failure cannot pass for it.

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0009 gives every course no certificate lines and no volume, and adds certificates with their rules, deleted with the access", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0008_ecourse_completion");
  // the live code's rows (raw SQL: drizzle would name the columns 0009 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group, outcomes) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000, '[{"et":"Kulmude kuju"}]')`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price) values ('e', 'e_learning', 'basic', '{"et":"E"}', '{"et":""}', '{"et":""}', 9900)`);
  const id = Object.fromEntries((await db.select({ id: courses.id, slug: courses.slug }).from(courses)).map((c) => [c.slug, c.id]));
  await db.execute(sql`insert into clients (email) values ('kati@example.test'), ('mari@example.test')`);
  const who = Object.fromEntries((await db.select({ id: clients.id, email: clients.email }).from(clients)).map((c) => [c.email, c.id]));
  await db.execute(
    sql`insert into course_access (client_id, course_id, granted_by, expires_at, completed_at) values (${who["kati@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', '2026-10-14T10:00:00Z'), (${who["mari@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', null)`,
  );
  const access = Object.fromEntries((await db.select({ id: courseAccess.id, clientId: courseAccess.clientId }).from(courseAccess)).map((a) => [a.clientId, a.id]));

  await through("0009_certificates");

  // what was there: each course gets no certificate lines and no volume; its outcomes stay as they were
  expect(await db.select({ slug: courses.slug, outcomes: courses.outcomes, skills: courses.certificateSkills, volume: courses.certificateVolume }).from(courses).orderBy(courses.slug)).toEqual([
    { slug: "e", outcomes: [], skills: [], volume: "" },
    { slug: "k", outcomes: [{ et: "Kulmude kuju" }], skills: [], volume: "" },
  ]);
  expect(await db.select().from(certificates)).toEqual([]);

  // a certificate: the frozen copy, the volume empty by default, no re-issue yet, its creation stamped
  const kati = access[who["kati@example.test"]];
  const copy = {
    number: "MS LAB 2026-03", year: 2026, seq: 3, name: "Kati Kask", courseTitle: "E", skills: ["Kulmude kuju"],
    practicalLine: "Praktiline töö", place: "Pärnu linn", registryCode: "16346048", issuedAt: new Date("2026-10-15T09:00:00Z"),
  };
  const [first] = await db.insert(certificates).values({ accessId: kati, ...copy }).returning();
  expect(first).toMatchObject({ accessId: kati, ...copy, volume: "", reissuedAt: null });
  expect(first.createdAt).toBeInstanceOf(Date);

  // one per access, one per number, one per year and number; the number from 1; the access must exist
  const mari = access[who["mari@example.test"]];
  await violates(db.insert(certificates).values({ ...copy, accessId: kati, number: "MS LAB 2026-04", seq: 4 }), "certificates_access");
  await violates(db.insert(certificates).values({ ...copy, accessId: mari, seq: 4 }), "certificates_number");
  await violates(db.insert(certificates).values({ ...copy, accessId: mari, number: "MS LAB 2026-3" }), "certificates_year_seq");
  await violates(db.insert(certificates).values({ ...copy, accessId: mari, number: "MS LAB 2026-00", seq: 0 }), "certificates_seq_positive");
  await violates(db.insert(certificates).values({ ...copy, accessId: 999_999, number: "MS LAB 2026-04", seq: 4 }), "certificates_access_id_course_access_id_fk");
  // the same number in another year is another certificate
  await db.insert(certificates).values({ ...copy, accessId: mari, number: "MS LAB 2027-03", year: 2027, volume: "10 akadeemilist tundi" });

  // the account's deletion takes the access and its certificate; the other one stays
  await db.delete(clients).where(eq(clients.id, who["kati@example.test"]));
  expect((await db.select({ number: certificates.number }).from(certificates)).map((c) => c.number)).toEqual(["MS LAB 2027-03"]);
});
