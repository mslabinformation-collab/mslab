"use client";

import type { MouseEvent } from "react";
import type { Verdict } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { Photo } from "./PhotoViewer";
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
 * One point of Maria's assessment, under its heading and above its note box (spec §5.3): the photos of its newest round as thumbnails (a tap
 * opens the full-screen viewer), the earlier rounds under "Varasemad fotod", folded and smaller, and the verdict buttons "Kinnitatud" and
 * "Paranda" (44 px, aria-pressed; the pressed one tapped again clears it), with "Salvestamata" while the tap is not stored (verdict-taps.ts).
 * `disabled`: nothing submitted yet, the verdicts locked after the approval, or the protocol read-only (sent, before "Muuda").
 */
export function AssessmentStage({
  index,
  photos,
  verdict,
  unsaved,
  disabled,
  onVerdict,
  onOpen,
}: {
  index: number;
  photos: readonly Photo[];
  verdict: Verdict | null;
  unsaved: boolean;
  disabled: boolean;
  onVerdict(verdict: Verdict | null): void;
  /** A thumbnail tapped: the photos of its round, which one, and the button (the focus goes back to it). */
  onOpen(group: readonly Photo[], at: number, from: HTMLElement): void;
}) {
  const s = adminEt.assessment.screen;
  const point = index + 1;
  const [latest, ...earlier] = byRound(photos);
  const thumbs = (group: { round: number; photos: Photo[] }, label?: string) => (
    <ul className={styles.thumbs} aria-label={label}>
      {group.photos.map((p, i) => (
        <li key={p.id}>
          <button type="button" className={styles.thumb} onClick={(e: MouseEvent<HTMLButtonElement>) => onOpen(group.photos, i, e.currentTarget)} data-assess-photo={p.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind the admin's session (a 302 to a signed address): next/image cannot fetch it */}
            <img src={`/api/admin/foto/${p.id}?v=pisi`} alt={fill(s.photoAlt, { point, round: group.round, n: i + 1 })} loading="lazy" draggable={false} />
          </button>
        </li>
      ))}
    </ul>
  );
  const choose = (v: Verdict) => {
    if (!disabled) onVerdict(verdict === v ? null : v);
  };

  return (
    <div className={styles.stage} data-assess-point={index}>
      {latest ? (
        <div data-latest-photos="">{thumbs(latest, fill(s.photosOf, { point }))}</div>
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
              {thumbs(g)}
            </div>
          ))}
        </details>
      )}
      <div className={styles.verdicts} role="group" aria-label={fill(s.verdictOf, { point })}>
        {(["ok", "fix"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.verdict}${verdict === v ? ` ${v === "ok" ? styles.okOn : styles.fixOn}` : ""}`}
            aria-pressed={verdict === v}
            disabled={disabled}
            onClick={() => choose(v)}
            data-verdict={v}
          >
            {v === "ok" ? s.ok : s.fix}
          </button>
        ))}
        {unsaved && (
          <span className={styles.unsaved} data-verdict-unsaved="">
            {adminEt.protocols.unsavedMark}
          </span>
        )}
      </div>
    </div>
  );
}
