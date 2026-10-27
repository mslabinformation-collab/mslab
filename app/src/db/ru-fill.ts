import { and, asc, eq, sql } from "drizzle-orm";
import type { Badge, StoredBadge } from "./schema";
import { courseImages, courseModules, courses, faq, galleryItems, heroSlides, pages, posts, practicePackages, settings } from "./schema";
import type { Db } from "./client";
import { courseSeeds, faqSeeds, heroSeeds, pageSeeds, postSeeds, practiceSeeds, settingSeeds, trainerWorks } from "./seed-data";
import type { I18n } from "@/i18n/field";

// Round 2 item 1b (and 5): brings the Russian sample texts of the seed (seed-data.ts) to a database seeded before they
// existed, WITHOUT touching anything Maria has written. A field gets the seed's Russian text only when
//   - its Russian text is missing or empty, and
//   - its Estonian text is still exactly the seed's Estonian text (an edited field is Maria's: left alone).
// The same rule for the round-2 changes of seed values that are not Russian texts: the home trainer card's own text
// (a new pages row, added only while the bio it replaces is still the seed's), D's stat labels (only while the stats
// are still the old seed's), the trainer's name in two languages and the badge labels (only while still the seed's).
// plan() reads and counts; apply() writes the plan in one transaction. No content is ever printed (counts only).

type Row = Record<string, unknown>;
const isI18n = (v: unknown): v is I18n => !!v && typeof v === "object" && typeof (v as I18n).et === "string";

/** The stored value with the seed's Russian text, or null when the rule says no (or there is nothing to add). */
export function fillI18n(stored: unknown, seed: I18n | null | undefined): I18n | null {
  if (!isI18n(stored) || !seed?.ru?.trim()) return null;
  if (stored.et !== seed.et) return null; // edited: Maria's
  if (typeof stored.ru === "string" && stored.ru.trim()) return null; // already has one
  return { ...stored, ru: seed.ru };
}

/** A list filled item by item (same position, same Estonian text); null when no item changes. */
export function fillList(stored: unknown, seed: I18n[] | null | undefined): I18n[] | null {
  if (!Array.isArray(stored) || !seed) return null;
  let changed = false;
  const out = stored.map((item, i) => {
    const filled = fillI18n(item, seed[i]);
    if (filled) changed = true;
    return filled ?? item;
  });
  return changed ? out : null;
}

/** A badge whose label is still the seed's Estonian text gets the seed's Russian text (the new label shape). */
export function fillBadge(stored: StoredBadge | null | undefined, seed: Badge): Badge | null {
  if (!stored || !seed?.label.ru) return null;
  const label = typeof stored.label === "string" ? { et: stored.label } : stored.label;
  const filled = fillI18n(label, seed.label as I18n);
  return filled ? { ...stored, label: filled } : null;
}

/** settings.trainer before round 2: the seed's stats with their short labels (D's labels replace them, item 5). */
export const OLD_TRAINER_STATS = [
  { value: "8+", label: { et: "aastat" } },
  { value: "4", label: { et: "linna" } },
  { value: "1:4", label: { et: "grupp" } },
];

/** Deep equality whatever the key order (jsonb stores object keys in its own order). */
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Row)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** settings.trainer with the round-2 seed values the rule allows, or null. */
export function fillTrainer(stored: unknown): Row | null {
  if (!stored || typeof stored !== "object") return null;
  const t = stored as Row;
  const seed = settingSeeds.trainer as { name: I18n; role: I18n; stats: { value: string; label: I18n }[] };
  const out: Row = { ...t };
  let changed = false;
  // the name: a plain string still equal to the seed's Estonian name, or { et } without a Russian one
  const name = typeof t.name === "string" ? { et: t.name } : t.name;
  const filledName = fillI18n(name, seed.name);
  if (filledName) {
    out.name = filledName;
    changed = true;
  }
  const role = fillI18n(t.role, seed.role);
  if (role) {
    out.role = role;
    changed = true;
  }
  if (same(t.stats, OLD_TRAINER_STATS)) {
    out.stats = seed.stats; // still the old seed's: D's labels in both languages
    changed = true;
  } else if (Array.isArray(t.stats)) {
    let statsChanged = false;
    const stats = t.stats.map((s: Row, i: number) => {
      const label = fillI18n(s?.label, seed.stats[i]?.label);
      if (!label || s.value !== seed.stats[i]?.value) return s;
      statsChanged = true;
      return { ...s, label };
    });
    if (statsChanged) {
      out.stats = stats;
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Fills the I18n fields `names` of `row` from `seed`; the changed fields, or null. */
function fillFields(row: Row, seed: Row, names: string[], lists: string[] = []): Row | null {
  const set: Row = {};
  for (const n of names) {
    const v = fillI18n(row[n], seed[n] as I18n | null);
    if (v) set[n] = v;
  }
  for (const n of lists) {
    const v = fillList(row[n], seed[n] as I18n[] | null);
    if (v) set[n] = v;
  }
  return Object.keys(set).length ? set : null;
}

type Update = { table: string; apply: (tx: Db) => Promise<unknown> };
export type RuFillPlan = { counts: Record<string, number>; updates: Update[] };

/** What the fill would change: rows per table (counted once per row, whatever number of fields). */
export async function planRuFill(db: Db): Promise<RuFillPlan> {
  const updates: Update[] = [];
  const add = (table: string, apply: Update["apply"]) => updates.push({ table, apply });

  // courses by slug, with their images (by key, while the Estonian alt text is still the seed's) and module titles
  for (const seed of courseSeeds) {
    const [row] = await db.select().from(courses).where(eq(courses.slug, seed.slug)).limit(1);
    if (!row) continue;
    const set = fillFields(row as Row, seed as unknown as Row, ["title", "summary", "body", "durationLabel", "nextDiscount"], ["outcomes", "includes"]) ?? {};
    const badge = fillBadge(row.badge, seed.badge as Badge);
    if (badge) set.badge = badge;
    if (Object.keys(set).length) add("courses", (tx) => tx.update(courses).set({ ...set, updatedAt: sql`now()` }).where(eq(courses.id, row.id)));
    const images = await db.select().from(courseImages).where(eq(courseImages.courseId, row.id));
    for (const img of images) {
      const seedImage = seed.images.find((s) => s.key === img.key && s.alt.et === img.alt?.et);
      const alt = fillI18n(img.alt, seedImage?.alt);
      if (alt) add("course_images", (tx) => tx.update(courseImages).set({ alt }).where(eq(courseImages.id, img.id)));
    }
    // the module titles (course_modules, by position), each while its Estonian text is still the seed's
    const moduleRows = await db.select().from(courseModules).where(eq(courseModules.courseId, row.id)).orderBy(asc(courseModules.position), asc(courseModules.id));
    for (const [i, m] of moduleRows.entries()) {
      const title = fillI18n(m.title, seed.modules?.[i]);
      if (title) add("course_modules", (tx) => tx.update(courseModules).set({ title }).where(eq(courseModules.id, m.id)));
    }
  }

  for (const seed of practiceSeeds) {
    const [row] = await db.select().from(practicePackages).where(eq(practicePackages.code, seed.code)).limit(1);
    const set = row && fillFields(row as Row, seed as unknown as Row, ["name", "tagline", "durationLabel"], ["items"]);
    if (row && set) add("practice_packages", (tx) => tx.update(practicePackages).set(set).where(eq(practicePackages.code, row.code)));
  }

  // keyless lists: a stored row is the seed row with the same Estonian title / question
  for (const row of await db.select().from(heroSlides)) {
    const seed = heroSeeds.find((s) => s.title.et === row.title.et);
    const set = seed && fillFields(row as Row, seed as unknown as Row, ["kicker", "title", "text", "ctaLabel"]);
    if (set) add("hero_slides", (tx) => tx.update(heroSlides).set(set).where(eq(heroSlides.id, row.id)));
  }
  for (const row of await db.select().from(faq)) {
    const seed = faqSeeds.find((s) => s.q.et === row.q.et);
    const set = seed && fillFields(row as Row, seed as unknown as Row, ["q", "a"]);
    if (set) add("faq", (tx) => tx.update(faq).set(set).where(eq(faq.id, row.id)));
  }

  for (const seed of postSeeds) {
    const [row] = await db.select().from(posts).where(eq(posts.slug, seed.slug)).limit(1);
    const set = row && fillFields(row as Row, seed as unknown as Row, ["title", "excerpt", "body", "category"]);
    if (row && set) add("posts", (tx) => tx.update(posts).set(set).where(eq(posts.id, row.id)));
  }

  for (const seed of pageSeeds) {
    const [row] = await db.select().from(pages).where(eq(pages.key, seed.key)).limit(1);
    if (!row) continue;
    const set = fillFields(row as Row, seed as unknown as Row, ["title", "body"]);
    if (set) add("pages", (tx) => tx.update(pages).set(set).where(eq(pages.key, row.key)));
  }
  // the home trainer card's own text: a new row, added while the card still shows the seed bio's first paragraph
  const teaser = pageSeeds.find((p) => p.key === "trainer_teaser")!;
  const bioSeed = pageSeeds.find((p) => p.key === "trainer_bio")!;
  const [teaserRow] = await db.select().from(pages).where(eq(pages.key, "trainer_teaser")).limit(1);
  const [bioRow] = await db.select().from(pages).where(eq(pages.key, "trainer_bio")).limit(1);
  if (!teaserRow && bioRow?.body.et === bioSeed.body.et) add("pages", (tx) => tx.insert(pages).values(teaser).onConflictDoNothing({ target: pages.key }));

  for (const row of await db.select().from(galleryItems).where(eq(galleryItems.group, "trainer_works"))) {
    const seed = trainerWorks.find((s) => s.key === row.key && s.alt.et === row.alt?.et);
    const alt = fillI18n(row.alt, seed?.alt);
    if (alt) add("gallery_items", (tx) => tx.update(galleryItems).set({ alt }).where(and(eq(galleryItems.id, row.id), eq(galleryItems.group, "trainer_works"))));
  }

  // (the old campaign offer's row 1 is not filled: it is shown and edited nowhere since admin UX pass piece 4b, R-d)

  const [trainer] = await db.select().from(settings).where(eq(settings.key, "trainer")).limit(1);
  const trainerValue = trainer && fillTrainer(trainer.value);
  if (trainerValue) add("settings", (tx) => tx.update(settings).set({ value: trainerValue }).where(eq(settings.key, "trainer")));

  const counts: Record<string, number> = {};
  for (const u of updates) counts[u.table] = (counts[u.table] ?? 0) + 1;
  return { counts, updates };
}

/** Writes a plan in one transaction. */
export async function applyRuFill(db: Db, plan: RuFillPlan): Promise<void> {
  if (!plan.updates.length) return;
  await db.transaction(async (tx) => {
    for (const u of plan.updates) await u.apply(tx as unknown as Db);
  });
}
