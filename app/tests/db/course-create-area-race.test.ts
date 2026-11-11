import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseAreas, courses } from "@/db/schema";
import { newCourseDraft } from "@/domain/course-editor";
import { makeTestDb } from "./helpers";

// „Lisa koolitus“ and an area deleted at the same time (course areas, review round 1 item 3): createCourseForm checks the „Valdkond“ first
// (checkCourseBasics), then saves the course in a transaction of its own (db/queries/admin.ts saveCourseWithImages). An area deleted in that gap
// (Seaded → Valdkonnad „Kustuta“: it was unused a moment ago) must be the field's error, as one deleted before the check is — never the foreign key's
// 23503 thrown as a server error — and no course is made. The gap is made here: the save is wrapped so that the area goes just before it runs.

const gap = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock("@/db/queries/admin", async (original) => {
  const real = await original<typeof import("@/db/queries/admin")>();
  return {
    ...real,
    saveCourseWithImages: async (...args: Parameters<typeof real.saveCourseWithImages>) => {
      await gap.before?.();
      return real.saveCourseWithImages(...args);
    },
  };
});

import { saveCourseWithImages } from "@/db/queries/admin";
import { createCourseForm } from "@/server/admin-content";

let db: Db;
let areaId: number;

beforeEach(async () => {
  db = await makeTestDb();
  gap.before = null;
  [{ id: areaId }] = await db.insert(courseAreas).values({ name: { et: "Meigikoolitused", ru: "Курсы макияжа" }, sort: 3 }).returning();
});

const form = (draft: object) => {
  const fd = new FormData();
  fd.set("data", JSON.stringify(draft));
  return fd;
};
const count = async () => (await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(courses))[0].n;

describe("„Lisa koolitus“ while its area is deleted", () => {
  test("the area deleted after the check and before the save: the field's error „area“, no course, nothing thrown", async () => {
    gap.before = async () => {
      await db.delete(courseAreas).where(eq(courseAreas.id, areaId));
    };
    const r = await createCourseForm(db, form({ ...newCourseDraft(), title: { et: "Meigi alused" }, areaId }));
    expect(r).toEqual({ ok: false, error: "invalid", fields: { areaId: "area" } });
    expect(await count()).toBe(0);
  });

  test("the save on its own: an area that is not there is „area“ and nothing is written; one that is there is stored", async () => {
    const fields = { slug: "meik", type: "contact" as const, level: "basic" as const, title: { et: "Meik" }, summary: { et: "" }, body: { et: "" }, test: null, certificateSkills: [], certificateVolume: "", certificateTitle: "", certificateDesignId: null };
    expect(await saveCourseWithImages(db, { id: null }, { ...fields, areaId: areaId + 100 }, [])).toBe("area");
    expect(await count()).toBe(0);
    const saved = await saveCourseWithImages(db, { id: null }, { ...fields, areaId }, []);
    expect(saved).toMatchObject({ slug: "meik", areaId });
  });
});
