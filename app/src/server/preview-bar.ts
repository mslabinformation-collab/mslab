import type { Q } from "@/db/client";
import type { PreviewBarProps, PreviewBarTexts, PreviewLabelTexts } from "@/components/site/PreviewBar";
import { SITE_ENTITY_ID, type SiteEntity } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { previewChangeCount } from "./course-parts";
import { siteChangeCount } from "./site-preview";

// What the preview bars of the public pages need (admin UX pass piece 3a, Task 6 review; components/site/PreviewBar.tsx). The course page's: its discard
// route and copies, how many changes wait, the way out, and the bar's words, which are the admin's (Estonian whatever the page's language): the
// PublishBar's count, „Loobu muudatustest“ and its question (adminEt.publish), the preview's own way out „Lõpeta eelvaade“ (Dim 24.10, D-1:
// adminEt.publish.previewExit), and a failed discard's words (the PublishBar's, D-2: „Muudatustest loobumine ei õnnestunud. Proovi uuesti.“, or „Logi
// uuesti sisse.“ for an ended session). The site pages' (piece 4a, Task 3, R-f): the same bar and words for the page's entity (home, trainer, practice),
// with its own discard route (R-e) and copies. The catalogue's (D-4): „Eelvaade“ (adminEt.publish.phonePreview, the phone bar's same word) and the same
// way out, nothing to discard.
// A page loads this module only for a request that is the admin's preview (server/preview.ts previewActive), so the dictionary and the draft layer
// never touch a visitor's render: the bars (components/site/PreviewBar.tsx) get their words as props.

/** The way out of the preview: draft mode off, back to `path` as a visitor sees it (api/admin/eelvaade?lopeta=1&tee=<path>). */
const exitOf = (path: string) => `/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(path)}`;

/** The bar's words for `count` changes (the course's and the site pages' alike). */
function barTexts(count: number): PreviewBarTexts {
  const t = adminEt.publish;
  return {
    count: fill(t.phoneCount, { n: count }),
    exit: t.previewExit,
    discard: t.discard,
    question: fill(t.confirm, { n: count }),
    yes: t.confirmYes,
    // a discard that failed (Dim 24.10, D-2: the PublishBar's words)
    failed: t.discardFailed,
    signedOut: adminEt.leave.reasons.signedOut,
  };
}

/**
 * The course page's bar. `path`: this page's path as the visitor sees it (with the locale prefix of the Russian page): the way out returns to it, with
 * draft mode off (api/admin/eelvaade?lopeta=1&tee=<path>).
 */
export async function previewBarProps(db: Q, courseId: number, path: string): Promise<PreviewBarProps> {
  const count = await previewChangeCount(db, courseId);
  return { discardHref: `/api/admin/koolitus/${courseId}/loobu`, copies: { course: courseId }, count, exitHref: exitOf(path), t: barTexts(count) };
}

/**
 * A site page's bar (R-f): the entity the page is the public page of (the home page → home, /koolitaja → trainer, /praktika → practice), its changes'
 * count (site-preview.ts siteChangeCount: what its PublishBar counts), „Loobu muudatustest“ through its discard route with this browser's copies of it
 * (POST api/admin/sisu/<entity>/0/loobu: every draft of the entity, R-e), and the way out to `path` (as previewBarProps).
 */
export async function sitePreviewBarProps(db: Q, entity: SiteEntity, path: string): Promise<PreviewBarProps> {
  const count = await siteChangeCount(db, entity);
  return { discardHref: `/api/admin/sisu/${entity}/${SITE_ENTITY_ID}/loobu`, copies: { site: entity }, count, exitHref: exitOf(path), t: barTexts(count) };
}

/** The catalogue's bar (D-4): „Eelvaade“ and the way out to `path` (this catalogue page as the visitor sees it, with the Russian page's prefix). */
export function catalogueBarProps(path: string): { exitHref: string; t: PreviewLabelTexts } {
  const t = adminEt.publish;
  return { exitHref: exitOf(path), t: { label: t.phonePreview, exit: t.previewExit } };
}
