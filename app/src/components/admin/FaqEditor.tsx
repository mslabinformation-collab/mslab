"use client";

import { useEffect, useId, useRef } from "react";
import { moveItem } from "@/domain/course-editor";
import { SITE_LIMITS, type FaqDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { I18nInput } from "./I18nInput";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./site-editor.module.css";

let added = 0;

/**
 * The home page FAQ: question and answer pairs in two languages (they take the page's language, EditLang.tsx), ↑ / ↓, ×, "Lisa
 * küsimus". As in ListEditor, the arrows are aria-disabled at the ends and the focus follows adds and removals.
 */
export function FaqEditor({ items, onChange, err }: { items: FaqDraft[]; onChange: (items: FaqDraft[]) => void; err: (name: string) => string | undefined }) {
  const t = adminEt.home.faq;
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const focus = useRef<{ uid: string; what: "q" | "up" | "down" } | "add" | null>(null);

  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    if (target === "add") root.current?.querySelector<HTMLElement>("[data-add-faq]")?.focus();
    else {
      const row = root.current?.querySelector(`[data-faq-row="${CSS.escape(target.uid)}"]`);
      (target.what === "q" ? row?.querySelector<HTMLElement>("[data-lang-field]") : row?.querySelector<HTMLElement>(`[data-tool="${target.what}"]`))?.focus();
    }
  });

  const edit = (i: number, patch: Partial<FaqDraft>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    focus.current = { uid: items[i].uid, what: dir < 0 ? "up" : "down" };
    onChange(moveItem(items, i, j));
  };
  const remove = (i: number) => {
    const next = items[i + 1] ?? items[i - 1];
    focus.current = next ? { uid: next.uid, what: "q" } : "add";
    onChange(items.filter((_, j) => j !== i));
  };
  const add = () => {
    const item: FaqDraft = { uid: `new-${Date.now().toString(36)}-${++added}`, id: null, q: { et: "" }, a: { et: "" } };
    focus.current = { uid: item.uid, what: "q" };
    onChange([...items, item]);
  };
  const listError = err("faq");

  return (
    <div ref={root} className={ed.list} data-faq-editor="" role="group" aria-labelledby={`${uid}-title`} data-invalid={listError ? "" : undefined} tabIndex={listError ? -1 : undefined}>
      <h3 id={`${uid}-title`} className={ui.sr}>
        {t.title}
      </h3>
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.empty}</p>
      ) : (
        <ol className={ed.rows}>
          {items.map((item, i) => {
            const n = i + 1;
            return (
              <li key={item.uid} className={ed.item} data-faq-row={item.uid}>
                <span className={ed.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div className={styles.faqFields}>
                  <I18nInput label={`${t.question} ${n}`} value={item.q} onChange={(q) => edit(i, { q })} maxLength={SITE_LIMITS.question} error={err(`faq.${i}.q`)} name={`faq.${i}.q`} />
                  <I18nInput label={`${t.answer} ${n}`} value={item.a} onChange={(a) => edit(i, { a })} multiline rows={3} maxLength={SITE_LIMITS.answer} error={err(`faq.${i}.a`)} name={`faq.${i}.a`} />
                </div>
                <span className={ed.tools}>
                  <button type="button" className={ed.iconBtn} data-tool="up" aria-label={fill(t.up, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className={ed.iconBtn} data-tool="down" aria-label={fill(t.down, { n })} aria-disabled={i === items.length - 1 || undefined} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className={ed.iconBtn} aria-label={fill(t.remove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {listError && <p className={ui.error}>{listError}</p>}
      <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${ed.addBtn}`} onClick={add} data-add-faq="">
        + {t.add}
      </button>
    </div>
  );
}
