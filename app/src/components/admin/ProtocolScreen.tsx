"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { PROTOCOL_LIMITS, type ProtocolStatus } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { GrowingText } from "./GrowingText";
import { ProtocolAutosave, statusOf, type Conflict, type Entry, type SaveStatus, type ServerDraft } from "./protocol-autosave";
import ui from "./ui.module.css";
import styles from "./ProtocolScreen.module.css";

/** One student as the page hands her over: her protocol's draft, every date as text. */
export type ScreenStudentView = {
  registrationId: number;
  name: string;
  /** Her registration waits for its prepayment: "ootab ettemaksu". */
  awaiting: boolean;
  version: number;
  titles: string[];
  notes: string[];
  generalNote: string;
  sentVersion: number | null;
  sentAt: string | null;
  savedAt: string | null;
};

/** The screen's students. `single`: one registration's screen (an individual course): its "Saada" is the primary button (Task 6). */
export type ScreenView = { single: boolean; students: ScreenStudentView[] };

type T = typeof adminEt.protocols;

const TONE: Record<Exclude<ProtocolStatus, "none">, string> = { draft: ui.warn, sent: ui.ok, changed: ui.bad };

const serverDraft = (s: ScreenStudentView): ServerDraft => ({
  registrationId: s.registrationId,
  version: s.version,
  titles: s.titles,
  content: { notes: s.notes, generalNote: s.generalNote },
  sentVersion: s.sentVersion,
  sentAt: s.sentAt,
  savedAt: s.savedAt === null ? null : Date.parse(s.savedAt),
});

/** The save's status line: "Salvestatud HH:MM" (Tallinn), the waiting states, and the failing ones (in the error colour). */
export function statusLine(s: SaveStatus, t: T): { text: string; failing: boolean } {
  switch (s.kind) {
    case "saved":
      return { text: s.at === null ? "" : fill(t.saved, { time: formatTime(new Date(s.at), "et") }), failing: false };
    case "pending":
      return { text: t.pending, failing: false };
    case "saving":
      return { text: t.saving, failing: false };
    case "retrying":
      return { text: t.retrying, failing: true };
    case "tooLong":
      return { text: t.tooLongStatus, failing: true };
    case "signedOut":
      return { text: t.signedOut, failing: true };
    case "gone":
      return { text: t.gone, failing: true };
  }
}

/**
 * The course day's protocols (spec §4): the students — a column on the left on a wide screen, a row of chips across the top on a narrow one
 * (a container query: the 1194 px tablet and wider get the column, the 834 px tablet upright and a phone the chips) — each with her status
 * mark (Mustand, Saadetud, Muudetud; none before the first save), "ootab ettemaksu" while her prepayment is not in, and "Salvestamata"
 * while her text is not confirmed; and the selected student's protocol: the practice part (each heading with a box that grows with its
 * text), then "Üldised märkused". Switching student is one tap: the one left saves in the background at once, never waited for; a student
 * whose boxes were never typed in is never saved (a first save creates the protocol). The autosave is protocol-autosave.ts; a sent protocol
 * shows read-only. Leaving the page while a text is not confirmed asks first (it is in this browser all the same). One student (an
 * individual course, or a session with one): no list.
 */
export function ProtocolScreen({ view }: { view: ScreenView }) {
  const t = adminEt.protocols;
  const [engine] = useState(() => new ProtocolAutosave(view.students.map(serverDraft)));
  useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const [selected, setSelected] = useState(view.students[0]?.registrationId ?? 0);

  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null; // blocked storage: the autosave still works; only a reload could not resume a text not saved yet
    }
    engine.start(storage);
    const warn = (e: BeforeUnloadEvent) => {
      if (engine.unsaved()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      engine.stop();
    };
  }, [engine]);

  const choose = (id: number) => {
    if (id === selected) return;
    void engine.save(selected); // in the background: switching never waits for it
    setSelected(id);
  };
  const entry = engine.get(selected);
  const student = view.students.find((s) => s.registrationId === selected);
  const list = view.students.length > 1;

  return (
    <div className={styles.screen} data-protocol-screen="">
      <div className={list ? `${styles.layout} ${styles.withList}` : styles.layout}>
        {list && (
          <nav className={styles.students} aria-label={t.students} data-students="">
            {view.students.map((s) => {
              const e = engine.get(s.registrationId)!;
              const status = statusOf(e);
              return (
                <button
                  key={s.registrationId}
                  type="button"
                  className={styles.student}
                  aria-pressed={s.registrationId === selected}
                  onClick={() => choose(s.registrationId)}
                  data-student={s.registrationId}
                  data-status={status}
                >
                  <span className={styles.studentName}>{s.name}</span>
                  <span className={styles.marks}>
                    {status !== "none" && (
                      <span className={`${ui.tag} ${TONE[status]}`} data-mark="">
                        {t.mark[status]}
                      </span>
                    )}
                    {s.awaiting && <span className={styles.awaiting}>{t.awaiting}</span>}
                    {engine.unconfirmed(s.registrationId) && (
                      <span className={styles.unsaved} data-unsaved="">
                        {t.unsavedMark}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
        {entry && student && <StudentEditor key={entry.registrationId} engine={engine} entry={entry} name={student.name} />}
      </div>
    </div>
  );
}

/** One student's protocol: her name and the save's status, a conflict's notice, the practice part's boxes, the general notes. */
function StudentEditor({ engine, entry, name }: { engine: ProtocolAutosave; entry: Entry; name: string }) {
  const t = adminEt.protocols;
  const uid = useId();
  const id = entry.registrationId;
  const locked = statusOf(entry) === "sent";
  // read-only while it is sent, and while a send is on its way (its text must stay the one sent)
  const frozen = locked || entry.sending;
  const line = statusLine(entry.status, t);
  const sentAt = entry.sentAt ? new Date(entry.sentAt) : null;

  return (
    <section className={styles.editor} aria-labelledby={`${uid}-name`} data-editor={id}>
      <div className={styles.editorHead}>
        <h2 id={`${uid}-name`} className={ui.h2}>
          {name}
        </h2>
        <p role="status" className={line.failing ? ui.error : ui.hint} data-save-status={entry.status.kind}>
          {line.text}
        </p>
      </div>
      {entry.conflict && <ConflictNotice conflict={entry.conflict} onDismiss={() => engine.dismissConflict(id)} />}
      {!entry.kept && (
        <p className={ui.error} role="alert" data-not-kept="">
          {t.notKept}
        </p>
      )}
      {locked && sentAt && (
        <p className={ui.notice} data-locked="">
          {fill(t.locked, { date: `${formatDate(sentAt, "et")} ${formatTime(sentAt, "et")}` })}
        </p>
      )}
      <div className={styles.part}>
        <h3 className={ui.h3}>{t.practice}</h3>
        {entry.titles.length === 0 && <p className={ui.hint}>{t.noStages}</p>}
        {entry.titles.map((title, i) => (
          <NoteBox
            key={i}
            id={`${uid}-note-${i}`}
            label={title}
            value={entry.content.notes[i] ?? ""}
            readOnly={frozen}
            note={i}
            onChange={(v) => engine.editNote(id, i, v)}
            onBlur={() => void engine.save(id)}
          />
        ))}
      </div>
      <div className={styles.part}>
        <NoteBox id={`${uid}-general`} label={t.general} heading value={entry.content.generalNote} readOnly={frozen} onChange={(v) => engine.editGeneral(id, v)} onBlur={() => void engine.save(id)} />
      </div>
    </section>
  );
}

/**
 * One box with its label (a stage's heading, or "Üldised märkused" as a heading of its own). Over 10 000 characters the box keeps every
 * character and says how many it has, and nothing is sent until it is shorter (the autosave's rule).
 */
function NoteBox({
  id,
  label,
  value,
  readOnly,
  onChange,
  onBlur,
  note,
  heading = false,
}: {
  id: string;
  label: string;
  value: string;
  readOnly: boolean;
  onChange(value: string): void;
  onBlur(): void;
  /** The stage's index (data-note); none: the general notes (data-general). */
  note?: number;
  heading?: boolean;
}) {
  const t = adminEt.protocols;
  const over = value.length > PROTOCOL_LIMITS.note;
  return (
    <div className={ui.field}>
      <label htmlFor={id} className={heading ? styles.generalLabel : undefined}>
        {label}
      </label>
      <GrowingText
        id={id}
        className={`${ui.textarea} ${styles.note}`}
        value={value}
        readOnly={readOnly}
        aria-invalid={over || undefined}
        aria-describedby={over ? `${id}-long` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        data-note={note}
        data-general={note === undefined ? "" : undefined}
      />
      {over && (
        <p id={`${id}-long`} className={ui.error} data-note-long="">
          {fill(t.tooLong, { n: value.length, max: PROTOCOL_LIMITS.note })}
        </p>
      )}
    </div>
  );
}

/** Another device saved first (spec §4): the short notice, and this screen's text that could not be saved, to copy what is still wanted. */
function ConflictNotice({ conflict, onDismiss }: { conflict: Conflict; onDismiss(): void }) {
  const t = adminEt.protocols;
  const lost = conflict.lost;
  return (
    <div className={`${ui.notice} ${styles.conflict}`} role="alert" data-conflict="">
      <p>{t.conflict}</p>
      {lost && (
        <details open className={styles.lost}>
          <summary>{t.conflictLost}</summary>
          {conflict.titles.map((title, i) =>
            (lost.notes[i] ?? "").trim() ? (
              <div key={i} className={styles.lostPart}>
                <strong>{title}</strong>
                <p className={styles.lostText}>{lost.notes[i]}</p>
              </div>
            ) : null,
          )}
          {lost.generalNote.trim() && (
            <div className={styles.lostPart}>
              <strong>{t.general}</strong>
              <p className={styles.lostText}>{lost.generalNote}</p>
            </div>
          )}
        </details>
      )}
      <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={onDismiss} data-conflict-dismiss="">
        {t.dismiss}
      </button>
    </div>
  );
}
