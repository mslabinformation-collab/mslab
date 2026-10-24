"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { useEditLang, type Lang } from "./EditLang";
import { UnpublishedTag } from "./UnpublishedTag";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

export type { Lang };

const hasRu = (v: I18n) => Boolean(v.ru && v.ru.trim());
/** An Estonian text without its Russian translation (an empty field is not "missing" anything yet). */
export const lacksRu = (v: I18n) => Boolean(v.et.trim()) && !hasRu(v);

/**
 * ET / RU switch of a preview (the popup's and the newsletter's): two pills, which show the preview in one language or the other. The page's
 * own switch, which sets the language of the fields, is `LangSwitch` in EditLang.tsx.
 */
export function PreviewLangSwitch({ lang, onChange, label, missingRu }: { lang: Lang; onChange: (l: Lang) => void; label: string; missingRu: boolean }) {
  const t = adminEt.i18n;
  return (
    <span className={styles.langs} role="group" aria-label={fill(t.switch, { label })} data-lang-switch="">
      {(["et", "ru"] as const).map((l) => (
        <button key={l} type="button" className={styles.lang} aria-pressed={lang === l} onClick={() => onChange(l)} data-lang={l}>
          {t.lang[l]}
          {l === "ru" && missingRu && <span className={styles.missing}>{t.missing}</span>}
        </button>
      ))}
    </span>
  );
}

type Props = {
  label: string;
  value: I18n;
  onChange: (value: I18n) => void;
  multiline?: boolean;
  rows?: number;
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
};

/**
 * A content field in two languages ({ et, ru? }): the Estonian text is the one the site always has; the Russian one is optional. The language
 * shown is the page's (EditLang.tsx: one switch in the page heading sets every field, README §1.9). In RU mode the Estonian text stands above the
 * input (it is also the placeholder: what the Russian page shows while the translation is missing), an empty RU field offers „Kopeeri eesti
 * keelest“, and „tõlge tulekul“ stays on the field. The field tells the page when its Russian text is missing, for „RU puudub {n} väljal“.
 */
export function I18nInput({ label, value, onChange, multiline, rows = 4, maxLength, hint, error, placeholder, labelHidden, name, unpublished }: Props) {
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
    [unpublished ? `${uid}-unpublished` : "", hint ? `${uid}-hint` : "", error ? `${uid}-error` : "", showMissing ? `${uid}-missing` : ""].filter(Boolean).join(" ") || undefined;
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
    "data-i18n": name,
    "data-lang-field": lang,
  } as const;

  return (
    <div ref={box} id={uid} className={styles.i18n} data-i18n-box="" data-unpublished={unpublished ? "" : undefined}>
      <div className={styles.i18nHead}>
        <label id={`${uid}-label`} htmlFor={inputId} className={labelHidden ? ui.sr : styles.label}>
          {label}
          <span className={ui.sr}> ({t.langName[lang]})</span>
        </label>
        {unpublished && <UnpublishedTag id={`${uid}-unpublished`} />}
        {pending && (
          <span className={styles.missing} data-ru-pending="">
            {t.missing}
          </span>
        )}
      </div>
      {ru && value.et.trim() && (
        <p className={styles.etRef} lang="et" data-et-ref="">
          <span className={styles.etTag} data-et-tag="">
            {t.etTag}
          </span>
          {value.et}
        </p>
      )}
      {multiline ? (
        <textarea {...common} className={ui.textarea} rows={rows} onChange={(e) => set(e.target.value)} />
      ) : (
        <input {...common} className={ui.input} type="text" autoComplete="off" onChange={(e) => set(e.target.value)} />
      )}
      {ru && pending && (
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
