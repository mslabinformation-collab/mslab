// Text Postgres can store, made from any pasted text (phase protocols: the autosave cleans what Maria pastes before it saves it, and the
// feedback's check uses it). It runs in the browser, on iOS Safari before 16.4 too, so it has no lookbehind (tests/unit/old-safari.test.ts
// walks the browser's imports); storable.ts asks whether it leaves a text as it is: one definition.

/** Word's line break (Shift+Enter: vertical tab) and page break (form feed): pasted, each is a line break, so the words never run together. */
const BREAKS = /[\u000b\u000c]/g;
/** The control characters Postgres refuses in text, or that a pasted document brings: all but tab, line feed and carriage return (and the breaks above). */
const CONTROL_CLASS = "[\\u0000-\\u0008\\u000e-\\u001f\\u007f]";

const CONTROLS = new RegExp(CONTROL_CLASS, "g");
/** A surrogate pair (kept), or a surrogate on its own (dropped): the pair is tried first, so no lookbehind is needed. */
const SURROGATES = /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;

/** `s` without what Postgres cannot store: the words, tabs and line breaks stay (Word's line and page breaks become line breaks); control characters and broken surrogates go. */
export const toStorable = (s: string): string =>
  s
    .replace(BREAKS, "\n")
    .replace(CONTROLS, "")
    .replace(SURROGATES, (m) => (m.length === 2 ? m : ""));
