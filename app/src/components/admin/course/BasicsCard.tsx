"use client";

import { useId } from "react";
import { COURSE_LANGUAGES, LIMITS, type CourseLanguage, type CourseLevel } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { Choice } from "../Choice";
import { I18nInput } from "../I18nInput";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import { UnpublishedTag } from "../UnpublishedTag";
import { Card } from "./Card";
import { CARD_ID } from "./course-view";
import { PlainField } from "./PlainField";
import type { PartApi } from "./types";

/**
 * „Põhiinfo“ (README B2): the name, the address, the level, the language, the short and the long text — the basics part (the type is the basics' too,
 * in the type card). The level and the language are instant; the texts save when typing stops or the card is left. On a published course a changed
 * address says that the old link stops working once it is published.
 */
export function BasicsCard({ api }: { api: PartApi<"basics"> }) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const v = api.fields;
  return (
    <Card id={CARD_ID.basics} title={t.sections.basics} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <div className={ed.grid}>
        <div className={ed.wide}>
          <I18nInput label={f.title} value={v.title} onChange={(x) => api.set("title", x)} maxLength={LIMITS.title} error={api.error("title")} name="title" unpublished={api.unpublished("title")} />
        </div>
        <div className={ed.wide}>
          <PlainField
            name="slug"
            label={f.slug}
            value={v.slug}
            onChange={(x) => api.set("slug", x)}
            hint={fill(f.slugHint, { slug: v.slug || "…" }) + (api.unpublished("slug") ? ` ${f.slugChanged}` : "")}
            error={api.error("slug")}
            maxLength={80}
            unpublished={api.unpublished("slug")}
          />
        </div>
        <fieldset className={ed.fieldset} aria-describedby={api.unpublished("level") ? `${uid}-level-unpublished` : undefined}>
          <legend className={ui.legend}>
            {f.level}
            {api.unpublished("level") && (
              <>
                {" "}
                <UnpublishedTag id={`${uid}-level-unpublished`} hidden />
              </>
            )}
          </legend>
          <div className={ed.choices}>
            {(["basic", "advanced"] as CourseLevel[]).map((l) => (
              <Choice key={l} className={ed.choice} label={adminEt.courses.level[l]} type="radio" name={`${uid}-level`} value={l} checked={v.level === l} onChange={() => api.commit("level", l)} />
            ))}
          </div>
        </fieldset>
        <div className={`${ui.field} ${ed.i18n}`} data-unpublished={api.unpublished("language") ? "" : undefined}>
          <div className={ed.i18nHead}>
            <label htmlFor={`${uid}-language`}>{f.language}</label>
            {api.unpublished("language") && <UnpublishedTag id={`${uid}-language-unpublished`} />}
          </div>
          <select
            id={`${uid}-language`}
            className={`${ui.input} ${ed.select}`}
            aria-describedby={api.unpublished("language") ? `${uid}-language-unpublished` : undefined}
            value={v.language}
            onChange={(e) => api.commit("language", e.target.value as CourseLanguage)}
            data-field="language"
          >
            {COURSE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className={ed.wide}>
          <I18nInput
            label={f.summary}
            value={v.summary}
            onChange={(x) => api.set("summary", x)}
            multiline
            rows={2}
            maxLength={LIMITS.summary}
            hint={f.summaryHint}
            error={api.error("summary")}
            name="summary"
            unpublished={api.unpublished("summary")}
          />
        </div>
        <div className={ed.wide}>
          <I18nInput
            label={f.body}
            value={v.body}
            onChange={(x) => api.set("body", x)}
            multiline
            rows={8}
            maxLength={LIMITS.body}
            hint={f.bodyHint}
            error={api.error("body")}
            name="body"
            unpublished={api.unpublished("body")}
          />
        </div>
      </div>
    </Card>
  );
}
