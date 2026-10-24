"use client";

import { adminEt } from "@/i18n/dict/admin";
import { GalleryEditor } from "../GalleryEditor";
import { Card } from "./Card";
import { CARD_ID } from "./course-view";
import type { PartApi } from "./types";

/**
 * „Galerii“ (README B2): the course's pictures (GalleryEditor: drag and ↑ / ↓, × with the UndoBar). A picture uploaded, moved, removed or brought
 * back saves now (an upload's reference is instant, README §1.3); a description when typing stops or the card is left. Every change goes through the
 * part's update, to the list as it is when it lands (an upload that ends after other changes, an undo pressed after the cards started over).
 */
export function GalleryCard({ api }: { api: PartApi<"gallery"> }) {
  const t = adminEt.courseEditor;
  return (
    <Card id={CARD_ID.gallery} title={t.sections.gallery} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore} unpublished={api.unpublished("images")}>
      <GalleryEditor images={api.fields.images} onChange={(update) => api.update("images", update)} error={api.error("images")} hint={t.fields.galleryHint} />
    </Card>
  );
}
