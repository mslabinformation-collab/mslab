"use client";

import { useEffect, useId, useRef, useState } from "react";
import { newToSend } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { sendProtocolAction, sendProtocolsAction } from "@/server/actions/admin-protocols";
import type { BulkResult, SendOutcome } from "@/server/protocols";
import { sameContent, statusOf, unsavedEntry, written, type Content, type Entry, type ProtocolAutosave } from "./protocol-autosave";
import ui from "./ui.module.css";
import styles from "./ProtocolScreen.module.css";

// The sends of the course day's screen (phase protocols, spec §4, §8, D4). Every send saves first and sends the version the server confirmed,
// with the protocol read-only meanwhile (ProtocolAutosave.setSending), so the student gets exactly what Maria sees and her own typing can
// never make a send "stale". This file runs on old iPads: no regular expression with a lookbehind, here or in anything it imports
// (tests/unit/old-safari.test.ts follows the imports).

type T = typeof adminEt.protocols;

/** The line a send leaves under its button: null when it went through (sent now, or already). */
export function sendMessage(result: SendOutcome, t: T): string | null {
  switch (result.kind) {
    case "sent":
    case "already":
      return null;
    case "empty":
      return t.sendErrors.empty;
    case "stale":
      return t.sendErrors.stale;
    case "cancelled":
      return t.sendErrors.cancelled;
    case "notFound":
      return t.sendErrors.notFound;
    case "failed":
      return t.sendErrors.failed;
  }
}

/**
 * The line for a protocol that is not sent because its text is not safely on the server, read from what the engine knows, in the words the
 * screen already has. A refusal (another device saved first) adopts that device's text and settles, so the status says "saved" although the
 * save failed: the open notice is what tells, and Maria's next step is to look at it and press "Selge", not to try again (a reload keeps the
 * notice). A protocol that is gone, signed out or too long says so; no answer (offline, a server error) is "not saved yet".
 */
export function unsavedMessage(e: Pick<Entry, "status" | "conflict">, t: T): string {
  if (e.conflict) return t.sendErrors.review;
  switch (e.status.kind) {
    case "gone":
      return t.sendErrors.notFound;
    case "tooLong":
      return t.tooLongStatus;
    case "signedOut":
      return t.signedOut;
    default:
      return t.sendErrors.unsaved;
  }
}

/** The text on the screen as it is now (the engine changes the entry's own arrays). */
const copyOf = (c: Content): Content => ({ notes: [...c.notes], generalNote: c.generalNote });

/** What "Lukusta ja saada kõik" would do with each protocol (planSendAll). */
export type SendPlan = { will: number[]; skipped: number[]; already: number[]; sending: number[]; review: number[] };

/**
 * What "Lukusta ja saada kõik" would do now (spec §4): `will` — the protocols with something new (a draft with text, one changed after it was
 * sent, or a sent one whose new text is still on its way); `skipped` — those without text; `already` — the sent ones with nothing new;
 * `sending` — those with a send already on its way (a single "Saada"), which this one leaves alone; `review` — those that would go but have
 * the notice of a refusal open (another device's text is on the screen, which Maria has not looked at), which are left out until she has.
 */
export function planSendAll(engine: ProtocolAutosave, shown?: ReadonlyMap<number, string>): SendPlan {
  const out: SendPlan = { will: [], skipped: [], already: [], sending: [], review: [] };
  for (const id of engine.ids()) {
    if (shown && !shown.has(id)) continue; // (a student the screen no longer lists: not one of this send)
    // cancelled or moved meanwhile, as the server's last read or answer said: nothing to send (one the read left out may still be saving her text)
    if (engine.dropped(id)) continue;
    const e = engine.get(id)!;
    if (e.status.kind === "gone") continue;
    if (e.sending) {
      out.sending.push(id);
      continue;
    }
    const status = statusOf(e);
    const effective = status === "sent" && unsavedEntry(e) ? "changed" : status;
    if (effective === "sent") out.already.push(id);
    else if (newToSend(effective, written(e))) (e.conflict ? out.review : out.will).push(id);
    else out.skipped.push(id);
  }
  return out;
}

/**
 * One student's sends, under her protocol (spec §4, D4): "Saada" (a draft) and "Saada uuesti" (changed after it was sent) — each saves first and
 * sends the version the server confirmed, and an empty protocol is refused at once; "Muuda" on a sent protocol, which only unlocks the screen
 * (the first saved edit raises the version). `primary`: the screen of one registration, where "Saada" is the one primary button.
 * The state of a send is the engine's, not this component's, so it outlives it when Maria goes to another student and back: that a send is on
 * its way (`sending`, also true while "Lukusta ja saada kõik" sends this protocol, so one protocol is never sent by two taps at once), and the
 * line under the button (`sendError`) until her next send or edit.
 */
export function StudentSend({ engine, id, primary, unlocked, onUnlock }: { engine: ProtocolAutosave; id: number; primary: boolean; unlocked: boolean; onUnlock(on: boolean): void }) {
  const t = adminEt.protocols;
  const e = engine.get(id);
  if (!e) return null;
  const status = statusOf(e);
  const busy = e.sending;
  const button = primary ? ui.btn : `${ui.btn} ${ui.secondary} ${ui.smallBtn}`;

  async function send() {
    let now = engine.get(id);
    if (!now || now.sending) return;
    engine.setSendError(id, null);
    // A screen shown from an older page (the browser's Back) has not read the server's text yet, so the text on it may not be the server's, and a
    // send of it must never reach the student unseen: it waits for the server's text (the page is being rendered again), and when that is another
    // text than the one on the screen, that text is shown now and not sent: Maria looks at it and presses again. (The text, not the version: her own
    // save, which her tap on the button started by taking the focus from her box, moves the version too, and the text she was shown is the one sent.)
    if (engine.checking(id)) {
      const shown = copyOf(now.content);
      engine.setSending(id, true);
      try {
        const read = await engine.whenFresh([id]);
        now = engine.get(id)!;
        if (!read) {
          engine.setSendError(id, t.sendErrors.unsaved);
          return;
        }
        if (now.conflict) {
          engine.setSendError(id, unsavedMessage(now, t));
          return;
        }
        if (!sameContent(now.content, shown)) {
          engine.setSendError(id, t.sendErrors.refreshed);
          return;
        }
      } finally {
        engine.setSending(id, false);
      }
    }
    if (now.status.kind === "signedOut") {
      // the read was refused: she is signed out, and a send would only be turned away by the server
      engine.setSendError(id, unsavedMessage(now, t));
      return;
    }
    if (now.conflict) {
      // the notice of a refusal is open: the text on the screen is another device's, which Maria has not looked at ("Selge" first)
      engine.setSendError(id, unsavedMessage(now, t));
      return;
    }
    if (!written(now)) {
      engine.setSendError(id, t.sendErrors.empty);
      return;
    }
    // read-only until the answer: the version saved now is the version sent, whatever Maria types meanwhile
    engine.setSending(id, true);
    try {
      const saved = await engine.save(id);
      const after = engine.get(id)!;
      // (a notice that opened meanwhile also stops it: Maria's tap took the focus from her box, that saved, and its refusal — answered to that
      // save, before this one — left the other device's text on the screen, so this save found nothing left to save)
      if (!saved || after.conflict) {
        engine.setSendError(id, unsavedMessage(after, t));
        return;
      }
      const result = await sendProtocolAction({ registrationId: id, version: engine.get(id)!.version }).catch((): SendOutcome => ({ kind: "failed" }));
      if (result.kind === "sent" || result.kind === "already") {
        engine.markSent(id, result.version, result.sentAt);
        onUnlock(false);
      }
      engine.setSendError(id, sendMessage(result, t));
    } finally {
      engine.setSending(id, false);
    }
  }

  return (
    <div className={styles.sendBar} data-send-bar="">
      {status === "sent" && !unlocked ? (
        <button
          type="button"
          className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
          onClick={() => {
            engine.setSendError(id, null);
            onUnlock(true);
          }}
          data-edit=""
        >
          {t.edit}
        </button>
      ) : status === "sent" ? (
        <p className={ui.hint} data-editing="">
          {t.editing}
        </p>
      ) : (
        <button type="button" className={button} aria-disabled={busy || undefined} onClick={() => void send()} data-send={status === "changed" ? "again" : "first"}>
          {busy ? t.sending : status === "changed" ? t.resend : t.send}
        </button>
      )}
      {e.sendError && (
        <p role="alert" className={ui.error} data-send-error="">
          {e.sendError}
        </p>
      )}
    </div>
  );
}

/** The summary of a "Saada kõik": who got one, and per reason (in a single "Saada"'s words) who did not: each group is one line. */
type Summary = { sent: string[]; notSent: { key: string; line: string }[] };

/**
 * "Lukusta ja saada kõik" (spec §4, §8): the session screen's primary button. The first tap opens one confirmation that names who will get a
 * protocol, who is skipped because hers is empty, who has hers already, whose send is on its way already (left alone), and whose text is
 * another device's with its notice still open (left out until she has looked at it and pressed "Selge"). "Saada" there saves
 * each of those protocols on its own (read-only meanwhile), sends the ones whose save the server confirmed, each in its own transaction
 * (sendProtocolsAction), and leaves out and names one that could not be saved, under the reason of that (unsavedMessage): one student's failure
 * never stops the others. The summary says who got one and, per reason, who did not; every protocol that was to go is in it, one the server
 * gave no answer for as "Saatmine ei õnnestunud". The summary's place is always on the screen, so that a screen reader announces what comes
 * into it; when the confirmation closes the focus goes back to the button that opened it.
 */
export function SendAll({ engine, names, onSent }: { engine: ProtocolAutosave; names: ReadonlyMap<number, string>; onSent(id: number): void }) {
  const t = adminEt.protocols;
  const uid = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // what the send in progress was started with: its protocols are "sending" meanwhile, which a plan made now would leave out
  const [started, setStarted] = useState<SendPlan | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLParagraphElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  const plan = started ?? planSendAll(engine, names);
  const nameOf = (id: number) => names.get(id) ?? String(id);
  const list = (ids: number[]) => ids.map(nameOf).join(", ");

  /** Closes the confirmation; its focused button goes with it, so the focus returns to the opener (unless Maria has gone elsewhere meanwhile). */
  function close() {
    const active = document.activeElement;
    if (!active || active === document.body || box.current?.contains(active)) opener.current?.focus();
    setAsking(false);
  }

  async function confirm() {
    if (busy) return;
    const start = planSendAll(engine, names);
    const planned = start.will;
    setBusy(true);
    setStarted(start);
    for (const id of planned) engine.setSending(id, true);
    try {
      // A screen shown from an older page (the browser's Back) has not read the server's text yet (see StudentSend): the protocols it lists wait for
      // it, and one whose text turns out to be another than the one the confirmation named is shown as it is now and left out, never sent unseen.
      const shown = new Map(planned.map((id) => [id, copyOf(engine.get(id)!.content)]));
      const read = planned.some((id) => engine.checking(id)) ? await engine.whenFresh(planned) : true;
      const held = new Map<number, { reason: string; review: boolean }>();
      for (const id of planned) {
        const e = engine.get(id)!;
        if (!read && engine.checking(id)) held.set(id, { reason: t.sendErrors.unsaved, review: false });
        else if (e.status.kind === "signedOut" || e.status.kind === "gone") held.set(id, { reason: unsavedMessage(e, t), review: false });
        else if (e.conflict) held.set(id, { reason: t.sendErrors.review, review: true });
        else if (!sameContent(e.content, shown.get(id)!)) held.set(id, { reason: t.sendErrors.refreshed, review: false });
      }
      const will = planned.filter((id) => !held.has(id));
      // each protocol saves on its own: one that cannot be saved is left out and named, the others go on (spec §8)
      const saved = await Promise.all(will.map((id) => engine.save(id)));
      // (one whose notice opened meanwhile is left out as an unsaved one: see StudentSend)
      const goes = will.map((id, i) => saved[i] && !engine.get(id)!.conflict);
      const items = will.filter((_, i) => goes[i]).map((id) => ({ registrationId: id, version: engine.get(id)!.version }));
      const results: BulkResult[] =
        items.length === 0 ? [] : await sendProtocolsAction(items).catch(() => items.map((i) => ({ registrationId: i.registrationId, result: { kind: "failed" } as const })));
      const sent: string[] = [];
      // the groups of the ones not sent, one line each ("Vaata enne üle …" for those whose notice is open: Maria’s next step is "Selge"), and
      // for each the reason under her own button, as a single "Saada" leaves it
      const notSent = new Map<string, { review: boolean; reason: string; names: string[] }>();
      const own = new Map<number, string>();
      const leftOut = (reason: string, id: number, review = false) => {
        const key = review ? "review" : reason;
        const group = notSent.get(key) ?? { review, reason, names: [] };
        group.names.push(nameOf(id));
        notSent.set(key, group);
        own.set(id, review ? t.sendErrors.review : reason);
      };
      for (const [id, why] of held) leftOut(why.reason, id, why.review);
      for (const id of will.filter((_, i) => !goes[i])) leftOut(unsavedMessage(engine.get(id)!, t), id, engine.get(id)!.conflict !== null);
      for (const r of results) {
        if (r.result.kind === "sent" || r.result.kind === "already") {
          engine.markSent(r.registrationId, r.result.version, r.result.sentAt);
          onSent(r.registrationId);
          sent.push(nameOf(r.registrationId));
        } else leftOut(sendMessage(r.result, t) ?? t.sendErrors.failed, r.registrationId);
      }
      // (an answer that does not list a protocol that was sent for: no one is left unexplained)
      const answered = new Set(results.map((r) => r.registrationId));
      for (const item of items) if (!answered.has(item.registrationId)) leftOut(t.sendErrors.failed, item.registrationId);
      for (const id of planned) engine.setSendError(id, own.get(id) ?? null); // (one that went has no line left from an earlier try)
      const lines = [...notSent].map(([key, g]) => ({
        key,
        line: g.review ? fill(t.confirm.review, { names: g.names.join(", ") }) : fill(t.result.notSent, { names: g.names.join(", "), reason: g.reason }),
      }));
      setSummary(sent.length === 0 && lines.length === 0 ? null : { sent, notSent: lines });
      close();
    } finally {
      for (const id of planned) engine.setSending(id, false);
      setStarted(null);
      setBusy(false);
    }
  }

  return (
    <div className={styles.sendAll} data-send-all="">
      <button
        ref={opener}
        type="button"
        className={asking ? `${ui.btn} ${ui.secondary}` : ui.btn}
        aria-expanded={asking}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          setSummary(null);
          setAsking(true);
        }}
        data-send-all-open=""
      >
        {t.sendAll}
      </button>
      {asking && (
        <div ref={box} className={`${ui.notice} ${styles.confirm}`} role="group" aria-labelledby={`${uid}-ask`} data-send-confirm="">
          <p id={`${uid}-ask`} ref={question} tabIndex={-1}>
            <strong>{t.confirm.title}</strong>
          </p>
          {plan.will.length > 0 ? <p data-confirm-will="">{fill(t.confirm.will, { names: list(plan.will) })}</p> : <p>{t.confirm.nothing}</p>}
          {plan.skipped.length > 0 && <p data-confirm-skipped="">{fill(t.confirm.skipped, { names: list(plan.skipped) })}</p>}
          {plan.already.length > 0 && <p data-confirm-already="">{fill(t.confirm.already, { names: list(plan.already) })}</p>}
          {plan.sending.length > 0 && <p data-confirm-sending="">{fill(t.confirm.onItsWay, { names: list(plan.sending) })}</p>}
          {plan.review.length > 0 && <p data-confirm-review="">{fill(t.confirm.review, { names: list(plan.review) })}</p>}
          <div className={styles.answers}>
            {plan.will.length > 0 && (
              <button type="button" className={ui.btn} aria-disabled={busy || undefined} onClick={() => void confirm()} data-confirm-send="">
                {busy ? t.sending : t.confirm.yes}
              </button>
            )}
            <button
              type="button"
              className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) close();
              }}
              data-confirm-cancel=""
            >
              {t.confirm.no}
            </button>
          </div>
        </div>
      )}
      <div className={styles.summary} role="status" data-send-summary="">
        {summary && summary.sent.length > 0 && (
          <p className={ui.success} data-summary-sent="">
            {fill(t.result.sent, { names: summary.sent.join(", ") })}
          </p>
        )}
        {summary?.notSent.map((group) => (
          <p key={group.key} className={ui.error} data-summary-failed="">
            {group.line}
          </p>
        ))}
      </div>
    </div>
  );
}
