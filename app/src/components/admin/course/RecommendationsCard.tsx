"use client";

import { useState } from "react";
import { LIMITS } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { Choice } from "../Choice";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import { Card } from "./Card";
import { CARD_ID } from "./course-view";
import type { OtherCourse, PartApi } from "./types";

/** „Soovitused“ (README B2): up to three other courses for the end of this course's page; a tick saves now. */
export function RecommendationsCard({ api, others }: { api: PartApi<"recommendations">; others: OtherCourse[] }) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const [note, setNote] = useState(false);
  const ids = api.fields.recommendationIds;
  const error = api.error("recommendationIds");
  const toggle = (id: number) => {
    const has = ids.includes(id);
    if (!has && ids.length >= LIMITS.recommendations) return setNote(true);
    setNote(false);
    api.commit("recommendationIds", has ? ids.filter((x) => x !== id) : [...ids, id]);
  };
  return (
    <Card id={CARD_ID.recommendations} title={t.sections.recommendations} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <fieldset className={ed.fieldset} data-recommendations="" data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined} data-field={error ? "recommendationIds" : undefined}>
        <legend className={ui.sr}>{t.sections.recommendations}</legend>
        <p className={ui.hint}>{f.recommendationsHint}</p>
        <ul className={ed.picks}>
          {others.map((c) => (
            <li key={c.id}>
              <Choice
                className={ed.pick}
                label={c.title}
                labelClassName={ed.pickName}
                type="checkbox"
                value={c.id}
                checked={ids.includes(c.id)}
                onChange={() => toggle(c.id)}
                data-recommend={c.id}
              >
                <span className={ed.pickTags}>
                  <span className={`${ui.tag} ${c.type === "e_learning" ? ui.dark : ""}`}>{adminEt.courses.type[c.type]}</span>
                  {!c.published && <span className={`${ui.tag} ${ui.warn}`}>{adminEt.courses.draft}</span>}
                </span>
              </Choice>
            </li>
          ))}
        </ul>
        <p role="status" className={note || error ? ui.error : ui.hint}>
          {note || error ? f.recommendationsMax : fill(f.recommendationsCount, { n: ids.length })}
        </p>
      </fieldset>
    </Card>
  );
}
