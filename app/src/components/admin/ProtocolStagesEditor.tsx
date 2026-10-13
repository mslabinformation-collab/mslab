"use client";

import { useEffect, useId, useRef, useState } from "react";
import { moveItem } from "@/domain/course-editor";
import { PROTOCOL_LIMITS } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

let rowCount = 0;
const newKey = () => `stage-${++rowCount}`;

/**
 * "Protokolli punktid": a contact course's stage headings for the course day's protocols (phase protocols, spec §3), or an e-course's practical
 * points, to each of which the student adds 1–3 photos (e-course completion, spec §5.1: `hint` and `empty` give the e-course's texts). In the
 * language Maria writes in (one plain field each, no translation), in order: add, remove, ↑ / ↓; at most 30, each at most 120 characters. Saved
 * with the course ("Salvesta"); blank rows are dropped then. A change reaches only protocols not created yet (the hint says so). As ListEditor:
 * the arrows are aria-disabled at the ends, after adding a row its field gets the focus, after removing one the next row's field (or "Lisa punkt").
 */
export function ProtocolStagesEditor({
  items,
  onChange,
  error,
  hint,
  empty,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  error?: string;
  /** The hint under the title (default: the contact course's). */
  hint?: string;
  /** The line shown while there are none (default: the contact course's). */
  empty?: string;
}) {
  const t = adminEt.courseEditor;
  const l = adminEt.list;
  const uid = useId();
  const [keys, setKeys] = useState<string[]>(() => items.map(newKey));
  // the list was replaced from outside (the editor reloads the saved course): new rows, new keys
  if (keys.length !== items.length) setKeys(items.map(newKey));
  const focus = useRef<number | "add" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") addBtn.current?.focus();
    else root.current?.querySelector<HTMLInputElement>(`[data-row="${target}"] input`)?.focus();
  });

  const set = (list: string[], k: string[]) => {
    setKeys(k);
    onChange(list);
  };
  const full = items.length >= PROTOCOL_LIMITS.stages;
  const add = () => {
    if (full) return;
    set([...items, ""], [...keys, newKey()]);
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
      data-protocol-stages=""
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={error ? `${uid}-hint ${uid}-error` : `${uid}-hint`}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <div className={styles.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {t.sections.protocolStages}
        </h3>
      </div>
      <p id={`${uid}-hint`} className={ui.hint}>
        {hint ?? t.fields.protocolStagesHint}
      </p>
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{empty ?? t.fields.protocolStagesEmpty}</p>
      ) : (
        <ol className={styles.rows}>
          {items.map((item, i) => {
            const n = i + 1;
            const id = `${uid}-${i}`;
            return (
              <li key={keys[i] ?? i} className={styles.item} data-row={i}>
                <span className={styles.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div>
                  <label htmlFor={id} className={ui.sr}>
                    {`${t.fields.protocolStage} ${n}`}
                  </label>
                  <input
                    id={id}
                    className={ui.input}
                    type="text"
                    value={item}
                    maxLength={PROTOCOL_LIMITS.title}
                    autoComplete="off"
                    onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                    data-protocol-stage={i}
                  />
                </div>
                <span className={styles.tools}>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.up, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.down, { n })} aria-disabled={i === items.length - 1 || undefined} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.remove, { n })} onClick={() => remove(i)}>
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
      <button ref={addBtn} type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.addBtn}`} aria-disabled={full || undefined} onClick={add} data-add-stage="">
        + {t.fields.protocolStagesAdd}
      </button>
      {full && <p className={ui.hint}>{t.fields.protocolStagesFull}</p>}
    </div>
  );
}
