"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import type { Verdict } from "@/db/schema";
import type { PracticalStatus } from "@/domain/completion";
import type { AssessmentView } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { AssessmentSend } from "./AssessmentSend";
import { AssessmentStage } from "./AssessmentStage";
import { PhotoViewer, type Photo } from "./PhotoViewer";
import { ProtocolScreen, type EditorState, type ScreenView } from "./ProtocolScreen";
import { getScreen, readStudents, type Entry, type ReadScreen, type ScreenSource } from "./protocol-autosave";
import { isVerdicts, postVerdict, VerdictTaps, type PostVerdict } from "./verdict-taps";
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
 * Maria's assessment of one e-course access's practical work (phase e-course completion, spec §5.3): the protocol screen (ProtocolScreen,
 * single, its autosave's owner the access) with, under each point's heading, its photos and verdict buttons (AssessmentStage), "Saada
 * hinnang" instead of the course day's sends (AssessmentSend), the round and the status above, and the full-screen viewer (PhotoViewer). The
 * verdicts are this screen's (verdict-taps.ts: each tap stored at once, R2), not the autosave's. The screen's reads (`read`, the same GET as the
 * notes') bring the practical work too: the photos, the verdicts, the status and the round of a new submission (R3) are taken from each, so the
 * round line ("Praktiline töö, 2. kord") follows them. Every tap and the send name the round the screen shows; a tap the server finds of an older
 * round ("stale": the student sent a new one meanwhile) is read again and the line says so. An e-course without points is the plain notes
 * protocol with its "Saada". `read` and `post` are replaceable for the tests.
 */
export function AssessmentScreen({ view, read = getScreen, post = postVerdict }: { view: ScreenView; read?: ReadScreen; post?: PostVerdict }) {
  const s = adminEt.assessment.screen;
  const first = view.students[0];
  const [assessment, setAssessment] = useState<AssessmentView | null>(first?.assessment ?? null);
  /** The practical work as the last read or send left it, for a send's check that runs after an await (AssessmentSend's `current`). */
  const latest = useRef<AssessmentView | null>(first?.assessment ?? null);
  const [taps] = useState(() => new VerdictTaps(first?.registrationId ?? 0, first?.assessment?.verdicts ?? [], first?.assessment?.round ?? 0, post));
  useSyncExternalStore(taps.subscribe, taps.snapshot, taps.snapshot);
  const [viewer, setViewer] = useState<{ photos: readonly Photo[]; index: number; label: string; from: HTMLElement } | null>(null);
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

  const onSent = (status: PracticalStatus | null, verdicts: (Verdict | null)[]) => {
    const a = latest.current;
    if (status === null || !a) return;
    taps.take(verdicts, taps.round);
    latest.current = { ...a, status, locked: status === "passed", verdicts, sentVerdicts: verdicts };
    setAssessment(latest.current);
  };

  const stageExtra = (i: number, state: EditorState) => {
    const id = state.entry.registrationId;
    const protocolId = state.entry.protocolId;
    return (
      <AssessmentStage
        index={i}
        photos={assessment.photos[i] ?? []}
        verdict={taps.shown(i)}
        unsaved={taps.unsaved(i)}
        disabled={assessment.status === "open" || assessment.locked || state.frozen || protocolId === null}
        onVerdict={(verdict) => {
          if (protocolId === null) return;
          state.engine.setSendError(id, null);
          void taps.tap(protocolId, i, verdict).then((result) => {
            if (result !== "refused" && result !== "stale") return;
            // the work changed meanwhile (the student's new round, approved on another device): read again and shown
            state.engine.recheck(id);
            state.engine.setSendError(id, result === "stale" ? s.errors.newRound : s.errors.verdictRefused);
          });
        }}
        onOpen={(photos, index, from) => setViewer({ photos, index, from, label: fill(s.viewer, { point: i + 1, title: state.entry.titles[i] ?? "" }) })}
      />
    );
  };
  const sendBar = (_entry: Entry, state: EditorState) => (
    <AssessmentSend state={state} assessment={assessment} current={() => latest.current} taps={taps} onSent={onSent} />
  );

  return (
    <div className={styles.screen} data-assessment-screen="">
      <p className={styles.statusLine}>
        <span className={ui.lead} data-assess-round="">
          {roundLine}
        </span>
        {!notesOnly && (
          <span className={`${ui.tag} ${TONE[assessment.status]}`} data-assess-status={assessment.status}>
            {s.status[assessment.status]}
          </span>
        )}
      </p>
      <ProtocolScreen view={view} read={reader} stageExtra={notesOnly ? undefined : stageExtra} sendBar={sendBar} opened={!notesOnly && assessment.status === "review"} />
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
