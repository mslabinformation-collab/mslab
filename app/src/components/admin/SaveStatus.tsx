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

/** The phone top bar's height (Sidebar.module.css .bar, below 900 px): a chip under it is out of view too. */
const PHONE_BAR = 64;

/**
 * Where the following copy stands (06.11 polish board 3) while the chip has gone up out of the window, or under the phone top bar: 16 px from the
 * window's top (below 900 px 8 px under the bar), at the chip's own right edge. Read on scroll and resize, once a frame; null while the chip is in
 * view, or has no box (hidden, not drawn).
 */
function useGoneUp(chip: RefObject<HTMLElement | null>, on: boolean): { right: number; top: number } | null {
  const [gone, setGone] = useState<{ right: number; top: number } | null>(null);
  useEffect(() => {
    if (!on) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const el = chip.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const phone = window.innerWidth < 900;
      const up = box.height > 0 && box.bottom <= (phone ? PHONE_BAR : 0);
      const right = Math.max(16, Math.round(window.innerWidth - box.right));
      const top = phone ? PHONE_BAR + 8 : 16;
      setGone((was) => (!up ? null : was && was.right === right && was.top === top ? was : { right, top }));
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
  }, [chip, on]);
  return on ? gone : null;
}

/**
 * The one status chip of a screen (admin UX pass, README §1.4): what the autosave is doing, in words and in colour. It replaced the editors' save bars and every
 * status line. Placement is the screen's: the right end of the page's H1 row, the drawer's header left of ✕, under the H1 on a phone.
 *
 * - `draft`: the saved state of an unpublished change: „Mustand salvestatud {HH:MM}“.
 * - `compact`: the phone page's short form of the saved state (strings.md D1); drawers keep the full one.
 * - `thing`: the partitive of what the screen edits, for „gone“: „Seda registreerimist enam ei ole. Tekst on selles seadmes alles.“
 * - `onShowInvalid`: the link „Näita“ of the invalid state; it focuses the first invalid field. Without it there is no link.
 *
 * Signed out, the words „logi uuesti sisse“ are a link to the login page and back (SignInAgain, B19), on every screen.
 *
 * For a screen reader the visible chip is hidden and a separate status region speaks the whole sentence, and only when the KIND of status changes
 * (typing, the clock of a second save, a longer list of invalid fields are not news). The ✓ is decoration.
 *
 * - `follow`: the page's own chip in its title row (06.11 polish board 3). While the title row is scrolled up out of the window, a copy of the chip
 *   stands fixed at the top of the window, at the chip's own right edge (useGoneUp), and goes when the chip is back in view. The copy says and does
 *   what the chip does („Näita“, „logi uuesti sisse“), out of the tab order and hidden from a screen reader: the chip's status region speaks, once.
 *   Drawers keep their chip in their header, without it.
 */
export function SaveStatus({
  status,
  draft = false,
  compact = false,
  thing,
  onShowInvalid,
  follow = false,
}: {
  status: AutosaveStatus;
  draft?: boolean;
  compact?: boolean;
  thing?: string;
  onShowInvalid?: () => void;
  follow?: boolean;
}) {
  const full = wordsOf(status, draft, thing);
  const visible = compact ? shortWordsOf(status, draft, thing) : full;
  // what the status region holds: renewed only when the kind of status changes (a state set while rendering is applied before anything is shown)
  const [spoken, setSpoken] = useState({ kind: status.kind, words: full });
  if (spoken.kind !== status.kind) setSpoken({ kind: status.kind, words: full });
  const chip = useRef<HTMLSpanElement>(null);
  const gone = useGoneUp(chip, follow);

  /** The chip's words and its „Näita“; `copy`: the following copy's, out of the tab order. */
  const body = (copy: boolean) => (
    <>
      {/* (signed out, the chip's text itself is not hidden: the link in it must be reachable, and SignInAgain hides the words before it) */}
      <span className={styles.text} aria-hidden={status.kind === "signedOut" && !copy ? undefined : "true"} data-save-text="">
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
    <span ref={chip} className={`${styles.chip} ${styles[toneOf(status)]}`} data-save-status="" data-save-kind={status.kind}>
      {body(false)}
      <span role="status" className={ui.sr}>
        {spoken.words}
      </span>
      {gone &&
        createPortal(
          <span
            className={`${styles.chip} ${styles[toneOf(status)]} ${styles.follow}`}
            style={{ top: gone.top, right: gone.right }}
            aria-hidden="true"
            data-save-follow=""
            data-save-kind={status.kind}
          >
            {body(true)}
          </span>,
          document.body,
        )}
    </span>
  );
}

/**
 * A line of the screen's own words in the chip's place and look (SaveStatus's neutral chip): a new record's drawer before its create button is pressed,
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
