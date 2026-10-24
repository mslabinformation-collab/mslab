import { useId, useState } from "react";
import { stableJson } from "@/lib/version";

// Row keys for the list editors' JSON rows (admin UX pass piece 3a, Task 8; README B2 "errors keyed by row id"; BEH B5): an outcome, a programme
// point, a protocol heading or a certificate line is a text in a JSON array with no id of its own, so the editor gives each row a key of its own
// and keeps it for as long as it is on the page — through a move, through typing, and through an undo, which brings a removed row back with the key
// it had. DragList finds the moved row by it (the focus), and React keeps the row's field (the cursor) by it.
//
// The keys a list starts with are rendered by the server too (DragList's data-drag-row): they are made from the editor's useId and the row's place,
// so the browser's hydration finds the same ones (review I-1). Only rows made in the browser later get a key of the tab's own counter.
//
// The editor knows its own changes (`expect`: the list they make and its keys). Any other change of the list — the card's update applied to the list
// as it is when it lands (an undo, perhaps after the cards started over), a list read again — is followed from the rows' contents: one place where rows
// came in or went out, the same rows in another order, or a row typed in at its place; a row that comes back with the content of one removed a moment
// ago gets that row's key back. Old iPads run it: no regex lookbehind, no crypto.randomUUID (tests/unit/old-safari.test.ts).

/** How many removed rows' keys are kept for an undo (the UndoBar offers only the last one; a few more cover a late update). */
const GONE_MAX = 20;

let made = 0;
/** A new key for a row made in this browser (added, or come in from outside), unique in this tab. Never for a list's first rows: see startKeys. */
export const newRowKey = (): string => `row-${++made}`;

export type RowKeys = {
  /** The list the keys are for: the reference the editor last saw. */
  items: readonly unknown[];
  /** Each row's content (stableJson). */
  sigs: string[];
  keys: string[];
  /** The editor's own change on its way: the list it makes (its content) and its keys. */
  expected: { sig: string; keys: string[] } | null;
  /** Rows taken out, the newest last: one that comes back gets its key back. */
  gone: { key: string; sig: string }[];
};

const listSig = (sigs: readonly string[]): string => `[${sigs.join(",")}]`;

/** The keys of a list as an editor starts: `seed(index)`, the same on the server and in the browser (the editor's useId and the row's place). */
export function startKeys(items: readonly unknown[], seed: (index: number) => string): RowKeys {
  return { items, sigs: items.map(stableJson), keys: items.map((_, i) => seed(i)), expected: null, gone: [] };
}

/** The editor's own change: the list `next` is to have the keys `keys` (in its order) when it comes. */
export function expectKeys(state: RowKeys, next: readonly unknown[], keys: string[]): RowKeys {
  return { ...state, expected: { sig: listSig(next.map(stableJson)), keys } };
}

/** The keys of `items`, the list that came after `state.items`. */
export function followKeys(state: RowKeys, items: readonly unknown[], make: () => string = newRowKey): RowKeys {
  const sigs = items.map(stableJson);
  const gone = [...state.gone];
  /** A key for a row that came in: a removed row's with the same content (the newest), else a new one. */
  const revive = (sig: string): string => {
    for (let g = gone.length - 1; g >= 0; g--) if (gone[g].sig === sig) return gone.splice(g, 1)[0].key;
    return make();
  };
  const own = state.expected && state.expected.sig === listSig(sigs) && state.expected.keys.length === items.length ? state.expected.keys : null;
  const keys = own ?? matchKeys(state.sigs, state.keys, sigs, revive);
  // the rows that went out: kept for a moment, so an undo finds them
  const kept = new Set(keys);
  state.keys.forEach((key, i) => {
    if (!kept.has(key)) gone.push({ key, sig: state.sigs[i] });
  });
  return { items, sigs, keys, expected: null, gone: gone.filter((g) => !kept.has(g.key)).slice(-GONE_MAX) };
}

/** The old rows' keys onto the new rows, from the rows' contents. */
function matchKeys(oldSigs: readonly string[], oldKeys: readonly string[], sigs: readonly string[], revive: (sig: string) => string): string[] {
  const n = oldSigs.length;
  const m = sigs.length;
  // rows the same at the start and at the end: what is between them came in or went out at one place
  let head = 0;
  while (head < n && head < m && oldSigs[head] === sigs[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && oldSigs[n - 1 - tail] === sigs[m - 1 - tail]) tail++;
  if (head + tail === n) return [...oldKeys.slice(0, head), ...sigs.slice(head, m - tail).map(revive), ...oldKeys.slice(n - tail)];
  if (head + tail === m) return [...oldKeys.slice(0, head), ...oldKeys.slice(n - tail)];
  if (m === n) {
    const sorted = (list: readonly string[]) => [...list].sort().join("\u0000");
    // a row typed in at its place: the rows keep their places
    if (sorted(oldSigs) !== sorted(sigs)) return [...oldKeys];
  }
  // the same rows in another order (a move), or anything else: each row by its content, its own place first; a row not there before, a key of its own
  const used = new Set<number>();
  return sigs.map((sig, i) => {
    let j = i < n && oldSigs[i] === sig ? i : -1;
    if (j < 0 || used.has(j)) j = oldSigs.findIndex((s, k) => s === sig && !used.has(k));
    if (j < 0) return revive(sig);
    used.add(j);
    return oldKeys[j];
  });
}

/**
 * An editor's row keys for `items` (React state, followed during the render as the list changes). `expect(next, keys)`: the editor's own change is
 * the list `next` with these keys.
 */
export function useRowKeys(items: readonly unknown[]): { keys: string[]; expect: (next: readonly unknown[], keys: string[]) => void } {
  const uid = useId();
  const [state, setState] = useState(() => startKeys(items, (i) => `${uid}r${i}`));
  let now = state;
  if (state.items !== items) {
    now = followKeys(state, items);
    setState(now);
  }
  return { keys: now.keys, expect: (next, keys) => setState((s) => expectKeys(s, next, keys)) };
}

/** A row put back at `index` (or at the end of a shorter list). */
export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/**
 * The row `item` taken out of the list as it is now: at `index` when it is still there, else where it is nearest to it; none like it, no change. A
 * row is known by its whole content, or by `same` (a row with an id of its own: a picture by its key, whatever its description is by then).
 */
export function removeAt<T>(list: readonly T[], index: number, item: T, same?: (x: T) => boolean): T[] {
  const sig = same ? "" : stableJson(item);
  const is = same ?? ((x: T) => stableJson(x) === sig);
  let at = -1;
  list.forEach((x, i) => {
    if (is(x) && (at < 0 || Math.abs(i - index) < Math.abs(at - index))) at = i;
  });
  return at < 0 ? [...list] : list.filter((_, i) => i !== at);
}
