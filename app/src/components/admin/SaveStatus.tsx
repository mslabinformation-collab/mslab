"use client";

import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AutosaveStatus } from "@/domain/autosave";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatTime } from "@/i18n/format";
import { adminLoginHref } from "@/lib/admin-return";
import ui from "./ui.module.css";
import styles from "./SaveStatus.module.css";

type Tone = "saved" | "neutral" | "error";

/** README §1.4: green when everything is confirmed, grey while a save is on its way, red when she has to know. */
function toneOf(status: AutosaveStatus): Tone {
  switch (status.kind) {
    case "saved":
      return "saved";
    case "dirty":
    case "saving":
    case "checking":
      return "neutral";
    case "retry":
    case "invalid":
    case "signedOut":
    case "conflict":
    case "gone":
      return "error";
  }
}

/** The whole sentence of a state (the status region speaks it, and the chip shows it unless `compact` shortens the saved one). */
function wordsOf(status: AutosaveStatus, draft: boolean, thing: string | undefined): string {
  const t = adminEt.autosave;
  switch (status.kind) {
    case "saved": {
      const time = clock(status.at);
      if (draft) return time ? fill(t.draft, { time }) : t.draftNoTime;
      return time ? fill(t.saved, { time }) : t.savedNoTime;
    }
    case "dirty":
      return t.dirty;
    case "saving":
      return t.saving;
    case "checking":
      return t.checking;
    case "retry":
      return t.retry;
    case "invalid":
      return t.invalid;
    case "signedOut":
      return t.signedOut;
    case "conflict":
      return t.conflict;
    case "gone":
      return fill(t.gone, { thing: thing ?? t.goneThing });
  }
}

/** "HH:MM" in Tallinn, or null before the first save (and for a date that is not one). */
function clock(at: Date | null): string | null {
  return at && !Number.isNaN(at.getTime()) ? formatTime(at, "et") : null;
}

/** The phone page's chip (strings.md D1): „✓ Mustand 14:02“, „✓ 11:20“; the other states keep their words. */
function shortWordsOf(status: AutosaveStatus, draft: boolean, thing: string | undefined): string {
  if (status.kind !== "saved") return wordsOf(status, draft, thing);
  const t = adminEt.autosave;
  const time = clock(status.at);
  if (draft) return time ? fill(t.draftShort, { time }) : t.draftShortNoTime;
  return time ?? t.savedNoTime;
}

/** This page's path, query and fragment (for useSyncExternalStore); null on the server. */
const here = () => window.location.pathname + window.location.search + window.location.hash;
const nowhere = () => null;
function onMove(change: () => void): () => void {
  window.addEventListener("hashchange", change);
  window.addEventListener("popstate", change);
  return () => {
    window.removeEventListener("hashchange", change);
    window.removeEventListener("popstate", change);
  };
}

/**
 * The signed-out words with „logi uuesti sisse“ a link to the login page, which brings her back to this page after signing in (B19: ?tagasi= with the
 * path, the query and the fragment). The words are the chip's own (no new text). The link stays reachable by a screen reader, so only the words
 * before it are hidden (the status region says the whole sentence). The router moves without an event, so the page is read again when the link
 * is focused or pressed.
 */
function SignInAgain({ copy = false }: { copy?: boolean }) {
  const t = adminEt.autosave;
  const at = t.signedOut.lastIndexOf(t.signedOutLink);
  const [, readAgain] = useReducer((n: number) => n + 1, 0);
  const href = adminLoginHref(useSyncExternalStore(onMove, here, nowhere));
  return (
    <>
      <span aria-hidden="true">{t.signedOut.slice(0, at)}</span>
      <a className={styles.signIn} href={href} onFocus={readAgain} onPointerDown={readAgain} tabIndex={copy ? -1 : undefined}>
        {t.signedOutLink}
      </a>
    </>
  );
}

/** The phone top bar's height (Sidebar.module.css .bar, below 900 px): a line under it is out of view too. */
const PHONE_BAR = 64;

/**
 * Which of the admin frame's slots (Sidebar.tsx: `data-save-follow-slot`) the following copy goes to while the line has gone up out of the window, or
 * under the phone top bar: "side" from 900 px, "bar" below. Read on scroll and resize, once a frame; null while the line is in view or has no box.
 */
function useGoneUp(line: RefObject<HTMLElement | null>, on: boolean): "side" | "bar" | null {
  const [gone, setGone] = useState<"side" | "bar" | null>(null);
  useEffect(() => {
    if (!on) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const el = line.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const phone = window.innerWidth < 900;
      setGone(box.height > 0 && box.bottom <= (phone ? PHONE_BAR : 0) ? (phone ? "bar" : "side") : null);
    };
    const ask = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    window.addEventListener("scroll", ask, { passive: true });
    window.addEventListener("resize", ask);
    read();
    return () => {
      window.removeEventListener("scroll", ask);
      window.removeEventListener("resize", ask);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [line, on]);
  return on ? gone : null;
}

/** The saved time a status holds, as a number (null: none) — undefined for a state that is not "saved". */
const savedAt = (status: AutosaveStatus): number | null | undefined => (status.kind === "saved" ? (status.at?.getTime() ?? null) : undefined);

/**
 * Whether anything has happened since the screen opened (UX pass 11.11 A17): false while the status is still the saved state it opened with, true
 * from the first other state or save time on, for good. SaveStatus keeps its own; a screen that moves its SaveStatus from one place to another (an
 * editor's header and its PublishBar) keeps it itself and hands it over as `news`, so the move does not start it over.
 */
export function useSaveNews(status: AutosaveStatus): boolean {
  // (state set while rendering is applied before anything is shown)
  const [opened] = useState(() => savedAt(status));
  const [moved, setMoved] = useState(() => status.kind !== "saved");
  const news = moved || status.kind !== "saved" || savedAt(status) !== opened;
  if (news && !moved) setMoved(true);
  return news;
}

/**
 * The one status line of a screen (admin UX pass, README §1.4; UX pass 11.11, A1/A17): what the autosave is doing, in quiet words in the state's colour
 * (no pill: it never stands over a button). Placement is the screen's: the page's header (its H1 row; under the H1 on a phone), a drawer's header left
 * of ✕, and an editor's PublishBar while the bar shows (the editors give it its `status` slot).
 *
 * It says nothing until something changes: the state a screen opens with (saved, at the time of the last save or none) is no news (A17: no
 * „✓ Salvestatud“ the moment a drawer opens). From the first change on — typing, a save, a state that needs her — it stays.
 *
 * - `draft`: the saved state of an unpublished change: „Mustand salvestatud kell {HH:MM}“.
 * - `compact`: the phone page's short form of the saved state (strings.md D1); drawers keep the full one.
 * - `thing`: the partitive of what the screen edits, for „gone“: „Seda registreerimist enam ei ole. Tekst on selles seadmes alles.“
 * - `onShowInvalid`: the link „Näita“ of the invalid state; it focuses the first invalid field. Without it there is no link.
 * - `news`: the screen's own useSaveNews, where it moves the line (see there).
 * - `follow`: the page's own line (its header, or its PublishBar on a computer). While it is scrolled up out of the window and its state needs her
 *   (the red ones: retry, invalid, signed out, conflict, gone), a copy stands in the admin's frame — the sidebar under the logo, the phone top bar in
 *   the title's place (Sidebar.tsx's slots) — never over the page, so it covers no button (review of A1: the old fixed pill stood on
 *   „Loobu muudatustest“). The quiet states stay in the line only. The copy says and does what the line does („Näita“, „logi uuesti sisse“), out
 *   of the tab order and hidden from a screen reader: the line's status region speaks, once. Drawers keep their line in their header, without it.
 *
 * Signed out, the words „logi uuesti sisse“ are a link to the login page and back (SignInAgain, B19), on every screen.
 *
 * For a screen reader the visible words are hidden and a separate status region speaks the whole sentence, and only when the KIND of status changes
 * (typing, the clock of a second save, a longer list of invalid fields are not news). The ✓ is decoration.
 */
export function SaveStatus({
  status,
  draft = false,
  compact = false,
  thing,
  onShowInvalid,
  news: given,
  follow = false,
}: {
  status: AutosaveStatus;
  draft?: boolean;
  compact?: boolean;
  thing?: string;
  onShowInvalid?: () => void;
  news?: boolean;
  follow?: boolean;
}) {
  const full = wordsOf(status, draft, thing);
  const visible = compact ? shortWordsOf(status, draft, thing) : full;
  const own = useSaveNews(status);
  const news = given ?? own;
  // what the status region holds: renewed only when the kind of status changes
  const [spoken, setSpoken] = useState({ kind: status.kind, words: news ? full : "" });
  if (news && (spoken.kind !== status.kind || spoken.words === "")) setSpoken({ kind: status.kind, words: full });
  const line = useRef<HTMLSpanElement>(null);
  const gone = useGoneUp(line, follow && toneOf(status) === "error");
  const slot = gone && document.querySelector(`[data-save-follow-slot="${gone}"]`);

  /** The line's words and its „Näita“; `copy`: the following copy's, out of the tab order. */
  const body = (copy: boolean) => (
    <>
      {/* (signed out, the line's text itself is not hidden: the link in it must be reachable, and SignInAgain hides the words before it) */}
      <span className={styles.text} aria-hidden={status.kind === "signedOut" && !copy ? undefined : "true"} data-save-text={copy ? undefined : ""}>
        {status.kind === "saved" && (
          <>
            <span aria-hidden="true" data-save-check="">
              ✓
            </span>{" "}
          </>
        )}
        {status.kind === "signedOut" ? <SignInAgain copy={copy} /> : visible}
      </span>
      {status.kind === "invalid" && onShowInvalid && (
        <button type="button" className={styles.show} onClick={onShowInvalid} tabIndex={copy ? -1 : undefined}>
          {adminEt.autosave.show}
        </button>
      )}
    </>
  );

  return (
    <span ref={line} className={`${styles.chip} ${styles[toneOf(status)]}`} data-save-status="" data-save-kind={status.kind} data-save-quiet={news ? undefined : ""}>
      {news && body(false)}
      <span role="status" className={ui.sr}>
        {spoken.words}
      </span>
      {slot &&
        createPortal(
          <span className={`${styles.chip} ${styles.error} ${styles.follow}`} aria-hidden="true" data-save-follow="" data-save-kind={status.kind}>
            {body(true)}
          </span>,
          slot,
        )}
    </span>
  );
}

/**
 * A line of the screen's own words in the status line's place and look (SaveStatus's neutral words): a new record's drawer before its create button is pressed,
 * where nothing autosaves yet (admin polish F22: „Lisa arvustus +“, Kalender's „Lisa toimumine +“). It is the status region itself; `data-*` name it
 * for tests.
 */
export function StatusLine({ children, ...data }: { children: ReactNode } & { [attribute: `data-${string}`]: string }) {
  return (
    <span className={`${styles.chip} ${styles.neutral}`} role="status" {...data}>
      <span className={styles.text}>{children}</span>
    </span>
  );
}
