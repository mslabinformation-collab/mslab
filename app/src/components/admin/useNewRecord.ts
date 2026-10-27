"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useGuardSource } from "./LeaveGuard";

// A record made by its one explicit button in a drawer — Kalender's „Lisa toimumine“ (SessionForm.tsx NewSession, piece 3b) and Tagasiside's „Lisa
// arvustus“ (ManualReviewForm.tsx NewReviewForm, piece 4c) — and what the two share (piece4-texts S3-P3-g, S4-39; Task 2 review I-1):
// - the fields as typed, with the codes of the refused ones (the drawer's own check before the press, or the server's) until each is typed in again;
//   a refusal puts the focus on the first refused field, in the screen's order;
// - this browser's copy of what is typed and not created yet (`mslab-draft:<owner>:uus`, one per browser): brought back after hydration when the
//   drawer opens again, followed from then on, and dropped once the record is created (or thrown away by the drawer's „Katkesta“);
// - the leave guard: typed and not created yet, leaving asks, naming the first field typed into, with „{Asja} pole veel lisatud.“ (`thing`).
// It runs on old iPads: no regular expression with a lookbehind here (tests/unit/old-safari.test.ts).

/** The copy in this browser under `key`, read defensively: null when there is none (or it is no object), else `read`'s fields (each checked there). */
export function readNewCopy<F>(key: string, read: (raw: Record<string, unknown>) => F): F | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return read(raw as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Keeps `value` as the copy under `key` (null: drops it). */
export function writeNewCopy(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // full or blocked: nothing is kept
  }
}

/** The first field of `order` whose value is not the empty record's, or null: nothing typed. */
export function firstTyped<K extends string>(order: readonly K[], fields: Record<K, unknown>, empty: Record<K, unknown>): K | null {
  return order.find((k) => fields[k] !== empty[k]) ?? null;
}

/** The field `name` of the form `form` (a selector): the one in the open drawer, else any (the leave guard's „Jää siia“, a refusal, „Näita“). */
export function focusFormField(form: string, name: string): void {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`${form} [name="${name}"]`));
  (all.find((el) => el.closest("dialog[data-drawer][open]") !== null) ?? all[0])?.focus();
}

export type NewRecord<K extends string, F extends Record<K, unknown>> = {
  fields: F;
  setFields: Dispatch<SetStateAction<F>>;
  /** A field typed into: its value, and its refusal's code goes. */
  setField: (field: K, value: F[K]) => void;
  /** The refused fields' codes, until each is typed in again. */
  refused: Partial<Record<K, string>>;
  /** Marks the refused fields (only those of `order`) and focuses the first. */
  refuse: (codes: Record<string, string | undefined>) => void;
  clearRefused: () => void;
  /** The first field typed into, or null. */
  typed: K | null;
  /** Created (or thrown away): the copy goes, and the guard asks nothing any more. */
  finish: () => void;
  finished: () => boolean;
};

export function useNewRecord<K extends string, F extends Record<K, unknown>>(o: {
  /** The copy's key in this browser's storage. */
  copyKey: string;
  /** The fields of a record before anything is typed. */
  empty: F;
  /** A kept copy's fields, each checked (anything of the wrong kind is the empty record's). */
  read: (raw: Record<string, unknown>) => F;
  /** The fields in the screen's order. */
  order: readonly K[];
  /** The leave guard's thing, in the partitive and capitalised („Toimumist“, „Arvustust“). */
  thing: string;
  label: (field: K) => string;
  focus: (field: K) => void;
}): NewRecord<K, F> {
  const id = useId();
  const [fields, setFields] = useState<F>(o.empty);
  const [refused, setRefused] = useState<Partial<Record<K, string>>>({});
  const [focusTo, setFocusTo] = useState<{ name: K } | null>(null);
  const done = useRef(false);
  /** The newest options, for the effects and the guard (a caller's `read` closes over its props). */
  const live = useRef(o);
  useLayoutEffect(() => {
    live.current = o;
  });

  // the copy an earlier visit kept comes back (after the first render: the server knows no browser storage); from then on it follows the fields
  const restored = useRef(false);
  useEffect(() => {
    const { copyKey, empty, read, order } = live.current;
    if (!restored.current) {
      restored.current = true;
      const copy = readNewCopy(copyKey, read);
      // (the storage is only known in the browser, after hydration: the first render is the empty record, the server's)
      if (copy && firstTyped(order, copy, empty) !== null) setFields(copy);
      return;
    }
    if (!done.current) writeNewCopy(copyKey, firstTyped(order, fields, empty) === null ? null : fields);
  }, [fields]);

  useEffect(() => {
    if (focusTo) live.current.focus(focusTo.name);
  }, [focusTo]);

  const typed = firstTyped(o.order, fields, o.empty);
  useGuardSource({
    id,
    label: () => live.current.label(typed ?? live.current.order[0]),
    flush: async () => false,
    unconfirmed: () => (!done.current && typed ? { reason: "notCreated", thing: live.current.thing } : null),
    focus: () => live.current.focus(typed ?? live.current.order[0]),
  });

  return {
    fields,
    setFields,
    setField: (field, value) => {
      setRefused((r) => (r[field] === undefined ? r : { ...r, [field]: undefined }));
      setFields((f) => ({ ...f, [field]: value }));
    },
    refused,
    refuse: (codes) => {
      const order = live.current.order;
      setRefused(Object.fromEntries(order.filter((k) => codes[k] !== undefined).map((k) => [k, codes[k]])) as Partial<Record<K, string>>);
      const first = order.find((k) => codes[k] !== undefined);
      if (first) setFocusTo({ name: first });
    },
    clearRefused: () => setRefused({}),
    typed,
    finish: () => {
      done.current = true;
      writeNewCopy(live.current.copyKey, null);
    },
    finished: () => done.current,
  };
}
