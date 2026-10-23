import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseAccess, courseTests } from "@/db/schema";
import { at, attempt, ecourse, practical, student, tabsOf } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Hindamine (e-course completion, spec §5.2, §5.4) and the overview's „Ootab hindamist“ row of „Sinu järjekord“ (R4, A1), rendered from a real (PGlite) database to
// HTML: the one list (A4) with its rows and their ways on, "Hindamist ootavaid töid pole." when nothing waits, the test review of one attempt (its own copy
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

/** One row of Hindamine's list: its markup, and its text with a bar between the parts. */
const rowOf = (page: string, key: string) => {
  const inner = new RegExp(`<li [^>]*data-queue-row="${key}"[^>]*>([\\s\\S]*?)</li>`).exec(page)?.[1];
  expect(inner, `the row ${key}`).toBeDefined();
  return { html: inner!, text: inner!.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "") };
};
const rowKeys = (page: string) => [...page.matchAll(/<li [^>]*data-queue-row="([^"]+)"/g)].map((m) => m[1]);

test("nothing waits: Hindamine says 'Hindamist ootavaid töid pole.' under its tabs, and the overview's queue has no „Ootab hindamist“ row", async () => {
  const page = await html(AssessmentPage());
  expect(page).toContain("Hindamist ootavaid töid pole.");
  expect(page).not.toContain("Kõik on hinnatud.");
  expect(rowKeys(page)).toEqual([]);
  expect(tabsOf(page)).toEqual([
    { href: "/admin/hindamine", text: "Ootab hindamist 0", current: true },
    { href: "/admin/tunnistused", text: "Tunnistused", current: false },
  ]);
  expect(await html(Overview())).not.toContain('data-overview-row="assessment"');
});

test("one list, each row „{name} · {what}“ with its meta and its ways on; the first tab counts the rows, and the overview's „Ootab hindamist“ row counts them (spec §5.2, R4, A4)", async () => {
  const anu = await student(db, course.id, "Anu");
  await practical(db, anu, 2, 1, at(8));
  const eve = await student(db, course.id, "Eve");
  const waiting = await attempt(db, eve, course.id, 1, "review", at(7));
  const gea = await student(db, course.id, "Gea");
  for (const n of [1, 2]) await attempt(db, gea, course.id, n, "failed", at(n), { correct: n === 1 ? 1 : 0 });

  const page = await html(AssessmentPage());
  // (19.10.2026 is in summer time: 8 o'clock UTC is 11:00 in Tallinn)
  const practicalRow = rowOf(page, `practical-${anu.access.id}`);
  expect(practicalRow.text).toBe("Anu · praktiline töö|2. kord · 19.10 11:00|Hinda");
  expect(practicalRow.html).toContain(`href="/admin/protokollid?ligipaas=${anu.access.id}"`);
  expect(practicalRow.html).not.toContain("secondary"); // „Hinda“ is the ink button
  const testRow = rowOf(page, `test-${waiting.id}`);
  expect(testRow.text).toBe("Eve · testi vastus|katse 1/2 · 19.10 10:00|Vaata");
  expect(testRow.html).toContain(`href="/admin/hindamine/test?id=${waiting.id}"`);
  const triesRow = rowOf(page, `triesUsed-${gea.access.id}`);
  expect(triesRow.text).toBe("Gea · katsed otsas|parim tulemus 50 % · katseid 2|Testi katsed|Ava test uuesti");
  expect(triesRow.html).toContain(`href="/admin/hindamine/test?ligipaas=${gea.access.id}"`);
  expect(triesRow.html).toContain('data-reopen=""');
  // (the three groups, their headings, the course and "saadetud" are gone; so is the register's header button)
  for (const gone of ["Praktilised tööd", "Testi vastused", "Katsed otsas", "Kulmumeistri e-koolitus", "saadetud", "Vaata vastuseid", "Väljastatud tunnistused", "data-to-register", "Hindamist ootavaid töid pole.", "Kõik on hinnatud."]) {
    expect(page, gone).not.toContain(gone);
  }
  expect(tabsOf(page)[0]).toEqual({ href: "/admin/hindamine", text: "Ootab hindamist 3", current: true });

  const row = /<a [^>]*data-overview-row="assessment"[^>]*>[\s\S]*?<\/a>/.exec(await html(Overview()))![0];
  expect(row).toContain('href="/admin/hindamine"');
  expect(row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("3 Ootab hindamist 1 praktiline töö · 1 testi vastus · 1 katsed otsas");
});

test("the list is oldest first by when each began to wait, whatever its kind; a student out of tries waits since her last attempt", async () => {
  const anu = await student(db, course.id, "Anu");
  await practical(db, anu, 1, null, at(9));
  const eve = await student(db, course.id, "Eve");
  const waiting = await attempt(db, eve, course.id, 1, "review", at(8));
  const gea = await student(db, course.id, "Gea");
  await attempt(db, gea, course.id, 1, "failed", at(1), { correct: 0 });
  await attempt(db, gea, course.id, 2, "failed", at(7), { correct: 0 });
  const dora = await student(db, course.id, "Dora");
  await practical(db, dora, 1, null, at(6));
  expect(rowKeys(await html(AssessmentPage()))).toEqual([`practical-${dora.access.id}`, `triesUsed-${gea.access.id}`, `test-${waiting.id}`, `practical-${anu.access.id}`]);
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
