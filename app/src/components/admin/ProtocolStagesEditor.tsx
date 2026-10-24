"use client";

import { useEffect, useId, useRef } from "react";
import { moveItem } from "@/domain/course-editor";
import { CERT_LIMITS, outcomesTooLong } from "@/domain/certificate";
import { PROTOCOL_LIMITS } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { DragList } from "./DragList";
import { insertAt, newRowKey, removeAt, useRowKeys } from "./row-keys";
import { UnpublishedTag } from "./UnpublishedTag";
import { focusFell } from "./focus-fell";
import { useListRows } from "./useListRows";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

/** Where the focus goes after the next render: a row's field (by its place after an add or a removal, by its key after an undo), or the add button. */
type Focus = { index: number } | { key: string } | "add" | null;

/**
 * "Protokolli punktid": a contact course's stage headings for the course day's protocols (phase protocols, spec §3), or an e-course's practical
 * points, to each of which the student adds 1–3 photos (e-course completion, spec §5.1: `hint` and `empty` give the e-course's texts). In the
 * language Maria writes in (one plain field each, no translation), in order; at most 30, each at most 120 characters. Saved with the course's
 * card (autosave); blank rows are dropped then. A change reaches only protocols not created yet (the hint says so). As ListEditor (Task 8, README
 * B2): each row has the handle „⋮⋮“ and ↑ / ↓ (DragList), × takes it out at once with the UndoBar „Rida eemaldatud.“ and „Võta tagasi“ puts it back
 * at its place with its key; after adding a row its field gets the focus, after removing one the next row's field (or "Lisa punkt").
 * `kind` "skills": the same editor for the e-course certificate's lines ("Oskused tunnistusel", phase 3d, spec §6), with their own title, row
 * label, limit (16 lines of 120 characters, CERT_LIMITS) and data hooks, so an e-course's editor tells its two lists apart. With no line of
 * its own the certificate prints the course's `outcomes`; one of them too long for a certificate line is warned of under the list
 * (domain/certificate.ts outcomesTooLong; final review M-4), and nothing is cut.
 */
export function ProtocolStagesEditor({
  items,
  onChange,
  onUpdate,
  error,
  hint,
  empty,
  kind = "stages",
  outcomes,
  unpublished,
}: {
  items: string[];
  /** A row typed in: the list with it. */
  onChange: (items: string[]) => void;
  /** A row added, moved, removed or brought back, worked out from the list as it is when it lands (the card's update); without it, `onChange`. */
  onUpdate?: (fn: (items: string[]) => string[]) => void;
  error?: string;
  /** The hint under the title (default: the kind's own: the contact course's protocol, or the certificate's lines'). */
  hint?: string;
  /** The line shown while there are none (default: the kind's own). */
  empty?: string;
  /** stages (default): "Protokolli punktid"; skills: the certificate's lines (phase 3d). */
  kind?: "stages" | "skills";
  /** kind "skills": the course's outcomes ("Õpiväljundid"), which the certificate prints while the list has no line. */
  outcomes?: readonly { et: string }[];
  /** A published course's list that waits for „Avalda muudatused“: „· avaldamata“ after the title (README §1.8). */
  unpublished?: boolean;
}) {
  const t = adminEt.courseEditor;
  const l = adminEt.list;
  const skills = kind === "skills";
  const words = skills
    ? {
        title: t.fields.certificateSkills,
        item: t.fields.certificateSkill,
        add: t.fields.certificateSkillsAdd,
        full: t.fields.certificateSkillsFull,
        hint: t.fields.certificateSkillsHint,
        empty: t.fields.certificateSkillsEmpty,
      }
    : {
        title: t.sections.protocolStages,
        item: t.fields.protocolStage,
        add: t.fields.protocolStagesAdd,
        full: t.fields.protocolStagesFull,
        hint: t.fields.protocolStagesHint,
        empty: t.fields.protocolStagesEmpty,
      };
  const most = skills ? CERT_LIMITS.skills : PROTOCOL_LIMITS.stages;
  const longest = skills ? CERT_LIMITS.skill : PROTOCOL_LIMITS.title;
  const uid = useId();
  const rows = useRowKeys(items);
  const keys = rows.keys;
  const { change, offer } = useListRows({ owner: skills ? "certificateSkills" : "protocolStages", items, onChange, onUpdate });
  const focus = useRef<Focus>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") return addBtn.current?.focus();
    if ("index" in target) return root.current?.querySelector<HTMLInputElement>(`[data-row="${target.index}"] input`)?.focus();
    if (focusFell()) root.current?.querySelector<HTMLInputElement>(`[data-drag-row="${CSS.escape(target.key)}"] input`)?.focus();
  });

  const full = items.length >= most;
  const tooLong = skills && outcomes !== undefined && outcomesTooLong({ certificateSkills: items, outcomes });
  const add = () => {
    if (full) return;
    rows.expect([...items, ""], [...keys, newRowKey()]);
    change((list) => (list.length >= most ? list : [...list, ""]));
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
      l.removed,
      (list) => (list.length >= most ? list : insertAt(list, i, item)),
      () => void (focus.current = { key }),
    );
  };
  const move = (from: number, to: number) => {
    rows.expect(moveItem(items, from, to), moveItem(keys, from, to));
    change((list) => moveItem(list, from, to));
  };
  const tagId = `${uid}-unpublished`;

  return (
    <div
      ref={root}
      className={styles.list}
      {...(skills ? { "data-certificate-skills": "" } : { "data-protocol-stages": "" })}
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={[unpublished ? tagId : "", `${uid}-hint`, tooLong ? `${uid}-long` : "", error ? `${uid}-error` : ""].filter(Boolean).join(" ")}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <div className={styles.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {words.title}
          {unpublished && (
            <>
              {" "}
              <UnpublishedTag id={tagId} hidden />
            </>
          )}
        </h3>
      </div>
      <p id={`${uid}-hint`} className={ui.hint}>
        {hint ?? words.hint}
      </p>
      {tooLong && (
        <p id={`${uid}-long`} className={styles.warning} data-certificate-long="">
          {t.fields.certificateSkillsLong}
        </p>
      )}
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{empty ?? words.empty}</p>
      ) : (
        <DragList
          items={items.map((item, i) => ({ item, key: keys[i] }))}
          keyOf={(row) => row.key}
          label={() => ""}
          onMove={move}
          className={styles.rows}
          renderRow={({ item }, i, handle, arrows) => {
            const n = i + 1;
            const id = `${uid}-${i}`;
            return (
              <div className={`${styles.item} ${styles.dragRow}`} data-row={i}>
                {handle}
                <span className={styles.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div className={styles.rowMain}>
                  <label htmlFor={id} className={ui.sr}>
                    {`${words.item} ${n}`}
                  </label>
                  <input
                    id={id}
                    className={ui.input}
                    type="text"
                    value={item}
                    maxLength={longest}
                    autoComplete="off"
                    onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                    {...(skills ? { "data-certificate-skill": i } : { "data-protocol-stage": i })}
                  />
                </div>
                <span className={styles.tools}>
                  {arrows}
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.remove, { n })} onClick={() => remove(i)}>
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
      <button
        ref={addBtn}
        type="button"
        className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.addBtn}`}
        aria-disabled={full || undefined}
        onClick={add}
        {...(skills ? { "data-add-skill": "" } : { "data-add-stage": "" })}
      >
        + {words.add}
      </button>
      {full && <p className={ui.hint}>{words.full}</p>}
    </div>
  );
}
