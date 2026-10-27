// The UndoBar's two timings as one fact (admin UX pass, README §1.7, B5; piece 4c review M-2): how long „Võta tagasi“ is on offer, and how old a
// soft delete's mark must be before the server purges it. The purge waits longer than the bar, so that it never takes a thing whose bar could
// still be pressed. The bar (components/admin/UndoBar.tsx) runs in the browser, the purges (server/lesson-file-purge.ts, server/review-purge.ts) on
// the server: pure, imports nothing, no lookbehind (tests/unit/old-safari.test.ts).

/** How long „Võta tagasi“ is on offer after a one-tap action. */
export const UNDO_LASTS_MS = 8_000;

/** How old a soft delete's mark must be before it is purged: the bar's time and a margin. Never less. */
export const PURGE_AFTER_MS = UNDO_LASTS_MS + 2_000;
