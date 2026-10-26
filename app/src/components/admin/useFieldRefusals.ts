"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Fields, SendPatch } from "./autosave/engine";
import { listChange } from "./course/course-view";

// What an editor's part keeps of its saves' answers, beside the shared engine (autosave/engine.ts): a course card's (course/useCoursePart.ts) and a
// site part's (site/useSitePart.ts), written once (piece 4a Task 2 review M-1). A 400's field codes are kept with the value each refused field was sent
// with, so a card can say at the field what its check refused (the engine holds those fields back and saves the rest) and a list can place the words
// on the row they are about, by the row's key in what was sent; a field typed in again or saved loses its words. The saves the server took are
// counted, as rendered (`saves`) and as they are this moment (`savedNow()`, counted before the save's promise resolves: a press that awaited its own
// flush reads its save, piece 4a Task 2 review I-1). And a part's changes: typed (`take`), or worked out from the field as it is when they land
// (`update`), a list's rows added, removed or moved saving at once (README §1.3).

type Answer = Awaited<ReturnType<SendPatch>>;
/** A refused field: its code, and the value the refused save sent. */
export type Refusal = { code: string; sent: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function useFieldRefusals() {
  /** Each refused field's code and the value the refused save sent. */
  const [codes, setCodes] = useState<Record<string, Refusal>>({});
  /** The saves the server took since the part started (a part the publish held is listed until its next one, review M-3 of piece 3a). */
  const [saves, setSaves] = useState(0);
  const saved = useRef(0);
  /** A save's answer, as the sender hears it (null: none): a 400's codes of the fields it sent kept; a 200 takes its fields' words and counts. */
  const hear = useCallback((patch: Fields, answer: Answer) => {
    const reply = answer && isRecord(answer.body) ? answer.body : null;
    if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
      const named = Object.fromEntries(
        Object.entries(reply.fields)
          .filter(([name, code]) => name in patch && typeof code === "string")
          .map(([name, code]) => [name, { code: code as string, sent: patch[name] }]),
      );
      setCodes((c) => ({ ...c, ...named }));
    } else if (answer?.status === 200 && reply?.ok === true) {
      setCodes((c) => Object.fromEntries(Object.entries(c).filter(([name]) => !(name in patch))));
      saved.current += 1;
      setSaves(saved.current);
    }
  }, []);
  /** A field typed in: its refusal's words go. */
  const clear = useCallback((name: string) => setCodes((c) => (name in c ? Object.fromEntries(Object.entries(c).filter(([n]) => n !== name)) : c)), []);
  /** The saves the server took, this moment. */
  const savedNow = useCallback(() => saved.current, []);
  return { codes, saves, savedNow, hear, clear };
}

/**
 * A part's changes for its api: `take`, a field typed in (its refusal's words go, the engine has it); `update`, a change worked out from the field as
 * the newest render holds it (`latest`, which it moves on, so an upload that ends after other changes adds to the list as it is by then) — a list's
 * rows added, removed or moved save now (`flush`), a text typed in a row waits.
 */
export function useFieldEdits(o: { latest: LatestFields; setField: (name: string, value: unknown) => void; flush: () => Promise<boolean>; clear: (name: string) => void }) {
  const { setField, flush, clear } = o;
  const { now, move } = o.latest;
  const take = useCallback(
    (name: string, value: unknown) => {
      clear(name);
      setField(name, value);
    },
    [clear, setField],
  );
  const update = useCallback(
    (name: string, fn: (current: unknown) => unknown) => {
      const before = now()[name];
      const after = fn(before);
      move({ ...now(), [name]: after });
      take(name, after);
      if (Array.isArray(before) && Array.isArray(after) && listChange(before, after) === "instant") void flush();
    },
    [now, move, take, flush],
  );
  return { take, update };
}

/** What the newest render holds of a part's fields, outside React's state: `now()`, and `move(fields)` (after each render, and by `update`). */
export type LatestFields = { now: () => Fields; move: (fields: Fields) => void };

/** A part's LatestFields, starting from `initial`. */
export function useLatestFields(initial: Fields): LatestFields {
  const ref = useRef(initial);
  const now = useCallback(() => ref.current, []);
  const move = useCallback((fields: Fields) => {
    ref.current = fields;
  }, []);
  return useMemo(() => ({ now, move }), [now, move]);
}
