import { PGlite } from "@electric-sql/pglite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { getCourseForEdit } from "@/db/queries/admin";
import { getCourseBySlug } from "@/db/queries/public";
import * as schema from "@/db/schema";
import { contentDrafts, courseImages, courseModules, courses, courseSessions, courseTests, lessonFiles, lessons, type TestQuestion } from "@/db/schema";
import { contentVersion } from "@/lib/version";
import { readDrafts } from "@/server/drafts";
import { makeTestDb } from "./helpers";

// A course's parts on the draft layer (admin UX pass piece 3a, Task 4; constraints R-a…R-e; README B2, §1.8): a published course is edited in
// `content_drafts` part by part and published with one press, an unpublished one saves each part straight to the record (spec §10). The versions are
// R-b's (as amended by the Task 4 review, I-1): "l:<the live part's hash>" while the part has no draft, "d:<the draft row's id>.<its counter>" once
// it has one, so no draft ever has an earlier draft's version. On a real (PGlite) database; the public pages' revalidation is a spy.

const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import {
  COURSE_PARTS, courseChanges, coursePublisher, discardCourse, partLabels, publishCourse, readCourseEditor, readCoursePart, switchCoursePublished, switchCourseSample, writeCoursePart,
} from "@/server/course-parts";

const MARIA = { email: "maria@example.test" };
const DIM = { email: "dim@example.test" };
const NOW = new Date("2026-10-24T09:00:00Z");
const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const QUESTION: TestQuestion = { id: "q1", kind: "choice", text: "Vana küsimus", options: [{ id: "a", text: "Jah", correct: true }, { id: "b", text: "Ei", correct: false }] };

let db: Db;
/** A published e-course with a test, a published contact course and an unpublished contact course. */
let online: { id: number };
let contact: { id: number };
let hidden: { id: number };

async function fixtures(d: Db) {
  const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
  [online] = await d.insert(courses).values({ ...base, slug: "e-kulm", type: "e_learning", title: { et: "E-kulm" }, price: 9500, accessMonths: 6, published: true, sort: 1 }).returning();
  [contact] = await d
    .insert(courses)
    .values({ ...base, slug: "kulmude-lami", type: "contact", title: { et: "Kulmude LAMI" }, priceGroup: 22000, priceIndividual: 30000, durationLabel: { et: "6 ak" }, includes: [{ et: "Teooria" }], published: true, sort: 2 })
    .returning();
  [hidden] = await d.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustand" }, priceGroup: 10000, sort: 3 }).returning();
  await d.insert(courseTests).values({ courseId: online.id, questions: [QUESTION], passPercent: 80, tries: 3 });
  await d.insert(courseImages).values({ courseId: online.id, key: "/seed/brow-closeup.jpg", alt: { et: "Kulmud" }, sort: 0 });
}

beforeEach(async () => {
  db = await makeTestDb();
  await fixtures(db);
  pub.revalidatePublic.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const read = async (id: number, part: string) => (await readCoursePart(db, id, part as never))!;
const write = (id: number, part: string, patch: Record<string, unknown>, version: string, admin = MARIA) => writeCoursePart(db, id, part as never, patch, version, admin, NOW);
const row = async (id: number) => (await db.select().from(courses).where(eq(courses.id, id)))[0];
const drafts = (id: number) => readDrafts(db, "course", id);
const revalidated = () => pub.revalidatePublic.mock.calls.map((c) => c[0]);
/** The part's draft version as its editor holds it: "d:<the draft row's id>.<its counter>"; null without a draft. */
async function dv(id: number, part: string): Promise<string | null> {
  const [d] = await db
    .select({ id: contentDrafts.id, version: contentDrafts.version })
    .from(contentDrafts)
    .where(and(eq(contentDrafts.entity, "course"), eq(contentDrafts.entityId, id), eq(contentDrafts.part, part)));
  return d ? `d:${d.id}.${d.version}` : null;
}
const FIRST = /^d:[1-9][0-9]*.1$/;

describe("the parts (R-a) and their versions (R-b)", () => {
  test("the parts of R-a, in screen order; each part's live version is l: and the hash of its live value", async () => {
    expect([...COURSE_PARTS]).toEqual(["basics", "price", "outcomes", "outline", "includes", "protocolStages", "test", "certificate", "gallery", "recommendations", "badge"]);
    const basics = await read(online.id, "basics");
    expect(basics.value).toEqual({ title: { et: "E-kulm" }, slug: "e-kulm", level: "basic", language: "ET", summary: { et: "" }, body: { et: "" }, type: "e_learning" });
    expect(basics.version).toBe(`l:${await contentVersion(basics.value)}`);
    expect((await read(online.id, "price")).value).toEqual({ price: "95", accessMonths: "6", videoCount: "", nextDiscount: { et: "" }, priceGroup: "", priceIndividual: "", durationLabel: { et: "" } });
    expect((await read(online.id, "test")).value).toEqual({ questions: [QUESTION], passPercent: "80", tries: "3" });
    expect((await read(online.id, "gallery")).value).toEqual({ images: [{ key: "/seed/brow-closeup.jpg", alt: { et: "Kulmud" } }] });
    expect((await read(contact.id, "includes")).value).toEqual({ includes: [{ et: "Teooria" }] });
    expect(await readCoursePart(db, 999_999, "basics")).toBeNull();
  });

  test("partLabels: a field by its visible label without a unit (P-3), a list or a card by its card title", () => {
    expect(partLabels("basics", { summary: { et: "x" } })).toEqual(["Lühikirjeldus"]);
    expect(partLabels("basics", { type: "contact", title: { et: "x" } })).toEqual(["Koolituse nimi", "Õppevorm"]);
    expect(partLabels("price", { price: "1" })).toEqual(["Hind"]);
    expect(partLabels("price", { priceGroup: "2", accessMonths: "1" })).toEqual(["Ligipääs", "Grupikoolituse hind"]);
    expect(partLabels("outcomes", { outcomes: [] })).toEqual(["Õpiväljundid"]);
    expect(partLabels("includes", { includes: [] })).toEqual(["Koolitus sisaldab"]);
    expect(partLabels("test", { questions: [] })).toEqual(["Teadmiste test"]);
    expect(partLabels("badge", { badge: null })).toEqual(["Koolituse märgis"]);
    expect(partLabels("gallery", {})).toEqual([]);
  });
});

describe("a published course: the parts save to drafts and go live with „Avalda muudatused“", () => {
  test("a basics save on l:<hash> creates a draft (based on the live hash); the live title is unchanged", async () => {
    const before = await read(online.id, "basics");
    const saved = await write(online.id, "basics", { title: { et: "E-kulm (uus)" } }, before.version);
    const first = (await dv(online.id, "basics"))!;
    expect(first).toMatch(FIRST);
    expect(saved).toEqual({ ok: true, version: first, savedAt: NOW.toISOString() });
    expect((await row(online.id)).title).toEqual({ et: "E-kulm" });
    expect(await drafts(online.id)).toEqual([expect.objectContaining({ part: "basics", version: 1, baseVersion: before.version.slice(2), value: { ...(before.value as object), title: { et: "E-kulm (uus)" } } })]);
    expect((await db.select({ by: contentDrafts.updatedBy }).from(contentDrafts))[0].by).toBe(MARIA.email);
    // the editor reads the draft from now on
    expect(await read(online.id, "basics")).toEqual({ version: first, value: { ...(before.value as object), title: { et: "E-kulm (uus)" } } });
    // a save that changes nothing makes no draft
    const price = await read(online.id, "price");
    expect(await write(online.id, "price", { price: "95" }, price.version)).toEqual({ ok: true, version: price.version, savedAt: NOW.toISOString() });
    expect((await drafts(online.id)).map((d) => d.part)).toEqual(["basics"]);
  });

  test("a second save on the draft's version updates it (d:<id>.1 → d:<id>.2); typing the live text back drops the draft", async () => {
    const before = await read(online.id, "basics");
    await write(online.id, "basics", { title: { et: "E-kulm (uus)" } }, before.version);
    const first = (await dv(online.id, "basics"))!;
    const second = first.replace(/.1$/, ".2");
    expect(await write(online.id, "basics", { summary: { et: "Lühike" } }, first)).toEqual({ ok: true, version: second, savedAt: NOW.toISOString() });
    expect((await read(online.id, "basics")).value).toMatchObject({ title: { et: "E-kulm (uus)" }, summary: { et: "Lühike" } });
    // back to the live value: no draft is left, the part is at its live version again
    expect(await write(online.id, "basics", { title: { et: "E-kulm" }, summary: { et: "" } }, second)).toEqual({ ok: true, version: before.version, savedAt: NOW.toISOString() });
    expect(await drafts(online.id)).toEqual([]);
  });

  test("a save on a stale l: (or any other version) is a conflict with what is stored; two tabs never save over each other", async () => {
    const live = await read(online.id, "basics");
    expect(await write(online.id, "basics", { title: { et: "X" } }, `l:${"0".repeat(32)}`)).toEqual({ ok: false, error: "conflict", version: live.version, value: live.value });
    for (const junk of ["", "d:1", "d:1.1", "x", live.version.slice(2)]) expect((await write(online.id, "basics", { title: { et: "X" } }, junk)).ok, junk).toBe(false);
    // tab B made the draft first: tab A's save on the live version is a conflict with B's draft, and changes nothing
    expect((await write(online.id, "basics", { title: { et: "Teise akna nimi" } }, live.version, DIM)).ok).toBe(true);
    const theirs = await read(online.id, "basics");
    expect(theirs.version).toMatch(FIRST);
    expect(await write(online.id, "basics", { title: { et: "Minu nimi" } }, live.version)).toEqual({ ok: false, error: "conflict", version: theirs.version, value: theirs.value });
    expect(await write(online.id, "basics", { title: { et: "Minu nimi" } }, theirs.version.replace(/.1$/, ".2"))).toEqual({ ok: false, error: "conflict", version: theirs.version, value: theirs.value });
    expect((await read(online.id, "basics")).value).toMatchObject({ title: { et: "Teise akna nimi" } });
    expect((await row(online.id)).title).toEqual({ et: "E-kulm" });
  });

  // Review I-1 (Review Focus 1, "never a silent overwrite"): every draft's counter starts at 1, so a draft made after an earlier one ended (published,
  // discarded, typed back to live) must not take a tab still on the earlier draft's "d:…" as its own. Both tabs on the same draft, then:
  test.each([
    ["published", () => publishCourse(db, online.id, NOW)],
    ["discarded", () => discardCourse(db, online.id)],
  ] as const)("the draft %s, tab A types on (a new draft): tab B's save on the old draft's version is a conflict, never written", async (_name, end) => {
    await write(online.id, "basics", { title: { et: "A1" } }, (await read(online.id, "basics")).version, MARIA);
    const tabB = (await read(online.id, "basics")).version;
    await end();
    const a2 = await write(online.id, "basics", { title: { et: "A2" } }, (await read(online.id, "basics")).version, MARIA);
    expect(a2).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    expect(a2.ok && a2.version).not.toBe(tabB);
    const now = await read(online.id, "basics");
    expect(await write(online.id, "basics", { title: { et: "B, vana aken" } }, tabB, DIM)).toEqual({ ok: false, error: "conflict", version: now.version, value: now.value });
    expect((await read(online.id, "basics")).value).toMatchObject({ title: { et: "A2" } });
  });

  test("the draft typed back to live (dropped), tab A types on: tab B's save on the old draft's version is a conflict, never written", async () => {
    const live = (await read(online.id, "basics")).version;
    await write(online.id, "basics", { title: { et: "X" } }, live, MARIA);
    const tabB = (await read(online.id, "basics")).version;
    expect(await write(online.id, "basics", { title: { et: "E-kulm" } }, tabB, MARIA)).toEqual({ ok: true, version: live, savedAt: NOW.toISOString() });
    expect(await write(online.id, "basics", { title: { et: "Y" } }, live, MARIA)).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    const now = await read(online.id, "basics");
    expect(now.version).not.toBe(tabB);
    expect(await write(online.id, "basics", { title: { et: "B, vana aken" } }, tabB, DIM)).toEqual({ ok: false, error: "conflict", version: now.version, value: now.value });
    expect((await read(online.id, "basics")).value).toMatchObject({ title: { et: "Y" } });
    expect((await row(online.id)).title).toEqual({ et: "E-kulm" });
  });

  test("review M-1: an old published course without a price still publishes a title; only a type change must bring the price", async () => {
    await db.update(courses).set({ price: null }).where(eq(courses.id, online.id));
    await write(online.id, "basics", { title: { et: "Uus nimi" } }, (await read(online.id, "basics")).version);
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: ["basics"], blocked: [] });
    expect((await row(online.id)).title).toEqual({ et: "Uus nimi" });
    // the price part itself still must not be left empty, nor a type change without the new type's price
    await write(online.id, "price", { videoCount: "3" }, (await read(online.id, "price")).version);
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: [], blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] });
  });

  test("publishing writes the title, deletes the draft and revalidates once; the other tab's next save is a conflict with the published text", async () => {
    const live = await read(online.id, "basics");
    await write(online.id, "basics", { title: { et: "E-kulm (uus)" } }, live.version);
    const tab = (await dv(online.id, "basics"))!;
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: ["basics"], blocked: [] });
    expect(await row(online.id)).toMatchObject({ title: { et: "E-kulm (uus)" }, published: true });
    expect((await row(online.id)).updatedAt.toISOString()).toBe(NOW.toISOString()); // the old editor's stale guard sees the change
    expect(await drafts(online.id)).toEqual([]);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
    const now = await read(online.id, "basics");
    expect(now.version).toBe(`l:${await contentVersion(now.value)}`);
    expect(await write(online.id, "basics", { title: { et: "Vana aken" } }, tab)).toEqual({ ok: false, error: "conflict", version: now.version, value: now.value });
    // nothing to publish: no revalidation
    pub.revalidatePublic.mockClear();
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: [], blocked: [] });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a part whose live value changed after its draft began is blocked with „changed“ and keeps its draft; the others are published", async () => {
    const basics = await read(online.id, "basics");
    await write(online.id, "basics", { summary: { et: "Uus lühikirjeldus" } }, basics.version);
    const outcomes = await read(online.id, "outcomes");
    await write(online.id, "outcomes", { outcomes: [{ et: "Oskab kulme" }] }, outcomes.version);
    // live basics changes another way meanwhile (the old editor's „Salvesta“, another tab's publish)
    await db.update(courses).set({ level: "advanced" }).where(eq(courses.id, online.id));
    const result = await publishCourse(db, online.id, NOW);
    expect(result.published).toEqual(["outcomes"]);
    expect(result.blocked).toEqual([{ part: "basics", reason: "changed", fields: expect.arrayContaining(["Lühikirjeldus"]) }]);
    expect(await row(online.id)).toMatchObject({ level: "advanced", summary: { et: "" }, outcomes: [{ et: "Oskab kulme" }] });
    expect((await drafts(online.id)).map((d) => d.part)).toEqual(["basics"]);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
  });

  test("clearing the price in the draft is saved (a draft may wait), but blocks the publish with „missing“ and fields [hind]", async () => {
    const price = await read(online.id, "price");
    expect(await write(online.id, "price", { price: "" }, price.version)).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: [], blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] });
    expect((await row(online.id)).price).toBe(9500);
    expect((await drafts(online.id)).map((d) => d.part)).toEqual(["price"]);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a type change without the new type's price is blocked as missing; with it, both go live and the other type's fields are emptied", async () => {
    const basics = await read(contact.id, "basics");
    expect(await write(contact.id, "basics", { type: "e_learning" }, basics.version)).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    expect(await publishCourse(db, contact.id, NOW)).toEqual({ published: [], blocked: [{ part: "basics", reason: "missing", fields: ["hind"] }] });
    expect((await row(contact.id)).type).toBe("contact");
    // the price card follows the drafted type: an e-course's fields are checked
    const price = await read(contact.id, "price");
    expect(await write(contact.id, "price", { price: "abc" }, price.version)).toEqual({ ok: false, error: "invalid", fields: { price: "amount" } });
    expect(await write(contact.id, "price", { price: "150", accessMonths: "12" }, price.version)).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    expect(await publishCourse(db, contact.id, NOW)).toEqual({ published: ["basics", "price"], blocked: [] });
    expect(await row(contact.id)).toMatchObject({ type: "e_learning", price: 15000, accessMonths: 12, priceGroup: null, priceIndividual: null, durationLabel: null, includes: [] });
  });

  test("the type lock holds in the draft: a course with a session keeps its type", async () => {
    await db.insert(courseSessions).values({ courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" });
    const basics = await read(contact.id, "basics");
    expect(await write(contact.id, "basics", { type: "e_learning" }, basics.version)).toEqual({ ok: false, error: "invalid", fields: { type: "typeLocked" } });
    expect(await drafts(contact.id)).toEqual([]);
  });

  test("a slug taken by another course is refused at the save with the existing slug error; a field error names the field", async () => {
    const basics = await read(online.id, "basics");
    expect(await write(online.id, "basics", { slug: "kulmude-lami" }, basics.version)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugTaken" } });
    expect(await write(online.id, "basics", { title: { et: " " } }, basics.version)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await write(online.id, "basics", { slug: "", title: { et: "Kulmude LAMI" } }, basics.version)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugTaken" } });
    expect(await drafts(online.id)).toEqual([]);
    // an empty slug is made from the title (its own title's slug is its own); a later title whose slug is taken is refused at the title too, the
    // field the save carries (else the screen could not hold anything back)
    expect(await write(online.id, "basics", { slug: "" }, basics.version)).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    expect(await write(online.id, "basics", { title: { et: "Kulmude LAMI" } }, (await dv(online.id, "basics"))!)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugTaken", title: "slugTaken" } });
    expect((await read(online.id, "basics")).value).toMatchObject({ slug: "", title: { et: "E-kulm" } });
  });

  test("a slug another course took after the draft was saved blocks the publish (changed meanwhile), never a 500", async () => {
    const basics = await read(hidden.id, "basics");
    expect((await write(hidden.id, "basics", { slug: "uus-aadress" }, basics.version)).ok).toBe(true); // unpublished: live
    const online0 = await read(online.id, "basics");
    expect((await write(online.id, "basics", { slug: "teine-aadress" }, online0.version)).ok).toBe(true);
    await db.update(courses).set({ slug: "teine-aadress" }).where(eq(courses.id, hidden.id));
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: [], blocked: [{ part: "basics", reason: "changed", fields: ["Aadress"] }] });
    expect((await row(online.id)).slug).toBe("e-kulm");
  });

  test("discard deletes the drafts and leaves live untouched", async () => {
    await write(online.id, "basics", { title: { et: "Uus" } }, (await read(online.id, "basics")).version);
    await write(online.id, "price", { price: "120" }, (await read(online.id, "price")).version);
    const live = await row(online.id);
    expect((await discardCourse(db, online.id)).discarded).toBe(2);
    expect(await drafts(online.id)).toEqual([]);
    expect(await row(online.id)).toEqual(live);
    expect((await read(online.id, "basics")).version).toMatch(/^l:[0-9a-f]{32}$/);
    expect((await discardCourse(db, online.id)).discarded).toBe(0);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("discard also deletes the rows flagged unpublished (R-e) and returns their videos and files for the cleanup", async () => {
    const [mod, flaggedMod] = await db
      .insert(courseModules)
      .values([
        { courseId: online.id, position: 1, title: { et: "Moodul 01" } },
        { courseId: online.id, position: 2, title: { et: "Moodul 02" }, unpublished: true },
      ])
      .returning();
    const [kept, newLesson, inNewModule] = await db
      .insert(lessons)
      .values([
        { moduleId: mod.id, position: 1, title: { et: "Avaldatud" }, videoId: "v-kept" },
        { moduleId: mod.id, position: 2, title: { et: "Uus" }, unpublished: true, videoId: "v-new", replacedVideoId: "v-old" },
        { moduleId: flaggedMod.id, position: 1, title: { et: "Uus moodulis" }, unpublished: true },
      ])
      .returning();
    await db.insert(lessonFiles).values([
      { lessonId: kept.id, r2Key: "lessons/kept.pdf", name: "kept.pdf", size: 1, contentType: "application/pdf", position: 1 },
      { lessonId: inNewModule.id, r2Key: "lessons/new.pdf", name: "new.pdf", size: 1, contentType: "application/pdf", position: 1 },
    ]);
    expect(await discardCourse(db, online.id)).toEqual({ discarded: 3, cleanup: { videoIds: expect.arrayContaining(["v-new", "v-old"]), fileKeys: ["lessons/new.pdf"] } });
    expect((await db.select({ id: lessons.id }).from(lessons).orderBy(asc(lessons.id))).map((l) => l.id)).toEqual([kept.id]);
    expect((await db.select({ id: courseModules.id }).from(courseModules)).map((m) => m.id)).toEqual([mod.id]);
    expect(newLesson.id).toBeGreaterThan(0);
    // nothing flagged and no draft: nothing to clean
    expect(await discardCourse(db, online.id)).toEqual({ discarded: 0, cleanup: { videoIds: [], fileKeys: [] } });
  });

  test("courseChanges: the changed fields' labels per part, in screen order", async () => {
    expect(await courseChanges(db, online.id)).toEqual([]);
    await write(online.id, "price", { price: "120" }, (await read(online.id, "price")).version);
    await write(online.id, "gallery", { images: [] }, (await read(online.id, "gallery")).version);
    await write(online.id, "basics", { summary: { et: "Lühike" } }, (await read(online.id, "basics")).version);
    expect(await courseChanges(db, online.id)).toEqual([
      { part: "basics", labels: ["Lühikirjeldus"] },
      { part: "price", labels: ["Hind"] },
      { part: "gallery", labels: ["Galerii"] },
    ]);
    // an unpublished course has no drafts to list
    expect(await courseChanges(db, hidden.id)).toEqual([]);
  });

  test("the answer key: the test part's draft never appears in getCourseBySlug's result", async () => {
    const test0 = await read(online.id, "test");
    const secret = { id: "q2", kind: "choice", text: "Salajane küsimus", options: [{ id: "a", text: "Õige vastus", correct: true }, { id: "b", text: "Vale", correct: false }] };
    expect(await write(online.id, "test", { questions: [QUESTION, secret] }, test0.version)).toMatchObject({ ok: true, version: expect.stringMatching(FIRST) });
    const page = JSON.stringify(await getCourseBySlug(db, "e-kulm"));
    for (const leak of ["Salajane küsimus", "Õige vastus", "Vana küsimus", "\"correct\""]) expect(page).not.toContain(leak);
    expect((await getCourseForEdit(db, online.id))!.test!.questions).toEqual([QUESTION]); // live is the old test until „Avalda muudatused“
    expect(await publishCourse(db, online.id, NOW)).toEqual({ published: ["test"], blocked: [] });
    expect((await getCourseForEdit(db, online.id))!.test!.questions.map((q) => q.text)).toEqual(["Vana küsimus", "Salajane küsimus"]);
    expect(JSON.stringify(await getCourseBySlug(db, "e-kulm"))).not.toContain("Salajane küsimus");
  });

  test("coursePublisher publishes through the draft layer on its own (publishDrafts)", async () => {
    const { publishDrafts } = await import("@/server/drafts");
    await write(online.id, "outcomes", { outcomes: [{ et: "Üks" }] }, (await read(online.id, "outcomes")).version);
    expect(await publishDrafts(db, "course", online.id, coursePublisher(online.id))).toEqual({ published: ["outcomes"], blocked: [] });
    expect((await row(online.id)).outcomes).toEqual([{ et: "Üks" }]);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
  });
});

describe("an unpublished course: a part saves straight to the record (spec §10)", () => {
  test("a save writes live at once, with no draft row; the next save goes on from the new live version", async () => {
    const basics = await read(hidden.id, "basics");
    const saved = await write(hidden.id, "basics", { title: { et: " Uus nimi " } }, basics.version);
    expect(saved).toMatchObject({ ok: true });
    expect((await row(hidden.id)).title).toEqual({ et: "Uus nimi" });
    expect(await drafts(hidden.id)).toEqual([]);
    const now = await read(hidden.id, "basics");
    expect(saved.ok && saved.version).toBe(now.version);
    expect(now.version).toBe(`l:${await contentVersion(now.value)}`);
    // the old version is a conflict (another tab saved), the new one goes on
    expect(await write(hidden.id, "basics", { summary: { et: "x" } }, basics.version)).toEqual({ ok: false, error: "conflict", version: now.version, value: now.value });
    expect((await write(hidden.id, "basics", { summary: { et: "x" } }, now.version)).ok).toBe(true);
    expect(pub.revalidatePublic).not.toHaveBeenCalled(); // nothing public shows it
  });

  test("the existing course rules: the type's own fields, the other type's emptied at a type change, the checks per field", async () => {
    const price = await read(hidden.id, "price");
    expect(await write(hidden.id, "price", { priceGroup: "abc", priceIndividual: "-5" }, price.version)).toEqual({ ok: false, error: "invalid", fields: { priceGroup: "amount", priceIndividual: "amount" } });
    expect(await write(hidden.id, "price", { priceGroup: "", priceIndividual: "" }, price.version)).toMatchObject({ ok: true }); // unpublished: a price may wait
    const outcomes = await read(hidden.id, "outcomes");
    expect(await write(hidden.id, "outcomes", { outcomes: [{ et: "", ru: "Без эстонского" }] }, outcomes.version)).toEqual({ ok: false, error: "invalid", fields: { outcomes: "listEt" } });
    const includes = await read(hidden.id, "includes");
    expect((await write(hidden.id, "includes", { includes: [{ et: " Teooria " }, { et: "" }] }, includes.version)).ok).toBe(true);
    expect((await row(hidden.id)).includes).toEqual([{ et: "Teooria" }]);
    await db.update(courses).set({ priceGroup: 10000, durationLabel: { et: "8 ak" } }).where(eq(courses.id, hidden.id));
    // the type change empties the contact fields (a course is e-learning or contact, never both)
    expect((await write(hidden.id, "basics", { type: "e_learning" }, (await read(hidden.id, "basics")).version)).ok).toBe(true);
    expect(await row(hidden.id)).toMatchObject({ type: "e_learning", priceGroup: null, priceIndividual: null, durationLabel: null, includes: [] });
    const e = await read(hidden.id, "price");
    expect(await write(hidden.id, "price", { price: "49,90", accessMonths: "0" }, e.version)).toEqual({ ok: false, error: "invalid", fields: { accessMonths: "whole" } });
    expect((await write(hidden.id, "price", { price: "49,90", accessMonths: "3" }, e.version)).ok).toBe(true);
    expect(await row(hidden.id)).toMatchObject({ price: 4990, accessMonths: 3 });
    // and back: the e-course's fields go, its test row too
    await db.insert(courseTests).values({ courseId: hidden.id, questions: [QUESTION] });
    await db.update(courses).set({ certificateSkills: ["Oskus"], certificateVolume: "10 ak" }).where(eq(courses.id, hidden.id));
    expect((await write(hidden.id, "basics", { type: "contact" }, (await read(hidden.id, "basics")).version)).ok).toBe(true);
    expect(await row(hidden.id)).toMatchObject({ type: "contact", price: null, accessMonths: null, videoCount: null, nextDiscount: null, certificateSkills: [], certificateVolume: "" });
    expect(await db.select().from(courseTests).where(eq(courseTests.courseId, hidden.id))).toEqual([]);
  });

  test("the test, the certificate, the gallery, the badge and the recommendations write their own rows and columns", async () => {
    await db.update(courses).set({ type: "e_learning" }).where(eq(courses.id, hidden.id));
    const t = await read(hidden.id, "test");
    expect(await write(hidden.id, "test", { questions: [{ ...QUESTION, options: [{ id: "a", text: "Jah", correct: false }] }] }, t.version)).toEqual({ ok: false, error: "invalid", fields: { questions: "testOptions" } });
    expect(await write(hidden.id, "test", { passPercent: "0" }, t.version)).toEqual({ ok: false, error: "invalid", fields: { passPercent: "whole" } });
    expect(await write(hidden.id, "test", { questions: [QUESTION, QUESTION] }, t.version)).toMatchObject({ ok: false, error: "invalid", fields: { questions: expect.any(String) } });
    expect((await write(hidden.id, "test", { questions: [QUESTION], tries: "5" }, t.version)).ok).toBe(true);
    expect((await db.select().from(courseTests).where(eq(courseTests.courseId, hidden.id)))[0]).toMatchObject({ questions: [QUESTION], passPercent: 80, tries: 5 });
    expect((await write(hidden.id, "certificate", { certificateSkills: [" Oskab ", ""], certificateVolume: "10 ak" }, (await read(hidden.id, "certificate")).version)).ok).toBe(true);
    expect(await row(hidden.id)).toMatchObject({ certificateSkills: ["Oskab"], certificateVolume: "10 ak" });
    expect((await write(hidden.id, "gallery", { images: [{ key: UPLOAD, alt: { et: "Uus" } }] }, (await read(hidden.id, "gallery")).version)).ok).toBe(true);
    expect((await db.select().from(courseImages).where(eq(courseImages.courseId, hidden.id))).map((i) => [i.key, i.sort, i.alt])).toEqual([[UPLOAD, 0, { et: "Uus" }]]);
    expect(await write(hidden.id, "gallery", { images: [{ key: "https://evil.example/a.jpg", alt: { et: "" } }] }, (await read(hidden.id, "gallery")).version)).toEqual({ ok: false, error: "invalid", fields: { images: "image" } });
    expect((await write(hidden.id, "badge", { badge: { label: { et: "Uus" }, bg: "#ddd4dc", fg: "#000" } }, (await read(hidden.id, "badge")).version)).ok).toBe(true);
    expect((await row(hidden.id)).badge).toEqual({ label: { et: "Uus" }, bg: "#DDD4DC", fg: "#222222" });
    const recs = await read(hidden.id, "recommendations");
    expect((await write(hidden.id, "recommendations", { recommendationIds: [online.id, hidden.id, 999_999] }, recs.version)).ok).toBe(true);
    expect((await row(hidden.id)).recommendationIds).toEqual([online.id]);
    expect((await write(hidden.id, "protocolStages", { protocolStages: [" Ettevalmistus ", ""] }, (await read(hidden.id, "protocolStages")).version)).ok).toBe(true);
    expect((await row(hidden.id)).protocolStages).toEqual(["Ettevalmistus"]);
  });

  test("text Postgres cannot store is cleaned before it is stored (no 500 that would be tried again for good)", async () => {
    expect((await write(online.id, "basics", { summary: { et: "a\u0000b\ud800c" } }, (await read(online.id, "basics")).version)).ok).toBe(true);
    expect((await read(online.id, "basics")).value).toMatchObject({ summary: { et: "abc" } });
    expect((await write(hidden.id, "basics", { summary: { et: "x\u0000y" } }, (await read(hidden.id, "basics")).version)).ok).toBe(true);
    expect((await row(hidden.id)).summary).toEqual({ et: "xy" });
  });
});

describe("R-d: the „Avaldatud“ switch", () => {
  test("switching off with a pending title draft publishes it, then unpublishes, in one go; revalidated once", async () => {
    await write(online.id, "basics", { title: { et: "Viimane nimi" } }, (await read(online.id, "basics")).version);
    expect(await switchCoursePublished(db, online.id, false, NOW)).toEqual({ ok: true });
    expect(await row(online.id)).toMatchObject({ title: { et: "Viimane nimi" }, published: false });
    expect(await drafts(online.id)).toEqual([]);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
    // off is off: a price may now be cleared live (an unpublished course needs none)
    expect((await write(online.id, "price", { price: "" }, (await read(online.id, "price")).version)).ok).toBe(true);
  });

  test("a blocked part refuses the switch: nothing is published and nothing unpublished", async () => {
    await write(online.id, "basics", { summary: { et: "Uus" } }, (await read(online.id, "basics")).version);
    await write(online.id, "outcomes", { outcomes: [{ et: "Oskab" }] }, (await read(online.id, "outcomes")).version);
    await db.update(courses).set({ summary: { et: "Vahepeal" } }).where(eq(courses.id, online.id));
    expect(await switchCoursePublished(db, online.id, false, NOW)).toEqual({ ok: false, error: "blocked", blocked: [{ part: "basics", reason: "changed", fields: ["Lühikirjeldus"] }] });
    expect(await row(online.id)).toMatchObject({ published: true, summary: { et: "Vahepeal" }, outcomes: [] });
    expect((await drafts(online.id)).map((d) => d.part)).toEqual(["basics", "outcomes"]);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a price cleared in the draft does not block switching off (an unpublished course needs no price)", async () => {
    await write(online.id, "price", { price: "" }, (await read(online.id, "price")).version);
    expect(await switchCoursePublished(db, online.id, false, NOW)).toEqual({ ok: true });
    expect(await row(online.id)).toMatchObject({ price: null, published: false });
  });

  test("switching on keeps today's price rule", async () => {
    await db.update(courses).set({ priceGroup: null }).where(eq(courses.id, hidden.id));
    expect(await switchCoursePublished(db, hidden.id, true, NOW)).toEqual({ ok: false, error: "invalid", fields: { priceGroup: "priceRequired" } });
    expect((await row(hidden.id)).published).toBe(false);
    await db.update(courses).set({ priceIndividual: 30000 }).where(eq(courses.id, hidden.id));
    expect(await switchCoursePublished(db, hidden.id, true, NOW)).toEqual({ ok: true });
    expect((await row(hidden.id)).published).toBe(true);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
    // the same state again changes nothing
    pub.revalidatePublic.mockClear();
    expect(await switchCoursePublished(db, hidden.id, true, NOW)).toEqual({ ok: true });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(await switchCoursePublished(db, 999_999, true, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  test("„Näidissisu“ is an instant switch of its own", async () => {
    expect(await switchCourseSample(db, online.id, true, NOW)).toEqual({ ok: true });
    expect((await row(online.id)).isSample).toBe(true);
    expect(await switchCourseSample(db, online.id, false, NOW)).toEqual({ ok: true });
    expect((await row(online.id)).isSample).toBe(false);
    expect(await drafts(online.id)).toEqual([]);
    expect(await switchCourseSample(db, 999_999, true, NOW)).toEqual({ ok: false, error: "notFound" });
  });
});

describe("the lock order (ledger T11, 40P01): the course row first, then content_drafts", () => {
  /** A fresh migrated database that records every query it runs (drizzle's logger), with the fixtures; it replaces `db`. */
  async function useLoggedDb(): Promise<string[]> {
    const log: string[] = [];
    const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void log.push(query) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    db = logged;
    await fixtures(db);
    log.length = 0;
    return log;
  }
  const courseLock = (log: string[]) => log.findIndex((q) => /^select [\s\S]* from "courses" where "courses"."id" = \$1 for update$/.test(q));
  const draftsTouched = (log: string[]) => log.findIndex((q) => /"content_drafts"/.test(q));

  test("writeCoursePart, publishCourse, discardCourse and the switch each lock the course before they touch content_drafts", async () => {
    const log = await useLoggedDb();
    const live = (await read(online.id, "basics")).version;
    const unpublished = (await read(hidden.id, "basics")).version;
    // each run is made first (its versions read before the log starts), then run
    const runs: [string, () => Promise<() => Promise<unknown>>][] = [
      ["write", async () => () => write(online.id, "basics", { title: { et: "Uus" } }, live)],
      ["write d:", async () => {
        const draft = (await dv(online.id, "basics"))!;
        return () => write(online.id, "basics", { title: { et: "Uuem" } }, draft);
      }],
      ["publish", async () => () => publishCourse(db, online.id, NOW)],
      ["discard", async () => () => discardCourse(db, online.id)],
      ["switch off", async () => () => switchCoursePublished(db, contact.id, false, NOW)],
    ];
    for (const [name, make] of runs) {
      const run = await make();
      log.length = 0;
      expect(await run(), name).not.toEqual(expect.objectContaining({ ok: false }));
      const lock = courseLock(log);
      expect(lock, name).toBeGreaterThanOrEqual(0);
      expect(draftsTouched(log), name).toBeGreaterThan(lock);
    }
    // an unpublished course's save writes live under the same lock and never reads a draft
    log.length = 0;
    expect(await write(hidden.id, "basics", { title: { et: "Uus" } }, unpublished)).toMatchObject({ ok: true });
    expect(courseLock(log)).toBeGreaterThanOrEqual(0);
    expect(courseLock(log)).toBeLessThan(log.findIndex((q) => /^update "courses"/.test(q)));
    expect(draftsTouched(log)).toBe(-1);
    // the publish: the lock, then the drafts FOR UPDATE, then the live reads its versions come from
    await write(online.id, "outcomes", { outcomes: [{ et: "Üks" }] }, (await read(online.id, "outcomes")).version);
    log.length = 0;
    expect((await publishCourse(db, online.id, NOW)).published).toEqual(["outcomes"]);
    const draftsLock = log.findIndex((q) => /from "content_drafts" [\s\S]*for update/.test(q));
    const liveRead = log.findIndex((q, i) => i > courseLock(log) && /from "course_images"/.test(q));
    const written = log.findIndex((q) => /^update "courses"/.test(q));
    expect([courseLock(log) < draftsLock, courseLock(log) < liveRead, draftsLock < written, liveRead < written]).toEqual([true, true, true, true]);
  });
});

describe("the editor's start (Task 7): every card's part at once", () => {
  test("each part's version and value as its card reads it (readCoursePart), with live's value beside it; the outline's labels; null for no course", async () => {
    await write(online.id, "basics", { summary: { et: "Uus" } }, (await read(online.id, "basics")).version);
    const state = (await readCourseEditor(db, online.id))!;
    expect(Object.keys(state.parts)).toEqual(COURSE_PARTS.filter((p) => p !== "outline"));
    for (const part of Object.keys(state.parts)) {
      const one = await read(online.id, part);
      expect(state.parts[part as keyof typeof state.parts], part).toMatchObject({ version: one.version, value: one.value });
    }
    // the draft's value is the card's, live's stays beside it (the PublishBar's compare)
    expect(state.parts.basics.value.summary).toEqual({ et: "Uus" });
    expect(state.parts.basics.live.summary).toEqual({ et: "" });
    expect(state.parts.price.live).toEqual(state.parts.price.value);
    // the answer key is in the admin's editor (its test card), never elsewhere
    expect(state.parts.test.value.questions).toEqual([QUESTION]);
    expect(state.outline).toEqual([]);
    // a new module waiting on the published course: the outline's labels (Moodul 01)
    await db.insert(courseModules).values({ courseId: online.id, position: 1, title: { et: "Uus moodul" }, unpublished: true });
    expect((await readCourseEditor(db, online.id))!.outline).toEqual(["Moodul 01"]);
    // an unpublished course: live, and no labels
    const off = (await readCourseEditor(db, hidden.id))!;
    expect(off.parts.basics.value).toEqual(off.parts.basics.live);
    expect(off.outline).toEqual([]);
    expect(await readCourseEditor(db, 999_999)).toBeNull();
  });
});
