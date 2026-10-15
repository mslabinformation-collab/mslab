"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import ui from "@/components/site/ui.module.css";
import { checkCertificateName } from "@/domain/certificate";
import { isDone, sendJson } from "@/lib/json-request";
import type { CertificateView } from "@/server/certificates";
import type { CertificateTexts } from "./texts";
import styles from "./CompletionSteps.module.css";

/** The certificate in an answer of POST …/tunnistus (a 200's, or a 409 "already"'s): its view; null for anything that is not one. */
function certificateOf(value: unknown): CertificateView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "number" || typeof v.number !== "string" || typeof v.name !== "string" || typeof v.issuedAt !== "string") return null;
  return { id: v.id, number: v.number, name: v.name, issuedAt: v.issuedAt, reissuedAt: typeof v.reissuedAt === "string" ? v.reissuedAt : null };
}

/**
 * The student confirms the name her certificate is made with (phase 3d, spec §5): the e-course page's "Tunnistus" row (CompletionSteps.tsx)
 * and the card of an ended access completed without one (AccountCourseCard.tsx: that course page needs an active access) both show it.
 * - "Kontrolli, kuidas su nimi tunnistusel kirjas on", the field "Nimi tunnistusel" (`startName`: her account's name to start with) with its
 *   hint "Ladina tähtedega, nagu passis." under it, always shown and named by the field's `aria-describedby` (her account's name may be in
 *   Cyrillic, which the rule refuses only on submit), the line of a refusal, apart from the hint, and "Kinnita ja koosta tunnistus".
 * - The button checks the name here first (domain/certificate.ts checkCertificateName, the server's own rule), then POSTs it once to
 *   /api/konto/kursus/<slug>/tunnistus; a second press waits for the first. The certificate of the answer, made now or by another of her
 *   devices first ("already"), goes to `onIssued`; a refusal is put in words.
 * - Each press empties the refusal's line first, and a refusal fills it again — the name refused here on the next frame, the server's with its
 *   answer — so `role="alert"` announces it again when it is the same words.
 * - `quiet`: an outline button (another primary is on the page). `readOnly` (the admin's view as client): nothing to type or press.
 */
export function CertificateForm({ slug, startName, t, readOnly, quiet, onIssued }: {
  slug: string;
  startName: string;
  t: CertificateTexts;
  readOnly: boolean;
  quiet: boolean;
  onIssued(certificate: CertificateView): void;
}) {
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();
  const [name, setName] = useState(startName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // one request at a time, also between two quick presses (state is read after the render)
  const sending = useRef(false);
  const button = `${quiet ? ui.btnOutline : ui.btn} ${styles.action} ${styles.main}`;

  const issue = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || sending.current) return;
    setError("");
    const checked = checkCertificateName(name);
    if (!checked.ok) {
      const refusal = checked.error === "letters" ? t.letters : t.length;
      requestAnimationFrame(() => setError(refusal));
      return;
    }
    sending.current = true;
    setBusy(true);
    const answer = await sendJson(`/api/konto/kursus/${encodeURIComponent(slug)}/tunnistus`, { name: checked.name });
    sending.current = false;
    setBusy(false);
    const view = certificateOf(answer.data.certificate);
    // made now, or by another of her devices first: either way the one she has
    if (view && (isDone(answer) || answer.data.error === "already")) return onIssued(view);
    if (answer.status === 400 && answer.data.error === "name") return setError(answer.data.reason === "letters" ? t.letters : t.length);
    setError(answer.status === 429 ? t.rate : t.failed);
  };

  return (
    <form className={styles.certificate} onSubmit={issue} noValidate>
      <p className={styles.line}>{t.check}</p>
      <div className={styles.field}>
        <label htmlFor={nameId}>{t.nameLabel}</label>
        <input
          id={nameId}
          name="certificateName"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${hintId} ${errorId}`}
          data-certificate-name=""
        />
      </div>
      <p id={hintId} className={styles.hint} data-certificate-hint="">
        {t.nameHint}
      </p>
      <p id={errorId} className={styles.error} role="alert" data-certificate-error="">
        {error}
      </p>
      {readOnly ? (
        <span className={button} aria-disabled="true" data-certificate-issue="">
          {t.issue}
        </span>
      ) : (
        <button type="submit" className={button} aria-disabled={busy || undefined} data-certificate-issue="">
          {busy ? t.issuing : t.issue}
        </button>
      )}
    </form>
  );
}
