"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { moveItem } from "@/domain/course-editor";
import { sameSiteValue } from "@/domain/site-changes";
import { SITE_LIMITS, type FaqDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { DragList } from "./DragList";
import { useEditLang } from "./EditLang";
import { focusFell } from "./focus-fell";
import { hasRu, I18nInput, lacksRu } from "./I18nInput";
import { insertAt } from "./row-keys";
import { REVEAL_FIELD } from "./site/useSitePart";
import { useListRows } from "./useListRows";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./HomeEditor.module.css";

// Avaleht's „KKK“ (admin UX pass piece 4a, Task 6; the Part 4 C1 frame and its note "FAQ rows: question visible, answer collapsed; drag, ↑/↓ and
// removal with undo"; piece4-texts S4-11, S4-3; builder notes §5 "a FAQ answer is folded"): each row is the handle, the question's field, the row's
// state „ET · RU“ (both texts have their Russian) or „RU puudub“ with ▸, which opens the answer under it, and ↑ / ↓ / × (DragList: a drag with a finger
// or the mouse, the arrows, the arrow keys on the handle). × takes the row out at once with the UndoBar „Küsimus eemaldatud.“, whose „Võta tagasi“ puts
// it back at its place. The rows take the page's language (EditLang.tsx); a folded answer whose Russian text is missing is counted by the page and
// „Järgmine →“ opens it, as a closed slide's fields are (SlidesEditor's CollapsedRu); the leave guard's „Jää siia“ and SaveStatus's „Näita“ unfold the
// answer they name (site/useSitePart.ts REVEAL_FIELD, review I-2 / M-4).

let added = 0;

/**
 * A folded answer is not on the page, so when it has Estonian text and no Russian it tells the page itself: „RU puudub {n} väljal“ counts it, and
 * „Järgmine →“ opens it with the cursor in its Russian text. Its place on the page is its row's ▸ (`anchor`), after the question. Renders nothing.
 */
function FoldedRu({ item, anchor, reveal }: { item: FaqDraft; anchor: string; reveal: (key: string) => void }) {
  const { register } = useEditLang();
  const missing = lacksRu(item.a);
  const key = item.uid;
  useEffect(() => (missing ? register(`${anchor}-answer`, true, () => reveal(key), anchor) : undefined), [register, anchor, missing, reveal, key]);
  return null;
}

export type FaqEditorProps = {
  items: FaqDraft[];
  /** Live's questions: a field of a row that is live too says „· avaldamata“ where it differs from it (README §1.8). */
  live?: readonly FaqDraft[];
  /** A change of the rows, worked out from the list as it is when it lands; rows added, moved or removed save at once (the part's update). */
  onUpdate: (fn: (items: FaqDraft[]) => FaqDraft[]) => void;
  /** Each row's refused fields (`q`, `a`), in words, by the row's key (`uid`): placed on that row wherever it is now (README B2). */
  errors?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** A refusal of the list as a whole (more than 30), under the rows. */
  error?: string;
};

/** Where the focus goes after the next render: a row's question, its answer („Järgmine →“), its × (after a removal) or ▸ (after an undo), „Lisa küsimus“. */
type Focus = { uid: string; what: "q" | "a" | "remove" | "toggle" } | "add" | null;

export function FaqEditor({ items, live, onUpdate, errors, error }: FaqEditorProps) {
  const t = adminEt.home.faq;
  const uid = useId();
  /** The rows whose answer is open (several may be). */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const focus = useRef<Focus>(null);
  const { change, offer } = useListRows<FaqDraft>({ owner: "faq", items, onUpdate });

  // a refused answer opens its row (once per refusal)
  const [seenErrors, setSeenErrors] = useState(errors);
  if (errors !== seenErrors) {
    setSeenErrors(errors);
    const refused = items.filter((x) => errors?.get(x.uid)?.a !== undefined).map((x) => x.uid);
    if (refused.length > 0) setOpen((o) => new Set([...o, ...refused]));
  }

  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    if (target === "add") return addBtn.current?.focus();
    const row = root.current?.querySelector<HTMLElement>(`[data-faq-row="${CSS.escape(target.uid)}"]`);
    if (!row) return;
    const i = items.findIndex((x) => x.uid === target.uid);
    if (target.what === "q") return row.querySelector<HTMLElement>(`[data-i18n="faq.${i}.q"]`)?.focus();
    if (target.what === "remove") return row.querySelector<HTMLElement>('[data-tool="remove"]')?.focus();
    // (after an undo: only when the focus has nowhere else to be)
    if (target.what === "toggle") return void (focusFell() && row.querySelector<HTMLElement>("[data-faq-toggle]")?.focus());
    // „Järgmine →“ opened the answer: the cursor in its Russian text, the field in the middle of the screen
    const field = row.querySelector<HTMLElement>(`[data-i18n="faq.${i}.a"]`);
    field?.focus({ preventScroll: true });
    field?.scrollIntoView?.({ block: "center" });
  });

  /** „Järgmine →“ (or „Jää siia“, „Näita“) at a folded answer: it opens, the cursor goes into it (in the language shown). */
  const reveal = useCallback((key: string) => {
    focus.current = { uid: key, what: "a" };
    setOpen((o) => new Set([...o, key]));
  }, []);
  // a folded answer is to be focused (site/useSitePart.ts focusSiteField): it opens
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onReveal = (e: Event) => {
      const key = (e.target as Element | null)?.closest<HTMLElement>("[data-faq-row]")?.dataset.faqRow;
      if (key) reveal(key);
    };
    el.addEventListener(REVEAL_FIELD, onReveal);
    return () => el.removeEventListener(REVEAL_FIELD, onReveal);
  }, [reveal]);
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /** A row's texts, found by its key. */
  const edit = (key: string, patch: Partial<FaqDraft>) => onUpdate((list) => list.map((x) => (x.uid === key ? { ...x, ...patch } : x)));
  const move = (from: number, to: number) => change((list) => moveItem(list, from, to));
  const remove = (i: number) => {
    const item = items[i];
    const next = items[i + 1] ?? items[i - 1];
    focus.current = next ? { uid: next.uid, what: "remove" } : "add";
    change((list) => list.filter((x) => x.uid !== item.uid));
    // back at its place with its key, unless it is in the list again already
    offer(
      adminEt.courseEditor.fields.testRemoved,
      (list) => (list.some((x) => x.uid === item.uid) ? list : insertAt(list, i, item)),
      () => void (focus.current = { uid: item.uid, what: "toggle" }),
    );
  };
  const add = () => {
    const item: FaqDraft = { uid: `new-${Date.now().toString(36)}-${++added}`, id: null, q: { et: "" }, a: { et: "" } };
    focus.current = { uid: item.uid, what: "q" };
    setOpen((o) => new Set([...o, item.uid]));
    change((list) => [...list, item]);
  };

  return (
    <div ref={root} className={styles.faq} data-faq-editor="">
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.empty}</p>
      ) : (
        <DragList
          items={items}
          keyOf={(x) => x.uid}
          label={() => ""}
          arrowNames={(n) => ({ up: fill(t.up, { n }), down: fill(t.down, { n }) })}
          onMove={move}
          className={styles.faqList}
          renderRow={(item, i, handle, arrows) => {
            const n = i + 1;
            const rowId = `${uid}-${item.uid}`;
            const expanded = open.has(item.uid);
            const both = hasRu(item.q) && hasRu(item.a);
            const was = live?.find((x) => x.uid === item.uid);
            const changed = (f: "q" | "a") => was !== undefined && !sameSiteValue(item[f], was[f]);
            const own = errors?.get(item.uid);
            return (
              <div id={rowId} className={styles.faqRow} data-faq-row={item.uid} data-reveals={expanded ? undefined : `faq.${i}.a`}>
                {!expanded && <FoldedRu item={item} anchor={`${rowId}-toggle`} reveal={reveal} />}
                <span className={styles.grip}>{handle}</span>
                <div className={styles.question}>
                  <I18nInput
                    label={`${t.question} ${n}`}
                    labelHidden
                    value={item.q}
                    onChange={(q) => edit(item.uid, { q })}
                    maxLength={SITE_LIMITS.question}
                    error={own?.q}
                    name={`faq.${i}.q`}
                    unpublished={changed("q")}
                  />
                </div>
                <button
                  id={`${rowId}-toggle`}
                  type="button"
                  className={styles.state}
                  aria-expanded={expanded}
                  aria-controls={expanded ? `${rowId}-answer` : undefined}
                  onClick={() => toggle(item.uid)}
                  data-faq-toggle=""
                  data-both={both || undefined}
                >
                  <span className={ui.sr}>
                    {t.answer} {n} ·{" "}
                  </span>
                  <span data-faq-state="">{both ? t.both : adminEt.sectionMap.ru}</span> <span aria-hidden="true">▸</span>
                </button>
                <span className={styles.faqTools}>
                  {arrows}
                  <button type="button" className={ed.iconBtn} data-tool="remove" aria-label={fill(t.remove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
                {expanded && (
                  <div id={`${rowId}-answer`} className={styles.answer}>
                    <I18nInput
                      label={`${t.answer} ${n}`}
                      value={item.a}
                      onChange={(a) => edit(item.uid, { a })}
                      multiline
                      rows={3}
                      maxLength={SITE_LIMITS.answer}
                      error={own?.a}
                      name={`faq.${i}.a`}
                      unpublished={changed("a")}
                    />
                  </div>
                )}
              </div>
            );
          }}
        />
      )}
      {error && <p className={ui.error}>{error}</p>}
      <button ref={addBtn} type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${ed.addBtn}`} onClick={add} data-add-faq="">
        + {t.add}
      </button>
    </div>
  );
}
