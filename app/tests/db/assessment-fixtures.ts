import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, courseAccess, courseModules, courses, lessonProgress, lessons, practicalPhotos, protocols, type Course, type Lesson, type Protocol } from "@/db/schema";
import { practicalStatus, sentFixPoints } from "@/domain/completion";
import { stagesFrom } from "@/domain/protocols";

// An e-course with practical points and a student with access to it, for Maria's assessment (phase e-course completion, Tasks 10–14). The course
// has one text lesson, which the student has done, and no test (no course_tests row): the practical work is her only step left, so an approving
// send completes the course. `submitRound` writes what the student's "Saada hindamiseks" leaves (server/practical.ts submitPractical, Task 7)
// without the photo files: the protocol her first photo made (the course's points, version 1, no text), a photo row per point named, round + 1,
// submitted_at, and the verdicts of the points this round redoes back to null — the sent "Paranda" points after an assessment, every point in
// the first round — exactly as submitPractical picks them (R3; the notes' version is not touched).

export const POINTS = ["Ettevalmistus", "Kulmude kuju", "Värvimine"];
/** The student's first submission. */
export const DAY = new Date("2026-11-10T10:00:00Z");

export async function ecourse(db: Db, over: { slug?: string; points?: string[] } = {}): Promise<{ course: Course; lesson: Lesson }> {
  const [course] = await db
    .insert(courses)
    .values({
      slug: over.slug ?? "kulmud-e",
      type: "e_learning",
      level: "basic",
      title: { et: "Kulmude e-kursus", ru: "Брови онлайн" },
      summary: { et: "" },
      body: { et: "" },
      price: 9000,
      protocolStages: over.points ?? POINTS,
    })
    .returning();
  const [module] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Moodul" } }).returning();
  const [lesson] = await db.insert(lessons).values({ moduleId: module.id, position: 1, title: { et: "Sissejuhatus" }, kind: "text" }).returning();
  return { course, lesson };
}

/** A student with access to `course` (six months from DAY unless `expiresAt`), its lesson done. */
export async function learner(
  db: Db,
  course: Course,
  lesson: Lesson,
  email: string,
  over: { name?: string; locale?: "et" | "ru"; expiresAt?: Date; revokedAt?: Date | null } = {},
) {
  const [client] = await db.insert(clients).values({ email, name: over.name ?? "Kati Kask", locale: over.locale ?? "et" }).returning();
  const [access] = await db
    .insert(courseAccess)
    .values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: over.expiresAt ?? new Date("2027-05-10T10:00:00Z"), revokedAt: over.revokedAt ?? null })
    .returning();
  await db.insert(lessonProgress).values({ clientId: client.id, lessonId: lesson.id, doneAt: DAY });
  return { client, access };
}

/** The course and Kati (kati@example.com: a real-looking address, so her mails are built and "sent" to the stubbed Resend). */
export async function ecourseAccess(db: Db, over: { slug?: string; points?: string[]; email?: string; expiresAt?: Date; revokedAt?: Date | null } = {}) {
  const { course, lesson } = await ecourse(db, over);
  const { client, access } = await learner(db, course, lesson, over.email ?? "kati@example.com", over);
  return { course, lesson, client, access };
}

/** One submission of the student: a photo on each point of `points` (0-based) in the new round. Returns the protocol after it. */
export async function submitRound(db: Db, accessId: number, points: readonly number[], at: Date): Promise<Protocol> {
  const [{ headings }] = await db
    .select({ headings: courses.protocolStages })
    .from(courseAccess)
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .where(eq(courseAccess.id, accessId));
  await db.insert(protocols).values({ accessId, stages: stagesFrom(headings) }).onConflictDoNothing({ target: protocols.accessId });
  const [p] = await db.select().from(protocols).where(eq(protocols.accessId, accessId));
  const round = p.round + 1;
  for (const stage of points)
    await db.insert(practicalPhotos).values({
      protocolId: p.id,
      stage,
      round,
      key: `practical/p${p.id}-${stage}-${round}.jpg`,
      thumbKey: `practical/p${p.id}-${stage}-${round}-t.jpg`,
      size: 150_000,
      width: 1600,
      height: 1200,
    });
  // the points this round redoes, as submitPractical has them: the SENT "Paranda" points once Maria has assessed, else every point
  const required = practicalStatus(p) === "fix" ? sentFixPoints(p.sent) : p.stages.map((_, i) => i);
  const verdicts = p.stages.map((_, i) => (required.includes(i) ? null : (p.verdicts[i] ?? null)));
  const [after] = await db.update(protocols).set({ round, submittedAt: at, verdicts }).where(eq(protocols.id, p.id)).returning();
  return after;
}
