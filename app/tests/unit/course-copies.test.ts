import { describe, expect, it } from "vitest";
import { draftKey } from "@/components/admin/autosave/engine";
import { COURSE_PARTS } from "@/domain/course-parts";
import { COURSE_COPY_OWNER, courseCopyKey, dropCourseCopies } from "@/lib/course-copies";

// The course editor's copies in this browser (lib/course-copies.ts): the keys the autosave engine writes for a course's parts — its own draftKey with
// the editor's owner and key — are the ones the preview bar's „Loobu muudatustest“ drops, and only those (review round 2, out of scope: one source).

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

describe("dropCourseCopies", () => {
  it("drops every key the engine writes for course 7's parts, in any tab, and nothing else", () => {
    const parts = COURSE_PARTS.filter((p) => p !== "outline");
    const mine = parts.flatMap((part) => ["t1", "t2-x"].map((tab) => draftKey(COURSE_COPY_OWNER, courseCopyKey(7, part), tab)));
    const others = [
      draftKey(COURSE_COPY_OWNER, courseCopyKey(70, "basics"), "t1"),
      draftKey(COURSE_COPY_OWNER, courseCopyKey(17, "price"), "t1"),
      draftKey(COURSE_COPY_OWNER, "uus", "t1"),
      "mslab-draft:koolitus:uus",
      draftKey("registreering", "7", "t1"),
      draftKey("registreering", courseCopyKey(7, "basics"), "t1"),
      "mslab-edit-lang",
    ];
    const storage = memoryStorage([...mine, ...others]);
    dropCourseCopies(7, storage);
    expect(keysOf(storage)).toEqual(others);
  });

  it("a storage that throws: nothing thrown", () => {
    const broken = {
      get length(): number {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => dropCourseCopies(7, broken)).not.toThrow();
    expect(() => dropCourseCopies(7, null)).not.toThrow();
  });
});
