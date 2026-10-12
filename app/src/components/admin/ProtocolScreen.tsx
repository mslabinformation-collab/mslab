"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { PROTOCOL_LIMITS, type ProtocolStatus, type ScreenStudentView } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { GrowingText } from "./GrowingText";
import { SendAll, StudentSend } from "./ProtocolSend";
import { getScreen, keepReading, ProtocolAutosave, serverDraft, statusOf, type Conflict, type Entry, type ReadScreen, type SaveStatus, type ScreenSource } from "./protocol-autosave";
import ui from "./ui.module.css";
import styles from "./ProtocolScreen.module.css";

/** One student as the page hands her over: her protocol's draft, every date as text (domain/protocols.ts). */
export type { ScreenStudentView };

/**
 * The screen's students. `single`: one registration's screen (an individual course): its "Saada" is the primary button (Task 6). `source`: the
 * address the page was made from, which the screen reads its data from again (GET /api/admin/protokoll).
 */
export type ScreenView = { single: boolean; source: ScreenSource; students: ScreenStudentView[] };

type T = typeof adminEt.protocols;

const TONE: Record<Exclude<ProtocolStatus, "none">, string> = { draft: ui.warn, sent: ui.ok, changed: ui.bad };

/** The save's status line: "Salvestatud HH:MM" (Tallinn), the waiting states, and the failing ones (in the error colour). */
export function statusLine(s: SaveStatus, t: T): { text: string; failing: boolean } {
  switch (s.kind) {
    case "saved":
      return { text: s.at === null ? "" : fill(t.saved, { time: formatTime(new Date(s.at), "et") }), failing: false };
    case "checking":
      return { text: t.checking, failing: false };
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
 * shows read-only. The sends are ProtocolSend.tsx: "Lukusta ja saada kõik" above the students (the session's primary button), each student's
 * "Saada" / "Muuda" / "Saada uuesti" under her protocol. Leaving the page while a text is not confirmed asks first (it is in this browser
 * all the same). One student (an individual course, or a session with one): no list.
 * The browser's Back restores this page from the client router's copy of the visit's server render, older than what was saved since, and a tab
 * hidden for hours may come back as it was: so the screen never takes its text for the server's. It says "Kontrollin …" instead of "Salvestatud"
 * until it has read the server's text again (GET /api/admin/protokoll when the screen is shown, and when it comes back from the browser's cache, the
 * tab is shown or the network is back: protocol-autosave.ts keepReading), and the engine then reconciles each student with it (reconcile). `read` is
 * the reading, replaceable for the tests.
 */
export function ProtocolScreen({ view, read = getScreen }: { view: ScreenView; read?: ReadScreen }) {
  const t = adminEt.protocols;
  const [engine] = useState(() => {
    const made = new ProtocolAutosave(view.students.map(serverDraft));
    made.awaitFresh();
    return made;
  });
  useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  // the students: the page's, and the server's when the screen has read it again (a student added or cancelled meanwhile)
  const [students, setStudents] = useState(view.students);
  const [source] = useState(view.source); // (where it reads from again: the address the page was made from)
  const [selected, setSelected] = useState(view.students[0]?.registrationId ?? 0);
  // "Muuda" pressed: these sent protocols are open on this screen (spec §3: only the screen unlocks; the first saved edit raises the version)
  const [unlocked, setUnlocked] = useState<ReadonlySet<number>>(() => new Set());
  const unlock = (id: number, on: boolean) =>
    setUnlocked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const names = new Map(students.map((s) => [s.registrationId, s.name]));

  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null; // blocked storage: the autosave still works; only a reload could not resume a text not saved yet
    }
    engine.start(storage);
    engine.awaitFresh();
    const reading = keepReading(engine, source, read, setStudents);
    const warn = (e: BeforeUnloadEvent) => {
      if (engine.unsaved()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      reading.stop();
      engine.stop();
    };
  }, [engine, source, read]);

  const choose = (id: number) => {
    if (id === open) return;
    void engine.save(open); // in the background: switching never waits for it
    setSelected(id);
  };
  // (a render that dropped the open student, a registration cancelled meanwhile: the first one is shown)
  const open = students.some((s) => s.registrationId === selected) ? selected : (students[0]?.registrationId ?? 0);
  const entry = engine.get(open);
  const student = students.find((s) => s.registrationId === open);
  const list = students.length > 1;

  return (
    <div className={styles.screen} data-protocol-screen="">
      {!view.single && <SendAll engine={engine} names={names} onSent={(id) => unlock(id, false)} />}
      <div className={list ? `${styles.layout} ${styles.withList}` : styles.layout}>
        {list && (
          <nav className={styles.students} aria-label={t.students} data-students="">
            {students.map((s) => {
              const e = engine.get(s.registrationId);
              if (!e) return null;
              const status = statusOf(e);
              return (
                <button
                  key={s.registrationId}
                  type="button"
                  className={styles.student}
                  aria-pressed={s.registrationId === open}
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
        {entry && student && (
          <StudentEditor
            key={entry.registrationId}
            engine={engine}
            entry={entry}
            name={student.name}
            primary={view.single}
            unlocked={unlocked.has(entry.registrationId)}
            onUnlock={(on) => unlock(entry.registrationId, on)}
          />
        )}
      </div>
    </div>
  );
}

/** One student's protocol: her name and the save's status, a conflict's notice, the practice part's boxes, the general notes. */
function StudentEditor({
  engine,
  entry,
  name,
  primary,
  unlocked,
  onUnlock,
}: {
  engine: ProtocolAutosave;
  entry: Entry;
  name: string;
  primary: boolean;
  unlocked: boolean;
  onUnlock(on: boolean): void;
}) {
  const t = adminEt.protocols;
  const uid = useId();
  const id = entry.registrationId;
  // a sent protocol is read-only until "Muuda"
  const locked = statusOf(entry) === "sent" && !unlocked;
  // read-only while it is sent, and while a send is on its way (its text must stay the one sent)
  const frozen = locked || entry.sending;
  const line = statusLine(entry.status, t);
  const sentAt = entry.sentAt ? new Date(entry.sentAt) : null;
  // "Muuda" pressed: its button is gone (the hint takes its place), so the focus goes to the first box, or to the general notes when the
  // course has no headings; a screen opened again with the protocol already open takes no focus
  const section = useRef<HTMLElement>(null);
  const wasUnlocked = useRef(unlocked);
  useEffect(() => {
    if (unlocked && !wasUnlocked.current) section.current?.querySelector("textarea")?.focus();
    wasUnlocked.current = unlocked;
  }, [unlocked]);

  return (
    <section ref={section} className={styles.editor} aria-labelledby={`${uid}-name`} data-editor={id}>
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
      <StudentSend engine={engine} id={id} primary={primary} unlocked={unlocked} onUnlock={onUnlock} />
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
