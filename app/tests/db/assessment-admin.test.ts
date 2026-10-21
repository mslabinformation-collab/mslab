import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseAccess, courseTests } from "@/db/schema";
import { at, attempt, ecourse, practical, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Hindamine (e-course completion, spec §5.2, §5.4) and the overview's "Ootab hindamist" card (R4), rendered from a real (PGlite) database to
// HTML: the three groups with their rows and their ways on, "Kõik on hinnatud." when nothing waits, the test review of one attempt (its own copy
// of the questions: Review Focus 3), every attempt of a student, and "not found". The server actions are stand-ins (they need a
// browser or a request); the menu counts are the real ones.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test", adminName: () => "Maria" }));
vi.mock("@/components/admin/data", async () => {
  const { adminCounts } = await import("@/db/queries/admin");
  return { getAdminCounts: async (email: string) => adminCounts(state.db as Db, email, new Date()) };
});
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));

import Overview from "@/app/admin/(panel)/page";
import AssessmentPage from "@/app/admin/(panel)/hindamine/page";
import TestReviewPage from "@/app/admin/(panel)/hindamine/test/page";

const html = async (page: Promise<React.ReactElement>) => renderToStaticMarkup(await page);
const review = (search: Record<string, string | undefined>) => html(TestReviewPage({ searchParams: Promise.resolve(search) }));
/** The HTML from `attribute="value"` to the next element carrying the same attribute (or the end). */
const part = (text: string, attribute: string, value: string | number) => {
  const from = text.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = text.indexOf(`${attribute}="`, from + 1);
  return text.slice(from, next === -1 ? undefined : next);
};

let db: Db;
let course: { id: number };

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  course = await ecourse(db);
});

test("nothing waits: Hindamine says 'Kõik on hinnatud.', and the overview has no 'Ootab hindamist' card", async () => {
  const page = await html(AssessmentPage());
  expect(page).toContain("Kõik on hinnatud.");
  expect(page).not.toContain("data-queue=");
  expect(await html(Overview())).not.toContain("data-overview-assessment");
});

test("the three groups, each row with its way on; the overview's card counts them (spec §5.2, R4)", async () => {
  const anu = await student(db, course.id, "Anu");
  await practical(db, anu, 2, 1, at(8));
  const eve = await student(db, course.id, "Eve");
  const waiting = await attempt(db, eve, course.id, 1, "review", at(7));
  const gea = await student(db, course.id, "Gea");
  for (const n of [1, 2]) await attempt(db, gea, course.id, n, "failed", at(n), { correct: n === 1 ? 1 : 0 });

  const page = await html(AssessmentPage());
  const practicals = part(page, "data-queue", "practicals");
  for (const text of ["Praktilised tööd", "Anu", "Kulmumeistri e-koolitus", "2. kord", "saadetud 19.10.2026"]) expect(practicals, text).toContain(text);
  expect(practicals).toContain(`href="/admin/protokollid?ligipaas=${anu.access.id}"`);
  const tests = part(page, "data-queue", "tests");
  for (const text of ["Testi vastused", "Eve", "Katse 1/2"]) expect(tests, text).toContain(text);
  expect(tests).toContain(`href="/admin/hindamine/test?id=${waiting.id}"`);
  const tries = part(page, "data-queue", "tries");
  for (const text of ["Katsed otsas", "Gea", "parim tulemus 50 %", "katseid 2", "Ava test uuesti"]) expect(tries, text).toContain(text);
  expect(tries).toContain(`href="/admin/hindamine/test?ligipaas=${gea.access.id}"`);
  expect(page).not.toContain("Kõik on hinnatud.");

  const card = part(await html(Overview()), "data-overview-assessment", "");
  expect(card).toContain("Ootab hindamist: 3");
  expect(card).toContain('href="/admin/hindamine"');
  expect(part(card, "data-overview-assessment-group", "practicals")).toContain(">1<");
});

test("Review Focus 3: the review of an attempt made before Maria changed the test shows the attempt's copy, its picks against that copy's key, and the form", async () => {
  const eve = await student(db, course.id, "Eve");
  const a = await attempt(db, eve, course.id, 1, "review", at(7));
  await db.update(courseTests).set({ questions: [{ id: "uus00001", kind: "open", text: "Uus küsimus pärast katset" }] }).where(eq(courseTests.courseId, course.id));
  const page = await review({ id: String(a.id) });
  expect(page).toContain("Mitu korda pesta pintslit?");
  expect(page).not.toContain("Uus küsimus pärast katset");
  expect(page).toContain("Valikküsimused: 50 % (vaja 80 %)");
  expect(page).toContain(`data-review-form="${a.id}"`);
  expect(part(page, "data-review-question", "qvalik01")).toContain('data-review-right="true"');
  expect(part(page, "data-review-question", "qvalik02")).toContain('data-review-right="false"');
  const wrongPick = part(page, "data-review-option", "o2vale01");
  expect(wrongPick).toContain('data-picked="true"');
  expect(wrongPick).not.toContain("data-correct");
  expect(part(page, "data-review-answer", "qavatud1")).toContain("Puhastan pintsli.");
  expect(page).toContain(`href="/admin/hindamine/test?ligipaas=${eve.access.id}"`);
});

test("?ligipaas=: every attempt of hers, newest first, each with its result and its link; an attempt already reviewed is read-only", async () => {
  const gea = await student(db, course.id, "Gea");
  const first = await attempt(db, gea, course.id, 1, "failed", at(2), { correct: 0 });
  const second = await attempt(db, gea, course.id, 2, "fix", at(3), { correct: 2, review: { qavatud1: { verdict: "fix", comment: "Lisa samm." } } });
  const page = await review({ ligipaas: String(gea.access.id) });
  expect(page).toContain(`data-attempts="${gea.access.id}"`);
  expect([...page.matchAll(/data-attempt="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([second.id, first.id]);
  expect(part(page, "data-attempt", second.id)).toContain("Parandamisel");
  expect(part(page, "data-attempt", first.id)).toContain("Läbimata");
  expect(part(page, "data-attempt", first.id)).toContain("0 %");
  expect(part(page, "data-attempt", first.id)).toContain(`href="/admin/hindamine/test?id=${first.id}"`);
  const fixed = await review({ id: String(second.id) });
  expect(fixed).not.toContain("data-review-form");
  expect(fixed).toContain(`data-review-readonly="${second.id}"`);
  expect(part(fixed, "data-review-answer", "qavatud1")).toContain("Lisa samm.");
});

test("not found: no such attempt, an id that is no id, nothing asked, an access an admin ended", async () => {
  for (const search of [{ id: "999999" }, { id: "abc" }, {}]) expect(await review(search), JSON.stringify(search)).toContain("Seda katset ei leitud.");
  const eve = await student(db, course.id, "Eve");
  const a = await attempt(db, eve, course.id, 1, "review", at(7));
  await db.update(courseAccess).set({ revokedAt: at(9) }).where(eq(courseAccess.id, eve.access.id));
  expect(await review({ id: String(a.id) })).toContain("Seda katset ei leitud.");
  expect(await review({ ligipaas: String(eve.access.id) })).toContain("Selle õpilase teste ei leitud.");
});
