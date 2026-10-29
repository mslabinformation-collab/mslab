import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseFeedback, courses, courseSessions, registrations, reviews, type Course, type CourseFeedback, type Registration } from "@/db/schema";
import { makeTestDb } from "./helpers";
import { protocolCourse, student } from "./protocols-fixtures";

// Maria's Tagasiside page and the answers in the registration's and the student's drawers, rendered from a real (PGlite) database to HTML:
// the questions and options in her own wording whatever language the student answered in, the average with a decimal comma, the counts per
// option. The drawer's dialog and the server actions are stand-ins (they need a browser or a request), as on Maksed's test.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
// (the list's toolbar is a client component that reads the router and the address, which a page rendered to HTML here has not got)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/registreerimised",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  // (the stand-in shows where the real drawer's close goes: the list as it was, with its search and course)
  return {
    Drawer: ({ children, closeHref }: { children: React.ReactNode; closeHref: string }) => createElement("div", { "data-drawer-stand-in": "", "data-close-href": closeHref }, children),
    useDrawerClose: () => null,
  };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ reissueCertificateAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(), updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("@/server/actions/admin-reviews", () => ({ decideReviewAction: vi.fn(), undoDecisionAction: vi.fn(), setFeaturedAction: vi.fn(), saveManualReviewAction: vi.fn(), removeReviewAction: vi.fn(), undoRemoveReviewAction: vi.fn() }));

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
/** The course select's options as the toolbar draws them: [value, label, chosen]. */
const courseOptions = (html: string) => {
  const select = html.match(/<select[^>]*aria-label="Koolitus"[^>]*>[\s\S]*?<\/select>/);
  expect(select, "the course select").not.toBeNull();
  return [...select![0].matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], m[2] !== undefined] as const);
};

let db: Db;
let course: Course;
let other: Course;
let mari: Registration, anu: Registration, liis: Registration;
let a: CourseFeedback, b: CourseFeedback, c: CourseFeedback;
let kati: number;

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
  const first = await protocolCourse(db);
  course = first.course;
  const second = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
  other = second.course;
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
  // the course is chosen in the toolbar's select (S4-40: it stays beside the search); the pills of before are gone
  expect(courseOptions(html)).toEqual([
    ["", "Kõik koolitused", false],
    [String(course.id), "Kulmude lamineerimine", true],
    [String(other.id), "Ripsmete tõstmine", false],
  ]);
  expect(html).not.toContain("data-feedback-filter");
  expect(courseOptions(await render(FeedbackPage))).toEqual([
    ["", "Kõik koolitused", true],
    [String(course.id), "Kulmude lamineerimine", false],
    [String(other.id), "Ripsmete tõstmine", false],
  ]);
  expect(html).not.toContain("Selle koolituse kohta pole tagasisidet.");
});

test("a ?koolitus= the select does not offer (an id that is no course, or a real course without answers) is no course: every answer, „Kõik koolitused“ chosen (Task 3 review M-3, m-5)", async () => {
  // (a real course that exists and has no answer, the case a stale link is about; removed again below, as the other tests share this database)
  const empty = await protocolCourse(db, { slug: "ilma-vastusteta", title: { et: "Ilma vastusteta", ru: "Без ответов" } });
  try {
    for (const koolitus of ["999", String(course.id + other.id + 100), String(empty.course.id)]) {
      const html = await render(FeedbackPage, { koolitus });
      // the list and the select agree, as Registreerimised resets a scope it does not know
      expect(rowIds(html), koolitus).toEqual([c.id, b.id, a.id]);
      expect(courseOptions(html).filter((o) => o[2]).map((o) => o[1]), koolitus).toEqual(["Kõik koolitused"]);
      expect(courseOptions(html).map((o) => o[0]), koolitus).not.toContain(String(empty.course.id)); // (a course without answers is not offered)
      expect(html).toContain("data-feedback-courses");
      expect(html).not.toContain("data-feedback-summary");
      expect(html).not.toContain("Selle valikuga vastuseid pole.");
      // the addresses on the page do not carry it on
      expect(html).not.toContain(`koolitus=${koolitus}`);
    }
    // with a search, it is the search alone
    for (const koolitus of ["999", String(empty.course.id)]) {
      const searched = await render(FeedbackPage, { koolitus, otsi: "maasikas" });
      expect(rowIds(searched), koolitus).toEqual([a.id]);
      expect(part(searched, "data-feedback-row", a.id)).toContain(`href="/admin/tagasiside?otsi=maasikas&amp;id=${a.id}"`);
    }
  } finally {
    await db.delete(courseSessions).where(eq(courseSessions.courseId, empty.course.id));
    await db.delete(courses).where(eq(courses.id, empty.course.id));
  }
});

test("a course and a search together say one „Vastuseid“, the list's: the course's numbers leave their own count out while a search is on (Task 3 review M-1)", async () => {
  const counts = (html: string) => [...html.matchAll(/Vastuseid: (\d+)/g)].map((m) => Number(m[1]));
  const both = await render(FeedbackPage, { koolitus: String(course.id), otsi: "maasikas" });
  expect(both).toContain(`data-feedback-summary="${course.id}"`);
  expect(both).not.toContain("data-feedback-course-count");
  expect(counts(both)).toEqual([1]);
  // the course's other numbers stay, the whole course's
  expect(both).toContain("Hindeid: 2");
  expect(both).toContain("Keskmine hinne: 7,5 / 10");
  // without a search the course's count is there, and agrees with its list
  const course0 = await render(FeedbackPage, { koolitus: String(course.id) });
  expect(course0).toContain("data-feedback-course-count");
  expect(counts(course0)).toEqual([2, 2]);
});

test("the search (S4-40): the answers of whoever's name or e-mail holds the text, beside the course select; a row and the drawer keep it", async () => {
  const html = await render(FeedbackPage, { otsi: "maasikas" });
  expect(html).toContain('placeholder="Otsi nime või e-posti järgi"');
  expect(courseOptions(html).map((o) => o[1])).toEqual(["Kõik koolitused", "Kulmude lamineerimine", "Ripsmete tõstmine"]);
  expect(rowIds(html)).toEqual([a.id]);
  expect(html).toContain("Vastuseid: 1");
  expect(rowIds(await render(FeedbackPage, { otsi: "ANUAAS@example" }))).toEqual([b.id]);
  // the course and the search narrow it together
  expect(rowIds(await render(FeedbackPage, { otsi: "tiina", koolitus: String(other.id) }))).toEqual([c.id]);
  expect(rowIds(await render(FeedbackPage, { otsi: "tiina", koolitus: String(course.id) }))).toEqual([]);
  // the row's link and the course table's links carry the search, so the drawer closes to the searched list
  expect(part(html, "data-feedback-row", a.id)).toContain(`href="/admin/tagasiside?otsi=maasikas&amp;id=${a.id}"`);
  expect(part(html, "data-feedback-course", course.id)).toContain(`href="/admin/tagasiside?otsi=maasikas&amp;koolitus=${course.id}"`);
  const open = await render(FeedbackPage, { otsi: "maasikas", koolitus: String(course.id), id: String(a.id) });
  expect(open).toContain(`data-close-href="/admin/tagasiside?otsi=maasikas&amp;koolitus=${course.id}"`);
});

test("the pager of a searched list keeps the search (and the course) on both of its ways (Task 3 review M-2)", async () => {
  const filled = state.db;
  const many = await makeTestDb();
  state.db = many;
  try {
    const { course: c1, session } = await protocolCourse(many);
    // 52 answers that the search finds (more than a page of 50) and one it does not
    const people = [...Array.from({ length: 52 }, (_, i) => [`Proov ${i + 1}`, `proov${i + 1}@example.test`]), ["Mari Maasikas", "mari@example.test"]];
    const regs = await many
      .insert(registrations)
      .values(people.map(([name, email]) => ({ courseId: c1.id, courseSessionId: session.id, kind: "group" as const, name, email, paymentChoice: "full" as const, status: "confirmed" as const })))
      .returning();
    await many.insert(courseFeedback).values(regs.map((r, i) => ({ registrationId: r.id, answers: { score: 8 }, locale: "et" as const, submittedAt: at(1 + (i % 28)), createdAt: at(1 + (i % 28)) })));
    // the pager's links („← Eelmine“, „Järgmine →“) by their rel
    const ways = (html: string) =>
      Object.fromEntries([...html.matchAll(/<a [^>]*rel="(prev|next)"[^>]*>/g)].map((m) => [m[1], m[0].match(/href="([^"]*)"/)![1].replace(/&amp;/g, "&")]));
    const first = await render(FeedbackPage, { otsi: "proov" });
    expect(first).toContain("Vastuseid: 52");
    expect(rowIds(first)).toHaveLength(50);
    expect(ways(first)).toEqual({ next: "/admin/tagasiside?otsi=proov&leht=2" });
    const second = await render(FeedbackPage, { otsi: "proov", leht: "2" });
    expect(rowIds(second)).toHaveLength(2);
    expect(ways(second)).toEqual({ prev: "/admin/tagasiside?otsi=proov" });
    // a row on page 2 opens its drawer on page 2, and the drawer closes there
    expect(part(second, "data-feedback-row", rowIds(second)[0])).toContain(`href="/admin/tagasiside?otsi=proov&amp;leht=2&amp;id=${rowIds(second)[0]}"`);
    // with the course chosen too, both stay
    const withCourse = await render(FeedbackPage, { otsi: "proov", koolitus: String(c1.id) });
    expect(ways(withCourse)).toEqual({ next: `/admin/tagasiside?otsi=proov&koolitus=${c1.id}&leht=2` });
    expect(ways(await render(FeedbackPage, { otsi: "proov", koolitus: String(c1.id), leht: "2" }))).toEqual({ prev: `/admin/tagasiside?otsi=proov&koolitus=${c1.id}` });
  } finally {
    state.db = filled;
  }
});

test("the search finds nothing: „{q}“ järgi vastuseid ei leitud. and the way back; with no answers at all, only that there are none", async () => {
  const none = await render(FeedbackPage, { otsi: "xyz" });
  expect(none).toContain("„xyz“ järgi vastuseid ei leitud.");
  expect(none).toMatch(/<a [^>]*href="\/admin\/tagasiside"[^>]*>Tühjenda otsing ja filtrid<\/a>/);
  expect(rowIds(none)).toEqual([]);
  // what was typed is shown as text, never as markup
  const markup = await render(FeedbackPage, { otsi: "<b>x</b>" });
  expect(markup).toContain("„&lt;b&gt;x&lt;/b&gt;“ järgi vastuseid ei leitud.");
  expect(markup).not.toContain("<b>x</b>");
  // a search that finds something shows no empty line
  expect(await render(FeedbackPage, { otsi: "maasikas" })).not.toContain("ei leitud");
  // nothing answered yet: the plain line, and nothing to clear
  const filled = state.db;
  state.db = await makeTestDb();
  try {
    const empty = await render(FeedbackPage);
    expect(empty).toContain("Tagasisidet pole veel antud.");
    expect(empty).not.toContain("Tühjenda otsing ja filtrid");
  } finally {
    state.db = filled;
  }
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

test("?id=: „Vaata arvustust →“ opens Arvustused at the card of the answer's live review — whatever its status — and is not there without one", async () => {
  const detailOf = async (f: CourseFeedback) => part(await render(FeedbackPage, { id: String(f.id) }), "data-feedback-detail", f.id);
  const [review] = await db.insert(reviews).values({ courseId: course.id, feedbackId: a.id, kind: "student", text: "Aitäh!", name: "Mari M.", locale: "et", writtenAt: at(13), status: "pending" }).returning();
  try {
    // (Mari's answer has the review; Anu's has none)
    const card = `/admin/tagasiside?vaade=arvustused#arvustus-${review.id}`;
    for (const status of ["pending", "published", "hidden"] as const) {
      await db.update(reviews).set({ status }).where(eq(reviews.id, review.id));
      const withLink = await detailOf(a);
      // the address names no ?olek=: the card is in the list of every status, so a pill pressed before cannot hide it
      expect(withLink, status).toContain(`href="${card}">Vaata arvustust →</a>`);
      expect(withLink, status).not.toContain("olek");
      // beside the other two links, the review first (S4-41)
      expect(withLink.indexOf("Vaata arvustust →"), status).toBeLessThan(withLink.indexOf("Ava õpilane →"));
      expect(withLink.indexOf("Ava õpilane →"), status).toBeLessThan(withLink.indexOf("Ava registreering →"));
    }
    expect(await detailOf(b)).not.toContain("Vaata arvustust");
    expect(await detailOf(b)).toContain("Ava registreering →");
    // a removed review is no review for the link
    await db.update(reviews).set({ removedAt: at(14) }).where(eq(reviews.id, review.id));
    expect(await detailOf(a)).not.toContain("Vaata arvustust");
    // and the words that S4-41 replaced are gone
    expect(await detailOf(a)).not.toContain("Õpilase juurde");
  } finally {
    await db.delete(reviews).where(eq(reviews.id, review.id));
  }
});

test("the drawers: the registration's answers (none for 'Ei soovi'); the student's, with the course", async () => {
  const reg = await render(RegistrationsPage, { id: String(mari.id) });
  expect(part(reg, "data-registration-detail", mari.id)).toContain("data-registration-feedback");
  expect(reg).toContain("Aitäh!\nVäga hea päev.");
  // (a folded row of the drawer, P-3: „Saadetud {date}“ when she answered, „pole antud“ when she has not — the row is there for a contact course either way)
  expect(reg).toMatch(/Tagasiside<\/span>[\s\S]*?Saadetud \d\d\.\d\d\.\d{4}/);
  const none = await render(RegistrationsPage, { id: String(liis.id) });
  expect(none).not.toContain("data-registration-feedback");
  expect(none).toMatch(/Tagasiside<\/span>[\s\S]*?pole antud/);
  const html = renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, kati))!, ecourses: [], now: at(20) }));
  // („Tagasiside“ is a folded row of the drawer: its summary — the title and how many — comes before what is inside)
  const section = html.slice(html.lastIndexOf("<details", html.indexOf("data-client-feedback")));
  for (const text of ["Tagasiside", "Kulmude lamineerimine", "Vastas ootustele", "9/10"]) expect(section, text).toContain(text);
  await db.update(registrations).set({ clientId: null }).where(eq(registrations.id, mari.id));
  expect(renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, kati))!, ecourses: [], now: at(20) }))).toContain("Tagasisidet pole antud.");
});
