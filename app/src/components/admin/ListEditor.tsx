"use client";

import { useEffect, useId, useRef, useState } from "react";
import { moveItem } from "@/domain/course-editor";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { I18nInput } from "./I18nInput";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

let rowCount = 0;
const newKey = () => `row-${++rowCount}`;

type Props = {
  /** The heading of the list. */
  title: string;
  /** The label of one row, numbered: "Õpiväljund 2". */
  itemLabel: string;
  items: I18n[];
  onChange: (items: I18n[]) => void;
  hint?: string;
  error?: string;
  multiline?: boolean;
  maxLength?: number;
  /** data-list-editor attribute. */
  name: string;
};

/**
 * An ordered list of texts in two languages (outcomes, programme, "Koolitus sisaldab"): add, remove, ↑ / ↓. The rows take the page's
 * language (EditLang.tsx: the one ET | RU switch in the page heading). The arrows are aria-disabled at the ends (a disabled button would
 * drop the focus); after adding a row its field gets the focus, after removing one the next row's field (or "Lisa rida") does.
 */
export function ListEditor({ title, itemLabel, items, onChange, hint, error, multiline, maxLength, name }: Props) {
  const t = adminEt.list;
  const uid = useId();
  const [keys, setKeys] = useState<string[]>(() => items.map(newKey));
  // the list was replaced from outside (the editor reloads the saved course): new rows, new keys
  if (keys.length !== items.length) setKeys(items.map(newKey));
  // where the focus goes after the next render (a row's field after add / remove, or "Lisa rida")
  const focus = useRef<number | "add" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") addBtn.current?.focus();
    else root.current?.querySelector<HTMLElement>(`[data-row="${target}"] [data-lang-field]`)?.focus();
  });

  const set = (list: I18n[], k: string[]) => {
    setKeys(k);
    onChange(list);
  };
  const add = () => {
    set([...items, { et: "" }], [...keys, newKey()]);
    focus.current = items.length;
  };
  const remove = (i: number) => {
    set(items.filter((_, j) => j !== i), keys.filter((_, j) => j !== i));
    focus.current = items.length > 1 ? Math.min(i, items.length - 2) : "add";
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    set(moveItem(items, i, j), moveItem(keys, i, j));
  };

  return (
    <div
      ref={root}
      className={styles.list}
      data-list-editor={name}
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={error ? `${uid}-error` : undefined}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <div className={styles.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {title}
        </h3>
      </div>
      {hint && <p className={ui.hint}>{hint}</p>}
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.empty}</p>
      ) : (
        <ol className={styles.rows}>
          {items.map((item, i) => {
            const n = i + 1;
            const label = `${itemLabel} ${n}`;
            return (
              <li key={keys[i] ?? i} className={styles.item} data-row={i}>
                <span className={styles.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <I18nInput
                  label={label}
                  labelHidden
                  value={item}
                  onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
                  multiline={multiline}
                  rows={2}
                  maxLength={maxLength}
                />
                <span className={styles.tools}>
                  <button type="button" className={styles.iconBtn} aria-label={fill(t.up, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={fill(t.down, { n })}
                    aria-disabled={i === items.length - 1 || undefined}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(t.remove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {error && (
        <p id={`${uid}-error`} className={ui.error}>
          {error}
        </p>
      )}
      <button ref={addBtn} type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.addBtn}`} onClick={add}>
        + {t.add}
      </button>
    </div>
  );
}
