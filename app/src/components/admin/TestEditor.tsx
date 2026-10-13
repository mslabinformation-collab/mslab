"use client";

import { useEffect, useId, useRef } from "react";
import type { ChoiceOption, TestQuestion } from "@/db/schema";
import { newItemId, TEST_LIMITS } from "@/domain/completion";
import { moveItem, type TestDraft } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { Choice } from "./Choice";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./TestEditor.module.css";

/** The save's refusals as the editor shows them: the three fields' texts, and where in the list the `test` one is (EditResult.at). */
export type TestErrors = { test?: string; testPassPercent?: string; testTries?: string; at?: { index: number; option?: number } };

const newOption = (): ChoiceOption => ({ id: newItemId(), text: "", correct: false });
/** A new question: a choice question with two empty options. */
const newQuestion = (): TestQuestion => ({ id: newItemId(), kind: "choice", text: "", options: [newOption(), newOption()] });

/** Where the focus goes after the next render: a question's text, an option's field, or "Lisa küsimus". */
type Focus = { question: number; option?: number } | "add" | null;

/**
 * "Teadmiste test" (e-course completion, spec §3.1, §5.1): an e-course's pass mark, tries and questions, saved with the course ("Salvesta").
 * A card per question: its kind ("Valikvastustega" / "Vaba vastusega"), its text, and for a choice question its 2–6 options, each with "Õige" (one
 * or more: more than one gives the student checkboxes); ↑ / ↓ / × as the other list editors (aria-disabled at the ends, the focus kept). Plain
 * text in the course's language, never translated. A question's and an option's id is made here (newItemId) and never reused: an attempt refers
 * to a question by its id. A choice question switched to "Vaba vastusega" keeps its options in memory, so switching back brings them back. The
 * save's refusal shows in the card of the question it names (its option marked), or under the list for the list as a whole.
 */
export function TestEditor({ value, onChange, errors }: { value: TestDraft; onChange: (v: TestDraft) => void; errors: TestErrors }) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const focus = useRef<Focus>(null);
  const kept = useRef(new Map<string, ChoiceOption[]>());

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") {
      addBtn.current?.focus();
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
    setQuestions([...questions, newQuestion()]);
    focus.current = { question: questions.length };
  };
  const remove = (i: number) => {
    setQuestions(questions.filter((_, j) => j !== i));
    focus.current = questions.length > 1 ? { question: Math.min(i, questions.length - 2) } : "add";
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= questions.length) return;
    setQuestions(moveItem(questions, i, j));
  };
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
  const removeOption = (i: number, j: number) => {
    const q = questions[i];
    if (q.kind !== "choice" || q.options.length <= TEST_LIMITS.minOptions) return;
    setOptions(i, q.options.filter((_, k) => k !== j));
    focus.current = { question: i, option: Math.min(j, q.options.length - 2) };
  };

  // the save's refusal: in the card of the question it names, or for the list as a whole
  const at = errors.test ? errors.at : undefined;
  const listError = errors.test && (!at || at.index < 0 || at.index >= questions.length) ? errors.test : undefined;

  /** The pass mark or the tries: a short field of digits, as typed (the server parses it). */
  const setting = (key: "passPercent" | "tries", label: string, hint: string, error: string | undefined, maxLength: number) => {
    const id = `${uid}-${key}`;
    return (
      <div className={ui.field}>
        <label htmlFor={id}>{label}</label>
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
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
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
      aria-describedby={listError ? `${uid}-hint ${uid}-error` : `${uid}-hint`}
      data-invalid={listError ? "" : undefined}
      tabIndex={listError ? -1 : undefined}
    >
      <div className={ed.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {t.sections.test}
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
        <ol className={ed.rows}>
          {questions.map((q, i) => {
            const n = i + 1;
            const id = `${uid}-q${i}`;
            const error = errors.test && at && at.index === i ? errors.test : undefined;
            return (
              <li key={q.id} className={ed.item} data-question={i} data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined}>
                <span className={ed.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div className={styles.body}>
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
                          const marked = error !== undefined && at?.option === j;
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
                  <button type="button" className={ed.iconBtn} aria-label={fill(f.testUp, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)} data-question-up="">
                    ↑
                  </button>
                  <button
                    type="button"
                    className={ed.iconBtn}
                    aria-label={fill(f.testDown, { n })}
                    aria-disabled={i === questions.length - 1 || undefined}
                    onClick={() => move(i, 1)}
                    data-question-down=""
                  >
                    ↓
                  </button>
                  <button type="button" className={ed.iconBtn} aria-label={fill(f.testRemove, { n })} onClick={() => remove(i)} data-question-remove="">
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
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
