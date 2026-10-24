"use client";

import { createContext, useContext } from "react";
import type { AutosaveStatus } from "@/domain/autosave";

// The modules card's row texts inside the course editor (admin UX pass piece 3a, Task 9; README B2, §1.3; R-b2): a module's name autosaves on its own
// route (api/admin/moodul/<id>, its „t:“ version), not as one of the editor's parts, yet it belongs to the same screen. SavedCourse.tsx gives this
// context to the card's rows, so that each row's autosave is one more card of the editor: „Avalda muudatused“, „Jah, loobu“ and „Avalikul lehel“ save
// it first, a discard drops its copy in this browser (review I-1 of Task 7: what was thrown away never comes back), its status is in the screen's one
// chip (README §1.4) and its map entry says „Kontrolli“, and while the cards wait it takes no typing. A stored name has the page read again for the
// PublishBar's labels („Moodul {nn}“) and the rows' „avaldamata“ (P-3), which only the server can work out; that read starts no card over. Outside
// the editor (no provider) a row autosaves all the same.

/** One row's text autosave as the editor holds it. */
export type OutlineTextRow = {
  /** Saves now; true when the server holds the text. */
  flush: () => Promise<boolean>;
  /** The server threw the text away („Loobu muudatustest“): its copies in this browser go, nothing more is sent (engine.ts discardCopy). */
  discardCopy: () => void;
};

export type OutlineTexts = {
  /** The row's autosave joins the editor's (the publish, the discard and the switch save it first); returns its leave. */
  join: (row: OutlineTextRow) => () => void;
  /** The row's status now, by its key (null: the row is gone): the screen's chip and the map's „Kontrolli“. */
  report: (key: string, status: AutosaveStatus | null) => void;
  /** The row's text was stored (its version moved): the page's labels are read again. Nothing when a press is on its way (its own read follows). */
  stored: () => void;
  /** The cards wait (a publish, a discard, the switch, a type's save): nothing typed is taken. */
  frozen: boolean;
};

export const OutlineTextsContext = createContext<OutlineTexts | null>(null);

/** The editor's hold on the row texts, or null outside it. */
export const useOutlineTexts = (): OutlineTexts | null => useContext(OutlineTextsContext);
