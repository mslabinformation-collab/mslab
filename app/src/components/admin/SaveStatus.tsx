"use client";

import { useState } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatTime } from "@/i18n/format";
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

/**
 * The one status chip of a screen (admin UX pass, README §1.4): what the autosave is doing, in words and in colour. It replaced the editors' save bars and every
 * status line. Placement is the screen's: the right end of the page's H1 row, the drawer's header left of ✕, under the H1 on a phone.
 *
 * - `draft`: the saved state of an unpublished change: „Mustand salvestatud {HH:MM}“.
 * - `compact`: the phone page's short form of the saved state (strings.md D1); drawers keep the full one.
 * - `thing`: the partitive of what the screen edits, for „gone“: „Seda registreerimist enam ei ole. Tekst on selles seadmes alles.“
 * - `onShowInvalid`: the link „Näita“ of the invalid state; it focuses the first invalid field. Without it there is no link.
 *
 * For a screen reader the visible chip is hidden and a separate status region speaks the whole sentence, and only when the KIND of status changes
 * (typing, the clock of a second save, a longer list of invalid fields are not news). The ✓ is decoration.
 */
export function SaveStatus({
  status,
  draft = false,
  compact = false,
  thing,
  onShowInvalid,
}: {
  status: AutosaveStatus;
  draft?: boolean;
  compact?: boolean;
  thing?: string;
  onShowInvalid?: () => void;
}) {
  const full = wordsOf(status, draft, thing);
  const visible = compact ? shortWordsOf(status, draft, thing) : full;
  // what the status region holds: renewed only when the kind of status changes (a state set while rendering is applied before anything is shown)
  const [spoken, setSpoken] = useState({ kind: status.kind, words: full });
  if (spoken.kind !== status.kind) setSpoken({ kind: status.kind, words: full });

  return (
    <span className={`${styles.chip} ${styles[toneOf(status)]}`} data-save-status="" data-save-kind={status.kind}>
      <span className={styles.text} aria-hidden="true" data-save-text="">
        {status.kind === "saved" && (
          <>
            <span aria-hidden="true" data-save-check="">
              ✓
            </span>{" "}
          </>
        )}
        {visible}
      </span>
      {status.kind === "invalid" && onShowInvalid && (
        <button type="button" className={styles.show} onClick={onShowInvalid}>
          {adminEt.autosave.show}
        </button>
      )}
      <span role="status" className={ui.sr}>
        {spoken.words}
      </span>
    </span>
  );
}
