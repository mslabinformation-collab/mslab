import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { getHomeData, readSetting } from "@/db/queries/public";
import { campaign, contentDrafts, posts, settings } from "@/db/schema";
import { applySeed } from "@/db/seed-apply";
import type { PopupOfferValue } from "@/domain/site-entities";
import { createSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// Hüpikaken on the site content's draft layer (admin UX pass piece 4b, Task 3; rulings R-c, R-d; piece4-texts S4-Q2 A, S4-Q3 A, S4-26, S4-30): the
// entity "popup" with id 0 and the one part `offer` — the newsletter popup's texts and picture (the campaign row 2) and, since F1 Task 12, nothing
// else: the discount and the code's days are the `welcome` row of discount_codes (Sooduskoodid), and the publish writes no settings.newsletter.
// A draft waits for „Avalda muudatused“. „Lehel näidatakse“ is no part:
// the instant switch acts on the live row (switchPopup), refused when the live row lacks a field a shown popup needs (`Puudub: pilt`) or when another
// tab changed the row meanwhile. On PGlite with the prototype seed, row 1 (the old campaign offer) switched on, as a database from before piece 4b may
// have it (the seed has it off since Task 4), and row 2 the newsletter popup, off (the migration's row).

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
import { POST as switchRoute } from "@/app/api/admin/hupikaken/naita/route";
import { discardSite, publishSite, readPopupSwitch, readSiteEditor, switchPopup, writeSitePart } from "@/server/site-drafts";
import { withSiteDrafts } from "@/server/site-preview";

const ORIGIN = "https://mslab.example";
const ADMIN = "admin@example.test";
const NOW = new Date("2026-10-27T09:00:00Z");
const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  await applySeed(db);
  await db.update(campaign).set({ active: true }).where(eq(campaign.id, 1));
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

const read = () => readSiteEditor(db, "popup");
const offerOf = async () => (await read()).parts.offer;
/** A save of `patch` from the version the screen holds now. */
const save = async (patch: Partial<PopupOfferValue>) => writeSitePart(db, "popup", "offer", patch, (await offerOf()).version, ADMIN, NOW);
/** „Avalda muudatused“ from a screen that has just read the popup. */
const publishNow = async () => publishSite(db, "popup", { offer: (await offerOf()).version });
const rowOf = async (id: number) => (await db.select().from(campaign).where(eq(campaign.id, id)))[0];
const newsletter = () => readSetting(db, "newsletter");
const popupDrafts = () => db.select().from(contentDrafts).where(eq(contentDrafts.entity, "popup"));
const switchNow = async (on: boolean) => switchPopup(db, on, (await readPopupSwitch(db)).version, NOW);

/** The seed's newsletter popup (row 2) as the editor holds it. */
const SEED_OFFER: PopupOfferValue = {
  kicker: { et: "MS LABi kirjad", ru: "Письма MS LAB" },
  title: { et: "Hea järgmine samm. Otse sinu postkasti.", ru: "Ваш следующий шаг. В вашем почтовом ящике." },
  text: { et: "Uued koolitused, kasulikud mõtted ja tervitussoodustus sinu esimesele koolitusele.", ru: "Новые курсы, полезные идеи и приветственная скидка на первый курс." },
  imageKey: "/seed/gift-bag-serum.jpg",
};

describe("the editor's read (readSiteEditor „popup“)", () => {
  test("one part `offer`: the newsletter row's texts and picture, no numbers; live is the same; no draft", async () => {
    const r = await read();
    expect(r.stamp).toEqual(expect.any(Number));
    expect(Object.keys(r.parts)).toEqual(["offer"]);
    expect(r.parts.offer.version).toMatch(/^l:[0-9a-f]{32}$/);
    expect(r.parts.offer.value).toEqual(SEED_OFFER);
    expect(r.parts.offer.live).toEqual(SEED_OFFER);
    // the switch is no field of the part: it has its own read
    expect(await readPopupSwitch(db)).toEqual({ on: false, version: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  test("a stored draft with discountPercent and codeDays reads without them and its publish writes nothing to settings.newsletter", async () => {
    // a draft saved before F1 Task 12 holds the two numbers (and an old settings row its welcomeCode and label): none of it is read back or written
    const settingBefore = { discountLabel: "-15%", welcomeCode: "TERE10", discountPercent: 20, codeDays: 30 };
    await setSetting(db, "newsletter", settingBefore);
    // (a draft is made by a save, then given the two keys a draft of that time held, as typed text)
    expect((await save({ title: { et: "Vana mustand" } })).ok).toBe(true);
    const [draft] = await popupDrafts();
    await db.update(contentDrafts).set({ value: { ...(draft.value as object), discountPercent: "15", codeDays: "30" } }).where(eq(contentDrafts.id, draft.id));
    const r = await offerOf();
    expect(r.value).toEqual({ ...SEED_OFFER, title: { et: "Vana mustand" } });
    expect(r.live).toEqual(SEED_OFFER);
    expect(await publishNow()).toEqual({ stamp: expect.any(Number), published: ["offer"], blocked: [] });
    expect((await rowOf(2)).title.et).toBe("Vana mustand");
    expect(await newsletter()).toEqual(settingBefore);
    expect(await popupDrafts()).toHaveLength(0);
  });
});

describe("a draft waits for „Avalda muudatused“ (S4-Q2 A, Review Focus 4)", () => {
  test("a title in the draft leaves the published popup as it is; the publish writes the row, revalidates the popup once and leaves settings.newsletter alone", async () => {
    const settingBefore = await newsletter();
    const saved = await save({ title: { et: "Uus pealkiri", ru: "Новый заголовок" } });
    expect(saved).toEqual({ ok: true, version: expect.stringMatching(/^d:\d+\.1$/), savedAt: NOW.toISOString() });
    expect((await rowOf(2)).title.et).toBe(SEED_OFFER.title.et);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    // the editor holds the draft over live
    expect((await offerOf()).value).toEqual({ ...SEED_OFFER, title: { et: "Uus pealkiri", ru: "Новый заголовок" } });
    expect((await offerOf()).live).toEqual(SEED_OFFER);

    expect(await publishNow()).toEqual({ stamp: expect.any(Number), published: ["offer"], blocked: [] });
    expect((await rowOf(2)).title).toEqual({ et: "Uus pealkiri", ru: "Новый заголовок" });
    expect(await newsletter()).toEqual(settingBefore);
    expect(await popupDrafts()).toHaveLength(0);
    // the footer of every page and the popup (the home page): once, after the commit
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "popup" });
  });

  test("the texts and the picture go to the newsletter row only; the switch, the old campaign row and the other settings keys stay as they are", async () => {
    const before = { one: await rowOf(1), two: await rowOf(2) };
    const setting = await newsletter();
    expect((await save({ title: { et: "Liitu ja saa kood ", ru: "Подпишись" }, kicker: { et: "Kirjad" }, imageKey: UPLOAD })).ok).toBe(true);
    expect(await publishNow()).toMatchObject({ published: ["offer"], blocked: [] });
    expect(await rowOf(2)).toEqual({ ...before.two, title: { et: "Liitu ja saa kood", ru: "Подпишись" }, kicker: { et: "Kirjad" }, imageKey: UPLOAD });
    expect(await rowOf(1)).toEqual(before.one);
    expect(await newsletter()).toEqual(setting);
  });

  test("the preview (withSiteDrafts) gets the newsletter row as the publish would store it, and no setting", async () => {
    expect((await save({ title: { et: "Eelvaate pealkiri" } })).ok).toBe(true);
    const shown = await withSiteDrafts(db, "popup", null as unknown, (parts) => parts.offer);
    expect(shown).toMatchObject({ popup: { id: 2, kind: "newsletter", active: false, title: { et: "Eelvaate pealkiri" } } });
    expect(shown).not.toHaveProperty("newsletter");
    // live is as it was
    expect((await rowOf(2)).title.et).toBe(SEED_OFFER.title.et);
  });

  test("the loose check of a save: lengths and the picture's form; nothing is required; the two old numbers are no fields any more", async () => {
    const refused = async (patch: Partial<PopupOfferValue>) => {
      const a = await save(patch);
      return a.ok || a.error !== "invalid" ? {} : a.fields;
    };
    expect(await refused({ title: { et: "x".repeat(121) } })).toEqual({ title: "tooLong" });
    expect(await refused({ imageKey: "javascript:alert(1)" })).toEqual({ imageKey: "image" });
    expect(await popupDrafts()).toHaveLength(0);
    // empty is no refusal: it waits for the publish
    expect((await save({ title: { et: "" }, imageKey: "" })).ok).toBe(true);
  });
});

describe("„Avalda muudatused“ of the offer (the strict check)", () => {
  test("while the popup is off, an unfinished offer publishes (its title and picture are asked when it is switched on); no number is asked", async () => {
    expect((await save({ title: { et: "" }, imageKey: "" })).ok).toBe(true);
    expect(await publishNow()).toMatchObject({ published: ["offer"], blocked: [] });
    expect(await rowOf(2)).toMatchObject({ active: false, title: { et: "" }, imageKey: "" });
  });

  test("while the popup is shown: a draft without its title or picture is held — `Puudub: pealkiri, pilt` — and the live popup stays as it is", async () => {
    expect(await switchNow(true)).toMatchObject({ ok: true });
    expect((await save({ title: { et: " " }, imageKey: "" })).ok).toBe(true);
    expect(await publishNow()).toEqual({ stamp: expect.any(Number), published: [], blocked: [{ part: "offer", reason: "missing", fields: ["pealkiri", "pilt"] }] });
    expect(await rowOf(2)).toMatchObject({ active: true, title: { et: SEED_OFFER.title.et }, imageKey: SEED_OFFER.imageKey });
    expect(await popupDrafts()).toHaveLength(1);
  });

  test("a draft whose live value changed after it began is held as changed, with S4-30's labels", async () => {
    expect((await save({ title: { et: "Mustandi pealkiri" } })).ok).toBe(true);
    // another way of saving changes the live row after the draft began
    await db.update(campaign).set({ text: { et: "Otse muudetud." } }).where(eq(campaign.id, 2));
    expect(await publishNow()).toEqual({ stamp: expect.any(Number), published: [], blocked: [{ part: "offer", reason: "changed", fields: ["Pealkiri", "Tekst"] }] });
  });
});

describe("„Lehel näidatakse“ (switchPopup, S4-26; Review Focus 3)", () => {
  test("on, with the live row lacking its picture: refused `missing: [\"pilt\"]`, nothing switched", async () => {
    await db.update(campaign).set({ imageKey: "" }).where(eq(campaign.id, 2));
    const before = await readPopupSwitch(db);
    expect(await switchPopup(db, true, before.version, NOW)).toEqual({ ok: false, missing: ["pilt"] });
    expect((await rowOf(2)).active).toBe(false);
    expect((await rowOf(1)).active).toBe(true);
    expect(await readPopupSwitch(db)).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("on, with a pending draft lacking the picture but a complete live row: it switches on (the switch acts on the live row); the old campaign row goes off (R-d); the draft stays", async () => {
    expect((await save({ imageKey: "", title: { et: "Mustand" } })).ok).toBe(true);
    const offer = (await offerOf()).version;
    const answer = await switchNow(true);
    expect(answer).toEqual({ ok: true, version: expect.stringMatching(/^[0-9a-f]{32}$/), stamp: expect.any(Number) });
    expect(await rowOf(2)).toMatchObject({ active: true, imageKey: SEED_OFFER.imageKey, title: { et: SEED_OFFER.title.et } });
    expect((await rowOf(1)).active).toBe(false);
    expect(await readPopupSwitch(db)).toEqual({ on: true, version: (answer as { version: string }).version });
    // the draft is untouched, and the switch never moves the offer's version
    expect(await popupDrafts()).toHaveLength(1);
    expect((await offerOf()).version).toBe(offer);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "campaign" });
  });

  test("a switch from a stale version (another tab switched it meanwhile) answers `changed` and changes nothing; from the answer's version, off and the undo go through", async () => {
    const seen = await readPopupSwitch(db);
    const on = await switchPopup(db, true, seen.version, NOW);
    expect(on).toMatchObject({ ok: true });
    expect(await switchPopup(db, false, seen.version, NOW)).toEqual({ ok: false, error: "changed", stamp: expect.any(Number) });
    expect((await rowOf(2)).active).toBe(true);
    // off from the version the switch answered: hidden at once, no check
    const off = await switchPopup(db, false, (on as { version: string }).version, NOW);
    expect(off).toEqual({ ok: true, version: seen.version, stamp: expect.any(Number) });
    expect((await rowOf(2)).active).toBe(false);
    expect((await rowOf(1)).active).toBe(false);
    // „Võta tagasi“: on again from the version off answered
    expect(await switchPopup(db, true, (off as { version: string }).version, NOW)).toMatchObject({ ok: true });
    expect((await rowOf(2)).active).toBe(true);
    // a publish in between changes the live row: the undo of a switch read before it is refused too
    const stale = (await readPopupSwitch(db)).version;
    expect((await save({ title: { et: "Uus pealkiri" } })).ok).toBe(true);
    expect(await publishNow()).toMatchObject({ published: ["offer"] });
    expect(await switchPopup(db, false, stale, NOW)).toMatchObject({ ok: false, error: "changed" });
  });

  test("the asked state already (a press from the version that shows it): nothing written, nothing revalidated", async () => {
    const seen = await readPopupSwitch(db);
    expect(await switchPopup(db, false, seen.version, NOW)).toEqual({ ok: true, version: seen.version, stamp: expect.any(Number) });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect((await rowOf(1)).active).toBe(true);
  });

  test("on with no newsletter row at all: refused with its title and its picture", async () => {
    await db.delete(campaign).where(eq(campaign.id, 2));
    expect(await switchNow(true)).toEqual({ ok: false, missing: ["pealkiri", "pilt"] });
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
  const switchCall = (body: unknown, headers: Record<string, string> = {}) => call(switchRoute, "/api/admin/hupikaken/naita", {}, body, headers);
  const saveCall = (body: unknown) => call(saveRoute, "/api/admin/sisu/popup/0/osa/offer", { entity: "popup", id: "0", part: "offer" }, body);
  const publishCall = (body: unknown) => call(publishRoute, "/api/admin/sisu/popup/0/avalda", { entity: "popup", id: "0" }, body);
  const discardCall = () => call(discardRoute, "/api/admin/sisu/popup/0/loobu", { entity: "popup", id: "0" });

  test("POST …/hupikaken/naita without an admin's session 401, from another site 403; nothing switched", async () => {
    const { version } = await readPopupSwitch(db);
    expect((await switchCall({ on: true, version })).status).toBe(401);
    await signIn();
    expect((await switchCall({ on: true, version }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rowOf(2)).active).toBe(false);
  });

  test("POST …/hupikaken/naita { on, version }: 200 with the switch's answer, never cached; 400 for another body", async () => {
    await signIn();
    const { version } = await readPopupSwitch(db);
    const on = await switchCall({ on: true, version });
    expect(on).toEqual({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(/^[0-9a-f]{32}$/), stamp: expect.any(Number) } });
    expect(await switchCall({ on: false, version })).toEqual({ status: 200, cache: "no-store", body: { ok: false, error: "changed", stamp: expect.any(Number) } });
    await db.update(campaign).set({ imageKey: "" }).where(eq(campaign.id, 2));
    const off = await switchCall({ on: false, version: (await readPopupSwitch(db)).version });
    expect(off).toMatchObject({ status: 200, body: { ok: true } });
    expect(await switchCall({ on: true, version: off.body.version })).toEqual({ status: 200, cache: "no-store", body: { ok: false, missing: ["pilt"] } });
    for (const body of [{}, { on: true }, { on: "yes", version }, { on: true, version: 7 }, { on: true, version, id: 1 }, null])
      expect(await switchCall(body), JSON.stringify(body)).toEqual({ status: 400, cache: "no-store", body: { ok: false, error: "body" } });
  });

  test("the generic routes take popup/0: the autosave, „Avalda muudatused“, „Loobu muudatustest“; another id or part is 404", async () => {
    await signIn();
    const v = (await offerOf()).version;
    const saved = await saveCall({ version: v, patch: { title: { et: "Marsruut" } } });
    expect(saved).toMatchObject({ status: 200, body: { ok: true, version: expect.stringMatching(/^d:\d+\.1$/) } });
    expect(await saveCall({ version: v, patch: { title: { et: "Teine" } } })).toMatchObject({ status: 409, body: { error: "conflict", version: saved.body.version } });
    expect(await saveCall({ version: saved.body.version, patch: { welcomeCode: "TERE" } })).toMatchObject({ status: 400, body: { fields: { welcomeCode: "invalid" } } });
    expect(await publishCall({ versions: { offer: saved.body.version } })).toEqual({ status: 200, cache: "no-store", body: { stamp: expect.any(Number), published: ["offer"], blocked: [] } });
    expect((await rowOf(2)).title.et).toBe("Marsruut");
    expect(await saveCall({ version: (await offerOf()).version, patch: { discountPercent: "15" } })).toMatchObject({ status: 400, body: { fields: { discountPercent: "invalid" } } });
    expect((await saveCall({ version: (await offerOf()).version, patch: { text: { et: "Seitse" } } })).status).toBe(200);
    expect(await discardCall()).toEqual({ status: 200, cache: "no-store", body: { stamp: expect.any(Number) } });
    expect(await popupDrafts()).toHaveLength(0);
    expect((await rowOf(2)).text.et).toBe(SEED_OFFER.text.et);
    expect((await call(saveRoute, "/api/admin/sisu/popup/1/osa/offer", { entity: "popup", id: "1", part: "offer" }, { version: "x", patch: {} })).status).toBe(404);
    expect((await call(saveRoute, "/api/admin/sisu/popup/0/osa/campaign", { entity: "popup", id: "0", part: "campaign" }, { version: "x", patch: {} })).status).toBe(404);
    expect((await call(publishRoute, "/api/admin/sisu/popup/1/avalda", { entity: "popup", id: "1" }, { versions: {} })).status).toBe(404);
    expect(await db.select().from(contentDrafts).where(and(eq(contentDrafts.entity, "popup"), eq(contentDrafts.entityId, 1)))).toHaveLength(0);
  });
});

// docs/deploy.md section 26 (piece 4b, Task 5): its read-only checks of Railway (item 5) and its rollback query (item 2) are run here as the doc prints
// them, so a query that would not run, or would not say what the doc says it does, fails here first. Nothing is ever run against Railway from a test.
describe("the queries of deploy.md §26, as printed there", () => {
  const section = (): string => {
    const doc = readFileSync(join(process.cwd(), "..", "docs", "deploy.md"), "utf8").replace(/\r\n/g, "\n");
    const at = doc.indexOf("\n## 26. ");
    if (at < 0) throw new Error("docs/deploy.md has no section 26");
    const end = doc.indexOf("\n## ", at + 1);
    return doc.slice(at, end < 0 ? undefined : end);
  };
  const query = (pattern: RegExp): string => {
    const found = pattern.exec(section());
    if (!found) throw new Error(`not in docs/deploy.md section 26: ${pattern}`);
    return found[1];
  };
  const rows = async (q: string): Promise<Record<string, unknown>[]> => {
    const res = (await db.execute(sql.raw(q))) as unknown as { rows?: Record<string, unknown>[] } & Record<string, unknown>[];
    return (res.rows ?? res) as Record<string, unknown>[];
  };

  test("item 2, the rollback: no row while nothing waits; a row for the posts' drafts and one for the popup's; none again once they are published or discarded", async () => {
    const q = query(/`(select entity, count\(\*\) from content_drafts where entity in \('post','popup'\) group by 1)`/);
    const left = async () => Object.fromEntries((await rows(q)).map((r) => [r.entity, Number(r.count)]));
    expect(await left()).toEqual({});
    const [post] = await db.select().from(posts).where(eq(posts.published, true)).limit(1);
    const target = { entity: "post" as const, id: post.id };
    expect(await writeSitePart(db, target, "post", { excerpt: { et: "Proov." } }, (await readSiteEditor(db, target)).parts.post.version, ADMIN, NOW)).toMatchObject({ ok: true });
    expect(await save({ title: { et: "Uus" } })).toMatchObject({ ok: true });
    expect(await left()).toEqual({ post: 1, popup: 1 });
    await publishNow();
    expect(await left()).toEqual({ post: 1 });
    await discardSite(db, target);
    expect(await left()).toEqual({});
  });

  test("item 5 (a), the old campaign offer's row: row 1 `campaign` and row 2 `newsletter`; with row 1 on, the home page has no popup until „Lehel näidatakse“ is switched on, which switches row 1 off", async () => {
    const q = query(/`(select id, kind, active from campaign)`/);
    expect(q).toBe("select id, kind, active from campaign");
    const campaignRows = async () => (await rows(q)).map((r) => ({ id: Number(r.id), kind: r.kind, active: r.active })).sort((a, b) => a.id - b.id);
    // (this file's database is one from before piece 4b: the old campaign offer shown)
    expect(await campaignRows()).toEqual([
      { id: 1, kind: "campaign", active: true },
      { id: 2, kind: "newsletter", active: false },
    ]);
    expect((await getHomeData(db)).popup).toBeNull();
    expect(await switchNow(true)).toMatchObject({ ok: true });
    expect(await campaignRows()).toEqual([
      { id: 1, kind: "campaign", active: false },
      { id: 2, kind: "newsletter", active: true },
    ]);
    expect((await getHomeData(db)).popup).toMatchObject({ id: 2, kind: "newsletter" });
  });

  test("item 5 (b), the discount's old label: the label as stored and no numbers; a publish leaves the setting as it was (F1 Task 12: the numbers are the welcome row's)", async () => {
    const q = query(/`(select value->>'discountLabel' as label, value->'discountPercent' as percent, value->'codeDays' as days from settings where key = 'newsletter')`/);
    const [before] = await rows(q);
    expect({ label: before.label, percent: before.percent ?? null, days: before.days ?? null }).toEqual({ label: "10%", percent: null, days: null });
    expect(await save({ title: { et: "Uus pealkiri" } })).toMatchObject({ ok: true });
    expect((await publishNow()).published).toEqual(["offer"]);
    const [after] = await rows(q);
    expect({ label: after.label, percent: after.percent ?? null, days: after.days ?? null }).toEqual({ label: "10%", percent: null, days: null });
    // no row at all (a database that never saved the setting): no row, and the publish does not make one
    await db.delete(settings).where(eq(settings.key, "newsletter"));
    expect(await save({ title: { et: "Veel üks" } })).toMatchObject({ ok: true });
    expect((await publishNow()).published).toEqual(["offer"]);
    expect(await rows(q)).toEqual([]);
  });
});
