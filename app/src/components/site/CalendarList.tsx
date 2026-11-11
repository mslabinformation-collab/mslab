"use client";

import { calendarQuery, citySlug, filterCalendar, parseCity } from "@/domain/calendar";
import { parseArea, type AreaChip } from "@/domain/course-areas";
import { fill } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";
import { useUrlQuery } from "@/lib/url-query";
import { CalendarRow, type CalendarRowData, type CalendarRowTexts } from "./CalendarRow";
import ui from "./ui.module.css";
import styles from "./Calendar.module.css";

export type CalendarTexts = CalendarRowTexts & {
  all: string;
  cityLabel: string;
  /** the area row's name for assistive technology (it has no visible heading): „Valdkond“ */
  areaLabel: string;
  /** the empty state's button, which clears both filters: „Näita kõiki“ */
  showAll: string;
  results: string;
  empty: string;
  none: string;
};

/**
 * Prototype A calendar: city chips Kõik / Pärnu / Tallinn / Tartu / Viljandi (L5) above the rows, and below them the area chips (course areas, spec
 * 2026-11-11-course-areas-filter-design.md §5.1): „Kõik“, then `areas` — the page's chips, the areas its sessions have in Maria's order
 * (domain/course-areas.ts areaChips), none when fewer than two, and then the row is not there at all and the calendar looks as it did. The area row has
 * no heading of its own, only its group name („Valdkond“), as the city row's „Linn“.
 * The URL is the single source of truth (as the catalogue filters): the city is read from ?linn=parnu|… and the area from ?valdkond=<slug> with
 * useUrlQuery, so links, reload and Back show what the address says; an unknown or old value reads as „Kõik“. A chip writes the address in place
 * (history.replaceState, no server round trip); other parameters are kept. City and area together (AND); when they leave nothing, „Näita kõiki“
 * clears both.
 */
export function CalendarList({ rows, cities, areas, locale, t }: { rows: CalendarRowData[]; cities: string[]; areas: AreaChip[]; locale: Locale; t: CalendarTexts }) {
  const [params, writeQuery] = useUrlQuery();
  const city = parseCity(params.get("linn"), cities);
  const area = parseArea(params.get("valdkond"), areas);

  // the address as it is now, not as this render read it: a press right after another keeps what the other wrote
  const write = (change: { linn?: string | null; valdkond?: string | null }) => writeQuery(calendarQuery(new URLSearchParams(window.location.search), change));

  const shown = filterCalendar(rows, { city, area });
  const cityChips: [string | null, string][] = [[null, t.all], ...cities.map((c): [string, string] => [citySlug(c), c])];
  const areaChips: [string | null, string][] = areas.length > 0 ? [[null, t.all], ...areas.map((a): [string, string] => [a.slug, a.label])] : [];

  return (
    <>
      <div className={styles.chips} role="group" aria-label={t.cityLabel} data-city-filter="">
        {cityChips.map(([key, label]) => (
          <button key={key ?? "all"} type="button" className={styles.chip} aria-pressed={city === key} onClick={() => write({ linn: key })}>
            {label}
          </button>
        ))}
      </div>

      {areaChips.length > 0 && (
        <div className={styles.chips} role="group" aria-label={t.areaLabel} data-area-filter="">
          {areaChips.map(([key, label]) => (
            <button key={key ?? "all"} type="button" className={styles.chip} aria-pressed={area === key} onClick={() => write({ valdkond: key })}>
              {label}
            </button>
          ))}
        </div>
      )}

      <p className={ui.srOnly} aria-live="polite">
        {fill(t.results, { n: shown.length })}
      </p>

      {shown.length > 0 ? (
        <ul className={styles.list}>
          {shown.map((r) => (
            <CalendarRow key={r.id} row={r} locale={locale} t={t} />
          ))}
        </ul>
      ) : (
        <div className={styles.empty} data-calendar-empty="">
          <p>{rows.length === 0 ? t.none : t.empty}</p>
          {rows.length > 0 && (
            <button type="button" className={ui.btnOutline} onClick={() => write({ linn: null, valdkond: null })}>
              {t.showAll}
            </button>
          )}
        </div>
      )}
    </>
  );
}
