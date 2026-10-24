"use client";

import { useEffect, useId, useRef } from "react";
import type { ChoiceOption, TestQuestion } from "@/db/schema";
import { newItemId, TEST_LIMITS } from "@/domain/completion";
import { moveItem, type TestDraft } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { Choice } from "./Choice";
import { DragList } from "./DragList";
import { insertAt } from "./row-keys";
import { UnpublishedTag } from "./UnpublishedTag";
import { focusFell } from "./focus-fell";
import { useListRows } from "./useListRows";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./TestEditor.module.css";

/**
 * The save's refusals as the editor shows them: the three fields' texts, and which question (and option) the `test` one is about, by their ids (README
 * B2 "errors keyed by row id": a question moved after the answer keeps its words); none, or a question no longer in the list: the list as a whole.
 */
export type TestErrors = { test?: string; testPassPercent?: string; testTries?: string; at?: { question: string; option?: string } };

const newOption = (): ChoiceOption => ({ id: newItemId(), text: "", correct: false });
/** A new question: a choice question with two empty options. */
const newQuestion = (): TestQuestion => ({ id: newItemId(), kind: "choice", text: "", options: [newOption(), newOption()] });

/** Where the focus goes after the next render: a question's text or an option's field (by place), "Lisa küsimus", or after an undo the question that came back (by its id). */
type Focus = { question: number; option?: number } | { back: string } | "add" | null;

/**
 * "Teadmiste test" (e-course completion, spec §3.1, §5.1): an e-course's pass mark, tries and questions, saved with the course's card (autosave).
 * A card per question: its kind ("Valikvastustega" / "Vaba vastusega"), its text, and for a choice question its 2–6 options, each with "Õige" (one
 * or more: more than one gives the student checkboxes). As the other list editors (Task 8, README B2): the handle „⋮⋮“ and ↑ / ↓ (DragList), and ×
 * at once with the UndoBar („Küsimus eemaldatud.“, an option's „Vastusevariant eemaldatud.“), whose „Võta tagasi“ puts the question or the option
 * back at its place with its id (BEH B5). Plain text in the course's language, never translated. A question's and an option's id is made here
 * (newItemId) and never reused: an attempt refers to a question by its id, and so does the editor (its row's key). A choice question switched to
 * "Vaba vastusega" keeps its options in memory, so switching back brings them back. The save's refusal shows in the card of the question it names
 * by id (its option marked), or under the list for the list as a whole.
 */
export function TestEditor({
  value,
  onChange,
  onUpdate,
  errors,
  unpublished,
}: {
  value: TestDraft;
  /** Typed: a text, a mark, a number, a question's kind, an option's „Õige“. */
  onChange: (v: TestDraft) => void;
  /**
   * The questions' rows changed (a question added, moved, removed or brought back, an option removed or brought back): worked out from the list as it
   * is when it lands (the card's update, which goes to the form on screen then). Without it the change goes to `onChange`, from the value last seen.
   */
  onUpdate?: (fn: (questions: TestQuestion[]) => TestQuestion[]) => void;
  errors: TestErrors;
  /** A published course's pass mark, tries or questions wait for „Avalda muudatused“: „· avaldamata“ after its label (README §1.8). */
  unpublished?: { passPercent?: boolean; tries?: boolean; questions?: boolean };
}) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const focus = useRef<Focus>(null);
  const kept = useRef(new Map<string, ChoiceOption[]>());
  const { change, offer } = useListRows({ owner: "test", items: value.questions, onChange: (questions) => onChange({ ...value, questions }), onUpdate });

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") {
      addBtn.current?.focus();
      return;
    }
    if ("back" in target) {
      if (focusFell()) root.current?.querySelector<HTMLElement>(`[data-drag-row="${CSS.escape(target.back)}"] [data-question-text]`)?.focus();
      return;
    }
    const card = root.current?.querySelector(`[data-question="${target.question}"]`);
    const field =
      target.option === undefined
        ? card?.querySelector<HTMLElement>("[data-question-text]")
        : card?.querySelector<HTMLElement>(`[data-option="${target.option}"] [data-option-text]`);
    field?.focus();
  });

  const { questions } = value;
  const setQuestions = (list: TestQuestion[]) => onChange({ ...value, questions: list });
  const update = (i: number, q: TestQuestion) => setQuestions(questions.map((x, j) => (j === i ? q : x)));
  const full = questions.length >= TEST_LIMITS.questions;

  const add = () => {
    if (full) return;
    const q = newQuestion();
    change((list) => (list.length >= TEST_LIMITS.questions ? list : [...list, q]));
    focus.current = { question: questions.length };
  };
  const remove = (i: number) => {
    const q = questions[i];
    change((list) => list.filter((x) => x.id !== q.id));
    focus.current = questions.length > 1 ? { question: Math.min(i, questions.length - 2) } : "add";
    // back at its place with its id and its options (never twice: the id is the question's for good); the focus on it, found by its id
    offer(
      f.testRemoved,
      (list) => (list.some((x) => x.id === q.id) || list.length >= TEST_LIMITS.questions ? list : insertAt(list, i, q)),
      () => void (focus.current = { back: q.id }),
    );
  };
  const move = (from: number, to: number) => change((list) => moveItem(list, from, to));
  const setKind = (i: number, kind: TestQuestion["kind"]) => {
    const q = questions[i];
    if (q.kind === kind) return;
    if (q.kind === "choice") {
      kept.current.set(q.id, q.options);
      update(i, { id: q.id, kind: "open", text: q.text });
    } else update(i, { id: q.id, kind: "choice", text: q.text, options: kept.current.get(q.id) ?? [newOption(), newOption()] });
  };
  const setOptions = (i: number, options: ChoiceOption[]) => {
    const q = questions[i];
    if (q.kind === "choice") update(i, { ...q, options });
  };
  const addOption = (i: number) => {
    const q = questions[i];
    if (q.kind !== "choice" || q.options.length >= TEST_LIMITS.maxOptions) return;
    setOptions(i, [...q.options, newOption()]);
    focus.current = { question: i, option: q.options.length };
  };
  /** The options of the question `id` as they are when the change lands (none: the question is not there, or not a choice question). */
  const changeOptions = (id: string, fn: (options: ChoiceOption[]) => ChoiceOption[]) =>
    change((list) => list.map((x) => (x.id === id && x.kind === "choice" ? { ...x, options: fn(x.options) } : x)));
  const removeOption = (i: number, j: number) => {
    const q = questions[i];
    if (q.kind !== "choice" || q.options.length <= TEST_LIMITS.minOptions) return;
    const o = q.options[j];
    changeOptions(q.id, (options) => (options.length <= TEST_LIMITS.minOptions ? options : options.filter((x) => x.id !== o.id)));
    focus.current = { question: i, option: Math.min(j, q.options.length - 2) };
    offer(f.testOptionRemoved, (list) =>
      list.map((x) =>
        x.id === q.id && x.kind === "choice" && !x.options.some((y) => y.id === o.id) && x.options.length < TEST_LIMITS.maxOptions ? { ...x, options: insertAt(x.options, j, o) } : x,
      ),
    );
  };

  // the save's refusal: in the card of the question it names (by its id), or for the list as a whole
  const at = errors.test ? errors.at : undefined;
  const listError = errors.test && (!at || !questions.some((q) => q.id === at.question)) ? errors.test : undefined;

  /** The pass mark or the tries: a short field of digits, as typed (the server parses it). */
  const setting = (key: "passPercent" | "tries", label: string, hint: string, error: string | undefined, maxLength: number) => {
    const id = `${uid}-${key}`;
    const waits = unpublished?.[key] === true;
    return (
      <div className={`${ui.field} ${ed.i18n}`} data-unpublished={waits ? "" : undefined}>
        <div className={ed.i18nHead}>
          <label htmlFor={id}>{label}</label>
          {waits && <UnpublishedTag id={`${id}-unpublished`} />}
        </div>
        <input
          id={id}
          className={ui.input}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={maxLength}
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          aria-invalid={error ? true : undefined}
          aria-describedby={[waits ? `${id}-unpublished` : "", `${id}-hint`, error ? `${id}-error` : ""].filter(Boolean).join(" ")}
          data-test-pass={key === "passPercent" ? "" : undefined}
          data-test-tries={key === "tries" ? "" : undefined}
        />
        <p id={`${id}-hint`} className={ui.hint}>
          {hint}
        </p>
        {error && (
          <p id={`${id}-error`} className={ui.error}>
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <div
      ref={root}
      className={ed.list}
      data-test-editor=""
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={[unpublished?.questions ? `${uid}-unpublished` : "", `${uid}-hint`, listError ? `${uid}-error` : ""].filter(Boolean).join(" ")}
      data-invalid={listError ? "" : undefined}
      tabIndex={listError ? -1 : undefined}
    >
      <div className={ed.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {t.sections.test}
          {unpublished?.questions && (
            <>
              {" "}
              <UnpublishedTag id={`${uid}-unpublished`} hidden />
            </>
          )}
        </h3>
      </div>
      <p id={`${uid}-hint`} className={ui.hint}>
        {f.testHint}
      </p>
      <div className={ed.grid}>
        {setting("passPercent", f.testPass, f.testPassHint, errors.testPassPercent, 3)}
        {setting("tries", f.testTries, f.testTriesHint, errors.testTries, 2)}
      </div>
      {questions.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{f.testEmpty}</p>
      ) : (
        <DragList
          items={questions}
          keyOf={(q) => q.id}
          label={() => ""}
          arrowNames={(n) => ({ up: fill(f.testUp, { n }), down: fill(f.testDown, { n }) })}
          onMove={move}
          className={ed.rows}
          renderRow={(q, i, handle, arrows) => {
            const n = i + 1;
            const id = `${uid}-q${i}`;
            const error = errors.test && at && at.question === q.id ? errors.test : undefined;
            return (
              <div className={`${ed.item} ${ed.dragRow}`} data-question={i} data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined}>
                {handle}
                <span className={ed.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div className={`${styles.body} ${ed.rowMain}`}>
                  <fieldset className={ed.fieldset}>
                    <legend className={ui.sr}>{fill(f.testKind, { n })}</legend>
                    <div className={ed.choices}>
                      <Choice
                        className={ed.choice}
                        label={f.testKindChoice}
                        type="radio"
                        name={`${uid}-kind-${q.id}`}
                        value="choice"
                        checked={q.kind === "choice"}
                        onChange={() => setKind(i, "choice")}
                        data-question-kind="choice"
                      />
                      <Choice
                        className={ed.choice}
                        label={f.testKindOpen}
                        type="radio"
                        name={`${uid}-kind-${q.id}`}
                        value="open"
                        checked={q.kind === "open"}
                        onChange={() => setKind(i, "open")}
                        data-question-kind="open"
                      />
                    </div>
                  </fieldset>
                  <div className={ui.field}>
                    <label htmlFor={id}>{fill(f.testQuestion, { n })}</label>
                    <textarea
                      id={id}
                      className={ui.textarea}
                      rows={2}
                      value={q.text}
                      onChange={(e) => update(i, { ...q, text: e.target.value })}
                      aria-describedby={error ? `${id}-error` : undefined}
                      data-question-text=""
                    />
                  </div>
                  {q.kind === "choice" ? (
                    <div className={styles.options}>
                      <ol className={styles.optionList}>
                        {q.options.map((o, j) => {
                          const m = j + 1;
                          const oid = `${id}-o${j}`;
                          const marked = error !== undefined && at?.option === o.id;
                          return (
                            <li key={o.id} className={styles.option} data-option={j}>
                              <label htmlFor={oid} className={ui.sr}>
                                {fill(f.testOption, { q: n, n: m })}
                              </label>
                              <input
                                id={oid}
                                className={ui.input}
                                type="text"
                                autoComplete="off"
                                value={o.text}
                                onChange={(e) => setOptions(i, q.options.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)))}
                                aria-invalid={marked || undefined}
                                aria-describedby={marked ? `${id}-error` : undefined}
                                data-option-text=""
                              />
                              <label className={`${ed.check} ${styles.correct}`}>
                                <input
                                  type="checkbox"
                                  checked={o.correct}
                                  onChange={(e) => setOptions(i, q.options.map((x, k) => (k === j ? { ...x, correct: e.target.checked } : x)))}
                                  data-option-correct=""
                                />
                                <span>{f.testCorrect}</span>
                              </label>
                              <button
                                type="button"
                                className={ed.iconBtn}
                                aria-label={fill(f.testOptionRemove, { q: n, n: m })}
                                aria-disabled={q.options.length <= TEST_LIMITS.minOptions || undefined}
                                onClick={() => removeOption(i, j)}
                                data-option-remove=""
                              >
                                ×
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                      <p className={ui.hint}>{f.testChoiceHint}</p>
                      <button
                        type="button"
                        className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${ed.addBtn}`}
                        aria-disabled={q.options.length >= TEST_LIMITS.maxOptions || undefined}
                        onClick={() => addOption(i)}
                        data-option-add=""
                      >
                        + {f.testOptionAdd}
                      </button>
                    </div>
                  ) : (
                    <p className={ui.hint}>{f.testOpenHint}</p>
                  )}
                  {error && (
                    <p id={`${id}-error`} className={ui.error}>
                      {error}
                    </p>
                  )}
                </div>
                <span className={ed.tools}>
                  {arrows}
                  <button type="button" className={ed.iconBtn} aria-label={fill(f.testRemove, { n })} onClick={() => remove(i)} data-question-remove="">
                    ×
                  </button>
                </span>
              </div>
            );
          }}
        />
      )}
      {listError && (
        <p id={`${uid}-error`} className={ui.error}>
          {listError}
        </p>
      )}
      <button ref={addBtn} type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${ed.addBtn}`} aria-disabled={full || undefined} onClick={add} data-question-add="">
        + {f.testAdd}
      </button>
      {full && <p className={ui.hint}>{f.testFull}</p>}
    </div>
  );
}
