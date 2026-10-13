import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { clientEmail, signInAsClient } from "./account";
import type { CreatedRows } from "./admin-login";
import { accountCourseSlug, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { LOCAL_URL, PROD_BUILD, TARGET } from "./target";
import { expect, submitsForms, test } from "./test";

// The protocols' e2e rows (phase protocols): a contact course of the test's own, not published, with Maria's headings and one session; its
// students' confirmed group registrations, without an account (a send, or her first login, makes it). Every address is
// `e2e-client-proto-<label>[-n]-<project>@example.test`: a sample address (never mailed) that fixtures.ts removeClientRows removes with
// everything it made, and the course's slug is the first student's (accountCourseSlug), so it goes too. Nothing here is on a public page.

const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

/** The name a test's addresses carry: its project, and its repeat of a --repeat-each run (those run side by side, on the same rows otherwise). */
export const runName = (info: TestInfo): string => `${info.project.name}${info.repeatEachIndex ? `-r${info.repeatEachIndex}` : ""}`;

export const E2E_HEADINGS = ["Ettevalmistus", "Kulmude analüüs", "Värvimine"];

export type ProtocolFixtures = { course: { id: number; slug: string }; session: { id: number }; students: { id: number; name: string; email: string }[] };

/**
 * The course "E2E protokollikoolitus" with `headings` (default E2E_HEADINGS) and its session, which starts at 10:00 Tallinn time `day` days
 * from today (default 0: today), and one confirmed group registration per name, the first name's address naming the course. Leftovers of the
 * same addresses are removed first.
 */
export async function insertProtocolFixtures(label: string, project: string, names: string[], opts: { headings?: string[]; day?: number } = {}): Promise<ProtocolFixtures> {
  const emails = names.map((_, i) => clientEmail(i === 0 ? `proto-${label}` : `proto-${label}-${i + 1}`, project));
  for (const email of emails) await removeClientRows(email);
  const slug = accountCourseSlug(emails[0]);
  return localDb(async (sql) => {
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price_group, price_individual, published, protocol_stages)
      values (${slug}, 'contact', 'basic', ${sql.json({ et: "E2E protokollikoolitus", ru: "E2E обучение с протоколом" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })},
              35000, 45000, false, ${sql.json(opts.headings ?? E2E_HEADINGS)})
      returning id`;
    const [session] = await sql<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      values (${course.id}, (date_trunc('day', now() at time zone 'Europe/Tallinn') + make_interval(days => ${opts.day ?? 0}::int, hours => 10)) at time zone 'Europe/Tallinn',
              'Pärnu', 'MS LAB stuudio', 6)
      returning id`;
    const students: ProtocolFixtures["students"] = [];
    for (const [i, name] of names.entries()) {
      const [r] = await sql<{ id: number }[]>`
        insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status, paid_cents)
        values (${course.id}, ${session.id}, 'group', ${name}, ${emails[i]}, '+372 5555 0101', 'full', 'confirmed', 35000)
        returning id`;
      students.push({ id: r.id, name, email: emails[i] });
    }
    return { course: { id: course.id, slug }, session: { id: session.id }, students };
  });
}

/**
 * What the protocol specs that sign in as Maria share (protocols.spec.ts, protocols-autosave.spec.ts); call it once at the top of the spec file.
 * Registers the hooks of the file: every test runs only against the local server (submitsForms), has 3 minutes (the first view of each page under
 * `next dev` compiles it; the retries wait seconds), and after each test the rows of every student `fixtures()` made and Maria's login rows
 * (`created`, for signInAsAdmin) are removed.
 */
export function protocolRows(): { created: CreatedRows; fixtures: (...args: Parameters<typeof insertProtocolFixtures>) => Promise<ProtocolFixtures> } {
  const made = new Set<string>();
  const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
  test.beforeEach(() => {
    submitsForms();
    test.setTimeout(180_000);
  });
  test.afterEach(async () => {
    for (const email of made) await removeClientRows(email);
    made.clear();
    await removeAdminRows(created).catch(() => {});
    created.tokens.clear();
    created.sessions.clear();
  });
  return {
    created,
    fixtures: async (...args) => {
      const fx = await insertProtocolFixtures(...args);
      for (const s of fx.students) made.add(s.email);
      return fx;
    },
  };
}

/** The autosave route, as a route pattern. */
export const SAVE_ROUTE = "**/api/admin/protokoll";

/** `n` stages with an empty note, for toMatchObject on a stored protocol. */
export const emptyNotes = (n: number) => Array.from({ length: n }, () => expect.objectContaining({ note: "" }));

type Stage = { title: string; note: string };

/** A protocol Maria has sent (version 1, its frozen copy the same): the student's page shows it, and her feedback form opens. */
export async function insertSentProtocol(registrationId: number, notes: string[], generalNote: string): Promise<void> {
  const stages: Stage[] = E2E_HEADINGS.map((title, i) => ({ title, note: notes[i] ?? "" }));
  await localDb(
    (sql) => sql`
      insert into protocols (registration_id, stages, general_note, version, sent, sent_at, sent_version)
      values (${registrationId}, ${sql.json(stages)}, ${generalNote}, 1, ${sql.json({ stages, generalNote })}, now(), 1)`,
  );
}

/** A protocol Maria has written but not sent (a draft, version 1): the confirmation of "Lukusta ja saada kõik" lists its student. */
export async function insertDraftProtocol(registrationId: number, notes: string[], generalNote: string): Promise<void> {
  const stages: Stage[] = E2E_HEADINGS.map((title, i) => ({ title, note: notes[i] ?? "" }));
  await localDb((sql) => sql`insert into protocols (registration_id, stages, general_note, version) values (${registrationId}, ${sql.json(stages)}, ${generalNote}, 1)`);
}

/** An answered feedback form (for a page that lists one). */
export async function insertFeedbackAnswer(registrationId: number, answers: Record<string, string | number>): Promise<void> {
  await localDb((sql) => sql`insert into course_feedback (registration_id, answers, locale, submitted_at) values (${registrationId}, ${sql.json(answers)}, 'et', now())`);
}

export type StoredProtocol = { version: number; stages: Stage[]; generalNote: string; sent: { stages: Stage[]; generalNote: string } | null; sentAt: Date | null; sentVersion: number | null };

/** The registration's protocol as stored, or null when there is none. */
export async function storedProtocol(registrationId: number): Promise<StoredProtocol | null> {
  const [row] = await localDb(
    (sql) => sql<StoredProtocol[]>`
      select version, stages, general_note as "generalNote", sent, sent_at as "sentAt", sent_version as "sentVersion" from protocols where registration_id = ${registrationId}`,
  );
  return row ?? null;
}

export type StoredFeedback = { id: number; answers: Record<string, unknown> | null; locale: string | null; submitted: boolean; dismissed: boolean };

/** The registration's feedback row, or null when there is none. */
export async function storedFeedback(registrationId: number): Promise<StoredFeedback | null> {
  const [row] = await localDb(
    (sql) => sql<StoredFeedback[]>`
      select id, answers, locale, submitted_at is not null as submitted, dismissed_at is not null as dismissed from course_feedback where registration_id = ${registrationId}`,
  );
  return row ?? null;
}

/** The student's own browser (another context from Maria's, as she would have), not signed in; `who` tells her visitor address from the test's. */
export async function studentContext(browser: Browser, ip: string, who = "student"): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: TARGET || LOCAL_URL, extraHTTPHeaders: { "x-forwarded-for": `${ip}-${who}` } });
  // (the production build's cached pages: the browser's own HTTP cache is left out of it, as the visitorIp fixture does for the main context)
  if (PROD_BUILD) await context.route("**/*", (route) => route.fallback());
  return context;
}

/** The student's own browser, signed in, on her dashboard. */
export async function studentPage(browser: Browser, email: string, ip: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await studentContext(browser, ip);
  const page = await context.newPage();
  await signInAsClient(page, email);
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  return { page, close: () => context.close() };
}

// ---------- the protocol screen's parts (ProtocolScreen.tsx) ----------

export const editor = (page: Page, id: number) => page.locator(`[data-editor="${id}"]`);
export const chip = (page: Page, id: number) => page.locator(`[data-student="${id}"]`);
export const note = (page: Page, id: number, i: number) => editor(page, id).locator(`[data-note="${i}"]`);
export const general = (page: Page, id: number) => editor(page, id).locator("[data-general]");
export const saveStatus = (page: Page, id: number) => editor(page, id).locator("[data-save-status]");
/** The autosave has confirmed this student's text (the debounce is 1.5 s; a retry can be 20 s away). */
export const saved = (page: Page, id: number) => expect(saveStatus(page, id)).toHaveAttribute("data-save-status", "saved", { timeout: 40_000 });
/**
 * Every key this browser keeps for ONE protocol (the copy, the texts sent without an answer, the notice: protocol-autosave.ts localKey / sentKey /
 * conflictKey): `<prefix>:<id>` or `<prefix>:<id>:<tab>`, so protocol 1 never matches 12.
 */
export const keptKeys = (page: Page, id: number) =>
  page.evaluate(
    (n) =>
      Object.keys(localStorage).filter((k) =>
        ["mslab-protocol", "mslab-protocol-sent", "mslab-protocol-conflict"].some((prefix) => k === `${prefix}:${n}` || k.startsWith(`${prefix}:${n}:`)),
      ),
    id,
  );
/** The first box's text in every copy this browser keeps of ONE protocol (one per tab; a test has one). */
export const keptTexts = (page: Page, id: number) =>
  page.evaluate(
    (n) =>
      Object.entries(localStorage)
        .filter(([k]) => k === `mslab-protocol:${n}` || k.startsWith(`mslab-protocol:${n}:`))
        .map(([, v]) => (JSON.parse(v) as { content: { notes: string[] } }).content.notes[0]),
    id,
  );

/**
 * Holds the protocol screen's read of the server's text: the GET /api/admin/protokoll?… request it makes when it is shown (keepReading) waits once
 * `arm()` was called, until `release()`. A screen the browser's Back restores is the visit's old render until that answer comes: this keeps it in
 * that state for as long as a test needs. The saves (POST, no query) and every other request pass. `held` counts the requests held.
 */
export async function holdRefresh(page: Page): Promise<{ arm(): void; release(): void; held(): number }> {
  let armed = false;
  let count = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  await page.route(/\/api\/admin\/protokoll\?/, async (route) => {
    if (armed && route.request().method() === "GET") {
      count++;
      await gate;
    }
    await route.continue().catch(() => {}); // (a page that went meanwhile)
  });
  return { arm: () => void (armed = true), release: () => open(), held: () => count };
}
