"use client";

import { useEffect, useRef } from "react";
import { LIMITS, moveItem, type DraftImage } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { DragList } from "./DragList";
import { I18nInput } from "./I18nInput";
import { ImageUpload, UploadNotes, UploadPicker, useImageUpload } from "./ImageUpload";
import { insertAt, removeAt } from "./row-keys";
import { useListRows } from "./useListRows";
import ui from "./ui.module.css";
import styles from "./editor.module.css";
import tiles from "./GalleryEditor.module.css";

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
 *
 * `layout="grid"` (Koolitaja's gallery, piece 4a ruling R-g; the Part 4 C2 frame): the same editor drawn as a grid of tiles — each the picture, 120 px
 * tall with a 12 px radius, its handle, a 32 px round ✕ at the corner and ↑ / ↓ (the gallery's own names, S4-15 note) — then the tile „+ Lisa“ (its
 * field named „Lisa pilte“), the upload's notes under the grid. The tiles are the pictures: no description, no „Põhipilt“ (as drawn). A tile is
 * dragged both ways (DragList layout="grid"). The course's gallery stays the list of rows above.
 */
export function GalleryEditor({
  images,
  onChange,
  error,
  hint,
  showMain = true,
  errorOf,
  layout = "list",
  addLabel = adminEt.upload.choose,
}: {
  images: DraftImage[];
  /** Gets an update function (an upload, or an undo, can finish after other changes: it must work on the list as it is then). */
  onChange: (update: (images: DraftImage[]) => DraftImage[]) => void;
  error?: string;
  hint?: string;
  /** "Põhipilt" on the first image (a course: the card's picture); off for the trainer's works. */
  showMain?: boolean;
  /** One picture's own refusal (a bad key, a description too long), shown at that picture's description (the list's rows). */
  errorOf?: (index: number) => string | undefined;
  /** "grid": the tiles of Koolitaja's gallery (see above); "list": the course's rows. */
  layout?: "list" | "grid";
  /** The grid's last tile's words after its „+“ (Koolitaja's „Lisa“, S4-15); its field is named „Lisa pilte“ all the same. */
  addLabel?: string;
}) {
  const t = adminEt.courseEditor.fields;
  const grid = layout === "grid";
  // every change is an update function already: the list as it is when it lands
  const { change, offer } = useListRows({ owner: "gallery", items: images, onUpdate: onChange });
  // the pictures picked go in at the end, one by one, as each upload ends (the list as it is then)
  const added = (keys: string[]) => onChange((list) => [...list, ...keys.map((key) => ({ key, alt: { et: "" } }))]);
  // the grid places the upload's parts itself: its field in the „+ Lisa“ tile, its notes under the grid (the list's rows have their own ImageUpload, so
  // there it is unused; a hook is called on every render all the same)
  const upload = useImageUpload(added);
  // the button that gets the focus after the next render (the next image's × after a removal)
  const focus = useRef<{ key: string; tool: "remove" } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const keys = rowKeys(images);

  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    root.current?.querySelector<HTMLElement>(`[data-gallery-item="${CSS.escape(target.key)}"] [data-tool="${target.tool}"]`)?.focus();
  });

  const move = (from: number, to: number) => change((list) => moveItem(list, from, to));
  const remove = (i: number) => {
    const img = images[i];
    const rest = images.filter((_, j) => j !== i);
    // the picture is known by its key (its description may be another by the time the change lands: the fresh form after a restart; review M-5)
    change((list) => removeAt(list, i, img, (x) => x.key === img.key));
    const nextKey = rowKeys(rest)[Math.min(i, rest.length - 1)];
    if (nextKey) focus.current = { key: nextKey, tool: "remove" };
    // back at its place, unless the picture is in the list again already (it would be there twice)
    offer(t.imageRemoved, (list) => (list.some((x) => x.key === img.key) ? list : insertAt(list, i, img)));
  };

  if (grid)
    return (
      <div ref={root} className={styles.list} data-gallery-editor="" data-gallery-layout="grid" data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined}>
        {hint && <p className={ui.hint}>{hint}</p>}
        <DragList
          layout="grid"
          items={images.map((img, i) => ({ img, key: keys[i] }))}
          keyOf={(row) => row.key}
          label={() => ""}
          arrowNames={(n) => ({ up: fill(t.imageUp, { n }), down: fill(t.imageDown, { n }) })}
          onMove={move}
          className={tiles.grid}
          rowClassName={tiles.cell}
          renderRow={({ img, key }, i, handle, arrows) => (
            <div className={tiles.tile} data-gallery-item={key}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a small thumbnail of an upload, no optimisation needed */}
              <img className={tiles.picture} src={mediaUrl(img.key)} alt="" draggable={false} />
              <span className={tiles.handle}>{handle}</span>
              <button type="button" className={tiles.remove} data-tool="remove" aria-label={fill(t.imageRemove, { n: i + 1 })} onClick={() => remove(i)}>
                ✕
              </button>
              <span className={tiles.arrows}>{arrows}</span>
            </div>
          )}
          after={
            <span className={tiles.add} data-gallery-add="" aria-busy={upload.busy || undefined}>
              <UploadPicker upload={upload} multiple name={adminEt.upload.choose}>
                + {addLabel}
              </UploadPicker>
            </span>
          }
        />
        {error && <p className={ui.error}>{error}</p>}
        <div className={tiles.notes}>
          <UploadNotes upload={upload} />
        </div>
      </div>
    );

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
          arrowNames={(n) => ({ up: fill(t.imageUp, { n }), down: fill(t.imageDown, { n }) })}
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
                  <I18nInput label={t.alt} value={img.alt} onChange={(alt) => onChange((list) => list.map((x, j) => (j === i ? { ...x, alt } : x)))} maxLength={LIMITS.alt} error={errorOf?.(i)} name={`image-${i}`} />
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
      <ImageUpload multiple onUploaded={added} />
    </div>
  );
}
