"use client";

import { useId, useState, type MutableRefObject } from "react";
import { NOTE_MAX, type CheckState, type Status, type StoredAnswer, type TestItem } from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDayMonth, formatTime } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./TestPlan.module.css";

// One check of the test page (TestPlan.tsx), as admin UX pass piece 4c draws it (C7, P4 frame; S4-45): a row of the title (with the who, device and
// „Loob andmeid“ chips and „Ava ↗“ under it), „Sammud ▸“, which folds the steps, „Mida näed“ and „Miks“, and the two answers „Läbitud“ | „Viga“ as
// one segmented control. Under the row: the note box under every answer (Dim 22.10), the last answer, the one a redo has overtaken, and (Dim 25.10)
// Automaattest's answer apart. A „Jäta vahele“ stored before the button went stays an answer (spec §10: the data stays): neither half is pressed,
// its last line names it, and a note typed on it keeps it.

type Texts = typeof adminEt.testplan;

/** The two answers the row offers (spec §10: „Jäta vahele“ has no button any more). */
const ANSWERS: readonly Status[] = ["ok", "bad"];

/** An answer's word: „Läbitud“, „Viga“ or (stored before piece 4c) „Jäta vahele“. */
const statusText = (t: Texts, status: Status): string => t[status];

/** Automaattest's answer to a check, for its quiet line (Dim 25.10); `overtaken`: a redo since then has made it one from before the change. */
export type AutoLine = { answer: StoredAnswer; overtaken: boolean };

/** An answer's instant as the page shows it: "dd.mm HH:MM", Tallinn time. */
const whenOf = (at: string): string => `${formatDayMonth(new Date(at), "et")} ${formatTime(new Date(at), "et")}`;

type CheckProps = {
  t: Texts;
  item: TestItem;
  st: CheckState;
  /** Automaattest's answer to this check, shown apart under it (null: none, or this is Automaattest's own page). */
  auto: AutoLine | null;
  /** The shown answer is one not sent yet (no "last answer" line: it is not the server's). */
  unsent: boolean;
  typed: string | undefined;
  /** The check whose note field takes the focus when it appears (set by a „Viga“ press). */
  focusAfterRef: MutableRefObject<string | null>;
  onPress(status: Status): void;
  onType(status: Status, value: string): void;
  onLeave(): void;
};

export function TestplanCheck({ t, item, st, auto, unsent, typed, focusAfterRef, onPress, onType, onLeave }: CheckProps) {
  const uid = useId();
  const [stepsOpen, setStepsOpen] = useState(false);
  const answer = st.answer;
  const titleId = `${uid}-title`;
  const stepsId = `${uid}-steps`;
  const when = answer && !unsent ? whenOf(answer.at) : "";

  return (
    <li id={item.id} className={styles.check} data-check={item.id} data-check-state={st.state}>
      <div className={styles.row}>
        <div className={styles.titleCell}>
          <h3 id={titleId} className={styles.checkTitle}>
            {item.title}
          </h3>
          <div className={styles.meta}>
            <span className={styles.chip} data-chip="">
              {t.who[item.who]}
            </span>
            {item.device !== "any" && (
              <span className={styles.chip} data-chip="">
                {t.device[item.device]}
              </span>
            )}
            {item.writes && (
              <span className={`${styles.chip} ${styles.writes}`} data-chip="">
                {t.writes}
              </span>
            )}
            {item.href && (
              <a className={styles.open} href={item.href} target="_blank" rel="noopener" data-open="">
                {t.open} <span aria-hidden="true">↗</span>
                <span className={ui.sr}> ({adminEt.shell.newWindow})</span>
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          className={styles.stepsToggle}
          aria-expanded={stepsOpen}
          aria-controls={stepsId}
          aria-describedby={titleId}
          onClick={() => setStepsOpen((open) => !open)}
          data-steps-toggle=""
        >
          {t.steps} <span className={styles.arrow} aria-hidden="true">▸</span>
        </button>
        <div className={styles.segmented} role="group" aria-labelledby={titleId}>
          {ANSWERS.map((status) => (
            <button key={status} type="button" className={styles.segment} aria-pressed={answer?.status === status} onClick={() => onPress(status)} data-answer={status}>
              {t[status]}
            </button>
          ))}
        </div>
      </div>

      <div id={stepsId} className={styles.fold} hidden={!stepsOpen} data-steps="">
        <ol className={styles.steps}>
          {item.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p className={styles.foldLabel}>{t.expect}</p>
        <ul className={styles.expect}>
          {item.expect.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <p className={styles.foldLabel}>{t.why}</p>
        <p className={styles.why}>{item.why}</p>
      </div>

      {answer && (
        // the note: open under every answer (Dim 22.10); a check with no answer has nothing to write a note on. A Viga asks what went wrong, any other answer just says „Märkus“.
        <div className={styles.noteBox}>
          <textarea
            ref={(el) => {
              if (el && focusAfterRef.current === item.id) {
                focusAfterRef.current = null;
                el.focus();
              }
            }}
            className={`${ui.textarea} ${styles.note}`}
            aria-label={t.note}
            placeholder={answer.status === "bad" ? t.notePrompt : t.note}
            maxLength={NOTE_MAX}
            value={typed ?? answer.note}
            onChange={(e) => onType(answer.status, e.target.value)}
            onBlur={onLeave}
            data-check-note=""
          />
        </div>
      )}

      {answer && !unsent && (
        <p className={styles.last} data-check-last="">
          {fill(t.last, { name: answer.by, when, status: statusText(t, answer.status) })}
        </p>
      )}
      {st.overtaken && (
        <p className={styles.overtaken} data-overtaken="">
          {fill(t.overtaken, { status: statusText(t, st.overtaken.status) })}
        </p>
      )}
      {auto && (
        // Automaattest's answer: never this tester's, so it fills no button, no note and no count; one from before a redo says so in the page's words
        <div className={styles.auto}>
          <p data-check-auto="">
            {t.who.auto}: {auto.overtaken ? fill(t.overtaken, { status: statusText(t, auto.answer.status) }) : statusText(t, auto.answer.status)} · {whenOf(auto.answer.at)}
          </p>
          {auto.answer.note !== "" && (
            <p className={styles.autoNote} data-check-auto-note="">
              {auto.answer.note}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
