import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { listAllPosts } from "@/db/queries/admin";
import { getPost, listPosts } from "@/db/queries/public";
import { contentDrafts, posts } from "@/db/schema";
import { applySeed } from "@/db/seed-apply";
import type { PostPartValue, SiteTarget } from "@/domain/site-entities";
import { createSession } from "@/server/auth";
import { saveDraftPart } from "@/server/drafts";
import { makeTestDb } from "./helpers";

// A post on the site content's draft layer (admin UX pass piece 4b, Task 1; rulings R-a, R-b, R-g, R-h; piece4-texts S4-19, S4-22, S4-24, S4-Q1 A):
// `content_drafts.entity = "post"`, entity_id the post's id, one part `post` without `published` (its version never moves with the switch). A post
// that is not published saves straight to its row (no draft, no bar); a published one saves into its draft and goes live with „Avalda muudatused“.
// „Avaldatud“ on is the post's publish, with S4-Q1 A's strict check (the cover, the title and the text in Estonian and Russian, the category and the
// address); off publishes the pending drafts first or refuses. „Lisa postitus +“ makes `Uus postitus` at once with a free address; „Kustuta postitus“
// takes the drafts with it. On PGlite with the prototype seed (six published posts); the admin's session cookie is faked for the routes.

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
import { POST as createRoute } from "@/app/api/admin/uudised/uus/route";
import { POST as switchRoute } from "@/app/api/admin/uudised/[id]/avaldatud/route";
import { POST as deleteRoute } from "@/app/api/admin/uudised/[id]/kustuta/route";
import { createPost, deletePost, discardSite, publishSite, readSiteEditor, switchPostPublished, writeSitePart } from "@/server/site-drafts";
import { withSiteDrafts } from "@/server/site-preview";

const ORIGIN = "https://mslab.example";
const ADMIN = "admin@example.test";
const NOW = new Date("2026-10-27T09:00:00Z");
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

const target = (id: number): SiteTarget => ({ entity: "post", id });
const read = (id: number) => readSiteEditor(db, target(id));
const valueOf = async (id: number) => (await read(id)).parts.post.value as PostPartValue;
/** A save of `patch` from the version the screen holds now. */
const save = async (id: number, patch: Partial<PostPartValue>) => writeSitePart(db, target(id), "post", patch, (await read(id)).parts.post.version, ADMIN, NOW);
const versionOf = (a: unknown) => (a as { version: string }).version;
const rowOf = async (id: number) => (await db.select().from(posts).where(eq(posts.id, id)))[0];
const postDrafts = () => db.select().from(contentDrafts).where(eq(contentDrafts.entity, "post")).orderBy(asc(contentDrafts.id));
/** „Avalda muudatused“ from a screen that has just read the post. */
const publishNow = async (id: number) => publishSite(db, target(id), { post: (await read(id)).parts.post.version });
/** The seed's posts, newest first: all six published. */
const seedPosts = () => listPosts(db);
/** What S4-Q1 A asks of a post at its publish, all there. */
const COMPLETE: Partial<PostPartValue> = {
  title: { et: "Sügisene uudis", ru: "Осенняя новость" },
  body: { et: "Esimene lõik.", ru: "Первый абзац." },
  category: { et: "Uudis", ru: "Новость" },
  coverKey: UPLOAD,
};

describe("„Lisa postitus +“ (createPost, S4-19, R-g)", () => {
  test("twice: `uus-postitus`, then `uus-postitus-2`; both unpublished, titled „Uus postitus“, dated now; a third is `uus-postitus-3`", async () => {
    const a = await createPost(db, NOW);
    const b = await createPost(db, NOW);
    expect(a.slug).toBe("uus-postitus");
    expect(b.slug).toBe("uus-postitus-2");
    expect(b.id).not.toBe(a.id);
    for (const p of [a, b]) {
      expect(await rowOf(p.id)).toMatchObject({ slug: p.slug, title: { et: "Uus postitus" }, published: false, coverKey: "", category: { et: "" }, body: { et: "" }, excerpt: { et: "" } });
      expect((await rowOf(p.id)).publishedAt.toISOString()).toBe(NOW.toISOString());
    }
    expect((await createPost(db, NOW)).slug).toBe("uus-postitus-3");
    // never on the public site, nothing revalidated
    expect((await seedPosts()).map((p) => p.id)).not.toContain(a.id);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(await postDrafts()).toHaveLength(0);
  });

  test("two presses at once (two tabs) make two posts with two addresses, never a unique-index error (Review Focus 2)", async () => {
    // (PGlite runs one transaction at a time, so this pins the numbering of presses that come together, not the lock: on Postgres it is
    // createPost's `LOCK posts IN EXCLUSIVE MODE` that puts the second press's look for a free address after the first one's insert)
    const made = await Promise.all([createPost(db, NOW), createPost(db, NOW), createPost(db, NOW)]);
    expect(made.map((p) => p.slug).sort()).toEqual(["uus-postitus", "uus-postitus-2", "uus-postitus-3"]);
    expect(new Set(made.map((p) => p.id)).size).toBe(3);
  });

  test("the editor reads the new post: one part `post`, its value without `published` or the id, the date in Estonian time; live is the same", async () => {
    const { id } = await createPost(db, NOW);
    const r = await read(id);
    expect(r.stamp).toEqual(expect.any(Number));
    expect(Object.keys(r.parts)).toEqual(["post"]);
    expect(r.parts.post.version).toMatch(/^l:[0-9a-f]{32}$/);
    expect(r.parts.post.value).toEqual({ title: { et: "Uus postitus" }, slug: "uus-postitus", category: { et: "" }, excerpt: { et: "" }, body: { et: "" }, coverKey: "", publishedAt: "2026-10-27" });
    expect(r.parts.post.live).toEqual(r.parts.post.value);
    // a post that is not there has no part
    expect((await read(99999)).parts).toEqual({});
  });
});

describe("a post that is not published saves straight to its row (R-a)", () => {
  test("the save writes the row and no draft; the read answers the row's version; the same text again keeps it", async () => {
    const { id } = await createPost(db, NOW);
    const saved = await save(id, { title: { et: "Sügisene uudis " }, slug: "sugisene-uudis", category: { et: "Uudis" } });
    expect(saved).toEqual({ ok: true, version: expect.stringMatching(/^l:[0-9a-f]{32}$/), savedAt: NOW.toISOString() });
    expect(await postDrafts()).toHaveLength(0);
    // the row holds the text as typed (the publish trims it), still hidden
    expect(await rowOf(id)).toMatchObject({ title: { et: "Sügisene uudis " }, slug: "sugisene-uudis", category: { et: "Uudis" }, published: false });
    const after = await read(id);
    expect(after.parts.post).toMatchObject({ version: versionOf(saved), value: { title: { et: "Sügisene uudis " }, slug: "sugisene-uudis" } });
    expect(after.parts.post.live).toEqual(after.parts.post.value);
    expect(await writeSitePart(db, target(id), "post", { slug: "sugisene-uudis" }, versionOf(saved), ADMIN, NOW)).toEqual({ ok: true, version: versionOf(saved), savedAt: NOW.toISOString() });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect((await seedPosts()).map((p) => p.id)).not.toContain(id);
  });

  test("a save from an old version is a conflict with the row's value; a new day is 09:00 Estonian time, the same day keeps the stored time", async () => {
    const { id } = await createPost(db, NOW);
    const start = (await read(id)).parts.post;
    const a = await writeSitePart(db, target(id), "post", { excerpt: { et: "Lühidalt." } }, start.version, ADMIN, NOW);
    expect(a.ok).toBe(true);
    expect(await writeSitePart(db, target(id), "post", { excerpt: { et: "Teine." } }, start.version, ADMIN, NOW)).toEqual({
      ok: false,
      error: "conflict",
      version: versionOf(a),
      value: { ...(start.value as PostPartValue), excerpt: { et: "Lühidalt." } },
    });
    expect((await save(id, { publishedAt: "2026-10-27", body: { et: "Tekst." } })).ok).toBe(true);
    expect((await rowOf(id)).publishedAt.toISOString()).toBe(NOW.toISOString());
    expect((await save(id, { publishedAt: "2026-12-24" })).ok).toBe(true);
    expect((await rowOf(id)).publishedAt.toISOString()).toBe("2026-12-24T07:00:00.000Z"); // winter: UTC+2
  });

  test("refused at the field (B3): an empty Estonian title, an address of another post or of the wrong form, a bad or empty date; nothing written", async () => {
    const { id } = await createPost(db, NOW);
    const [seed] = await seedPosts();
    const v = (await read(id)).parts.post.version;
    const before = await rowOf(id);
    expect(await writeSitePart(db, target(id), "post", { title: { et: " ", ru: "Новость" } }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await writeSitePart(db, target(id), "post", { slug: seed.slug }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugTaken" } });
    expect(await writeSitePart(db, target(id), "post", { slug: "Mitte Nii!" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugFormat" } });
    expect(await writeSitePart(db, target(id), "post", { publishedAt: "2026-02-30" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { publishedAt: "date" } });
    expect(await writeSitePart(db, target(id), "post", { publishedAt: "" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { publishedAt: "required" } });
    expect(await writeSitePart(db, target(id), "post", { title: { et: "x".repeat(161) } }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { title: "tooLong" } });
    expect(await writeSitePart(db, target(id), "post", { published: true } as Partial<PostPartValue>, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { published: "invalid" } });
    // a refused address does not hold the title back: the screen sends the rest again without it
    expect(await writeSitePart(db, target(id), "post", { title: { et: "Uus koolitus: Lash Lift BOTOX" }, slug: seed.slug }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugTaken" } });
    expect(await rowOf(id)).toEqual(before);
    // an address typed in capitals is stored in small letters; an emptied one is made from the title (today's rule)
    expect((await save(id, { slug: "Talvine-Uudis" })).ok).toBe(true);
    expect((await rowOf(id)).slug).toBe("talvine-uudis");
    expect((await save(id, { slug: "", title: { et: "Kevadine uudis" } })).ok).toBe(true);
    expect((await rowOf(id)).slug).toBe("kevadine-uudis");
    expect(await postDrafts()).toHaveLength(0);
  });
});

describe("the address follows the title until the post is first published, unless Maria typed one (R-g)", () => {
  test("post 2 (`uus-postitus-2`) retitled „Kevad“ gets `kevad`; a title whose address another post has gets `-2`, never a refusal", async () => {
    await createPost(db, NOW);
    const b = await createPost(db, NOW);
    expect(b.slug).toBe("uus-postitus-2");
    expect(await save(b.id, { title: { et: "Kevad" } })).toMatchObject({ ok: true });
    expect((await rowOf(b.id)).slug).toBe("kevad");
    // the editor's read has it (the screen shows the address by the same rule: domain/site-checks.ts slugFollowsTitle)
    expect((await valueOf(b.id)).slug).toBe("kevad");
    const [seed] = await seedPosts();
    const c = await createPost(db, NOW);
    expect(await save(c.id, { title: { et: seed.title.et } })).toMatchObject({ ok: true });
    expect((await rowOf(c.id)).slug).toBe(`${seed.slug}-2`);
    // still following: retitled again, the number goes with the old title
    expect(await save(c.id, { title: { et: "Talvine uudis" } })).toMatchObject({ ok: true });
    expect((await rowOf(c.id)).slug).toBe("talvine-uudis");
    expect(await postDrafts()).toHaveLength(0);
  });

  test("an address already in the new title's series stays as it is: no number is taken back by a title that makes the same address", async () => {
    const a = await createPost(db, NOW);
    const b = await createPost(db, NOW);
    expect(await deletePost(db, a.id)).toBe(true);
    expect(await save(b.id, { title: { et: "Uus postitus!" } })).toMatchObject({ ok: true });
    expect((await rowOf(b.id)).slug).toBe("uus-postitus-2");
  });

  test("a typed address stays as typed after the title changes; a typed one another post has is refused at the save (ADM:2281)", async () => {
    const { id } = await createPost(db, NOW);
    expect(await save(id, { slug: "minu-aadress" })).toMatchObject({ ok: true });
    expect(await save(id, { title: { et: "Talv" } })).toMatchObject({ ok: true });
    expect(await rowOf(id)).toMatchObject({ slug: "minu-aadress", title: { et: "Talv" } });
    // a title and an address sent together: the address is the typed one
    expect(await save(id, { title: { et: "Kevad" }, slug: "veel-uks" })).toMatchObject({ ok: true });
    expect((await rowOf(id)).slug).toBe("veel-uks");
    const [seed] = await seedPosts();
    expect(await save(id, { slug: seed.slug })).toEqual({ ok: false, error: "invalid", fields: { slug: "slugTaken" } });
  });

  test("a published post's address never follows: its title's draft keeps the address, and so does its publish", async () => {
    const [seed] = await seedPosts();
    expect(await save(seed.id, { title: { et: "Täiesti uus pealkiri", ru: seed.title.ru } })).toMatchObject({ ok: true, version: expect.stringMatching(/^d:/) });
    expect((await valueOf(seed.id)).slug).toBe(seed.slug);
    expect(await publishNow(seed.id)).toMatchObject({ published: ["post"], blocked: [] });
    expect(await rowOf(seed.id)).toMatchObject({ slug: seed.slug, title: { et: "Täiesti uus pealkiri" } });
  });
});

describe("a published post saves into its draft", () => {
  test("the save is a draft; the public reader still has the live text; the version leaves `published` out", async () => {
    const [seed] = await seedPosts();
    const start = (await read(seed.id)).parts.post;
    expect(start.value).not.toHaveProperty("published");
    expect(start.value).not.toHaveProperty("id");
    const saved = await save(seed.id, { body: { et: "Mustandi tekst.", ru: "Текст черновика." } });
    expect(saved).toEqual({ ok: true, version: expect.stringMatching(/^d:\d+\.1$/), savedAt: NOW.toISOString() });
    const [row] = await postDrafts();
    expect(row).toMatchObject({ entity: "post", entityId: seed.id, part: "post", version: 1, updatedBy: ADMIN });
    expect((await getPost(db, seed.slug))!.body).toEqual(seed.body);
    expect(await rowOf(seed.id)).toEqual(seed);
    const after = (await read(seed.id)).parts.post;
    expect(after).toMatchObject({ version: versionOf(saved), value: { body: { et: "Mustandi tekst.", ru: "Текст черновика." } }, live: start.live });
    // the switch's column is not in the part: changing it moves no version
    await db.update(posts).set({ published: false }).where(eq(posts.id, seed.id));
    expect((await read(seed.id)).parts.post.live).toEqual(start.live);
    await db.update(posts).set({ published: true }).where(eq(posts.id, seed.id));
    expect((await read(seed.id)).parts.post.version).toBe(versionOf(saved));
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("two tabs: the second save from the same version is a conflict with the first one's draft, which stays (Review Focus 1)", async () => {
    const [seed] = await seedPosts();
    const v = (await read(seed.id)).parts.post.version;
    const first = await writeSitePart(db, target(seed.id), "post", { title: { et: "Esimese akna pealkiri", ru: seed.title.ru } }, v, ADMIN, NOW);
    expect(first.ok).toBe(true);
    const second = await writeSitePart(db, target(seed.id), "post", { title: { et: "Teise akna pealkiri", ru: seed.title.ru } }, v, ADMIN, NOW);
    expect(second).toMatchObject({ ok: false, error: "conflict", version: versionOf(first), value: { title: { et: "Esimese akna pealkiri" } } });
    expect((await valueOf(seed.id)).title.et).toBe("Esimese akna pealkiri");
    expect(await postDrafts()).toHaveLength(1);
  });

  test("a draft address is checked for its form at the save, for another post's at the publish (R-g)", async () => {
    const [a, b] = await seedPosts();
    const v = (await read(a.id)).parts.post.version;
    expect(await writeSitePart(db, target(a.id), "post", { slug: "Mitte Nii!" }, v, ADMIN, NOW)).toEqual({ ok: false, error: "invalid", fields: { slug: "slugFormat" } });
    expect((await save(a.id, { slug: b.slug })).ok).toBe(true);
    expect(await postDrafts()).toHaveLength(1);
  });
});

describe("„Avalda muudatused“ of a published post (publishSite, S4-Q1 A)", () => {
  test("a complete draft goes live trimmed, the draft goes, the post pages are revalidated once", async () => {
    const [seed] = await seedPosts();
    expect((await save(seed.id, { title: { et: " Uus pealkiri ", ru: "Новый заголовок" }, excerpt: { et: "Lühidalt. " } })).ok).toBe(true);
    expect(await publishNow(seed.id)).toEqual({ stamp: expect.any(Number), published: ["post"], blocked: [] });
    expect(await rowOf(seed.id)).toMatchObject({ title: { et: "Uus pealkiri", ru: "Новый заголовок" }, excerpt: { et: "Lühidalt." }, published: true, publishedAt: seed.publishedAt });
    expect(await postDrafts()).toHaveLength(0);
    expect((await getPost(db, seed.slug))!.title.et).toBe("Uus pealkiri");
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "posts" });
  });

  test("a draft without its cover or its Russian text is held back with S4-22's `Puudub: …` labels; live and the draft stay", async () => {
    const [seed] = await seedPosts();
    expect((await save(seed.id, { coverKey: "", body: { et: "Ainult eesti keeles." } })).ok).toBe(true);
    expect(await publishNow(seed.id)).toEqual({ stamp: expect.any(Number), published: [], blocked: [{ part: "post", reason: "missing", fields: ["kaanepilt", "tekst (RU)"] }] });
    expect(await rowOf(seed.id)).toEqual(seed);
    expect(await postDrafts()).toHaveLength(1);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a taken address is refused at the publish with ADM:2281's code (slugTaken), named „Aadress“; live and the draft stay", async () => {
    const [a, b] = await seedPosts();
    expect((await save(a.id, { slug: b.slug })).ok).toBe(true);
    expect(await publishNow(a.id)).toEqual({ stamp: expect.any(Number), published: [], blocked: [{ part: "post", reason: "invalid", fields: ["Aadress"], errors: { slug: "slugTaken" } }] });
    expect((await rowOf(a.id)).slug).toBe(a.slug);
    expect(await postDrafts()).toHaveLength(1);
  });

  test("a draft another window saved after the screen's read is held as changed, with the bar's labels in S4-24's order: „Pealkiri (RU)“, „Tekst“", async () => {
    const [seed] = await seedPosts();
    const first = await save(seed.id, { body: { et: "Ekraani tekst.", ru: seed.body.ru } });
    const screen = (await read(seed.id)).parts.post.version;
    expect(screen).toBe(versionOf(first));
    expect((await save(seed.id, { title: { et: seed.title.et, ru: "Другой заголовок" } })).ok).toBe(true);
    expect(await publishSite(db, target(seed.id), { post: screen })).toEqual({ stamp: expect.any(Number), published: [], blocked: [{ part: "post", reason: "changed", fields: ["Pealkiri (RU)", "Tekst"] }] });
    expect(await rowOf(seed.id)).toEqual(seed);
  });

  test("„Loobu muudatustest“ drops the post's draft only; live stays", async () => {
    const [a, b] = await seedPosts();
    expect((await save(a.id, { excerpt: { et: "Uus." } })).ok).toBe(true);
    expect((await save(b.id, { excerpt: { et: "Teine." } })).ok).toBe(true);
    expect(await discardSite(db, target(a.id))).toEqual({ stamp: expect.any(Number) });
    expect((await postDrafts()).map((d) => d.entityId)).toEqual([b.id]);
    expect((await read(a.id)).parts.post.value).toEqual((await read(a.id)).parts.post.live);
    expect(await rowOf(a.id)).toEqual(a);
  });
});

describe("„Avaldatud“ (switchPostPublished, R-b)", () => {
  test("on, for a post never published: refused without its cover — `kaanepilt`; without the Russian title and text — in S4-22's order; complete, it publishes", async () => {
    const { id } = await createPost(db, NOW);
    // (the address follows the title, R-g)
    const slug = "sugisene-uudis";
    expect((await save(id, { ...COMPLETE, coverKey: "" })).ok).toBe(true);
    expect(await switchPostPublished(db, id, true, NOW)).toEqual({ ok: false, missing: ["kaanepilt"] });
    expect((await save(id, { coverKey: UPLOAD, title: { et: "Sügisene uudis" }, body: { et: "Esimene lõik." } })).ok).toBe(true);
    expect(await switchPostPublished(db, id, true, NOW)).toEqual({ ok: false, missing: ["pealkiri (RU)", "tekst (RU)"] });
    expect((await rowOf(id)).published).toBe(false);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();

    expect((await save(id, { ...COMPLETE, title: { et: "Sügisene uudis ", ru: "Осенняя новость" } })).ok).toBe(true);
    expect(await switchPostPublished(db, id, true, NOW)).toEqual({ ok: true, stamp: expect.any(Number) });
    expect(await rowOf(id)).toMatchObject({ published: true, slug, title: { et: "Sügisene uudis", ru: "Осенняя новость" }, coverKey: UPLOAD });
    expect((await getPost(db, slug))!.id).toBe(id);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "posts" });
    // on again: nothing to do; from now on its saves are drafts
    expect(await switchPostPublished(db, id, true, NOW)).toEqual({ ok: true, stamp: expect.any(Number) });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(versionOf(await save(id, { excerpt: { et: "Lühidalt." } }))).toMatch(/^d:/);
  });

  test("on, for „Uus postitus“ as made: every missing field, the cover first, then the Estonian ones, then the Russian ones", async () => {
    const { id } = await createPost(db, NOW);
    expect(await switchPostPublished(db, id, true, NOW)).toEqual({ ok: false, missing: ["kaanepilt", "tekst", "kategooria", "pealkiri (RU)", "tekst (RU)"] });
  });

  test("off, with a pending draft: the draft is published first, then the post is hidden; the draft is gone, nothing is lost", async () => {
    const [seed] = await seedPosts();
    // (an unpublished post needs no cover: a draft that removed it goes too)
    expect((await save(seed.id, { body: { et: "Viimane tekst.", ru: "Последний текст." }, coverKey: "" })).ok).toBe(true);
    expect(await switchPostPublished(db, seed.id, false, NOW)).toEqual({ ok: true, stamp: expect.any(Number) });
    expect(await rowOf(seed.id)).toMatchObject({ published: false, body: { et: "Viimane tekst.", ru: "Последний текст." }, coverKey: "" });
    expect(await postDrafts()).toHaveLength(0);
    expect(await getPost(db, seed.slug)).toBeNull();
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "posts" });
    // hidden, it saves straight to its row again
    expect(versionOf(await save(seed.id, { excerpt: { et: "Peidetud." } }))).toMatch(/^l:/);
    expect((await rowOf(seed.id)).excerpt).toEqual({ et: "Peidetud." });
    // off again: nothing to do
    expect(await switchPostPublished(db, seed.id, false, NOW)).toEqual({ ok: true, stamp: expect.any(Number) });
  });

  test("off, with a draft blocked as changed (live moved after it began): refused with the part, nothing published or hidden, the draft stays", async () => {
    const [seed] = await seedPosts();
    expect((await save(seed.id, { title: { et: "Mustandi pealkiri", ru: seed.title.ru } })).ok).toBe(true);
    // another way of saving changes the live row after the draft began
    await db.update(posts).set({ excerpt: { et: "Otse muudetud." } }).where(eq(posts.id, seed.id));
    const result = await switchPostPublished(db, seed.id, false, NOW);
    expect(result).toEqual({ ok: false, blocked: [{ part: "post", reason: "changed", fields: ["Pealkiri", "Lühitekst"] }] });
    expect(await rowOf(seed.id)).toMatchObject({ published: true, title: seed.title, excerpt: { et: "Otse muudetud." } });
    expect(await postDrafts()).toHaveLength(1);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("off, with a draft whose address another post has: refused with slugTaken, nothing hidden", async () => {
    const [a, b] = await seedPosts();
    expect((await save(a.id, { slug: b.slug })).ok).toBe(true);
    expect(await switchPostPublished(db, a.id, false, NOW)).toEqual({ ok: false, blocked: [{ part: "post", reason: "invalid", fields: ["Aadress"], errors: { slug: "slugTaken" } }] });
    expect((await rowOf(a.id)).published).toBe(true);
    expect(await postDrafts()).toHaveLength(1);
  });

  test("a post that is not there: notFound, either way", async () => {
    expect(await switchPostPublished(db, 99999, true, NOW)).toEqual({ ok: false, error: "notFound" });
    expect(await switchPostPublished(db, 99999, false, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  test("a draft an earlier way of saving left on a hidden post is ignored everywhere (R-a): the editor, the list, the preview, the bar's publish; on drops it", async () => {
    const { id } = await createPost(db, NOW);
    expect((await save(id, COMPLETE)).ok).toBe(true);
    const row = await rowOf(id);
    const base = (await read(id)).parts.post.version.slice(2);
    const left = { ...(await valueOf(id)), excerpt: { et: "Vana." } };
    expect(await saveDraftPart(db, { entity: "post", entityId: id, part: "post", value: left, baseVersion: base, version: null, by: ADMIN })).toMatchObject({ ok: true });
    // the editor shows the row, never that draft
    expect((await read(id)).parts.post).toMatchObject({ version: `l:${base}`, value: { excerpt: { et: "" } } });
    // the list says no change, the preview lays nothing over, the bar's publish publishes and names nothing
    expect((await listAllPosts(db)).find((p) => p.id === id)).toMatchObject({ changes: false });
    expect(await withSiteDrafts(db, target(id), "live", () => "drafted")).toBe("live");
    expect(await publishSite(db, target(id), { post: (await read(id)).parts.post.version })).toEqual({ stamp: expect.any(Number), published: [], blocked: [] });
    expect(await rowOf(id)).toEqual(row);
    expect(await postDrafts()).toHaveLength(1);
    // switched on, the post goes public with its row's text, and the draft is gone: it never shows up as a change later
    expect(await switchPostPublished(db, id, true, NOW)).toEqual({ ok: true, stamp: expect.any(Number) });
    expect(await postDrafts()).toHaveLength(0);
    expect((await rowOf(id)).excerpt).toEqual({ et: "" });
  });
});

describe("„Kustuta postitus“ (deletePost, R-h) and the list (listAllPosts)", () => {
  test("deleting a post deletes its drafts in the same transaction; another post's draft stays; a post that is gone answers false", async () => {
    const [a, b] = await seedPosts();
    expect((await save(a.id, { excerpt: { et: "Uus." } })).ok).toBe(true);
    expect((await save(b.id, { excerpt: { et: "Teine." } })).ok).toBe(true);
    expect(await deletePost(db, a.id)).toBe(true);
    expect(await rowOf(a.id)).toBeUndefined();
    expect((await postDrafts()).map((d) => d.entityId)).toEqual([b.id]);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "posts" });
    expect(await deletePost(db, a.id)).toBe(false);
    // a post that was never published leaves the public pages as they are
    pub.revalidatePublic.mockReset();
    const { id } = await createPost(db, NOW);
    expect(await deletePost(db, id)).toBe(true);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("listAllPosts: every post, newest first, `changes` true for a post with a draft", async () => {
    const [a, b] = await seedPosts();
    const { id } = await createPost(db, NOW);
    expect((await save(b.id, { excerpt: { et: "Teine." } })).ok).toBe(true);
    const list = await listAllPosts(db);
    expect(list).toHaveLength(7);
    expect(list[0]).toMatchObject({ id, changes: false });
    expect(list.find((p) => p.id === a.id)).toMatchObject({ changes: false });
    expect(list.find((p) => p.id === b.id)).toMatchObject({ changes: true });
    expect(list.filter((p) => p.changes)).toHaveLength(1);
  });
});

describe("the routes", () => {
  const signIn = async () => {
    state.cookie = await createSession(db, ADMIN);
  };
  type Route = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const call = async (route: unknown, url: string, params: Record<string, string>, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await (route as Route)(new Request(`${ORIGIN}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
      params: Promise.resolve(params),
    });
    return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
  };
  const create = () => call(createRoute, "/api/admin/uudised/uus", {});
  const switchCall = (id: string, body: unknown) => call(switchRoute, `/api/admin/uudised/${id}/avaldatud`, { id }, body);
  const deleteCall = (id: string) => call(deleteRoute, `/api/admin/uudised/${id}/kustuta`, { id });
  const saveCall = (id: string, body: unknown) => call(saveRoute, `/api/admin/sisu/post/${id}/osa/post`, { entity: "post", id, part: "post" }, body);
  const publishCall = (id: string, body: unknown) => call(publishRoute, `/api/admin/sisu/post/${id}/avalda`, { entity: "post", id }, body);
  const discardCall = (id: string) => call(discardRoute, `/api/admin/sisu/post/${id}/loobu`, { entity: "post", id });

  test("without an admin's session 401, from another site 403; nothing is made", async () => {
    expect((await create()).status).toBe(401);
    expect((await switchCall("1", { on: true })).status).toBe(401);
    expect((await deleteCall("1")).status).toBe(401);
    await signIn();
    expect((await call(createRoute, "/api/admin/uudised/uus", {}, {}, { origin: "https://evil.example" })).status).toBe(403);
    expect(await db.select().from(posts)).toHaveLength(6);
  });

  test("POST …/uudised/uus: 200 { id } of „Uus postitus“; never cached", async () => {
    await signIn();
    const made = await create();
    expect(made).toEqual({ status: 200, cache: "no-store", body: { id: expect.any(Number) } });
    expect(await rowOf(made.body.id as number)).toMatchObject({ slug: "uus-postitus", title: { et: "Uus postitus" }, published: false });
  });

  test("POST …/uudised/<id>/avaldatud { on }: 200 { ok: true, stamp } or { ok: false, missing }; 400 for another body; 404 for a post that is none", async () => {
    await signIn();
    const id = String((await create()).body.id);
    expect(await switchCall(id, { on: true })).toEqual({ status: 200, cache: "no-store", body: { ok: false, missing: ["kaanepilt", "tekst", "kategooria", "pealkiri (RU)", "tekst (RU)"] } });
    expect((await save(Number(id), COMPLETE)).ok).toBe(true);
    expect(await switchCall(id, { on: true })).toEqual({ status: 200, cache: "no-store", body: { ok: true, stamp: expect.any(Number) } });
    expect((await rowOf(Number(id))).published).toBe(true);
    for (const body of [{}, { on: "yes" }, { on: true, id: 1 }, null]) expect(await switchCall(id, body), JSON.stringify(body)).toEqual({ status: 400, cache: "no-store", body: { ok: false, error: "body" } });
    for (const bad of ["0", "x", "99999", "01"]) expect((await switchCall(bad, { on: false })).status, bad).toBe(404);
    expect(await switchCall(id, { on: false })).toMatchObject({ status: 200, body: { ok: true } });
  });

  test("POST …/uudised/<id>/kustuta: 200 { ok: true } with its drafts; 404 once it is gone", async () => {
    await signIn();
    const [seed] = await seedPosts();
    expect((await save(seed.id, { excerpt: { et: "Uus." } })).ok).toBe(true);
    expect(await deleteCall(String(seed.id))).toEqual({ status: 200, cache: "no-store", body: { ok: true } });
    expect(await postDrafts()).toHaveLength(0);
    expect((await deleteCall(String(seed.id))).status).toBe(404);
    expect((await deleteCall("x")).status).toBe(404);
  });

  test("the generic routes take post/<id>: the autosave, „Avalda muudatused“, „Loobu muudatustest“; post/0 and a post that is none are 404", async () => {
    await signIn();
    const [seed] = await seedPosts();
    const id = String(seed.id);
    const v = (await read(seed.id)).parts.post.version;
    const saved = await saveCall(id, { version: v, patch: { excerpt: { et: "Uus lühitekst." } } });
    expect(saved).toMatchObject({ status: 200, body: { ok: true, version: expect.stringMatching(/^d:\d+\.1$/) } });
    expect(await saveCall(id, { version: v, patch: { excerpt: { et: "Teine." } } })).toMatchObject({ status: 409, body: { error: "conflict", version: saved.body.version } });
    expect(await publishCall(id, { versions: { post: saved.body.version } })).toEqual({ status: 200, cache: "no-store", body: { stamp: expect.any(Number), published: ["post"], blocked: [] } });
    expect((await rowOf(seed.id)).excerpt).toEqual({ et: "Uus lühitekst." });
    const next = (await read(seed.id)).parts.post.version;
    expect((await saveCall(id, { version: next, patch: { excerpt: { et: "Veel üks." } } })).status).toBe(200);
    expect(await discardCall(id)).toEqual({ status: 200, cache: "no-store", body: { stamp: expect.any(Number) } });
    expect(await postDrafts()).toHaveLength(0);
    for (const bad of ["0", "99999", "x"]) {
      expect((await saveCall(bad, { version: "x", patch: {} })).status, bad).toBe(404);
      expect((await publishCall(bad, { versions: {} })).status, bad).toBe(404);
      expect((await discardCall(bad)).status, bad).toBe(404);
    }
    expect((await call(saveRoute, `/api/admin/sisu/post/${id}/osa/slides`, { entity: "post", id, part: "slides" }, { version: "x", patch: {} })).status).toBe(404);
    expect((await call(saveRoute, `/api/admin/sisu/home/${id}/osa/statement`, { entity: "home", id, part: "statement" }, { version: "x", patch: {} })).status).toBe(404);
    expect(await db.select().from(contentDrafts).where(and(eq(contentDrafts.entity, "post"), eq(contentDrafts.entityId, 0)))).toHaveLength(0);
  });
});
