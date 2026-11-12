"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { circleCrop, contactZoomOf, DEFAULT_CONTACT_POS, formatFocal, parseFocal } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import styles from "./ContactCircle.module.css";

/** The arrows' step in percent of the point (Shift: a bigger one). */
const STEP = 2;
const BIG_STEP = 10;

/**
 * How far the picture moves in the frame per 100 % of the point, on each axis (px): the zoomed cover size less the frame's (domain/site-editor.ts
 * circleCrop: the picture covers the frame, placed by the point, zoomed about it; so a point's change `dp` moves it by dp·(S − zW)). 0 where it cannot
 * move (the picture just fills the circle that way); null before the picture has loaded.
 */
export function circleReach(frame: number, natural: { width: number; height: number }, zoom: number): { x: number; y: number } | null {
  if (!frame || !natural.width || !natural.height) return null;
  const cover = Math.max(frame / natural.width, frame / natural.height);
  const z = contactZoomOf(zoom) / 100;
  return { x: Math.max(0, z * natural.width * cover - frame), y: Math.max(0, z * natural.height * cover - frame) };
}

/** The point after the picture was dragged by (dx, dy) px from `start`: the picture follows the pointer (a drag to the right shows more of its left). */
export function draggedPoint(start: { x: number; y: number }, reach: { x: number; y: number }, dx: number, dy: number): string {
  const along = (p: number, d: number, r: number) => (r > 0.5 ? p - (d / r) * 100 : p);
  return formatFocal({ x: along(start.x, dx, reach.x), y: along(start.y, dy, reach.y) });
}

/**
 * Koolitaja's „Kontaktifoto“ circle (UX pass 11.11, A11; board 1): the photo cut as the site's small avatars cut it (circleCrop), dragged in the circle
 * until the face is in the middle — or moved with the arrow keys (the same: the picture moves the arrow's way; Shift for bigger steps). `onMove` gets
 * each new point (saved by the part's autosave), `onDone` when a drag or a key ends (the save goes then). `field`: its site field's name (the leave
 * guard's „Jää siia“ and the chip's „Näita“ reach it).
 */
export function ContactCircle({
  src,
  pos,
  zoom,
  onMove,
  onDone,
  field,
}: {
  src: string;
  pos: string;
  zoom: number;
  onMove: (pos: string) => void;
  onDone: () => void;
  field?: string;
}) {
  const t = adminEt.trainer;
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; start: { x: number; y: number }; reach: { x: number; y: number } } | null>(null);
  const point = parseFocal(pos) ?? parseFocal(DEFAULT_CONTACT_POS)!;

  const reachNow = () => {
    const el = img.current;
    return el ? circleReach(el.clientWidth, { width: el.naturalWidth, height: el.naturalHeight }, zoom) : null;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    const reach = reachNow();
    if (!reach || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: point, reach };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = draggedPoint(d.start, d.reach, e.clientX - d.x, e.clientY - d.y);
    if (next !== pos) onMove(next);
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    onDone();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    // the picture moves the arrow's way: its point the other way
    const by: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    const next = formatFocal({ x: point.x + d[0], y: point.y + d[1] });
    if (next !== pos) onMove(next);
  };

  return (
    <div
      className={styles.circle}
      role="group"
      aria-label={fill(t.contactPlace, { x: String(point.x), y: String(point.y) })}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onKeyUp={(e) => {
        if (e.key.startsWith("Arrow")) onDone();
      }}
      data-contact-circle=""
      data-field={field}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- the admin's own upload, cut as the site cuts it */}
      <img ref={img} className={styles.img} src={src} alt="" draggable={false} style={circleCrop(pos, zoom)} />
    </div>
  );
}

/** „Suurendus“ under the circle: 100–300 % (the picture just filling the circle … three times that). */
export function ContactZoom({ value, onChange, onDone, field }: { value: number; onChange: (zoom: string) => void; onDone: () => void; field?: string }) {
  const t = adminEt.trainer;
  return (
    <label className={styles.zoom}>
      {t.contactZoom}
      <input
        type="range"
        min={100}
        max={300}
        step={1}
        value={contactZoomOf(value)}
        onChange={(e) => onChange(e.target.value)}
        onPointerUp={onDone}
        onKeyUp={onDone}
        onBlur={onDone}
        data-contact-zoom=""
        data-field={field}
      />
    </label>
  );
}

/** „Nii näeb see lehel välja“: the 46 px avatar as the site shows it, and the name beside it (the reply time is the contact block's lead's: P8). */
export function ContactSample({ src, crop, name }: { src: string; crop: { pos: string; zoom: number } | null; name: string }) {
  const t = adminEt.trainer;
  return (
    <div className={styles.sample} data-contact-sample="">
      <span className={styles.sampleTitle}>{t.contactSample}</span>
      <span className={styles.sampleRow}>
        {src && (
          <span className={styles.avatar} aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element -- a preview of the site's avatar */}
            <img src={src} alt="" style={crop ? circleCrop(crop.pos, crop.zoom) : undefined} />
          </span>
        )}
        <b>{name}</b>
      </span>
    </div>
  );
}
