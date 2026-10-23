"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import type { Verdict } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { Photo } from "./PhotoViewer";
import { NoteArea } from "./ProtocolScreen";
import ui from "./ui.module.css";
import styles from "./Assessment.module.css";

/** A point's photos by round, the newest first. */
function byRound(photos: readonly Photo[]): { round: number; photos: Photo[] }[] {
  const out: { round: number; photos: Photo[] }[] = [];
  for (const p of [...photos].sort((a, b) => b.round - a.round || a.id - b.id)) {
    const last = out[out.length - 1];
    if (last && last.round === p.round) last.photos.push(p);
    else out.push({ round: p.round, photos: [p] });
  }
  return out;
}

/**
 * One point of Maria's assessment as a card (README A4, the Part 2 prototype): the photos of its newest round (the first one 260 px high and as wide
 * as the card, the others small under it; a tap opens the full-screen viewer), the earlier rounds under "Varasemad fotod", folded and smaller, the
 * point's title, the segmented verdict "Kinnitatud" | "Paranda" (44 px, aria-pressed; the pressed half filled; the pressed one tapped again clears
 * it), with "Salvestamata" while the tap is not stored (verdict-taps.ts), and the comment: a box that opens by itself on "Paranda" (and stays
 * open while it holds words), "Lisa märkus" otherwise, which opens it with the focus in it. The box is the point's note of the protocol (the
 * notes' autosave, ProtocolScreen.tsx NoteArea), named „Märkus: {title}“ (piece2-texts P-12).
 * `disabled`: nothing submitted yet, the verdicts locked after the approval, or the protocol read-only (sent, before "Muuda"); `readOnly`: the
 * protocol is read-only (the note too).
 */
export function AssessmentStage({
  index,
  title,
  photos,
  verdict,
  unsaved,
  disabled,
  note,
  readOnly,
  onNote,
  onNoteBlur,
  onVerdict,
  onOpen,
}: {
  index: number;
  title: string;
  photos: readonly Photo[];
  verdict: Verdict | null;
  unsaved: boolean;
  disabled: boolean;
  note: string;
  readOnly: boolean;
  onNote(value: string): void;
  onNoteBlur(): void;
  onVerdict(verdict: Verdict | null): void;
  /** A thumbnail tapped: the photos of its round, which one, and the button (the focus goes back to it). */
  onOpen(group: readonly Photo[], at: number, from: HTMLElement): void;
}) {
  const s = adminEt.assessment.screen;
  const uid = useId();
  const point = index + 1;
  const [latest, ...earlier] = byRound(photos);
  // the comment box: open on "Paranda", while it holds words, and once Maria has asked for it or typed in it (emptied again, it stays under her hands)
  const [asked, setAsked] = useState(false);
  const open = verdict === "fix" || note !== "" || asked;
  const field = useRef<HTMLDivElement>(null);
  const focusBox = useRef(false);
  useEffect(() => {
    // "Lisa märkus" pressed: its button is gone, so the focus goes to the box that took its place
    if (!focusBox.current || !open) return;
    focusBox.current = false;
    field.current?.querySelector("textarea")?.focus();
  });
  const image = (p: Photo, group: { round: number; photos: Photo[] }, i: number) => (
    <button
      type="button"
      className={latest === group && i === 0 ? styles.hero : styles.thumb}
      onClick={(e: MouseEvent<HTMLButtonElement>) => onOpen(group.photos, i, e.currentTarget)}
      data-assess-photo={p.id}
      data-assess-hero={latest === group && i === 0 ? "" : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind the admin's session (a 302 to a signed address): next/image cannot fetch it */}
      <img src={`/api/admin/foto/${p.id}?v=pisi`} alt={fill(s.photoAlt, { point, round: group.round, n: i + 1 })} loading="lazy" draggable={false} />
    </button>
  );
  const choose = (v: Verdict) => {
    if (!disabled) onVerdict(verdict === v ? null : v);
  };

  return (
    <div className={styles.card} role="group" aria-labelledby={`${uid}-title`} data-assess-point={index}>
      {latest ? (
        <div data-latest-photos="">
          <ul className={styles.photos} aria-label={fill(s.photosOf, { point })}>
            {latest.photos.map((p, i) => (
              <li key={p.id} className={i === 0 ? styles.heroItem : undefined}>
                {image(p, latest, i)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={ui.hint} data-no-photos="">
          {s.noPhotos}
        </p>
      )}
      {earlier.length > 0 && (
        <details className={styles.earlier} data-earlier-photos="">
          <summary>{s.earlier}</summary>
          {earlier.map((g) => (
            <div key={g.round} className={styles.earlierRound}>
              <p className={ui.hint}>{fill(s.roundOf, { n: g.round })}</p>
              <ul className={styles.photos}>
                {g.photos.map((p, i) => (
                  <li key={p.id}>{image(p, g, i)}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
      <h2 id={`${uid}-title`} className={styles.pointTitle} data-assess-title="">
        {title}
      </h2>
      <div className={styles.segmented} role="group" aria-label={fill(s.verdictOf, { point })}>
        {(["ok", "fix"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`${styles.verdict}${verdict === v ? ` ${v === "ok" ? styles.okOn : styles.fixOn}` : ""}`}
            aria-pressed={verdict === v}
            disabled={disabled}
            onClick={() => choose(v)}
            data-verdict={v}
          >
            {v === "ok" ? s.ok : s.fix}
          </button>
        ))}
      </div>
      {unsaved && (
        <span className={styles.unsaved} data-verdict-unsaved="">
          {adminEt.protocols.unsavedMark}
        </span>
      )}
      {latest && (
        <p className={styles.openHint} data-open-hint="">
          {s.openHint}
        </p>
      )}
      {open ? (
        <div ref={field}>
          <NoteArea
            id={`${uid}-note`}
            value={note}
            readOnly={readOnly}
            onChange={(v) => {
              setAsked(true);
              onNote(v);
            }}
            onBlur={onNoteBlur}
            note={index}
            label={fill(s.pointNote, { title })}
            className={styles.comment}
          />
        </div>
      ) : (
        !readOnly && (
          <button
            type="button"
            className={styles.addNote}
            onClick={() => {
              focusBox.current = true;
              setAsked(true);
            }}
            data-add-note=""
          >
            {s.addNote}
          </button>
        )
      )}
    </div>
  );
}
