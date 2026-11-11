"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { DESIGN_LIMITS, DESIGN_TONES, isDesignTone, type DesignTone } from "@/domain/certificate-design";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { DesignCardRow } from "@/server/certificate-designs";
import { ConfirmPanel } from "./ConfirmPanel";
import { PillChoice } from "./PillChoice";
import { SingleImage } from "./SingleImage";
import { pressFailedLine } from "./useEditorRestarts";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./CertificateDesigns.module.css";

const t = adminEt.certificates.designs;

type RowField = "name" | "tone" | "backgroundKey";
const LABELS: Record<RowField, string> = { name: t.name, tone: t.tone, backgroundKey: t.background };
const ERRORS: Record<string, string> = t.errors;

/** The words instead of „Kustuta“: how many courses use the design, or that it is the last one; null: it can go. */
function keptBecause(courses: number, last: boolean): string | null {
  if (courses === 1) return t.usedOne;
  if (courses > 1) return fill(t.used, { n: courses });
  return last ? t.last : null;
}

/** The address of a design's sample (api/admin/naidistunnistus): the certificate card's values as they stand, drawn in the design as stored. */
const sampleOf = (base: string, id: number) => `${base}${base.includes("?") ? "&" : "?"}design=${id}`;

type Removed = { ok: true } | { ok: false; signedOut: boolean; status: number; body: unknown };

async function removeDesign(id: number): Promise<Removed> {
  try {
    const res = await fetch(`/api/admin/tunnistuse-kujundus/${id}`, { method: "DELETE", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.ok) return { ok: true };
    return { ok: false, signedOut: res.status === 401, status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, signedOut: false, status: 0, body: null };
  }
}

/**
 * One design's row: „Nimi“ (typed: saved 1.5 s after the last key and when left), „Toon“ and „Taustapilt“ (saved at once), „Vaata näidist“ (the
 * sample in this design as stored) and „Kustuta“ (a confirmation; refused while a course uses it or it is the last, which the row then says). Its
 * own autosave (useSeadedPart on api/admin/tunnistuse-kujundus/<id>, its own version): its status goes to the page's one SaveStatus as
 * „kujundus-<id>“, and a conflict offers „Taasta minu tekst“ in the row.
 */
function DesignRow({
  design,
  first,
  last,
  sampleHref,
  onStatus,
  onRemoved,
  onReread,
}: {
  design: DesignCardRow;
  first: boolean;
  last: boolean;
  sampleHref: string;
  onStatus?: StatusReport;
  /** Deleted: the focus goes to „Lisa kujundus“ and the page is read again. */
  onRemoved: () => void;
  /** A delete refused: the page is read again (the counts and the list as they are now). */
  onReread: () => void;
}) {
  const uid = useId();
  const partName = `kujundus-${design.id}`;
  const id = (f: RowField) => `${uid}-${f}`;
  const fields = useMemo(() => ({ name: design.name, tone: design.tone, backgroundKey: design.backgroundKey }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  // the chip's „Näita“ and the leave guard's „Jää siia“: the name's field, the chosen tone, the photo's group
  const focusField = useCallback(
    (f: string) => {
      const row = `[data-design-row="${design.id}"]`;
      const el =
        f === "tone"
          ? document.querySelector<HTMLElement>(`${row} [data-design-tone]:checked`)
          : f === "backgroundKey"
            ? document.querySelector<HTMLElement>(`${row} [data-single-image]`)
            : document.getElementById(`${uid}-name`);
      el?.focus();
    },
    [uid, design.id],
  );
  const part = useSeadedPart({ part: partName, url: `/api/admin/tunnistuse-kujundus/${design.id}`, version: design.version, fields, label: (f) => LABELS[f as RowField] ?? f, focusField, onStatus });
  // a row that goes (deleted) leaves nothing waiting on the page's status
  const report = useRef(onStatus);
  useEffect(() => {
    report.current = onStatus;
  });
  useEffect(() => () => report.current?.(partName, { kind: "saved", at: null }), [partName]);

  const name = String(part.text("name") ?? "");
  const toneNow = part.text("tone");
  const tone: DesignTone = isDesignTone(toneNow) ? toneNow : design.tone;
  const background = String(part.text("backgroundKey") ?? "");
  const errorOf = (f: RowField): string | undefined => {
    const code = part.codeOf(f);
    return code === undefined ? undefined : (ERRORS[code] ?? t.errors.other);
  };
  const nameError = errorOf("name");

  // „Kustuta“: the confirmation in its place, then the delete; refused, the row says why (the count the server found)
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keptLine = useRef<HTMLParagraphElement>(null);
  const because = kept ?? keptBecause(design.courses, last);
  // the confirmation gone with a refusal: the focus goes to the words in its place (or back to „Kustuta“), never to the page's top
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (keptLine.current ?? trigger.current)?.focus();
  });
  const remove = async () => {
    setBusy(true);
    setFailed(null);
    const answer = await removeDesign(design.id);
    setBusy(false);
    setAsking(false);
    if (answer.ok) return onRemoved();
    const body = answer.body as { error?: unknown; courses?: unknown } | null;
    if (answer.status === 409 && body?.error === "inUse" && typeof body.courses === "number") setKept(keptBecause(body.courses, last) ?? t.failed);
    else if (answer.status === 409 && body?.error === "last") setKept(t.last);
    else if (answer.status === 404) setKept(t.gone);
    else setFailed(answer.signedOut ? pressFailedLine(true) : t.failed);
    refocus.current = true;
    onReread();
  };

  const leave = () => void part.flush();
  const rowName = name.trim() || design.name;

  return (
    <fieldset className={styles.row} aria-labelledby={`${uid}-row`} onBlur={leave} data-design-row={design.id}>
      <legend id={`${uid}-row`} className={ui.sr}>
        {fill(t.row, { name: rowName })}
      </legend>
      <div className={styles.fields}>
        <div className={ui.field}>
          <label htmlFor={id("name")}>{t.name}</label>
          <input
            id={id("name")}
            className={ui.input}
            type="text"
            autoComplete="off"
            maxLength={DESIGN_LIMITS.name}
            value={name}
            onChange={(e) => part.type("name", e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={[first ? `${uid}-first` : "", nameError ? `${id("name")}-error` : ""].filter(Boolean).join(" ") || undefined}
            data-design-name=""
          />
          {first && (
            <p id={`${uid}-first`} className={ui.hint} data-design-first="">
              {t.first}
            </p>
          )}
          {nameError && (
            <p id={`${id("name")}-error`} className={ui.error}>
              {nameError}
            </p>
          )}
        </div>
        <div className={styles.tone}>
          {/* (the pills' own legend names the group for a screen reader: this is its visible label) */}
          <p className={ui.legend} aria-hidden="true">
            {t.tone}
          </p>
          <PillChoice
            name={`${uid}-tone`}
            legend={t.tone}
            options={DESIGN_TONES.map((v) => ({ value: v, label: t.tones[v], data: { "data-design-tone": v } }))}
            value={tone}
            onChange={(v) => {
              part.type("tone", v);
              void part.flush();
            }}
          />
          {errorOf("tone") && <p className={ui.error}>{errorOf("tone")}</p>}
        </div>
        <SingleImage
          label={t.background}
          value={background}
          onChange={(key) => {
            part.type("backgroundKey", key);
            void part.flush();
          }}
          hint={t.backgroundHint}
          error={errorOf("backgroundKey")}
          removable
          ratio="842 / 595"
          name={`design-${design.id}`}
          field={`${partName}.backgroundKey`}
          kind="certificate-background"
        />
      </div>
      {part.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void part.restore()} data-design-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
      <div className={styles.actions}>
        <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={sampleOf(sampleHref, design.id)} target="_blank" rel="noopener" data-design-sample="">
          {t.sample}
        </a>
        {asking ? (
          <ConfirmPanel
            question={fill(t.removeQuestion, { name: rowName })}
            lines={[t.removeLine]}
            yesLabel={t.removeYes}
            tone="danger"
            busy={busy}
            onYes={() => void remove()}
            onCancel={() => {
              setAsking(false);
              requestAnimationFrame(() => trigger.current?.focus());
            }}
          />
        ) : because ? (
          <p ref={keptLine} tabIndex={-1} className={`${ui.hint} ${styles.kept}`} data-design-kept="">
            {because}
          </p>
        ) : (
          <button ref={trigger} type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => setAsking(true)} data-design-remove="">
            {t.remove}
          </button>
        )}
        {failed && (
          <p role="alert" className={ui.error} data-design-failed="">
            {failed}
          </p>
        )}
      </div>
    </fieldset>
  );
}

/**
 * Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1): the designs an e-course's certificate can be drawn in, the first
 * first (an e-course with none picked gets it), one row each (DesignRow), and „Lisa kujundus“ under them (a light design without a photo, named by
 * the server; its name field takes the focus). A row added or deleted: the page is read again. `sampleHref`: the certificate card's sample address
 * (its values as typed), which each row's „Vaata näidist“ draws in that design.
 */
export function CertificateDesigns({ designs, sampleHref, onStatus }: { designs: readonly DesignCardRow[]; sampleHref: string; onStatus?: StatusReport }) {
  const uid = useId();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // the design just added, whose name takes the focus once the page's new read shows its row
  const fresh = useRef<number | null>(null);
  useEffect(() => {
    const id = fresh.current;
    if (id === null || !designs.some((d) => d.id === id)) return;
    fresh.current = null;
    document.querySelector<HTMLInputElement>(`[data-design-row="${id}"] [data-design-name]`)?.focus();
  }, [designs]);
  const reread = useCallback(() => startTransition(() => router.refresh()), [router]);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setFailed(null);
    try {
      const res = await fetch("/api/admin/tunnistuse-kujundus", { method: "POST", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      const body = (await res.json().catch(() => null)) as { ok?: unknown; id?: unknown } | null;
      if (res.ok && body?.ok === true && typeof body.id === "number") {
        fresh.current = body.id;
        reread();
      } else setFailed(res.status === 401 ? pressFailedLine(true) : t.failed);
    } catch {
      setFailed(t.failed);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-certificate-designs="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <div className={styles.rows}>
        {designs.map((d, i) => (
          <DesignRow
            key={d.id}
            design={d}
            first={i === 0}
            last={designs.length <= 1}
            sampleHref={sampleHref}
            onStatus={onStatus}
            onRemoved={() => {
              addButton.current?.focus();
              reread();
            }}
            onReread={reread}
          />
        ))}
      </div>
      <div className={styles.add}>
        <button ref={addButton} type="button" className={`${ui.btn} ${ui.secondary}`} onClick={() => void add()} aria-disabled={adding || undefined} data-design-add="">
          {adding ? t.adding : t.add}
        </button>
        {failed && (
          <p role="alert" className={ui.error} data-design-add-failed="">
            {failed}
          </p>
        )}
      </div>
    </section>
  );
}
