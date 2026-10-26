"use client";

import { useId, type HTMLInputTypeAttribute } from "react";
import { UnpublishedTag } from "./UnpublishedTag";
import ui from "./ui.module.css";
import ed from "./editor.module.css";

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  type?: HTMLInputTypeAttribute;
  inputMode?: "text" | "decimal" | "numeric" | "email" | "tel" | "url";
  autoComplete?: string;
  maxLength?: number;
  placeholder?: string;
  /** A datalist of suggestions (links). */
  suggestions?: string[];
  /** data-field attribute (tests, the first-error focus). */
  name?: string;
  className?: string;
  /** The label for screen readers only (Koolitaja's number pairs, which the card's title names). */
  labelHidden?: boolean;
  /**
   * The field of a site editor's draft (Avaleht's slide link, piece 4a): given, the field is drawn as the two-language fields are (I18nInput), and
   * true, its value waits for „Avalda muudatused“ — „· avaldamata“ after the label and the border in #9e8993 (README §1.8). Not given: as before.
   */
  unpublished?: boolean;
};

/** A one-language text field with its label, hint and error (names, amounts, links, e-mail, phone). */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  type = "text",
  inputMode,
  autoComplete = "off",
  maxLength,
  placeholder,
  suggestions,
  name,
  className,
  labelHidden,
  unpublished,
}: Props) {
  const id = useId();
  const describedBy = [unpublished ? `${id}-unpublished` : "", hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const drafted = unpublished !== undefined;
  const own = (
    <label htmlFor={id} className={labelHidden ? ui.sr : undefined}>
      {label}
    </label>
  );
  return (
    <div className={[ui.field, drafted ? ed.i18n : "", className ?? ""].filter(Boolean).join(" ")} data-unpublished={unpublished ? "" : undefined}>
      {drafted ? (
        <div className={ed.i18nHead}>
          {own}
          {unpublished && <UnpublishedTag id={`${id}-unpublished`} />}
        </div>
      ) : (
        own
      )}
      <input
        id={id}
        className={ui.input}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        list={suggestions?.length ? `${id}-list` : undefined}
        data-field={name}
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={`${id}-list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {hint && (
        <p id={`${id}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={ui.error}>
          {error}
        </p>
      )}
    </div>
  );
}
