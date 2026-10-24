"use client";

import type { CourseCardData } from "@/components/site/CourseCard";
import type { Badge } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { BadgeEditor } from "../BadgeEditor";
import { Card } from "./Card";
import { CARD_ID } from "./course-view";
import type { PartApi } from "./types";

/** A quick label, a colour or „Puudub“ is a pick (saved now); an own text is typed (saved when typing stops or the card is left). */
function picked(before: Badge, after: Badge): boolean {
  if (!before || !after) return true;
  if (before.bg !== after.bg) return true;
  return before.label.et !== after.label.et && (before.label.ru ?? "") !== (after.label.ru ?? "");
}

/**
 * „Koolituse märgis“ (README B2, the side column; prototype D): BadgeEditor as it is, with the course's card as the catalogue would show it (`card`,
 * from the cards' fields as they are now).
 */
export function BadgeCard({ api, card }: { api: PartApi<"badge">; card: CourseCardData }) {
  const value = api.fields.badge;
  return (
    <Card id={CARD_ID.badge} label={adminEt.badge.title} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <BadgeEditor value={value} onChange={(b) => (picked(value, b) ? api.commit("badge", b) : api.set("badge", b))} card={card} error={api.error("badge")} />
    </Card>
  );
}
