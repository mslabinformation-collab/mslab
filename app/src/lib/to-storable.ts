// Text Postgres can store, made from any pasted text (phase protocols: the autosave cleans what Maria pastes before it saves it, and the
// feedback's check uses it). It runs in the browser, on iOS Safari before 16.4 too, so it has no lookbehind (tests/unit/old-safari.test.ts
// walks the browser's imports); storable.ts asks whether it leaves a text as it is: one definition.

/** The control characters Postgres refuses in text, or that a pasted document brings: all but tab, line feed and carriage return. */
const CONTROL_CLASS = "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]";

const CONTROLS = new RegExp(CONTROL_CLASS, "g");
/** A surrogate pair (kept), or a surrogate on its own (dropped): the pair is tried first, so no lookbehind is needed. */
const SURROGATES = /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;

/** `s` without what Postgres cannot store: the words, tabs and line breaks stay; control characters and broken surrogates go. */
export const toStorable = (s: string): string => s.replace(CONTROLS, "").replace(SURROGATES, (m) => (m.length === 2 ? m : ""));
