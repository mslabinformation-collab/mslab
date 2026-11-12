"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { SeatState } from "@/domain/sessions";
import { keepNameTogether } from "@/domain/title-breaks";
import type { Locale } from "@/i18n/locales";
import { Icon } from "./Icon";
import { WaitlistForm, type WaitlistTexts } from "./WaitlistForm";
import ui from "./ui.module.css";
import styles from "./Calendar.module.css";

export type CalendarRowData = {
  id: number;
  /** citySlug(city), the ?linn value */
  cityKey: string;
  /** the slug of the course's area (domain/course-areas.ts areaSlug), the ?valdkond value; null: the course has none (only under „Kõik“) */
  areaKey: string | null;
  city: string;
  venue: string;
  /** "14.11" */
  day: string;
  /** "laupäev" */
  weekday: string;
  /** ISO start, for <time> */
  dateTime: string;
  title: string;
  courseHref: string;
  /** The course page with this session picked (?sessioon=id). */
  registerHref: string;
  /** "Kontaktõpe" */
  format: string;
  /** "ET", "RU", "ET / RU" */
  language: string;
  state: SeatState;
  /** "Vabu kohti · 4", "Viimased kohad · 2", "Täis", "Tühistatud" */
  stateLabel: string;
};

export type CalendarRowTexts = { register: string; waitlist: string; others: string; languageLabel: string; waitlistForm: WaitlistTexts };

/**
 * One calendar row: prototype A's white rounded row, re-ordered for Maria (C21 / L2–L4): date block → the course name,
 * first and dominant (Jost 26px, A's city size) → city with a pin and the venue → format and language tag →
 * seat state word in its colour → action. Open dates register on the course page (?sessioon=id); a full date opens the
 * waitlist form under the row; a cancelled date leads to the course page with its other dates.
 */
export function CalendarRow({ row, locale, t }: { row: CalendarRowData; locale: Locale; t: CalendarRowTexts }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const bookable = row.state === "open" || row.state === "few";
  const context = `${row.title} · ${row.day} · ${row.city}`;

  return (
    <li className={styles.row} data-calendar-row="" data-state={row.state}>
      <p className={styles.date}>
        <time dateTime={row.dateTime}>
          <b>{row.day}</b> <span>{row.weekday}</span>
        </time>
      </p>

      <div className={styles.main}>
        <h2 className={styles.name} data-course-name="">
          <Link href={row.courseHref}>{keepNameTogether(row.title)}</Link>
        </h2>
        <p className={styles.place}>
          <Icon name="pin" size={16} className={styles.pin} />
          <span className={styles.city} data-city="">
            {row.city}
          </span>
          {row.venue && <span className={styles.venue}>{row.venue}</span>}
        </p>
      </div>

      <div className={styles.meta}>
        <p className={styles.format}>
          {row.format}
          <span className={styles.lang} data-lang="">
            <span className={ui.srOnly}>{t.languageLabel}: </span>
            {row.language}
          </span>
        </p>
        <p className={styles.state} data-seat-state="">
          <i aria-hidden="true" />
          {row.stateLabel}
        </p>
      </div>

      <div className={styles.action} data-calendar-action="">
        {bookable ? (
          <Link className={ui.btn} href={row.registerHref}>
            {t.register}
            <span className={ui.srOnly}>: {context}</span>
            <Icon name="arrow" />
          </Link>
        ) : row.state === "full" ? (
          <button type="button" className={`${ui.btn} ${styles.soft}`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
            {t.waitlist}
            <span className={ui.srOnly}>: {context}</span>
          </button>
        ) : (
          <Link className={`${ui.btn} ${styles.soft}`} href={row.courseHref}>
            {t.others}
            <span className={ui.srOnly}>: {row.title}</span>
          </Link>
        )}
      </div>

      {row.state === "full" && (
        <div id={panelId} className={styles.panel} hidden={!open}>
          {open && <WaitlistForm session={row.id} context={context} locale={locale} t={t.waitlistForm} />}
        </div>
      )}
    </li>
  );
}
