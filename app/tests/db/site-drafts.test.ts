import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSlides, saveSlides } from "@/db/queries/admin-site";
import { getPracticePackages, getSettings, readSetting } from "@/db/queries/public";
import { contentDrafts, faq, galleryItems, heroSlides, pages, practicePackages } from "@/db/schema";
import { applySeed } from "@/db/seed-apply";
import { newSlideDraft, type FaqDraft, type PackageDraft, type SlideDraft, type WorkDraft } from "@/domain/site-editor";
import { createSession } from "@/server/auth";
import { saveDraftPart } from "@/server/drafts";
import { makeTestDb } from "./helpers";

// The site content's draft layer (admin UX pass piece 4a, Task 1; rulings R-a … R-e, R-i): Avaleht ("home"), Koolitaja ("trainer") and Praktika
// ("practice"), each one row of `content_drafts` with entity_id 0 and the parts admin-site.ts already has. A save goes to the part's draft under a
// loose check (types, lengths, list caps, formats: a new slide without its picture or title is kept); „Avalda muudatused“ writes each part through
// its existing strict check and writer, holding back the parts that fail it (`Puudub: …`, S4-2) or whose live value moved since the draft began;
// „Loobu muudatustest“ drops every draft of the entity. On PGlite with the prototype seed; the admin's session cookie is faked for the routes.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as saveRoute } from "@/app/api/admin/sisu/[entity]/[id]/osa/[part]/route";
import { POST as publishRoute } from "@/app/api/admin/sisu/[entity]/[id]/avalda/route";
import { POST as discardRoute } from "@/app/api/admin/sisu/[entity]/[id]/loobu/route";
import { discardSite, publishSite, readSiteEditor, writeSitePart } from "@/server/site-drafts";
import type { SiteEntity } from "@/domain/site-entities";

const ORIGIN = "https://mslab.example";
const ADMIN = "admin@example.test";
const NOW = new Date("2026-10-26T09:00:00Z");
const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  await applySeed(db);
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  vi.stubEnv("ADMIN_EMAILS", ADMIN);
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const drafts = () => db.select().from(contentDrafts).orderBy(asc(contentDrafts.id));
const read = (entity: SiteEntity) => readSiteEditor(db, entity);
/** A save of `patch` from the version the screen holds now. */
const save = async (entity: SiteEntity, part: string, patch: Record<string, unknown>) => writeSitePart(db, entity, part, patch, (await read(entity)).parts[part].version, ADMIN, NOW);
const versionOf = (a: unknown) => (a as { version: string }).version;
const liveSlides = async () => (clone((await read("home")).parts.slides.live) as { slides: SlideDraft[] }).slides;
const liveFaq = async () => (clone((await read("home")).parts.faq.live) as { faq: FaqDraft[] }).faq;

describe("a draft: a save never changes what is live", () => {
  test("a practice package's save is its draft: the read answers d:… with the draft's value and live unchanged; the public reader still has the live price", async () => {
    const before = await read("practice");
    expect(Object.keys(before.parts)).toEqual(["MINI", "MAXI"]);
    const mini = before.parts.MINI;
    expect(mini.version).toMatch(/^l:[0-9a-f]{32}$/);
    expect(mini.value).toEqual(mini.live);
    expect(mini.live).toMatchObject({ price: "100", models: "2", name: { et: "MINI" } });
    expect(before.stamp).toEqual(expect.any(Number));

    const saved = await writeSitePart(db, "practice", "MINI", { price: "120" }, mini.version, ADMIN, NOW);
    expect(saved).toEqual({ ok: true, version: expect.stringMatching(/^d:\d+\.1$/), savedAt: NOW.toISOString() });
    const after = await read("practice");
    expect(after.parts.MINI).toEqual({ version: versionOf(saved), value: { ...(mini.live as PackageDraft), price: "120" }, live: mini.live });
    expect(after.parts.MAXI).toEqual(before.parts.MAXI);
    expect(after.stamp).toBeGreaterThanOrEqual(before.stamp);
    const [row] = await drafts();
    expect(row).toMatchObject({ entity: "practice", entityId: 0, part: "MINI", version: 1, baseVersion: mini.version.slice(2), updatedBy: ADMIN });
    expect(`d:${row.id}.1`).toBe(versionOf(saved));
    expect((await getPracticePackages(db))[0]).toMatchObject({ code: "MINI", price: 10000 });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();

    // the next save of the draft is its compare-and-set
    expect(await writeSitePart(db, "practice", "MINI", { models: "3" }, versionOf(saved), ADMIN, NOW)).toEqual({ ok: true, version: `d:${row.id}.2`, savedAt: NOW.toISOString() });
    expect((await read("practice")).parts.MINI.value).toMatchObject({ price: "120", models: "3" });
  });

  test("conflict: a save from a stale version answers the stored version and value, and writes nothing", async () => {
    const start = (await read("practice")).parts.MINI;
    const a = await writeSitePart(db, "practice", "MINI", { price: "120" }, start.version, ADMIN, NOW);
    expect(a.ok).toBe(true);
    // another tab made its first change from live too: the draft is there already
    const draftValue = { ...(start.live as PackageDraft), price: "120" };
    expect(await writeSitePart(db, "practice", "MINI", { price: "130" }, start.version, ADMIN, NOW)).toEqual({ ok: false, error: "conflict", version: versionOf(a), value: draftValue });
    const a2 = await writeSitePart(db, "practice", "MINI", { price: "125" }, versionOf(a), ADMIN, NOW);
    expect(a2).toMatchObject({ ok: true, version: versionOf(a).replace(/\.1$/, ".2") });
    // a tab still on the first draft version, or on a version that is none
    expect(await writeSitePart(db, "practice", "MINI", { price: "130" }, versionOf(a), ADMIN, NOW)).toEqual({ ok: false, error: "conflict", version: versionOf(a2), value: { ...draftValue, price: "125" } });
    expect(await writeSitePart(db, "practice", "MINI", { price: "130" }, "l:0", ADMIN, NOW)).toMatchObject({ ok: false, error: "conflict", version: versionOf(a2) });
    // discarded, then a new draft: a tab on the earlier draft is a conflict, never a write into the new one
    await discardSite(db, "practice");
    const fresh = await save("practice", "MINI", { price: "140" });
    expect(versionOf(fresh)).toMatch(/^d:\d+\.1$/);
    expect(versionOf(fresh)).not.toBe(versionOf(a));
    expect(await writeSitePart(db, "practice", "MINI", { price: "150" }, versionOf(a2), ADMIN, NOW)).toMatchObject({ ok: false, error: "conflict", version: versionOf(fresh) });
    expect((await read("practice")).parts.MINI.value).toMatchObject({ price: "140" });
  });

  test("typing back: a save that types a field back to its live value drops the draft; the read answers l:… again", async () => {
    const start = (await read("practice")).parts.MINI;
    const a = await writeSitePart(db, "practice", "MINI", { price: "120" }, start.version, ADMIN, NOW);
    expect(await drafts()).toHaveLength(1);
    expect(await writeSitePart(db, "practice", "MINI", { price: "100" }, versionOf(a), ADMIN, NOW)).toEqual({ ok: true, version: start.version, savedAt: NOW.toISOString() });
    expect(await drafts()).toHaveLength(0);
    expect((await read("practice")).parts.MINI).toEqual(start);
    // a Russian side typed and emptied again is no change: "" is the same as no Russian text
    expect(start.live).toMatchObject({ name: { et: "MINI" } });
    expect(await writeSitePart(db, "practice", "MINI", { name: { et: "MINI", ru: "" } }, start.version, ADMIN, NOW)).toEqual({ ok: true, version: start.version, savedAt: NOW.toISOString() });
    expect(await drafts()).toHaveLength(0);
  });

  test("the same value again writes nothing and keeps the version", async () => {
    const a = await save("practice", "MAXI", { models: "5" });
    expect(await writeSitePart(db, "practice", "MAXI", { models: "5" }, versionOf(a), ADMIN, NOW)).toEqual({ ok: true, version: versionOf(a), savedAt: NOW.toISOString() });
    expect((await drafts())[0].version).toBe(1);
  });
});

describe("the loose check at a save (R-d)", () => {
  test("a home/slides save with a new slide that has no picture and no title is stored; a title over 120 characters is refused as invalid with field codes", async () => {
    const live = await liveSlides();
    expect(live).toHaveLength(5);
    const slides = [...live.slice(0, 2), newSlideDraft("new-1"), ...live.slice(2)];
    const saved = await save("home", "slides", { slides });
    expect(saved).toMatchObject({ ok: true, version: expect.stringMatching(/^d:\d+\.1$/) });
    expect((await read("home")).parts.slides.value).toEqual({ slides });
    expect(await db.select().from(heroSlides)).toHaveLength(5);

    const long = clone(slides);
    long[5].title = { et: "x".repeat(121), ru: long[5].title.ru };
    expect(await writeSitePart(db, "home", "slides", { slides: long }, versionOf(saved), ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { "slides.5.title": "tooLong", slides: "tooLong" } });
    expect((await read("home")).parts.slides).toMatchObject({ version: versionOf(saved), value: { slides } });
  });

  test("a wrong format is held at the field, not at the publish (B3): a link, a picture that is no upload, a price, a number of models; a list over its cap", async () => {
    const live = await liveSlides();
    live[1].ctaHref = "/ru/praktika";
    live[2].ctaHref = "javascript:alert(1)";
    live[3].imageKey = "https://evil.example/a.jpg";
    const version = (await read("home")).parts.slides.version;
    expect(await writeSitePart(db, "home", "slides", { slides: live }, version, ADMIN, NOW)).toEqual({
      ok: false,
      error: "invalid",
      fields: { slides: "localeHref", "slides.1.ctaHref": "localeHref", "slides.2.ctaHref": "href", "slides.3.imageKey": "image" },
    });
    const nine = Array.from({ length: 9 }, (_, i) => newSlideDraft(`n${i}`));
    expect(await writeSitePart(db, "home", "slides", { slides: nine }, version, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { slides: "tooMany" } });
    const maxi = (await read("practice")).parts.MAXI.version;
    expect(await writeSitePart(db, "practice", "MAXI", { price: "abc", models: "99" }, maxi, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { price: "amount", models: "whole" } });
    // empty is no wrong format: it waits in the draft (the publish says what is missing)
    expect(await writeSitePart(db, "practice", "MAXI", { price: "", models: "", name: { et: "" } }, maxi, ADMIN, NOW)).toMatchObject({ ok: true });
    expect(await drafts()).toHaveLength(1);
  });

  test("a refusal in a field the save did not send (a stored value a limit refuses) names every field sent with its code, so the screen holds them back", async () => {
    await db.update(practicePackages).set({ name: { et: "x".repeat(41) } }).where(eq(practicePackages.code, "MINI"));
    const v = (await read("practice")).parts.MINI.version;
    expect(await writeSitePart(db, "practice", "MINI", { price: "120", models: "3" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { name: "tooLong", price: "tooLong", models: "tooLong" } });
    // a refusal that names a field sent names only what it names
    expect(await writeSitePart(db, "practice", "MINI", { name: { et: "MINI" }, price: "abc" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { price: "amount" } });
    expect(await drafts()).toHaveLength(0);
  });

  test("a field the part does not have, or a value of the wrong type, is refused by field", async () => {
    const v = (await read("practice")).parts.MINI.version;
    expect(await writeSitePart(db, "practice", "MINI", { colour: "red" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { colour: "invalid" } });
    expect(await writeSitePart(db, "practice", "MINI", { price: 120 }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { price: "invalid" } });
    const t = (await read("trainer")).parts.trainer.version;
    expect(await writeSitePart(db, "trainer", "trainer", { stats: "8+" }, t, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { stats: "invalid" } });
    expect(await drafts()).toHaveLength(0);
  });
});

describe("„Avalda muudatused“ (publishSite)", () => {
  test("with drafts on slides and faq both are written: live equals the drafts, the drafts are gone, the slide ids are kept; revalidated once", async () => {
    const ids = (await readSlides(db)).map((s) => s.id);
    const slides = await liveSlides();
    slides[0].title = { et: "Uus pealkiri", ru: "Новый заголовок" };
    [slides[1], slides[2]] = [slides[2], slides[1]];
    expect((await save("home", "slides", { slides })).ok).toBe(true);
    const items = await liveFaq();
    items[0].q = { et: "Uus küsimus?", ru: "Новый вопрос?" };
    const kept = items.slice(0, 5);
    expect((await save("home", "faq", { faq: kept })).ok).toBe(true);

    const result = await publishSite(db, "home");
    expect(result).toEqual({ stamp: expect.any(Number), published: ["slides", "faq"], blocked: [] });
    const after = await read("home");
    expect(after.parts.slides).toEqual({ version: expect.stringMatching(/^l:/), value: { slides }, live: { slides } });
    expect(after.parts.faq).toEqual({ version: expect.stringMatching(/^l:/), value: { faq: kept }, live: { faq: kept } });
    expect(await drafts()).toHaveLength(0);
    expect((await readSlides(db)).map((s) => s.id)).toEqual([ids[0], ids[2], ids[1], ids[3], ids[4]]);
    expect(await db.select().from(faq)).toHaveLength(5);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "home" });
  });

  test("a blocked part: a new slide without its picture beside a valid faq draft — the faq goes live, the slides wait: Puudub: slaid 3 pilt (S4-2, S4-12)", async () => {
    const live = await liveSlides();
    const fresh = { ...newSlideDraft("new-1"), title: { et: "Uus slaid" } };
    const slides = [...live.slice(0, 2), fresh, ...live.slice(2)];
    expect((await save("home", "slides", { slides })).ok).toBe(true);
    const items = await liveFaq();
    items[3].a = { et: "Uus vastus.", ru: "Новый ответ." };
    expect((await save("home", "faq", { faq: items })).ok).toBe(true);

    const result = await publishSite(db, "home");
    expect(result.published).toEqual(["faq"]);
    expect(result.blocked).toEqual([{ part: "slides", reason: "missing", fields: ["slaid 3 pilt"] }]);
    expect((await drafts()).map((d) => d.part)).toEqual(["slides"]);
    expect(await readSlides(db)).toHaveLength(5);
    expect((await read("home")).parts.faq.live).toEqual({ faq: items });
    expect((await read("home")).parts.slides.value).toEqual({ slides });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);

    // the picture added: the slides publish too, the new slide gets its row
    slides[2] = { ...slides[2], imageKey: UPLOAD };
    expect((await save("home", "slides", { slides })).ok).toBe(true);
    expect(await publishSite(db, "home")).toMatchObject({ published: ["slides"], blocked: [] });
    expect((await readSlides(db)).map((s) => s.title.et)[2]).toBe("Uus slaid");
  });

  test("every missing field of a blocked part is named, in the S4-2 casing: KKK, MINI and MAXI keep their capitals", async () => {
    const live = await liveSlides();
    const slides = [...live.slice(0, 2), newSlideDraft("new-1")];
    expect((await save("home", "slides", { slides })).ok).toBe(true);
    const items = await liveFaq();
    items.push({ uid: "new-2", id: null, q: { et: "Kas?" }, a: { et: "" } });
    expect((await save("home", "faq", { faq: items })).ok).toBe(true);
    expect((await publishSite(db, "home")).blocked).toEqual([
      { part: "slides", reason: "missing", fields: ["slaid 3 pilt", "slaid 3 pealkiri"] },
      { part: "faq", reason: "missing", fields: ["KKK vastus 7"] },
    ]);

    expect((await save("practice", "MAXI", { price: "", items: [{ et: "Töö neljal modellil" }, { et: "", ru: "Только по-русски" }] })).ok).toBe(true);
    expect((await save("trainer", "trainer", { name: { et: "" } })).ok).toBe(true);
    expect((await publishSite(db, "practice")).blocked).toEqual([{ part: "MAXI", reason: "missing", fields: ["MAXI hind", "MAXI punkt 2"] }]);
    expect((await publishSite(db, "trainer")).blocked).toEqual([{ part: "trainer", reason: "missing", fields: ["nimi"] }]);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(await drafts()).toHaveLength(4);
  });

  test("a draft the loose check never saw (stored before a rule was tightened) is still held back: the missing fields first, then the other refusals", async () => {
    const live = await liveSlides();
    live[0] = { ...live[0], ctaHref: "javascript:alert(1)" };
    live[1] = { ...live[1], title: { et: "" } };
    const base = (await read("home")).parts.slides.version.slice(2);
    expect(await saveDraftPart(db, { entity: "home", entityId: 0, part: "slides", value: { slides: live }, baseVersion: base, version: null, by: ADMIN })).toMatchObject({ ok: true });
    expect((await publishSite(db, "home")).blocked).toEqual([{ part: "slides", reason: "missing", fields: ["slaid 2 pealkiri", "slaid 1 nupp viib"] }]);
    expect(await readSlides(db)).toHaveLength(5);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("changed meanwhile: a live row that changed after the draft was based is blocked as changed, and stays a draft", async () => {
    const slides = await liveSlides();
    slides[0].title = { et: "Mustandi pealkiri" };
    expect((await save("home", "slides", { slides })).ok).toBe(true);
    // another way of saving changes live after the draft began
    const rows = await readSlides(db);
    await db.transaction((tx) => saveSlides(tx, rows.map((r, i) => (i === 1 ? { ...r, kicker: { et: "Otse muudetud" } } : r))));
    const result = await publishSite(db, "home");
    expect(result.published).toEqual([]);
    expect(result.blocked).toEqual([{ part: "slides", reason: "changed", fields: expect.any(Array) }]);
    expect(result.blocked[0].fields.length).toBeGreaterThan(0);
    expect((await drafts()).map((d) => d.part)).toEqual(["slides"]);
    expect((await readSlides(db))[0].title.et).not.toBe("Mustandi pealkiri");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("changed meanwhile names the draft's rows as the bar does (R-i): „Slaid 2 pealkiri“, a Russian side alone with „(RU)“", async () => {
    const slides = await liveSlides();
    slides[1].title = { ...slides[1].title, et: "Mustandi pealkiri" };
    const faqRows = await liveFaq();
    faqRows[0].a = { ...faqRows[0].a, ru: "Новый ответ" };
    expect((await save("home", "slides", { slides })).ok).toBe(true);
    expect((await save("home", "faq", { faq: faqRows })).ok).toBe(true);
    // another way of saving changes the same slide's title live, and the FAQ, after the drafts began
    const rows = await readSlides(db);
    await db.transaction((tx) => saveSlides(tx, rows.map((r, i) => (i === 1 ? { ...r, title: { ...r.title, et: "Otse muudetud" } } : r))));
    const stored = await db.select().from(faq).orderBy(asc(faq.sort), asc(faq.id));
    await db.update(faq).set({ q: { ...stored[2].q, et: "Otse muudetud küsimus" } }).where(eq(faq.id, stored[2].id));
    const result = await publishSite(db, "home");
    expect(result.published).toEqual([]);
    // (the draft's rows against live as it is now: row 1's answer differs only in Russian, row 3's question in Estonian)
    expect(result.blocked).toEqual([
      { part: "slides", reason: "changed", fields: ["Slaid 2 pealkiri"] },
      { part: "faq", reason: "changed", fields: ["KKK vastus 1 (RU)", "KKK küsimus 3"] },
    ]);
    expect((await drafts()).map((d) => d.part)).toEqual(["slides", "faq"]);
  });

  test("nothing to publish: an answer with nothing published and nothing blocked, nothing revalidated", async () => {
    expect(await publishSite(db, "trainer")).toEqual({ stamp: expect.any(Number), published: [], blocked: [] });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("the trainer's publish keeps the setting's other keys (the contact photo) and revalidates the parts written; practice revalidates its pages", async () => {
    const before = (await getSettings(db)).trainer as Record<string, unknown>;
    expect((await save("trainer", "trainer", { role: { et: "Koolitaja", ru: "Тренер" } })).ok).toBe(true);
    const works = (clone((await read("trainer")).parts.works.live) as { works: WorkDraft[] }).works.slice(0, 2);
    expect((await save("trainer", "works", { works })).ok).toBe(true);
    expect(await publishSite(db, "trainer")).toMatchObject({ published: ["trainer", "works"], blocked: [] });
    expect((await getSettings(db)).trainer).toMatchObject({ contactPhotoKey: before.contactPhotoKey, role: { et: "Koolitaja", ru: "Тренер" } });
    expect(await db.select().from(galleryItems).where(eq(galleryItems.group, "trainer_works"))).toHaveLength(2);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "trainer", parts: ["trainer", "works"] });

    pub.revalidatePublic.mockReset();
    expect((await save("practice", "MAXI", { price: "155,50" })).ok).toBe(true);
    expect(await publishSite(db, "practice")).toMatchObject({ published: ["MAXI"], blocked: [] });
    expect((await getPracticePackages(db))[1]).toMatchObject({ code: "MAXI", price: 15550 });
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "practice" });
  });
});

describe("„Loobu muudatustest“ (discardSite)", () => {
  test("removes every trainer draft, and the read answers the live values; another entity's drafts stay", async () => {
    const start = await read("trainer");
    expect((await save("trainer", "trainer", { name: { et: "Maria S." } })).ok).toBe(true);
    expect((await save("trainer", "bio", { body: { et: "Uus tutvustus." } })).ok).toBe(true);
    expect((await save("trainer", "center_story", { title: { et: "Lugu" } })).ok).toBe(true);
    expect((await save("home", "statement", { body: { et: "Uus lause." } })).ok).toBe(true);
    const result = await discardSite(db, "trainer");
    expect(result).toEqual({ stamp: expect.any(Number) });
    expect((await drafts()).map((d) => [d.entity, d.part])).toEqual([["home", "statement"]]);
    const after = await read("trainer");
    expect(after.parts).toEqual(start.parts);
    for (const p of Object.values(after.parts)) expect(p.value).toEqual(p.live);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });
});

describe("versions (R-b): the hash of the part's draft-shaped live value", () => {
  test("changing settings.trainer.contactPhotoKey does not move the trainer part's version, and a trainer draft still publishes", async () => {
    const before = (await read("trainer")).parts.trainer;
    const stored = (await readSetting(db, "trainer")) as Record<string, unknown>;
    expect(stored.contactPhotoKey).toBe("/seed/maria-seated.jpg");
    await setSetting(db, "trainer", { ...stored, contactPhotoKey: UPLOAD });
    expect((await read("trainer")).parts.trainer).toEqual(before);
    // a draft made before such a change still publishes: its base is still live's
    expect((await save("trainer", "trainer", { role: { et: "Koolitaja" } })).ok).toBe(true);
    await setSetting(db, "trainer", { ...stored, contactPhotoKey: "/seed/maria-standing.jpg" });
    expect(await publishSite(db, "trainer")).toMatchObject({ published: ["trainer"], blocked: [] });
    expect((await getSettings(db)).trainer).toMatchObject({ contactPhotoKey: "/seed/maria-standing.jpg", role: { et: "Koolitaja" } });
  });

  test("changing package MINI's live row does not move part MAXI's version (each package is its own part)", async () => {
    const before = await read("practice");
    await db.update(practicePackages).set({ price: 12300, models: 3 }).where(eq(practicePackages.code, "MINI"));
    const after = await read("practice");
    expect(after.parts.MINI.version).not.toBe(before.parts.MINI.version);
    expect(after.parts.MAXI.version).toBe(before.parts.MAXI.version);
  });

  test("a page part's version is of its draft-shaped value: the statement's stored title is not in it", async () => {
    const before = (await read("home")).parts.statement;
    expect(before.live).toEqual({ body: expect.objectContaining({ et: expect.any(String) }) });
    await db.update(pages).set({ title: { et: "Teine pealkiri" } }).where(eq(pages.key, "statement"));
    expect((await read("home")).parts.statement.version).toBe(before.version);
  });
});

describe("the routes", () => {
  const signIn = async () => {
    state.cookie = await createSession(db, ADMIN);
  };
  type Params = { entity: string; id: string; part?: string };
  const call = async (route: typeof publishRoute | typeof saveRoute, params: Params, body: unknown, headers: Record<string, string> = {}) => {
    const url = `/api/admin/sisu/${params.entity}/${params.id}/${params.part === undefined ? "x" : `osa/${params.part}`}`;
    const res = await (route as (r: Request, c: { params: Promise<Params> }) => Promise<Response>)(
      new Request(`${ORIGIN}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
  };
  const saveCall = (entity: string, id: string, part: string, body: unknown, headers?: Record<string, string>) => call(saveRoute, { entity, id, part }, body, headers);
  const publishCall = (entity: string, id: string) => call(publishRoute, { entity, id }, {});
  const discardCall = (entity: string, id: string) => call(discardRoute, { entity, id }, {});

  test("without an admin's session 401, from another site 403; an unknown entity, id or part 404; nothing stored", async () => {
    expect((await saveCall("practice", "0", "MINI", { version: "x", patch: {} })).status).toBe(401);
    expect((await publishCall("practice", "0")).status).toBe(401);
    expect((await discardCall("practice", "0")).status).toBe(401);
    await signIn();
    expect((await saveCall("practice", "0", "MINI", { version: "x", patch: {} }, { origin: "https://evil.example" })).status).toBe(403);
    for (const [entity, id] of [["course", "0"], ["post", "0"], ["home", "1"], ["home", "00"], ["trainer", "x"], ["", "0"]]) {
      expect((await saveCall(entity, id, "slides", { version: "x", patch: {} })).status, `${entity}/${id}`).toBe(404);
      expect((await publishCall(entity, id)).status, `${entity}/${id}`).toBe(404);
      expect((await discardCall(entity, id)).status, `${entity}/${id}`).toBe(404);
    }
    for (const [entity, part] of [["home", "hero"], ["home", "trainer"], ["trainer", "slides"], ["practice", "XL"], ["practice", "slides"]]) {
      expect((await saveCall(entity, "0", part, { version: "x", patch: {} })).status, `${entity}/${part}`).toBe(404);
    }
    expect(await drafts()).toHaveLength(0);
  });

  test("POST …/osa/<part>: the autosave — 200 the draft's version, 409 what is stored, 400 by field; never cached", async () => {
    await signIn();
    const live = (await read("practice")).parts.MAXI.version;
    const ok = await saveCall("practice", "0", "MAXI", { version: live, patch: { price: "160" } });
    expect(ok).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(/^d:\d+\.1$/) } });
    expect(await saveCall("practice", "0", "MAXI", { version: live, patch: { price: "170" } })).toMatchObject({ status: 409, body: { ok: false, error: "conflict", version: ok.body.version, value: { price: "160" } } });
    expect(await saveCall("practice", "0", "MAXI", { version: ok.body.version, patch: { price: "abc" } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { price: "amount" } } });
    expect(await saveCall("practice", "0", "MAXI", { nothing: 1 })).toMatchObject({ status: 400, body: { ok: false, error: "body" } });
    expect((await drafts())[0]).toMatchObject({ entity: "practice", part: "MAXI", updatedBy: ADMIN });
  });

  test("POST …/avalda: 200 { stamp, published, blocked }; POST …/loobu: 200 { stamp }", async () => {
    await signIn();
    const live = (await read("home")).parts.statement.version;
    expect((await saveCall("home", "0", "statement", { version: live, patch: { body: { et: "Uus lause." } } })).status).toBe(200);
    expect(await publishCall("home", "0")).toEqual({ status: 200, cache: "no-store", body: { stamp: expect.any(Number), published: ["statement"], blocked: [] } });
    const next = (await read("home")).parts.statement.version;
    expect((await saveCall("home", "0", "statement", { version: next, patch: { body: { et: "Veel üks." } } })).status).toBe(200);
    expect(await discardCall("home", "0")).toEqual({ status: 200, cache: "no-store", body: { stamp: expect.any(Number) } });
    expect(await drafts()).toHaveLength(0);
    expect((await read("home")).parts.statement.live).toMatchObject({ body: { et: "Uus lause." } });
  });
});

// docs/deploy.md section 25, item 2 (the rollback): the older Avaleht, Koolitaja and Praktika read none of the site drafts, so before an earlier
// deployment is promoted every site draft is published or discarded, and this read-only query must return no row. The test runs the query as the doc
// prints it.
describe("the rollback check of deploy.md §25 item 2: the site drafts that are left", () => {
  const docQuery = (): string => {
    const doc = readFileSync(join(process.cwd(), "..", "docs", "deploy.md"), "utf8");
    const section = doc.slice(doc.indexOf("\n## 25. "));
    const found = /`(select entity, count\(\*\) from content_drafts where entity in \('home','trainer','practice'\) group by 1)`/.exec(section);
    if (!found) throw new Error("the query is not in docs/deploy.md section 25");
    return found[1];
  };
  const left = async (): Promise<Record<string, number>> => {
    const res = (await db.execute(sql.raw(docQuery()))) as unknown as { rows?: { entity: string; count: string | number }[] } & { entity: string; count: string | number }[];
    return Object.fromEntries(((res.rows ?? res) as { entity: string; count: string | number }[]).map((r) => [r.entity, Number(r.count)]));
  };

  test("no row when nothing waits; a row for each screen that holds drafts, with its parts; a course's draft is no site draft; published or discarded, no row again", async () => {
    expect(await left()).toEqual({});
    const items = await liveFaq();
    expect((await save("home", "faq", { faq: items.slice(0, 5) })).ok).toBe(true);
    expect((await save("home", "statement", { body: { et: "Uus lause." } })).ok).toBe(true);
    expect((await save("trainer", "bio", { body: { et: "Uus tutvustus." } })).ok).toBe(true);
    expect((await save("practice", "MAXI", { price: "160" })).ok).toBe(true);
    // (a course's draft is the course editor's own: section 23, item 2)
    expect(await saveDraftPart(db, { entity: "course", entityId: 1, part: "basics", value: {}, baseVersion: "x", version: null, by: ADMIN })).toMatchObject({ ok: true });
    expect(await left()).toEqual({ home: 2, trainer: 1, practice: 1 });
    await publishSite(db, "home");
    await discardSite(db, "trainer");
    expect(await left()).toEqual({ practice: 1 });
    await publishSite(db, "practice");
    expect(await left()).toEqual({});
    expect(await drafts()).toHaveLength(1); // the course's, untouched
  });
});
