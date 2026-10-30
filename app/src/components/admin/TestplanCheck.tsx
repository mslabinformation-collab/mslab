"use client";

import { useId, useRef, useState, type MutableRefObject } from "react";
import { NOTE_MAX, type CheckState, type Status, type StoredAnswer, type StoredStatus, type TestItem } from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDayMonth, formatTime } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./TestPlan.module.css";

// One check of the test page (TestPlan.tsx), as admin UX pass piece 4c draws it (C7, P4 frame; S4-45): a row of the title (with the who, device and
// „Loob andmeid“ chips and „Ava ↗“ under it), „Sammud ▸“, which folds the steps, „Mida näed“ and „Miks“, and the two answers „Läbitud“ | „Viga“ as
// one segmented control. Under the row: the note box under every answer (Dim 22.10), the last answer, the one a redo has overtaken, and (Dim 25.10)
// Automaattest's note. A „Jäta vahele“ stored before the button went stays an answer (spec §10: the data stays): neither half is pressed, its last
// line names it, and a note typed on it keeps it.
// Admin polish Part A (Dim 29.10: "clear which tests are done and which need doing"): a marker before the title (an empty ring, a green ✓, a red ✕,
// with the state's word for a screen reader); the steps open on a check still to do and folded on a done or failed one; the pressed half pressed
// again takes the answer back, and so does „Võta vastus tagasi“ at the end of the last-answer line (the note goes with the answer); a double-click
// or double-tap on either half counts as its first click alone; Automaattest's result is a chip in the meta line. The state is TestPlan's
// (domain/testplan.ts sharedState): a check Automaattest alone passed is done, with no half pressed.
// Dim 30.10: the note box is under every check, answered or not (an answer taken back leaves it there, empty). A note typed on a check with no answer
// of hers is a note on its own (`onType("note", …)`): it changes no state, its last line ends „· Märkus“ with no take-back (emptying the box removes
// it), and no half is pressed. Automaattest's note alone is no result: no chip, only its „Automaattest: …“ line.

type Texts = typeof adminEt.testplan;

/** The two answers the row offers (spec §10: „Jäta vahele“ has no button any more). A note on its own is never one. */
const ANSWERS: readonly Status[] = ["ok", "bad"];
/** The marker's glyph (not read: the state's word is): an open check's ring is empty. */
const GLYPH: Record<CheckState["state"], string> = { open: "", done: "✓", failed: "✕" };

/** An answer's word: „Läbitud“, „Viga“, (stored before piece 4c) „Jäta vahele“, or (a note on its own, Dim 30.10) „Märkus“. */
const statusText = (t: Texts, status: StoredStatus): string => t[status];
/** A check's state in the page's words, for a screen reader: „Avatud“ (the „Olek“ pill's word without its number), „Läbitud“, „Viga“. */
const stateText = (t: Texts, state: CheckState["state"]): string => (state === "open" ? t.filter.open.replace(" {n}", "") : state === "done" ? t.ok : t.bad);

/**
 * Automaattest's answer to a check, for its chip (Dim 25.10, 29.10) and its note line; `overtaken`: a redo since then has made it one from before
 * the change. A note on its own (Dim 30.10) has no chip, only its line.
 */
export type AutoAnswer = { answer: StoredAnswer; overtaken: boolean };

/** An answer's instant as the page shows it: "dd.mm HH:MM", Tallinn time. */
const whenOf = (at: string): string => `${formatDayMonth(new Date(at), "et")} ${formatTime(new Date(at), "et")}`;

type CheckProps = {
  t: Texts;
  item: TestItem;
  /** The check's state (sharedState); `answer` and `overtaken` are a person's only (`answer` may be her note on its own, Dim 30.10). */
  st: CheckState;
  /** Automaattest's answer to this check, shown as a chip (null: none, or this is Automaattest's own page). */
  auto: AutoAnswer | null;
  /** The shown answer is one not sent yet (no "last answer" line: it is not the server's). */
  unsent: boolean;
  typed: string | undefined;
  /** The check whose note field takes the focus when it appears (set by a „Viga“ press). */
  focusAfterRef: MutableRefObject<string | null>;
  onPress(status: Status): void;
  /** Takes the answer back (Dim 29.10): the pressed half pressed again, or „Võta vastus tagasi“. */
  onTakeBack(): void;
  /** A note typed: on her answer's status, or "note" where she has none (or her note on its own: Dim 30.10). */
  onType(status: StoredStatus, value: string): void;
  onLeave(): void;
};

export function TestplanCheck({ t, item, st, auto, unsent, typed, focusAfterRef, onPress, onTakeBack, onType, onLeave }: CheckProps) {
  const uid = useId();
  /** The tester's own „Sammud ▸“ choice: once she makes one, it holds. */
  const [stepsPicked, setStepsPicked] = useState<boolean | null>(null);
  /**
   * Until she does (Dim 29.10, and the ruling on the review's Minor 6): open on a check still to do and folded on one done or failed when the
   * row appears; then a pass folds them and an answer taken back opens them, while a Viga leaves them as they are (she is about to write what
   * failed, and may want to read the steps while she does). `seen` is the state they were last set for (state kept from the render before).
   */
  const [stepsFor, setStepsFor] = useState({ seen: st.state, open: st.state === "open" });
  if (stepsFor.seen !== st.state) setStepsFor({ seen: st.state, open: st.state === "failed" ? stepsFor.open : st.state === "open" });
  const stepsOpen = stepsPicked ?? stepsFor.open;
  const halves = useRef<Partial<Record<Status, HTMLButtonElement | null>>>({});
  const answer = st.answer;
  /** Her answer, a verdict (null: none, or her note on its own, which is no answer to take back). */
  const verdict = answer && answer.status !== "note" ? answer : null;
  const titleId = `${uid}-title`;
  const stepsId = `${uid}-steps`;
  const when = answer && !unsent ? whenOf(answer.at) : "";
  /** „Võta vastus tagasi“: the line and the link go with the answer, so the focus stays in the row, on the half that was pressed (a Jäta vahele's: the first). */
  const takeBack = () => {
    const half = halves.current[answer?.status === "bad" ? "bad" : "ok"];
    onTakeBack();
    half?.focus();
  };

  return (
    <li id={item.id} className={styles.check} data-check={item.id} data-check-state={st.state}>
      <div className={styles.row} data-check-row="">
        <div className={styles.titleCell}>
          <h3 className={styles.checkTitle}>
            <span className={styles.marker} aria-hidden="true" data-check-marker={st.state}>
              {GLYPH[st.state]}
            </span>
            <span className={ui.sr} data-check-state-word="">
              {stateText(t, st.state)}
            </span>{" "}
            <span id={titleId} className={styles.titleText} data-check-title="">
              {item.title}
            </span>
          </h3>
          <div className={styles.meta} data-check-meta="">
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
            {auto && auto.answer.status !== "note" && (
              // Automaattest's result (Dim 29.10): green, red or grey; one from before a redo is grey and in the page's words (its note alone is
              // no result: no chip, Dim 30.10)
              <span className={`${styles.chip} ${styles.autoChip}`} data-check-auto={auto.overtaken ? "overtaken" : auto.answer.status}>
                {t.who.auto}: {auto.overtaken ? fill(t.overtaken, { status: statusText(t, auto.answer.status) }) : statusText(t, auto.answer.status)}
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
          onClick={() => setStepsPicked(!stepsOpen)}
          data-steps-toggle=""
        >
          {t.steps} <span className={styles.arrow} aria-hidden="true">▸</span>
        </button>
        <div className={styles.segmented} role="group" aria-labelledby={titleId}>
          {ANSWERS.map((status) => (
            <button
              key={status}
              ref={(el) => {
                halves.current[status] = el;
              }}
              type="button"
              className={styles.segment}
              aria-pressed={answer?.status === status}
              // (the pressed half pressed again takes the answer back, Dim 29.10. A double-click or a double-tap is one click: its second click,
              // `detail` 2 or more, is ignored on either half before anything else, as the first has already re-rendered the row; otherwise it would
              // undo the press it just made, or press again the half whose answer it just took back, with an empty note. Enter and Space click with
              // `detail` 0, review Minor 1 and the final review's Important 1)
              onClick={(e) => {
                if (e.detail > 1) return;
                if (answer?.status !== status) onPress(status);
                else onTakeBack();
              }}
              data-answer={status}
            >
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

      {/* the note: under every check, answered or not (Dim 30.10; under every answer since Dim 22.10). Her Viga asks what went wrong, anything
          else just says „Märkus“. Typed on her answer it is that answer's note; typed where she has none (open, Automaattest's ✓, a redo's old
          answer) or on her note it is a note on its own, which changes no state. */}
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
          placeholder={verdict?.status === "bad" ? t.notePrompt : t.note}
          maxLength={NOTE_MAX}
          value={typed ?? answer?.note ?? ""}
          onChange={(e) => onType(verdict ? verdict.status : "note", e.target.value)}
          onBlur={onLeave}
          data-check-note=""
        />
      </div>

      {answer && !unsent && (
        <p className={verdict ? styles.last : `${styles.last} ${styles.lastAlone}`}>
          {/* (a note on its own: „{name} · {when} · Märkus“, and no take-back: emptying the box removes it) */}
          <span data-check-last="">{fill(t.last, { name: answer.by, when, status: statusText(t, answer.status) })}</span>
          {verdict && (
            <button type="button" className={`${ui.link} ${styles.takeBack}`} aria-describedby={titleId} onClick={takeBack} data-take-back="">
              {t.takeBack}
            </button>
          )}
        </p>
      )}
      {st.overtaken && (
        <p className={styles.overtaken} data-overtaken="">
          {fill(t.overtaken, { status: statusText(t, st.overtaken.status) })}
        </p>
      )}
      {auto && auto.answer.note !== "" && (
        // Automaattest's note, under the row with its name (its result is the chip above)
        <p className={styles.autoNote}>
          <span className={styles.autoName}>{t.who.auto}:</span> <span data-check-auto-note="">{auto.answer.note}</span>
        </p>
      )}
    </li>
  );
}
