import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftKey } from "@/components/admin/autosave/engine";
import { HOME_PARTS, TRAINER_PARTS } from "@/domain/site-entities";
import { dropSiteCopies, siteCopyOwner } from "@/lib/site-copies";

// The site editors' copies in this browser (lib/site-copies.ts; admin UX pass piece 4a, Task 3): the keys the autosave engine writes for a site
// entity's parts — its own draftKey with the owner the editor's hook uses (components/admin/site/useSitePart.ts) — are the ones the public preview
// bar's „Loobu muudatustest“ drops, and only those: one definition of the owner, shared by the hook and the bar.

/** A Storage over a Map. */
function memoryStorage(keys: string[]): Storage {
  const items = new Map(keys.map((k) => [k, "{}"]));
  return {
    get length() {
      return items.size;
    },
    key: (i) => Array.from(items.keys())[i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, String(v)),
    removeItem: (k) => void items.delete(k),
    clear: () => items.clear(),
  };
}
const keysOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i)!);

describe("dropSiteCopies", () => {
  it("drops every key the engine writes for the entity's parts, in any tab, and nothing else", () => {
    const mine = [...HOME_PARTS].flatMap((part) => ["t1", "t2-x"].map((tab) => draftKey(siteCopyOwner("home"), part, tab)));
    const others = [
      ...[...TRAINER_PARTS].map((part) => draftKey(siteCopyOwner("trainer"), part, "t1")),
      draftKey(siteCopyOwner("practice"), "MAXI", "t1"),
      draftKey("site:homeX", "slides", "t1"), // (an owner that only starts like it)
      "mslab-draft:site:home", // not a copy
      "mslab-draft:site:home:slides", // no tab
      draftKey("koolitus", "7-basics", "t1"),
      "mslab-edit-lang",
    ];
    const storage = memoryStorage([...mine, ...others]);
    dropSiteCopies("home", storage);
    expect(keysOf(storage)).toEqual(others);
  });

  it("Praktika's parts are its package codes: MINI and MAXI go, the other entities' copies stay", () => {
    const mine = ["MINI", "MAXI"].map((code) => draftKey(siteCopyOwner("practice"), code, "t1"));
    const others = [draftKey(siteCopyOwner("home"), "faq", "t1"), draftKey(siteCopyOwner("trainer"), "bio", "t9")];
    const storage = memoryStorage([...others, ...mine]);
    dropSiteCopies("practice", storage);
    expect(keysOf(storage)).toEqual(others);
  });

  it("a post's copies (piece 4b: one entity row per post) are `site:post:<id>`: that post's go, never another post's (1 is not 12) or a site entity's", () => {
    const one = { entity: "post", id: 1 } as const;
    expect(siteCopyOwner(one)).toBe("site:post:1");
    const mine = ["t1", "t2"].map((tab) => draftKey(siteCopyOwner(one), "post", tab));
    const others = [draftKey(siteCopyOwner({ entity: "post", id: 12 }), "post", "t1"), draftKey(siteCopyOwner("home"), "faq", "t1"), "mslab-draft:site:post:1:post"];
    const storage = memoryStorage([...mine, ...others]);
    dropSiteCopies(one, storage);
    expect(keysOf(storage)).toEqual(others);
    // and the site entities' drop never takes a post's
    const posts = memoryStorage(mine);
    for (const entity of ["home", "trainer", "practice"] as const) dropSiteCopies(entity, posts);
    expect(keysOf(posts)).toEqual(mine);
  });

  it("a storage that throws, or none: nothing thrown", () => {
    const broken = {
      get length(): number {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => dropSiteCopies("home", broken)).not.toThrow();
    expect(() => dropSiteCopies("home", null)).not.toThrow();
  });

  it("the owner is `site:<entity>`, and the editor's hook takes it from here (one definition)", () => {
    expect(siteCopyOwner("practice")).toBe("site:practice");
    const hook = readFileSync(join(process.cwd(), "src/components/admin/site/useSitePart.ts"), "utf8");
    expect(hook).toMatch(/import \{[^}]*\bsiteCopyOwner\b[^}]*\} from "@\/lib\/site-copies"/);
    expect(hook).not.toMatch(/`site:\$\{/);
  });
});
