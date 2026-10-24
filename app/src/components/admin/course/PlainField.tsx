"use client";

import { useId } from "react";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import { UnpublishedTag } from "../UnpublishedTag";

/**
 * A one-language text field of a course card (the address, the prices, the counts, the certificate's volume) with its label, hint and error, the
 * same markup as the old editor's (`data-field` is the field's name: the tests and the focus of „Näita“ and „Jää siia“ find it by it). `unpublished`:
 * a published course's draft differs from live here — „· avaldamata“ after the label and the accent border (README §1.8).
 */
export function PlainField({
  name,
  label,
  value,
  onChange,
  error,
  hint,
  inputMode,
  maxLength = 40,
  unpublished,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  inputMode?: "decimal" | "numeric";
  maxLength?: number;
  unpublished?: boolean;
}) {
  const id = `${useId()}-${name}`;
  const describedBy = [unpublished ? `${id}-unpublished` : "", hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`${ui.field} ${ed.i18n}`} data-plain-field="" data-unpublished={unpublished ? "" : undefined}>
      <div className={ed.i18nHead}>
        <label htmlFor={id}>{label}</label>
        {unpublished && <UnpublishedTag id={`${id}-unpublished`} />}
      </div>
      <input
        id={id}
        className={ui.input}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        data-field={name}
      />
      {hint && (
        <p id={`${id}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={ui.error} data-field-error="">
          {error}
        </p>
      )}
    </div>
  );
}
