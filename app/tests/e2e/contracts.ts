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
