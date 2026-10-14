"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AssessmentView } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { lockPageScroll, trapTab } from "@/lib/modal";
import { AdminIcon } from "./AdminIcon";
import styles from "./Assessment.module.css";

/** One submitted photo of a point: the full one is /api/admin/foto/<id>, its thumbnail ?v=pisi (Task 7's route). */
export type Photo = AssessmentView["photos"][number][number];

/** A one-finger (or mouse) move across the photo of at least this many px goes to the next or the previous one. */
export const SWIPE_PX = 50;

/** Is the page pinched in (the browser's zoom: visualViewport.scale, 1 when not zoomed; a little over 1 is the browser's rounding)? */
const zoomedIn = (): boolean => (window.visualViewport?.scale ?? 1) > 1.05;

/**
 * One point's photos full-screen (spec §5.3: "a tap opens a full-screen viewer with swipe between photos and pinch zoom"). A modal <dialog>: the
 * page behind is inert and still, Tab stays inside, Esc and ✕ close it, ←/→, the buttons and a swipe move round, and the focus goes back to
 * `returnTo` (the thumbnail: a tap on an iPad does not focus a button) or to what had it. The photo fits the screen; zooming is the browser's
 * own pinch (touch-action: pinch-zoom on its box), so a second finger down is never read as a swipe. Pinched in, one finger looks round the
 * photo as in the Photos app: the box says so (`data-zoomed`, from the visual viewport's resize, lets one finger pan) and no move is a swipe until
 * the page is back at its size. "Ava täissuuruses" opens the photo in a tab of its own (the device's own viewer). No animation. Render it only
 * while open.
 */
export function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
  label,
  returnTo = null,
}: {
  photos: readonly Photo[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
  /** The dialog's name: the point's number and title. */
  label: string;
  returnTo?: HTMLElement | null;
}) {
  const s = adminEt.assessment.screen;
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const back = useRef(returnTo);
  /** The pointers down on the photo, by id, with where each went down. */
  const down = useRef(new Map<number, number>());
  /** A second pointer went down since none was: no swipe until every one is up (the browser's pinch). */
  const pinch = useRef(false);
  /** The page is pinched in: one finger pans the photo (the frame's touch-action), never a swipe. */
  const [zoomed, setZoomed] = useState(false);
  const n = photos.length;
  const go = (i: number) => onIndex((i + n) % n);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = back.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const unlock = lockPageScroll();
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    // a pinch resizes the visual viewport (its scale changes): the frame follows it while the viewer is open
    const viewport = window.visualViewport;
    const follow = () => setZoomed(zoomedIn());
    viewport?.addEventListener("resize", follow);
    return () => {
      viewport?.removeEventListener("resize", follow);
      if (dialog.open) dialog.close();
      unlock();
      opener?.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (n > 1) go(index + (e.key === "ArrowRight" ? 1 : -1));
    } else {
      trapTab(e, ref.current); // Tab stays inside the dialog
    }
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    down.current.set(e.pointerId, e.clientX);
    if (down.current.size > 1) pinch.current = true;
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const start = down.current.get(e.pointerId);
    down.current.delete(e.pointerId);
    const pinched = pinch.current;
    if (down.current.size === 0) pinch.current = false;
    if (cancelled || start === undefined || pinched || n < 2) return;
    if (zoomedIn()) return; // pinched in: the drag looked round the photo (asked now: the browser may not have told the resize yet)
    const dx = e.clientX - start;
    if (Math.abs(dx) >= SWIPE_PX) go(index + (dx < 0 ? 1 : -1));
  };

  const photo = photos[index];
  if (!photo) return null;
  return (
    <dialog
      ref={ref}
      className={styles.viewer}
      aria-label={label}
      onKeyDown={onKeyDown}
      // Esc fires "cancel" first: closing goes through onClose, so the screen's state stays the source of truth
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      data-photo-viewer=""
    >
      <div className={styles.viewerTop}>
        <span className={styles.counter} aria-live="polite" data-viewer-count="">
          {fill(s.viewerCount, { n: index + 1, of: n })}
        </span>
        <span className={styles.viewerActions}>
          <a className={styles.fullLink} href={`/api/admin/foto/${photo.id}`} target="_blank" rel="noopener" data-viewer-full="">
            {s.viewerFull}
          </a>
          <button ref={closeRef} type="button" className={styles.roundBtn} onClick={onClose} aria-label={s.close} data-viewer-close="">
            <AdminIcon name="close" size={20} />
          </button>
        </span>
      </div>
      <div
        className={styles.frame}
        data-zoomed={zoomed ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerUp={(e) => onPointerEnd(e, false)}
        onPointerCancel={(e) => onPointerEnd(e, true)}
        data-viewer-frame=""
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind the admin's session (a 302 to a signed address): next/image cannot fetch it */}
        <img key={photo.id} className={styles.image} src={`/api/admin/foto/${photo.id}`} alt={fill(s.viewerAlt, { label, n: index + 1 })} draggable={false} />
      </div>
      {n > 1 && (
        <>
          <button type="button" className={`${styles.roundBtn} ${styles.prev}`} onClick={() => go(index - 1)} aria-label={s.previous} data-viewer-prev="">
            <AdminIcon name="arrow" size={20} />
          </button>
          <button type="button" className={`${styles.roundBtn} ${styles.next}`} onClick={() => go(index + 1)} aria-label={s.next} data-viewer-next="">
            <AdminIcon name="arrow" size={20} />
          </button>
        </>
      )}
    </dialog>
  );
}
