import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The course editor's page (app/admin/(panel)/koolitused/[id]/page.tsx) and its read's stamp (server/read-stamp.ts; Task 9 review M-1): the stamp is
// the database's clock before the page reads anything of the course, so a read at or past a press's answer shows what the press did
// (course/SavedCourse.tsx). Final review P9-1: the stamp is taken alongside the admin check, not after it (one round trip less on every read of the
// editor), and still before every course read. The page's readers are stand-ins here that log when they start.

const log = vi.hoisted(() => [] as string[]);
const gate = vi.hoisted(() => ({ admin: null as null | (() => void), stamp: null as null | ((n: number) => void), stampFails: null as null | ((e: Error) => void), refuse: false }));
const read = vi.hoisted(
  () =>
    (name: string, value: unknown = null) =>
    async () => {
      log.push(`read ${name}`);
      return value;
    },
);
const COURSE = vi.hoisted(() => ({ id: 7, slug: "kulm", type: "e_learning", published: true, isSample: false }));

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth", () => ({
  requireAdmin: () => {
    log.push("admin");
    return new Promise((resolve, reject) => {
      gate.admin = () => {
        log.push("admin done");
        if (gate.refuse) reject(new Error("NEXT_REDIRECT"));
        else resolve("maria@example.test");
      };
    });
  },
}));
vi.mock("@/server/read-stamp", () => ({
  readStamp: () => {
    log.push("stamp");
    return new Promise<number>((resolve, reject) => {
      gate.stamp = (n) => {
        log.push("stamp done");
        resolve(n);
      };
      gate.stampFails = reject;
    });
  },
}));
vi.mock("@/db/queries/admin", () => ({
  getCourseForEdit: read("course", COURSE),
  listAllCourses: read("courses", []),
  courseUsage: read("usage", { registrations: 0 }),
  typeLocked: () => false,
}));
vi.mock("@/db/queries/public", () => ({ getCourseBySlug: read("detail") }));
vi.mock("@/server/admin-lessons", () => ({ listCourseLessons: read("lessons", []) }));
vi.mock("@/server/course-parts", () => ({ readCourseEditor: read("editor", { parts: {}, outline: [] }) }));
vi.mock("@/server/lesson-file-purge", () => ({ purgeRemovedLessonFiles: vi.fn() }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => null }));
vi.mock("@/server/bunny", () => ({ bunnyConfig: () => null }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/components/admin/CourseEditor", () => ({ CourseEditor: () => null }));
vi.mock("@/components/admin/Drawer", () => ({ Drawer: () => null }));
vi.mock("@/components/admin/LessonDrawer", () => ({ LessonDrawer: () => null }));

import CourseEditPage from "@/app/admin/(panel)/koolitused/[id]/page";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const open = (id: string) => CourseEditPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
/** The props the page hands CourseEditor (the first child of its fragment). */
const editorProps = (tree: unknown) => {
  const children = (tree as ReactElement<{ children: unknown[] }>).props.children;
  const editor = children[0];
  expect(isValidElement(editor)).toBe(true);
  return (editor as ReactElement<{ course: { stamp: number } | null }>).props;
};

beforeEach(() => {
  log.length = 0;
  gate.admin = null;
  gate.stamp = null;
  gate.stampFails = null;
  gate.refuse = false;
});

describe("the course editor's read stamp (final review P9-1)", () => {
  test("it starts with the admin check, not after it, and every course read waits for it", async () => {
    const page = open("7");
    await settle();
    // both are on their way at once: the stamp does not wait for the admin check
    expect(log).toEqual(["admin", "stamp"]);
    gate.admin!();
    await settle();
    // the admin check done, the reads still wait for the stamp
    expect(log).toEqual(["admin", "stamp", "admin done"]);
    gate.stamp!(1_800_000_000_000_000);
    const tree = await page;
    const reads = log.filter((e) => e.startsWith("read "));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    expect(log.indexOf("stamp done")).toBeLessThan(log.findIndex((e) => e.startsWith("read ")));
    // and the stamp is the one the editor's data carries
    expect(editorProps(tree).course?.stamp).toBe(1_800_000_000_000_000);
  });

  test("the stamp first, the admin check after: still nothing is read before both", async () => {
    const page = open("7");
    await settle();
    gate.stamp!(5);
    await settle();
    expect(log).toEqual(["admin", "stamp", "stamp done"]);
    gate.admin!();
    await page;
    expect(log.slice(0, 4)).toEqual(["admin", "stamp", "stamp done", "admin done"]);
  });

  test("not signed in: the admin check's redirect ends the page and no course is read; a stamp that then fails is no unhandled rejection", async () => {
    gate.refuse = true;
    const page = open("7");
    await settle();
    gate.admin!();
    await expect(page).rejects.toThrow("NEXT_REDIRECT");
    // (the stamp left unawaited fails after the redirect: vitest would report an unhandled rejection)
    gate.stampFails!(new Error("the database is down"));
    await settle();
    expect(log.filter((e) => e.startsWith("read "))).toEqual([]);
  });

  test("a stamp that fails fails the read (the editor never starts from a read without its stamp)", async () => {
    const page = open("7");
    await settle();
    gate.admin!();
    gate.stampFails!(new Error("the database is down"));
    await expect(page).rejects.toThrow("the database is down");
    expect(log.filter((e) => e.startsWith("read "))).toEqual([]);
  });

  test("a new course (/uus) takes no stamp: there is nothing of it to read", async () => {
    const page = open("uus");
    await settle();
    gate.admin!();
    const tree = await page;
    expect(log).not.toContain("stamp");
    expect(editorProps(tree).course).toBeNull();
  });
});
