"use client";

import { useEffect, useId, useRef } from "react";
import { moveItem } from "@/domain/course-editor";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { DragList } from "./DragList";
import { I18nInput } from "./I18nInput";
import { insertAt, newRowKey, removeAt, useRowKeys } from "./row-keys";
import { UnpublishedTag } from "./UnpublishedTag";
import { focusFell, useListRows } from "./useListRows";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

type Props = {
  /** The heading of the list. */
  title: string;
  /** The label of one row, numbered: "Õpiväljund 2". */
  itemLabel: string;
  items: I18n[];
  /** A row typed in: the list with it. */
  onChange: (items: I18n[]) => void;
  /**
   * A row added, moved, removed or brought back: the change worked out from the list as it is when it lands (the course card's update, which goes to
   * the form on screen then, also after the cards started over). Without it the change goes to `onChange`, from the list the editor last saw.
   */
  onUpdate?: (fn: (items: I18n[]) => I18n[]) => void;
  hint?: string;
  error?: string;
  multiline?: boolean;
  maxLength?: number;
  /** data-list-editor attribute. */
  name: string;
  /** A published course's list that waits for „Avalda muudatused“: „· avaldamata“ after the title (README §1.8). */
  unpublished?: boolean;
};

/** Where the focus goes after the next render: a row's field (by its place after an add or a removal, by its key after an undo), or "Lisa rida". */
type Focus = { index: number } | { key: string } | "add" | null;

/**
 * An ordered list of texts in two languages (outcomes, „Koolitus sisaldab“, Praktika's items; README B2): each row has the handle „⋮⋮“ and ↑ / ↓
 * (DragList: a drag with a finger or the mouse, the arrows, the arrow keys on the handle, each one move announced), × takes it out at once with the
 * UndoBar „Rida eemaldatud.“, and „Võta tagasi“ puts it back at its place with its key (BEH B5: a client restore, then the card's save). The rows
 * take the page's language (EditLang.tsx). After adding a row its field gets the focus, after removing one the next row's field (or "Lisa rida"),
 * after an undo the row's own field (when the focus has nowhere else to be).
 */
export function ListEditor({ title, itemLabel, items, onChange, onUpdate, hint, error, multiline, maxLength, name, unpublished }: Props) {
  const t = adminEt.list;
  const uid = useId();
  const rows = useRowKeys(items);
  const keys = rows.keys;
  const { change, offer } = useListRows({ owner: name, items, onChange, onUpdate });
  const focus = useRef<Focus>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") return addBtn.current?.focus();
    if ("index" in target) return root.current?.querySelector<HTMLElement>(`[data-row="${target.index}"] [data-lang-field]`)?.focus();
    if (focusFell()) root.current?.querySelector<HTMLElement>(`[data-drag-row="${CSS.escape(target.key)}"] [data-lang-field]`)?.focus();
  });

  const add = () => {
    rows.expect([...items, { et: "" }], [...keys, newRowKey()]);
    change((list) => [...list, { et: "" }]);
    focus.current = { index: items.length };
  };
  const remove = (i: number) => {
    const item = items[i];
    const key = keys[i];
    rows.expect(
      items.filter((_, j) => j !== i),
      keys.filter((_, j) => j !== i),
    );
    change((list) => removeAt(list, i, item));
    focus.current = items.length > 1 ? { index: Math.min(i, items.length - 2) } : "add";
    offer(
      t.removed,
      (list) => insertAt(list, i, item),
      () => void (focus.current = { key }),
    );
  };
  const move = (from: number, to: number) => {
    rows.expect(moveItem(items, from, to), moveItem(keys, from, to));
    change((list) => moveItem(list, from, to));
  };

  const tagId = `${uid}-unpublished`;
  const described = [unpublished ? tagId : "", error ? `${uid}-error` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <div
      ref={root}
      className={styles.list}
      data-list-editor={name}
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={described}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <div className={styles.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {title}
          {unpublished && (
            <>
              {" "}
              <UnpublishedTag id={tagId} hidden />
            </>
          )}
        </h3>
      </div>
      {hint && <p className={ui.hint}>{hint}</p>}
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.empty}</p>
      ) : (
        <DragList
          items={items.map((item, i) => ({ item, key: keys[i] }))}
          keyOf={(row) => row.key}
          label={() => ""}
          onMove={move}
          className={styles.rows}
          renderRow={({ item }, i, handle, arrows) => {
            const n = i + 1;
            return (
              <div className={`${styles.item} ${styles.dragRow}`} data-row={i}>
                {handle}
                <span className={styles.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div className={styles.rowMain}>
                  <I18nInput
                    label={`${itemLabel} ${n}`}
                    labelHidden
                    value={item}
                    onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
                    multiline={multiline}
                    rows={2}
                    maxLength={maxLength}
                  />
                </div>
                <span className={styles.tools}>
                  {arrows}
                  <button type="button" className={styles.iconBtn} aria-label={fill(t.remove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              </div>
            );
          }}
        />
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
