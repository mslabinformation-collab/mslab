"use client";

import { useId } from "react";
import { LIMITS, type CourseType } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { Choice } from "../Choice";
import { I18nInput } from "../I18nInput";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import styles from "../CourseEditor.module.css";
import { UnpublishedTag } from "../UnpublishedTag";
import { Card } from "./Card";
import { CARD_ID } from "./course-view";
import { PlainField } from "./PlainField";
import type { PartApi } from "./types";

/**
 * „Õppevorm ja hind“ (README B2): „Õppevorm“ (the basics part's type, instant) and the price part's fields of that type — an e-course's price, access,
 * videos and next-course discount, a contact course's group and individual price and duration. The cards follow the type at once (a published
 * course: the drafted one). A course with sessions, registrations, lessons or access keeps its type (`locked`, the server refuses it too).
 * `priceMissing`: the price a published course must have is not there (the publish held it, S3-P3-b, or the „Avaldatud“ switch was refused): the
 * field says so (ADM:12).
 */
export function TypeCard({
  basics,
  price,
  locked,
  liveType,
  priceMissing,
}: {
  basics: PartApi<"basics">;
  price: PartApi<"price">;
  locked: boolean;
  liveType: CourseType;
  priceMissing: boolean;
}) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const type = basics.fields.type;
  const online = type === "e_learning";
  const v = price.fields;
  const typeError = basics.error("type");
  const required = priceMissing ? t.errors.priceRequired : undefined;
  const plain = (name: "price" | "accessMonths" | "videoCount" | "priceGroup" | "priceIndividual", label: string, opts: { hint?: string; inputMode: "decimal" | "numeric"; maxLength?: number }) => (
    <PlainField
      name={name}
      label={label}
      value={v[name]}
      onChange={(x) => price.set(name, x)}
      error={price.error(name) ?? (name === (online ? "price" : "priceGroup") ? required : undefined)}
      unpublished={price.unpublished(name)}
      {...opts}
    />
  );
  return (
    <Card
      id={CARD_ID.price}
      title={t.sections.type}
      onLeave={() => {
        price.flush();
        basics.flush();
      }}
      // the type is the basics part's: its conflict is offered here too, where the radio is (review M-5)
      conflict={price.conflict || basics.conflict}
      onRestore={() => {
        if (price.conflict) price.restore();
        if (basics.conflict) basics.restore();
      }}
      data-type-section={type}
    >
      <fieldset
        className={`${ed.fieldset} ${styles.typeSwitch}`}
        aria-describedby={[basics.unpublished("type") ? `${uid}-type-unpublished` : "", `${uid}-type-hint`, typeError ? `${uid}-type-error` : ""].filter(Boolean).join(" ")}
        data-invalid={typeError ? "" : undefined}
      >
        <legend className={ui.legend}>
          {f.type}
          {basics.unpublished("type") && (
            <>
              {" "}
              <UnpublishedTag id={`${uid}-type-unpublished`} hidden />
            </>
          )}
        </legend>
        <div className={ed.choices} data-type-switch="">
          {(["e_learning", "contact"] as CourseType[]).map((ty) => (
            <Choice
              key={ty}
              className={ed.choice}
              label={adminEt.courses.type[ty]}
              type="radio"
              name={`${uid}-type`}
              value={ty}
              checked={type === ty}
              // a course with sessions, registrations, lessons or access keeps its type (the server refuses the change too)
              disabled={locked && liveType !== ty}
              onChange={() => basics.commit("type", ty)}
              data-field={type === ty ? "type" : undefined}
            />
          ))}
        </div>
        <p id={`${uid}-type-hint`} className={ui.hint} data-type-hint="">
          {locked ? (liveType === "e_learning" ? t.typeLockedOnline : t.errors.typeLocked) : f.typeHint}
        </p>
        {typeError && (
          <p id={`${uid}-type-error`} className={ui.error}>
            {typeError}
          </p>
        )}
      </fieldset>
      {online ? (
        <div className={ed.grid} data-fields="e_learning">
          {plain("price", f.price, { inputMode: "decimal" })}
          {plain("accessMonths", f.accessMonths, { inputMode: "numeric", maxLength: 4 })}
          {plain("videoCount", f.videoCount, { inputMode: "numeric", maxLength: 4 })}
          <div className={ed.wide}>
            <I18nInput
              label={f.nextDiscount}
              value={v.nextDiscount}
              onChange={(x) => price.set("nextDiscount", x)}
              maxLength={LIMITS.discount}
              hint={f.nextDiscountHint}
              error={price.error("nextDiscount")}
              name="nextDiscount"
              unpublished={price.unpublished("nextDiscount")}
            />
          </div>
        </div>
      ) : (
        <div className={ed.grid} data-fields="contact">
          {plain("priceGroup", f.priceGroup, { inputMode: "decimal", hint: f.priceGroupHint })}
          {plain("priceIndividual", f.priceIndividual, { inputMode: "decimal", hint: f.priceIndividualHint })}
          <div className={ed.wide}>
            <I18nInput
              label={f.durationLabel}
              value={v.durationLabel}
              onChange={(x) => price.set("durationLabel", x)}
              maxLength={LIMITS.duration}
              hint={f.durationHint}
              error={price.error("durationLabel")}
              name="durationLabel"
              unpublished={price.unpublished("durationLabel")}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
