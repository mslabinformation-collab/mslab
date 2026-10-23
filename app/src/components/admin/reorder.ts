/**
 * The list with the item at `from` taken out and put at `to` (the other items keep their order); the list given is not changed. A place outside the list, or the
 * item's own, gives the same order. The optimistic order of a list that DragList moves (the page puts it in its new order in the same tick as `onMove`).
 */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
