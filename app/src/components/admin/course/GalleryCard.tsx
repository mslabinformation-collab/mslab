"use client";

import { adminEt } from "@/i18n/dict/admin";
import { GalleryEditor } from "../GalleryEditor";
import { Card } from "./Card";
import { CARD_ID } from "./course-view";
import type { PartApi } from "./types";

/**
 * „Galerii“ (README B2): the course's pictures (GalleryEditor, as it is until Task 8). A picture uploaded, moved or removed saves now (an upload's
 * reference is instant, README §1.3); a description when typing stops or the card is left. An upload that ends after other changes adds to the list as
 * it is then.
 */
export function GalleryCard({ api }: { api: PartApi<"gallery"> }) {
  const t = adminEt.courseEditor;
  return (
    <Card id={CARD_ID.gallery} title={t.sections.gallery} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <GalleryEditor images={api.fields.images} onChange={(update) => api.update("images", update)} error={api.error("images")} hint={t.fields.galleryHint} />
    </Card>
  );
}
