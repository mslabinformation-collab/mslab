import type { I18n } from "@/i18n/field";
import { parseRowId } from "@/lib/row-id";
import type { FaqDraft, PackageDraft, PageDraft, SlideDraft, TrainerDraft, WorkDraft } from "./site-editor";

// The site content editors on the draft layer (admin UX pass piece 4a; rulings R-a, R-b): Avaleht ("home"), Koolitaja ("trainer") and Praktika
// ("practice"). Each is one row of `content_drafts` (server/drafts.ts) with the entity's name and entity_id 0, and its parts are the ones
// server/admin-site.ts has: home slides, statement, teaser, faq; trainer trainer, bio, works, center_story, trainer_journey; practice one part per
// package code (read from `practice_packages`). The design's cards are views over these parts; no part is split (R-a).
// Piece 4b (ruling R-a) adds the posts ("post"): one row per post, entity_id the post's id, with the one part `post` (PostPartValue); and (R-c) Hüpikaken
// ("popup"), entity_id 0 as the three above, with the one part `offer` (PopupOfferValue). Its switch „Lehel näidatakse“ is no part: it acts on the live row.
//
// A part's value as its editor holds it (`SitePartState.value`, `.live`) is a record of fields, as the autosave sends them (components/admin/
// autosave/engine.ts: a patch is some of the fields). Most parts' drafts are records already (a package, the trainer card, a page's title and
// text, a post); a list part (the slides, the FAQ, the trainer's gallery) is held as one field of the part's own name: `{ slides: SlideDraft[] }`.
// Pure: no database, no React; the browser imports it too (tests/unit/old-safari.test.ts).

/** The entities that are one record each, in the one `content_drafts` row SITE_ENTITY_ID: Avaleht, Koolitaja, Praktika, Hüpikaken (piece 4b). */
export type SiteEntity = "home" | "trainer" | "practice" | "popup";
export const SITE_ENTITIES: readonly SiteEntity[] = ["home", "trainer", "practice", "popup"];

/** Every entity of the site content's draft layer (its `content_drafts.entity`): the four above and the posts (piece 4b R-a), one row per post. */
export type SiteDraftEntity = SiteEntity | "post";

/** The `content_drafts` row id of Avaleht, Koolitaja, Praktika and Hüpikaken (R-a). */
export const SITE_ENTITY_ID = 0;

export const isSiteEntity = (s: string): s is SiteEntity => (SITE_ENTITIES as readonly string[]).includes(s);

/**
 * What a site editor edits: Avaleht, Koolitaja, Praktika or Hüpikaken by name (their row 0), or a post by its id (piece 4b R-a: entity_id = posts.id).
 * The server's draft functions (server/site-drafts.ts) take it.
 */
export type SiteTarget = SiteEntity | { entity: "post"; id: number };

/** A target's `content_drafts` row: its entity and its entity_id. */
export const siteRowOf = (t: SiteTarget): { entity: SiteDraftEntity; id: number } => (typeof t === "string" ? { entity: t, id: SITE_ENTITY_ID } : { entity: t.entity, id: t.id });

/**
 * The target an address names (api/admin/sisu/<entity>/<id>/…): Avaleht, Koolitaja, Praktika or Hüpikaken with id "0", a post with its id written as
 * a row id (lib/row-id.ts: digits, no leading zero); null for anything else (the routes' 404).
 */
export function parseSiteTarget(entity: string, id: string): SiteTarget | null {
  if (entity === "post") {
    const n = parseRowId(id);
    return n === null ? null : { entity: "post", id: n };
  }
  return isSiteEntity(entity) && id === String(SITE_ENTITY_ID) ? entity : null;
}

/**
 * The advisory lock's name of an entity row's drafts (R-c): every save, discard, publish and switch of the row takes it first, and so does deleting
 * a post with its drafts (server/site-drafts.ts deletePost).
 */
export const siteDraftLockKey = (entity: SiteDraftEntity, id: number): string => `site-draft:${entity}:${id}`;

/** A post's one part (R-a). */
export const POST_PART = "post";

/**
 * A post as its editor holds it (piece 4b R-a): the post's fields without `published` (the instant switch „Avaldatud“, so it never moves the part's
 * version) and without its id; `publishedAt` is the Estonian calendar day, YYYY-MM-DD.
 */
export type PostPartValue = { title: I18n; slug: string; category: I18n; excerpt: I18n; body: I18n; coverKey: string; publishedAt: string };

/** Hüpikaken's one part (piece 4b R-c): the card „Pakkumine“ (S4-27). */
export const POPUP_PART = "offer";

/**
 * Hüpikaken's offer as its editor holds it (piece 4b R-c): the newsletter popup's texts and picture (the `campaign` row of kind "newsletter") and the
 * two numbers of `settings.newsletter` — „Soodustus (%)“ and „Kood kehtib (päeva)“ — as typed, the way a package's price and models are held (a whole
 * number checked at the field; "" for days: none, the welcome mail then says nothing of them). No `active`: „Lehel näidatakse“ is the instant switch,
 * so it never moves the part's version; and no welcome code (Seaded's „Tervituskood“, in the same settings row), so a code's save never blocks it.
 */
export type PopupOfferValue = { kicker: I18n; title: I18n; text: I18n; imageKey: string; discountPercent: string; codeDays: string };

/**
 * A part as its editor starts (server/site-drafts.ts readSiteEditor): `version` (R-b) "l:<hash>" while the part has no draft (the hash of `live`),
 * "d:<draft row id>.<n>" with one; `value` the draft over live (live when there is none); `live` what the public page shows.
 */
export type SitePartState = { version: string; value: unknown; live: unknown };

/** The fixed parts of Avaleht and Koolitaja, in their screens' order (Praktika's are its package codes, in the packages' order). */
export const HOME_PARTS = ["slides", "statement", "teaser", "faq"] as const;
export const TRAINER_PARTS = ["trainer", "bio", "works", "center_story", "trainer_journey"] as const;

/** The editor's values of the parts (Praktika: each package code's part is a PackageDraft). */
export type HomePartValues = { slides: { slides: SlideDraft[] }; statement: { body: I18n }; teaser: { body: I18n }; faq: { faq: FaqDraft[] } };
export type TrainerPartValues = { trainer: TrainerDraft; bio: { body: I18n }; works: { works: WorkDraft[] }; center_story: PageDraft; trainer_journey: PageDraft };
export type PracticePartValue = PackageDraft;

/** Is the part a list of rows, held by its editor as the one field of its own name? */
export const isListPart = (entity: SiteDraftEntity, part: string): boolean => (entity === "home" ? part === "slides" || part === "faq" : entity === "trainer" && part === "works");

/** A part's stored draft (server/admin-site.ts Part.draft) as its editor holds it: a list as its one field, a record as it is. */
export const toEditorValue = (entity: SiteDraftEntity, part: string, draft: unknown): Record<string, unknown> =>
  isListPart(entity, part) ? { [part]: draft } : (draft as Record<string, unknown>);

/** The editor's value back to the part's draft (what its checks and writer take). */
export const fromEditorValue = (entity: SiteDraftEntity, part: string, value: Record<string, unknown>): unknown => (isListPart(entity, part) ? value[part] : value);
