"use client";

import { useId } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { fill } from "@/i18n/format";
import type { PhotoView } from "@/server/practical";
import { ProgressBar } from "./ProgressBar";
import type { PracticalTexts } from "./texts";
import styles from "./PracticalPage.module.css";

/** A practical photo's address (R5): the full photo, or its thumbnail (…/pisi); each a 302 to a 5-minute signed address, for her only. */
export const photoUrl = (id: number, thumb = false): string => `/api/konto/praktiline/foto/${id}${thumb ? "/pisi" : ""}`;

/** Where a photo picked on the page is: waiting its turn, being made smaller, on its way, or why it stopped. */
export type PendingState = "waiting" | "preparing" | "uploading" | "failed" | "decode" | "tooBig" | "refused" | "full";

/** A photo that stopped: it stays in its row with the reason until it is sent again ("failed" only) or taken away. */
export const stopped = (state: PendingState): boolean => state !== "waiting" && state !== "preparing" && state !== "uploading";

/** The line of a pending photo's row. */
function pendingLine(state: PendingState, percent: number, t: PracticalTexts): string {
  switch (state) {
    case "waiting":
      return t.waiting;
    case "preparing":
      return t.preparing;
    case "uploading":
      return fill(t.uploading, { percent });
    case "failed":
      return t.uploadFailed;
    case "decode":
      return t.decode;
    case "tooBig":
      return t.tooBig;
    case "refused":
      return t.refused;
    case "full":
      return t.full;
  }
}

type Props = { t: PracticalTexts } & (
  | { kind: "photo"; photo: PhotoView; n: number; onRemove: (() => void) | null; busy: boolean }
  | { kind: "pending"; state: PendingState; progress: number; preview: string | null; onRetry(): void; onRemove(): void }
);

/**
 * One row of a point's photos (e-course completion, spec §4.3): a stored photo — its thumbnail and name opening the full photo in a new
 * tab, and its remove while the point takes photos — or a photo on its way — its thumbnail as made in the browser, where it is (with the
 * share sent), "Proovi uuesti" when the connection failed, why it stopped, and its remove once it is not moving.
 */
export function PhotoSlot(props: Props) {
  const { t } = props;
  if (props.kind === "photo") {
    const { photo, n, onRemove, busy } = props;
    const name = fill(t.photo, { n });
    return (
      <li className={styles.photo} data-photo={photo.id}>
        <a className={styles.photoLink} href={photoUrl(photo.id)} target="_blank" rel="noopener noreferrer">
          <span className={styles.thumbBox}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind her session (a 302 to a signed address): next/image would fetch it without her cookie */}
            <img className={styles.thumb} src={photoUrl(photo.id, true)} alt="" width={72} height={72} loading="lazy" decoding="async" />
          </span>
          <span>{name}</span>
        </a>
        {onRemove ? (
          <button
            type="button"
            className={styles.remove}
            aria-label={fill(t.removePhoto, { n })}
            aria-disabled={busy || undefined}
            onClick={() => !busy && onRemove()}
            data-photo-remove=""
          >
            <Icon name="close" size={18} />
          </button>
        ) : (
          <span />
        )}
      </li>
    );
  }
  const { state, progress, preview, onRetry, onRemove } = props;
  const percent = Math.round(progress * 100);
  const line = pendingLine(state, percent, t);
  return (
    <li className={styles.photo} data-photo-pending={state}>
      <div className={styles.pendingMain}>
        <span className={styles.thumbBox}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the browser's own copy (a blob: address) of the photo being sent */}
          {preview && <img className={styles.thumb} src={preview} alt="" width={72} height={72} />}
        </span>
        <div className={styles.pendingText}>
          {state === "uploading" ? (
            <div className={styles.progress} data-photo-progress="">
              <span className={styles.status}>{line}</span>
              <ProgressBar done={percent} total={100} label={line} />
            </div>
          ) : (
            <span className={stopped(state) ? styles.problem : styles.status} role={stopped(state) ? "alert" : undefined}>
              {line}
            </span>
          )}
          {state === "failed" && (
            <button type="button" className={styles.retry} onClick={onRetry} data-photo-retry="">
              {t.retry}
            </button>
          )}
        </div>
      </div>
      {state !== "preparing" && state !== "uploading" ? (
        <button type="button" className={styles.remove} aria-label={t.removePending} onClick={onRemove} data-photo-remove="">
          <Icon name="close" size={18} />
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}

/**
 * "Lisa foto" (spec §4.3): the phone's camera or gallery — any image, and no `capture`, so the phone offers both. Several at once, up to
 * the point's `free` places (the rest of a larger pick is not taken). The input is reset at once, so the same photo can be picked again.
 */
export function AddPhoto({ free, onPick, t }: { free: number; onPick(files: File[]): void; t: PracticalTexts }) {
  const id = useId();
  return (
    <div className={styles.addRow} data-photo-add="">
      <input
        id={id}
        className={ui.srOnly}
        type="file"
        accept="image/*"
        multiple={free > 1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).slice(0, free);
          e.target.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
      <label htmlFor={id} className={styles.add}>
        <span className={styles.plus} aria-hidden="true">
          +
        </span>
        {t.add}
      </label>
    </div>
  );
}
