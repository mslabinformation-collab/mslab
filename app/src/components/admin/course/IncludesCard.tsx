"use client";

import { LIMITS } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { ListEditor } from "../ListEditor";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import type { PartApi } from "./types";

/** „Koolitus sisaldab“ (a contact course's card, README B2): ListEditor. Rows added, moved, removed or brought back save now, through the part's update. */
export function IncludesCard({ api }: { api: PartApi<"includes"> }) {
  const t = adminEt.courseEditor;
  const items = api.fields.includes;
  return (
    <Card id={CARD_ID.includes} label={t.sections.includes} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <ListEditor
        title={t.sections.includes}
        itemLabel={t.fields.includes}
        hint={t.fields.includesHint}
        items={items}
        onChange={(v) => (listChange(items, v) === "instant" ? api.commit("includes", v) : api.set("includes", v))}
        onUpdate={(fn) => api.update("includes", fn)}
        unpublished={api.unpublished("includes")}
        error={api.error("includes")}
        maxLength={LIMITS.item}
        multiline
        name="includes"
      />
    </Card>
  );
}
