import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { getHomeData, getPracticePackages, getTrainerPage } from "@/db/queries/public";
import { courses, type PracticePackage } from "@/db/schema";
import { applySeed } from "@/db/seed-apply";
import { newSlideDraft, type FaqDraft, type PackageDraft, type SlideDraft, type TrainerDraft, type WorkDraft } from "@/domain/site-editor";
import type { SiteEntity } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { createSession } from "@/server/auth";
import { saveDraftPart } from "@/server/drafts";
import { makeTestDb } from "./helpers";

// The admin's draft preview of the site content (admin UX pass piece 4a, Task 3; ruling R-f; README §1.8 „Eelvaade ↗“): with Next's draft mode on AND a
// live admin session (server/preview.ts previewActive), the public home page, /koolitaja and /praktika show each part's draft as „Avalda muudatused“
// would store it (server/site-preview.ts withSiteDrafts) — a part whose draft fails its strict check shows live — under the preview bar of the page's
// entity (home, trainer, practice). Every other request, and the static render, reads live and never looks for a session; the footer (the site
// layout, cached with "nothing depends on the request") is always live. On PGlite with the prototype seed; the session cookie and draftMode are faked.

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
// (the pages' client components read the router, which a page rendered to HTML here has not got; notFound() stays the real one)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import HomePage from "@/app/[locale]/(site)/page";
import TrainerPage from "@/app/[locale]/(site)/koolitaja/page";
import PracticePage from "@/app/[locale]/(site)/praktika/page";
import SiteLayout from "@/app/[locale]/(site)/layout";
import { previewActive } from "@/server/preview";
import { publishSite, readSiteEditor, writeSitePart } from "@/server/site-drafts";
import { withSiteDrafts } from "@/server/site-preview";

const ME = "maria@example.test";
const NOW = new Date("2026-10-26T09:00:00Z");
const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const BAR = "data-preview-bar";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  await applySeed(db);
  state.db = db;
  state.cookie = undefined;
  state.draftOn = false;
  state.cookieReads = 0;
  vi.stubEnv("ADMIN_EMAILS", ME);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** A part's value as its editor holds it now (the draft over live). */
const valueOf = async <V>(entity: SiteEntity, part: string) => clone((await readSiteEditor(db, entity)).parts[part].value) as V;
/** „Avalda muudatused“ from a screen that has just read the entity: every part's version as that read gives it (the route's `{ versions }`). */
const publishNow = async (entity: SiteEntity) =>
  publishSite(db, entity, Object.fromEntries(Object.entries((await readSiteEditor(db, entity)).parts).map(([part, s]) => [part, s.version])));
/** A save of `patch` from the version the editor holds now: it goes to the part's draft (the loose check), live is left alone. */
async function save(entity: SiteEntity, part: string, patch: Record<string, unknown>) {
  const answer = await writeSitePart(db, entity, part, patch, (await readSiteEditor(db, entity)).parts[part].version, ME, NOW);
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
}
/** Draft mode on and Maria signed in: her preview. */
async function asAdmin() {
  state.draftOn = true;
  state.cookie = await createSession(db, ME);
}
const byCode = (list: PracticePackage[], code: string) => list.find((p) => p.code === code)!;
/** What /praktika and the home page show of the packages: the draft's price over live (the pick of the page readers). */
const packagesOver = (live: PracticePackage[]) => (parts: Record<string, unknown>) => live.map((p) => (parts[p.code] as PracticePackage | undefined) ?? p);

describe("withSiteDrafts (R-f): each part's draft that passes its strict check, every other part live", () => {
  test("with a practice draft, the overlay returns the draft price (in cents, as the publish stores it); the other package stays live", async () => {
    await save("practice", "MAXI", { price: "987,50" });
    const live = await getPracticePackages(db);
    const pick = vi.fn(packagesOver(live));
    const shown = await withSiteDrafts(db, "practice", live, pick);
    expect(byCode(shown, "MAXI").price).toBe(98750);
    expect(byCode(shown, "MINI")).toEqual(byCode(live, "MINI"));
    // only the drafted part is handed over, as the package row „Avalda muudatused“ makes of it
    expect(Object.keys(pick.mock.calls[0][0])).toEqual(["MAXI"]);
    expect(pick.mock.calls[0][0].MAXI).toEqual({ ...byCode(live, "MAXI"), price: 98750 });
    // live is left alone
    expect(byCode(await getPracticePackages(db), "MAXI").price).toBe(15000);
  });

  test("a draft that fails the strict check (an empty price) shows live; a package beside it that passes shows its draft", async () => {
    await save("practice", "MAXI", { price: "" });
    await save("practice", "MINI", { price: "120" });
    const live = await getPracticePackages(db);
    const shown = await withSiteDrafts(db, "practice", live, packagesOver(live));
    expect(byCode(shown, "MAXI")).toEqual(byCode(live, "MAXI"));
    expect(byCode(shown, "MINI").price).toBe(12000);
  });

  test("no draft, or only drafts that fail: live itself, without a call of `pick`", async () => {
    const live = await getPracticePackages(db);
    const pick = vi.fn(packagesOver(live));
    expect(await withSiteDrafts(db, "practice", live, pick)).toBe(live);
    await save("practice", "MAXI", { price: "", name: { et: "" } });
    expect(await withSiteDrafts(db, "practice", live, pick)).toBe(live);
    expect(pick).not.toHaveBeenCalled();
  });

  test("a stored draft that is not the part's (jsonb holds anything) is read as live, and a draft of a package that is gone is left out", async () => {
    await saveDraftPart(db, { entity: "practice", entityId: 0, part: "MAXI", value: { price: 12 }, baseVersion: "x", version: null, by: ME });
    await saveDraftPart(db, { entity: "practice", entityId: 0, part: "GONE", value: { price: "1" }, baseVersion: "x", version: null, by: ME });
    const live = await getPracticePackages(db);
    expect(await withSiteDrafts(db, "practice", live, packagesOver(live))).toEqual(live);
  });
});

describe("the page readers: drafts only when the page asks for them (the admin's preview)", () => {
  test("without draft mode the page reader returns live (as /praktika asks: previewActive first), and nothing looks for the session", async () => {
    await save("practice", "MAXI", { price: "987" });
    state.cookie = await createSession(db, ME); // a signed-in admin, but not in her preview
    state.cookieReads = 0;
    expect(byCode(await getPracticePackages(db, { drafts: await previewActive() }), "MAXI").price).toBe(15000);
    expect(state.cookieReads).toBe(0);
    // draft mode on and no session (a visitor with the draft-mode cookie): live
    state.draftOn = true;
    state.cookie = undefined;
    expect(byCode(await getPracticePackages(db, { drafts: await previewActive() }), "MAXI").price).toBe(15000);
    // her preview: the draft
    await asAdmin();
    expect(byCode(await getPracticePackages(db, { drafts: await previewActive() }), "MAXI").price).toBe(98700);
  });

  test("the home page's data: its own parts, the trainer's card and the packages, each from its own entity's drafts; live without them", async () => {
    const slides = (await valueOf<{ slides: SlideDraft[] }>("home", "slides")).slides;
    expect(slides.length).toBeGreaterThan(1);
    slides[0].title = { et: "  Uus pealkiri  ", ru: "Новый" };
    slides[1].active = false; // „Näidatakse avalehel“ off: the home page leaves it out
    await save("home", "slides", { slides });
    await save("home", "statement", { body: { et: "Uus lause." } });
    const faq = (await valueOf<{ faq: FaqDraft[] }>("home", "faq")).faq;
    await save("home", "faq", { faq: [{ uid: "new-1", id: null, q: { et: "Uus küsimus?" }, a: { et: "Uus vastus." } }, ...faq] });
    await save("trainer", "trainer", { name: { et: "Maria Uus" } });
    await save("trainer", "bio", { body: { et: "Uus tutvustus." } });
    await save("practice", "MAXI", { price: "199" });

    const live = await getHomeData(db);
    const shown = await getHomeData(db, { drafts: true });
    expect(shown.slides.map((s) => s.title)).toEqual([{ et: "Uus pealkiri", ru: "Новый" }, ...live.slides.slice(2).map((s) => s.title)]);
    expect(shown.slides[0].id).toBe(live.slides[0].id);
    expect(shown.pages.statement.body).toEqual({ et: "Uus lause." });
    expect(shown.pages.statement.title).toEqual(live.pages.statement.title); // (the statement's title is not the part's: kept)
    expect(shown.faq.map((f) => f.q.et)).toEqual(["Uus küsimus?", ...live.faq.map((f) => f.q.et)]);
    expect(shown.pages.trainer_bio.body).toEqual({ et: "Uus tutvustus." });
    const trainer = shown.settings.trainer as Record<string, unknown>;
    expect(trainer.name).toEqual({ et: "Maria Uus" });
    // (a key of the setting outside the part, the contact block's photo, stays)
    expect(trainer.contactPhotoKey).toBe((live.settings.trainer as Record<string, unknown>).contactPhotoKey);
    expect(byCode(shown.practice, "MAXI").price).toBe(19900);
    // the rest of the page is live, and so is everything without draft mode
    expect(shown.posts).toEqual(live.posts);
    expect(shown.courses).toEqual(live.courses);
    expect(shown.settings.contact).toEqual(live.settings.contact);
    expect(await getHomeData(db)).toEqual(live);
    expect(live.pages.statement.body.et).not.toBe("Uus lause.");
  });

  test("a home part whose draft fails the strict check (a new slide without its picture) shows live; the statement drafted beside it shows", async () => {
    const slides = (await valueOf<{ slides: SlideDraft[] }>("home", "slides")).slides;
    await save("home", "slides", { slides: [...slides, newSlideDraft("new-1")] });
    await save("home", "statement", { body: { et: "Uus lause." } });
    const live = await getHomeData(db);
    const shown = await getHomeData(db, { drafts: true });
    expect(shown.slides).toEqual(live.slides);
    expect(shown.pages.statement.body).toEqual({ et: "Uus lause." });
  });

  test("the trainer page's data: the card, bio, works and stories from the trainer's drafts; live without them", async () => {
    const card = await valueOf<TrainerDraft>("trainer", "trainer");
    await save("trainer", "trainer", { name: { et: "Maria Uus" }, stats: [...card.stats, { uid: "t9", value: "7", label: { et: "aastat" } }].slice(-3) });
    await save("trainer", "works", { works: [{ key: UPLOAD, alt: { et: "Uus töö" } }] satisfies WorkDraft[] });
    await save("trainer", "center_story", { title: { et: "Lugu" }, body: { et: "Esimene lõik.\n\nTeine lõik." } });
    const live = await getTrainerPage(db);
    const shown = await getTrainerPage(db, { drafts: true });
    const trainer = shown.trainer as Record<string, unknown>;
    expect(trainer.name).toEqual({ et: "Maria Uus" });
    expect((trainer.stats as { value: string }[]).at(-1)).toEqual({ value: "7", label: { et: "aastat" } });
    expect(trainer.contactPhotoKey).toBe((live.trainer as Record<string, unknown>).contactPhotoKey);
    expect(shown.works.map((w) => [w.key, w.alt])).toEqual([[UPLOAD, { et: "Uus töö" }]]);
    expect(shown.story).toMatchObject({ key: "center_story", title: { et: "Lugu" }, body: { et: "Esimene lõik.\n\nTeine lõik." } });
    expect(shown.bio).toEqual(live.bio);
    expect(shown.journey).toEqual(live.journey);
    expect(await getTrainerPage(db)).toEqual(live);
  });
});

describe("what the preview shows is what „Avalda muudatused“ stores (one definition: the part's check)", () => {
  const noIds = <R extends { id: number }>(rows: R[]) => rows.map((row) => ({ ...row, id: undefined }));

  test("every part of the three entities answers its write with what it stores (Write.shown): none is left out of the preview unseen", async () => {
    const { partsOf, strictDraft } = await import("@/server/site-drafts");
    const seen: string[] = [];
    for (const entity of ["home", "trainer", "practice"] as const) {
      for (const [part, def] of Object.entries(await partsOf(db, entity))) {
        const { check, write } = strictDraft(entity, part, def, await def.read(db), {});
        expect(check.ok, `${entity} ${part}`).toBe(true);
        expect(write?.shown, `${entity} ${part}`).toBeTypeOf("function");
        seen.push(`${entity}.${part}`);
      }
    }
    expect(seen).toEqual(["home.slides", "home.statement", "home.teaser", "home.faq", "trainer.trainer", "trainer.bio", "trainer.works", "trainer.center_story", "trainer.trainer_journey", "practice.MINI", "practice.MAXI"]);
  });

  test("Avaleht, Koolitaja and Praktika: every part drafted, the preview's data equals the live data after the publish", async () => {
    const slides = (await valueOf<{ slides: SlideDraft[] }>("home", "slides")).slides;
    const moved = [{ ...slides[1], title: { et: " Teine ette " } }, { ...slides[0], ctaHref: " /praktika " }, ...slides.slice(2), { ...newSlideDraft("new-1"), imageKey: UPLOAD, title: { et: "Uus" }, ctaHref: "/kontakt", active: true }];
    await save("home", "slides", { slides: moved });
    await save("home", "statement", { body: { et: " Uus lause. ", ru: " " } });
    await save("home", "teaser", { body: { et: "Kaardi tekst." } });
    const faq = (await valueOf<{ faq: FaqDraft[] }>("home", "faq")).faq;
    await save("home", "faq", { faq: [...faq.slice(1), { uid: "new-2", id: null, q: { et: "K?" }, a: { et: "V." } }, { uid: "new-3", id: null, q: { et: "" }, a: { et: "" } }] });
    await save("trainer", "trainer", { name: { et: " Maria Uus " }, role: { et: "" }, portraitKey: UPLOAD, portraitPos: "30% 40%" });
    await save("trainer", "bio", { body: { et: "Uus tutvustus." } });
    await save("trainer", "works", { works: [{ key: UPLOAD, alt: { et: "" } }] });
    await save("trainer", "trainer_journey", { title: { et: "Teekond" }, body: { et: "Tekst." } });
    const maxi = await valueOf<PackageDraft>("practice", "MAXI");
    await save("practice", "MAXI", { price: "1 234,5", models: " 3 ", items: [...maxi.items, { et: " Uus punkt " }, { et: "" }], tagline: { et: "" } });

    const home = await getHomeData(db, { drafts: true });
    const trainer = await getTrainerPage(db, { drafts: true });
    const practice = await getPracticePackages(db, { drafts: true });
    for (const entity of ["home", "trainer", "practice"] as const) expect((await publishNow(entity)).blocked).toEqual([]);
    const after = { home: await getHomeData(db), trainer: await getTrainerPage(db), practice: await getPracticePackages(db) };

    // (a new row's id is the database's after the publish; the preview gives it a placeholder: rows compared without their ids, kept ids compared)
    expect(noIds(home.slides)).toEqual(noIds(after.home.slides));
    expect(home.slides.filter((s) => s.id > 0).map((s) => s.id)).toEqual(after.home.slides.slice(0, -1).map((s) => s.id));
    expect(noIds(home.faq)).toEqual(noIds(after.home.faq));
    // (the pages the home page shows; the others in its record, the stories, are not its own and stay live there)
    for (const key of ["statement", "trainer_teaser", "trainer_bio"]) expect(home.pages[key], key).toEqual(after.home.pages[key]);
    expect(home.settings.trainer).toEqual(after.home.settings.trainer);
    expect(home.practice).toEqual(after.home.practice);
    expect(trainer.trainer).toEqual(after.trainer.trainer);
    expect([trainer.bio, trainer.story, trainer.journey]).toEqual([after.trainer.bio, after.trainer.story, after.trainer.journey]);
    expect(noIds(trainer.works)).toEqual(noIds(after.trainer.works));
    expect(practice).toEqual(after.practice);
  });
});

describe("the pages in the admin's preview: the drafts and the bar of the page's entity; everyone else: live, no bar", () => {
  const practicePage = (locale: "et" | "ru" = "et") => PracticePage({ params: Promise.resolve({ locale }) }).then((tree) => renderToStaticMarkup(tree));
  const trainerPage = (locale: "et" | "ru" = "et") => TrainerPage({ params: Promise.resolve({ locale }) }).then((tree) => renderToStaticMarkup(tree));
  const homePage = (locale: "et" | "ru" = "et") => HomePage({ params: Promise.resolve({ locale }) }).then((tree) => renderToStaticMarkup(tree));
  /** A visitor's page (draft mode off, a session or not) and a stranger's (draft mode on, no session): both live, no bar. */
  async function others(render: () => Promise<string>) {
    state.cookie = await createSession(db, ME);
    state.draftOn = false;
    state.cookieReads = 0;
    const off = await render();
    // (the static render and a visitor's request never look for a session: the page stays in the cache)
    expect(state.cookieReads).toBe(0);
    state.draftOn = true;
    state.cookie = undefined;
    const stranger = await render();
    return [off, stranger];
  }

  test("/praktika: the drafted price, „Avaldamata 1“, „Loobu muudatustest“ and the way out to /praktika; the Russian page leaves to /ru/praktika", async () => {
    await save("practice", "MAXI", { price: "987" });
    await asAdmin();
    const page = await practicePage();
    expect(page).toContain("987 €");
    expect(page).not.toContain("150 €");
    expect(page).toContain(BAR);
    expect(page).toContain("Avaldamata 1");
    expect(page).toContain("Loobu muudatustest");
    expect(page).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2Fpraktika" data-preview-exit="">Lõpeta eelvaade</a>');
    expect(await practicePage("ru")).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2Fru%2Fpraktika"');
    for (const other of await others(() => practicePage())) {
      expect(other).toContain("150 €");
      expect(other).not.toContain("987 €");
      expect(other).not.toContain(BAR);
      expect(other).not.toContain("eelvaade?lopeta");
    }
  });

  test("/koolitaja: the drafted name and bio under the trainer's bar; a visitor's page is live", async () => {
    await save("trainer", "trainer", { name: { et: "Maria Uus" } });
    await save("trainer", "bio", { body: { et: "Uus tutvustus." } });
    await asAdmin();
    const page = await trainerPage();
    expect(page).toMatch(/<h1[^>]*>Maria Uus<\/h1>/);
    expect(page).toContain("Uus tutvustus.");
    expect(page).toContain(BAR);
    expect(page).toContain("Avaldamata 2");
    expect(page).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2Fkoolitaja"');
    for (const other of await others(() => trainerPage())) {
      expect(other).toMatch(/<h1[^>]*>Maria Sosnina<\/h1>/);
      expect(other).not.toContain("Uus tutvustus.");
      expect(other).not.toContain(BAR);
    }
  });

  test("the home page: its own drafts, the trainer's and the packages', under the home page's bar, which counts the home page's changes only", async () => {
    await save("home", "statement", { body: { et: "Uus lause avalehel." } });
    await save("trainer", "trainer", { name: { et: "Maria Uus" } });
    await save("practice", "MAXI", { price: "987" });
    await asAdmin();
    const page = await homePage();
    expect(page).toContain("Uus lause avalehel.");
    expect(page).toContain("Maria Uus");
    expect(page).toContain("987 €");
    expect(page).toContain(BAR);
    expect(page).toContain("Avaldamata 1");
    expect(page).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2F" data-preview-exit=""');
    expect(await homePage("ru")).toContain('href="/api/admin/eelvaade?lopeta=1&amp;tee=%2Fru"');
    for (const other of await others(() => homePage())) {
      for (const draft of ["Uus lause avalehel.", "Maria Uus", "987 €", BAR]) expect(other).not.toContain(draft);
    }
  });

  test("in the preview with nothing unpublished: the way out only", async () => {
    await asAdmin();
    const page = await practicePage();
    expect(page).toContain(BAR);
    expect(page).not.toContain("data-preview-count");
    expect(page).not.toContain("Loobu muudatustest");
    expect(page).toContain("Lõpeta eelvaade");
  });

  test("the footer (the site layout) stays live in her preview, and the layout reads neither the request nor a draft", async () => {
    await save("trainer", "trainer", { name: { et: "Maria Uus" } });
    await asAdmin();
    state.cookieReads = 0;
    const html = renderToStaticMarkup(await SiteLayout({ children: null, params: Promise.resolve({ locale: "et" }) }));
    expect(html).toContain("Maria Sosnina");
    expect(html).not.toContain("Maria Uus");
    expect(state.cookieReads).toBe(0);
    const source = readFileSync("src/app/[locale]/(site)/layout.tsx", "utf8");
    expect(source).not.toMatch(/previewActive|draftMode|site-preview|withSiteDrafts|next\/headers|drafts:/);
  });
});

describe("sitePreviewBarProps: the bar of a site page", () => {
  test("the entity's discard route and copies, „Avaldamata {n}“ with the PublishBar's count (siteChangeLabels), the way out; the course's words", async () => {
    const { sitePreviewBarProps } = await import("@/server/preview-bar");
    await save("practice", "MAXI", { price: "987", name: { et: "MAXI uus" } });
    const props = await sitePreviewBarProps(db, "practice", "/ru/praktika");
    expect(props).toMatchObject({ discardHref: "/api/admin/sisu/practice/0/loobu", copies: { site: "practice" }, count: 2, exitHref: "/api/admin/eelvaade?lopeta=1&tee=%2Fru%2Fpraktika" });
    const t = adminEt.publish;
    expect(props.t).toEqual({ count: "Avaldamata 2", exit: t.previewExit, discard: t.discard, question: "Kas loobun 2 muudatusest? Avalikul lehel jääb praegune versioon.", yes: t.confirmYes, failed: t.discardFailed, signedOut: adminEt.leave.reasons.signedOut });
    expect((await sitePreviewBarProps(db, "home", "/")).count).toBe(0);
    expect((await sitePreviewBarProps(db, "trainer", "/koolitaja")).discardHref).toBe("/api/admin/sisu/trainer/0/loobu");
  });

  test("the course's bar keeps its route and copies (previewBarProps)", async () => {
    const { previewBarProps } = await import("@/server/preview-bar");
    const [course] = await db.select({ id: courses.id }).from(courses).limit(1);
    expect(await previewBarProps(db, course.id, "/koolitused/x")).toMatchObject({ discardHref: `/api/admin/koolitus/${course.id}/loobu`, copies: { course: course.id }, count: 0 });
  });
});
