"use client";

import { useId, useState } from "react";
import { CourseCard, type CourseCardData } from "@/components/site/CourseCard";
import type { Badge, BadgeLabel } from "@/db/schema";
import { shownBadge } from "@/domain/badge";
import { BADGE_MAX, BADGE_PRESETS, BADGE_SWATCHES, swatchOf, type SwatchId } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

/**
 * Prototype D `adminBadges` ("Koolituse märgis", Maria C36 "Väga meeldib see blokk. Jätame."): quick labels or an own
 * text of up to 18 characters, a colour from D's swatches, and a live preview: the site's real course card with the
 * badge as it would look on the catalogue page. Only the swatches can be chosen (D's free colour picker is left out,
 * so every badge stays in the palette). The text has a Russian version for the RU pages (a quick label brings its own;
 * without one the RU pages show the Estonian text). `card`: the course's card without its badge.
 */
export function BadgeEditor({ value, onChange, card, error }: { value: Badge; onChange: (badge: Badge) => void; card: CourseCardData; error?: string }) {
  const t = adminEt.badge;
  const uid = useId();
  // the colour stays chosen while there is no label ("Puudub", then "Uus" keeps it)
  const [chosen, setChosen] = useState<SwatchId>(() => swatchOf(value) ?? "tint");
  const stored = value ? swatchOf(value) : null;
  const pressed = value ? stored : chosen;
  const label: BadgeLabel = value?.label ?? { et: "" };

  const withLabel = (next: BadgeLabel, swatch: SwatchId | null = pressed ?? chosen): Badge => {
    if (!next.et.trim()) return null;
    const s = BADGE_SWATCHES.find((x) => x.id === swatch) ?? BADGE_SWATCHES[0];
    const ru = next.ru?.slice(0, BADGE_MAX);
    return { label: ru ? { et: next.et.slice(0, BADGE_MAX), ru } : { et: next.et.slice(0, BADGE_MAX) }, bg: s.bg, fg: s.fg };
  };
  const pickSwatch = (id: SwatchId) => {
    setChosen(id);
    if (value) onChange(withLabel(value.label, id));
  };
  const shown = shownBadge(value, "et");
  const presetRu = (l: BadgeLabel) => BADGE_PRESETS.some((p) => p.et === l.et && p.ru === l.ru);

  return (
    <div className={styles.badge} data-badge-editor="">
      <div>
        {/* the cards' title size (UX pass 11.11 A3) */}
        <h2 className={ui.h2}>{t.title}</h2>
        <p className={`${ui.muted} ${ui.small}`}>{t.lead}</p>
      </div>

      <div className={styles.fieldset} role="group" aria-labelledby={`${uid}-presets`}>
        <p id={`${uid}-presets`} className={`${ui.legend} ${styles.groupLabel}`}>
          {t.presets}
        </p>
        <div className={styles.chips}>
          <button type="button" className={styles.chip} aria-pressed={!value} onClick={() => onChange(null)}>
            {t.none}
          </button>
          {BADGE_PRESETS.map((p) => (
            <button key={p.et} type="button" className={styles.chip} aria-pressed={value?.label.et === p.et} onClick={() => onChange(withLabel(p))}>
              {p.et}
            </button>
          ))}
        </div>
        <p className={`${ui.muted} ${ui.small}`} data-badge-gone="">
          {t.bestsellerGone}
        </p>
      </div>

      <div className={ui.field}>
        <label htmlFor={`${uid}-own`}>{t.own}</label>
        <input
          id={`${uid}-own`}
          className={ui.input}
          type="text"
          maxLength={BADGE_MAX}
          value={label.et}
          placeholder={t.placeholder}
          autoComplete="off"
          // a quick label's Russian text goes with it: an own Estonian text starts without one
          onChange={(e) => onChange(withLabel({ et: e.target.value, ru: presetRu(label) ? undefined : label.ru }))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${uid}-error` : undefined}
          data-badge-label=""
        />
      </div>

      <div className={ui.field}>
        <label htmlFor={`${uid}-own-ru`}>{t.ownRu}</label>
        <input
          id={`${uid}-own-ru`}
          className={ui.input}
          type="text"
          lang="ru"
          maxLength={BADGE_MAX}
          value={label.ru ?? ""}
          placeholder={t.placeholderRu}
          autoComplete="off"
          // a Russian text belongs to a badge: there is none until the Estonian text is given
          disabled={!value}
          aria-describedby={`${uid}-ru-note`}
          onChange={(e) => onChange(withLabel({ ...label, ru: e.target.value }))}
          data-badge-label-ru=""
        />
        <small id={`${uid}-ru-note`} className={`${ui.muted} ${ui.small}`}>
          {t.ruNote}
        </small>
      </div>

      <div className={styles.fieldset} role="group" aria-labelledby={`${uid}-colour`}>
        <p id={`${uid}-colour`} className={`${ui.legend} ${styles.groupLabel}`}>
          {t.colour}
        </p>
        <div className={styles.swatches}>
          {BADGE_SWATCHES.map((s) => (
            <button key={s.id} type="button" className={styles.swatch} aria-pressed={pressed === s.id} onClick={() => pickSwatch(s.id)} data-swatch={s.id}>
              <i style={{ background: s.bg }} aria-hidden="true" />
              {t.swatch[s.id]}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p id={`${uid}-error`} className={ui.error}>
          {error}
        </p>
      )}

      <div className={styles.preview} data-badge-preview="">
        <p className={ui.eyebrow}>{t.preview}</p>
        {/* inert: the preview is a picture of the card, not a second link to the course */}
        <div className={styles.previewCard} inert>
          <CourseCard c={{ ...card, badge: shown }} square sizes="300px" />
        </div>
        <p className={`${ui.muted} ${ui.small}`}>{t.previewNote}</p>
      </div>
    </div>
  );
}
