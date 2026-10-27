import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseFeedback, protocols, registrations, reviews } from "@/db/schema";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./helpers";
import { contactStudent, graduate, RECOMMEND, studentOf, submit } from "./reviews-fixtures";

// Maria's „Tagasiside“ with the reviews and the student's drawer, rendered from a real (PGlite) database to HTML (student reviews, Task 4; spec D2, §4;
// admin UX pass piece 4c, Task 2: README C6, S4-35, S4-36, R-c, R-d, R-e): the two views as tabs (the phone's reviews tab counting the ones waiting), the
// header's „Lisa arvustus +“, „Arvustused“ with its status pills and their counts (no „Kõik“; the menu badge's ?olek=ootel shows only the waiting cards),
// each card's anchor and proof (the registration's status and the protocol line, or „Lõpetatud {date}“), the drawers of ?id=uus and ?id=<review>, the
// e-course answers on the list and in the answer's drawer with the day her access was completed in place of a course day, and the student's drawer:
// whether she allowed publishing and what became of it. The drawer's dialog and the server actions are stand-ins (they need a browser or a request), as
// on feedback-admin-pages.test.ts, and so is the router the toolbar and the drawers read.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
// (the toolbar and the drawers are client components that read the router and the address, which a page rendered to HTML here has not got)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/tagasiside",
  useSearchParams: () => new URLSearchParams("vaade=arvustused"),
}));
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return {
    Drawer: ({ children, label }: { children: React.ReactNode; label: string }) => createElement("div", { "data-drawer-stand-in": label }, children),
    useDrawerClose: () => null,
  };
});
vi.mock("@/server/actions/admin-reviews", () => ({
  decideReviewAction: vi.fn(),
  undoDecisionAction: vi.fn(),
  setFeaturedAction: vi.fn(),
  saveManualReviewAction: vi.fn(),
  removeReviewAction: vi.fn(),
  undoRemoveReviewAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ reissueCertificateAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(), updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

import FeedbackPage from "@/app/admin/(panel)/tagasiside/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await FeedbackPage({ searchParams: Promise.resolve(search) }));
/** The HTML from `marker` to the next element carrying the same attribute (or the end). */
const part = (html: string, attribute: string, value: string | number) => {
  const from = html.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attribute}="`, from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The opening tag that carries `attribute="value"` (its other attributes come before or after). */
const tag = (html: string, attribute: string, value: string | number) => html.match(new RegExp(`<[^<>]*${attribute}="${value}"[^<>]*>`))?.[0] ?? "";
/** The text inside the element that carries `attribute="value"`. */
const inner = (html: string, attribute: string, value: string | number) => text(html.match(new RegExp(`<(\\w+)[^<>]*${attribute}="${value}"[^<>]*>([\\s\\S]*?)</\\1>`))?.[2] ?? "");
const reviewIds = (html: string) => [...html.matchAll(/data-review="(\d+)"/g)].map((m) => Number(m[1]));
/** The link (its opening tag and its HTML) of the first `<a>` after `from` whose href is `href` (as written in the HTML: `&` is `&amp;`). */
const link = (html: string, href: string, from = 0) => {
  const at = html.indexOf(`href="${href}"`, from);
  if (at === -1) return { tag: "", inner: "" };
  const start = html.lastIndexOf("<a", at);
  const end = html.indexOf("</a>", at);
  const open = html.indexOf(">", at);
  return { tag: html.slice(start, open + 1), inner: html.slice(open + 1, end) };
};
/** The tab (TabPills) of a view: its link in the tabs' row. */
const tabOf = (html: string, view: "answers" | "reviews") => link(html, view === "answers" ? "/admin/tagasiside?vaade=vastused" : "/admin/tagasiside?vaade=arvustused", html.indexOf("data-tab-pills"));
/** The status pills' links (the toolbar's row „Olek“): the words with the count, the address, and whether it is pressed. */
const pillsOf = (html: string) => {
  const from = html.indexOf('aria-label="Olek"');
  const row = html.slice(from, html.indexOf("</nav>", from));
  return [...row.matchAll(/<a[^<>]*href="([^"]*)"[^<>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ text: text(m[2]), href: m[1].replace(/&amp;/g, "&"), current: /aria-current="true"/.test(m[0]) }));
};
const NOW = new Date("2026-10-18T09:00:00Z");

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Mari (a contact course's student, confirmed, with a protocol sent) and Kati (an e-course graduate) have each given a review; Anu answered without the tick. */
async function world() {
  const mari = await contactStudent(db, "Mari Maasikas");
  await db.insert(protocols).values({ registrationId: mari.registration.id, stages: [], sentAt: new Date("2026-10-13T07:00:00Z") });
  expect((await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." })).kind).toBe("submitted");
  const kati = await graduate(db, { slug: "kulmud-e", name: "Kati Kask", email: "kati@example.test" });
  expect((await submit(db, kati.client.id, { courseSlug: "kulmud-e" }, { name: "Kati K." }, { now: new Date("2026-10-14T08:00:00Z") })).kind).toBe("submitted");
  const anu = await studentOf(db, mari.course, mari.session, "Anu Aas");
  expect((await submit(db, anu.client.id, { registrationId: anu.registration.id }, null)).kind).toBe("submitted");
  const [marisReview, katisReview] = await db.select().from(reviews).orderBy(reviews.id);
  return { mari, kati, anu, marisReview, katisReview };
}

describe("the heading and the two views (S4-35)", () => {
  test("no count in the heading any more: the phone's reviews tab says how many wait („Arvustused · Ootab {n}“), on both views; at 0 just „Arvustused“", async () => {
    const empty = await render();
    expect(text(empty)).not.toContain("Arvustusi ootab kinnitust");
    expect(empty).not.toContain("Ootab 0");
    const { marisReview } = await world();
    for (const html of [await render(), await render({ vaade: "arvustused" })]) {
      expect(html).not.toContain("data-pending-reviews");
      expect(text(tabOf(html, "reviews").inner)).toBe("Arvustused Arvustused · Ootab 2");
    }
    await db.update(reviews).set({ status: "published" }).where(eq(reviews.id, marisReview.id));
    expect(text(tabOf(await render(), "reviews").inner)).toBe("Arvustused Arvustused · Ootab 1");
    await db.update(reviews).set({ status: "hidden" }).where(eq(reviews.kind, "student"));
    expect(text(tabOf(await render(), "reviews").inner)).toBe("Arvustused");
  });

  test("two views as tabs, „Vastused“ (the default) and „Arvustused“; each marks itself the current page, and each view shows only its own part; „Lisa arvustus +“ is the reviews' header button", async () => {
    await world();
    const answers = await render();
    expect(tabOf(answers, "answers").tag).toContain('aria-current="page"');
    expect(tabOf(answers, "reviews").tag).not.toContain("aria-current");
    expect(answers).toContain("data-feedback-row");
    expect(answers).not.toContain("data-reviews-panel");
    expect(answers).not.toContain("data-review-add");
    expect(await render({ vaade: "vastused" })).toContain("data-feedback-row");
    const reviewsView = await render({ vaade: "arvustused" });
    expect(tabOf(reviewsView, "reviews").tag).toContain('aria-current="page"');
    expect(tabOf(reviewsView, "answers").tag).not.toContain("aria-current");
    expect(reviewsView).toContain("data-reviews-panel");
    expect(reviewsView).not.toContain("data-feedback-row");
    // the ink button at the header's right: the create drawer on the view's own address, the focus given back to it (its id)
    const add = tag(reviewsView, "data-review-add", "");
    expect(add).toContain('href="/admin/tagasiside?vaade=arvustused&amp;id=uus"');
    expect(add).toContain('id="review-add"');
    expect(inner(reviewsView, "data-review-add", "")).toBe("Lisa arvustus +");
    expect(tag(await render({ vaade: "arvustused", olek: "ootel" }), "data-review-add", "")).toContain('href="/admin/tagasiside?vaade=arvustused&amp;olek=ootel&amp;id=uus"');
  });
});

describe("„Arvustused“", () => {
  test("every review with its proof: the contact course's registration status and protocol line, the e-course's completion day; the waiting ones first", async () => {
    const { mari, marisReview, katisReview } = await world();
    const html = await render({ vaade: "arvustused" });
    expect(reviewIds(html).sort()).toEqual([marisReview.id, katisReview.id].sort());
    expect(text(part(html, "data-review", marisReview.id))).toContain("Registreering: Kinnitatud · Protokoll saadetud");
    expect(text(part(html, "data-review", katisReview.id))).toContain("Lõpetatud 10.10.2026");
    expect(part(html, "data-review", marisReview.id)).toContain('data-review-kind="student"');
    // a registration awaiting its prepayment, with no protocol sent
    await db.update(registrations).set({ status: "awaiting_prepayment" }).where(eq(registrations.id, mari.registration.id));
    await db.delete(protocols);
    expect(text(part(await render({ vaade: "arvustused" }), "data-review", marisReview.id))).toContain("Registreering: Ootab ettemaksu · Protokolli pole saadetud");
  });

  test("by status (waiting, published, hidden), the newest written first within each; a pressed pill narrows the list, and an unknown word is no filter", async () => {
    const { marisReview, katisReview } = await world();
    const written = (id: number, day: number) => db.update(reviews).set({ writtenAt: new Date(Date.UTC(2026, 9, day, 9)) }).where(eq(reviews.id, id));
    // both waiting: the newest written first
    await written(marisReview.id, 13);
    await written(katisReview.id, 14);
    expect(reviewIds(await render({ vaade: "arvustused" }))).toEqual([katisReview.id, marisReview.id]);
    await written(katisReview.id, 1);
    expect(reviewIds(await render({ vaade: "arvustused" }))).toEqual([marisReview.id, katisReview.id]);
    // Mari's published, Kati's older one still waits: the waiting one is first whatever the days
    await db.update(reviews).set({ status: "published" }).where(eq(reviews.id, marisReview.id));
    expect(reviewIds(await render({ vaade: "arvustused" }))).toEqual([katisReview.id, marisReview.id]);
    expect(reviewIds(await render({ vaade: "arvustused", olek: "ootel" }))).toEqual([katisReview.id]);
    expect(reviewIds(await render({ vaade: "arvustused", olek: "avaldatud" }))).toEqual([marisReview.id]);
    const none = await render({ vaade: "arvustused", olek: "peidetud" });
    expect(reviewIds(none)).toEqual([]);
    expect(text(none)).toContain("Selle valikuga arvustusi pole. Tühjenda otsing ja filtrid");
    expect(text(none)).not.toContain("Selles vaates");
    expect(reviewIds(await render({ vaade: "arvustused", olek: "constructor" }))).toEqual([katisReview.id, marisReview.id]);
    // published before hidden, whatever the days: Mari's, now hidden, is the newest written; Kati's, now published, the oldest
    await db.update(reviews).set({ status: "hidden", writtenAt: new Date(Date.UTC(2026, 9, 15, 9)) }).where(eq(reviews.id, marisReview.id));
    await db.update(reviews).set({ status: "published" }).where(eq(reviews.id, katisReview.id));
    expect(reviewIds(await render({ vaade: "arvustused" }))).toEqual([katisReview.id, marisReview.id]);
  });

  test("R-e: the pills count every status (no „Kõik“), from reviewCounts; the menu badge's address ?olek=ootel shows only the waiting cards, with „Ootab kinnitust“ pressed to toggle off", async () => {
    const { mari, marisReview, katisReview } = await world();
    await db.update(reviews).set({ status: "published" }).where(eq(reviews.id, marisReview.id));
    await db
      .insert(reviews)
      .values({ courseId: mari.course.id, kind: "manual", text: "Tore.", name: "Anu A.", locale: "et", writtenAt: new Date("2026-09-19T21:00:00Z"), status: "hidden", note: "Paberil" });
    const LIST = "/admin/tagasiside?vaade=arvustused";
    expect(pillsOf(await render({ vaade: "arvustused" }))).toEqual([
      { text: "Ootab kinnitust 1", href: `${LIST}&olek=ootel`, current: false },
      { text: "Avaldatud 1", href: `${LIST}&olek=avaldatud`, current: false },
      { text: "Peidetud 1", href: `${LIST}&olek=peidetud`, current: false },
    ]);
    const badge = await render({ vaade: "arvustused", olek: "ootel" });
    expect(reviewIds(badge)).toEqual([katisReview.id]);
    expect(part(badge, "data-review", katisReview.id)).toContain('data-review-status="pending"');
    expect(pillsOf(badge)).toEqual([
      { text: "Ootab kinnitust 1", href: LIST, current: true },
      { text: "Avaldatud 1", href: `${LIST}&olek=avaldatud`, current: false },
      { text: "Peidetud 1", href: `${LIST}&olek=peidetud`, current: false },
    ]);
    // the counts are of every status whatever the pill (and a removed review is in none)
    expect(pillsOf(await render({ vaade: "arvustused", olek: "peidetud" })).map((p) => p.text)).toEqual(["Ootab kinnitust 1", "Avaldatud 1", "Peidetud 1"]);
    await db.update(reviews).set({ removedAt: new Date() }).where(eq(reviews.kind, "manual"));
    expect(pillsOf(await render({ vaade: "arvustused" })).map((p) => p.text)).toEqual(["Ootab kinnitust 1", "Avaldatud 1", "Peidetud 0"]);
  });

  test("R-d: each card is the anchor `arvustus-<id>`; a waiting card is marked so (its ink border); the stars of the student's score", async () => {
    const { marisReview, katisReview } = await world();
    const html = await render({ vaade: "arvustused" });
    for (const r of [marisReview, katisReview]) expect(tag(html, "data-review", r.id)).toContain(`id="arvustus-${r.id}"`);
    expect(tag(html, "data-review", marisReview.id)).toContain('data-review-status="pending"');
    // (the fixtures' answers give „Hinne“ 9)
    expect(inner(part(html, "data-review", marisReview.id), "data-review-stars", 5)).toBe("★★★★★");
  });

  test("with no review at all the view still offers „Lisa arvustus +“ and says there are none", async () => {
    const html = await render({ vaade: "arvustused" });
    expect(text(html)).toContain("Arvustusi pole veel.");
    expect(inner(html, "data-review-add", "")).toBe("Lisa arvustus +");
  });

  test("?id=uus: the create drawer „Uus arvustus“ with every course to choose; ?id=<review Maria added>: „Muuda arvustust“ with its fields; a student's review or none: „Seda arvustust enam pole.“", async () => {
    const mari = await contactStudent(db);
    const [manual] = await db
      .insert(reviews)
      .values({ courseId: mari.course.id, kind: "manual", text: "Tore koolitus.", name: "Anu A.", locale: "ru", writtenAt: new Date("2026-09-19T21:00:00Z"), status: "published", note: "Paberil vormil" })
      .returning();
    const created = await render({ vaade: "arvustused", id: "uus" });
    expect(created).toContain('data-drawer-stand-in="Uus arvustus"');
    expect(created).toContain('data-review-form="new"');
    expect(inner(created, "data-review-field", "courseId")).toContain(mari.course.title.et);
    const edited = await render({ vaade: "arvustused", olek: "avaldatud", id: String(manual.id) });
    expect(edited).toContain('data-drawer-stand-in="Muuda arvustust"');
    expect(edited).toContain(`data-review-form="${manual.id}"`);
    expect(tag(edited, "data-review-field", "name")).toContain('value="Anu A."');
    expect(tag(edited, "data-review-field", "writtenAt")).toContain('value="2026-09-20"');
    expect(inner(edited, "data-review-field", "text")).toBe("Tore koolitus.");
    expect(edited).toContain("data-save-status");
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." });
    const [students] = await db.select().from(reviews).where(eq(reviews.kind, "student"));
    for (const id of [students.id, 99_999]) {
      const html = await render({ vaade: "arvustused", id: String(id) });
      expect(html).toContain('data-drawer-stand-in="Seda arvustust enam pole."');
      expect(html).not.toContain("data-review-form=");
    }
  });

  test("a review Maria added shows as hers, with its note and no proof", async () => {
    const mari = await contactStudent(db);
    const [row] = await db
      .insert(reviews)
      .values({ courseId: mari.course.id, kind: "manual", text: "Tore koolitus.", name: "Anu A.", locale: "et", writtenAt: new Date("2026-09-19T21:00:00Z"), status: "published", note: "Paberil vormil" })
      .returning();
    const html = part(await render({ vaade: "arvustused" }), "data-review", row.id);
    expect(text(html)).toContain("Lisatud käsitsi");
    expect(text(html)).toContain("Allikas: Paberil vormil");
    expect(html).not.toContain("data-review-proof");
    expect(html).not.toContain("data-review-stars"); // (no score)
    expect(tag(html, "data-review-edit", "")).toContain(`href="/admin/tagasiside?vaade=arvustused&amp;id=${row.id}"`);
    expect(html).toContain("data-review-delete");
  });

  test("the courses „Lisa arvustus“ can name are every course, a draft too, in the public order (the form's select is drawn when it opens)", async () => {
    const { reviewCourses } = await import("@/server/reviews");
    const mari = await contactStudent(db);
    await graduate(db, { slug: "kulmud-e", published: false });
    const list = await reviewCourses(db);
    expect(list.map((c) => [c.title.et, c.published])).toEqual([
      [mari.course.title.et, true],
      ["Kulmude e-kursus", false],
    ]);
  });
});

describe("the answers' list and drawer, e-courses included", () => {
  test("an e-course's answer is on the list with the day her access was completed in place of a course day; a contact answer keeps its day", async () => {
    const { mari, kati } = await world();
    const html = await render();
    const katis = html.match(/data-feedback-row="(\d+)"/g)!;
    expect(katis).toHaveLength(3); // Mari's, Kati's and Anu's (no tick, but an answer all the same)
    const kRow = part(html, "data-feedback-row", (await db.select().from(courseFeedback).where(eq(courseFeedback.accessId, kati.access.id)))[0].id);
    expect(text(kRow)).toContain("Lõpetatud 10.10.2026");
    expect(text(kRow)).toContain("Kulmude e-kursus");
    const mRow = part(html, "data-feedback-row", (await db.select().from(courseFeedback).where(eq(courseFeedback.registrationId, mari.registration.id)))[0].id);
    expect(text(mRow)).toContain("12.10.2026");
    expect(text(mRow)).not.toContain("Lõpetatud");
  });

  test("?id= of an e-course's answer: her name (the account's), the course with „Lõpetatud {date}“ in place of a day, a way to the student and none to a registration", async () => {
    const { kati } = await world();
    const [feedback] = await db.select().from(courseFeedback).where(eq(courseFeedback.accessId, kati.access.id));
    const html = await render({ id: String(feedback.id) });
    const detail = part(html, "data-feedback-detail", feedback.id);
    expect(inner(detail, "data-feedback-course-day", "")).toBe("Kulmude e-kursus, Lõpetatud 10.10.2026");
    expect(detail).toContain("Kati Kask");
    expect(detail).toContain(`href="/admin/opilased?id=${kati.client.id}"`);
    expect(detail).not.toContain("/admin/registreerimised");
  });
});

describe("the student's drawer: whether she allowed publishing, and the review's status", () => {
  const drawer = async (clientId: number) => {
    const html = renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId))!, ecourses: [], now: NOW }));
    return html.slice(html.indexOf("data-client-feedback"));
  };

  test("a contact answer with her permission says so with the review's status, and a way to „Arvustused“", async () => {
    const { mari, marisReview } = await world();
    let html = await drawer(mari.client.id);
    expect(inner(html, "data-feedback-review", "pending")).toBe("Lubab avaldada: Ootab kinnitust Ava arvustused");
    expect(html).toContain('href="/admin/tagasiside?vaade=arvustused"');
    await db.update(reviews).set({ status: "published" }).where(eq(reviews.id, marisReview.id));
    html = await drawer(mari.client.id);
    expect(inner(html, "data-feedback-review", "published")).toContain("Lubab avaldada: Avaldatud");
    await db.update(reviews).set({ featured: true }).where(eq(reviews.id, marisReview.id));
    expect(inner(await drawer(mari.client.id), "data-feedback-review", "published")).toContain("Lubab avaldada: Avaldatud, avalehel");
    await db.update(reviews).set({ status: "hidden" }).where(eq(reviews.id, marisReview.id));
    expect(inner(await drawer(mari.client.id), "data-feedback-review", "hidden")).toContain("Lubab avaldada: Peidetud");
  });

  test("an answer without the tick says the permission was not given, and offers no way to „Arvustused“", async () => {
    const { anu } = await world();
    const html = await drawer(anu.client.id);
    expect(inner(html, "data-feedback-review", "none")).toBe("Avaldamise luba pole antud.");
    expect(html).not.toContain("data-feedback-review-link");
  });

  test("an e-course answer is in her drawer, with the day her access was completed and her permission", async () => {
    const { kati } = await world();
    const html = await drawer(kati.client.id);
    expect(inner(html, "data-feedback-completed", "")).toBe("Lõpetatud 10.10.2026");
    expect(inner(html, "data-feedback-review", "pending")).toContain("Lubab avaldada: Ootab kinnitust");
  });

  test("a student whose permission was withdrawn (the review is gone) is shown as not having given it; her answer stays", async () => {
    const { mari, marisReview } = await world();
    await db.delete(reviews).where(eq(reviews.id, marisReview.id));
    const html = await drawer(mari.client.id);
    expect(inner(html, "data-feedback-review", "none")).toBe("Avaldamise luba pole antud.");
    expect(html).toContain(RECOMMEND);
  });
});
