"use client";

import Link from "next/link";
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
import type { AreaOption, PartApi } from "./types";

/**
 * „Valdkond“ (course areas, spec 2026-11-11 §4.2): „Määramata“ first, then Seaded → Valdkonnad's areas in Maria's order, instant as the language; its
 * hint (`hintId`, under the row it shares with the language: UX pass 11.11 A4) says what it is for and where the list is kept. An area deleted since
 * the page was read is refused by the save (`area`), said under it. A stored area the list no longer has (none can be: Seaded keeps an area a course or
 * a draft uses) reads as „Määramata“.
 */
function AreaSelect({ api, areas, uid, hintId }: { api: PartApi<"basics">; areas: readonly AreaOption[]; uid: string; hintId: string }) {
  const f = adminEt.courseEditor.fields;
  const id = `${uid}-area`;
  const unpublished = api.unpublished("areaId");
  const error = api.error("areaId");
  const known = api.fields.areaId !== null && areas.some((a) => a.id === api.fields.areaId);
  const describedBy = [unpublished ? `${id}-unpublished` : "", hintId, error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className={`${ui.field} ${ed.i18n}`} data-unpublished={unpublished ? "" : undefined}>
      <div className={ed.i18nHead}>
        <label htmlFor={id}>{f.area}</label>
        {unpublished && <UnpublishedTag id={`${id}-unpublished`} />}
      </div>
      <select
        id={id}
        className={`${ui.input} ${ed.select}`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        value={known ? String(api.fields.areaId) : ""}
        onChange={(e) => api.commit("areaId", e.target.value === "" ? null : Number(e.target.value))}
        data-field="areaId"
      >
        <option value="">{f.areaNone}</option>
        {areas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${id}-error`} className={ui.error}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * „Põhiinfo“ (README B2): the name, the address, the level, the language, the short and the long text — the basics part (the type is the basics' too,
 * in the type card). The level and the language are instant; the texts save when typing stops or the card is left. On a published course a changed
 * address says that the old link stops working once it is published. „Valdkond“ (course areas, spec 2026-11-11 §4.2): AreaSelect. UX pass 11.11 A4 (the
 * Kursus board): the level on a row of its own, then „Koolituse keel“ and „Valdkond“ side by side (one under the other where the card is narrow), the
 * area's hint under them across the card with its link to Seaded → Valdkonnad.
 */
export function BasicsCard({ api, areas }: { api: PartApi<"basics">; areas: readonly AreaOption[] }) {
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
        <fieldset className={`${ed.fieldset} ${ed.wide}`} aria-describedby={api.unpublished("level") ? `${uid}-level-unpublished` : undefined}>
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
        <div className={`${ed.wide} ${ed.pair}`} data-basics-pair="">
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
        <AreaSelect api={api} areas={areas} uid={uid} hintId={`${uid}-area-hint`} />
        </div>
        <p id={`${uid}-area-hint`} className={`${ui.hint} ${ed.wide} ${ed.pairHint}`} data-area-hint="">
          {f.areaHint}{" "}
          <Link className={ed.hintLink} href="/admin/seaded#valdkonnad">
            {f.areaLink}
          </Link>
          .
        </p>
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
