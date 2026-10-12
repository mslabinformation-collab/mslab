"use client";

import { useEffect, useId, useRef, useState } from "react";
import { newToSend } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { sendProtocolAction, sendProtocolsAction } from "@/server/actions/admin-protocols";
import type { BulkResult, SendOutcome } from "@/server/protocols";
import { statusOf, unsavedEntry, written, type ProtocolAutosave } from "./protocol-autosave";
import ui from "./ui.module.css";
import styles from "./ProtocolScreen.module.css";

// The sends of the course day's screen (phase protocols, spec §4, §8, D4). Every send saves first and sends the version the server confirmed,
// with the protocol read-only meanwhile (ProtocolAutosave.setSending), so the student gets exactly what Maria sees and her own typing can
// never make a send "stale". This file runs on old iPads: no regular expression with a lookbehind, and no import of lib/storable.ts
// (tests/unit/old-safari.test.ts).

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
 * What "Lukusta ja saada kõik" would do now (spec §4): `will` — the protocols with something new (a draft with text, one changed after it was
 * sent, or a sent one whose new text is still on its way); `skipped` — those without text; `already` — the sent ones with nothing new.
 */
export function planSendAll(engine: ProtocolAutosave): { will: number[]; skipped: number[]; already: number[] } {
  const out = { will: [] as number[], skipped: [] as number[], already: [] as number[] };
  for (const id of engine.ids()) {
    const e = engine.get(id)!;
    const status = statusOf(e);
    const effective = status === "sent" && unsavedEntry(e) ? "changed" : status;
    if (effective === "sent") out.already.push(id);
    else if (newToSend(effective, written(e))) out.will.push(id);
    else out.skipped.push(id);
  }
  return out;
}

/**
 * One student's sends, under her protocol (spec §4, D4): "Saada" (a draft) and "Saada uuesti" (changed after it was sent) — each saves first and
 * sends the version the server confirmed, and an empty protocol is refused at once; "Muuda" on a sent protocol, which only unlocks the screen
 * (the first saved edit raises the version). `primary`: the screen of one registration, where "Saada" is the one primary button.
 * That a send is on its way is the engine's (`sending`), not this component's: it survives switching to another student and back, and it
 * is also true while "Lukusta ja saada kõik" sends this protocol, so the one protocol is never sent by two taps at once.
 */
export function StudentSend({ engine, id, primary, unlocked, onUnlock }: { engine: ProtocolAutosave; id: number; primary: boolean; unlocked: boolean; onUnlock(on: boolean): void }) {
  const t = adminEt.protocols;
  const [message, setMessage] = useState<string | null>(null);
  const e = engine.get(id);
  if (!e) return null;
  const status = statusOf(e);
  const busy = e.sending;
  const button = primary ? ui.btn : `${ui.btn} ${ui.secondary} ${ui.smallBtn}`;

  async function send() {
    if (engine.get(id)?.sending) return;
    setMessage(null);
    if (!written(engine.get(id)!)) {
      setMessage(t.sendErrors.empty);
      return;
    }
    // read-only until the answer: the version saved now is the version sent, whatever Maria types meanwhile
    engine.setSending(id, true);
    try {
      if (!(await engine.save(id))) {
        setMessage(t.sendErrors.unsaved);
        return;
      }
      const result = await sendProtocolAction({ registrationId: id, version: engine.get(id)!.version }).catch((): SendOutcome => ({ kind: "failed" }));
      if (result.kind === "sent" || result.kind === "already") {
        engine.markSent(id, result.version, result.sentAt);
        onUnlock(false);
      }
      setMessage(sendMessage(result, t));
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
            setMessage(null);
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
      {message && (
        <p role="alert" className={ui.error} data-send-error="">
          {message}
        </p>
      )}
    </div>
  );
}

/** The summary of a "Saada kõik": who got one, and per reason (in a single "Saada"'s words) who did not. */
type Summary = { sent: string[]; notSent: { reason: string; names: string[] }[] };

/**
 * "Lukusta ja saada kõik" (spec §4, §8): the session screen's primary button. The first tap opens one confirmation that names who will get a
 * protocol, who is skipped because hers is empty, and who has hers already. "Saada" there saves each of those protocols on its own (read-only
 * meanwhile), sends the ones whose save the server confirmed, each in its own transaction (sendProtocolsAction), and leaves out and names one
 * that could not be saved: one student's failure never stops the others. The summary says who got one and, per reason, who did not; every
 * protocol that was to go is in it, one the server gave no answer for as "Saatmine ei õnnestunud".
 */
export function SendAll({ engine, names, onSent }: { engine: ProtocolAutosave; names: ReadonlyMap<number, string>; onSent(id: number): void }) {
  const t = adminEt.protocols;
  const uid = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const question = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  const plan = planSendAll(engine);
  const nameOf = (id: number) => names.get(id) ?? String(id);
  const list = (ids: number[]) => ids.map(nameOf).join(", ");

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const will = planSendAll(engine).will;
    for (const id of will) engine.setSending(id, true);
    try {
      // each protocol saves on its own: one that cannot be saved is left out and named, the others go on (spec §8)
      const saved = await Promise.all(will.map((id) => engine.save(id)));
      const items = will.filter((_, i) => saved[i]).map((id) => ({ registrationId: id, version: engine.get(id)!.version }));
      const results: BulkResult[] =
        items.length === 0 ? [] : await sendProtocolsAction(items).catch(() => items.map((i) => ({ registrationId: i.registrationId, result: { kind: "failed" } as const })));
      const sent: string[] = [];
      const notSent = new Map<string, string[]>();
      const leftOut = (reason: string, id: number) => notSent.set(reason, [...(notSent.get(reason) ?? []), nameOf(id)]);
      for (const id of will.filter((_, i) => !saved[i])) leftOut(t.sendErrors.unsaved, id);
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
      setSummary({ sent, notSent: [...notSent].map(([reason, who]) => ({ reason, names: who })) });
      setAsking(false);
    } finally {
      for (const id of will) engine.setSending(id, false);
      setBusy(false);
    }
  }

  return (
    <div className={styles.sendAll} data-send-all="">
      <button
        type="button"
        className={ui.btn}
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
        <div className={`${ui.notice} ${styles.confirm}`} role="group" aria-labelledby={`${uid}-ask`} data-send-confirm="">
          <p id={`${uid}-ask`} ref={question} tabIndex={-1}>
            <strong>{t.confirm.title}</strong>
          </p>
          {plan.will.length > 0 ? <p data-confirm-will="">{fill(t.confirm.will, { names: list(plan.will) })}</p> : <p>{t.confirm.nothing}</p>}
          {plan.skipped.length > 0 && <p data-confirm-skipped="">{fill(t.confirm.skipped, { names: list(plan.skipped) })}</p>}
          {plan.already.length > 0 && <p data-confirm-already="">{fill(t.confirm.already, { names: list(plan.already) })}</p>}
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
                if (!busy) setAsking(false);
              }}
              data-confirm-cancel=""
            >
              {t.confirm.no}
            </button>
          </div>
        </div>
      )}
      {summary && (
        <div role="status" data-send-summary="">
          {summary.sent.length > 0 && (
            <p className={ui.success} data-summary-sent="">
              {fill(t.result.sent, { names: summary.sent.join(", ") })}
            </p>
          )}
          {summary.notSent.map((group) => (
            <p key={group.reason} className={ui.error} data-summary-failed="">
              {fill(t.result.notSent, { names: group.names.join(", "), reason: group.reason })}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
