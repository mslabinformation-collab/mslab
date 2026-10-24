import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { getCourseBySlug, listPublishedCourses } from "@/db/queries/public";
import * as schema from "@/db/schema";
import { courseImages, courseModules, courses, courseTests, lessons, type TestQuestion } from "@/db/schema";
import { createSession, deleteSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// The draft layer's preview on the public pages (admin UX pass piece 3a, Task 6; ruling R-h; README §1.8 „Eelvaade ↗“): with Next's draft mode on AND a live
// admin session, the course page and the catalogue show the course's drafts laid over its live data (the parts' values as „Avalda muudatused“ would
// store them, the modules and lessons in their working order with the flagged rows); every other request reads live. The test's answer key is never
// laid over. The admin's session cookie and draftMode (next/headers) are faked, the database is PGlite, as in tests/db/admin-eelvaade-route.test.ts.

const state = vi.hoisted(() => ({
  db: null as unknown,
  cookie: undefined as string | undefined,
  draftOn: false,
  /** How often anything looked for the admin's session cookie (a visitor's page in the static cache must never do). */
  cookieReads: 0,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      state.cookieReads++;
      return name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined;
    },
  }),
  draftMode: async () => ({
    get isEnabled() {
      return state.draftOn;
    },
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/public-cache", () => ({ revalidatePublic: vi.fn() }));
// (the registration form is a client component that reads the router, which a page rendered to HTML here has not got; notFound() stays the real one)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import CoursePage from "@/app/[locale]/(site)/koolitused/[slug]/page";

import { addLessonForm, addModuleForm, moveModuleForm, renameModuleForm } from "@/server/admin-lessons";
import { readCoursePart, writeCoursePart } from "@/server/course-parts";
import { previewActive } from "@/server/preview";

const ME = "maria@example.test";
const MARIA = { email: ME };
const NOW = new Date("2026-10-24T09:00:00Z");
const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const SECRET: TestQuestion = {
  id: "q9",
  kind: "choice",
  text: "Salajane küsimus",
  options: [{ id: "a", text: "Õige vastus", correct: true }, { id: "b", text: "Vale vastus", correct: false }],
};

let db: Db;
let online: { id: number };
let contact: { id: number };
let m1: number;
let m2: number;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  state.draftOn = false;
  state.cookieReads = 0;
  vi.stubEnv("ADMIN_EMAILS", ME);
  const base = { level: "basic" as const, summary: { et: "Elus kokkuvõte" }, body: { et: "Elus tekst" } };
  [online] = await db
    .insert(courses)
    .values({ ...base, slug: "e-kulm", type: "e_learning", title: { et: "E-kulm" }, price: 9500, accessMonths: 6, outcomes: [{ et: "Oskus A" }], published: true, sort: 1 })
    .returning();
  [contact] = await db
    .insert(courses)
    .values({ ...base, slug: "kulmude-lami", type: "contact", title: { et: "Kulmude LAMI" }, priceGroup: 22000, priceIndividual: 30000, durationLabel: { et: "6 ak" }, includes: [{ et: "Teooria" }], published: true, sort: 2 })
    .returning();
  await db.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustand" }, priceGroup: 10000, sort: 3 });
  await db.insert(courseTests).values({ courseId: online.id, questions: [{ id: "q1", kind: "choice", text: "Vana küsimus", options: [{ id: "a", text: "Jah", correct: true }, { id: "b", text: "Ei", correct: false }] }], passPercent: 80, tries: 3 });
  await db.insert(courseImages).values({ courseId: online.id, key: "/seed/brow-closeup.jpg", alt: { et: "Kulmud" }, sort: 0 });
  [{ id: m1 }, { id: m2 }] = await db.insert(courseModules).values([{ courseId: online.id, position: 1, title: { et: "Moodul 1" } }, { courseId: online.id, position: 2, title: { et: "Moodul 2" } }]).returning();
  await db.insert(lessons).values({ moduleId: m1, position: 1, title: { et: "Esimene" } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const idOf = (r: { ok: boolean; id?: number }) => {
  if (!r.ok || r.id === undefined) throw new Error(JSON.stringify(r));
  return r.id;
};
/** A part's save on a published course: it goes to the draft, live is left alone. */
async function draft(id: number, part: string, patch: Record<string, unknown>) {
  const { version } = (await readCoursePart(db, id, part as never))!;
  const saved = await writeCoursePart(db, id, part as never, patch, version, MARIA, NOW);
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
}
/** What the course page reads: its call, as the page makes it. */
const pageCourse = async (slug: string, o: { includeUnpublished?: boolean } = {}) => (await getCourseBySlug(db, slug, { ...o, drafts: await previewActive() }))!;
const catalogue = async () => listPublishedCourses(db, undefined, { drafts: await previewActive() });
const titles = (c: { moduleTitles: { et: string }[] }) => c.moduleTitles.map((t) => t.et);
/** Draft mode on and Maria signed in: her preview. */
async function asAdmin() {
  state.draftOn = true;
  state.cookie = await createSession(db, ME);
}

describe("previewActive (R-h): draft mode on and a live admin session", () => {
  test("draft mode off: false, and nothing looks for the session (a visitor's page stays in the static cache)", async () => {
    state.cookie = await createSession(db, ME); // a signed-in admin, but not in her preview
    state.cookieReads = 0;
    expect(await previewActive()).toBe(false);
    expect(state.cookieReads).toBe(0);
  });

  test("draft mode on and a live session of an allowed admin: true", async () => {
    await asAdmin();
    expect(await previewActive()).toBe(true);
  });

  test("draft mode on and no session (a visitor with the draft-mode cookie): false", async () => {
    state.draftOn = true;
    expect(await previewActive()).toBe(false);
    state.cookie = "not-a-session";
    expect(await previewActive()).toBe(false);
  });

  test("draft mode outlives logout: with the cookie still set, a session that was ended, one that expired, or one of an address taken off the list is false", async () => {
    await asAdmin();
    await deleteSession(db, state.cookie);
    expect(await previewActive()).toBe(false);
    state.cookie = await createSession(db, ME, new Date("2020-01-01T00:00:00Z"));
    expect(await previewActive()).toBe(false);
    state.cookie = await createSession(db, "former.admin@example.test");
    expect(await previewActive()).toBe(false);
    state.cookie = await createSession(db, ME);
    expect(await previewActive()).toBe(true);
    vi.stubEnv("ADMIN_EMAILS", "someone.else@example.test");
    expect(await previewActive()).toBe(false);
  });
});

describe("the course page's data (getCourseBySlug with the preview's drafts)", () => {
  async function drafted() {
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" } });
    // a new module with a lesson: real rows flagged `unpublished`, waiting for „Avalda muudatused“
    const m3 = idOf(await addModuleForm(db, form({ courseId: online.id, titleEt: "Moodul 3" })));
    idOf(await addLessonForm(db, form({ moduleId: m3, titleEt: "Uus tund" })));
  }

  test("draft mode on and an admin session: the draft title, and the flagged lesson's module", async () => {
    await drafted();
    await asAdmin();
    const page = await pageCourse("e-kulm");
    expect(page.title).toEqual({ et: "E-kulm (uus)" });
    expect(titles(page)).toEqual(["Moodul 1", "Moodul 2", "Moodul 3"]);
  });

  test("draft mode on and nobody signed in: live data (title and modules)", async () => {
    await drafted();
    state.draftOn = true;
    const page = await pageCourse("e-kulm");
    expect(page.title).toEqual({ et: "E-kulm" });
    expect(titles(page)).toEqual(["Moodul 1", "Moodul 2"]);
  });

  test("draft mode off: live data, and no session read", async () => {
    await drafted();
    state.cookie = await createSession(db, ME);
    state.cookieReads = 0;
    const page = await pageCourse("e-kulm");
    expect(page.title).toEqual({ et: "E-kulm" });
    expect(titles(page)).toEqual(["Moodul 1", "Moodul 2"]);
    expect(state.cookieReads).toBe(0);
  });

  test("the drafted parts are laid over as publishing would store them: texts trimmed, prices in cents, the outcomes, the badge", async () => {
    await draft(online.id, "basics", { summary: { et: "  Uus kokkuvõte " }, body: { et: "Uus tekst", ru: "Новый текст" } });
    await draft(online.id, "price", { price: "120,50", accessMonths: "12", nextDiscount: { et: "-10%" } });
    await draft(online.id, "outcomes", { outcomes: [{ et: "Oskus A" }, { et: "Oskus B" }] });
    await draft(online.id, "badge", { badge: { label: { et: "Uus" }, bg: "#ddd4dc", fg: "#000" } });
    await draft(online.id, "certificate", { certificateVolume: "10 akadeemilist tundi" });
    await draft(online.id, "protocolStages", { protocolStages: ["Algus"] });
    await asAdmin();
    const page = await pageCourse("e-kulm");
    expect(page).toMatchObject({
      summary: { et: "Uus kokkuvõte" },
      body: { et: "Uus tekst", ru: "Новый текст" },
      price: 12050,
      accessMonths: 12,
      nextDiscount: { et: "-10%" },
      outcomes: [{ et: "Oskus A" }, { et: "Oskus B" }],
      badge: { label: { et: "Uus" }, bg: "#DDD4DC", fg: "#222222" },
      certificateVolume: "10 akadeemilist tundi",
      protocolStages: ["Algus"],
    });
    // the rest is live's
    expect(page).toMatchObject({ title: { et: "E-kulm" }, slug: "e-kulm", type: "e_learning", published: true, id: online.id });
    // and the live row itself was never touched
    state.draftOn = false;
    expect(await pageCourse("e-kulm")).toMatchObject({ summary: { et: "Elus kokkuvõte" }, price: 9500, accessMonths: 6, outcomes: [{ et: "Oskus A" }], badge: null });
  });

  test("the gallery, the recommendations and a contact course's includes and prices", async () => {
    await draft(online.id, "gallery", { images: [{ key: UPLOAD, alt: { et: "Uus pilt" } }, { key: "/seed/brow-closeup.jpg", alt: { et: "Kulmud" } }] });
    await draft(online.id, "recommendations", { recommendationIds: [contact.id] });
    await draft(contact.id, "includes", { includes: [{ et: "Teooria" }, { et: "Praktika" }] });
    await draft(contact.id, "price", { priceGroup: "250", durationLabel: { et: "8 ak" } });
    await asAdmin();
    const e = await pageCourse("e-kulm");
    expect(e.images.map((i) => [i.key, i.alt])).toEqual([[UPLOAD, { et: "Uus pilt" }], ["/seed/brow-closeup.jpg", { et: "Kulmud" }]]);
    expect(e.recommendationIds).toEqual([contact.id]);
    const k = await pageCourse("kulmude-lami");
    expect(k).toMatchObject({ includes: [{ et: "Teooria" }, { et: "Praktika" }], priceGroup: 25000, priceIndividual: 30000, durationLabel: { et: "8 ak" } });
    state.draftOn = false;
    expect((await pageCourse("e-kulm")).images.map((i) => i.key)).toEqual(["/seed/brow-closeup.jpg"]);
    expect((await pageCourse("e-kulm")).recommendationIds).toEqual([]);
  });

  test("a course's drafts are laid over that course only", async () => {
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" } });
    await asAdmin();
    expect((await pageCourse("kulmude-lami")).title).toEqual({ et: "Kulmude LAMI" });
    expect((await pageCourse("kulmude-lami")).moduleTitles).toEqual([]);
  });

  test("the slug stays live: the page is found, and linked, by the address it has", async () => {
    await draft(online.id, "basics", { slug: "uus-aadress" });
    await asAdmin();
    expect(await getCourseBySlug(db, "uus-aadress", { drafts: true })).toBeNull();
    expect((await pageCourse("e-kulm")).slug).toBe("e-kulm");
  });

  test("a type change in the draft shows the course as the other type, with the other type's fields emptied", async () => {
    // (an e-course with lessons keeps its type: this one has none)
    const [empty] = await db
      .insert(courses)
      .values({ slug: "tyhi", type: "e_learning", level: "basic", title: { et: "Tühi" }, summary: { et: "" }, body: { et: "" }, price: 5000, accessMonths: 3, nextDiscount: { et: "-5%" }, published: true, sort: 4 })
      .returning();
    await draft(empty.id, "basics", { type: "contact" });
    await draft(empty.id, "includes", { includes: [{ et: "Kohtumine" }] });
    await asAdmin();
    // (no price part drafted: the type change alone empties the e-course's fields, as the publish's write does)
    expect(await pageCourse("tyhi")).toMatchObject({ type: "contact", price: null, accessMonths: null, nextDiscount: null, includes: [{ et: "Kohtumine" }] });
    await draft(empty.id, "price", { priceGroup: "180" });
    expect(await pageCourse("tyhi")).toMatchObject({ type: "contact", priceGroup: 18000, priceIndividual: null, price: null, includes: [{ et: "Kohtumine" }] });
    state.draftOn = false;
    expect(await pageCourse("tyhi")).toMatchObject({ type: "e_learning", price: 5000, nextDiscount: { et: "-5%" } });
  });

  test("a part its checks refuse now (a slug taken meanwhile) is left out as publishing would hold it; the other parts show", async () => {
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" }, slug: "vaba-aadress" });
    await draft(online.id, "outcomes", { outcomes: [{ et: "Oskus Z" }] });
    await db.update(courses).set({ slug: "vaba-aadress" }).where(eq(courses.id, contact.id));
    await asAdmin();
    const page = await pageCourse("e-kulm");
    expect(page.title).toEqual({ et: "E-kulm" });
    expect(page.outcomes).toEqual([{ et: "Oskus Z" }]);
  });

  test("the test's answer key is never laid over: not the draft's, not live's", async () => {
    await draft(online.id, "test", { questions: [SECRET], passPercent: "90" });
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" } });
    await asAdmin();
    const page = await pageCourse("e-kulm");
    const json = JSON.stringify(page) + JSON.stringify(await catalogue());
    expect(page.title).toEqual({ et: "E-kulm (uus)" });
    for (const secret of ["Salajane küsimus", "Õige vastus", "Vale vastus", "Vana küsimus", "correct", "questions", "passPercent"]) expect(json, secret).not.toContain(secret);
  });

  test("the modules: a rename and a move wait in the outline draft, a new module shows where it will be; students' list (draft mode off) is live's", async () => {
    idOf(await renameModuleForm(db, form({ id: m1, titleEt: "Sissejuhatus" }), MARIA));
    const m3 = idOf(await addModuleForm(db, form({ courseId: online.id, titleEt: "Kordamine" })));
    await asAdmin();
    expect(titles(await pageCourse("e-kulm"))).toEqual(["Sissejuhatus", "Moodul 2", "Kordamine"]);
    // a move of a live module is a draft move too (Task 5): „Moodul 2“ goes before the renamed first one; the new module keeps its place at the end
    idOf(await moveModuleForm(db, form({ id: m2, dir: "up" }), MARIA));
    expect(titles(await pageCourse("e-kulm"))).toEqual(["Moodul 2", "Sissejuhatus", "Kordamine"]);
    // and the new module moves directly, to the front
    idOf(await moveModuleForm(db, form({ id: m3, dir: "up" }), MARIA));
    idOf(await moveModuleForm(db, form({ id: m3, dir: "up" }), MARIA));
    expect(titles(await pageCourse("e-kulm"))).toEqual(["Kordamine", "Moodul 2", "Sissejuhatus"]);
    state.draftOn = false;
    expect(titles(await pageCourse("e-kulm"))).toEqual(["Moodul 1", "Moodul 2"]);
  });

  test("the admin's contact-course read (includeUnpublished) lists the flagged modules only in the preview", async () => {
    const [{ id: pm }] = await db.insert(courseModules).values({ courseId: contact.id, position: 1, title: { et: "Teooria" } }).returning();
    idOf(await addModuleForm(db, form({ courseId: contact.id, titleEt: "Praktika" })));
    expect(pm).toBeGreaterThan(0);
    expect(titles((await getCourseBySlug(db, "kulmude-lami", { includeUnpublished: true }))!)).toEqual(["Teooria"]);
    await asAdmin();
    expect(titles(await pageCourse("kulmude-lami", { includeUnpublished: true }))).toEqual(["Teooria", "Praktika"]);
  });

  test("an unpublished course has no drafts to show, and the public page does not find it either way", async () => {
    await asAdmin();
    expect(await pageCourse("mustand")).toBeNull();
    expect((await pageCourse("mustand", { includeUnpublished: true })).title).toEqual({ et: "Mustand" });
  });
});

describe("the catalogue (listPublishedCourses with the preview's drafts)", () => {
  test("the courses with drafts show them, in the same order; the others and a visitor's list are live", async () => {
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" } });
    await draft(contact.id, "price", { priceGroup: "250" });
    await asAdmin();
    const list = await catalogue();
    expect(list.map((c) => [c.slug, c.title.et, c.price ?? c.priceGroup])).toEqual([["e-kulm", "E-kulm (uus)", 9500], ["kulmude-lami", "Kulmude LAMI", 25000]]);
    expect(list[0].images.map((i) => i.key)).toEqual(["/seed/brow-closeup.jpg"]);
    state.draftOn = false;
    expect((await catalogue()).map((c) => [c.slug, c.title.et, c.price ?? c.priceGroup])).toEqual([["e-kulm", "E-kulm", 9500], ["kulmude-lami", "Kulmude LAMI", 22000]]);
    state.draftOn = true;
    state.cookie = undefined;
    expect((await catalogue())[0].title.et).toBe("E-kulm");
  });
});

describe("the answer key stays out of the preview's reads (Task 6 review, M-2)", () => {
  test("the test part's draft is left out in the query and the course's test row is not read at all", async () => {
    const log: { query: string; params: unknown[] }[] = [];
    const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string, params: unknown[]) => void log.push({ query, params }) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    state.db = logged;
    const [c] = await logged
      .insert(courses)
      .values({ slug: "e-kulm", type: "e_learning", level: "basic", title: { et: "E-kulm" }, summary: { et: "" }, body: { et: "" }, price: 9500, accessMonths: 6, published: true })
      .returning();
    await logged.insert(courseTests).values({ courseId: c.id, questions: [SECRET], passPercent: 80, tries: 3 });
    const saved = async (part: string, patch: Record<string, unknown>) => {
      const { version } = (await readCoursePart(logged, c.id, part as never))!;
      expect((await writeCoursePart(logged, c.id, part as never, patch, version, MARIA, NOW)).ok).toBe(true);
    };
    await saved("test", { passPercent: "90" });
    await saved("basics", { title: { et: "E-kulm (uus)" } });
    log.length = 0;
    const page = (await getCourseBySlug(logged, "e-kulm", { drafts: true }))!;
    expect(page.title).toEqual({ et: "E-kulm (uus)" });
    const draftReads = log.filter((q) => /from "content_drafts"/.test(q.query));
    expect(draftReads.length).toBeGreaterThan(0);
    // every read of the drafts is limited by part: the parts' drafts without the test's, or the outline's alone (the module titles); none takes them all
    for (const read of draftReads) {
      if (/"part" not in \(/.test(read.query)) expect(read.params).toEqual(expect.arrayContaining(["test", "outline"]));
      else {
        expect(read.query).toMatch(/"part" in \(/);
        expect(read.params).toEqual(expect.not.arrayContaining(["test"]));
      }
    }
    expect(draftReads.map((r) => /"part" not in \(/.test(r.query))).toContain(true);
    expect(log.filter((q) => /"course_tests"/.test(q.query))).toEqual([]);
  });
});

describe("the preview bar on the course page (Task 6 review: spec C3, Part 4)", () => {
  const html = (locale: "et" | "ru", slug = "e-kulm") => CoursePage({ params: Promise.resolve({ locale, slug }) }).then((tree) => renderToStaticMarkup(tree));
  const BAR = "data-preview-bar";

  test("in the admin's preview: „Avaldamata 4“ (every label the PublishBar counts), the way out to this page, „Loobu muudatustest“", async () => {
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" }, summary: { et: "Uus kokkuvõte" } });
    await draft(online.id, "outcomes", { outcomes: [{ et: "Oskus Z" }] });
    idOf(await addModuleForm(db, form({ courseId: online.id, titleEt: "Moodul 3" })));
    await asAdmin();
    const page = await html("et");
    expect(page).toContain(BAR);
    expect(page).toContain("E-kulm (uus)");
    expect(page).toContain("Avaldamata 4");
    expect(page).toContain("Loobu muudatustest");
    expect(page).toContain("Vaata kodulehte");
    // the way out ends draft mode and comes back to this very page, as a visitor sees it
    expect(page).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2Fkoolitused%2Fe-kulm"');
    expect(page).toContain('data-fab-avoid=""');
    // the Russian page leaves to the Russian page
    expect(await html("ru")).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2Fru%2Fkoolitused%2Fe-kulm"');
  });

  test("in the preview with nothing unpublished: the way out only", async () => {
    await asAdmin();
    const page = await html("et");
    expect(page).toContain(BAR);
    expect(page).not.toContain("data-preview-count");
    expect(page).not.toContain("Loobu muudatustest");
    expect(page).toContain("Vaata kodulehte");
  });

  test("never for a visitor: draft mode off, or draft mode on without an admin session (the page shows the live data and no bar)", async () => {
    await draft(online.id, "basics", { title: { et: "E-kulm (uus)" } });
    state.cookie = await createSession(db, ME);
    const off = await html("et");
    state.draftOn = true;
    state.cookie = undefined;
    const stranger = await html("et");
    for (const page of [off, stranger]) {
      expect(page).not.toContain(BAR);
      expect(page).not.toContain("Loobu muudatustest");
      expect(page).not.toContain("eelvaade?lopeta");
      expect(page).not.toContain("E-kulm (uus)");
      expect(page).toContain("E-kulm");
    }
  });
});

describe("the ISR pages", () => {
  const ROOT = "src/app/[locale]/(site)/koolitused";
  test.each([`${ROOT}/page.tsx`, `${ROOT}/[slug]/page.tsx`])("%s reaches the draft mode and the session only through previewActive()", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("previewActive()");
    // a cookie, a header or a session read of its own would make the page dynamic for every visitor
    expect(src).not.toMatch(/next\/headers|currentAdminEmail|requireAdmin|cookies\(|headers\(|draftMode/);
  });
});
