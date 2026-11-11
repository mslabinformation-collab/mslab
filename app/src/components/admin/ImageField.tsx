"use client";

import { useId, useState, type DragEvent, type ReactNode } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { mediaUrl, type UploadKind } from "@/lib/media";
import { UploadPicker, useImageUpload, type ImageUploadState } from "./ImageUpload";
import ui from "./ui.module.css";
import styles from "./ImageField.module.css";

/** The files of a drop that are pictures (the upload checks each again: type, size, content). */
const picturesOf = (e: DragEvent): File[] => Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));

/** Whether a drag carries files (a dragged text or link is not for the drop zone). */
const carriesFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * The one image field of the admin's recent screens (UX pass 11.11, board 1: Seaded's „Kujundused“, Koolitaja's „Portree“ and „Kontaktifoto“): the
 * preview IS the drop zone (a picture dropped on it uploads, as „Vali pilt“ / „Vaheta pilt“ does: made smaller and metadata-free in the browser,
 * ImageUpload's useImageUpload), with „Vaheta pilt · Eemalda“ right under it; beside it the field's label and its hint lines. No picture yet: the
 * zone is dashed, „Lohista pilt siia“ with „Vali pilt“ in it. One upload status line under the buttons.
 *
 * - `preview`: what the zone shows of the picture (default: the picture, cut to the zone); a field that edits its framing (the portrait's focal point,
 *   the contact photo's circle) draws its own. `size`: the zone's width and height (CSS); `round`: a circle (the contact photo); `fluid`: with a
 *   picture, the zone is as tall as the picture shown whole at that width (the portrait's focal point is picked on the whole picture).
 * - `under`: what goes under the buttons in the picture's column (the contact photo's zoom); `aside`: after the hint lines (the focal point's
 *   numbers, the 46 px sample).
 * - `hints`: the field's lines; the first is the upload's description (the file field's aria-describedby).
 * - `name`: the group's `data-single-image` (tests, the design row's focus); `field`: a site part's field name (`data-field`, the leave guard's „Jää
 *   siia“ and the chip's „Näita“ reach it).
 */
export function ImageField({
  label,
  value,
  onChange,
  hints,
  error,
  removable = false,
  kind = "image",
  size,
  round = false,
  fluid = false,
  preview,
  under,
  aside,
  name,
  field,
  onPicked,
}: {
  label: string;
  value: string;
  onChange: (key: string) => void;
  hints: ReactNode[];
  error?: string;
  removable?: boolean;
  kind?: UploadKind;
  size: { width: string; height: string };
  round?: boolean;
  fluid?: boolean;
  preview?: (src: string) => ReactNode;
  under?: ReactNode;
  aside?: ReactNode;
  name: string;
  field?: string;
  /** A new picture is in (uploaded): the contact photo starts its circle over. */
  onPicked?: (key: string) => void;
}) {
  const t = adminEt.editor.image;
  const id = useId();
  const upload = useImageUpload((keys) => {
    const key = keys[keys.length - 1];
    if (!key) return;
    onPicked?.(key);
    onChange(key);
  }, kind);
  const [over, setOver] = useState(false);

  const drag = {
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (!over) setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setOver(false);
      // one picture per field: the last one dropped
      const files = picturesOf(e);
      if (files.length > 0 && !upload.busy) upload.pick(files.slice(-1));
    },
  };
  const zone = { width: size.width, height: size.height };
  const shape = round ? `${styles.zone} ${styles.round}` : styles.zone;

  return (
    <div
      className={styles.field}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={error ? `${id}-error` : undefined}
      data-single-image={name}
      data-image-field=""
      data-field={field}
      data-invalid={error ? "" : undefined}
      tabIndex={error || field ? -1 : undefined}
    >
      <div className={styles.picture}>
        {value ? (
          <div className={shape} style={fluid ? { width: size.width } : zone} {...drag} data-drop-zone="" data-drag-over={over ? "" : undefined} aria-busy={upload.busy || undefined}>
            {preview ? (
              preview(mediaUrl(value))
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- a preview of an upload, no optimisation needed
              <img className={styles.cover} src={mediaUrl(value)} alt="" data-current-image={value} />
            )}
          </div>
        ) : (
          <div className={`${shape} ${styles.empty}`} style={zone} {...drag} data-drop-zone="" data-no-image="" data-drag-over={over ? "" : undefined} aria-busy={upload.busy || undefined}>
            <span aria-hidden="true">{t.drop}</span>
            <UploadPicker upload={upload} className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} name={`${t.choose}: ${label}`}>
              {t.choose}
            </UploadPicker>
          </div>
        )}
        {under}
        {value && (
          <div className={styles.actions}>
            <UploadPicker upload={upload} className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} name={`${t.replace}: ${label}`}>
              {t.replace}
            </UploadPicker>
            {removable && (
              <button type="button" className={styles.quiet} aria-label={`${t.remove}: ${label}`} onClick={() => onChange("")} data-image-remove="">
                {t.removeShort}
              </button>
            )}
          </div>
        )}
        <UploadStatus upload={upload} />
      </div>
      <div className={styles.words}>
        <p id={`${id}-label`} className={styles.label}>
          {label}
        </p>
        {hints.map((h, i) => (
          <p key={i} id={i === 0 ? `${upload.id}-hint` : undefined} className={ui.hint}>
            {h}
          </p>
        ))}
        {error && (
          <p id={`${id}-error`} className={ui.error}>
            {error}
          </p>
        )}
        {aside}
      </div>
    </div>
  );
}

/** How the upload went (the file field's description, `${id}-status`); empty until a picture is picked or dropped. */
function UploadStatus({ upload }: { upload: ImageUploadState }) {
  const { id, status } = upload;
  return (
    <p id={`${id}-status`} role="status" className={status.kind === "error" ? ui.error : status.kind === "done" ? ui.success : ui.hint} data-upload-status={status.kind}>
      {status.kind === "idle" ? "" : status.text}
    </p>
  );
}
