// The course editor's copies in this browser (admin UX pass piece 3a, Task 7): each card's autosave keeps its unconfirmed text under
// `mslab-draft:koolitus:<course id>-<part>:<tab>` (components/admin/autosave/engine.ts draftKey with the owner and key below). „Loobu muudatustest“
// throws a course's drafts away on the server, so this browser's copies of that course go with it — from the editor (each engine's discardCopy) and from
// the public preview page's bar (components/site/PreviewBar.tsx), which must not load the admin's engine or dictionary: hence this small module.
// Pure but for the storage it is given; no regex lookbehind (old iPads; tests/unit/old-safari.test.ts lists it).

/** The engine's owner of the course editor's copies. */
export const COURSE_COPY_OWNER = "koolitus";

/** The engine's key of course `id`'s part `part`. */
export const courseCopyKey = (id: number, part: string): string => `${id}-${part}`;

/** Every copy of course `id`: `mslab-draft:koolitus:<id>-<part>:<tab>`, never another course's (12 is not 120), the new-course page's (`…:uus`) or another owner's. */
function isCopyOf(key: string, id: number): boolean {
  const prefix = `mslab-draft:${COURSE_COPY_OWNER}:${id}-`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length).split(":");
  return rest.length === 2 && rest[0] !== "" && rest[1] !== "";
}

/** Removes this browser's copies of course `id` (a storage that is blocked or full: nothing, nothing thrown). */
export function dropCourseCopies(id: number, storage?: Storage | null): void {
  try {
    const store = storage === undefined ? window.localStorage : storage;
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && isCopyOf(key, id)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // blocked: nothing was kept
  }
}
