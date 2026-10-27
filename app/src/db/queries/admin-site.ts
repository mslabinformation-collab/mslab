import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Q, Tx } from "../client";
import { campaign, faq, galleryItems, heroSlides, pages, posts, practicePackages } from "../schema";
import type { Campaign, FaqItem, GalleryItem, HeroSlide, Page, Post, PracticePackage } from "../schema";
import { numberedSlug } from "@/domain/site-checks";
import type { I18n } from "@/i18n/field";

// The site content editors' reads and writes (Task 13B): hero slides, FAQ, text pages, settings, practice packages, the
// trainer works gallery, the campaign and posts. Callers must already have checked the admin session. The readers take
// the database or an open transaction, so a save reads what it compares (the stale guard) inside its own transaction.

/** The tables a site editor writes; a save locks the ones it touches (see lockTables). */
export const SITE_TABLES = ["campaign", "faq", "gallery_items", "hero_slides", "pages", "posts", "practice_packages", "settings"] as const;
export type SiteTable = (typeof SITE_TABLES)[number];

/**
 * Locks the tables for the rest of the transaction against other writers (EXCLUSIVE: plain reads, the public pages, go
 * on). Two admins saving the same content are so put one after the other: the second one then sees the first one's
 * change and is refused as stale. Always in the same (alphabetical) order, so two saves cannot wait on each other.
 * A table-level lock also covers rows that do not exist yet (a new FAQ item, a missing settings key).
 */
export async function lockTables(tx: Tx, tables: Iterable<SiteTable>): Promise<void> {
  const list = SITE_TABLES.filter((t) => new Set(tables).has(t));
  if (list.length) await tx.execute(sql.raw(`LOCK TABLE ${list.join(", ")} IN EXCLUSIVE MODE`));
}

// ---------- reads ----------

export const readSlides = (q: Q): Promise<HeroSlide[]> => q.select().from(heroSlides).orderBy(asc(heroSlides.sort), asc(heroSlides.id));

export const readFaq = (q: Q): Promise<FaqItem[]> => q.select().from(faq).orderBy(asc(faq.sort), asc(faq.id));

export async function readPage(q: Q, key: string): Promise<Page | null> {
  const [row] = await q.select().from(pages).where(eq(pages.key, key)).limit(1);
  return row ?? null;
}

/** A settings value, or null when the key is not stored (the reader lives with the public queries; the admin's editors use it too). */
export { readSetting } from "./public";

export async function readPackage(q: Q, code: string): Promise<PracticePackage | null> {
  const [row] = await q.select().from(practicePackages).where(eq(practicePackages.code, code)).limit(1);
  return row ?? null;
}

export const readPackages = (q: Q): Promise<PracticePackage[]> => q.select().from(practicePackages).orderBy(asc(practicePackages.sort), asc(practicePackages.code));

export const readGallery = (q: Q, group: string): Promise<GalleryItem[]> =>
  q.select().from(galleryItems).where(eq(galleryItems.group, group)).orderBy(asc(galleryItems.sort), asc(galleryItems.id));

/** The newsletter popup's row (kind "newsletter", phase 2c): Hüpikaken's one popup since admin UX pass piece 4b (R-d: the old campaign offer's row 1 is shown and edited nowhere). */
export async function readNewsletterPopup(q: Q): Promise<Campaign | null> {
  const [row] = await q.select().from(campaign).where(eq(campaign.kind, "newsletter")).limit(1);
  return row ?? null;
}

export async function readPost(q: Q, id: number): Promise<Post | null> {
  const [row] = await q.select().from(posts).where(eq(posts.id, id)).limit(1);
  return row ?? null;
}

/** Is `slug` used by a post other than `exceptId`? */
export async function isPostSlugTaken(q: Q, slug: string, exceptId?: number | null): Promise<boolean> {
  const [row] = await q
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.slug, slug), exceptId != null ? ne(posts.id, exceptId) : undefined))
    .limit(1);
  return row !== undefined;
}

// ---------- writes (inside the save's transaction) ----------

export type SlideRow = Omit<HeroSlide, "id" | "sort">;
export type FaqRow = { q: I18n; a: I18n };
export type PackageFields = Omit<PracticePackage, "code" | "sort">;
export type PostFields = Omit<Post, "id">;

/**
 * How an ordered list is stored so that its rows keep their ids: a row with the id of a stored row updates it, one
 * without (or with an id that is not stored, or that came earlier in the list: a forged draft) is added, and stored rows
 * that are not in the list are deleted. sort = place 1…n.
 */
export function syncPlan<T extends { id: number | null }>(stored: number[], rows: T[]): { remove: number[]; steps: { id: number | null; row: Omit<T, "id">; sort: number }[] } {
  const known = new Set(stored);
  const used = new Set<number>();
  const steps = rows.map(({ id, ...row }, i) => {
    const keep = id != null && known.has(id) && !used.has(id);
    if (keep) used.add(id);
    return { id: keep ? id : null, row, sort: i + 1 };
  });
  return { remove: stored.filter((id) => !used.has(id)), steps };
}

/** The hero slides in this order, keeping their ids (syncPlan). */
export async function saveSlides(tx: Tx, rows: (SlideRow & { id: number | null })[]): Promise<void> {
  const plan = syncPlan((await tx.select({ id: heroSlides.id }).from(heroSlides)).map((r) => r.id), rows);
  if (plan.remove.length) await tx.delete(heroSlides).where(inArray(heroSlides.id, plan.remove));
  for (const step of plan.steps) {
    if (step.id != null) await tx.update(heroSlides).set({ ...step.row, sort: step.sort }).where(eq(heroSlides.id, step.id));
    else await tx.insert(heroSlides).values({ ...step.row, sort: step.sort });
  }
}

/** The FAQ in this order, keeping the ids of its items (syncPlan), so the editor's rows keep their fields after a save. */
export async function saveFaq(tx: Tx, rows: (FaqRow & { id: number | null })[]): Promise<void> {
  const plan = syncPlan((await tx.select({ id: faq.id }).from(faq)).map((r) => r.id), rows);
  if (plan.remove.length) await tx.delete(faq).where(inArray(faq.id, plan.remove));
  for (const step of plan.steps) {
    if (step.id != null) await tx.update(faq).set({ ...step.row, sort: step.sort }).where(eq(faq.id, step.id));
    else await tx.insert(faq).values({ ...step.row, sort: step.sort });
  }
}

export async function updatePackage(tx: Tx, code: string, fields: PackageFields): Promise<void> {
  await tx.update(practicePackages).set(fields).where(eq(practicePackages.code, code));
}

/**
 * The first address of `slug`'s series that no post but `exceptId` has (admin UX pass piece 4b, ruling R-g; S4-19): `slug` itself, else `slug-2`,
 * `slug-3` … (domain/site-checks.ts numberedSlug). Inside a transaction that has the posts table locked (lockTables), so nothing takes it before the
 * write: „Lisa postitus +“ (insertPost) and an address that follows its title (server/admin-site.ts) number it so.
 */
export async function freePostSlug(q: Q, slug: string, exceptId?: number): Promise<string> {
  if (!(await isPostSlugTaken(q, slug, exceptId))) return slug;
  for (let n = 2; ; n++) {
    const next = numberedSlug(slug, n);
    if (!(await isPostSlugTaken(q, next, exceptId))) return next;
  }
}

/**
 * Inserts a post (inside the save's transaction, the posts table locked: lockTables). An address another post has gets the series' first free one
 * (freePostSlug: „Lisa postitus +“ pressed twice, or in two tabs, makes `uus-postitus` and `uus-postitus-2`, never a unique-index error). The row as
 * stored, with its address.
 */
export async function insertPost(tx: Tx, fields: PostFields): Promise<Post> {
  const [row] = await tx.insert(posts).values({ ...fields, slug: await freePostSlug(tx, fields.slug) }).returning();
  return row;
}

/** Writes the given columns of a post (the others stay). */
export async function updatePost(tx: Tx, id: number, fields: Partial<PostFields>): Promise<void> {
  await tx.update(posts).set(fields).where(eq(posts.id, id));
}

/**
 * Deletes a post's row, inside the caller's transaction: server/site-drafts.ts deletePost, which takes the post's draft lock and the posts table first
 * and deletes its drafts in the same transaction (piece 4b, ruling R-h). The deleted row; null when there was none.
 */
export async function deletePostRow(tx: Tx, id: number): Promise<Post | null> {
  const [row] = await tx.delete(posts).where(eq(posts.id, id)).returning();
  return row ?? null;
}
