import { expect, test } from "vitest";
import { todaySessions } from "@/db/queries/protocols";
import { courses, courseSessions } from "@/db/schema";
import { protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The overview's "Täna" (spec §4): the contact courses' sessions of today's Tallinn date, scheduled ones, with how many students are listed.

test("today in Tallinn: from midnight to midnight there, the called-off ones left out; each with its listed students", async () => {
  const db = await makeTestDb();
  const { course, session: morning } = await protocolCourse(db); // 12.10 10:00 in Tallinn
  const at = async (startsAt: string, status: "scheduled" | "cancelled" = "scheduled") =>
    (await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date(startsAt), city: "Tartu", status }).returning())[0];
  const late = await at("2026-10-12T20:30:00Z"); // 23:30 on 12.10
  await at("2026-10-11T20:30:00Z"); // 23:30 on 11.10
  await at("2026-10-12T21:30:00Z"); // 00:30 on 13.10
  await at("2026-10-12T09:00:00Z", "cancelled");
  await student(db, course, morning, "Mari");
  await student(db, course, morning, "Anu", { status: "awaiting_prepayment" });
  await student(db, course, morning, "Tiina", { status: "cancelled" });
  const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" } }).returning();
  await db.insert(courseSessions).values({ courseId: ecourse.id, startsAt: new Date("2026-10-12T08:00:00Z"), city: "Pärnu" });

  const today = await todaySessions(db, new Date("2026-10-12T09:00:00Z"));
  expect(today.map((s) => [s.id, s.students])).toEqual([[morning.id, 2], [late.id, 0]]);
  expect(today[0]).toMatchObject({ city: "Pärnu", venue: "MS LAB stuudio", title: { et: "Kulmude lamineerimine" }, startsAt: morning.startsAt });
  // just after midnight in Tallinn (21:10 UTC) it is the 13th there: only the 00:30 session
  expect((await todaySessions(db, new Date("2026-10-12T21:10:00Z"))).map((s) => s.startsAt.toISOString())).toEqual(["2026-10-12T21:30:00.000Z"]);
});
