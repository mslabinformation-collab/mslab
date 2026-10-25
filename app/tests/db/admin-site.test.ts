import { beforeEach, describe, expect, test } from "vitest";
import { asc, eq } from "drizzle-orm";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { campaign, faq, galleryItems, heroSlides, pages, posts, practicePackages, settings } from "@/db/schema";
import { applySeed } from "@/db/seed-apply";
import { getHomeData, getPage, getPracticePackages, getSettings, listPosts } from "@/db/queries/public";
import { shellSettings, trainerSettings } from "@/components/site/settings";
import {
  deletePostForm,
  loadCampaign,
  loadHome,
  loadPost,
  loadPractice,
  loadSettings,
  loadTrainer,
  saveCampaignForm,
  saveHomeForm,
  savePostForm,
  savePracticeForm,
  saveSettingsForm,
  saveTrainerForm,
  writeSettingsPart,
  type SettingsPart,
} from "@/server/admin-site";
import type { SaveAnswer } from "@/domain/autosave";
import type { EditResult } from "@/server/edit-check";
import { newPostDraft, type PostDraft } from "@/domain/site-editor";
import { parsePrepayment } from "@/domain/account-cards";

// Task 13B: the site content editors' form handling on a real (PGlite) database with the prototype seed.

const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const UPLOAD2 = "img/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.webp";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  await applySeed(db);
});

const form = (parts: Record<string, { version: string; value: unknown }>) => {
  const fd = new FormData();
  fd.set("data", JSON.stringify({ parts }));
  return fd;
};
const fieldsOf = (r: EditResult) => (r.ok ? {} : (r.fields ?? {}));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("home page: hero slides, statement, FAQ", () => {
  test("loads every part with a version; a save with no parts changes nothing", async () => {
    const home = await loadHome(db);
    expect(home.values.slides).toHaveLength(5);
    expect(home.values.slides[0]).toMatchObject({ tone: "light", imagePos: "50% 50%", imagePosMobile: "73% 50%", ctaHref: "/koolitused", active: true });
    expect(home.values.statement.body.et).toMatch(/^Õpetame/);
    expect(home.values.faq).toHaveLength(6);
    for (const name of ["slides", "statement", "faq"]) expect(home.versions[name]).toMatch(/^[0-9a-f]{32}$/);
    expect(await saveHomeForm(db, form({}))).toMatchObject({ ok: true });
    expect((await loadHome(db)).versions).toEqual(home.versions);
  });

  test("slide 1 turns dark with new focal points; the other parts and slides stay as they are", async () => {
    const home = await loadHome(db);
    const slides = clone(home.values.slides);
    slides[0] = { ...slides[0], tone: "dark", imagePos: "30% 60%", imagePosMobile: "80% 40%", title: { et: "  Uus\nslaid  ", ru: " " } };
    const r = await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: slides } }));
    expect(r).toMatchObject({ ok: true });
    const data = await getHomeData(db);
    expect(data.slides[0]).toMatchObject({ tone: "dark", imagePos: "30% 60%", imagePosMobile: "80% 40%", title: { et: "Uus\nslaid" }, sort: 1 });
    expect(data.slides.slice(1).map((s) => s.title.et)).toEqual(home.values.slides.slice(1).map((s) => s.title.et));
    // the result carries the parts as stored now, with their new versions
    const saved = (r as unknown as { saved: { values: { slides: unknown[] }; versions: Record<string, string> } }).saved;
    expect(Object.keys(saved.versions)).toEqual(["slides"]);
    expect(saved.versions.slides).not.toBe(home.versions.slides);
    const after = await loadHome(db);
    expect(after.versions.slides).toBe(saved.versions.slides);
    expect(after.versions.statement).toBe(home.versions.statement);
    expect(after.versions.faq).toBe(home.versions.faq);
  });

  test("a slide is refused without its image or title, with an outside or script link, a bad focal point; at most 8", async () => {
    const home = await loadHome(db);
    const before = await db.select().from(heroSlides);
    const slides = clone(home.values.slides);
    slides[0] = { ...slides[0], imageKey: "" };
    slides[1] = { ...slides[1], title: { et: " ", ru: "Только" }, ctaHref: "javascript:alert(1)" };
    slides[2] = { ...slides[2], ctaHref: "//evil.example/x", imagePos: "120% 50%" };
    slides[3] = { ...slides[3], ctaHref: "http://example.com", imageKey: "https://evil.example/a.jpg" };
    slides[4] = { ...slides[4], ctaHref: "data:text/html,<b>x</b>", imagePosMobile: "50%" };
    expect(fieldsOf(await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: slides } })))).toEqual({
      "slides.0.imageKey": "imageRequired",
      "slides.1.title": "required",
      "slides.1.ctaHref": "href",
      "slides.2.ctaHref": "href",
      "slides.2.imagePos": "focal",
      "slides.3.ctaHref": "href",
      "slides.3.imageKey": "image",
      "slides.4.ctaHref": "href",
      "slides.4.imagePosMobile": "focal",
    });
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...home.values.slides[0], uid: `n${i}` }));
    expect(fieldsOf(await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: nine } })))).toEqual({ slides: "tooMany" });
    expect(await db.select().from(heroSlides)).toEqual(before);
  });

  test("a site path written with its locale is refused (the site adds /ru itself)", async () => {
    const home = await loadHome(db);
    const slides = clone(home.values.slides);
    slides[0].ctaHref = "/ru/praktika";
    slides[1].ctaHref = "/et/koolitused";
    expect(fieldsOf(await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: slides } })))).toEqual({ "slides.0.ctaHref": "localeHref", "slides.1.ctaHref": "localeHref" });
    const c = await loadCampaign(db);
    expect(fieldsOf(await saveCampaignForm(db, form({ campaign: { version: c.versions.campaign, value: { ...c.values.campaign, ctaHref: "/ru/koolitused" } } })))).toEqual({ "campaign.ctaHref": "localeHref" });
  });

  test("site paths (with a query or a hash) and https addresses are accepted links; a new slide goes where it is put", async () => {
    const home = await loadHome(db);
    const slides = clone(home.values.slides);
    slides[0].ctaHref = "/praktika?pakett=MINI#taotlus";
    slides[1].ctaHref = "https://www.instagram.com/mslab";
    slides.splice(1, 0, { ...slides[2], uid: "new-1", id: null, imageKey: UPLOAD, title: { et: "Uus" }, active: false });
    expect(await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: slides } }))).toMatchObject({ ok: true });
    const stored = await db.select().from(heroSlides).orderBy(heroSlides.sort);
    expect(stored.map((s) => s.ctaHref).slice(0, 3)).toEqual(["/praktika?pakett=MINI#taotlus", slides[1].ctaHref, "https://www.instagram.com/mslab"]);
    expect(stored[1]).toMatchObject({ imageKey: UPLOAD, active: false, sort: 2 });
    expect((await getHomeData(db)).slides).toHaveLength(5); // the hidden one is not on the home page
  });

  test("a saved slide keeps its id; a removed one is deleted; a repeated id (a forged draft) does not update one row twice", async () => {
    const home = await loadHome(db);
    const ids = home.values.slides.map((s) => s.id);
    const slides = clone(home.values.slides);
    const [first] = slides.splice(0, 1); // the first one goes …
    slides.push({ ...first, uid: "copy", title: { et: "Kordus" } }, { ...first, uid: "copy2", title: { et: "Kordus 2" } }); // … and comes back twice
    expect(await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: slides.slice(1) } }))).toMatchObject({ ok: true });
    const stored = await db.select().from(heroSlides).orderBy(heroSlides.sort);
    expect(stored.map((s) => s.title.et)).toEqual([...home.values.slides.slice(2).map((s) => s.title.et), "Kordus", "Kordus 2"]);
    expect(stored.slice(0, 3).map((s) => s.id)).toEqual(ids.slice(2, 5)); // kept their ids
    expect(stored[3].id).toBe(ids[0]); // the first place with that id keeps it
    expect(stored[4].id).not.toBe(ids[0]);
    expect(stored.map((s) => s.id)).not.toContain(ids[1]); // removed
  });

  test("stale: a part saved elsewhere since it was loaded is refused, nothing written; another part still saves", async () => {
    const mine = await loadHome(db);
    const other = await loadHome(db);
    const theirs = clone(other.values.slides);
    theirs[0].tone = "dark";
    expect(await saveHomeForm(db, form({ slides: { version: other.versions.slides, value: theirs } }))).toMatchObject({ ok: true });

    const slides = clone(mine.values.slides);
    slides[1].kicker = { et: "Minu muudatus" };
    const statement = { body: { et: "Uus lause, mis on lühike." } };
    // one stale part refuses the whole save
    expect(await saveHomeForm(db, form({ slides: { version: mine.versions.slides, value: slides }, statement: { version: mine.versions.statement, value: statement } }))).toEqual({ ok: false, error: "stale" });
    expect((await getPage(db, "statement"))!.body.et).toBe(mine.values.statement.body.et);
    expect((await getHomeData(db)).slides[1].kicker.et).not.toBe("Minu muudatus");
    expect((await getHomeData(db)).slides[0].tone).toBe("dark"); // their change is kept
    // the statement alone was not changed elsewhere: it saves; the title is kept
    expect(await saveHomeForm(db, form({ statement: { version: mine.versions.statement, value: statement } }))).toMatchObject({ ok: true });
    expect(await getPage(db, "statement")).toMatchObject({ title: { et: "MS LAB Koolituskeskus" }, body: { et: "Uus lause, mis on lühike." } });
  });

  test("the trainer card's text (C26, round 2 item 5): D's line by default, saved in ET and RU; empty is allowed", async () => {
    const home = await loadHome(db);
    expect(home.values.teaser.body).toEqual({
      et: "Kulmu- ja ripsmetehnikate meister ja koolitaja. Õpetan nii, nagu oleksin ise tahtnud õppida: selgelt, praktiliselt ja iga õpilase tempos.",
      ru: "Мастер и преподаватель техник бровей и ресниц. Я учу так, как хотела бы учиться сама: понятно, практично и в темпе каждого ученика.",
    });
    const value = { body: { et: "Uus tekst.", ru: "Новый текст." } };
    expect(await saveHomeForm(db, form({ teaser: { version: home.versions.teaser, value } }))).toMatchObject({ ok: true });
    expect(await getPage(db, "trainer_teaser")).toMatchObject({ title: { et: "Sinu koolitaja" }, body: value.body });
    const again = await loadHome(db);
    expect(fieldsOf(await saveHomeForm(db, form({ teaser: { version: again.versions.teaser, value: { body: { et: "x".repeat(301) } } } })))).toEqual({ "teaser.body": "tooLong" });
    expect(await saveHomeForm(db, form({ teaser: { version: again.versions.teaser, value: { body: { et: "" } } } }))).toMatchObject({ ok: true });
  });

  test("FAQ: rows in their order, blank rows dropped; a question needs its answer; at most 30", async () => {
    const home = await loadHome(db);
    const items = clone(home.values.faq);
    const moved = [items[1], items[0], { uid: "x", q: { et: " " }, a: { et: "" } }, { uid: "y", q: { et: "Uus küsimus?", ru: "Новый вопрос?" }, a: { et: "Jah." } }, ...items.slice(2)];
    expect(await saveHomeForm(db, form({ faq: { version: home.versions.faq, value: moved } }))).toMatchObject({ ok: true });
    const stored = await db.select().from(faq).orderBy(faq.sort);
    expect(stored).toHaveLength(7);
    expect(stored.map((f) => f.q.et).slice(0, 3)).toEqual([items[1].q.et, items[0].q.et, "Uus küsimus?"]);
    expect(stored[2]).toMatchObject({ q: { et: "Uus küsimus?", ru: "Новый вопрос?" }, a: { et: "Jah." }, sort: 3 });
    expect((await getHomeData(db)).faq[0].q.et).toBe(items[1].q.et);

    const now = await loadHome(db);
    const bad = [{ uid: "a", q: { et: "Küsimus ilma vastuseta?" }, a: { et: "" } }, { uid: "b", q: { et: "", ru: "Только русский?" }, a: { et: "Vastus" } }];
    expect(fieldsOf(await saveHomeForm(db, form({ faq: { version: now.versions.faq, value: bad } })))).toEqual({ "faq.0.a": "required", "faq.1.q": "required" });
    const many = Array.from({ length: 31 }, (_, i) => ({ uid: `m${i}`, q: { et: `K${i}?` }, a: { et: "V" } }));
    expect(fieldsOf(await saveHomeForm(db, form({ faq: { version: now.versions.faq, value: many } })))).toEqual({ faq: "tooMany" });
    expect(await db.select().from(faq)).toHaveLength(7);
  });

  test("FAQ items keep their ids across saves (the editor's rows keep their fields); removed ones are deleted", async () => {
    const home = await loadHome(db);
    const ids = home.values.faq.map((f) => f.id);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    const items = clone(home.values.faq);
    items[0].q = { et: "Muudetud küsimus?" };
    const moved = [items[2], items[0], ...items.slice(3), { uid: "n", id: null, q: { et: "Uus?" }, a: { et: "Jah." } }]; // item 2 (index 1) removed
    expect(await saveHomeForm(db, form({ faq: { version: home.versions.faq, value: moved } }))).toMatchObject({ ok: true });
    const stored = await db.select().from(faq).orderBy(faq.sort);
    expect(stored.map((f) => f.id).slice(0, 5)).toEqual([ids[2], ids[0], ids[3], ids[4], ids[5]]);
    expect(stored[1].q).toEqual({ et: "Muudetud küsimus?" });
    expect(stored.map((f) => f.id)).not.toContain(ids[1]);
    expect(ids).not.toContain(stored[5].id); // the new one
    expect((await loadHome(db)).values.faq.map((f) => f.uid)).toEqual(stored.map((f) => `f${f.id}`));
  });

  test("an unknown part, a malformed draft or no JSON is refused", async () => {
    const home = await loadHome(db);
    expect(await saveHomeForm(db, form({ campaign: { version: home.versions.slides, value: {} } }))).toEqual({ ok: false, error: "invalid" });
    expect(await saveHomeForm(db, form({ slides: { version: home.versions.slides, value: [{ tone: "purple" }] } }))).toEqual({ ok: false, error: "invalid" });
    const fd = new FormData();
    fd.set("data", "{not json");
    expect(await saveHomeForm(db, fd)).toEqual({ ok: false, error: "invalid" });
    expect(await saveHomeForm(db, new FormData())).toEqual({ ok: false, error: "invalid" });
  });
});

describe("practice packages", () => {
  test("MAXI's duration '9 ak' (A8) and its list are stored; MINI is untouched", async () => {
    const p = await loadPractice(db);
    expect(p.codes).toEqual(["MINI", "MAXI"]);
    expect(p.values.MAXI).toMatchObject({ models: "4", price: "150", durationLabel: { et: "8 ak" } });
    const maxi = { ...clone(p.values.MAXI), durationLabel: { et: "9 ak", ru: "9 ак" }, price: "155,50", items: [{ et: "Töö neljal modellil" }, { et: " " }, { et: "Uus punkt", ru: "Новый пункт" }] };
    expect(await savePracticeForm(db, form({ MAXI: { version: p.versions.MAXI, value: maxi } }))).toMatchObject({ ok: true });
    const [mini, stored] = await getPracticePackages(db);
    expect(stored).toMatchObject({ code: "MAXI", durationLabel: { et: "9 ak", ru: "9 ак" }, price: 15550, models: 4, items: [{ et: "Töö neljal modellil" }, { et: "Uus punkt", ru: "Новый пункт" }], sort: 2 });
    expect(mini.durationLabel).toEqual({ et: "4 ak", ru: "4 ак. ч." });
    expect((await loadPractice(db)).versions.MINI).toBe(p.versions.MINI);
  });

  test("name, duration, models and price are required and checked; an unknown package code is refused", async () => {
    const p = await loadPractice(db);
    const bad = { ...clone(p.values.MINI), name: { et: "" }, durationLabel: { et: " " }, models: "99", price: "abc", items: [{ et: "", ru: "Только" }] };
    expect(fieldsOf(await savePracticeForm(db, form({ MINI: { version: p.versions.MINI, value: bad } })))).toEqual({
      "MINI.name": "required",
      "MINI.durationLabel": "required",
      "MINI.models": "whole",
      "MINI.price": "amount",
      "MINI.items": "listEt",
    });
    expect(fieldsOf(await savePracticeForm(db, form({ MINI: { version: p.versions.MINI, value: { ...clone(p.values.MINI), models: "", price: "" } } })))).toEqual({ "MINI.models": "required", "MINI.price": "required" });
    expect(await savePracticeForm(db, form({ XL: { version: p.versions.MINI, value: p.values.MINI } }))).toEqual({ ok: false, error: "invalid" });
    expect((await getPracticePackages(db))[0].price).toBe(10000);
  });

  test("two admins: MINI saved by one, MAXI by the other, both kept; a second MINI save from the old page is stale", async () => {
    const a = await loadPractice(db);
    const b = await loadPractice(db);
    expect(await savePracticeForm(db, form({ MINI: { version: a.versions.MINI, value: { ...clone(a.values.MINI), models: "3" } } }))).toMatchObject({ ok: true });
    expect(await savePracticeForm(db, form({ MAXI: { version: b.versions.MAXI, value: { ...clone(b.values.MAXI), models: "5" } } }))).toMatchObject({ ok: true });
    expect(await savePracticeForm(db, form({ MINI: { version: b.versions.MINI, value: { ...clone(b.values.MINI), models: "1" } } }))).toEqual({ ok: false, error: "stale" });
    expect((await db.select().from(practicePackages).orderBy(practicePackages.sort)).map((x) => x.models)).toEqual([3, 5]);
  });
});

describe("trainer page", () => {
  test("the trainer card: portrait with its focal point, name, role and stats; the contact photo is kept", async () => {
    const t = await loadTrainer(db);
    expect(t.values.trainer).toMatchObject({ portraitKey: "/seed/maria-standing.jpg", portraitPos: "50% 20%", name: { et: "Maria Sosnina", ru: "Мария Соснина" } });
    expect(t.values.trainer.stats).toHaveLength(3);
    const trainer = { ...clone(t.values.trainer), portraitKey: UPLOAD, portraitPos: "40% 30%", name: { et: " Maria S. ", ru: "Мария С." }, role: { et: "Koolitaja", ru: "Тренер" }, stats: [{ uid: "a", value: "10+", label: { et: "aastat", ru: "лет" } }, { uid: "b", value: " ", label: { et: "" } }] };
    expect(await saveTrainerForm(db, form({ trainer: { version: t.versions.trainer, value: trainer } }))).toMatchObject({ ok: true });
    const s = (await getSettings(db)).trainer;
    expect(s).toEqual({ portraitKey: UPLOAD, portraitPos: "40% 30%", contactPhotoKey: "/seed/maria-seated.jpg", name: { et: "Maria S.", ru: "Мария С." }, role: { et: "Koolitaja", ru: "Тренер" }, stats: [{ value: "10+", label: { et: "aastat", ru: "лет" } }] });
    expect((await loadTrainer(db)).values.trainer.portraitPos).toBe("40% 30%");
  });

  test("refuses a missing name, an outside image, a half stat and more than 3 stats", async () => {
    const t = await loadTrainer(db);
    const four = Array.from({ length: 4 }, (_, i) => ({ uid: `s${i}`, value: String(i), label: { et: "x" } }));
    expect(
      fieldsOf(
        await saveTrainerForm(
          db,
          form({ trainer: { version: t.versions.trainer, value: { ...clone(t.values.trainer), name: { et: "", ru: "Мария" }, portraitKey: "https://evil.example/p.jpg", stats: [{ uid: "a", value: "8+", label: { et: "" } }, ...four] } } }),
        ),
      ),
    ).toEqual({ "trainer.name": "required", "trainer.portraitKey": "image", "trainer.stats.0.label": "required", "trainer.stats": "tooMany" });
  });

  test("a name stored before round 2 (a plain string) is the Estonian name in the editor and on the site (item 1d)", async () => {
    const t = await loadTrainer(db);
    const s = await getSettings(db);
    await db.update(settings).set({ value: { ...(s.trainer as object), name: "Maria Sosnina" } }).where(eq(settings.key, "trainer"));
    expect((await loadTrainer(db)).values.trainer.name).toEqual({ et: "Maria Sosnina" });
    expect(trainerSettings(await getSettings(db), "ru").name).toBe("Maria Sosnina"); // RU falls back to it
    await db.update(settings).set({ value: s.trainer }).where(eq(settings.key, "trainer"));
    expect(trainerSettings(await getSettings(db), "ru").name).toBe("Мария Соснина");
    expect(shellSettings(await getSettings(db), "ru").trainerName).toBe("Мария Соснина");
    void t;
  });

  test("bio, works gallery and the two stories", async () => {
    const t = await loadTrainer(db);
    expect(t.values.works).toHaveLength(7);
    const works = [{ key: UPLOAD2, alt: { et: "Uus töö", ru: "Новая работа" } }, ...clone(t.values.works).slice(0, 2)];
    const r = await saveTrainerForm(
      db,
      form({
        bio: { version: t.versions.bio, value: { body: { et: "Esimene lõik.\n\nTeine lõik." } } },
        works: { version: t.versions.works, value: works },
        center_story: { version: t.versions.center_story, value: { title: { et: "" }, body: { et: "Lugu.", ru: "История." } } },
        trainer_journey: { version: t.versions.trainer_journey, value: { title: { et: "Minu tee" }, body: { et: "" } } },
      }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(await getPage(db, "trainer_bio")).toMatchObject({ title: { et: "Maria Sosnina" }, body: { et: "Esimene lõik.\n\nTeine lõik." } });
    const gallery = await db.select().from(galleryItems).where(eq(galleryItems.group, "trainer_works")).orderBy(galleryItems.sort);
    expect(gallery.map((g) => [g.key, g.sort])).toEqual([[UPLOAD2, 0], [t.values.works[0].key, 1], [t.values.works[1].key, 2]]);
    expect(gallery[0].alt).toEqual({ et: "Uus töö", ru: "Новая работа" });
    expect(await getPage(db, "center_story")).toMatchObject({ title: { et: "" }, body: { et: "Lugu.", ru: "История." } });
    expect(await getPage(db, "trainer_journey")).toMatchObject({ title: { et: "Minu tee" }, body: { et: "" } });

    const now = await loadTrainer(db);
    const tooMany = Array.from({ length: 25 }, () => ({ key: UPLOAD, alt: { et: "" } }));
    expect(fieldsOf(await saveTrainerForm(db, form({ works: { version: now.versions.works, value: tooMany } })))).toEqual({ works: "tooMany" });
    // each picture's refusal under its own index (the editor marks that picture)
    expect(
      fieldsOf(
        await saveTrainerForm(db, form({ works: { version: now.versions.works, value: [{ key: UPLOAD, alt: { et: "x".repeat(201) } }, { key: "../../etc/passwd", alt: { et: "" } }, { key: UPLOAD2, alt: { et: "ok" } }] } })),
      ),
    ).toEqual({ "works.0.alt": "tooLong", "works.1.key": "image" });
  });
});

describe("campaign (D adminCamp + image upload, M3–M5)", () => {
  test("the uploaded image, code and texts are stored; an empty button text becomes 'Leia enda koolitus'", async () => {
    const c = await loadCampaign(db);
    expect(c.values.campaign).toMatchObject({ active: true, code: "TALV15", ctaLabel: { et: "Leia enda koolitus" }, imageKey: "/seed/lash-editorial.jpg" });
    const value = { ...clone(c.values.campaign), imageKey: UPLOAD, code: " kevad-20 ", ctaLabel: { et: " " }, title: { et: "−20% kevadel", ru: "−20% весной" } };
    expect(await saveCampaignForm(db, form({ campaign: { version: c.versions.campaign, value } }))).toMatchObject({ ok: true });
    const [row] = await db.select().from(campaign).where(eq(campaign.id, 1));
    expect(row).toMatchObject({ imageKey: UPLOAD, code: "KEVAD-20", ctaLabel: { et: "Leia enda koolitus" }, title: { et: "−20% kevadel", ru: "−20% весной" }, active: true });
  });

  test("an active campaign needs its title and image; a switched-off one may stay unfinished; links and codes are checked", async () => {
    const c = await loadCampaign(db);
    const base = clone(c.values.campaign);
    expect(fieldsOf(await saveCampaignForm(db, form({ campaign: { version: c.versions.campaign, value: { ...base, imageKey: "", title: { et: "" }, ctaHref: "javascript:alert(1)", code: "TALV 15" } } })))).toEqual({
      "campaign.imageKey": "imageRequired",
      "campaign.title": "required",
      "campaign.ctaHref": "href",
      "campaign.code": "codeFormat",
    });
    expect(await saveCampaignForm(db, form({ campaign: { version: c.versions.campaign, value: { ...base, active: false, imageKey: "", title: { et: "" } } } }))).toMatchObject({ ok: true });
    expect((await getHomeData(db)).popup).toBeNull();
  });

  test("Hüpikaken: both parts load; choosing Uudiskiri switches the campaign off and the newsletter on in one save; Väljas both off", async () => {
    const p = await loadCampaign(db);
    expect(p.values.newsletter).toMatchObject({ active: false, kicker: { et: "MS LABi kirjad", ru: "Письма MS LAB" }, imageKey: "/seed/gift-bag-serum.jpg" });
    const flags = async () => (await db.select({ id: campaign.id, active: campaign.active }).from(campaign).orderBy(asc(campaign.id))).map((r) => r.active);
    expect(await flags()).toEqual([true, false]);
    const both = (c: boolean, n: boolean) =>
      form({
        campaign: { version: p.versions.campaign, value: { ...clone(p.values.campaign), active: c } },
        newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: n } },
      });
    expect(await saveCampaignForm(db, both(false, true))).toMatchObject({ ok: true });
    expect(await flags()).toEqual([false, true]);
    expect((await getHomeData(db)).popup).toMatchObject({ kind: "newsletter" });
    const q = await loadCampaign(db);
    expect(await saveCampaignForm(db, form({ newsletter: { version: q.versions.newsletter, value: { ...clone(q.values.newsletter), active: false } } }))).toMatchObject({ ok: true });
    expect(await flags()).toEqual([false, false]);
    expect((await getHomeData(db)).popup).toBeNull();
  });

  test("a shown newsletter popup needs its title and picture; a switched-off one may stay unfinished", async () => {
    const p = await loadCampaign(db);
    const nl = (value: object) => form({ newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), ...value } } });
    expect(fieldsOf(await saveCampaignForm(db, nl({ active: true, title: { et: "" }, imageKey: "" })))).toEqual({ "newsletter.title": "required", "newsletter.imageKey": "imageRequired" });
    expect(await saveCampaignForm(db, nl({ active: false, title: { et: "" }, imageKey: "" }))).toMatchObject({ ok: true });
  });

  // The first test above sends the campaign part first, so the campaign is already off (in the same transaction) when the newsletter
  // popup is switched on: it passes even without upsertCampaign's "switch the other popup off first". These do not: the popup
  // switched on is written while the other one is still on, and campaign_one_active refuses a second active row.
  describe("at most one popup shown, whichever part is saved or written first", () => {
    const flags = async () => (await db.select({ id: campaign.id, active: campaign.active }).from(campaign).orderBy(asc(campaign.id))).map((r) => r.active);

    test("only the newsletter part, switched on, while the campaign is still on: the campaign goes off in the same save", async () => {
      const p = await loadCampaign(db);
      expect(await flags()).toEqual([true, false]);
      const r = await saveCampaignForm(db, form({ newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: true } } }));
      expect(r).toMatchObject({ ok: true });
      expect(await flags()).toEqual([false, true]);
    });

    test("only the campaign part, switched on, while the newsletter popup is on: the newsletter popup goes off", async () => {
      const p = await loadCampaign(db);
      await saveCampaignForm(db, form({ newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: true } } }));
      const q = await loadCampaign(db);
      expect(await flags()).toEqual([false, true]);
      expect(await saveCampaignForm(db, form({ campaign: { version: q.versions.campaign, value: { ...clone(q.values.campaign), active: true } } }))).toMatchObject({ ok: true });
      expect(await flags()).toEqual([true, false]);
    });

    test("both parts in the other order (the newsletter popup first): the same result", async () => {
      const p = await loadCampaign(db);
      const r = await saveCampaignForm(
        db,
        form({
          newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: true } },
          campaign: { version: p.versions.campaign, value: { ...clone(p.values.campaign), active: false } },
        }),
      );
      expect(r).toMatchObject({ ok: true });
      expect(await flags()).toEqual([false, true]);
    });

    test("a forged draft with both on is not a database error: the part written last wins, one popup is shown", async () => {
      const p = await loadCampaign(db);
      const r = await saveCampaignForm(
        db,
        form({
          campaign: { version: p.versions.campaign, value: { ...clone(p.values.campaign), active: true } },
          newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: true } },
        }),
      );
      expect(r).toMatchObject({ ok: true });
      expect((await flags()).filter(Boolean)).toHaveLength(1);
    });

    test("one stale part, nothing written: another save changed the newsletter popup, so the campaign's switch-off in the same save is not stored either", async () => {
      const p = await loadCampaign(db);
      await db.update(campaign).set({ title: { et: "Kellegi teine salvestus" } }).where(eq(campaign.id, 2));
      const r = await saveCampaignForm(
        db,
        form({
          campaign: { version: p.versions.campaign, value: { ...clone(p.values.campaign), active: false } },
          newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: true } },
        }),
      );
      expect(r).toEqual({ ok: false, error: "stale" });
      expect(await flags()).toEqual([true, false]);
    });

    test("one refused part, nothing written: the campaign stays on (its own switch-off is not saved) when the newsletter popup is switched on without its picture", async () => {
      const p = await loadCampaign(db);
      const r = await saveCampaignForm(
        db,
        form({
          campaign: { version: p.versions.campaign, value: { ...clone(p.values.campaign), active: false } },
          newsletter: { version: p.versions.newsletter, value: { ...clone(p.values.newsletter), active: true, imageKey: "" } },
        }),
      );
      expect(fieldsOf(r)).toEqual({ "newsletter.imageKey": "imageRequired" });
      expect(await flags()).toEqual([true, false]);
    });
  });
});

describe("settings", () => {
  /** An autosaved part's save (writeSettingsPart, the route's write: admin UX pass piece 3b, Task 4) from the version the page reads now. */
  const savePart = async (part: SettingsPart, patch: unknown) => writeSettingsPart(db, part, patch, (await loadSettings(db)).versions[part], new Date());
  const refusedOf = (a: SaveAnswer) => (a.ok || a.error !== "invalid" ? {} : a.fields);

  test("contact details and social links (https only), field by field; other keys are kept; the legal form takes none of them", async () => {
    const s = await loadSettings(db);
    expect(s.values.contact).toEqual({ email: "info@mslab.ee", phone: "", address: "Pärnu", instagram: "", facebook: "" });
    const bad = { email: "info@", phone: "helista mulle", address: "Rüütli 12, Pärnu", instagram: "http://instagram.com/mslab", facebook: "javascript:alert(1)" };
    expect(refusedOf(await savePart("contact", bad))).toEqual({ email: "email", phone: "phone", instagram: "url", facebook: "url" });
    for (const facebook of ["data:text/html,x", "https://", "//facebook.com/x", "https://user:pw@facebook.com/x"]) expect(refusedOf(await savePart("contact", { facebook })), facebook).toEqual({ facebook: "url" });
    expect((await getSettings(db)).contact).toEqual(s.values.contact);
    const good = { email: " maria@example.ee ", phone: "+372 5555  0101", address: "Rüütli 12, Pärnu", instagram: "https://www.instagram.com/mslab", facebook: "https://facebook.com/mslab" };
    await db.update(settings).set({ value: { ...s.values.contact, extra: "kept" } }).where(eq(settings.key, "contact"));
    expect(await savePart("contact", good)).toMatchObject({ ok: true, changed: true });
    expect((await getSettings(db)).contact).toEqual({ email: "maria@example.ee", phone: "+372 5555 0101", address: "Rüütli 12, Pärnu", instagram: "https://www.instagram.com/mslab", facebook: "https://facebook.com/mslab", extra: "kept" });
    // the version the page reads is the route's: from the one before the last save, a conflict with the stored text
    expect(await writeSettingsPart(db, "contact", { phone: "" }, s.versions.contact, new Date())).toMatchObject({ ok: false, error: "conflict", value: { phone: "+372 5555 0101" } });
    // the legal texts' form takes only theirs
    expect(await saveSettingsForm(db, form({ contact: { version: (await loadSettings(db)).versions.contact, value: good } }))).toEqual({ ok: false, error: "invalid" });
  });

  test("newsletter discount label (required) and the legal pages (their own form)", async () => {
    const s = await loadSettings(db);
    expect(refusedOf(await savePart("newsletter", { discountLabel: " " }))).toEqual({ discountLabel: "required" });
    expect(fieldsOf(await saveSettingsForm(db, form({ terms: { version: s.versions.terms, value: { title: { et: "" }, body: { et: "" } } } })))).toEqual({ "terms.title": "required", "terms.body": "required" });
    expect(await savePart("newsletter", { discountLabel: "15%" })).toMatchObject({ ok: true });
    const r = await saveSettingsForm(db, form({ privacy: { version: s.versions.privacy, value: { title: { et: "Privaatsuspoliitika" }, body: { et: "Esimene.\n\nTeine.", ru: "Первый." } } } }));
    expect(r).toMatchObject({ ok: true });
    expect((await getSettings(db)).newsletter).toEqual({ discountLabel: "15%", welcomeCode: "" });
    expect(await getPage(db, "privacy")).toMatchObject({ title: { et: "Privaatsuspoliitika" }, body: { et: "Esimene.\n\nTeine.", ru: "Первый." } });
  });

  test("Tervituskood: stored in capitals next to the discount; another shape or over 30 is refused; a save without it keeps it", async () => {
    expect(refusedOf(await savePart("newsletter", { welcomeCode: "tere 10" }))).toEqual({ welcomeCode: "codeFormat" });
    expect(refusedOf(await savePart("newsletter", { welcomeCode: "A".repeat(31) }))).toEqual({ welcomeCode: "tooLong" });
    expect(await savePart("newsletter", { discountLabel: "10%", welcomeCode: " tere-10 " })).toMatchObject({ ok: true });
    expect((await getSettings(db)).newsletter).toEqual({ discountLabel: "10%", welcomeCode: "TERE-10" });
    expect(await savePart("newsletter", { discountLabel: "15%" })).toMatchObject({ ok: true });
    expect((await getSettings(db)).newsletter).toEqual({ discountLabel: "15%", welcomeCode: "TERE-10" });
  });

  describe("E-koolituse tingimused (course_terms)", () => {
    const stored = async () => ({
      page: await getPage(db, "course_terms"),
      version: (await getSettings(db)).courseTermsVersion,
    });
    const save = async (body: { et: string; ru?: string }) => {
      const s = await loadSettings(db);
      return saveSettingsForm(db, form({ course_terms: { version: s.versions.course_terms, value: { body } } }));
    };

    test("the seed has a sample text in both languages and no version yet; the editor loads the title (the contract's, ruling R3) and the body", async () => {
      const s = await loadSettings(db);
      expect(s.values.course_terms.body.et).toMatch(/Näidistekst/);
      expect(s.values.course_terms.body.ru).toMatch(/Образец текста/);
      expect(s.values.course_terms.title).toEqual({ et: "E-koolituse tingimused", ru: "Условия онлайн-обучения" });
      expect(Object.keys(s.values.course_terms)).toEqual(["title", "body"]);
      expect(s.versions.course_terms).toMatch(/^[0-9a-f]{32}$/);
      expect((await stored()).version).toBeUndefined(); // no version in the seed: it reads as "1" until the first save
      expect(JSON.stringify((await getPage(db, "course_terms"))!.body)).not.toMatch(/version/i);
    });

    test("saving the text writes it and the save time as the version, together; the title stays", async () => {
      const before = Date.now();
      const r = await save({ et: "  Uus tekst.\n\nTeine lõik.  ", ru: "Новый текст." });
      expect(r).toMatchObject({ ok: true });
      const { page, version } = await stored();
      expect(page).toMatchObject({ title: { et: "E-koolituse tingimused", ru: "Условия онлайн-обучения" }, body: { et: "Uus tekst.\n\nTeine lõik.", ru: "Новый текст." } });
      expect(typeof version).toBe("string");
      expect(new Date(version as string).toISOString()).toBe(version); // an ISO time
      expect(new Date(version as string).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(version as string).getTime()).toBeLessThanOrEqual(Date.now());
      // the result carries the part as now stored, with its new version
      const saved = (r as unknown as { saved: { values: { course_terms: { body: unknown } }; versions: Record<string, string> } }).saved;
      expect(Object.keys(saved.versions)).toEqual(["course_terms"]);
      expect(saved.values.course_terms.body).toEqual({ et: "Uus tekst.\n\nTeine lõik.", ru: "Новый текст." });
    });

    test("the title is the e-course contract's (ruling R3): Maria writes it, trimmed and required in Estonian, within the legal titles' limit; a save without one (an older page) keeps the stored title", async () => {
      const saveTitled = async (title: { et: string; ru?: string }, body: { et: string; ru?: string } = { et: "Tekst." }) => {
        const s = await loadSettings(db);
        return saveSettingsForm(db, form({ course_terms: { version: s.versions.course_terms, value: { title, body } } }));
      };
      expect(await saveTitled({ et: "  E-koolituse leping ", ru: " Договор онлайн-обучения " })).toMatchObject({ ok: true });
      expect((await stored()).page).toMatchObject({ title: { et: "E-koolituse leping", ru: "Договор онлайн-обучения" }, body: { et: "Tekst." } });
      const saved = (await loadSettings(db)).values.course_terms;
      expect(saved.title).toEqual({ et: "E-koolituse leping", ru: "Договор онлайн-обучения" });
      // an older page sends the body alone: the title Maria wrote stays
      expect(await save({ et: "Uus tekst." })).toMatchObject({ ok: true });
      expect((await stored()).page).toMatchObject({ title: { et: "E-koolituse leping", ru: "Договор онлайн-обучения" }, body: { et: "Uus tekst." } });
      // refused: an empty Estonian title, a title past the limit; nothing is written
      const before = await stored();
      expect(fieldsOf(await saveTitled({ et: "  " }, { et: "Muu tekst." }))).toEqual({ "course_terms.title": "required" });
      expect(fieldsOf(await saveTitled({ et: "", ru: "Только русский" }, { et: "Muu tekst." }))).toEqual({ "course_terms.title": "required" });
      expect(fieldsOf(await saveTitled({ et: "x".repeat(121) }, { et: "Muu tekst." }))).toEqual({ "course_terms.title": "tooLong" });
      expect(await stored()).toEqual(before);
    });

    test("the title is part of what a student accepts: a changed title alone gives a new version, the very same title and text keeps it", async () => {
      const saveTitled = async (title: { et: string }, body: { et: string }) => {
        const s = await loadSettings(db);
        return saveSettingsForm(db, form({ course_terms: { version: s.versions.course_terms, value: { title, body } } }));
      };
      await saveTitled({ et: "E-koolituse tingimused" }, { et: "Tekst." });
      const first = (await stored()).version;
      expect(typeof first).toBe("string");
      await saveTitled({ et: "E-koolituse tingimused" }, { et: "Tekst." });
      expect((await stored()).version).toBe(first);
      await saveTitled({ et: "E-koolituse leping" }, { et: "Tekst." });
      const second = (await stored()).version;
      expect(second).not.toBe(first);
      expect(new Date(second as string).getTime()).toBeGreaterThan(new Date(first as string).getTime());
    });

    test("every changed save gives a new version; a save of the very same text keeps it (nobody has to accept again)", async () => {
      await save({ et: "Esimene." });
      const first = (await stored()).version;
      await save({ et: "Teine." });
      const second = (await stored()).version;
      expect(second).not.toBe(first);
      expect(new Date(second as string).getTime()).toBeGreaterThan(new Date(first as string).getTime());
      await save({ et: "Teine." });
      expect((await stored()).version).toBe(second);
    });

    test("an empty Estonian text is refused and writes nothing; a stale save writes nothing; other parts save alongside", async () => {
      const s = await loadSettings(db);
      expect(fieldsOf(await save({ et: "  " }))).toEqual({ "course_terms.body": "required" });
      expect(fieldsOf(await save({ et: "", ru: "Только русский" }))).toEqual({ "course_terms.body": "required" });
      expect(fieldsOf(await save({ et: "x".repeat(30_001) }))).toEqual({ "course_terms.body": "tooLong" });
      expect(await stored()).toMatchObject({ version: undefined, page: { body: s.values.course_terms.body } });

      expect(await save({ et: "Esimene." })).toMatchObject({ ok: true });
      const afterFirst = await stored();
      // another admin saved first: this one was loaded before it
      const stale = await saveSettingsForm(db, form({ course_terms: { version: s.versions.course_terms, value: { body: { et: "Hilinenud." } } } }));
      expect(stale).toEqual({ ok: false, error: "stale" });
      expect(await stored()).toEqual(afterFirst);

      // a failed check of another part in the same save writes no version either
      const fresh = await loadSettings(db);
      const mixed = await saveSettingsForm(
        db,
        form({
          course_terms: { version: fresh.versions.course_terms, value: { body: { et: "Kolmas." } } },
          terms: { version: fresh.versions.terms, value: { title: { et: " " }, body: { et: "Tekst." } } },
        }),
      );
      expect(mixed.ok).toBe(false);
      expect(await stored()).toEqual(afterFirst);
    });

    test("a first save when the page row is missing creates it with the default title", async () => {
      await db.delete(pages).where(eq(pages.key, "course_terms"));
      const s = await loadSettings(db);
      expect(s.values.course_terms.body).toEqual({ et: "" });
      expect(await save({ et: "Esimene." })).toMatchObject({ ok: true });
      expect((await stored()).page).toMatchObject({ title: { et: "E-koolituse tingimused" }, body: { et: "Esimene." } });
    });
  });

  describe("Ettemaksu juhised (prepayment, phase 2a Task 9)", () => {
    const savePay = (value: Record<string, string>) => savePart("prepayment", value);
    const empty = { receiver: "", iban: "", bank: "", referencePrefix: "" };

    test("loads empty when nothing is stored; saved trimmed, the IBAN without spaces in capitals; the cards read it", async () => {
      const s = await loadSettings(db);
      expect(s.values.prepayment).toEqual(empty);
      expect(s.versions.prepayment).toMatch(/^[0-9a-f]{32}$/);
      const r = await savePay({ receiver: " MS LAB OÜ ", iban: " ee38 2200 2210 2014 5685 ", bank: "Swedbank", referencePrefix: " MSLAB- " });
      expect(r).toMatchObject({ ok: true, version: expect.stringMatching(/^[0-9a-f]{32}$/) });
      const value = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
      expect((await loadSettings(db)).versions.prepayment).toBe(r.ok ? r.version : null);
      expect((await getSettings(db)).prepayment).toEqual(value);
      expect(parsePrepayment((await getSettings(db)).prepayment)).toEqual(value);
    });

    test("all empty is allowed and means no instructions (the cards then say Maria sends an invoice)", async () => {
      expect(await savePay({ receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "", referencePrefix: "" })).toMatchObject({ ok: true });
      expect(await savePay({ receiver: " ", iban: "  ", bank: "", referencePrefix: "" })).toMatchObject({ ok: true });
      expect((await getSettings(db)).prepayment).toEqual(empty);
      expect(parsePrepayment((await getSettings(db)).prepayment)).toBeNull();
    });

    test("an IBAN that is not one is refused with its own message; too long fields too; nothing is stored", async () => {
      for (const iban of ["EE38", "38EE2200221020145685", "EE3822002210201456850000000000000000", "EE38 2200-2210", "ЕЕ382200221020145685"])
        expect(refusedOf(await savePay({ ...empty, receiver: "MS LAB OÜ", iban })), iban).toEqual({ iban: "iban" });
      expect(refusedOf(await savePay({ ...empty, iban: "E".repeat(61) }))).toEqual({ iban: "tooLong" });
      expect(refusedOf(await savePay({ ...empty, receiver: "x".repeat(121), bank: "x".repeat(81), referencePrefix: "x".repeat(31) }))).toEqual({
        receiver: "tooLong",
        bank: "tooLong",
        referencePrefix: "tooLong",
      });
      expect((await getSettings(db)).prepayment).toBeUndefined();
      expect(await savePay({ ...empty, iban: "LT12 1000 0111 0100 1000" })).toMatchObject({ ok: true }); // another country
      expect(((await getSettings(db)).prepayment as { iban: string }).iban).toBe("LT121000011101001000");
    });

    test("two tabs: saved elsewhere since the page was loaded is a conflict with the stored text, the other save is kept", async () => {
      const s = await loadSettings(db);
      expect(await savePay({ ...empty, receiver: "Esimene" })).toMatchObject({ ok: true });
      const late = await writeSettingsPart(db, "prepayment", { receiver: "Teine" }, s.versions.prepayment, new Date());
      expect(late).toMatchObject({ ok: false, error: "conflict", value: { ...empty, receiver: "Esimene" } });
      expect(((await getSettings(db)).prepayment as { receiver: string }).receiver).toBe("Esimene");
    });
  });
});

describe("posts", () => {
  const draft = (over: Partial<PostDraft> = {}): PostDraft => ({ ...newPostDraft("2026-10-02"), title: { et: "Sügisene uudis" }, category: { et: "Uudis" }, ...over });
  const savePost = (d: PostDraft, version = "") => savePostForm(db, form({ post: { version, value: d } }));

  test("a new post gets a slug from its title, 09:00 Estonian time on its date, and is hidden until published", async () => {
    const r = await savePost(draft({ excerpt: { et: "Lühidalt." }, body: { et: "Üks.\n\nKaks." } }));
    expect(r).toMatchObject({ ok: true, created: true });
    const id = (r as { id: number }).id;
    const [row] = await db.select().from(posts).where(eq(posts.id, id));
    expect(row).toMatchObject({ slug: "sugisene-uudis", published: false, coverKey: "", category: { et: "Uudis" } });
    expect(row.publishedAt.toISOString()).toBe("2026-10-02T06:00:00.000Z");
    expect((await listPosts(db)).map((p) => p.id)).not.toContain(id);

    // publishing needs the cover
    const loaded = (await loadPost(db, id))!;
    expect(loaded.values.post).toMatchObject({ id, slug: "sugisene-uudis", publishedAt: "2026-10-02" });
    expect(fieldsOf(await savePost({ ...loaded.values.post, published: true }, loaded.versions.post))).toEqual({ "post.coverKey": "imageRequired" });
    expect(await savePost({ ...loaded.values.post, published: true, coverKey: UPLOAD, publishedAt: "2026-12-24" }, loaded.versions.post)).toMatchObject({ ok: true, created: false });
    const [first] = await listPosts(db);
    expect(first).toMatchObject({ id, coverKey: UPLOAD });
    expect(first.publishedAt.toISOString()).toBe("2026-12-24T07:00:00.000Z"); // winter: UTC+2
  });

  test("an edit on the same day keeps the stored time (the order of that day's posts); a new day starts at 09:00", async () => {
    const [seed] = await listPosts(db);
    const at = new Date("2026-09-22T11:37:00Z"); // 14:37 in Tallinn
    await db.update(posts).set({ publishedAt: at }).where(eq(posts.id, seed.id));
    const a = (await loadPost(db, seed.id))!;
    expect(a.values.post.publishedAt).toBe("2026-09-22");
    const same = await savePost({ ...a.values.post, title: { et: "Sama päev" } }, a.versions.post);
    expect(same).toMatchObject({ ok: true });
    expect((await db.select().from(posts).where(eq(posts.id, seed.id)))[0].publishedAt.toISOString()).toBe(at.toISOString());
    // the saved draft and version are the ones a fresh load gives (read back inside the save's transaction)
    expect((same as unknown as { saved: unknown }).saved).toEqual(await loadPost(db, seed.id));
    const b = (await loadPost(db, seed.id))!;
    expect(await savePost({ ...b.values.post, publishedAt: "2026-09-23" }, b.versions.post)).toMatchObject({ ok: true });
    expect((await db.select().from(posts).where(eq(posts.id, seed.id)))[0].publishedAt.toISOString()).toBe("2026-09-23T06:00:00.000Z");
  });

  test("refuses a missing title or category, a bad date, a taken or malformed slug", async () => {
    expect(fieldsOf(await savePost(draft({ title: { et: "" }, category: { et: "" }, publishedAt: "2026-02-30" })))).toEqual({
      "post.title": "required",
      "post.slug": "required",
      "post.category": "required",
      "post.publishedAt": "date",
    });
    expect(fieldsOf(await savePost(draft({ slug: "Mitte Nii!" })))).toEqual({ "post.slug": "slugFormat" });
    expect(fieldsOf(await savePost(draft({ title: { et: "Uus koolitus: Lash Lift BOTOX" } })))).toEqual({ "post.slug": "slugTaken" }); // a seed post
    expect(fieldsOf(await savePost(draft({ publishedAt: "" })))).toEqual({ "post.publishedAt": "required" });
    expect(await db.select().from(posts)).toHaveLength(6);
  });

  test("an edit is stale after a save elsewhere and notFound for a missing post; delete removes it", async () => {
    const [seed] = await listPosts(db);
    const a = (await loadPost(db, seed.id))!;
    const b = (await loadPost(db, seed.id))!;
    expect(await savePost({ ...a.values.post, title: { et: "Muudetud" } }, a.versions.post)).toMatchObject({ ok: true });
    expect(await savePost({ ...b.values.post, title: { et: "Minu oma" } }, b.versions.post)).toEqual({ ok: false, error: "stale" });
    expect((await db.select().from(posts).where(eq(posts.id, seed.id)))[0].title).toEqual({ et: "Muudetud" });
    expect(await savePost({ ...a.values.post, id: 99999 }, a.versions.post)).toEqual({ ok: false, error: "notFound" });

    const del = new FormData();
    del.set("id", String(seed.id));
    expect(await deletePostForm(db, del)).toMatchObject({ ok: true, deleted: true });
    expect(await deletePostForm(db, del)).toEqual({ ok: false, error: "notFound" });
    const bad = new FormData();
    bad.set("id", "x");
    expect(await deletePostForm(db, bad)).toEqual({ ok: false, error: "invalid" });
    expect(await db.select().from(posts)).toHaveLength(5);
  });
});

describe("missing rows", () => {
  test("a page or setting that is not stored yet loads empty and is created on save", async () => {
    await db.delete(pages).where(eq(pages.key, "terms"));
    await db.delete(settings).where(eq(settings.key, "newsletter"));
    const s = await loadSettings(db);
    expect(s.values.terms).toEqual({ title: { et: "" }, body: { et: "" } });
    expect(s.values.newsletter).toEqual({ discountLabel: "", welcomeCode: "" });
    const r = await saveSettingsForm(db, form({ terms: { version: s.versions.terms, value: { title: { et: "Tingimused" }, body: { et: "Tekst." } } } }));
    expect(r).toMatchObject({ ok: true });
    expect(await writeSettingsPart(db, "newsletter", { discountLabel: "10%" }, s.versions.newsletter, new Date())).toMatchObject({ ok: true });
    expect(await getPage(db, "terms")).toMatchObject({ title: { et: "Tingimused" }, body: { et: "Tekst." } });
    expect((await getSettings(db)).newsletter).toEqual({ discountLabel: "10%" });
  });
});
