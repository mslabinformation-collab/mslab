import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { contentDrafts, courseAreas, courses } from "@/db/schema";
import { contentVersion } from "@/lib/version";
import { makeTestDb } from "./helpers";

// Seaded → „Valdkonnad“ (course areas, spec 2026-11-11-course-areas-filter-design.md §4.1; server/course-areas.ts): Maria's list of training areas.
// Each row's names autosave from the row's own version (the stale-save check); „Lisa valdkond“, the moves and „Kustuta“ are explicit and answer the
// list as it is after them. Both names are required (at most 60 characters, trimmed); the Estonian names are unique by the slug the address uses; an
// area that a course uses — live or in a draft of its „Põhiinfo“ — is never deleted. A change revalidates the calendar and the catalogue (their
// chips). On a real (PGlite) database whose migrations seed the two areas of 0024: „Kulmukoolitused“ (id 1) and „Ripsmekoolitused“ (id 2).

const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { addArea, deleteArea, moveAreaTo, readAdminAreas, writeAreaName } from "@/server/course-areas";

const NOW = new Date("2026-11-11T09:00:00Z");
const KULM = 1;
const RIPS = 2;

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  pub.revalidatePublic.mockReset();
});

const revalidated = () => pub.revalidatePublic.mock.calls.map((c) => c[0]);
const stored = () => db.select({ id: courseAreas.id, name: courseAreas.name, sort: courseAreas.sort }).from(courseAreas).orderBy(asc(courseAreas.sort), asc(courseAreas.id));
const names = async () => (await stored()).map((a) => a.name.et);
const versionOf = async (id: number) => (await readAdminAreas(db)).find((a) => a.id === id)!.version;

async function course(slug: string, areaId: number | null, published = false) {
  const [c] = await db
    .insert(courses)
    .values({ slug, type: "contact", level: "basic", title: { et: slug }, summary: { et: "" }, body: { et: "" }, areaId, published, sort: 1 })
    .returning();
  return c;
}

describe("the list as Seaded reads it", () => {
  test("in Maria's order, each with both names, its version (the hash of its names) and how many courses use it", async () => {
    await course("a", KULM);
    await course("b", KULM, true);
    const areas = await readAdminAreas(db);
    expect(areas).toEqual([
      { id: KULM, name: { et: "Kulmukoolitused", ru: "Курсы по бровям" }, version: await contentVersion({ et: "Kulmukoolitused", ru: "Курсы по бровям" }), used: 2 },
      { id: RIPS, name: { et: "Ripsmekoolitused", ru: "Курсы по ресницам" }, version: await contentVersion({ et: "Ripsmekoolitused", ru: "Курсы по ресницам" }), used: 0 },
    ]);
  });

  test("a course counts once per area: live, or in its „Põhiinfo“ draft (a published course whose draft moves it elsewhere counts for both)", async () => {
    const c = await course("c", KULM, true);
    await db.insert(contentDrafts).values({ entity: "course", entityId: c.id, part: "basics", value: { areaId: RIPS }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    const d = await course("d", KULM, true);
    await db.insert(contentDrafts).values({ entity: "course", entityId: d.id, part: "basics", value: { areaId: KULM }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    // (another part's draft, or another entity's, names no area)
    await db.insert(contentDrafts).values({ entity: "post", entityId: d.id, part: "basics", value: { areaId: RIPS }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    expect((await readAdminAreas(db)).map((a) => [a.id, a.used])).toEqual([
      [KULM, 2],
      [RIPS, 1],
    ]);
  });
});

describe("a row's names, autosaved from its version", () => {
  test("a name saved: trimmed and on one line, a new version; the calendar and the catalogue revalidated", async () => {
    const answer = await writeAreaName(db, KULM, { et: "  Kulmud\n ja laminatsioon " }, await versionOf(KULM), NOW);
    const after = { et: "Kulmud ja laminatsioon", ru: "Курсы по бровям" };
    expect(answer).toEqual({ ok: true, version: await contentVersion(after), savedAt: NOW.toISOString() });
    expect((await stored())[0].name).toEqual(after);
    expect(revalidated()).toEqual([{ kind: "areas" }]);
  });

  test("the same names again: the version stays, nothing written or revalidated", async () => {
    const version = await versionOf(RIPS);
    expect(await writeAreaName(db, RIPS, { ru: " Курсы по ресницам " }, version, NOW)).toEqual({ ok: true, version, savedAt: NOW.toISOString() });
    expect(revalidated()).toEqual([]);
  });

  test("from another version (another tab saved meanwhile): a conflict with the names as stored", async () => {
    const first = await versionOf(KULM);
    expect((await writeAreaName(db, KULM, { ru: "Брови" }, first, NOW)).ok).toBe(true);
    expect(await writeAreaName(db, KULM, { et: "Kulm" }, first, NOW)).toEqual({ ok: false, error: "conflict", version: await versionOf(KULM), value: { et: "Kulmukoolitused", ru: "Брови" } });
    expect(await names()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
  });

  test("a name left empty, one too long, or the Estonian name of another area (by its slug: case and accents aside) is refused in its field", async () => {
    const version = await versionOf(KULM);
    expect(await writeAreaName(db, KULM, { et: "  ", ru: "x".repeat(61) }, version, NOW)).toEqual({ ok: false, error: "invalid", fields: { et: "required", ru: "tooLong" } });
    expect(await writeAreaName(db, KULM, { et: "RIPSMEKOOLITUSED" }, version, NOW)).toEqual({ ok: false, error: "invalid", fields: { et: "taken" } });
    expect(await writeAreaName(db, KULM, { et: "Ripsme koolitused" }, version, NOW)).toMatchObject({ ok: true });
    // its own name in another case is no clash
    expect(await writeAreaName(db, RIPS, { et: "ripsmekoolitused" }, await versionOf(RIPS), NOW)).toMatchObject({ ok: true });
    expect(await names()).toEqual(["Ripsme koolitused", "ripsmekoolitused"]);
  });
});

describe("„Lisa valdkond“", () => {
  test("a new area goes last with both names; the answer is the list with its id", async () => {
    const answer = await addArea(db, { et: " Meik ", ru: "Макияж" });
    expect(answer).toMatchObject({ ok: true, id: expect.any(Number) });
    if (!answer.ok) throw new Error("refused");
    expect(answer.areas.map((a) => [a.name.et, a.used])).toEqual([
      ["Kulmukoolitused", 0],
      ["Ripsmekoolitused", 0],
      ["Meik", 0],
    ]);
    expect((await stored()).at(-1)).toEqual({ id: answer.id, name: { et: "Meik", ru: "Макияж" }, sort: 3 });
    expect(revalidated()).toEqual([{ kind: "areas" }]);
  });

  test("refused with its fields: a name missing or too long, an Estonian name another area has; a body that is no names", async () => {
    expect(await addArea(db, { et: "Meik", ru: "" })).toEqual({ ok: false, error: "invalid", fields: { ru: "required" } });
    expect(await addArea(db, { et: "x".repeat(61), ru: "y" })).toEqual({ ok: false, error: "invalid", fields: { et: "tooLong" } });
    expect(await addArea(db, { et: "Kulmukoolitused ", ru: "Брови" })).toEqual({ ok: false, error: "invalid", fields: { et: "taken" } });
    expect(await addArea(db, { et: "Meik" })).toEqual({ ok: false, error: "invalid", fields: { ru: "required" } });
    expect(await addArea(db, null)).toEqual({ ok: false, error: "invalid", fields: { et: "required", ru: "required" } });
    // (read defensively: a name that is no text is none; any other key is not read)
    expect(await addArea(db, { et: 1, ru: "x", extra: true })).toEqual({ ok: false, error: "invalid", fields: { et: "required" } });
    expect(await names()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
    expect(revalidated()).toEqual([]);
  });
});

describe("the moves", () => {
  test("an area to a place (0 is the first; past the end: last): the list renumbered in its new order", async () => {
    const meik = await addArea(db, { et: "Meik", ru: "Макияж" });
    if (!meik.ok) throw new Error("refused");
    pub.revalidatePublic.mockReset();
    const answer = await moveAreaTo(db, meik.id!, 0);
    expect(answer.ok && answer.areas.map((a) => a.name.et)).toEqual(["Meik", "Kulmukoolitused", "Ripsmekoolitused"]);
    expect((await stored()).map((a) => a.sort)).toEqual([1, 2, 3]);
    expect(revalidated()).toEqual([{ kind: "areas" }]);
    await moveAreaTo(db, meik.id!, 99);
    expect(await names()).toEqual(["Kulmukoolitused", "Ripsmekoolitused", "Meik"]);
  });

  test("a move to where it is changes nothing; an area that is not there is notFound", async () => {
    const answer = await moveAreaTo(db, KULM, 0);
    expect(answer.ok && answer.areas.map((a) => a.id)).toEqual([KULM, RIPS]);
    expect(revalidated()).toEqual([]);
    expect(await moveAreaTo(db, 99, 0)).toEqual({ ok: false, error: "notFound" });
  });
});

describe("„Kustuta“", () => {
  test("an area no course uses goes; the answer is the list without it", async () => {
    const answer = await deleteArea(db, RIPS);
    expect(answer.ok && answer.areas.map((a) => a.id)).toEqual([KULM]);
    expect(await names()).toEqual(["Kulmukoolitused"]);
    expect(revalidated()).toEqual([{ kind: "areas" }]);
    expect(await deleteArea(db, RIPS)).toEqual({ ok: false, error: "notFound" });
  });

  test("refused while a course uses it, live or in a draft: how many say so, and the area stays", async () => {
    await course("live", RIPS);
    expect(await deleteArea(db, RIPS)).toMatchObject({ ok: false, error: "inUse", used: 1 });
    const c = await course("draft", null, true);
    await db.insert(contentDrafts).values({ entity: "course", entityId: c.id, part: "basics", value: { areaId: KULM }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    const answer = await deleteArea(db, KULM);
    expect(answer).toMatchObject({ ok: false, error: "inUse", used: 1 });
    expect(await names()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
    expect(revalidated()).toEqual([]);
    // the draft thrown away, or the course moved to „Määramata“: then it can go
    await db.delete(contentDrafts).where(eq(contentDrafts.entityId, c.id));
    expect((await deleteArea(db, KULM)).ok).toBe(true);
  });
});
