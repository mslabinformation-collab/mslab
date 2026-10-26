import type { SiteEntity } from "@/domain/site-entities";

// The site editors' copies in this browser (admin UX pass piece 4a, Task 3): each part's autosave keeps its unconfirmed text under
// `mslab-draft:site:<entity>:<part>:<tab>` (components/admin/autosave/engine.ts draftKey with the owner below and the part as its key). „Loobu
// muudatustest“ throws an entity's drafts away on the server (R-e), so this browser's copies of that entity go with it — from the editor
// (components/admin/site/useSitePart.ts and SiteEditorPage.tsx take the owner and the rule from here) and from the public preview page's bar
// (components/site/PreviewBar.tsx), which must not load the admin's engine or dictionary: hence this small module, as lib/course-copies.ts is the course's.
// Pure but for the storage it is given; no regex lookbehind (old iPads; tests/unit/old-safari.test.ts lists it).

/** The engine's owner of a site entity's copies in this browser (the key is the part's name). */
export const siteCopyOwner = (entity: SiteEntity): string => `site:${entity}`;

/** Every copy of `entity`'s parts: `mslab-draft:site:<entity>:<part>:<tab>`, never another entity's (`site:home` is not `site:homeX`) or another owner's. */
function isCopyOf(key: string, entity: SiteEntity): boolean {
  const prefix = `mslab-draft:${siteCopyOwner(entity)}:`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length).split(":");
  return rest.length === 2 && rest[0] !== "" && rest[1] !== "";
}

/** Removes this browser's copies of `entity`'s parts (a storage that is blocked or full: nothing, nothing thrown). */
export function dropSiteCopies(entity: SiteEntity, storage?: Storage | null): void {
  try {
    const store = storage === undefined ? window.localStorage : storage;
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && isCopyOf(key, entity)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // blocked: nothing was kept
  }
}
