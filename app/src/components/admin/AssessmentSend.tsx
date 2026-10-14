"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Verdict } from "@/db/schema";
import type { PracticalStatus } from "@/domain/completion";
import type { AssessmentView } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { sendAssessmentAction } from "@/server/actions/admin-assessment";
import type { AssessmentResult } from "@/server/assessment";
import type { EditorState } from "./ProtocolScreen";
import { bounded, unsavedMessage } from "./ProtocolSend";
import { sameContent, statusOf, unsavedEntry, written, type Content } from "./protocol-autosave";
import type { VerdictTaps } from "./verdict-taps";
import ui from "./ui.module.css";
import screen from "./ProtocolScreen.module.css";

// The send of Maria's assessment screen (phase e-course completion, spec §5.3, §8; R2, R3): "Saada hinnang" with one confirmation, or, for an
// e-course without points, the notes-only protocol's "Saada" as a contact course's (no confirmation). Like ProtocolSend.tsx's StudentSend, the
// send saves the notes first and sends the version the server confirmed, read-only meanwhile; and before it every verdict tap must be stored
// (verdict-taps.ts flush), so the student gets exactly what Maria sees. The send names the student's round the screen shows: a new round sent
// meanwhile (R3 leaves the version) is "stale", read and shown, never approved unseen. This file runs on old iPads: no lookbehind here or in what
// it imports.

type S = typeof adminEt.assessment.screen;
type T = typeof adminEt.protocols;
type Outcome = AssessmentResult | { kind: "failed" };

/** Points (0-based) in Maria's words: "2, 4". */
const list = (points: readonly number[]): string => points.map((i) => i + 1).join(", ");

/** Two verdict lists alike point by point (none is never alike). */
const sameVerdicts = (a: readonly (Verdict | null)[] | null, b: readonly (Verdict | null)[]): boolean => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

/** The line a send leaves under its button: null when it went through (sent now, or already). */
export function assessMessage(result: Outcome, s: S, t: T): string | null {
  switch (result.kind) {
    case "sent":
    case "already":
      return null;
    case "notSubmitted":
      return s.errors.notSubmitted;
    case "verdicts":
      return fill(s.errors.verdicts, { points: list(result.missing) });
    case "comments":
      return fill(s.errors.comments, { points: list(result.missing) });
    case "stale":
      return t.sendErrors.stale;
    case "empty":
      return t.sendErrors.empty;
    case "notFound":
      return s.errors.notFound;
    case "failed":
      return t.sendErrors.failed;
  }
}

/**
 * Under the access's protocol. Sent and not opened: "Muuda" (a correction of the same round; after the approval only the notes can change).
 * Otherwise "Saada hinnang" (the screen's one primary button): a tap first checks what the screen shows — the student has sent her work, every
 * point has a verdict, every "Paranda" has a note — and says what is missing; then one confirmation with the counts; its "Saada" saves the
 * notes, stores every tap, and sends (sendAssessmentAction) with the round the screen shows. After an approval the button sends the changed notes
 * again ("Saada uuesti"). R3: coming back to the window reads the server again (engine.recheck), so the student's new round reaches a screen left
 * open; a send or a tap the server finds of an older round reads it too, and the line says she sent a new one. A read that brings another round
 * closes the confirmation (its counts were of the round before). An "already" answer reads the server again, so the screen takes its status; a
 * send that got no answer reads it too, and the line "Vastust ei tulnud …" goes when the read shows the send done.
 */
export function AssessmentSend({
  state,
  assessment,
  current,
  taps,
  onSent,
}: {
  state: EditorState;
  assessment: AssessmentView;
  /** The practical work as the screen's last read or send left it (`assessment` is the render's: a check after an await asks this). */
  current(): AssessmentView | null;
  taps: VerdictTaps;
  /** A send went through: the status it made (null: only the notes went, or it was sent already) and the verdicts it sent. */
  onSent(status: PracticalStatus | null, verdicts: (Verdict | null)[]): void;
}) {
  const s = adminEt.assessment.screen;
  const t = adminEt.protocols;
  const uid = useId();
  const { engine, entry, locked, onUnlock } = state;
  const id = entry.registrationId;
  const notesOnly = entry.titles.length === 0;
  // the round the confirmation was opened on: it shows only while the screen shows that round, so a read that brings the student's new round
  // closes it (its counts were of the round before, and the server would refuse its send as stale)
  const [askedOn, setAskedOn] = useState<number | null>(null);
  const asking = askedOn !== null && askedOn === assessment.round;
  const [done, setDone] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLParagraphElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) question.current?.focus();
    // closed by a new round, the focused button gone with it: the focus returns to "Saada hinnang" (close() moves it itself)
    else if (wasAsking.current && (document.activeElement === null || document.activeElement === document.body)) opener.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  useEffect(() => {
    if (notesOnly) return;
    // R3: the student's new round (its photos, the "Paranda" verdicts cleared) reaches a screen left open with its next read; coming back to the
    // window asks for one (the screen's own reads come when it is shown from the browser's cache, or after five minutes hidden)
    const back = () => engine.recheck(id);
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [engine, id, notesOnly]);
  const busy = entry.sending;
  const shown = entry.titles.map((_, i) => taps.shown(i));
  const ok = shown.filter((v) => v === "ok").length;
  const fix = shown.filter((v) => v === "fix").length;

  /** Why "Saada hinnang" cannot go, from what the screen shows (the server checks it all again): null when it can. */
  function why(): string | null {
    if (assessment.status === "open") return s.errors.notSubmitted;
    if (assessment.locked) return null; // approved: only the notes go again
    const missing = shown.flatMap((v, i) => (v === null ? [i] : []));
    if (missing.length > 0) return fill(s.errors.verdicts, { points: list(missing) });
    const bare = shown.flatMap((v, i) => (v === "fix" && !(entry.content.notes[i] ?? "").trim() ? [i] : []));
    if (bare.length > 0) return fill(s.errors.comments, { points: list(bare) });
    return null;
  }

  function ask() {
    if (busy) return;
    setDone(null);
    if (notesOnly) {
      void send(); // as a contact course's "Saada": no confirmation
      return;
    }
    const line = why();
    engine.setSendError(id, line);
    if (!line) setAskedOn(assessment.round);
  }

  /** Closes the confirmation; its focused button goes with it, so the focus returns to "Saada hinnang" (unless Maria has gone elsewhere). */
  function close() {
    const active = document.activeElement;
    if (!active || active === document.body || box.current?.contains(active)) opener.current?.focus();
    setAskedOn(null);
  }

  /**
   * A send that got no answer in SEND_TIMEOUT_MS may have gone through (as ProtocolSend.tsx checkAfterTimeout): the server is read again, and when
   * the read shows this send done — the notes' version sent with nothing unsaved since, and with points the round sent, assessed with exactly the
   * verdicts sent — the line "Vastust ei tulnud …" goes and the screen locks as after a send answered "sent". Otherwise the line stays; a send again
   * is safe (the server answers "already" for what it has sent).
   */
  function checkAfterTimeout(line: string, round: number, sent: readonly (Verdict | null)[]) {
    engine.recheck(id);
    void engine.whenFresh([id]).then((read) => {
      const e = engine.get(id);
      if (!read || !e || e.sending || statusOf(e) !== "sent" || unsavedEntry(e)) return;
      const a = current();
      const assessed = a !== null && a.round === round && (a.status === "fix" || a.status === "passed") && sameVerdicts(a.sentVerdicts, sent);
      if (!notesOnly && !assessed) return;
      if (e.sendError === line) engine.setSendError(id, null);
      onUnlock(false);
      onSent(notesOnly || !a ? null : a.status, [...sent]);
    });
  }

  /** The line after a send that went through. */
  function doneLine(result: Extract<Outcome, { kind: "sent" | "already" }>, sent: readonly (Verdict | null)[]): string {
    if (result.kind === "already") return s.already;
    if (notesOnly || assessment.locked) return s.sentNotes;
    if (result.status === "fix") return fill(s.sentFix, { points: list(sent.flatMap((v, i) => (v === "fix" ? [i] : []))) });
    return result.completed ? s.sentCompleted : s.sentPassed;
  }

  async function send() {
    let now = engine.get(id);
    if (!now || now.sending) return;
    // the student's round this screen shows: the send names it, and the server refuses it as "stale" once she has sent a newer one
    const round = assessment.round;
    engine.setSendError(id, null);
    engine.setSending(id, true);
    try {
      // a screen shown from an older page (the browser's Back) waits for the server's text first, and a text other than the one shown is not sent
      // unseen (as StudentSend)
      if (engine.checking(id)) {
        const before: Content = { notes: [...now.content.notes], generalNote: now.content.generalNote };
        const read = await engine.whenFresh([id]);
        now = engine.get(id)!;
        if (!read) {
          engine.setSendError(id, t.sendErrors.unsaved);
          return;
        }
        if (!sameContent(now.content, before)) {
          engine.setSendError(id, t.sendErrors.refreshed);
          return;
        }
      }
      if (now.status.kind === "signedOut" || now.conflict) {
        engine.setSendError(id, unsavedMessage(now, t));
        return;
      }
      if (notesOnly && !written(now)) {
        engine.setSendError(id, t.sendErrors.empty);
        return;
      }
      // the notes first: the version the server confirmed is the one sent, whatever is typed meanwhile (read-only)
      const saved = await engine.save(id);
      const after = engine.get(id)!;
      if (!saved || after.conflict || engine.unconfirmed(id)) {
        engine.setSendError(id, unsavedMessage(after, t));
        return;
      }
      // then every tap: the verdicts sent are the ones on the screen (R2)
      if (!notesOnly && after.protocolId !== null) {
        const stored = await taps.flush(after.protocolId);
        if (stored === "stale" || stored === "refused") {
          // a tap of an older round (the student sent a new one), or the work changed otherwise: read again and shown
          engine.recheck(id);
          engine.setSendError(id, stored === "stale" ? s.errors.newRound : s.errors.verdictRefused);
          return;
        }
        if (stored === "unsaved") {
          engine.setSendError(id, s.errors.unsavedVerdicts);
          return;
        }
      }
      const sent = after.titles.map((_, i) => taps.shown(i));
      const result = await bounded(sendAssessmentAction({ accessId: id, version: after.version, protocolId: after.protocolId, round })).catch((): Outcome => ({ kind: "failed" }));
      if (result === "timeout") {
        engine.setSendError(id, t.sendErrors.timeout); // (the boxes open again: the finally below)
        checkAfterTimeout(t.sendErrors.timeout, round, sent);
        return;
      }
      if (result.kind === "sent" || result.kind === "already") {
        engine.markSent(id, result.version, result.sentAt);
        onUnlock(false);
        onSent(result.kind === "sent" && !notesOnly ? result.status : null, sent);
        setDone(doneLine(result, sent));
        // sent before (another device, or a send whose answer was lost): the screen still shows what it had, so the server's status, sent
        // verdicts and round are read and shown
        if (result.kind === "already") engine.recheck(id);
        return;
      }
      if (result.kind === "stale") {
        // the server holds newer work than this screen shows: it is read and shown first. The stored version still the screen's is the student's
        // new round (R3 leaves the version); so is a read that brings another round than the one sent (another device saved the notes as well)
        engine.recheck(id);
        const fresh = await engine.whenFresh([id]);
        const newRound = !notesOnly && (result.version === after.version || taps.round !== round);
        engine.setSendError(id, newRound ? s.errors.newRound : fresh ? t.sendErrors.refreshed : t.sendErrors.stale);
        return;
      }
      if (result.kind === "verdicts" || result.kind === "notSubmitted") {
        // the server's verdicts or status are not the screen's: they are read and shown first
        engine.recheck(id);
        await engine.whenFresh([id]);
      }
      engine.setSendError(id, assessMessage(result, s, t));
    } finally {
      engine.setSending(id, false);
      close();
    }
  }

  const waiting = !notesOnly && assessment.status === "open";
  const label = notesOnly ? (statusOf(entry) === "changed" ? t.resend : t.send) : assessment.locked ? t.resend : s.send;
  return (
    <div className={screen.sendBar} data-send-bar="">
      {locked ? (
        <button
          type="button"
          className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
          onClick={() => {
            engine.setSendError(id, null);
            setDone(null);
            onUnlock(true);
          }}
          data-edit=""
        >
          {t.edit}
        </button>
      ) : notesOnly && statusOf(entry) === "sent" ? (
        <p className={ui.hint} data-editing="">
          {t.editing}
        </p>
      ) : (
        <button
          ref={opener}
          type="button"
          className={ui.btn}
          aria-disabled={busy || waiting || undefined}
          aria-expanded={notesOnly ? undefined : asking}
          onClick={ask}
          data-assess-send=""
        >
          {busy ? t.sending : label}
        </button>
      )}
      {waiting && (
        <p className={ui.hint} data-assess-waiting="">
          {s.waiting}
        </p>
      )}
      {!notesOnly && assessment.locked && (
        <p className={ui.hint} data-assess-locked="">
          {s.lockedPassed}
        </p>
      )}
      {asking && (
        <div ref={box} className={`${ui.notice} ${screen.confirm}`} role="group" aria-labelledby={`${uid}-ask`} data-assess-confirm-box="">
          <p id={`${uid}-ask`} ref={question} tabIndex={-1}>
            <strong>{s.confirmTitle}</strong>
          </p>
          {assessment.locked ? <p>{s.confirmNotes}</p> : <p>{fill(s.confirmCounts, { ok, fix })}</p>}
          {!assessment.locked && fix === 0 && <p>{s.confirmPassed}</p>}
          <div className={screen.answers}>
            <button
              type="button"
              className={ui.btn}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void send();
              }}
              data-assess-confirm=""
            >
              {busy ? t.sending : s.confirmYes}
            </button>
            <button
              type="button"
              className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) close();
              }}
              data-assess-confirm-no=""
            >
              {s.confirmNo}
            </button>
          </div>
        </div>
      )}
      {entry.sendError && (
        <p role="alert" className={ui.error} data-assess-error="">
          {entry.sendError}
        </p>
      )}
      <div role="status">
        {done && (
          <p className={ui.success} data-assess-sent="">
            {done}
          </p>
        )}
      </div>
    </div>
  );
}
