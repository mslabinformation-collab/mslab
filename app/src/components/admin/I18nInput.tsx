"use client";

import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { useEditLang, type Lang } from "./EditLang";
import { GrowingText } from "./GrowingText";
import { UnpublishedTag } from "./UnpublishedTag";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

export type { Lang };

/** A text with its Russian translation. */
export const hasRu = (v: I18n) => Boolean(v.ru && v.ru.trim());
/** An Estonian text without its Russian translation (an empty field is not "missing" anything yet). */
export const lacksRu = (v: I18n) => Boolean(v.et.trim()) && !hasRu(v);

/** What a field's `ref` can do (piece 3b, Task 5: the legal texts' placeholder chips). */
export type I18nInputHandle = {
  /**
   * Puts `text` where the cursor is in the language shown — over the selection, the cursor after it — and the focus back in the field; at the end of the
   * text when the field has not had the cursor in this language. The change goes through `onChange`, as typing does.
   */
  insert(text: string): void;
};

type Props = {
  label: string;
  value: I18n;
  onChange: (value: I18n) => void;
  multiline?: boolean;
  rows?: number;
  /** A multiline field whose box grows with its text, so a long one is read without a scrollbar of its own (GrowingText; the list rows). */
  grow?: boolean;
  maxLength?: number;
  hint?: string;
  error?: string;
  placeholder?: string;
  /** The label only for screen readers (list rows). */
  labelHidden?: boolean;
  /** data-i18n attribute (tests, the first-error focus). */
  name?: string;
  /**
   * The field's text waits for „Avalda muudatused“ (a published thing's draft differs from live, README §1.8): „· avaldamata“ after the label (in
   * #6b4f5c, the token --warn) and the field's border in #9e8993 (--rose). It is the field's description too, not part of its name.
   */
  unpublished?: boolean;
  /** More of the field's description, by element id (a list row's own tag beside the field, the modules card's „avaldamata“). */
  describedBy?: string;
  /** The text can be read and selected, not changed (a publish of it is on its way). */
  readOnly?: boolean;
  /** insert() at the cursor (I18nInputHandle). */
  ref?: Ref<I18nInputHandle>;
};

/**
 * A content field in two languages ({ et, ru? }): the Estonian text is the one the site always has; the Russian one is optional. The language
 * shown is the page's (EditLang.tsx: one switch in the page heading sets every field, README §1.9). In RU mode the Estonian text stands above the
 * input (it is also the placeholder: what the Russian page shows while the translation is missing), an empty RU field offers „Kopeeri eesti
 * keelest“, and „tõlge tulekul“ stays on the field. The field tells the page when its Russian text is missing, for „RU puudub {n} väljal“.
 */
export function I18nInput({ label, value, onChange, multiline, rows = 4, grow, maxLength, hint, error, placeholder, labelHidden, name, unpublished, describedBy: more, readOnly, ref }: Props) {
  const uid = useId();
  const { lang, register } = useEditLang();
  const t = adminEt.i18n;
  const box = useRef<HTMLDivElement>(null);
  const inputId = `${uid}-${lang}`;
  const ru = lang === "ru";
  const pending = lacksRu(value);
  // the "missing translation" line under the field (list rows have no room for it: they have the tag and the copy link)
  const showMissing = ru && pending && !labelHidden;
  const describedBy =
    [unpublished ? `${uid}-unpublished` : "", more ?? "", hint ? `${uid}-hint` : "", error ? `${uid}-error` : "", showMissing ? `${uid}-missing` : ""].filter(Boolean).join(" ") || undefined;
  const text = (ru ? value.ru : value.et) ?? "";
  const set = (v: string) => onChange(ru ? { ...value, ru: v } : { ...value, et: v });

  const input = useCallback(() => box.current?.querySelector<HTMLElement>("[data-lang-field]") ?? null, []);
  /** „Järgmine →“: the cursor in the field, and the field in the middle of the screen. */
  const focusField = useCallback(() => {
    const el = input();
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "center" });
  }, [input]);
  useEffect(() => register(uid, pending, focusField), [register, uid, pending, focusField]);
  // insert(): the language the cursor was last put in (a field without the focus that never had it in the language shown takes the text at its end),
  // and where the cursor goes once the field shows the new text
  const cursorLang = useRef<Lang | null>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = caret.current;
    if (at === null) return;
    caret.current = null;
    const el = input() as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
  });
  useImperativeHandle(
    ref,
    () => ({
      insert(piece: string) {
        const el = input() as HTMLInputElement | HTMLTextAreaElement | null;
        const clamp = (n: number | null | undefined) => Math.min(Math.max(n ?? text.length, 0), text.length);
        // (the cursor is the field's while it has the focus — a chip's press keeps it there — or since it was last put there in this language)
        const here = el !== null && (document.activeElement === el || cursorLang.current === lang);
        const start = here ? clamp(el.selectionStart) : text.length;
        const end = here ? Math.max(start, clamp(el.selectionEnd)) : text.length;
        cursorLang.current = lang;
        caret.current = start + piece.length;
        set(text.slice(0, start) + piece + text.slice(end));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `set` is made from the same `value`, `lang` and `onChange`
    [text, lang, value, onChange, input],
  );
  const copy = () => {
    onChange({ ...value, ru: value.et });
    input()?.focus(); // (the link is gone with the copy: the cursor goes to the text, ready to be edited)
  };

  const common = {
    id: inputId,
    value: text,
    maxLength,
    placeholder: ru ? value.et || placeholder : placeholder,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    lang,
    readOnly,
    onFocus: () => void (cursorLang.current = lang),
    "data-i18n": name,
    "data-lang-field": lang,
  } as const;

  const labelEl = (
    <label id={`${uid}-label`} htmlFor={inputId} className={labelHidden ? ui.sr : styles.label}>
      {label}
      <span className={ui.sr}> ({t.langName[lang]})</span>
    </label>
  );

  return (
    <div ref={box} id={uid} className={styles.i18n} data-i18n-box="" data-unpublished={unpublished ? "" : undefined}>
      {/* a label for screen readers only and nothing beside it (a list row's field): no head line, so the field starts at the box's top and lines up
          with its row's handle, number and buttons (admin polish F1) */}
      {labelHidden && !unpublished && !pending ? (
        labelEl
      ) : (
        <div className={styles.i18nHead}>
          {labelEl}
          {unpublished && <UnpublishedTag id={`${uid}-unpublished`} />}
          {pending && (
            <span className={styles.missing} data-ru-pending="">
              {t.missing}
            </span>
          )}
        </div>
      )}
      {ru && value.et.trim() && (
        <p className={styles.etRef} lang="et" data-et-ref="">
          <span className={styles.etTag} data-et-tag="">
            {t.etTag}
          </span>
          {value.et}
        </p>
      )}
      {multiline && grow ? (
        <GrowingText {...common} className={ui.textarea} rows={rows} onChange={(e) => set(e.target.value)} />
      ) : multiline ? (
        <textarea {...common} className={ui.textarea} rows={rows} onChange={(e) => set(e.target.value)} />
      ) : (
        <input {...common} className={ui.input} type="text" autoComplete="off" onChange={(e) => set(e.target.value)} />
      )}
      {ru && pending && !readOnly && (
        <button type="button" className={styles.copy} onClick={copy} aria-describedby={`${uid}-label`} data-copy-et="">
          {t.copyFromEt}
        </button>
      )}
      {hint && (
        <p id={`${uid}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {showMissing && (
        <p id={`${uid}-missing`} className={ui.hint}>
          {t.missingHint}
        </p>
      )}
      {error && (
        <p id={`${uid}-error`} className={ui.error}>
          {error}
        </p>
      )}
    </div>
  );
}
