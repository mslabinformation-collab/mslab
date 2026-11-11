"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { DESIGN_LIMITS, DESIGN_TONES, isDesignTone, type DesignTone } from "@/domain/certificate-design";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { DesignCardRow } from "@/server/certificate-designs";
import { ConfirmPanel } from "./ConfirmPanel";
import { ImageField } from "./ImageField";
import { PillChoice } from "./PillChoice";
import { pressFailedLine } from "./useEditorRestarts";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./CertificateDesigns.module.css";

const t = adminEt.certificates.designs;

type RowField = "name" | "tone" | "backgroundKey";
const LABELS: Record<RowField, string> = { name: t.name, tone: t.tone, backgroundKey: t.background };
const ERRORS: Record<string, string> = t.errors;

/** The header's count: „Kasutab {n} koolitust“ (one: „Kasutab 1 koolitus“), or „Pole kasutusel“. */
const usedLine = (n: number): string => (n === 0 ? t.unused : n === 1 ? t.usedOne : fill(t.used, { n }));

/** Why „Kustuta“ is greyed: the design is in use, or it is the last one; null: it can go. */
function keptBecause(courses: number, last: boolean): string | null {
  if (courses > 0) return t.inUse;
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
 * One design's box (UX pass 11.11, board 1): the header — „Kujunduse nimi“ (typed: saved 1.5 s after the last key and when left), „Vaikimisi“ on
 * the first, the tone pills (saved at once), how many courses use it, „Vaata näidist ↗“ (the sample in this design as stored) — then the picture
 * („Taustapilt“, ImageField: the preview is the drop zone, „Vaheta pilt · Eemalda“ under it, saved at once) with its hint lines, and at the end of the
 * words „Kustuta“ (red outline; a confirmation under the box). In use or the last one, „Kustuta“ is greyed and says why beside it; a delete refused
 * meanwhile says it too, with the count the server found. Its own autosave (useSeadedPart on api/admin/tunnistuse-kujundus/<id>, its own version):
 * its status goes to the page's one SaveStatus as „kujundus-<id>“, and a conflict offers „Taasta minu tekst“ in the box.
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
  /** Deleted: the focus goes to the add row's name and the page is read again. */
  onRemoved: () => void;
  /** A delete refused: the page is read again (the counts and the list as they are now). */
  onReread: () => void;
}) {
  const uid = useId();
  const partName = `kujundus-${design.id}`;
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

  // „Kustuta“: the confirmation under the box, then the delete; refused, the box says why (the count the server found, until the page's new read)
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ courses: number | null; words: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keptLine = useRef<HTMLParagraphElement>(null);
  const courses = refused?.courses ?? design.courses;
  const because = refused?.words ?? keptBecause(courses, last);
  // the confirmation gone with a refusal: the focus goes to the words beside „Kustuta“ (or back to it), never to the page's top
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
    if (answer.status === 409 && body?.error === "inUse" && typeof body.courses === "number") setRefused({ courses: body.courses, words: t.inUse });
    else if (answer.status === 409 && body?.error === "last") setRefused({ courses: null, words: t.last });
    else if (answer.status === 404) setRefused({ courses: null, words: t.gone });
    else setFailed(answer.signedOut ? pressFailedLine(true) : t.failed);
    refocus.current = true;
    onReread();
  };

  const leave = () => void part.flush();
  const rowName = name.trim() || design.name;
  const usedId = `${uid}-used`;
  const keptId = `${uid}-kept`;

  return (
    <fieldset className={styles.design} aria-labelledby={`${uid}-row`} onBlur={leave} data-design-row={design.id}>
      <legend id={`${uid}-row`} className={ui.sr}>
        {fill(t.row, { name: rowName })}
      </legend>
      <div className={styles.head}>
        <input
          id={`${uid}-name`}
          className={`${ui.input} ${styles.name}`}
          type="text"
          autoComplete="off"
          aria-label={t.name}
          maxLength={DESIGN_LIMITS.name}
          value={name}
          onChange={(e) => part.type("name", e.target.value)}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${uid}-name-error` : undefined}
          data-design-name=""
        />
        {first && (
          <span className={styles.tag} data-design-default="">
            {t.defaultTag}
          </span>
        )}
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
        <span className={styles.spacer} />
        <span id={usedId} className={styles.used} data-design-used="">
          {usedLine(courses)}
        </span>
        <a className={styles.sample} href={sampleOf(sampleHref, design.id)} target="_blank" rel="noopener" data-design-sample="">
          {t.sample} <span aria-hidden="true">↗</span>
        </a>
      </div>
      {nameError && (
        <p id={`${uid}-name-error`} className={`${ui.error} ${styles.line}`}>
          {nameError}
        </p>
      )}
      {errorOf("tone") && <p className={`${ui.error} ${styles.line}`}>{errorOf("tone")}</p>}
      <ImageField
        label={t.background}
        value={background}
        onChange={(key) => {
          part.type("backgroundKey", key);
          void part.flush();
        }}
        hints={[background ? t.backgroundHint : t.backgroundNone, ...(first ? [t.first] : [])]}
        error={errorOf("backgroundKey")}
        removable
        kind="certificate-background"
        size={{ width: "300px", height: "212px" }}
        name={`design-${design.id}`}
        field={`${partName}.backgroundKey`}
        aside={
          <div className={styles.remove}>
            {because && (
              <p ref={keptLine} id={keptId} tabIndex={-1} className={`${ui.hint} ${styles.kept}`} data-design-kept="">
                {because}
              </p>
            )}
            <button
              ref={trigger}
              type="button"
              className={`${ui.btn} ${ui.danger} ${ui.smallBtn} ${ui.held}`}
              aria-disabled={because ? true : undefined}
              aria-describedby={because ? (courses > 0 ? `${usedId} ${keptId}` : keptId) : undefined}
              aria-expanded={because ? undefined : asking}
              onClick={() => {
                if (!because) setAsking(true);
              }}
              data-design-remove=""
            >
              {t.remove}
            </button>
          </div>
        }
      />
      {part.conflict && (
        <p className={styles.line}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void part.restore()} data-design-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
      {asking && !because && (
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
      )}
      {failed && (
        <p role="alert" className={`${ui.error} ${styles.line}`} data-design-failed="">
          {failed}
        </p>
      )}
    </fieldset>
  );
}

/** The dashed add row at the end: the new design's name (none: the server names it) and „Lisa kujundus +“; the route's words at a name it refused. */
function AddDesign({ onAdded }: { onAdded: (id: number) => void }) {
  const uid = useId();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const add = async () => {
    if (adding) return;
    setAdding(true);
    setError(null);
    setFailed(null);
    try {
      const res = await fetch("/api/admin/tunnistuse-kujundus", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(name.trim() ? { name } : {}),
      });
      const body = (await res.json().catch(() => null)) as { ok?: unknown; id?: unknown; fields?: { name?: unknown } } | null;
      if (res.ok && body?.ok === true && typeof body.id === "number") {
        setName("");
        onAdded(body.id);
      } else if (res.status === 400 && typeof body?.fields?.name === "string") setError(ERRORS[body.fields.name] ?? t.errors.other);
      else setFailed(res.status === 401 ? pressFailedLine(true) : t.failed);
    } catch {
      setFailed(t.failed);
    } finally {
      setAdding(false);
    }
  };
  return (
    <form
      className={`${styles.design} ${styles.add}`}
      noValidate
      aria-label={t.newName}
      data-design-add-row=""
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className={styles.addLine}>
        <input
          id={`${uid}-name`}
          className={`${ui.input} ${styles.newName}`}
          type="text"
          autoComplete="off"
          aria-label={t.newName}
          placeholder={t.newName}
          maxLength={DESIGN_LIMITS.name}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${uid}-error` : undefined}
          data-design-new-name=""
        />
        <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={adding || undefined} data-design-add="">
          {adding ? t.adding : t.add}
        </button>
      </div>
      {error && (
        <p id={`${uid}-error`} className={`${ui.error} ${styles.line}`} data-design-add-error="">
          {error}
        </p>
      )}
      {failed && (
        <p role="alert" className={`${ui.error} ${styles.line}`} data-design-add-failed="">
          {failed}
        </p>
      )}
    </form>
  );
}

/**
 * Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1; UX pass 11.11 board 1, A7/A8): the designs an e-course's certificate
 * can be drawn in, the first first (an e-course with none picked gets it: „Vaikimisi“), one bordered box each (DesignRow), and the dashed add row
 * at the end (AddDesign: a light design without a photo, named as typed or by the server; its name field takes the focus once its box is there). A
 * design added or deleted: the page is read again. `sampleHref`: the certificate card's sample address (its values as typed), which each box's
 * „Vaata näidist ↗“ draws in that design.
 */
export function CertificateDesigns({ designs, sampleHref, onStatus }: { designs: readonly DesignCardRow[]; sampleHref: string; onStatus?: StatusReport }) {
  const uid = useId();
  const router = useRouter();
  // the design just added, whose name takes the focus once the page's new read shows its box
  const fresh = useRef<number | null>(null);
  useEffect(() => {
    const id = fresh.current;
    if (id === null || !designs.some((d) => d.id === id)) return;
    fresh.current = null;
    document.querySelector<HTMLInputElement>(`[data-design-row="${id}"] [data-design-name]`)?.focus();
  }, [designs]);
  const reread = useCallback(() => startTransition(() => router.refresh()), [router]);

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
              document.querySelector<HTMLElement>("[data-design-new-name]")?.focus();
              reread();
            }}
            onReread={reread}
          />
        ))}
        <AddDesign
          onAdded={(id) => {
            fresh.current = id;
            reread();
          }}
        />
      </div>
    </section>
  );
}
