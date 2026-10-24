"use client";

import type { CourseType } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { ProtocolStagesEditor } from "../ProtocolStagesEditor";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import type { PartApi } from "./types";

/**
 * „Protokolli punktid“ (README B2): a contact course's protocol headings, an e-course's practical points with their own texts (e-course completion,
 * spec §5.1). ProtocolStagesEditor; rows added, moved, removed or brought back save now, through the part's update.
 */
export function StagesCard({ api, type }: { api: PartApi<"protocolStages">; type: CourseType }) {
  const t = adminEt.courseEditor;
  const online = type === "e_learning";
  const items = api.fields.protocolStages;
  return (
    <Card id={CARD_ID.protocolStages} label={t.sections.protocolStages} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <ProtocolStagesEditor
        items={items}
        onChange={(v) => (listChange(items, v) === "instant" ? api.commit("protocolStages", v) : api.set("protocolStages", v))}
        onUpdate={(fn) => api.update("protocolStages", fn)}
        unpublished={api.unpublished("protocolStages")}
        error={api.error("protocolStages")}
        hint={online ? t.fields.protocolStagesHintOnline : undefined}
        empty={online ? t.fields.protocolStagesEmptyOnline : undefined}
      />
    </Card>
  );
}
