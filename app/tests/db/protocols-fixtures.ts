import type { Db } from "@/db/client";
import { courses, courseSessions, registrations, type Course, type CourseSession, type Registration } from "@/db/schema";

// The protocol DB tests' common parts (phase protocols): a contact course with Maria's headings, its session on the course day, and the
// students' registrations on it. The addresses are @example.com: a protocol mail is really built and "sent" to the stubbed Resend.

export const HEADINGS = ["Ettevalmistus", "Kulmude analüüs", "Vormi määramine", "Värvimine"];
/** The course day: 12.10.2026 10:00 in Tallinn (summer time). */
export const COURSE_DAY = new Date("2026-10-12T07:00:00Z");

/** A published contact course with the headings (`over` replaces fields) and its one session on the course day. */
export async function protocolCourse(db: Db, over: Partial<typeof courses.$inferInsert> = {}): Promise<{ course: Course; session: CourseSession }> {
  const [course] = await db
    .insert(courses)
    .values({
      slug: "kulmude-lami",
      type: "contact",
      level: "basic",
      title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" },
      summary: { et: "" },
      body: { et: "" },
      priceGroup: 35000,
      priceIndividual: 45000,
      published: true,
      protocolStages: HEADINGS,
      ...over,
    })
    .returning();
  const [session] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: COURSE_DAY, city: "Pärnu", venue: "MS LAB stuudio", capacity: 6 }).returning();
  return { course, session };
}

/**
 * A student's registration: on `session` a group one (null: an individual one), confirmed, without an account, her address made of her name
 * (`Mari Maasikas` → `marimaasikas@example.com`); `over` replaces fields.
 */
export async function student(db: Db, course: Course, session: CourseSession | null, name: string, over: Partial<typeof registrations.$inferInsert> = {}): Promise<Registration> {
  const local = name.toLowerCase().replace(/[^a-z]+/g, "");
  const [r] = await db
    .insert(registrations)
    .values({ courseId: course.id, courseSessionId: session?.id ?? null, kind: session ? "group" : "individual", name, email: `${local}@example.com`, paymentChoice: "full", status: "confirmed", ...over })
    .returning();
  return r;
}
