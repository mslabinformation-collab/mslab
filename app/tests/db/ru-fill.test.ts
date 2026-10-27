import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { campaign, courseImages, courseModules, courses, faq, pages, posts, practicePackages, settings } from "@/db/schema";
import { listModuleTitles } from "@/db/queries/public";
import { applySeed } from "@/db/seed-apply";
import { applyRuFill, fillBadge, fillI18n, fillTrainer, OLD_TRAINER_STATS, planRuFill } from "@/db/ru-fill";
import { targetMatches } from "@/db/fill-ru";
import { pageSeeds } from "@/db/seed-data";

// Round 2 item 1b: the Russian sample texts reach a database seeded before them, and nothing Maria wrote is touched.

const etOnly = (v: unknown) => (v && typeof v === "object" && "et" in v ? { et: (v as { et: string }).et } : v);

describe("the fill rule", () => {
  test("only an empty Russian text, only while the Estonian text is still the seed's", () => {
    const seed = { et: "Uus", ru: "Новинка" };
    expect(fillI18n({ et: "Uus" }, seed)).toEqual(seed);
    expect(fillI18n({ et: "Uus", ru: "" }, seed)).toEqual(seed);
    expect(fillI18n({ et: "Uus", ru: "Своё" }, seed)).toBeNull(); // Maria's Russian text stays
    expect(fillI18n({ et: "Uus!" }, seed)).toBeNull(); // her Estonian edit: the field is hers
    expect(fillI18n({ et: "Uus" }, { et: "Uus" })).toBeNull(); // nothing to add
    expect(fillI18n(null, seed)).toBeNull();
  });

  test("badges: an old plain label equal to the seed's gets the Russian text", () => {
    const seed = { label: { et: "Populaarne", ru: "Популярное" }, bg: "#222222", fg: "#ffffff" };
    expect(fillBadge({ label: "Populaarne", bg: "#6B4F5C", fg: "#ffffff" }, seed)).toEqual({ label: { et: "Populaarne", ru: "Популярное" }, bg: "#6B4F5C", fg: "#ffffff" });
    expect(fillBadge({ label: "Sügise hitt", bg: "#222222", fg: "#ffffff" }, seed)).toBeNull();
    expect(fillBadge(null, seed)).toBeNull();
  });

  test("the trainer: the old seed's stats become D's labels; edited stats only get Russian labels where still the seed's", () => {
    const filled = fillTrainer({ name: "Maria Sosnina", role: { et: "Kulmu- ja ripsmetehnikate meister ja koolitaja" }, stats: OLD_TRAINER_STATS, portraitKey: "/p.jpg" })!;
    expect(filled).toMatchObject({ name: { et: "Maria Sosnina", ru: "Мария Соснина" }, role: { ru: "Мастер и преподаватель техник бровей и ресниц" }, portraitKey: "/p.jpg" });
    expect((filled.stats as { label: unknown }[]).map((s) => s.label)).toEqual([
      { et: "aastat kogemust", ru: "лет опыта" },
      { et: "linna", ru: "города" },
      { et: "väikesed grupid", ru: "малые группы" },
    ]);
    const edited = fillTrainer({ name: "Maria S.", stats: [{ value: "10+", label: { et: "aastat" } }, { value: "4", label: { et: "linna" } }] })!;
    expect(edited.name).toBe("Maria S."); // her name stays
    expect(edited.stats).toEqual([{ value: "10+", label: { et: "aastat" } }, { value: "4", label: { et: "linna", ru: "города" } }]);
    expect(fillTrainer({ name: "Maria S.", stats: [] })).toBeNull();
  });
});

describe("plan and apply on a database seeded before round 2", () => {
  let db: Db;

  beforeAll(async () => {
    db = await makeTestDb();
    await applySeed(db);
    // the state of a database seeded before round 2: Estonian-only texts, plain badge labels, the old trainer values
    for (const c of await db.select().from(courses)) {
      await db
        .update(courses)
        .set({
          title: etOnly(c.title) as never,
          summary: etOnly(c.summary) as never,
          includes: c.includes.map(etOnly) as never,
          durationLabel: (c.durationLabel && etOnly(c.durationLabel)) as never,
          badge: (c.badge && { ...c.badge, label: typeof c.badge.label === "string" ? c.badge.label : c.badge.label.et }) as never,
        })
        .where(eq(courses.id, c.id));
    }
    for (const m of await db.select().from(courseModules)) await db.update(courseModules).set({ title: etOnly(m.title) as never }).where(eq(courseModules.id, m.id));
    for (const i of await db.select().from(courseImages)) await db.update(courseImages).set({ alt: etOnly(i.alt) as never }).where(eq(courseImages.id, i.id));
    for (const q of await db.select().from(faq)) await db.update(faq).set({ q: etOnly(q.q) as never, a: etOnly(q.a) as never }).where(eq(faq.id, q.id));
    for (const p of await db.select().from(posts)) await db.update(posts).set({ title: etOnly(p.title) as never, excerpt: etOnly(p.excerpt) as never, body: etOnly(p.body) as never }).where(eq(posts.id, p.id));
    await db.delete(pages).where(eq(pages.key, "trainer_teaser"));
    for (const p of await db.select().from(pages)) if (p.key !== "privacy" && p.key !== "terms" && p.key !== "center_story" && p.key !== "course_terms") await db.update(pages).set({ title: etOnly(p.title) as never, body: etOnly(p.body) as never }).where(eq(pages.key, p.key));
    const [camp] = await db.select().from(campaign).where(eq(campaign.id, 1));
    await db.update(campaign).set({ kicker: etOnly(camp.kicker) as never, title: etOnly(camp.title) as never, text: etOnly(camp.text) as never, ctaLabel: etOnly(camp.ctaLabel) as never }).where(eq(campaign.id, 1));
    const [t] = await db.select().from(settings).where(eq(settings.key, "trainer"));
    await db.update(settings).set({ value: { ...(t.value as object), name: "Maria Sosnina", stats: OLD_TRAINER_STATS } }).where(eq(settings.key, "trainer"));
    for (const p of await db.select().from(practicePackages)) await db.update(practicePackages).set({ durationLabel: etOnly(p.durationLabel) as never }).where(eq(practicePackages.code, p.code));
    // Maria's own edits, which must stay as they are
    await db.update(courses).set({ title: { et: "Kulmude LAMI (Maria)" } }).where(eq(courses.slug, "kulmude-lami"));
    await db.update(courses).set({ summary: { et: "Uus koolitus.", ru: "Мой текст." } }).where(eq(courses.slug, "lash-lift-botox"));
  });

  test("a dry run counts rows per table and writes nothing; apply fills them once; a second plan finds nothing", async () => {
    const plan = await planRuFill(db);
    expect(plan.counts).toMatchObject({ courses: 6, faq: 6, posts: 6, settings: 1, practice_packages: 2 });
    // the old campaign offer's row 1 (Estonian-only above) is left alone: it is shown and edited nowhere since admin UX pass piece 4b (R-d)
    expect(plan.counts.campaign).toBeUndefined();
    expect(plan.counts.pages).toBe(4); // statement, trainer_bio and trainer_journey (one row each), and the new trainer card row
    expect(plan.counts.course_images).toBeGreaterThan(0);
    expect(plan.counts.course_modules).toBeGreaterThan(0);
    expect((await db.select().from(courses).where(eq(courses.slug, "kulmumeistri-e-koolitus")))[0].title).toEqual({ et: "Kulmumeistri e-koolitus" });

    await applyRuFill(db, plan);
    expect((await planRuFill(db)).updates).toHaveLength(0);

    const bySlug = async (slug: string) => (await db.select().from(courses).where(eq(courses.slug, slug)))[0];
    expect((await bySlug("kulmumeistri-e-koolitus")).title).toEqual({ et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" });
    expect((await bySlug("kulmumeistri-baaskoolitus")).badge).toEqual({ label: { et: "Populaarne", ru: "Популярное" }, bg: "#222222", fg: "#ffffff" });
    expect((await bySlug("kulmumeistri-baaskoolitus")).durationLabel).toEqual({ et: "2 päeva · 16 ak", ru: "2 дня · 16 ак. ч." });
    // Maria's edits are untouched; her course's other seed texts are filled
    const lami = await bySlug("kulmude-lami");
    expect(lami.title).toEqual({ et: "Kulmude LAMI (Maria)" });
    expect(lami.summary.ru).toBe("Ламинирование бровей для практикующих мастеров: средства, время выдержки и стойкость формы.");
    expect((await bySlug("lash-lift-botox")).summary).toEqual({ et: "Uus koolitus.", ru: "Мой текст." });
    const [kuju] = await db.select().from(courses).where(eq(courses.slug, "kulmukuju-ja-summeetria"));
    expect((await listModuleTitles(db, kuju.id))[0]).toEqual({ et: "Sissejuhatus ja töövahendid", ru: "Введение и инструменты" });

    const teaser = (await db.select().from(pages).where(eq(pages.key, "trainer_teaser")))[0];
    expect(teaser).toEqual(pageSeeds.find((p) => p.key === "trainer_teaser"));
    const trainer = (await db.select().from(settings).where(eq(settings.key, "trainer")))[0].value as { name: unknown; stats: { label: unknown }[] };
    expect(trainer.name).toEqual({ et: "Maria Sosnina", ru: "Мария Соснина" });
    expect(trainer.stats[0].label).toEqual({ et: "aastat kogemust", ru: "лет опыта" });
  });

  test("no trainer card row while the bio it would replace has been edited", async () => {
    await db.delete(pages).where(eq(pages.key, "trainer_teaser"));
    await db.update(pages).set({ body: { et: "Maria oma tekst." } }).where(eq(pages.key, "trainer_bio"));
    expect((await planRuFill(db)).counts.pages ?? 0).toBe(0);
  });
});

describe("the CLI's guards", () => {
  test("--target must agree with the address", () => {
    expect(targetMatches("postgres://u:p@localhost:5432/mslab", "local")).toBe(true);
    expect(targetMatches("postgres://u:p@127.0.0.1/db", "local")).toBe(true);
    expect(targetMatches("postgres://u:p@[::1]:5432/db", "local")).toBe(true);
    expect(targetMatches("postgres://u:p@x.proxy.rlwy.net:123/railway", "local")).toBe(false);
    expect(targetMatches("postgres://u:p@x.proxy.rlwy.net:123/railway", "railway")).toBe(true);
    expect(targetMatches("postgres://u:p@localhost:5432/mslab", "railway")).toBe(false);
    expect(targetMatches("postgres://u:p@db.example.com/x", "railway")).toBe(false);
    expect(targetMatches("not a url", "local")).toBe(false);
  });
});
