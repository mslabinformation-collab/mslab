"use client";

import { useEffect, useRef } from "react";
import { LIMITS, moveItem, type DraftImage } from "@/domain/course-editor";
import type { I18n } from "@/i18n/field";
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

type GalleryProps = {
  images: DraftImage[];
  /** Gets an update function (an upload, or an undo, can finish after other changes: it must work on the list as it is then). */
  onChange: (update: (images: DraftImage[]) => DraftImage[]) => void;
  error?: string;
  hint?: string;
  /** "Põhipilt" on the first image (a course: the card's picture); off for the trainer's works. The list's rows only. */
  showMain?: boolean;
  /** One picture's own refusal (a bad key, a description too long), shown at that picture's description. */
  errorOf?: (index: number) => string | undefined;
  /** "grid": the tiles of Koolitaja's gallery (GalleryGrid below); "list" (the default): the course's rows. */
  layout?: "list" | "grid";
  /** The grid's last tile's words after its „+“ (Koolitaja's „Lisa“, S4-15); its field is named „Lisa pilte“ all the same. */
  addLabel?: string;
  /** The grid's description fields' names: `<name>.<i>.alt` (a site part's convention, `works.2.alt`); without it `image-<i>`, as the list's rows. */
  name?: string;
  /** The grid's cap (Koolitaja's 24): at it „+ Lisa“ is aria-disabled and opens no file dialog, described by `maxNote` (the id of the counter). */
  max?: number;
  maxNote?: string;
};

/**
 * What both drawings of the gallery share: the rows' keys, a move, a removal with the UndoBar „Pilt eemaldatud.“ (its „Võta tagasi“ puts the picture
 * back at its place with its description, unless it is in the list again already), a description typed, the pictures uploaded added at the end, and
 * after a removal the focus on the next picture's × (in the root the hook gives).
 */
function useGalleryRows(images: DraftImage[], onChange: GalleryProps["onChange"]) {
  const t = adminEt.courseEditor.fields;
  // every change is an update function already: the list as it is when it lands
  const { change, offer } = useListRows({ owner: "gallery", items: images, onUpdate: onChange });
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
  const describe = (i: number, alt: I18n) => onChange((list) => list.map((x, j) => (j === i ? { ...x, alt } : x)));
  // the pictures picked go in at the end, one by one, as each upload ends (the list as it is then)
  const added = (picked: string[]) => onChange((list) => [...list, ...picked.map((key) => ({ key, alt: { et: "" } }))]);
  /** DragList's props for these rows (the order control: the handle, ↑ / ↓ with the pictures' own names, a move). */
  const drag = {
    items: images.map((img, i) => ({ img, key: keys[i] })),
    keyOf: (row: { key: string }) => row.key,
    label: () => "",
    arrowNames: (n: number) => ({ up: fill(t.imageUp, { n }), down: fill(t.imageDown, { n }) }),
    onMove: move,
  };
  return { root, drag, remove, describe, added };
}

/**
 * An ordered image list (course gallery, the trainer's works): upload more, write each picture's description (ET / RU), order with the handle „⋮⋮“
 * or ↑ / ↓ (DragList: pointer events, so a finger on an old iPad drags the handle as the mouse does; README B2), remove at once with the UndoBar
 * „Pilt eemaldatud.“, whose „Võta tagasi“ puts the picture back at its place with its description (BEH B5: a client restore, then the card's save;
 * the stored file is never deleted by a removal, so nothing is lost). The first image is the main one (card, start of the gallery). The order is
 * the stored `sort`.
 *
 * `layout="grid"`: Koolitaja's gallery drawn as tiles (GalleryGrid, piece 4a ruling R-g). The course's gallery is the list of rows (GalleryList).
 */
export function GalleryEditor(props: GalleryProps) {
  return props.layout === "grid" ? <GalleryGrid {...props} /> : <GalleryList {...props} />;
}

/** The course's gallery: a list of rows, each the handle, the thumbnail, „Pilt {n}“ (and „Põhipilt“), its description, ↑ ↓ ×; „Lisa pilte“ under it. */
function GalleryList({ images, onChange, error, hint, showMain = true, errorOf }: GalleryProps) {
  const t = adminEt.courseEditor.fields;
  const { root, drag, remove, describe, added } = useGalleryRows(images, onChange);
  return (
    <div ref={root} className={styles.list} data-gallery-editor="" data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined}>
      {hint && <p className={ui.hint}>{hint}</p>}
      {images.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.noImages}</p>
      ) : (
        <DragList
          {...drag}
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
                  <I18nInput label={t.alt} value={img.alt} onChange={(alt) => describe(i, alt)} maxLength={LIMITS.alt} error={errorOf?.(i)} name={`image-${i}`} />
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

/**
 * Koolitaja's gallery (piece 4a ruling R-g; the Part 4 C2 frame): the pictures as a grid of tiles — each the picture, 120 px tall with a 12 px
 * radius, its handle, a 32 px round ✕ at the corner and ↑ / ↓ (the gallery's own names, S4-15 note), and under it the picture's description (the
 * list's field and words, „Pildi kirjeldus“, as its name and placeholder: builder notes §5, the fields the mocks leave out stay) with its own refusal
 * — then the tile „+ Lisa“ (its field named „Lisa pilte“), the upload's notes under the grid. A tile is dragged both ways (DragList layout="grid").
 * At `max` pictures the tile adds none (final review M-3: a picture past the cap would hold back every later change of the gallery).
 */
function GalleryGrid({ images, onChange, error, hint, errorOf, addLabel = adminEt.upload.choose, name, max, maxNote }: GalleryProps) {
  const t = adminEt.courseEditor.fields;
  const { root, drag, remove, describe, added } = useGalleryRows(images, onChange);
  // the upload's parts placed by the grid: its field in the „+ Lisa“ tile, its notes under the grid
  const upload = useImageUpload(added);
  const full = max !== undefined && images.length >= max;
  return (
    <div ref={root} className={styles.list} data-gallery-editor="" data-gallery-layout="grid" data-invalid={error ? "" : undefined} tabIndex={error ? -1 : undefined}>
      {hint && <p className={ui.hint}>{hint}</p>}
      <DragList
        {...drag}
        layout="grid"
        className={tiles.grid}
        rowClassName={tiles.cell}
        renderRow={({ img, key }, i, handle, arrows) => (
          <div className={tiles.item} data-gallery-item={key}>
            <div className={tiles.tile}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a small thumbnail of an upload, no optimisation needed */}
              <img className={tiles.picture} src={mediaUrl(img.key)} alt="" draggable={false} />
              <span className={tiles.handle}>{handle}</span>
              <button type="button" className={tiles.remove} data-tool="remove" aria-label={fill(t.imageRemove, { n: i + 1 })} onClick={() => remove(i)}>
                ✕
              </button>
              <span className={tiles.arrows}>{arrows}</span>
            </div>
            <I18nInput
              label={t.alt}
              labelHidden
              placeholder={t.alt}
              value={img.alt}
              onChange={(alt) => describe(i, alt)}
              maxLength={LIMITS.alt}
              error={errorOf?.(i)}
              name={name ? `${name}.${i}.alt` : `image-${i}`}
            />
          </div>
        )}
        after={
          <span className={tiles.add} data-gallery-add="" data-full={full ? "" : undefined} aria-busy={upload.busy || undefined}>
            <UploadPicker upload={upload} multiple name={adminEt.upload.choose} full={full} fullNote={maxNote}>
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
}
