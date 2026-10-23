"use client";

import { Fragment, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { Verdict } from "@/db/schema";
import type { PracticalStatus } from "@/domain/completion";
import type { AssessmentView } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { AssessmentSend } from "./AssessmentSend";
import { AssessmentStage } from "./AssessmentStage";
import { PhotoViewer, type Photo } from "./PhotoViewer";
import { ProtocolScreen, type EditorState, type ScreenView } from "./ProtocolScreen";
import { getScreen, readStudents, type Entry, type ReadScreen, type ScreenSource } from "./protocol-autosave";
import { isVerdicts, postVerdict, VerdictTaps, type PostVerdict, type TapsResult } from "./verdict-taps";
import ui from "./ui.module.css";
import styles from "./Assessment.module.css";

const photoOf = (p: unknown): boolean => typeof p === "object" && p !== null && ["id", "round", "width", "height"].every((k) => typeof (p as Record<string, unknown>)[k] === "number");

/** A read's practical work (server/protocols.ts handleRead: domain/protocols.ts AssessmentView), checked field by field; null for anything else. */
export function readAssessment(value: unknown): AssessmentView | null {
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  const good =
    typeof a.accessId === "number" &&
    typeof a.clientId === "number" &&
    typeof a.email === "string" &&
    (a.status === "open" || a.status === "review" || a.status === "fix" || a.status === "passed") &&
    typeof a.round === "number" &&
    (a.submittedAt === null || typeof a.submittedAt === "string") &&
    isVerdicts(a.verdicts) &&
    (a.sentVerdicts === null || isVerdicts(a.sentVerdicts)) &&
    Array.isArray(a.photos) &&
    a.photos.every((point) => Array.isArray(point) && point.every(photoOf)) &&
    typeof a.locked === "boolean" &&
    typeof a.expiresAt === "string";
  return good ? (value as AssessmentView) : null;
}

const TONE: Record<PracticalStatus, string> = { open: "", review: ui.warn, fix: ui.bad, passed: ui.ok };

/**
 * Maria's assessment of one e-course access's practical work (phase e-course completion, spec §5.3; admin UX pass README A4): the protocol screen
 * (ProtocolScreen, single, its autosave's owner the access) laid out as the Part 2 prototype draws it. The header (`head`): the student as the H1,
 * a meta line (the course, the round, the day she sent it, the status) and the SaveStatus chip. The action bar (`sendBar`, AssessmentSend):
 * "{n} punkti · {k} hinnatud", „Kinnita kõik“ and the informed send „Saada hinnang · {k} kinnitatud, {p} paranda“, which has no confirmation.
 * Then a card for each point (`stage`, AssessmentStage): its photos, title, the segmented verdict and its comment; and the full-screen viewer
 * (PhotoViewer). The verdicts are this screen's (verdict-taps.ts: each tap stored at once, R2), not the autosave's. The screen's reads (`read`,
 * the same GET as the notes') bring the practical work too: the photos, the verdicts, the status and the round of a new submission (R3) are taken
 * from each, so the round line ("Praktiline töö, 2. kord") follows them. Every tap and the send name the round the screen shows; a tap the server
 * finds of an older round ("stale": the student sent a new one meanwhile) is read again and the line says so. An e-course without points is the
 * plain notes protocol with its "Saada". `course` (the course's title) and `expired` (the line of an access that has ended) come from the page;
 * `read` and `post` are replaceable for the tests.
 */
export function AssessmentScreen({
  view,
  read = getScreen,
  post = postVerdict,
  course,
  expired,
}: {
  view: ScreenView;
  read?: ReadScreen;
  post?: PostVerdict;
  course?: string;
  expired?: string;
}) {
  const s = adminEt.assessment.screen;
  const first = view.students[0];
  const [assessment, setAssessment] = useState<AssessmentView | null>(first?.assessment ?? null);
  /** The practical work as the last read or send left it, for a send's check that runs after an await (AssessmentSend's `current`). */
  const latest = useRef<AssessmentView | null>(first?.assessment ?? null);
  const [taps] = useState(() => new VerdictTaps(first?.registrationId ?? 0, first?.assessment?.verdicts ?? [], first?.assessment?.round ?? 0, post));
  useSyncExternalStore(taps.subscribe, taps.snapshot, taps.snapshot);
  const [viewer, setViewer] = useState<{ photos: readonly Photo[]; index: number; label: string; from: HTMLElement } | null>(null);
  /** The height of the send's dock on a phone (it is fixed to the bottom there); the screen keeps a padding as tall, so nothing is covered. */
  const [dock, setDock] = useState(0);
  // the screen's own read, its answer's practical work taken on the way (one stable function: the screen restarts its reading for a new one)
  const [reader] = useState<ReadScreen>(() => async (source: ScreenSource) => {
    const answer = await read(source);
    const next = answer && answer.status === 200 ? readAssessment(readStudents(answer.body)?.[0]?.assessment) : null;
    if (next) {
      taps.take(next.verdicts, next.round);
      latest.current = next;
      setAssessment(next);
    }
    return answer;
  });

  if (!assessment) return <ProtocolScreen view={view} read={reader} />; // (an access's page always hands it over)
  const notesOnly = (first?.titles.length ?? 0) === 0;
  const roundLine = notesOnly ? s.notesOnly : assessment.round === 0 ? s.notSubmitted : fill(s.round, { n: assessment.round });
  const sentAt = !notesOnly && assessment.submittedAt ? new Date(assessment.submittedAt) : null;

  const onSent = (status: PracticalStatus | null, verdicts: (Verdict | null)[]) => {
    const a = latest.current;
    if (status === null || !a) return;
    taps.take(verdicts, taps.round);
    latest.current = { ...a, status, locked: status === "passed", verdicts, sentVerdicts: verdicts };
    setAssessment(latest.current);
  };

  /** What a tap (or „Kinnita kõik“) came to: refused, or of an older round, the work changed meanwhile: read again and shown, and said. */
  const afterTaps = (state: EditorState, result: TapsResult) => {
    if (result !== "refused" && result !== "stale") return;
    state.engine.recheck(state.entry.registrationId);
    state.engine.setSendError(state.entry.registrationId, result === "stale" ? s.errors.newRound : s.errors.verdictRefused);
  };

  const head = (chip: ReactNode, nameId: string) => {
    const parts: { key: string; node: ReactNode }[] = [];
    if (course) parts.push({ key: "course", node: <span data-assess-course="">{course}</span> });
    parts.push({ key: "round", node: <span data-assess-round="">{roundLine}</span> });
    if (sentAt)
      parts.push({
        key: "sent",
        node: <span data-assess-sent-at="">{fill(adminEt.assessment.sentAt, { date: `${formatDate(sentAt, "et")} ${formatTime(sentAt, "et")}` })}</span>,
      });
    if (!notesOnly)
      parts.push({
        key: "status",
        node: (
          <span className={`${ui.tag} ${TONE[assessment.status]}`} data-assess-status={assessment.status}>
            {s.status[assessment.status]}
          </span>
        ),
      });
    return (
      <>
        <div className={styles.head} data-assess-head="">
          <div className={styles.title}>
            <h1 id={nameId} className={styles.name}>
              {first?.name}
            </h1>
            <p className={styles.meta}>
              {parts.map((part, i) => (
                <Fragment key={part.key}>
                  {i > 0 && <span aria-hidden="true">·</span>}
                  {part.node}
                </Fragment>
              ))}
            </p>
          </div>
          <div className={styles.chip}>{chip}</div>
        </div>
        {expired && (
          <p className={ui.notice} data-access-expired="">
            {expired}
          </p>
        )}
      </>
    );
  };

  const stage = (i: number, state: EditorState) => {
    const id = state.entry.registrationId;
    const protocolId = state.entry.protocolId;
    return (
      <AssessmentStage
        index={i}
        title={state.entry.titles[i] ?? ""}
        photos={assessment.photos[i] ?? []}
        verdict={taps.shown(i)}
        unsaved={taps.unsaved(i)}
        disabled={assessment.status === "open" || assessment.locked || state.frozen || protocolId === null}
        note={state.entry.content.notes[i] ?? ""}
        readOnly={state.frozen}
        onNote={(value) => state.engine.editNote(id, i, value)}
        onNoteBlur={() => void state.engine.save(id)}
        onVerdict={(verdict) => {
          if (protocolId === null) return;
          state.engine.setSendError(id, null);
          void taps.tap(protocolId, i, verdict).then((result) => afterTaps(state, result));
        }}
        onOpen={(photos, index, from) => setViewer({ photos, index, from, label: fill(s.viewer, { point: i + 1, title: state.entry.titles[i] ?? "" }) })}
      />
    );
  };
  const sendBar = (_entry: Entry, state: EditorState) => (
    <AssessmentSend
      state={state}
      assessment={assessment}
      current={() => latest.current}
      taps={taps}
      onSent={onSent}
      onApproveAll={() => {
        const protocolId = state.entry.protocolId;
        if (protocolId === null) return;
        state.engine.setSendError(state.entry.registrationId, null);
        void taps.approveAll(protocolId, state.entry.titles.length).then((result) => {
          afterTaps(state, result);
          // taps with no answer: every point looks approved, so the bar says that they are not stored (a single tap shows it on its card only)
          if (result === "unsaved") state.engine.setSendError(state.entry.registrationId, s.errors.unsavedVerdicts);
        });
      }}
      onDock={setDock}
    />
  );

  return (
    <div className={styles.screen} style={{ "--dock-h": `${dock}px` } as CSSProperties} data-assessment-screen="">
      <ProtocolScreen view={view} read={reader} head={head} stage={notesOnly ? undefined : stage} sendBar={sendBar} opened={!notesOnly && assessment.status === "review"} />
      {viewer && (
        <PhotoViewer
          photos={viewer.photos}
          index={viewer.index}
          label={viewer.label}
          returnTo={viewer.from}
          onIndex={(index) => setViewer((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
