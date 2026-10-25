import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { setSetting, upsertPage } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { clients, contentDrafts, courseAccess, courses, pages, settings } from "@/db/schema";
import { createSession } from "@/server/auth";
import { contractTemplate, shownVersionHolds } from "@/server/contracts";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";

// The legal texts on the draft layer (admin UX pass piece 3b, Task 5; README B4, spec C6; rulings R-d, R-e; behaviours "Contract texts on the draft
// layer"): Privaatsus, Õppetingimused, E-koolituse leping and Kontaktkoolituse leping. Typing saves to `content_drafts` (entity "legal", entity_id 1–4,
// part "text") and never to `pages` or to a version setting; „Avalda uus leping“ / „Avalda uus tekst“ publishes through the existing writers
// unchanged — a new contract version exactly as a save made one, so a student's open form or cart that showed the old version is refused as today
// (shownVersionHolds) —, and the e-course panel counts the students who will be asked again (distinct clients with an active access). The sample
// PDF („Näidisleping“) reads the draft when the card posts no text. On PGlite; the admin's session cookie is faked for the routes.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as saveRoute } from "@/app/api/admin/oigustekst/[key]/route";
import { POST as publishRoute } from "@/app/api/admin/oigustekst/[key]/avalda/route";
import { POST as sampleRoute } from "@/app/api/admin/naidisleping/route";
import { LEGAL_IDS, LEGAL_KEYS, publishLegal, reacceptCount, readLegal, writeLegalDraft, type LegalKey } from "@/server/legal-drafts";

const ORIGIN = "https://mslab.example";
const ADMIN = { email: "admin@example.test" };
const NOW = new Date("2026-10-25T09:00:00Z");
const OLD_VERSION = "2026-10-01T00:00:00.000Z";
const LIVE: Record<LegalKey, { title: { et: string; ru?: string }; body: { et: string; ru?: string } }> = {
  privacy: { title: { et: "Privaatsus" }, body: { et: "Vana privaatsustekst." } },
  terms: { title: { et: "Õppetingimused" }, body: { et: "Vanad õppetingimused." } },
  course_terms: { title: { et: "E-koolituse leping", ru: "Договор онлайн-обучения" }, body: { et: "Vana e-koolituse leping, {nimi}.", ru: "Старый договор." } },
  contract_contact: { title: { et: "Kontaktkoolituse leping" }, body: { et: "Vana kontaktleping, {nimi}." } },
};
const PAGE_KEY: Record<LegalKey, string> = { privacy: "privacy", terms: "terms", course_terms: "course_terms", contract_contact: "contract_contact" };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  vi.stubEnv("ADMIN_EMAILS", ADMIN.email);
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  for (const key of LEGAL_KEYS) await upsertPage(db, { key: PAGE_KEY[key], ...LIVE[key] });
  await setSetting(db, "courseTermsVersion", OLD_VERSION);
  await setSetting(db, "contractContactVersion", OLD_VERSION);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Everything live: every page row and every setting, as stored. */
const liveRows = async () => ({ pages: await db.select().from(pages).orderBy(pages.key), settings: await db.select().from(settings).orderBy(settings.key) });
const drafts = () => db.select().from(contentDrafts);
const versionOf = async (key: string) => readSetting(db, key);
/** A draft save from the version the screen holds now (readLegal). */
const typeText = async (key: LegalKey, patch: Record<string, unknown>) => writeLegalDraft(db, key, patch, (await readLegal(db, key)).version, ADMIN);

describe("a draft (R-d): typing never changes what is live", () => {
  test.each(LEGAL_KEYS)("%s: the text goes to content_drafts only; pages and the version settings are as they were; the editor reads the draft over live", async (key) => {
    const before = await readLegal(db, key);
    expect(before.version).toMatch(/^l:[0-9a-f]{32}$/);
    expect(before.changed).toBe(false);
    expect(before.value).toEqual(before.live);
    expect(before.live.body.et).toBe(LIVE[key].body.et);
    const rows = await liveRows();
    const shown = { contact: (await contractTemplate(db, "contact", "et")).version, ecourse: (await contractTemplate(db, "ecourse", "et")).version };

    const saved = await writeLegalDraft(db, key, { body: { et: "Uus tekst.", ru: "" } }, before.version, ADMIN);
    expect(saved).toMatchObject({ ok: true, version: expect.stringMatching(/^d:\d+\.1$/) });
    expect(await liveRows()).toEqual(rows);
    const [draft] = await drafts();
    expect(draft).toMatchObject({ entity: "legal", entityId: LEGAL_IDS[key], part: "text", version: 1, updatedBy: ADMIN.email });
    expect(await readLegal(db, key)).toEqual({ version: (saved as { version: string }).version, value: { ...before.live, body: { et: "Uus tekst.", ru: "" } }, live: before.live, changed: true });

    // a form or a cart that shows the live text now is not refused for a draft (nothing was published)
    expect(await shownVersionHolds(db, "contact", "et", await contractTemplate(db, "contact", "et"), shown.contact)).toBe(true);
    expect(await shownVersionHolds(db, "ecourse", "et", await contractTemplate(db, "ecourse", "et"), shown.ecourse)).toBe(true);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("the ids are R-d's: privacy 1, terms 2, course_terms 3, contract_contact 4", () => {
    expect(LEGAL_IDS).toEqual({ privacy: 1, terms: 2, course_terms: 3, contract_contact: 4 });
  });

  test("typed back to the live text, the draft goes: the text is live's again (no change to publish)", async () => {
    const first = await typeText("terms", { body: { et: "Muudetud." } });
    expect(first.ok).toBe(true);
    const back = await typeText("terms", { body: { et: LIVE.terms.body.et, ru: "" } });
    expect(back).toMatchObject({ ok: true, version: expect.stringMatching(/^l:[0-9a-f]{32}$/) });
    expect(await drafts()).toHaveLength(0);
    expect(await readLegal(db, "terms")).toMatchObject({ changed: false, version: (back as { version: string }).version });
  });

  test("a stale draft version is a conflict with what is stored, and nothing is written: another tab's save, a draft that ended", async () => {
    const start = (await readLegal(db, "privacy")).version;
    const a = await writeLegalDraft(db, "privacy", { body: { et: "Tab A." } }, start, ADMIN);
    expect(a.ok).toBe(true);
    const aVersion = (a as { version: string }).version;
    // tab B made its first change from live too: the draft is there already
    expect(await writeLegalDraft(db, "privacy", { body: { et: "Tab B." } }, start, ADMIN)).toEqual({ ok: false, error: "conflict", version: aVersion, value: expect.objectContaining({ body: { et: "Tab A.", ru: "" } }) });
    const a2 = await writeLegalDraft(db, "privacy", { body: { et: "Tab A, teine." } }, aVersion, ADMIN);
    expect(a2).toMatchObject({ ok: true, version: aVersion.replace(/\.1$/, ".2") });
    // tab B on the first draft version
    expect(await writeLegalDraft(db, "privacy", { body: { et: "Tab B." } }, aVersion, ADMIN)).toMatchObject({ ok: false, error: "conflict", version: aVersion.replace(/\.1$/, ".2") });
    expect((await readLegal(db, "privacy")).value.body.et).toBe("Tab A, teine.");
    // published, then a new draft: a tab still on the earlier draft is a conflict, never a write into the new one
    expect(await publishLegal(db, "privacy", aVersion.replace(/\.1$/, ".2"), NOW)).toMatchObject({ ok: true });
    const fresh = await typeText("privacy", { body: { et: "Uus mustand." } });
    expect(fresh).toMatchObject({ ok: true, version: expect.stringMatching(/^d:\d+\.1$/) });
    expect((fresh as { version: string }).version).not.toBe(aVersion);
    expect(await writeLegalDraft(db, "privacy", { body: { et: "Vana vaheleht." } }, aVersion, ADMIN)).toMatchObject({ ok: false, error: "conflict", version: (fresh as { version: string }).version });
    expect((await readLegal(db, "privacy")).value.body.et).toBe("Uus mustand.");
  });

  test("each field sent is checked by the legal texts' rules (the Estonian text required, at most 120 and 30 000 characters): a refused field is named, nothing is stored", async () => {
    const v = (await readLegal(db, "course_terms")).version;
    expect(await writeLegalDraft(db, "course_terms", { title: { et: "  " } }, v, ADMIN)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await writeLegalDraft(db, "course_terms", { title: { et: "", ru: "Только русский" } }, v, ADMIN)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await writeLegalDraft(db, "course_terms", { title: { et: "x".repeat(121) }, body: { et: "y".repeat(30_001) } }, v, ADMIN)).toEqual({ ok: false, error: "invalid", fields: { title: "tooLong", body: "tooLong" } });
    expect(await drafts()).toHaveLength(0);
    // a field not sent is not judged: a first contact text may start with its body (its title waits; the publish asks for it)
    await db.delete(pages).where(eq(pages.key, "contract_contact"));
    expect(await typeText("contract_contact", { body: { et: "Ainult tekst." } })).toMatchObject({ ok: true });
  });
});

describe("publish (C6): through the existing writers, a new version exactly as a save made one", () => {
  test("E-koolituse leping: courseTermsVersion moves once, with the text; the draft is gone; a second publish with no change does not bump; a cart or a gate showing the old version is refused", async () => {
    const shown = (await contractTemplate(db, "ecourse", "et")).version;
    expect(shown).toBe(OLD_VERSION);
    const saved = await typeText("course_terms", { body: { et: "Uus e-koolituse leping, {nimi}.", ru: "Новый договор." } });
    const published = await publishLegal(db, "course_terms", (saved as { version: string }).version, NOW);
    expect(published).toMatchObject({ ok: true, state: { changed: false, version: expect.stringMatching(/^l:/) } });
    const version = await versionOf("courseTermsVersion");
    expect(typeof version).toBe("string");
    expect(version).not.toBe(OLD_VERSION);
    expect(new Date(version as string).toISOString()).toBe(version);
    expect((await db.select().from(pages).where(eq(pages.key, "course_terms")))[0]).toMatchObject({ title: LIVE.course_terms.title, body: { et: "Uus e-koolituse leping, {nimi}.", ru: "Новый договор." } });
    expect(await drafts()).toHaveLength(0);
    // the student's open cart (or the terms gate) still shows the old version: refused, as a save refused it
    expect(await shownVersionHolds(db, "ecourse", "et", await contractTemplate(db, "ecourse", "et"), shown)).toBe(false);

    // pressed again (nothing changed since): no write, the version stays
    const rows = await liveRows();
    const again = await publishLegal(db, "course_terms", (published as { state: { version: string } }).state.version, NOW);
    expect(again).toMatchObject({ ok: true });
    expect(await liveRows()).toEqual(rows);
    expect(await versionOf("courseTermsVersion")).toBe(version);
  });

  test("Kontaktkoolituse leping: contractContactVersion moves to the publish time, the text is stored trimmed; a form that showed the old version is refused", async () => {
    const shown = (await contractTemplate(db, "contact", "et")).version;
    const saved = await typeText("contract_contact", { title: { et: " Uus leping ", ru: "" }, body: { et: "Uus tekst, {nimi}.\n", ru: " Новый. " } });
    expect(await publishLegal(db, "contract_contact", (saved as { version: string }).version, NOW)).toMatchObject({ ok: true });
    expect(await versionOf("contractContactVersion")).toBe(NOW.toISOString());
    expect((await db.select().from(pages).where(eq(pages.key, "contract_contact")))[0]).toMatchObject({ title: { et: "Uus leping" }, body: { et: "Uus tekst, {nimi}.", ru: "Новый." } });
    expect(await shownVersionHolds(db, "contact", "et", await contractTemplate(db, "contact", "et"), shown)).toBe(false);
  });

  test("Õppetingimused while the contact text is empty: it is the contact contract, so its published text is a new contract version for the forms; Privaatsus: written, no version", async () => {
    await db.delete(pages).where(eq(pages.key, "contract_contact"));
    const shown = (await contractTemplate(db, "contact", "et")).version;
    expect(shown).toMatch(/^terms:/);
    const saved = await typeText("terms", { body: { et: "Uued õppetingimused." } });
    expect(await publishLegal(db, "terms", (saved as { version: string }).version, NOW)).toMatchObject({ ok: true });
    expect(await shownVersionHolds(db, "contact", "et", await contractTemplate(db, "contact", "et"), shown)).toBe(false);
    const settingsBefore = (await liveRows()).settings;
    const privacy = await typeText("privacy", { title: { et: "Privaatsuspoliitika" } });
    expect(await publishLegal(db, "privacy", (privacy as { version: string }).version, NOW)).toMatchObject({ ok: true });
    expect((await db.select().from(pages).where(eq(pages.key, "privacy")))[0]).toMatchObject({ title: { et: "Privaatsuspoliitika" }, body: { et: LIVE.privacy.body.et } });
    expect((await liveRows()).settings).toEqual(settingsBefore);
  });

  test("the pages of the text are revalidated once after a publish (the existing targets), never after a refusal or for nothing", async () => {
    const saved = await typeText("course_terms", { body: { et: "Uus." } });
    expect(await publishLegal(db, "course_terms", "d:0.0", NOW)).toMatchObject({ ok: false, error: "changed" });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    await publishLegal(db, "course_terms", (saved as { version: string }).version, NOW);
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "settings", parts: ["course_terms"] }]]);
    await publishLegal(db, "course_terms", (await readLegal(db, "course_terms")).version, NOW);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
  });

  test("a screen on an older version (another tab typed into the draft meanwhile) is refused as changed: nothing written, the draft and its text stay, the stored state comes back", async () => {
    const mine = await typeText("contract_contact", { body: { et: "Minu tekst." } });
    const other = await writeLegalDraft(db, "contract_contact", { body: { et: "Teise vahelehe tekst." } }, (mine as { version: string }).version, ADMIN);
    expect(other.ok).toBe(true);
    const rows = await liveRows();
    const refused = await publishLegal(db, "contract_contact", (mine as { version: string }).version, NOW);
    expect(refused).toMatchObject({ ok: false, error: "changed", state: { version: (other as { version: string }).version, changed: true, value: { body: { et: "Teise vahelehe tekst." } } } });
    expect(await liveRows()).toEqual(rows);
    expect(await drafts()).toHaveLength(1);
  });

  test("live written another way after the draft began (its base is old): refused as changed and never overwritten unseen; the draft is kept on the new live, and the next press publishes it", async () => {
    const saved = await typeText("privacy", { body: { et: "Minu mustand." } });
    await upsertPage(db, { key: "privacy", title: { et: "Privaatsus" }, body: { et: "Kirjutatud mujalt." } });
    const version = (saved as { version: string }).version;
    const refused = await publishLegal(db, "privacy", version, NOW);
    expect(refused).toMatchObject({ ok: false, error: "changed", state: { version, changed: true, live: { body: { et: "Kirjutatud mujalt." } }, value: { body: { et: "Minu mustand." } } } });
    expect((await db.select().from(pages).where(eq(pages.key, "privacy")))[0].body).toEqual({ et: "Kirjutatud mujalt." });
    // she was told; pressed again, her text goes live
    expect(await publishLegal(db, "privacy", version, NOW)).toMatchObject({ ok: true });
    expect((await db.select().from(pages).where(eq(pages.key, "privacy")))[0].body).toEqual({ et: "Minu mustand." });
  });

  test("a draft the writer refuses (a first contact text without a title) is invalid by field: nothing is written and the draft stays", async () => {
    await db.delete(pages).where(eq(pages.key, "contract_contact"));
    const saved = await typeText("contract_contact", { body: { et: "Ainult tekst." } });
    const rows = await liveRows();
    expect(await publishLegal(db, "contract_contact", (saved as { version: string }).version, NOW)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await liveRows()).toEqual(rows);
    expect(await drafts()).toHaveLength(1);
  });
});

describe("reacceptCount (R-e): the students the e-course panel says will be asked again", () => {
  test("distinct clients with an active e-course access (not revoked, not expired): two accesses of one client count once", async () => {
    const course = async (slug: string) =>
      (await db.insert(courses).values({ slug, type: "e_learning", level: "basic", title: { et: slug }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 }).returning())[0];
    const client = async (email: string) => (await db.insert(clients).values({ email }).returning())[0];
    const [a, b] = [await course("e-koolitus-a"), await course("e-koolitus-b")];
    const [kati, mari, liis, anu] = [await client("kati@example.test"), await client("mari@example.test"), await client("liis@example.test"), await client("anu@example.test")];
    const access = (clientId: number, courseId: number, over: Partial<typeof courseAccess.$inferInsert> = {}) =>
      db.insert(courseAccess).values({ clientId, courseId, grantedBy: "maria@example.test", expiresAt: new Date("2027-04-01T00:00:00Z"), ...over });
    expect(await reacceptCount(db, NOW)).toBe(0);
    await access(kati.id, a.id);
    await access(kati.id, b.id); // (one student, two courses: asked once per course, counted once)
    await access(mari.id, a.id);
    await access(liis.id, a.id, { revokedAt: new Date("2026-10-20T00:00:00Z") });
    await access(anu.id, b.id, { expiresAt: new Date("2026-10-24T00:00:00Z") });
    expect(await reacceptCount(db, NOW)).toBe(2);
    // an access that ends exactly now is not active
    expect(await reacceptCount(db, new Date("2027-04-01T00:00:00Z"))).toBe(0);
  });
});

describe("the routes", () => {
  const signIn = async () => {
    state.cookie = await createSession(db, ADMIN.email);
  };
  const call = async (route: typeof saveRoute, url: string, key: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await route(new Request(`${ORIGIN}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ key }) });
    return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
  };
  const save = (key: string, body: unknown, headers?: Record<string, string>) => call(saveRoute, `/api/admin/oigustekst/${key}`, key, body, headers);
  const publish = (key: string, body: unknown, headers?: Record<string, string>) => call(publishRoute, `/api/admin/oigustekst/${key}/avalda`, key, body, headers);

  test("without an admin's session 401, from another site 403, a text that is none 404; nothing stored", async () => {
    expect((await save("privacy", { version: "x", patch: {} })).status).toBe(401);
    expect((await publish("privacy", { version: "x" })).status).toBe(401);
    await signIn();
    expect((await save("privacy", { version: "x", patch: {} }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await publish("privacy", { version: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    for (const key of ["contact", "pages", "tingimused", ""]) {
      expect((await save(key, { version: "x", patch: {} })).status, key).toBe(404);
      expect((await publish(key, { version: "x" })).status, key).toBe(404);
    }
    expect(await drafts()).toHaveLength(0);
  });

  test("POST /api/admin/oigustekst/<key>: the draft's autosave — 200 its version, 409 what is stored, 400 by field; never cached", async () => {
    await signIn();
    const live = (await readLegal(db, "terms")).version;
    const ok = await save("terms", { version: live, patch: { body: { et: "Uus." } } });
    expect(ok).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(/^d:\d+\.1$/) } });
    expect(await save("terms", { version: live, patch: { body: { et: "Teine." } } })).toMatchObject({ status: 409, body: { ok: false, error: "conflict", version: ok.body.version } });
    expect(await save("terms", { version: ok.body.version, patch: { title: { et: "" } } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { title: "required" } } });
    expect(await save("terms", { version: ok.body.version, patch: { other: "x" } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid" } });
    expect((await db.select().from(pages).where(eq(pages.key, "terms")))[0].body).toEqual(LIVE.terms.body);
  });

  test("POST /api/admin/oigustekst/<key>/avalda: 200 the new state, 409 changed with the stored state, 400 a body that is no publish", async () => {
    await signIn();
    const saved = await save("course_terms", { version: (await readLegal(db, "course_terms")).version, patch: { body: { et: "Avaldatav." } } });
    expect(await publish("course_terms", { nothing: 1 })).toMatchObject({ status: 400, body: { ok: false, error: "body" } });
    expect(await publish("course_terms", { version: "d:0.0" })).toMatchObject({ status: 409, body: { ok: false, error: "changed", version: saved.body.version, changed: true } });
    const done = await publish("course_terms", { version: saved.body.version });
    expect(done).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, changed: false, version: expect.stringMatching(/^l:/), live: { body: { et: "Avaldatav." } } } });
    expect(await versionOf("courseTermsVersion")).not.toBe(OLD_VERSION);
  });
});

describe("the sample PDF uses the draft (R-d)", () => {
  /** The text a PDF draws, all its pages, one run a line. */
  const textOf = async (res: Response) => {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const count = (await import("pdf-lib").then((m) => m.PDFDocument.load(bytes))).getPageCount();
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(...(await readPdf(bytes, i)).runs.map((r) => r.text));
    return out.join("\n");
  };
  const sample = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return sampleRoute(new Request(`${ORIGIN}/api/admin/naidisleping`, { method: "POST", body: form }), undefined);
  };

  test("a field the card does not post is the contact text's draft when there is one, else live's; a posted field is the card's", async () => {
    state.cookie = await createSession(db, ADMIN.email);
    const live = await textOf(await sample({ lang: "et" }));
    expect(live).toContain("Kontaktkoolituse leping");
    expect(live).toContain("Vana kontaktleping, Proov (näidis).");
    await typeText("contract_contact", { title: { et: "Mustandi pealkiri" }, body: { et: "Mustandi tekst, {nimi}." } });
    const draft = await textOf(await sample({ lang: "et" }));
    expect(draft).toContain("Mustandi pealkiri");
    expect(draft).toContain("Mustandi tekst, Proov (näidis).");
    expect(draft).not.toContain("Vana kontaktleping");
    // what the card posts is the screen's (newer than the stored draft while a save waits)
    const posted = await textOf(await sample({ titleEt: "Ekraani pealkiri", bodyEt: "Ekraani tekst.", lang: "et" }));
    expect(posted).toContain("Ekraani pealkiri");
    expect(posted).not.toContain("Mustandi");
    // nothing is published by a sample
    expect((await db.select().from(pages).where(eq(pages.key, "contract_contact")))[0].body).toEqual(LIVE.contract_contact.body);
  });
});
