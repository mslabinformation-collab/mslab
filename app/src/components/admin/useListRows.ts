"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useUndo } from "./UndoBar";

// The list editors' shared rows plumbing (admin UX pass piece 3a, Task 8; review M-3): ListEditor, ProtocolStagesEditor, TestEditor and
// GalleryEditor change their rows (add, move, remove, undo) through `change`, which works on the list as it is when the change lands: the page's
// `onUpdate` (the course card's update, which goes to the form on screen then, also after the cards started over: Task 7 N-3), else `onChange` with
// the list the editor last saw. `offer` puts the UndoBar up for a removal (BEH B5: a client restore, then the page's save).
//
// An offer belongs to its list (`owner`: "outcomes", "protocolStages", "test", "gallery", …). When the list's editor goes and another editor of the
// same list comes in the same commit (the course editor starting over after a publish or a discard), the offer stays: „Võta tagasi“ lands on the
// new one's form (carry 1). When it goes with none after it (the page left, its card gone with a type change), it takes the bar with it (review
// M-6): „Võta tagasi“ never acts on an editor that is no longer there.

/** Each list's editors on the page now, and the bar to take away when the last one goes. */
const owners = new Map<string, { count: number; withdraw: (() => void) | null }>();

/** After an undo the restored row may take the focus only where the focus fell (on the body: the bar's button is gone) or is still on the bar. */
export function focusFell(): boolean {
  const now = document.activeElement;
  return !now || now === document.body || now.closest("[data-undo-bar]") !== null;
}

export function useListRows<T>(o: { owner: string; items: readonly T[]; onChange?: (items: T[]) => void; onUpdate?: (fn: (items: T[]) => T[]) => void }): {
  /** A change of the rows, to the list as it is when it lands. */
  change: (fn: (list: T[]) => T[]) => void;
  /** The UndoBar for a removal: `text` („Rida eemaldatud.“), `back` puts the row back into the list as it is then; `then` runs first (the focus). */
  offer: (text: string, back: (list: T[]) => T[], then?: () => void) => void;
} {
  const undo = useUndo();
  const { owner } = o;
  // the newest render's list and callbacks: a change or an undo pressed later works on the list as it is then
  const live = useRef(o);
  useLayoutEffect(() => {
    live.current = o;
  });

  useEffect(() => {
    const entry = owners.get(owner) ?? { count: 0, withdraw: null };
    entry.count += 1;
    owners.set(owner, entry);
    return () => {
      entry.count -= 1;
      if (entry.count > 0) return;
      // gone: unless another editor of the list comes in this same commit, the offer goes too
      setTimeout(() => {
        if (entry.count > 0) return;
        entry.withdraw?.();
        entry.withdraw = null;
        if (owners.get(owner) === entry) owners.delete(owner);
      }, 0);
    };
  }, [owner]);

  const change = (fn: (list: T[]) => T[]) => {
    const now = live.current;
    if (now.onUpdate) now.onUpdate(fn);
    else now.onChange?.(fn([...now.items]));
  };
  const offer = (text: string, back: (list: T[]) => T[], then?: () => void) => {
    const entry = owners.get(owner);
    const withdraw = undo.show({
      text,
      undo: async () => {
        if (entry) entry.withdraw = null;
        then?.();
        change(back);
        return true;
      },
    });
    if (entry) entry.withdraw = withdraw;
  };
  return { change, offer };
}
