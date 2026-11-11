import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseAreas, courseSessions, courses } from "@/db/schema";
import { makeTestDb } from "./helpers";

// The area chips on the public pages (course areas, spec 2026-11-11-course-areas-filter-design.md §5): the calendar's (/koolituskalender) and the
// catalogue's (/koolitused) read the area list once and keep the areas their list has, in Maria's order, named in the page's language, shown only for
// two or more. The migration's two areas („Kulmukoolitused“ sort 1, „Ripsmekoolitused“ sort 2) are the database's; the pages are rendered to HTML
// against PGlite, as in tests/db/course-preview.test.ts. What a chip does in the browser is tests/unit/calendar-list-dom.test.ts and
// tests/unit/catalogue-filters-dom.test.ts.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), draftMode: async () => ({ isEnabled: false }) }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import CataloguePage from "@/app/[locale]/(site)/koolitused/page";
import CalendarPage from "@/app/[locale]/(site)/koolituskalender/page";

let db: Db;
let brows: number;
let lashes: number;
let third: number;

const base = { level: "basic" as const, summary: { et: "Kokkuvõte" }, body: { et: "Tekst" }, published: true };
async function contactCourse(slug: string, title: string, areaId: number | null, sort: number, published = true) {
  const [c] = await db
    .insert(courses)
    .values({ ...base, slug, type: "contact", title: { et: title, ru: `${title} RU` }, priceGroup: 20000, durationLabel: { et: "6 ak" }, areaId, sort, published })
    .returning();
  return c.id;
}
async function eCourse(slug: string, title: string, areaId: number | null, sort: number) {
  const [c] = await db.insert(courses).values({ ...base, slug, type: "e_learning", title: { et: title }, price: 9500, accessMonths: 6, areaId, sort }).returning();
  return c.id;
}
const soon = (days: number) => new Date(Date.now() + days * 86_400_000);
async function session(courseId: number, city: string, days: number) {
  await db.insert(courseSessions).values({ courseId, startsAt: soon(days), city, venue: "Stuudio" });
}

const calendar = (locale: "et" | "ru") => CalendarPage({ params: Promise.resolve({ locale }) }).then((tree) => renderToStaticMarkup(tree));
const catalogue = (locale: "et" | "ru") => CataloguePage({ params: Promise.resolve({ locale }) }).then((tree) => renderToStaticMarkup(tree));
/** The buttons of the filter row that `marker` starts (its attribute), in their order; null when the page has no such row. */
function rowButtons(html: string, marker: string): string[] | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const end = html.indexOf("</div>", at);
  return [...html.slice(at, end).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
}
const groupLabel = (html: string, marker: string) => /aria-label="([^"]*)"[^>]*$/.exec(html.slice(0, html.indexOf(marker)))?.[1] ?? null;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  const areas = await db.select().from(courseAreas).orderBy(courseAreas.sort);
  [brows, lashes] = areas.map((a) => a.id);
  [{ id: third }] = await db.insert(courseAreas).values({ name: { et: "Meigikoolitused", ru: "Курсы макияжа" }, sort: 3 }).returning();
});

describe("the calendar's area chips (§5.1)", () => {
  test("the areas its dates have, in Maria's order (not the dates'), after „Kõik“, below the city chips; Russian names on /ru", async () => {
    await session(await contactCourse("ripsmed", "Ripsmepikendus", lashes, 1), "Tallinn", 3);
    await session(await contactCourse("kulmud", "Kulmude laminatsioon", brows, 2), "Pärnu", 5);
    await session(await contactCourse("meik", "Meik", null, 3), "Pärnu", 7);
    const et = await calendar("et");
    expect(rowButtons(et, "data-city-filter")?.slice(0, 3)).toEqual(["Kõik", "Pärnu", "Tallinn"]);
    expect(rowButtons(et, "data-area-filter")).toEqual(["Kõik", "Kulmukoolitused", "Ripsmekoolitused"]);
    expect(groupLabel(et, "data-area-filter")).toBe("Valdkond");
    expect(et.indexOf("data-city-filter")).toBeLessThan(et.indexOf("data-area-filter"));
    // („Meigikoolitused“ has no date: not offered)
    expect(et).not.toContain("Meigikoolitused");
    const ru = await calendar("ru");
    expect(rowButtons(ru, "data-area-filter")).toEqual(["Все", "Курсы по бровям", "Курсы по ресницам"]);
    expect(groupLabel(ru, "data-area-filter")).toBe("Направление");
  });

  test("one area among the dates (the others' courses have none, or no date, or are hidden): no area row", async () => {
    await session(await contactCourse("kulmud", "Kulmude laminatsioon", brows, 1), "Pärnu", 5);
    await session(await contactCourse("kulmud-2", "Kulmude värvimine", brows, 2), "Tallinn", 6);
    await session(await contactCourse("meik", "Meik", null, 3), "Pärnu", 7);
    await contactCourse("ripsmed", "Ripsmepikendus", lashes, 4); // no date
    await session(await contactCourse("peidus", "Peidus", third, 5, false), "Tartu", 8); // not published
    await eCourse("e-ripsmed", "E-ripsmed", lashes, 6); // an e-course is never in the calendar
    const et = await calendar("et");
    expect(rowButtons(et, "data-city-filter")?.slice(0, 3)).toEqual(["Kõik", "Pärnu", "Tallinn"]);
    expect(rowButtons(et, "data-area-filter")).toBeNull();
  });
});

describe("the catalogue's area chips (§5.2)", () => {
  test("the areas its courses have, in Maria's order, after the level chips, „Kõik“ first; Russian names on /ru", async () => {
    await eCourse("e-ripsmed", "E-ripsmed", lashes, 1);
    await contactCourse("meik", "Meik", third, 2);
    await contactCourse("kulmud", "Kulmude laminatsioon", brows, 3);
    await contactCourse("peidus", "Peidus", null, 4);
    const et = await catalogue("et");
    expect(rowButtons(et, 'data-filter-row="area"')).toEqual(["Kõik", "Kulmukoolitused", "Ripsmekoolitused", "Meigikoolitused"]);
    expect(groupLabel(et, 'data-filter-row="area"')).toBe("Valdkond");
    expect(et.indexOf('data-filter-row="level"')).toBeLessThan(et.indexOf('data-filter-row="area"'));
    const ru = await catalogue("ru");
    expect(rowButtons(ru, 'data-filter-row="area"')).toEqual(["Все", "Курсы по бровям", "Курсы по ресницам", "Курсы макияжа"]);
  });

  test("one area among the published courses: no area row", async () => {
    await eCourse("e-kulmud", "E-kulmud", brows, 1);
    await contactCourse("kulmud", "Kulmude laminatsioon", brows, 2);
    await contactCourse("ripsmed", "Ripsmepikendus", lashes, 3, false); // not published
    await contactCourse("meik", "Meik", null, 4);
    const et = await catalogue("et");
    expect(et).toContain('data-filter-row="level"');
    expect(rowButtons(et, 'data-filter-row="area"')).toBeNull();
  });
});
