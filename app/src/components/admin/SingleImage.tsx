"use client";

import { useId, type ReactNode } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { mediaUrl } from "@/lib/media";
import { ImageUpload } from "./ImageUpload";
import ui from "./ui.module.css";
import styles from "./site-editor.module.css";

/**
 * One picture of a content item (a hero slide, the portrait, a post's cover, the campaign image): the current one, and
 * "Vali pilt" / "Vaheta pilt" to upload another (made smaller and metadata-free in the browser, ImageUpload).
 * `children`: what goes under it (a focal point picker).
 */
export function SingleImage({
  label,
  value,
  onChange,
  hint,
  error,
  removable,
  ratio = "4 / 3",
  preview = true,
  labelHidden,
  name,
  field,
  children,
}: {
  label: string;
  value: string;
  onChange: (key: string) => void;
  hint?: string;
  error?: string;
  /** "Eemalda pilt" (where no picture is allowed). */
  removable?: boolean;
  /** The thumbnail's aspect ratio (CSS). */
  ratio?: string;
  /** Show the current picture (false where the focal point picker under it shows it anyway). */
  preview?: boolean;
  /** The label for screen readers only (the card's heading already says it). */
  labelHidden?: boolean;
  /** data-single-image attribute (tests). */
  name: string;
  /**
   * The name of the field the picture is (a site part's, `trainer.portraitKey`): the group carries it as `data-field` and takes the focus, so the
   * leave guard's „Jää siia“ and the chip's „Näita“ reach it (site/useSitePart.ts focusSiteField; piece 4a final review M-5).
   */
  field?: string;
  children?: ReactNode;
}) {
  const t = adminEt.editor.image;
  const id = useId();
  return (
    <div
      className={styles.single}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={error ? `${id}-error` : undefined}
      data-single-image={name}
      data-field={field}
      data-invalid={error ? "" : undefined}
      tabIndex={error || field ? -1 : undefined}
    >
      <p id={`${id}-label`} className={labelHidden ? ui.sr : styles.label}>
        {label}
      </p>
      {value && !preview ? null : value ? (
        // eslint-disable-next-line @next/next/no-img-element -- a preview of an upload, no optimisation needed
        <img className={styles.singleImage} src={mediaUrl(value)} alt="" style={{ aspectRatio: ratio }} data-current-image={value} />
      ) : (
        <p className={`${styles.noImage} ${ui.muted} ${ui.small}`} style={{ aspectRatio: ratio }}>
          {t.none}
        </p>
      )}
      {hint && <p className={ui.hint}>{hint}</p>}
      {error && (
        <p id={`${id}-error`} className={ui.error}>
          {error}
        </p>
      )}
      <ImageUpload onUploaded={(keys) => keys.length && onChange(keys[keys.length - 1])} label={value ? t.replace : t.choose} />
      {removable && value && (
        <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.start}`} onClick={() => onChange("")}>
          {t.remove}
        </button>
      )}
      {children}
    </div>
  );
}
