// The autosave's status and the answer of a save (admin UX pass, README §1.3 and §1.4): what a screen's one SaveStatus chip can say, and what a
// per-part save endpoint (`save{Thing}Part(id, part, version, patch)`, B1) answers. Types only: no database, no React. It is imported by the browser
// (useAutosave, SaveStatus, the editors), on iOS Safari before 16.4 as well (tests/unit/old-safari.test.ts), and by the server's actions.

/**
 * What the chip says. The states of README §1.4:
 * - saved: everything is confirmed; `at` is when the server confirmed the last save (null: the page was just opened, nothing saved yet);
 * - dirty: typed, waiting out the 1.5 s; saving: the request is on its way; checking: re-reading the stored text after Back, a hidden tab or a reconnect;
 * - retry: offline or a server error, tried again after 2/5/10/20/30 s; signedOut: a 401, the text is kept on this device;
 * - invalid: a field failed its check and was held back (the others still save); `fields`: the labels of those fields, in screen order;
 * - conflict: another tab or device saved the same part first; gone: the row was deleted meanwhile.
 */
export type AutosaveStatus =
  | { kind: "saved"; at: Date | null }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "checking" }
  | { kind: "retry" }
  | { kind: "invalid"; fields: string[] }
  | { kind: "signedOut" }
  | { kind: "conflict" }
  | { kind: "gone" };

/**
 * A save endpoint's answer. `version` is the part's version after the save (ok) or what the server holds now (conflict); `savedAt` an ISO time.
 * A conflict brings the stored `value` of the part, which the screen shows with its own unsaved text in the notice (README §1.3, „Taasta minu tekst“).
 * An invalid answer is per field: key = the field's name in the patch, value = the text to show at the field.
 */
export type SaveAnswer =
  | { ok: true; version: string; savedAt: string }
  | { ok: false; error: "conflict"; version: string; value: unknown }
  | { ok: false; error: "invalid"; fields: Record<string, string> };
