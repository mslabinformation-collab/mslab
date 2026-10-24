// Where the focus may go after an undo (admin UX pass piece 3a; final review P10-1: one helper for the list editors and the lesson drawer). The
// UndoBar's „Võta tagasi“ brings a thing back — a list's row (useListRows.ts), a lesson's file (LessonFiles.tsx) or its „Õpilastele nähtav“
// (LessonDrawer.tsx) — and the thing may take the focus only where the focus fell with the bar, never from where she has moved it since.

/** The focus has nowhere to be: on <body>, on an element that is gone, or in the UndoBar (which goes once its undo is done). */
export function focusFell(): boolean {
  const now = document.activeElement;
  return !now || now === document.body || !now.isConnected || now.closest("[data-undo-bar]") !== null;
}
