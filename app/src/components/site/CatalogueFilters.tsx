"use client";

import { useEffect, useId, useRef, useState } from "react";
import { catalogueSearch, matchesCatalogue, parseCatalogueQuery, type FormatFilter, type LevelFilter } from "@/domain/catalogue";
import { parseArea, type AreaChip } from "@/domain/course-areas";
import { fill, pluralForm } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";
import { useUrlQuery } from "@/lib/url-query";
import { CourseCard, type CourseCardData } from "./CourseCard";
import { FormatExplainer, type ExplainerFormat, type ExplainerTexts } from "./FormatExplainer";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./CatalogueFilters.module.css";

export type CatalogueCourse = {
  card: CourseCardData;
  level: "basic" | "advanced";
  /** normalizeSearch(title + summary) */
  text: string;
  /** the slug of the course's area (domain/course-areas.ts areaSlug), the ?valdkond value; null: none (only under „Kõik“) */
  area: string | null;
};

export type CatalogueTexts = ExplainerTexts & {
  search: string;
  formatLabel: string;
  levelLabel: string;
  /** the area row's group name (no visible heading, as the other rows): „Valdkond“ */
  areaLabel: string;
  filterAll: string;
  allLevels: string;
  levelBasic: string;
  levelAdvanced: string;
  emptyTitle: string;
  emptyText: string;
  resetFilters: string;
  /** the visible count above the courses (UX pass P6), by i18n/format.ts pluralForm: „6 koolitust“ */
  count: { one: string; few: string; many: string };
};

/**
 * Catalogue filters in prototype B's arrangement (Maria C17 / K3): format chips with the search on the first row, the level chips on their own row
 * (K4), then the area chips (course areas, spec 2026-11-11-course-areas-filter-design.md §5.2: „Kõik“ and `areas`, the page's chips — the areas its
 * courses have, in Maria's order, none when fewer than two, and then the row is not there at all). UX pass 11.11 P6 (the Telefon-koolitused board):
 * the rows stand together, then the explainer — under „Kõik“ one line that opens the three „Õppevormid“ cards, under a format its journey — then the
 * count („6 koolitust“) and the course grid, so a phone shows a course on its first screen.
 *
 * The URL is the single source of truth: format, level, area and search are read from
 * ?vorm=e|k&tase=baas|taiend&valdkond=<slug>&otsi=… (useUrlQuery; an unknown or old area reads as „Kõik“), so the home page links, a reload,
 * Back/Forward and the header "Koolitused" link always show
 * what the address says. Changes are written in place with history.replaceState, without a server round trip
 * (router.replace would re-render the dynamic page on every click and keystroke); useUrlQuery explains why the value
 * is read from the address bar and not from useSearchParams alone.
 * Only the text being typed is held locally, while the search field has focus, so typing never lags behind the URL.
 */
export function CatalogueFilters({
  courses,
  areas,
  formats,
  t,
  locale,
}: {
  courses: CatalogueCourse[];
  areas: AreaChip[];
  formats: { e: ExplainerFormat; k: ExplainerFormat; h: ExplainerFormat };
  t: CatalogueTexts;
  locale: Locale;
}) {
  const id = useId();
  const [params, writeQuery] = useUrlQuery();
  const q = parseCatalogueQuery({ vorm: params.get("vorm") ?? undefined, tase: params.get("tase") ?? undefined, otsi: params.get("otsi") ?? undefined });
  const { vorm, tase } = q;
  const area = parseArea(params.get("valdkond"), areas);
  const [draft, setDraft] = useState<string | null>(null); // the search text while typing; null = follow the URL
  const search = draft ?? q.otsi;
  const [hybridOpen, setHybridOpen] = useState(q.hybrid);
  // the line „Mis vahe on …?“ under „Kõik“ (P6): closed, open for the old ?vorm=h (its hybrid explanation) and after the hybrid note
  const [overviewOpen, setOverviewOpen] = useState(q.hybrid);
  const focusHybrid = useRef(false); // set by the hybrid note; done once the explanation is on screen
  const hybridHeading = useRef<HTMLHeadingElement>(null);

  // Write the catalogue state into the address bar; other parameters are kept. Reads the live URL, not the render's.
  // An area left as it is stays as written, even one the chips do not know (it reads as „Kõik“); "" removes it.
  const write = (changes: { vorm?: FormatFilter; tase?: LevelFilter; valdkond?: string; otsi?: string }) => {
    const live = new URLSearchParams(window.location.search);
    const cur = parseCatalogueQuery({
      vorm: live.get("vorm") ?? undefined,
      tase: live.get("tase") ?? undefined,
      valdkond: live.get("valdkond") ?? undefined,
      otsi: live.get("otsi") ?? undefined,
    });
    const next = { vorm: changes.vorm ?? cur.vorm, tase: changes.tase ?? cur.tase, valdkond: changes.valdkond ?? cur.valdkond, otsi: changes.otsi ?? cur.otsi };
    const merged = new URLSearchParams(catalogueSearch(next).slice(1));
    live.forEach((value, key) => {
      if (key !== "vorm" && key !== "tase" && key !== "valdkond" && key !== "otsi") merged.append(key, value);
    });
    writeQuery(merged);
  };

  const pickFormat = (v: FormatFilter) => {
    setHybridOpen(false);
    write({ vorm: v });
  };
  const pickLevel = (l: LevelFilter) => write({ tase: l });
  const pickArea = (slug: string | null) => write({ valdkond: slug ?? "" });
  const onSearch = (value: string) => {
    setDraft(value);
    write({ otsi: value });
  };
  // From a format's journey panel: hybrid means combining courses of both formats, so show all of them.
  const openHybridFromNote = () => {
    setOverviewOpen(true);
    setHybridOpen(true);
    focusHybrid.current = true;
    write({ vorm: "all" });
  };
  const toggleHybrid = () => {
    setHybridOpen((o) => !o);
    if (params.get("vorm") === "h") write({ vorm: "all" }); // drop the old prototype parameter once used
  };
  const reset = () => {
    setDraft(null);
    setHybridOpen(false);
    write({ vorm: "all", tase: "all", valdkond: "", otsi: "" });
  };

  // The note button disappears with the panel it was in: move focus to the hybrid explanation instead. The format
  // comes from the URL (a router transition), so wait until the "Kõik" view with the open explanation has rendered.
  useEffect(() => {
    if (focusHybrid.current && hybridHeading.current) {
      focusHybrid.current = false;
      hybridHeading.current.focus();
    }
  }, [vorm, hybridOpen]);

  const shown = courses.filter((c) => matchesCatalogue({ type: c.card.type, level: c.level, text: c.text, area: c.area }, { vorm, tase, search, area }));

  const formatChips: [FormatFilter, string][] = [
    ["all", t.filterAll],
    ["e", formats.e.name],
    ["k", formats.k.name],
  ];
  const levelChips: [LevelFilter, string][] = [
    ["all", t.allLevels],
    ["baas", t.levelBasic],
    ["taiend", t.levelAdvanced],
  ];

  return (
    <>
      <div className={styles.bar}>
        <div className={styles.pills} role="group" aria-label={t.formatLabel} data-filter-row="format">
          {formatChips.map(([v, label]) => (
            <button key={v} type="button" className={styles.pill} aria-pressed={vorm === v} onClick={() => pickFormat(v)}>
              {label}
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <Icon name="search" size={18} />
          <span className={ui.srOnly}>{t.search}</span>
          <input
            type="search"
            value={search}
            placeholder={t.search}
            autoComplete="off"
            maxLength={100}
            onChange={(e) => onSearch(e.target.value)}
            onBlur={() => setDraft(null)}
          />
        </label>
      </div>

      <div className={`${styles.pills} ${styles.levels}`} role="group" aria-label={t.levelLabel} data-filter-row="level">
        {levelChips.map(([l, label]) => (
          <button key={l} type="button" className={styles.pill} aria-pressed={tase === l} onClick={() => pickLevel(l)}>
            {label}
          </button>
        ))}
      </div>

      {areas.length > 0 && (
        <div className={`${styles.pills} ${styles.areas}`} role="group" aria-label={t.areaLabel} data-filter-row="area">
          {[{ slug: null, label: t.filterAll }, ...areas].map((a) => (
            <button key={a.slug ?? "all"} type="button" className={styles.pill} aria-pressed={area === a.slug} onClick={() => pickArea(a.slug)}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      <FormatExplainer
        mode={vorm}
        overviewOpen={overviewOpen}
        hybridOpen={hybridOpen}
        formats={formats}
        t={t}
        onFormat={pickFormat}
        onOverviewToggle={() => setOverviewOpen((o) => !o)}
        onHybridToggle={toggleHybrid}
        onHybridNote={openHybridFromNote}
        hybridHeadingRef={hybridHeading}
      />

      <p className={styles.count} aria-live="polite" id={`${id}-results`} data-catalogue-count="">
        {fill(t.count[pluralForm(shown.length, locale)], { n: shown.length })}
      </p>

      {shown.length > 0 ? (
        <div className={styles.grid}>
          {shown.map((c) => (
            <CourseCard key={c.card.id} c={c.card} square sizes="(max-width: 640px) 100vw, (max-width: 1180px) 50vw, 33vw" />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>{t.emptyTitle}</h2>
          <p>{t.emptyText}</p>
          <button type="button" className={ui.btnOutline} onClick={reset}>
            {t.resetFilters}
          </button>
        </div>
      )}
    </>
  );
}
