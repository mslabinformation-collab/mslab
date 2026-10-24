import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses, pages, reviews } from "@/db/schema";
import { COURSE_REVIEWS_MAX, COURSE_REVIEWS_SHOWN, HOME_REVIEWS_MAX } from "@/domain/review";
import { makeTestDb } from "./helpers";
import { protocolCourse } from "./protocols-fixtures";

// The student reviews on the public pages (student reviews, Task 5; spec D5, §5; Review Focus 3), through the pages' own reads: the course page
// (koolitused/[slug]/page.tsx) and the home page are the real pages, rendered from a real (PGlite) database to HTML, in both languages. What a
// published review does to each of them: the course page's block with the course's newest six and „Näita kõiki“ for the rest (up to 50), the home
// page's section with the featured ones (up to 6), each naming its course; and what must never show: a pending or hidden review, a review of a
// course that is not published (its page does not exist, the home page leaves it out), one not featured on the home page. Everything else on the page
// is the page as it is: the empty database has no slides, posts or settings.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
// (the registration form is a client component that reads the router, which a page rendered to HTML here has not got; notFound() stays the real one)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// (the course page asks whether the request is the admin's draft preview, server/preview.ts previewActive: draft mode is read outside a request here, and a
// visitor's request has it off)
vi.mock("next/headers", async (original) => ({ ...(await original<typeof import("next/headers")>()), draftMode: async () => ({ isEnabled: false }) }));

import CoursePage from "@/app/[locale]/(site)/koolitused/[slug]/page";
import HomePage from "@/app/[locale]/(site)/page";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
});
afterEach(() => vi.restoreAllMocks());

const day = (d: number, hour = 12) => new Date(Date.UTC(2026, 9, d, hour));
type Over = Partial<typeof reviews.$inferInsert>;
/** A published manual review (`over` replaces fields); written on the day `n`, so that a higher n is newer. */
async function addReview(courseId: number, n: number, over: Over = {}) {
  const [row] = await db
    .insert(reviews)
    .values({ courseId, kind: "manual", text: `Soovitaksin kindlasti ${n}.`, name: `Mari ${n}.`, locale: "et", writtenAt: day(n), status: "published", note: "paberil", ...over })
    .returning();
  return row;
}
const course = (locale: "et" | "ru", slug = "kulmude-lami") => CoursePage({ params: Promise.resolve({ locale, slug }) }).then((tree) => renderToStaticMarkup(tree));
const home = (locale: "et" | "ru") => HomePage({ params: Promise.resolve({ locale }) }).then((tree) => renderToStaticMarkup(tree));
/** The ids of the reviews in a page, in the order shown. */
const shown = (html: string) => [...html.matchAll(/data-review="(\d+)"/g)].map((m) => Number(m[1]));
const BLOCK = 'data-reviews="course"';
const SECTION = 'data-reviews="home"';

describe("the course page", () => {
  test("a course with no published review has no block: no heading, no notice, no button", async () => {
    await protocolCourse(db);
    const html = await course("et");
    expect(html).toContain("Kulmude lamineerimine"); // (the page itself is there)
    for (const text of [BLOCK, "data-review=", "Õpilaste tagasiside", "Tagasiside on MS LAB-i koolituse läbinud õpilastelt", "Näita kõiki"]) expect(html, text).not.toContain(text);
  });

  test("a published review: the block after the course's content, with its words, name and month, the notice, and no score of any kind", async () => {
    const { course: made } = await protocolCourse(db);
    const review = await addReview(made.id, 5, { text: "Esimene lõik.\n\nTeine lõik.", name: "Kati K." });
    const html = await course("et");
    expect(shown(html)).toEqual([review.id]);
    expect(html).toContain(BLOCK);
    expect(html).toContain("Õpilaste tagasiside");
    expect(html).toContain("Esimene lõik.");
    expect(html).toContain("Teine lõik.");
    expect(html).toContain("Kati K.");
    expect(html).toContain("okt 2026");
    expect(html).toContain("Tagasiside on MS LAB-i koolituse läbinud õpilastelt. Avaldame selle õpilase loal ja pärast kontrolli.");
    expect(html).not.toContain("Näita kõiki");
    expect(html).not.toMatch(/[★☆]|keskmine/i);
    // the order of the page: the course's content, then the reviews, then the recommendations
    expect(html.indexOf(BLOCK)).toBeGreaterThan(html.indexOf("Kulmude lamineerimine"));
    const recommendations = html.indexOf("data-recommendations");
    if (recommendations >= 0) expect(html.indexOf(BLOCK)).toBeLessThan(recommendations);
  });

  test("the block comes after the course's content section and before the trainer's card", async () => {
    const { course: made } = await protocolCourse(db, { body: { et: "Koolituse kirjeldus." } });
    await db.insert(pages).values({ key: "trainer_bio", title: { et: "Maria Sosnina" }, body: { et: "Maria lugu." } });
    await addReview(made.id, 5);
    const html = await course("et");
    const content = html.indexOf("Koolituse kirjeldus.");
    const block = html.indexOf(BLOCK);
    const trainer = html.indexOf("data-trainer-card");
    expect(content).toBeGreaterThan(-1);
    expect(trainer).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(content);
    expect(block).toBeLessThan(trainer);
  });

  test("pending and hidden reviews are never shown, nor is another course's", async () => {
    const { course: made } = await protocolCourse(db);
    const { course: other } = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine" } });
    const published = await addReview(made.id, 3);
    await addReview(made.id, 4, { status: "pending", kind: "student", note: null, text: "Ootel sõnad." });
    await addReview(made.id, 5, { status: "hidden", text: "Peidetud sõnad." });
    await addReview(other.id, 6, { text: "Teise koolituse sõnad." });
    const html = await course("et");
    expect(shown(html)).toEqual([published.id]);
    for (const text of ["Ootel sõnad.", "Peidetud sõnad.", "Teise koolituse sõnad."]) expect(html, text).not.toContain(text);
  });

  test(`the newest ${COURSE_REVIEWS_SHOWN} first and „Näita kõiki (n)“ for the rest, up to ${COURSE_REVIEWS_MAX}; the rest is in the page's data, not in its HTML`, async () => {
    const { course: made } = await protocolCourse(db);
    const rows = [];
    for (let i = 1; i <= 20; i++) rows.push(await addReview(made.id, i));
    const html = await course("et");
    expect(shown(html)).toEqual(rows.slice(-COURSE_REVIEWS_SHOWN).reverse().map((r) => r.id)); // newest first
    expect(html).toContain("Näita kõiki (14)");
    expect(html).not.toContain("Soovitaksin kindlasti 14.");
  });

  test(`more than ${COURSE_REVIEWS_MAX} published reviews: the page counts ${COURSE_REVIEWS_MAX} in all`, async () => {
    const { course: made } = await protocolCourse(db);
    await db.insert(reviews).values(Array.from({ length: COURSE_REVIEWS_MAX + 3 }, (_, i) => ({ courseId: made.id, kind: "manual" as const, text: `Sõnad ${i}.`, name: "A.", locale: "et" as const, writtenAt: day(1, i % 24), status: "published" as const, note: "x" })));
    const html = await course("et");
    expect(html).toContain(`Näita kõiki (${COURSE_REVIEWS_MAX - COURSE_REVIEWS_SHOWN})`);
  });

  test("Review Focus 3: a course that is not published has no page and shows nothing on the home page; the reviews come back when it is published again", async () => {
    const { course: made } = await protocolCourse(db);
    const review = await addReview(made.id, 5, { featured: true });
    expect(shown(await course("et"))).toEqual([review.id]);
    expect(shown(await home("et"))).toEqual([review.id]);

    await db.update(courses).set({ published: false }).where(eq(courses.id, made.id));
    await expect(course("et")).rejects.toMatchObject({ digest: expect.stringContaining("404") }); // (notFound(): the page does not exist)
    await expect(course("ru")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(shown(await home("et"))).toEqual([]);
    expect(await home("et")).not.toContain("Õpilaste kogemused");
    expect(await db.select().from(reviews)).toHaveLength(1); // (kept)

    await db.update(courses).set({ published: true }).where(eq(courses.id, made.id));
    expect(shown(await course("et"))).toEqual([review.id]);
    expect(shown(await home("et"))).toEqual([review.id]);
  });

  test("a withdrawn or deleted review is gone from the next render", async () => {
    const { course: made } = await protocolCourse(db);
    const a = await addReview(made.id, 3);
    const b = await addReview(made.id, 4);
    expect(shown(await course("et"))).toEqual([b.id, a.id]);
    await db.delete(reviews).where(eq(reviews.id, b.id));
    expect(shown(await course("et"))).toEqual([a.id]);
    await db.delete(reviews).where(eq(reviews.id, a.id));
    expect(await course("et")).not.toContain(BLOCK);
  });

  test("the Russian page: Russian heading, notice and month; a review is shown as written and marked with its own language", async () => {
    const { course: made } = await protocolCourse(db);
    await addReview(made.id, 5, { text: "Soovitan kõigile.", name: "Anu A.", locale: "et" });
    await addReview(made.id, 6, { text: "Рекомендую всем!", name: "Мария М.", locale: "ru" });
    const html = await course("ru");
    expect(html).toContain("Отзывы учеников");
    expect(html).toContain("Отзывы оставляют ученики, прошедшие обучение в MS LAB.");
    expect(html).toContain("окт. 2026");
    expect(html).not.toContain("Õpilaste tagasiside");
    expect(html).toMatch(/<blockquote[^>]*lang="et"[^>]*><p>Soovitan kõigile\.<\/p>/);
    expect(html).toMatch(/<blockquote[^>]*><p>Рекомендую всем!<\/p>/);
    expect(html.match(/<blockquote[^>]*lang="ru"/)).toBeNull(); // (the page's own language needs no mark)
    expect(html).toMatch(/<span[^>]*lang="et"[^>]*>Anu A\.<\/span>/); // (the shown name of the Estonian review is marked too)
    expect(html).not.toMatch(/<span[^>]*lang="ru"[^>]*>Мария М\./);
  });
});

describe("the home page", () => {
  test("no featured review: no section, no heading, no notice", async () => {
    const { course: made } = await protocolCourse(db);
    await addReview(made.id, 5, { featured: false });
    const html = await home("et");
    for (const text of [SECTION, "data-review=", "Õpilaste kogemused", "Avaldame selle õpilase loal"]) expect(html, text).not.toContain(text);
  });

  test("a published, featured review: the section with its words, name, month and a link to its course", async () => {
    const { course: made } = await protocolCourse(db);
    const review = await addReview(made.id, 5, { featured: true, name: "Kati K." });
    const html = await home("et");
    expect(shown(html)).toEqual([review.id]);
    expect(html).toContain(SECTION);
    expect(html).toContain("Õpilaste kogemused");
    expect(html).toContain("Soovitaksin kindlasti 5.");
    expect(html).toContain("Kati K.");
    expect(html).toContain("okt 2026");
    expect(html).toContain('href="/koolitused/kulmude-lami"');
    expect(html).toContain("Avaldame selle õpilase loal ja pärast kontrolli.");
    expect(html).not.toContain("Näita kõiki");
  });

  test("the section sits after the trainer section and before the practice and blog blocks", async () => {
    const { course: made } = await protocolCourse(db);
    await db.insert(pages).values({ key: "trainer_bio", title: { et: "Maria Sosnina" }, body: { et: "Maria lugu." } });
    await addReview(made.id, 5, { featured: true });
    const html = await home("et");
    const trainer = html.indexOf("Maria lugu.");
    const section = html.indexOf(SECTION);
    const contact = html.indexOf("Ei tea, milline koolitus sobib?");
    expect(trainer).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(trainer);
    expect(section).toBeLessThan(contact);
  });

  test("hidden, pending and not featured reviews never show; the newest featured first; at most six", async () => {
    const { course: made } = await protocolCourse(db);
    const { course: other } = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
    const rows = [];
    for (let i = 1; i <= HOME_REVIEWS_MAX + 2; i++) rows.push(await addReview(i % 2 ? other.id : made.id, i, { featured: true }));
    await addReview(made.id, 20, { featured: false });
    await addReview(made.id, 21, { featured: true, status: "hidden" });
    await addReview(made.id, 22, { featured: true, status: "pending", kind: "student", note: null });
    const html = await home("et");
    expect(shown(html)).toEqual(rows.slice(-HOME_REVIEWS_MAX).reverse().map((r) => r.id));
    // each one names its course, linked: the courses alternate
    expect(html).toContain('href="/koolitused/ripsmete-tostmine"');
    expect(html).toContain('href="/koolitused/kulmude-lami"');
  });

  test("the Russian home page: Russian heading and notice, the course in Russian and linked under /ru, the review as written", async () => {
    const { course: made } = await protocolCourse(db);
    await addReview(made.id, 5, { featured: true, text: "Soovitan kõigile.", locale: "et" });
    const html = await home("ru");
    expect(html).toContain("Опыт учеников");
    expect(html).toContain("Ламинирование бровей");
    expect(html).toContain('href="/ru/koolitused/kulmude-lami"');
    expect(html).toMatch(/<blockquote[^>]*lang="et"[^>]*><p>Soovitan kõigile\.<\/p>/);
    expect(html).not.toContain("Õpilaste kogemused");
  });
});
