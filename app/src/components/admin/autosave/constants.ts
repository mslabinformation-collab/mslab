// The timings and limits both autosaves share (the protocol screen's, protocol-autosave.ts, and the editors', autosave/engine.ts). They live here, with
// no imports, so the editors' engine does not pull the protocol screen's whole module (and its domain code) into every editor's chunk, and so
// the protocol screen can move onto the engine (the A screens) without a cycle between the two. protocol-autosave.ts re-exports them unchanged.
// Old iPads run this: no regex lookbehind, no crypto.randomUUID (tests/unit/old-safari.test.ts).

/** A field saves this long after the last change (and sooner on a blur, a switch or leaving). */
export const DEBOUNCE_MS = 1500;
/** A save that has not been answered in 10 s is given up (and kept, and tried again). */
export const SAVE_TIMEOUT_MS = 10_000;
/** The waits before trying a failed save again; the last one repeats. */
export const RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000] as const;

/** The most text this browser keeps of the saves sent without an answer, in characters (one protocol at its limits holds 310 000). */
export const SENT_MAX_CHARS = 200_000;
/** The most a page that is put away sends as keepalive requests, in bytes (the browsers' limit for them all is 64 KiB). */
export const KEEPALIVE_MAX_BYTES = 64_000;
