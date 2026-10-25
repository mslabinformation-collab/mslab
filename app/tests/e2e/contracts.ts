import type postgres from "postgres";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, snapshotRows } from "./fixtures";

// What the contract specs share (contracts Task 7): the turn at the contact course's contract text, which Maria writes in Seaded.

/** The Postgres advisory lock every test that writes the contact contract's text holds. */
const TEXTS_LOCK = "e2e-contract-texts";

/**
 * Takes the contact contract's text for one test (contracts, spec D2). The text (the `contract_contact` page) and its version (the
 * `contractContactVersion` setting) are shared by every registration form of the site: a form sends the version it showed (ruling R6), and a
 * save between its page and its submit would be refused. The two edit specs that write the text (contracts.spec.ts, admin-site.spec.ts) run side
 * by side under `next dev`, so they take turns, the lock first and then the two rows saved for putting back. The wait for the turn is added to
 * the test's own time. Returns the function that puts the rows back and lets the lock go: call it after the test, also when it failed.
 */
export async function holdContractTexts(info: { setTimeout(ms: number): void; timeout: number }): Promise<() => Promise<void>> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const unlock = await holdLocalLock(TEXTS_LOCK);
  const restores: (() => Promise<void>)[] = [];
  try {
    restores.push(await snapshotRows("pages", { column: "key", value: "contract_contact" }));
    restores.push(await snapshotRows("settings", { column: "key", value: "contractContactVersion" }));
  } catch (e) {
    for (const restore of restores.splice(0).reverse()) await restore().catch(() => {});
    await unlock();
    throw e;
  }
  return async () => {
    try {
      for (const restore of restores.splice(0).reverse()) await restore();
    } finally {
      await unlock();
    }
  };
}

/** Each legal text's draft row in `content_drafts` (entity "legal": server/legal-drafts.ts LEGAL_IDS, ruling R-d of admin UX pass piece 3b). */
const LEGAL_IDS = { privacy: 1, terms: 2, course_terms: 3, contract_contact: 4 } as const;
type DraftRow = { id: number; entity: string; entity_id: number; part: string; value: unknown; base_version: string; version: number; updated_at: Date; updated_by: string };

/**
 * Takes a legal text's draft out of the way for one test (admin UX pass piece 3b, Task 5: Seaded's legal cards type into drafts and publish them):
 * the draft as it is now (one left by hand on the local database) is kept and deleted, so the card starts from the live text; the function returned
 * deletes whatever draft the test left (a test that failed before its publish) and writes the kept one back. Call it after the test, also when it
 * failed. The live text itself is the caller's to put back (holdContractTexts, a rows snapshot).
 */
export async function holdLegalDraft(key: keyof typeof LEGAL_IDS): Promise<() => Promise<void>> {
  const id = LEGAL_IDS[key];
  const kept = await onLocalDb(
    async (sql) => {
      const rows = await sql<DraftRow[]>`select * from content_drafts where entity = 'legal' and entity_id = ${id}`;
      await sql`delete from content_drafts where entity = 'legal' and entity_id = ${id}`;
      return rows;
    },
    { marksPages: false },
  );
  return () =>
    onLocalDb(
      async (sql) => {
        await sql`delete from content_drafts where entity = 'legal' and entity_id = ${id}`;
        for (const r of kept)
          await sql`
            insert into content_drafts (id, entity, entity_id, part, value, base_version, version, updated_at, updated_by)
            values (${r.id}, ${r.entity}, ${r.entity_id}, ${r.part}, ${sql.json(r.value as postgres.JSONValue)}, ${r.base_version}, ${r.version}, ${r.updated_at}, ${r.updated_by})`;
      },
      { marksPages: false },
    );
}

/** The legal draft of `key` as stored now (null: none), for a test that checks that typing saved only there. */
export async function legalDraftOf(key: keyof typeof LEGAL_IDS): Promise<{ value: { title: { et: string; ru: string }; body: { et: string; ru: string } } } | null> {
  const [row] = await onLocalDb((sql) => sql<{ value: { title: { et: string; ru: string }; body: { et: string; ru: string } } }[]>`select value from content_drafts where entity = 'legal' and entity_id = ${LEGAL_IDS[key]}`, { marksPages: false });
  return row ?? null;
}

/**
 * A frozen contact contract of a registration written straight to the LOCAL database (contracts.ts is the app's; this is a row as an earlier
 * acceptance left it): `via` the way it was accepted (default the registration form's box), `title` its title, accepted `days` ago. It is the
 * registration's current contract unless one of the rows below supersedes it. The student is `email`/`name`, the school an invented one.
 */
export async function insertContract(
  registration: { id: number; courseId: number; clientId: number | null },
  student: { name: string; email: string },
  over: { title?: string; via?: string; days?: number } = {},
): Promise<number> {
  const fields = { school: { company: "E2E OÜ", registryCode: "", address: "" }, student, course: "E2E koolitus", session: "", price: "350,00 €", payment: "" };
  const [row] = await onLocalDb(
    (sql) =>
      sql<{ id: number }[]>`
        insert into contracts (kind, registration_id, course_id, client_id, version, locale, title, body, fields, accepted_at, accepted_via)
        values ('contact', ${registration.id}, ${registration.courseId}, ${registration.clientId}, 'e2e-old', 'et', ${over.title ?? "E2E vana leping"}, 'E2E vana tekst.', ${sql.json(fields)},
                now() - ${`${over.days ?? 3} days`}::interval, ${over.via ?? "form"})
        returning id`,
    { marksPages: false },
  );
  return row.id;
}
