"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { LIMITS, moveItem, type DraftImage } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { DragList } from "./DragList";
import { I18nInput } from "./I18nInput";
import { ImageUpload } from "./ImageUpload";
import { insertAt, removeAt } from "./row-keys";
import { useUndo } from "./UndoBar";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

/** React keys for the images: the key, numbered when the same image is in the list twice. A picture keeps its key wherever it moves, and back after an undo. */
function rowKeys(images: DraftImage[]): string[] {
  const seen = new Map<string, number>();
  return images.map((img) => {
    const n = (seen.get(img.key) ?? 0) + 1;
    seen.set(img.key, n);
    return n === 1 ? img.key : `${img.key}#${n}`;
  });
}

/**
 * An ordered image list (course gallery, the trainer's works): upload more, write each picture's description (ET / RU), order with the handle „⋮⋮“
 * or ↑ / ↓ (DragList: pointer events, so a finger on an old iPad drags the handle as the mouse does; README B2), remove at once with the UndoBar
 * „Pilt eemaldatud.“, whose „Võta tagasi“ puts the picture back at its place with its description (BEH B5: a client restore, then the card's save;
 * the stored file is never deleted by a removal, so nothing is lost). The first image is the main one (card, start of the gallery). The order is
 * the stored `sort`.
 */
export function GalleryEditor({
  images,
  onChange,
  error,
  hint,
  showMain = true,
  errorOf,
}: {
  images: DraftImage[];
  /** Gets an update function (an upload, or an undo, can finish after other changes: it must work on the list as it is then). */
  onChange: (update: (images: DraftImage[]) => DraftImage[]) => void;
  error?: string;
  hint?: string;
  /** "Põhipilt" on the first image (a course: the card's picture); off for the trainer's works. */
  showMain?: boolean;
  /** One picture's own refusal (a bad key, a description too long), shown at that picture. */
  errorOf?: (index: number) => string | undefined;
}) {
  const t = adminEt.courseEditor.fields;
  const undo = useUndo();
  // the button that gets the focus after the next render (the next image's × after a removal)
  const focus = useRef<{ key: string; tool: "remove" } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const keys = rowKeys(images);
  // the newest render's onChange: an undo pressed later goes to the list as it is then
  const live = useRef(onChange);
  useLayoutEffect(() => {
    live.current = onChange;
  });

  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    root.current?.querySelector<HTMLElement>(`[data-gallery-item="${CSS.escape(target.key)}"] [data-tool="${target.tool}"]`)?.focus();
  });

  const move = (from: number, to: number) => live.current((list) => moveItem(list, from, to));
  const remove = (i: number) => {
    const img = images[i];
    const rest = images.filter((_, j) => j !== i);
    live.current((list) => removeAt(list, i, img));
    const nextKey = rowKeys(rest)[Math.min(i, rest.length - 1)];
    if (nextKey) focus.current = { key: nextKey, tool: "remove" };
    undo.show({
      text: t.imageRemoved,
      // back at its place, unless the picture is in the list again already (it would be there twice)
      undo: async () => {
        live.current((list) => (list.some((x) => x.key === img.key) ? list : insertAt(list, i, img)));
        return true;
      },
    });
  };

  return (
    <div ref={root} className={styles.list} data-gallery-editor="" data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined}>
      {hint && <p className={ui.hint}>{hint}</p>}
      {images.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.noImages}</p>
      ) : (
        <DragList
          items={images.map((img, i) => ({ img, key: keys[i] }))}
          keyOf={(row) => row.key}
          label={() => ""}
          onMove={move}
          className={styles.gallery}
          renderRow={({ img, key }, i, handle, arrows) => {
            const n = i + 1;
            return (
              <div className={`${styles.shot} ${styles.dragShot}`} data-gallery-item={key}>
                {handle}
                {/* eslint-disable-next-line @next/next/no-img-element -- a small thumbnail of an upload, no optimisation needed */}
                <img className={styles.thumb} src={mediaUrl(img.key)} alt="" draggable={false} />
                <div className={styles.shotBody}>
                  <span className={styles.shotName}>
                    {fill(t.image, { n })}
                    {showMain && i === 0 && <span className={`${ui.tag} ${ui.dark}`}>{t.main}</span>}
                  </span>
                  <I18nInput label={t.alt} value={img.alt} onChange={(alt) => live.current((list) => list.map((x, j) => (j === i ? { ...x, alt } : x)))} maxLength={LIMITS.alt} error={errorOf?.(i)} name={`image-${i}`} />
                </div>
                <span className={styles.shotTools}>
                  {arrows}
                  <button type="button" className={styles.iconBtn} data-tool="remove" aria-label={fill(t.imageRemove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              </div>
            );
          }}
        />
      )}
      {error && <p className={ui.error}>{error}</p>}
      <ImageUpload multiple onUploaded={(added) => onChange((list) => [...list, ...added.map((key) => ({ key, alt: { et: "" } }))])} />
    </div>
  );
}
