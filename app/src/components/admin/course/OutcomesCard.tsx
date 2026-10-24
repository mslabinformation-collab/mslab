"use client";

import { LIMITS } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { ListEditor } from "../ListEditor";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import type { PartApi } from "./types";

/**
 * „Õpiväljundid“ (README B2): the outcomes list (ListEditor: drag and ↑ / ↓, × with the UndoBar). A row added, moved, removed or brought back saves
 * now, through the part's update (the form on screen when it lands: an undo pressed after the cards started over goes to the fresh form); a row's
 * text when typing stops.
 */
export function OutcomesCard({ api }: { api: PartApi<"outcomes"> }) {
  const t = adminEt.courseEditor;
  const items = api.fields.outcomes;
  return (
    <Card id={CARD_ID.outcomes} label={t.sections.outcomes} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <ListEditor
        title={t.sections.outcomes}
        itemLabel={t.fields.outcomes}
        hint={t.fields.outcomesHint}
        items={items}
        onChange={(v) => (listChange(items, v) === "instant" ? api.commit("outcomes", v) : api.set("outcomes", v))}
        onUpdate={(fn) => api.update("outcomes", fn)}
        unpublished={api.unpublished("outcomes")}
        error={api.error("outcomes")}
        maxLength={LIMITS.item}
        multiline
        name="outcomes"
      />
    </Card>
  );
}
