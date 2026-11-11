import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { certificateDesigns, contentDrafts, courses } from "@/db/schema";
import {
  certificateDesignsCard, createCertificateDesign, deleteCertificateDesign, designUsage, listCertificateDesigns, readCertificateDesign, writeCertificateDesign,
} from "@/server/certificate-designs";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1) against a real (PGlite) database: the list (by sort, then id) with
// how many courses use each design (an e-course's pick, live or in its draft; an e-course with no pick uses the first design), „Lisa kujundus“, a
// row's autosave (its own version: the stale-save check; the name required, at most 40 characters and unique; the tone; the photo a JPEG of at most
// 1.5 MB that is in the store) and „Kustuta“, refused while a course uses the design and for the last one.

const PHOTO = [...readFileSync("tests/fixtures/certificate-background.jpg")];
const KEY = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const PNG_KEY = "img/1f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const BIG_KEY = "img/2f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const MISSING_KEY = "img/3f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";

let db: Db;
let store: ReturnType<typeof fakeMediaStore>;
beforeEach(async () => {
  db = await makeTestDb();
  store = fakeMediaStore({
    [KEY]: { bytes: PHOTO, contentType: "image/jpeg" },
    [PNG_KEY]: { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], contentType: "image/jpeg" },
    [BIG_KEY]: { bytes: [0xff, 0xd8, 0xff, 0xe0, ...new Array(1.5 * 1024 * 1024).fill(0)], contentType: "image/jpeg" },
  });
});

const designs = () => listCertificateDesigns(db);
const byName = async (name: string) => (await designs()).find((d) => d.name === name)!;
const read = async (id: number) => (await readCertificateDesign(db, id))!;
const save = async (id: number, patch: Record<string, unknown>) => writeCertificateDesign(db, id, patch, (await read(id)).version, store);
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
const ecourse = async (slug: string, over: Partial<typeof courses.$inferInsert> = {}) =>
  (await db.insert(courses).values({ ...base, slug, type: "e_learning", title: { et: slug }, price: 9500, ...over }).returning())[0];

describe("the list", () => {
  test("by sort, then id: „Hele“ and „Tume“ from the migration; each with its version and the courses using it", async () => {
    expect((await designs()).map((d) => [d.name, d.tone, d.backgroundKey])).toEqual([["Hele", "light", ""], ["Tume", "dark", ""]]);
    await db.insert(certificateDesigns).values({ name: "Hall", tone: "dark", sort: 1 });
    expect((await designs()).map((d) => d.name)).toEqual(["Hele", "Hall", "Tume"]);
    const card = await certificateDesignsCard(db);
    expect(card.map((d) => d.name)).toEqual(["Hele", "Hall", "Tume"]);
    for (const d of card) expect(d.version).toBe((await read(d.id)).version);
    expect(card.map((d) => d.courses)).toEqual([0, 0, 0]);
  });

  test("the courses using a design: an e-course's pick, live or in its draft (each course once); an e-course with no pick uses the first; a contact course none", async () => {
    const hele = await byName("Hele");
    const tume = await byName("Tume");
    await ecourse("a"); // no pick: the first
    await ecourse("b", { certificateDesignId: tume.id });
    const c = await ecourse("c", { certificateDesignId: tume.id, published: true });
    // c's draft goes back to none (the first): c uses both until it is published
    await db.insert(contentDrafts).values({ entity: "course", entityId: c.id, part: "certificate", value: { certificateDesignId: null }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    const d = await ecourse("d", { published: true });
    await db.insert(contentDrafts).values({ entity: "course", entityId: d.id, part: "certificate", value: { certificateDesignId: tume.id }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    // a draft that does not name the pick leaves the live one
    const e = await ecourse("e", { certificateDesignId: tume.id, published: true });
    await db.insert(contentDrafts).values({ entity: "course", entityId: e.id, part: "certificate", value: { certificateVolume: "10 ak" }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    await db.insert(courses).values({ ...base, slug: "k", type: "contact", title: { et: "K" }, priceGroup: 100 });
    const usage = await designUsage(db, await designs());
    expect([usage.get(hele.id), usage.get(tume.id)]).toEqual([3, 4]);
  });
});

describe("„Lisa kujundus“", () => {
  test("a new light design without a photo, last, named „Uus kujundus“ (then „Uus kujundus 2“, …: the names stay unique)", async () => {
    const first = await createCertificateDesign(db);
    const second = await createCertificateDesign(db);
    expect((await designs()).map((d) => [d.name, d.tone, d.backgroundKey])).toEqual([
      ["Hele", "light", ""],
      ["Tume", "dark", ""],
      ["Uus kujundus", "light", ""],
      ["Uus kujundus 2", "light", ""],
    ]);
    expect((await designs()).slice(2).map((d) => d.id)).toEqual([first.id, second.id]);
  });
});

describe("a row's autosave", () => {
  test("the name trimmed (one space), the tone and the photo; the answer's version is the one read next; the same again writes nothing", async () => {
    const tume = await byName("Tume");
    const answer = await save(tume.id, { name: "  Öine   kujundus ", tone: "light", backgroundKey: KEY });
    expect(answer).toEqual({ ok: true, version: (await read(tume.id)).version, savedAt: expect.any(String) });
    expect(await byName("Öine kujundus")).toMatchObject({ tone: "light", backgroundKey: KEY });
    expect((await read(tume.id)).value).toEqual({ name: "Öine kujundus", tone: "light", backgroundKey: KEY });
    const before = (await read(tume.id)).version;
    expect(await save(tume.id, { name: "Öine kujundus" })).toMatchObject({ ok: true, version: before });
    // no photo again
    expect((await save(tume.id, { backgroundKey: "" })).ok).toBe(true);
    expect((await read(tume.id)).value).toMatchObject({ backgroundKey: "" });
  });

  test("the refusals, each on its field: a name empty, over 40 or another design's (any case); a tone that is none; a photo that is no JPEG upload, not in the store, not a JPEG or over 1.5 MB", async () => {
    const tume = await byName("Tume");
    const fields = async (patch: Record<string, unknown>) => {
      const a = await save(tume.id, patch);
      return a.ok ? null : a.error === "invalid" ? a.fields : a.error;
    };
    expect(await fields({ name: "   " })).toEqual({ name: "required" });
    expect(await fields({ name: "x".repeat(41) })).toEqual({ name: "tooLong" });
    expect(await fields({ name: "hele" })).toEqual({ name: "taken" });
    expect(await fields({ tone: "grey" })).toEqual({ tone: "invalid" });
    expect(await fields({ backgroundKey: "/seed/certificate-white.jpg" })).toEqual({ backgroundKey: "image" });
    expect(await fields({ backgroundKey: "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.png" })).toEqual({ backgroundKey: "image" });
    expect(await fields({ backgroundKey: MISSING_KEY })).toEqual({ backgroundKey: "image" });
    expect(await fields({ backgroundKey: PNG_KEY })).toEqual({ backgroundKey: "image" });
    expect(await fields({ backgroundKey: BIG_KEY })).toEqual({ backgroundKey: "image" });
    // no store (production without R2): a photo cannot be checked, so none is taken
    expect(await writeCertificateDesign(db, tume.id, { backgroundKey: KEY }, (await read(tume.id)).version, null)).toEqual({ ok: false, error: "invalid", fields: { backgroundKey: "image" } });
    // a name of exactly 40 is fine; the design's own name in another case too
    expect((await save(tume.id, { name: "x".repeat(40) })).ok).toBe(true);
    expect((await save(tume.id, { name: "X".repeat(40) })).ok).toBe(true);
    expect(await byName("X".repeat(40))).toMatchObject({ tone: "dark", backgroundKey: "" });
  });

  test("the stale-save check: a save from another version is a conflict with the stored fields; a design deleted meanwhile is a conflict with none (version \"\")", async () => {
    const tume = await byName("Tume");
    const old = (await read(tume.id)).version;
    expect((await save(tume.id, { name: "Must" })).ok).toBe(true);
    expect(await writeCertificateDesign(db, tume.id, { tone: "light" }, old, store)).toEqual({
      ok: false,
      error: "conflict",
      version: (await read(tume.id)).version,
      value: { name: "Must", tone: "dark", backgroundKey: "" },
    });
    await db.delete(certificateDesigns).where(eq(certificateDesigns.id, tume.id));
    expect(await readCertificateDesign(db, tume.id)).toBeNull();
    expect(await writeCertificateDesign(db, tume.id, { tone: "light" }, old, store)).toEqual({ ok: false, error: "conflict", version: "", value: null });
  });
});

describe("„Kustuta“", () => {
  test("a design no course uses goes; certificates keep their copy", async () => {
    const extra = await createCertificateDesign(db);
    expect(await deleteCertificateDesign(db, extra.id)).toEqual({ ok: true });
    expect((await designs()).map((d) => d.name)).toEqual(["Hele", "Tume"]);
    expect(await deleteCertificateDesign(db, extra.id)).toEqual({ ok: false, error: "gone" });
  });

  test("refused while a course uses it (live, a draft, or no pick for the first design), with the count; refused for the last design", async () => {
    const hele = await byName("Hele");
    const tume = await byName("Tume");
    const b = await ecourse("b", { certificateDesignId: tume.id });
    expect(await deleteCertificateDesign(db, tume.id)).toEqual({ ok: false, error: "inUse", courses: 1 });
    await db.update(courses).set({ certificateDesignId: null, published: true }).where(eq(courses.id, b.id));
    // now in b's draft only
    await db.insert(contentDrafts).values({ entity: "course", entityId: b.id, part: "certificate", value: { certificateDesignId: tume.id }, baseVersion: "l:x", updatedBy: "maria@example.test" });
    expect(await deleteCertificateDesign(db, tume.id)).toEqual({ ok: false, error: "inUse", courses: 1 });
    // b uses „Hele“ live (no pick: the first)
    expect(await deleteCertificateDesign(db, hele.id)).toEqual({ ok: false, error: "inUse", courses: 1 });
    await db.delete(contentDrafts);
    await db.delete(courses);
    expect(await deleteCertificateDesign(db, tume.id)).toEqual({ ok: true });
    expect(await deleteCertificateDesign(db, hele.id)).toEqual({ ok: false, error: "last" });
    expect((await designs()).map((d) => d.name)).toEqual(["Hele"]);
  });
});
