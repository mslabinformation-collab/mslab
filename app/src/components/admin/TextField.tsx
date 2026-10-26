"use client";

import { useId, type HTMLInputTypeAttribute } from "react";
import ui from "./ui.module.css";

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
};

/** A one-language text field with its label, hint and error (names, amounts, links, e-mail, phone). */
export function TextField({ label, value, onChange, hint, error, type = "text", inputMode, autoComplete = "off", maxLength, placeholder, suggestions, name, className, labelHidden }: Props) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`${ui.field} ${className ?? ""}`}>
      <label htmlFor={id} className={labelHidden ? ui.sr : undefined}>
        {label}
      </label>
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
