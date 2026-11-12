"use client";

import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { DEFAULT_FOCAL, formatFocal, parseFocal } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./site-editor.module.css";

export type FocalTarget = {
  /** "Arvutis", "Telefonis (4:3)" … */
  label: string;
  /** "x% y%" */
  value: string;
  onChange: (value: string) => void;
  /** The aspect ratio of the frame the picture is cut to there (CSS, "16 / 9"). */
  ratio: string;
  /** More than one frame for the same point (the portrait: the trainer page on a computer and on a phone). */
  frames?: { label: string; ratio: string }[];
  /** data-focal attribute (tests). */
  name: string;
};

/**
 * The focal point of a picture: the spot that stays visible however the site cuts the picture to its frame (CSS
 * object-position). A click on the picture sets it; the two number fields (percent from the left and from the top) do
 * the same from the keyboard. One picture can have a point per view (the hero: desktop and phone), switched with the
 * pills. Under it, the picture as each view will cut it. `zoom`: the previews zoom in as the site does (seed portrait).
 *
 * `hint` replaces the words under the title (Avaleht's open slide: „Puuduta pilti, et valida fookus · Vaheta pilt“, piece4-texts S4-10, with the
 * slide's upload in it); `titleHidden` keeps „Fookuspunkt“ for a screen reader only (the group's name), where the picture's column draws no title.
 * `field`: the name of the field the point is (a site part's, `trainer.portraitPos`): the group carries it as `data-field` and takes the focus, so
 * the leave guard's „Jää siia“ and the chip's „Näita“ reach it (site/useSitePart.ts focusSiteField; piece 4a final review M-5).
 */
export function FocalPoint({
  src,
  targets,
  zoom = false,
  error,
  hint,
  titleHidden = false,
  field,
}: {
  src: string;
  targets: FocalTarget[];
  zoom?: boolean;
  error?: string;
  hint?: ReactNode;
  titleHidden?: boolean;
  field?: string;
}) {
  const t = adminEt.editor.focal;
  const id = useId();
  const [which, setWhich] = useState(0);
  const current = targets[Math.min(which, targets.length - 1)];

  return (
    <div
      className={styles.focal}
      role="group"
      aria-labelledby={`${id}-title`}
      data-focal-point=""
      data-field={field}
      data-invalid={error ? "" : undefined}
      tabIndex={error || field ? -1 : undefined}
    >
      <p id={`${id}-title`} className={titleHidden ? ui.sr : styles.label}>
        {t.title}
      </p>
      <p className={ui.hint} data-focal-hint="">
        {hint ?? t.hint}
      </p>
      {targets.length > 1 && (
        <span className={styles.pills} role="group" aria-label={t.which}>
          {targets.map((x, i) => (
            <button key={x.name} type="button" className={styles.pillBtn} aria-pressed={i === which} onClick={() => setWhich(i)} data-focal-tab={x.name}>
              {x.label}
            </button>
          ))}
        </span>
      )}
      <FocalPick src={src} value={current.value} onChange={current.onChange} name={current.name} />
      <FocalAxes value={current.value} onChange={current.onChange} name={current.name} view={targets.length > 1 ? current.label : undefined} />
      {error && <p className={ui.error}>{error}</p>}
      <div className={styles.frames}>
        {targets.flatMap((x, i) =>
          (x.frames ?? [{ label: x.label, ratio: x.ratio }]).map((f, k) => (
            <figure key={`${x.name}-${k}`} className={styles.frame} data-active={(targets.length > 1 && i === which) || undefined} data-focal-preview={x.frames ? `${x.name}-${k}` : x.name}>
              <span className={styles.frameBox} style={{ aspectRatio: f.ratio }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a crop preview */}
                <img src={src} alt="" className={zoom ? styles.zoom : undefined} style={{ objectPosition: x.value }} />
              </span>
              <figcaption className={`${ui.muted} ${ui.small}`}>{fill(t.preview, { label: f.label })}</figcaption>
            </figure>
          )),
        )}
      </div>
    </div>
  );
}

/**
 * The picture whole with the point's marker on it: a click sets the point (a pointer shortcut: FocalAxes is the keyboard and screen reader way to the
 * same value). FocalPoint's, and Koolitaja's „Portree“ field's preview (UX pass 11.11, board 1: the preview is where the point is picked).
 */
export function FocalPick({ src, value, onChange, name }: { src: string; value: string; onChange: (value: string) => void; name: string }) {
  const point = parseFocal(value) ?? parseFocal(DEFAULT_FOCAL)!;
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const img = e.currentTarget.querySelector("img");
    if (!img) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    onChange(formatFocal({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 }));
  };
  return (
    <div className={styles.pick} onClick={pick} aria-hidden="true" data-focal-pick={name}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the admin's own upload, shown whole */}
      <img src={src} alt="" draggable={false} />
      <span className={styles.marker} style={{ left: `${point.x}%`, top: `${point.y}%` }} />
    </div>
  );
}

/** The point's two number fields, percent from the left and from the top (`view`: which of the picture's views they are, for a screen reader). */
export function FocalAxes({ value, onChange, name, view }: { value: string; onChange: (value: string) => void; name: string; view?: string }) {
  const t = adminEt.editor.focal;
  const id = useId();
  const point = parseFocal(value) ?? parseFocal(DEFAULT_FOCAL)!;
  const setAxis = (axis: "x" | "y", raw: string) => {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) return;
    onChange(formatFocal({ ...point, [axis]: n }));
  };
  return (
    <div className={styles.axes}>
      {(["x", "y"] as const).map((axis) => (
        <div key={axis} className={ui.field}>
          <label htmlFor={`${id}-${axis}`}>
            {t[axis]}
            {view && <span className={ui.sr}> · {view}</span>}
          </label>
          <input
            id={`${id}-${axis}`}
            className={ui.input}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={point[axis]}
            onChange={(e) => setAxis(axis, e.target.value)}
            data-focal-axis={`${name}-${axis}`}
          />
        </div>
      ))}
    </div>
  );
}
