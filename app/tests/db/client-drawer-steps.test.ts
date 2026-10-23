import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseAccess, courseModules, courses, courseSessions, courseTests, lessonProgress, lessons, protocols, registrations, testAttempts } from "@/db/schema";
import { makeTestDb } from "./helpers";

// The Õpilased drawer's cards (e-course completion, spec §5.5; admin UX pass A5), rendered from a real (PGlite) database to HTML: the step line as her own
// page reads her steps (P-7: no colons; the phone's shorter line beside it), "Hinda" once work waits for Maria and "Ava test uuesti" while her tries are used
// up, the pill — "Avatud kuni …", "Läbitud …" with its day, "Ligipääs lõppes …", "Ligipääs lõpetatud …" —, nothing to open on an access an admin ended, and the
// contact registrations' own "Lisa protokoll" / "Ava protokoll". (What is under "Veel ▾" — the protocol, "Testi katsed" … — opens on a click: client-drawer-dom.test.ts.)
// The server actions are stand-ins (they need a request).

vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));

import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const NOW = new Date("2026-10-20T09:00:00Z");
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
const QUESTION = { id: "qvalik01", kind: "choice" as const, text: "Üks?", options: [{ id: "o1oige01", text: "Jah", correct: true }, { id: "o1vale01", text: "Ei", correct: false }] };

let db: Db;
let veeb: { id: number };
let lesson: { one: number; two: number };
let kontakt: { id: number; sessionId: number };

beforeEach(async () => {
  db = await makeTestDb();
  // an e-course of two lessons with a test (two tries) and two points; a contact course with one session
  [veeb] = await db.insert(courses).values({ ...base, slug: "veeb", type: "e_learning", title: { et: "Veebikoolitus" }, protocolStages: ["Ettevalmistus", "Värvimine"] }).returning();
  await db.insert(courseTests).values({ courseId: veeb.id, questions: [QUESTION], passPercent: 80, tries: 2 });
  const [m] = await db.insert(courseModules).values({ courseId: veeb.id, position: 1, title: { et: "M" } }).returning();
  const [l1] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Üks" } }).returning();
  const [l2] = await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "Kaks" } }).returning();
  lesson = { one: l1.id, two: l2.id };
  const [k] = await db.insert(courses).values({ ...base, slug: "kontakt", type: "contact", title: { et: "Kulmude lamineerimine" }, priceGroup: 35000 }).returning();
  const [s] = await db.insert(courseSessions).values({ courseId: k.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" }).returning();
  kontakt = { id: k.id, sessionId: s.id };
});

/** Kati with access to the e-course (`over` replaces fields of the access). */
async function kati(over: Partial<typeof courseAccess.$inferInsert> = {}) {
  const [client] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: client.id, courseId: veeb.id, grantedBy: "maria@example.test", expiresAt: new Date("2027-04-20T20:59:59.999Z"), ...over }).returning();
  return { client, access };
}
const lessonDone = (clientId: number, lessonId: number) => db.insert(lessonProgress).values({ clientId, lessonId, watchedSec: 100, doneAt: NOW });
const failedAttempt = (clientId: number, number: number) =>
  db.insert(testAttempts).values({ clientId, courseId: veeb.id, number, questions: [QUESTION], answers: { qvalik01: ["o1vale01"] }, correct: 0, total: 1, status: "failed", submittedAt: NOW });
const drawer = async (clientId: number) => renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId, NOW))!, ecourses: [], now: NOW }));
/** The HTML from `attribute="value"` to the next element carrying the same attribute (or the end). */
const part = (html: string, attribute: string, value: string | number) => {
  const from = html.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attribute}="`, from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};

test("an e-course's line, as she stands (the phone's line beside it); 'Hinda' only once work waits; 'Ava test uuesti' once her tries are used up", async () => {
  const { client, access } = await kati();
  await lessonDone(client.id, lesson.one);
  let row = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(row, "data-access-steps", "")).toContain("Õppetunnid 1/2 · Test lukus · Praktiline töö lukus");
  expect(part(row, "data-access-steps", "")).toContain("1/2 · test lukus · praktiline lukus");
  expect(row).not.toContain("data-access-assess");
  expect(row).not.toContain('data-reopen=""');

  await lessonDone(client.id, lesson.two);
  for (const n of [1, 2]) await failedAttempt(client.id, n);
  await db.insert(protocols).values({ accessId: access.id, stages: [{ title: "Ettevalmistus", note: "Alusta puhastusest." }, { title: "Värvimine", note: "" }] });
  row = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(row, "data-access-steps", "")).toContain("Õppetunnid 2/2 · Test katsed otsas (0 %) · Praktiline töö lukus");
  expect(part(row, "data-access-steps", "")).toContain("2/2 · test katsed otsas · praktiline lukus");
  expect(row).toContain('data-reopen=""');
  expect(row).toContain("Ava test uuesti");
  expect(row).not.toContain("data-access-assess");
});

test("'Hinda' when the practical work waits (her protocol screen) or the test's open answers wait (that attempt); the practical work first", async () => {
  const { client, access } = await kati();
  const stages = [{ title: "Ettevalmistus", note: "" }, { title: "Värvimine", note: "" }];
  // the test has an open question: her attempt waits for Maria
  const open = { id: "qavatud1", kind: "open" as const, text: "Kirjelda." };
  const [attempt] = await db
    .insert(testAttempts)
    .values({ clientId: client.id, courseId: veeb.id, number: 1, questions: [open], answers: { qavatud1: "Nii." }, correct: 0, total: 0, status: "review", submittedAt: NOW })
    .returning();
  let row = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(row, "data-access-assess", "")).toContain(`href="/admin/hindamine/test?id=${attempt.id}"`);
  expect(part(row, "data-access-assess", "")).toContain("Hinda");
  // and her practical work was sent too: it comes first
  await db.insert(protocols).values({ accessId: access.id, stages, verdicts: [null, null], round: 1, submittedAt: NOW });
  row = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(row, "data-access-assess", "")).toContain(`href="/admin/protokollid?ligipaas=${access.id}"`);
  expect(row.match(/data-access-assess/g)).toHaveLength(1);
});

test("the pill: a completed course says 'Läbitud' with its day (and has no step line); an access an admin ended 'Ligipääs lõpetatud' and has nothing to open", async () => {
  const { client, access } = await kati({ completedAt: new Date("2026-11-14T10:00:00Z") });
  const row = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(row, "data-access-pill", "")).toContain("Läbitud 14.11.2026");
  expect(row).toContain('data-access-state="active"');
  expect(row).not.toContain("data-access-steps");
  expect(row).not.toContain("Õppetunnid");
  expect(row).toContain("data-access-actions");
  await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, access.id));
  const ended = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(ended, "data-access-pill", "")).toContain("Ligipääs lõpetatud 20.10.2026");
  expect(ended).toContain('data-access-state="revoked"');
  expect(ended).not.toContain("Läbitud");
  expect(ended).not.toContain("data-access-actions");
  expect(ended).not.toContain("data-extend");
  expect(ended).not.toContain("data-access-assess");
  expect(ended).not.toContain("data-reopen");
});

test("the pill of an access that ran out by date says 'Ligipääs lõppes …' (S3-h), with 'Pikenda ▾' beside it; one that ran out after the course was completed still says 'Läbitud'", async () => {
  const { client, access } = await kati({ expiresAt: new Date("2026-09-30T20:59:59.999Z") });
  let row = part(await drawer(client.id), "data-access", veeb.id);
  expect(row).toContain('data-access-state="expired"');
  expect(part(row, "data-access-pill", "")).toContain("Ligipääs lõppes 30.09.2026");
  expect(row).toContain("data-extend");
  await db.update(courseAccess).set({ completedAt: new Date("2026-09-20T10:00:00Z") }).where(eq(courseAccess.id, access.id));
  row = part(await drawer(client.id), "data-access", veeb.id);
  expect(part(row, "data-access-pill", "")).toContain("Läbitud 20.09.2026");
  expect(part(row, "data-access-pill", "")).not.toContain("lõppes");
});

test("each contact registration: 'Lisa protokoll' before its first save, 'Ava protokoll' after; none for a cancelled one or an e-course's", async () => {
  const [liis] = await db.insert(clients).values({ email: "liis@example.test", name: "Liis" }).returning();
  const register = async (over: Partial<typeof registrations.$inferInsert> = {}) =>
    (
      await db
        .insert(registrations)
        .values({ courseId: kontakt.id, courseSessionId: kontakt.sessionId, kind: "group", name: "Liis Tamm", email: "liis@example.test", paymentChoice: "full", status: "confirmed", clientId: liis.id, ...over })
        .returning()
    )[0];
  const open = await register();
  const cancelled = await register({ status: "cancelled" });
  const purchase = await register({ courseId: veeb.id, courseSessionId: null, kind: "individual" });
  let html = await drawer(liis.id);
  const row = part(html, "data-client-registration", open.id);
  expect(row).toContain(`href="/admin/protokollid?registreering=${open.id}"`);
  expect(row).toContain("Lisa protokoll");
  expect(part(html, "data-client-registration", cancelled.id)).not.toContain("data-registration-protocol");
  expect(part(html, "data-client-registration", purchase.id)).not.toContain("data-registration-protocol");
  await db.insert(protocols).values({ registrationId: open.id, stages: [] });
  html = await drawer(liis.id);
  expect(part(html, "data-client-registration", open.id)).toContain("Ava protokoll");
});
