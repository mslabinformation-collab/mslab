import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, courseAccess, courses, type Client, type Course, type CourseSession, type Registration } from "@/db/schema";
import type { FeedbackAnswers } from "@/domain/protocols";
import { submitFeedback, type FeedbackTarget, type SubmitResult } from "@/server/course-feedback";
import { ecourse, learner } from "./assessment-fixtures";
import { protocolCourse, student } from "./protocols-fixtures";

// The student reviews' DB tests' common parts (phase student reviews, Task 2): a contact student whose form is open, an e-course graduate whose
// form is open, and the submit with a consent. The addresses are @example.test: nothing is ever mailed from these tests.

/** The day after the course day (12.10.2026): every group registration's form is open (domain/protocols.ts feedbackOpen). */
export const NOW = new Date("2026-10-13T08:00:00Z");
/** The answer to „Kas soovitaksid seda koolitust ka teistele? Miks?“: the text a review is made of. */
export const RECOMMEND = "Soovitaksin kindlasti, õppisin kolme päevaga väga palju.";

/** A contact course (published unless `over` says otherwise) with its session, and a student with an account whose form is open at NOW. */
export async function contactStudent(db: Db, name = "Mari Maasikas", over: Partial<typeof courses.$inferInsert> = {}) {
  const { course, session } = await protocolCourse(db, over);
  return { course, session, ...(await studentOf(db, course, session, name)) };
}

/** Another student with an account on `session` of `course`. */
export async function studentOf(db: Db, course: Course, session: CourseSession, name: string): Promise<{ registration: Registration; client: Client }> {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, "")}@example.test`;
  const [client] = await db.insert(clients).values({ email, name }).returning();
  const registration = await student(db, course, session, name, { clientId: client.id, email });
  return { registration, client };
}

/**
 * An e-course (published unless `over` says) and a graduate: her access is completed on 10.10.2026 (`completed: false`: still under way). Her
 * account name is `name` (may be empty).
 */
export async function graduate(
  db: Db,
  over: { name?: string; email?: string; slug?: string; published?: boolean; completed?: boolean; revoked?: boolean } = {},
): Promise<{ course: Course; client: Client; access: typeof courseAccess.$inferSelect }> {
  const { course: made, lesson } = await ecourse(db, { slug: over.slug });
  const [course] = await db.update(courses).set({ published: over.published ?? true }).where(eq(courses.id, made.id)).returning();
  const { client, access } = await learner(db, course, lesson, over.email ?? "kati@example.test", { name: over.name ?? "Kati Kask" });
  const [row] = await db
    .update(courseAccess)
    .set({ completedAt: over.completed === false ? null : new Date("2026-10-10T09:00:00Z"), revokedAt: over.revoked ? new Date("2026-10-11T09:00:00Z") : null })
    .where(eq(courseAccess.id, access.id))
    .returning();
  return { course, client, access: row };
}

/** The submit of the form: her answers (the recommend text unless `answers` says), her consent (null: none), the page's language. */
export function submit(
  db: Db,
  clientId: number,
  target: FeedbackTarget,
  consent: { name: string } | null,
  over: { answers?: FeedbackAnswers; locale?: "et" | "ru"; now?: Date } = {},
): Promise<SubmitResult> {
  return submitFeedback(db, { clientId, target, answers: over.answers ?? { score: 9, recommend: RECOMMEND }, locale: over.locale ?? "et", consent }, over.now ?? NOW);
}
