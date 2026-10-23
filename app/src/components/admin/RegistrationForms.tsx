"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { formatEUR } from "@/domain/money";
import { NOTE_MAX, type RegStatus } from "@/domain/registration";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { AdminResult } from "@/server/admin";
import { cancelRegistration, saveRegistrationStatus } from "@/server/actions/admin";
import { patchSender } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { ConfirmPanel } from "./ConfirmPanel";
import { PillChoice } from "./PillChoice";
import { SaveStatus } from "./SaveStatus";
import ui from "./ui.module.css";
import styles from "./RegistrationForms.module.css";

// The registration drawer's own forms (admin UX pass, piece 2, Task 5; README A2 drawer 1 and 3). Money is added with „Lisa laekumine“ on the Raha
// card (MoneyCard.tsx, B4).
// - „Staatus ja märkus“: the status pills „Ootab ettemaksu“ / „Kinnitatud“ (a manual override, saved at once with the status they showed:
//   server/admin.ts saveStatus refuses a stale one, and the page is refreshed to show the stored one), and „Märkus“, the app's first editor on the
//   autosave (useAutosave → POST /api/admin/registreering/<id>/markus, server/registration-note.ts). The note's engine lives in RegistrationNote,
//   around the whole drawer, so its SaveStatus can sit in the drawer's header (NoteSaveStatus) and its field in the section (README §1.4); it is a
//   leave-guard source („Märkus“, P-12): ✕, Back and a menu click ask while the note is not saved.
// - „Tühista registreerimine“ (RegistrationCancel, B10: it asks with a ConfirmPanel first).

type Note = ReturnType<typeof useAutosave>;
const NoteContext = createContext<Note | null>(null);

/** The note's engine of the open registration (`key` it by the registration: another one is another form part). */
export function RegistrationNote({ id, note, version, children }: { id: number; note: string; version: string; children: ReactNode }) {
  const t = adminEt.registrations.drawer;
  const [save] = useState(() => patchSender(`/api/admin/registreering/${id}/markus`));
  const auto = useAutosave({
    owner: "registreering",
    key: String(id),
    version,
    fields: { note },
    save,
    // (the field's maxLength keeps a typed note within the limit; a pasted or resumed longer copy is held back with the server's own code)
    validate: (f): Record<string, string> => (typeof f.note === "string" && f.note.length > NOTE_MAX ? { note: "tooLong" } : {}),
    label: () => t.noteLabel,
  });
  return <NoteContext.Provider value={auto}>{children}</NoteContext.Provider>;
}

function useNote(): Note {
  const auto = useContext(NoteContext);
  if (!auto) throw new Error("the note's parts are drawn inside RegistrationNote");
  return auto;
}

/** The first element named `note` in the open drawer: SaveStatus's „Näita“. */
const focusNote = () => document.querySelector<HTMLTextAreaElement>("dialog[data-drawer][open] textarea[name='note']")?.focus();

/** The drawer header's SaveStatus: the note's (README §1.4: the header, left of ✕); „gone“ says „Seda registreerimist enam ei ole. …“ (P-10). */
export function NoteSaveStatus() {
  const auto = useNote();
  return <SaveStatus status={auto.status} thing={adminEt.registrations.drawer.noteThing} onShowInvalid={focusNote} />;
}

/** „Staatus ja märkus“: the status pills and the note. A cancelled registration's pills choose nothing and are disabled (it is not put back, spec §10). */
export function StatusAndNote({ id, status }: { id: number; status: RegStatus }) {
  const t = adminEt.registrations.drawer;
  const uid = useId();
  return (
    <section className={styles.part} aria-labelledby={`${uid}-title`} data-status-form="">
      <h3 id={`${uid}-title`} className={ui.h3}>
        {t.statusTitle}
      </h3>
      <StatusPills id={id} status={status} />
      <NoteField />
    </section>
  );
}

function StatusPills({ id, status }: { id: number; status: RegStatus }) {
  const t = adminEt.registrations.drawer;
  const uid = useId();
  const cancelled = status === "cancelled";
  const [asked, setAsked] = useState<RegStatus | null>(null);
  const [line, setLine] = useState<"stale" | "error" | null>(null);
  const [pending, start] = useTransition();
  // the pill shown: the one pressed while its save is on the way, else the stored status (the page is refreshed after the save, also after a
  // stale refusal, and brings it)
  const shown = cancelled ? null : pending && asked ? asked : status;

  const choose = (value: string) => {
    if (pending || cancelled || value === status) return;
    const next = value as RegStatus;
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("status", next);
    // the status the pills showed: the server refuses the change if the stored one is different by now
    fd.set("expected", status);
    setAsked(next);
    setLine(null);
    start(async () => {
      try {
        const r = await saveRegistrationStatus(null, fd);
        if (!r.ok) setLine(r.error === "stale" ? "stale" : "error");
      } catch {
        setLine("error"); // (no answer: the connection dropped)
      }
    });
  };

  return (
    // (busy while a press is on its way, the page's refresh included: a press meanwhile is not taken)
    <div className={styles.pills} aria-busy={pending || undefined} data-status-choice="">
      <PillChoice
        name={`${uid}-status`}
        legend={t.statusLabel}
        options={(["awaiting_prepayment", "confirmed"] as const).map((s) => ({ value: s, label: adminEt.registrations.status[s] }))}
        value={shown}
        onChange={choose}
        disabled={cancelled}
      />
      <p role="status" className={ui.error} data-status-line="">
        {line === "stale" ? t.stale : line === "error" ? adminEt.common.saveError : ""}
      </p>
    </div>
  );
}

/** „Märkus“ (autosaved, max 2000, „Näeb ainult haldus.“); after a conflict, „Taasta minu tekst“ saves this text over the other one (README §1.3). */
function NoteField() {
  const t = adminEt.registrations.drawer;
  const uid = useId();
  const auto = useNote();
  const value = typeof auto.fields.note === "string" ? auto.fields.note : "";
  const invalid = auto.status.kind === "invalid";
  return (
    <div className={ui.field}>
      <label htmlFor={`${uid}-note`}>{t.noteLabel}</label>
      <textarea
        id={`${uid}-note`}
        name="note"
        className={ui.textarea}
        maxLength={NOTE_MAX}
        value={value}
        onChange={(e) => auto.setField("note", e.target.value)}
        onBlur={() => void auto.flush()}
        aria-invalid={invalid || undefined}
        aria-describedby={`${uid}-note-hint${invalid ? ` ${uid}-note-error` : ""}`}
        data-registration-note=""
      />
      <p id={`${uid}-note-hint`} className={ui.hint}>
        {t.noteHint}
      </p>
      {invalid && (
        <p id={`${uid}-note-error`} className={ui.error}>
          {t.noteTooLong}
        </p>
      )}
      {auto.conflict && (
        <div>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void auto.restore()} data-note-restore="">
            {t.restore}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * „Tühista registreerimine“ (README A2 drawer 6, B10; piece2-texts S3-g): the danger button asks first, with a ConfirmPanel in its place — the question
 * „Kas tühistan registreerimise: {name}?“ (a surname's case is not guessed), the lines each only when true — the seat that is free in the public
 * calendar at once (`seat`: the session's „12.12 Tallinn“, null when there is no session or the registration holds no seat now), the money and the
 * invoices that stay (`paidCents`, `hasInvoices`: „Laekunud {x} € ja arved jäävad alles.“, „Laekunud {x} € jääb alles.“, „Arved jäävad alles.“, none
 * when there is neither) and always that no mail goes —, „Jah, tühista“ and „Katkesta“. „Katkesta“ and Esc close the question and the focus goes back to
 * the button; the drawer round it stays open. The action is called through startTransition. Once cancelled the button gives way to „Registreerimine on
 * tühistatud.“, which takes the focus.
 */
export function RegistrationCancel({
  id,
  name,
  status,
  seat,
  paidCents,
  hasInvoices,
}: {
  id: number;
  /** The student's name, as written. */
  name: string;
  status: RegStatus;
  seat: string | null;
  paidCents: number;
  /** The registration has invoices of any state (they all stay). */
  hasInvoices: boolean;
}) {
  const t = adminEt.registrations.drawer;
  const c = t.cancelPanel;
  const [state, action, pending] = useActionState<AdminResult | null, FormData>(cancelRegistration, null);
  const [asking, setAsking] = useState(false);
  /** A new object each time the question is closed: the focus goes back to the button (a plain flag could not say "again"). */
  const [back, setBack] = useState<object | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const cancelledNote = useRef<HTMLParagraphElement>(null);
  // the action went through: the page is refreshed with the cancelled registration, and the line that says so is shown at once
  const cancelled = status === "cancelled" || state?.ok === true;

  useEffect(() => {
    if (back) button.current?.focus();
  }, [back]);
  useEffect(() => {
    if (state?.ok) cancelledNote.current?.focus();
  }, [state]);

  const close = () => {
    setAsking(false);
    setBack({});
  };
  const yes = () => {
    if (pending) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(() => action(fd));
  };

  // S3-g: each line only when true; the amount as the Raha card writes it (no euro sign inside)
  const money = paidCents > 0 ? formatEUR(paidCents, "et").replace(/ €$/, "") : null;
  const lines = [
    ...(seat ? [fill(c.seat, { place: seat })] : []),
    ...(money !== null ? [fill(hasInvoices ? c.moneyAndInvoices : c.moneyOnly, { x: money })] : hasInvoices ? [c.invoicesOnly] : []),
    c.noMail,
  ];

  return (
    <div className={styles.form} data-cancel-form="">
      {cancelled ? (
        <p ref={cancelledNote} tabIndex={-1} className={ui.muted} data-cancelled="">
          {t.cancelled}
        </p>
      ) : asking ? (
        <ConfirmPanel question={fill(c.question, { name })} lines={lines} yesLabel={pending ? adminEt.common.saving : c.yes} tone="danger" busy={pending} onYes={yes} onCancel={close} />
      ) : (
        <button ref={button} type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} onClick={() => setAsking(true)}>
          {t.cancel}
        </button>
      )}
      {state && !state.ok && (
        <p role="alert" className={ui.error}>
          {adminEt.common.saveError}
        </p>
      )}
    </div>
  );
}
