"use client";

import { LIMITS } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { ListEditor } from "../ListEditor";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import type { PartApi } from "./types";

/** „Õpiväljundid“ (README B2): the outcomes list (ListEditor, as it is until Task 8). A row added, removed or moved saves now; a row's text when typing stops. */
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
        error={api.error("outcomes")}
        maxLength={LIMITS.item}
        multiline
        name="outcomes"
      />
    </Card>
  );
}
