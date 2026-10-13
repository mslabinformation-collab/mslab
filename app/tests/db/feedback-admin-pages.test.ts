import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseFeedback, registrations, type Course, type CourseFeedback, type Registration } from "@/db/schema";
import { makeTestDb } from "./helpers";
import { protocolCourse, student } from "./protocols-fixtures";

// Maria's Tagasiside page and the answers in the registration's and the student's drawers, rendered from a real (PGlite) database to HTML:
// the questions and options in her own wording whatever language the student answered in, the average with a decimal comma, the counts per
// option. The shell, the drawer's dialog and the server actions are stand-ins (they need a browser or a request), as on Maksed's test.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/data", () => ({ getAdminCounts: async () => ({}) }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return { Drawer: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-drawer-stand-in": "" }, children), useUnsavedInDrawer: () => {} };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), saveRegistrationPayment: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn() }));

import RegistrationsPage from "@/app/admin/(panel)/registreerimised/page";
import FeedbackPage from "@/app/admin/(panel)/tagasiside/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const render = async (page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve(search) }));
const rowIds = (html: string) => [...html.matchAll(/data-feedback-row="(\d+)"/g)].map((m) => Number(m[1]));
/** The HTML from `marker` to the next element carrying the same attribute (or the end). */
const part = (html: string, attribute: string, value: string | number) => {
  const from = html.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attribute}="`, from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));

let db: Db;
let course: Course;
let mari: Registration, anu: Registration, liis: Registration;
let a: CourseFeedback, b: CourseFeedback, c: CourseFeedback;
let kati: number;

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
  const first = await protocolCourse(db);
  course = first.course;
  const second = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
  const [client] = await db.insert(clients).values({ email: "marimaasikas@example.com", name: "Mari Maasikas" }).returning();
  kati = client.id;
  mari = await student(db, course, first.session, "Mari Maasikas", { clientId: kati });
  anu = await student(db, course, first.session, "Anu Aas");
  liis = await student(db, course, first.session, "Liis Lepp");
  const tiina = await student(db, second.course, second.session, "Tiina Tamm");
  const answer = async (registrationId: number, answers: CourseFeedback["answers"], day: number, locale: "et" | "ru" = "et") =>
    (await db.insert(courseFeedback).values({ registrationId, answers, locale, submittedAt: at(day), createdAt: at(day) }).returning())[0];
  a = await answer(mari.id, { score: 9, expectations: "met", message: "Aitäh!\nVäga hea päev." }, 13);
  b = await answer(anu.id, { score: 6, expectations: "exceeded", ready: "mostly", recommend: "Да, всем советую" }, 14, "ru");
  c = await answer(tiina.id, { clarity: "very_clear" }, 15);
  await db.insert(courseFeedback).values({ registrationId: liis.id, dismissedAt: at(13), createdAt: at(13) });
});

test("the list: newest first with each score; every course with its answers and average (a decimal comma); a name opens the answers", async () => {
  const html = await render(FeedbackPage);
  expect(html).toContain('data-shell-active="feedback"');
  expect(rowIds(html)).toEqual([c.id, b.id, a.id]);
  expect(html).toContain("Vastuseid: 3");
  expect(part(html, "data-feedback-row", a.id)).toContain(`href="/admin/tagasiside?id=${a.id}"`);
  expect(part(html, "data-feedback-row", a.id)).toContain("9/10");
  expect(part(html, "data-feedback-course", course.id)).toContain("7,5 / 10");
  expect(html).toContain(`href="/admin/tagasiside?koolitus=${course.id}"`);
  expect(html).not.toContain("data-feedback-summary");
});

test("a course: its average and scores, every option counted in Maria's wording; only its answers listed", async () => {
  const html = await render(FeedbackPage, { koolitus: String(course.id) });
  expect(html).toContain(`data-feedback-summary="${course.id}"`);
  expect(html).toContain("Keskmine hinne: 7,5 / 10");
  expect(html).toContain("Hindeid: 2");
  const expectations = part(html, "data-feedback-counts", "expectations");
  expect(expectations).toContain("Kas koolitus vastas sinu ootustele?");
  for (const [label, n] of [["Ületas ootusi", 1], ["Vastas ootustele", 1], ["Ei vastanud ootustele", 0]] as const) expect(expectations).toMatch(new RegExp(`${label}</span><strong>${n}</strong>`));
  expect(rowIds(html)).toEqual([b.id, a.id]);
  // (the attributes' order is the Link's, so the tag is found by its href and then asked for aria-current)
  const pill = (href: string) => html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))![0];
  expect(pill(`/admin/tagasiside\\?koolitus=${course.id}`)).toContain('aria-current="true"');
  expect(pill("/admin/tagasiside")).not.toContain("aria-current");
  expect(await render(FeedbackPage, { koolitus: "999" })).toContain("Selle koolituse kohta pole tagasisidet.");
});

test("?id=: a Russian answer in Maria's wording with its language said, the free text as written; the way to the registration", async () => {
  const html = await render(FeedbackPage, { id: String(b.id) });
  const detail = part(html, "data-feedback-detail", b.id);
  for (const text of ["Anu Aas", "Kas koolitus vastas sinu ootustele?", "Ületas ootusi", "Pigem jah, natuke harjutamist vajab", "Да, всем советую", "Vastas vene keeles", "Saadetud 14.10.2026"])
    expect(detail, text).toContain(text);
  expect(detail).toContain(`href="/admin/registreerimised?id=${anu.id}"`);
  expect(detail).not.toContain("/admin/opilased"); // Anu has no account
  expect(part(await render(FeedbackPage, { id: String(a.id) }), "data-feedback-detail", a.id)).toContain(`href="/admin/opilased?id=${kati}"`);
  expect(await render(FeedbackPage, { id: "999" })).toContain("Seda tagasisidet ei leitud.");
});

test("the drawers: the registration's answers (none for 'Ei soovi'); the student's, with the course", async () => {
  const reg = await render(RegistrationsPage, { id: String(mari.id) });
  expect(part(reg, "data-registration-detail", mari.id)).toContain("data-registration-feedback");
  expect(reg).toContain("Aitäh!\nVäga hea päev.");
  expect(await render(RegistrationsPage, { id: String(liis.id) })).not.toContain("data-registration-feedback");
  const html = renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, kati))!, ecourses: [], now: at(20) }));
  const section = html.slice(html.indexOf("data-client-feedback"));
  for (const text of ["Tagasiside", "Kulmude lamineerimine", "Vastas ootustele", "9/10"]) expect(section, text).toContain(text);
  await db.update(registrations).set({ clientId: null }).where(eq(registrations.id, mari.id));
  expect(renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, kati))!, ecourses: [], now: at(20) }))).toContain("Tagasisidet pole antud.");
});
