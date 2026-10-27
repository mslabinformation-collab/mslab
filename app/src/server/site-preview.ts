import type { Q } from "@/db/client";
import { siteChangeLabels } from "@/domain/site-changes";
import { siteRowOf, type SiteTarget } from "@/domain/site-entities";
import { readDrafts } from "./drafts";
import { partsOf, readSiteEditor, strictDraft } from "./site-drafts";

// The admin's draft preview of the site content (admin UX pass piece 4a, Task 3; ruling R-f; README §1.8 „Eelvaade ↗“): in draft mode with a live
// admin session (server/preview.ts previewActive), the public home page, /koolitaja and /praktika show the drafts of the entities home, trainer and
// practice (server/site-drafts.ts) laid over their live data, as „Avalda muudatused“ would store them. Only a page reader that the page has told so
// (db/queries/public.ts `{ drafts }`, after previewActive) loads this module; every visitor, and the static render, reads live and never touches the
// draft layer. The footer (the site layout, cached with "nothing depends on the request") always shows live values.

/**
 * `live` (a public reader's data) with `entity`'s drafts laid over it, as the course page's withCourseDrafts lays a course's (server/course-parts.ts):
 * - each drafted part goes through its STRICT check, as at the publish (server/site-drafts.ts strictDraft: the draft read defensively, Part.check);
 * - a part that passes is handed to `pick` as the stored value the publish makes of it (Write.shown: what the part's `read` answers then, e.g. a
 *   package's row with the price in cents, the hero slides in their new order with every slide, shown or not; a new row's id a placeholder below 0);
 * - a part that fails (an empty price, a new slide without its picture), and every part without a draft, is left out of `parts`: `pick` keeps live
 *   there (it closes over `live`). With no part to lay over, `live` itself comes back and `pick` is not called.
 * Drafts of a part the entity no longer has (a package deleted meanwhile) are left out. Changed live meanwhile is not checked: the preview shows the
 * draft, as the course's does (the publish holds such a part back and says so).
 */
export async function withSiteDrafts<T>(db: Q, target: SiteTarget, live: T, pick: (parts: Record<string, unknown>) => T): Promise<T> {
  const { entity, id } = siteRowOf(target);
  const drafts = await readDrafts(db, entity, id);
  if (drafts.length === 0) return live;
  const parts = await partsOf(db, target);
  const shown: Record<string, unknown> = {};
  for (const draft of drafts) {
    const def = Object.hasOwn(parts, draft.part) ? parts[draft.part] : undefined;
    if (!def) continue;
    const stored = await def.read(db);
    const { check, write } = strictDraft(entity, draft.part, def, stored, draft.value);
    if (check.ok && write?.shown) shown[draft.part] = write.shown(stored);
  }
  return Object.keys(shown).length > 0 ? pick(shown) : live;
}

/**
 * The number the site page's preview bar says, „Avaldamata {n}“ (components/site/PreviewBar.tsx): how many changes the entity's PublishBar names
 * (domain/site-changes.ts siteChangeLabels over every part's draft against live, as components/admin/site/SiteEditorPage.tsx counts them). 0 without
 * drafts.
 */
export async function siteChangeCount(db: Q, target: SiteTarget): Promise<number> {
  const { parts } = await readSiteEditor(db, target);
  return siteChangeLabels(siteRowOf(target).entity,Object.entries(parts).map(([part, s]) => ({ part, live: s.live, draft: s.value }))).length;
}
