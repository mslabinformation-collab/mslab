import type { I18n } from "@/i18n/field";
import type { FaqDraft, PackageDraft, PageDraft, SlideDraft, TrainerDraft, WorkDraft } from "./site-editor";

// The site content editors on the draft layer (admin UX pass piece 4a; rulings R-a, R-b): Avaleht ("home"), Koolitaja ("trainer") and Praktika
// ("practice"). Each is one row of `content_drafts` (server/drafts.ts) with the entity's name and entity_id 0, and its parts are the ones
// server/admin-site.ts has: home slides, statement, teaser, faq; trainer trainer, bio, works, center_story, trainer_journey; practice one part per
// package code (read from `practice_packages`). The design's cards are views over these parts; no part is split (R-a).
//
// A part's value as its editor holds it (`SitePartState.value`, `.live`) is a record of fields, as the autosave sends them (components/admin/
// autosave/engine.ts: a patch is some of the fields). Most parts' drafts are records already (a package, the trainer card, a page's title and
// text); a list part (the slides, the FAQ, the trainer's gallery) is held as one field of the part's own name: `{ slides: SlideDraft[] }`.
// Pure: no database, no React; the browser imports it too (tests/unit/old-safari.test.ts).

export type SiteEntity = "home" | "trainer" | "practice";
export const SITE_ENTITIES: readonly SiteEntity[] = ["home", "trainer", "practice"];

/** Every site entity's one `content_drafts` row id (R-a). */
export const SITE_ENTITY_ID = 0;

export const isSiteEntity = (s: string): s is SiteEntity => (SITE_ENTITIES as readonly string[]).includes(s);

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
export const isListPart = (entity: SiteEntity, part: string): boolean => (entity === "home" ? part === "slides" || part === "faq" : entity === "trainer" && part === "works");

/** A part's stored draft (server/admin-site.ts Part.draft) as its editor holds it: a list as its one field, a record as it is. */
export const toEditorValue = (entity: SiteEntity, part: string, draft: unknown): Record<string, unknown> =>
  isListPart(entity, part) ? { [part]: draft } : (draft as Record<string, unknown>);

/** The editor's value back to the part's draft (what its checks and writer take). */
export const fromEditorValue = (entity: SiteEntity, part: string, value: Record<string, unknown>): unknown => (isListPart(entity, part) ? value[part] : value);
