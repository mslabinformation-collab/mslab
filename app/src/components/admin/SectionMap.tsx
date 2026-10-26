"use client";

import { useState, type MouseEvent } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import styles from "./SectionMap.module.css";

export type SectionEntry = {
  /** The id of the page's card for this entry: the link goes to `#id`. */
  id: string;
  label: string;
  /** How many rows the card holds („Õpiväljundid 4“). */
  count?: number;
  /** „RU puudub“ (the Russian text is missing) or „Kontrolli“, in #6b4f5c. */
  flag?: "ru" | "check";
  /** How many of its texts have an unpublished change: „{n} avaldamata“ (Seaded's „Lepingud ja tingimused“, piece3-texts P-11), in #6b4f5c; none at 0. */
  unpublished?: number;
};

/**
 * The class of a card the map points at: it keeps the card's top 24 px clear of the top of the window when the card is scrolled to, and 64 px more below
 * 900 px, where the phone top bar is. Give it to every card that has an entry here, with the id of the entry. (Import it from a client file: a server file
 * gets a reference to this module's exports, not the class name.)
 */
export const sectionCard: string = styles.card;

/**
 * The map of a long editor page (README B2; the Part 3 and 4 prototypes): from 1180 px a 190 px sticky list of links to the page's cards, each with its
 * count, „RU puudub“ or „Kontrolli“ at the right; below that a select „Jaotised ▾“ (it shows „Jaotised · {the card}“) in its place. A tap or a choice
 * scrolls to the card, smoothly unless the reader asked for less motion, and moves the focus into a card that can take it (`tabIndex={-1}`), so a keyboard
 * user starts reading where the page went. The page does not split into tabs: the cards stay in one long page.
 *
 * It renders no wrapper (a fragment of the list and the select), so that in the page's grid the list is a grid item of its own and `position: sticky`
 * has the whole column to move in. The page decides where it goes: the first column from 1180 px, under the heading below it. `width`: the list's
 * width, 190 px (the B screens) or 170 px (the C screens' site-editor template, piece 4a; the Part 4 frames' `170px minmax(0,1fr)`), which the page's
 * grid gives its column too.
 */
export function SectionMap({ sections, width = 190 }: { sections: SectionEntry[]; width?: 170 | 190 }) {
  const t = adminEt.sectionMap;
  const [chosen, setChosen] = useState(sections[0]?.id);
  // the entry that was chosen last, or the first one when it is not there any more (the card follows the draft „Õppevorm“)
  const current = sections.find((s) => s.id === chosen) ?? sections[0];

  const go = (id: string) => {
    setChosen(id);
    const card = document.getElementById(id);
    if (!card) return;
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
    if (card.hasAttribute("tabindex")) card.focus({ preventScroll: true });
  };

  const onLink = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    // a new tab, a new window and the like are the browser's own
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(id);
  };

  /** „{n} avaldamata“ while some of an entry's texts wait for their publish. */
  const waiting = (s: SectionEntry) => (s.unpublished ? fill(t.unpublished, { n: s.unpublished }) : "");
  /** "4", "RU puudub", "6 · RU puudub", "1 avaldamata": the entry's status as one text (the select's options). */
  const statusText = (s: SectionEntry) => [s.count === undefined ? "" : String(s.count), s.flag ? t[s.flag] : "", waiting(s)].filter(Boolean).join(t.join);

  return (
    <>
      <nav className={width === 170 ? `${styles.nav} ${styles.narrow}` : styles.nav} aria-label={t.label} data-fab-avoid="">
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={styles.link} aria-current={s.id === current?.id ? "true" : undefined} onClick={(e) => onLink(e, s.id)}>
            <span data-section-label="">{s.label}</span>
            <span className={styles.status} data-section-status="">
              {s.count !== undefined && <span data-count="">{s.count}</span>}
              {s.count !== undefined && s.flag && t.join}
              {s.flag && <span data-flag={s.flag}>{t[s.flag]}</span>}
              {(s.count !== undefined || s.flag) && waiting(s) && t.join}
              {waiting(s) && <span data-unpublished="">{waiting(s)}</span>}
            </span>
          </a>
        ))}
      </nav>
      <div className={styles.select} data-section-select="">
        <select aria-label={t.label} value={current?.id} onChange={(e) => go(e.target.value)}>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {statusText(s) ? `${s.label}${t.join}${statusText(s)}` : s.label}
            </option>
          ))}
        </select>
        {/* what the eye sees: the select itself lies over it, invisible, so a tap anywhere on the box opens the list */}
        <span className={styles.face} data-section-face="" aria-hidden="true">
          <span>
            <span className={styles.prefix}>
              {t.label}
              {t.join}
            </span>
            {current?.label}
          </span>{" "}
          <span aria-hidden="true" className={styles.caret}>
            ▾
          </span>
        </span>
      </div>
    </>
  );
}
