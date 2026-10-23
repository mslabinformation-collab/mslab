import type { Db } from "@/db/client";
import { clients, courseAccess, courses, courseTests, protocols, testAttempts, type AttemptStatus, type OpenReview, type TestAnswers, type TestQuestion } from "@/db/schema";

// The Hindamine tests' common parts (e-course completion, Task 12): an e-course with Maria's test and points, students with access to it, their
// attempts and their practical work, written straight to the (PGlite) database. The addresses are @example.test: nothing here is mailed.

/** The test: a single-answer and a multiple-answer choice question, then an open one (ids as domain/completion.ts newItemId makes them). */
export const QUESTIONS: TestQuestion[] = [
  { id: "qvalik01", kind: "choice", text: "Mitu korda pesta pintslit?", options: [{ id: "o1oige01", text: "Pärast igat kasutust", correct: true }, { id: "o1vale01", text: "Kord nädalas", correct: false }] },
  {
    id: "qvalik02",
    kind: "choice",
    text: "Mis kuulub ettevalmistusse?",
    options: [
      { id: "o2oige01", text: "Naha puhastus", correct: true },
      { id: "o2oige02", text: "Kuju mõõtmine", correct: true },
      { id: "o2vale01", text: "Värvi segamine silma järgi", correct: false },
    ],
  },
  { id: "qavatud1", kind: "open", text: "Kirjelda oma tööde järjekorda." },
];
/** Her answers: the first right, the second wrong (one correct option missed, a wrong one picked), the open one written: 1 of 2, 50 %. */
export const ANSWERS: TestAnswers = { qvalik01: ["o1oige01"], qvalik02: ["o2oige01", "o2vale01"], qavatud1: "Puhastan pintsli." };
export const POINTS = ["Ettevalmistus", "Värvimine"];
export const COURSE_TITLE = { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" };
/** An access that runs until April 2027. */
export const LATER = new Date("2027-04-20T20:59:59.999Z");
/** `hour` o'clock (UTC) on 19.10.2026. */
export const at = (hour: number) => new Date(Date.UTC(2026, 9, 19, hour));

const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

/** The e-course "Kulmumeistri e-koolitus" with POINTS and, unless `test` is null, its test (QUESTIONS, pass mark 80, `tries` 2). */
export async function ecourse(db: Db, opts: { slug?: string; title?: { et: string; ru?: string }; test?: { tries: number } | null } = {}): Promise<{ id: number }> {
  const [course] = await db
    .insert(courses)
    .values({ ...base, slug: opts.slug ?? "e-kulm", type: "e_learning", title: opts.title ?? COURSE_TITLE, protocolStages: POINTS })
    .returning();
  if (opts.test !== null) await db.insert(courseTests).values({ courseId: course.id, questions: QUESTIONS, passPercent: 80, tries: opts.test?.tries ?? 2 });
  return course;
}

export type Student = { client: { id: number; email: string }; access: { id: number } };

/** A student (`name`, her address made of it) with access to `courseId` until LATER; `over` replaces fields of the access. */
export async function student(db: Db, courseId: number, name: string, over: Partial<typeof courseAccess.$inferInsert> = {}): Promise<Student> {
  const [client] = await db.insert(clients).values({ email: `${name.toLowerCase()}@example.test`, name }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: client.id, courseId, grantedBy: "maria@example.test", expiresAt: LATER, ...over }).returning();
  return { client, access };
}

/** One of her attempts at `courseId`'s test, with QUESTIONS as its copy and ANSWERS (1 of 2 right) unless `over` says otherwise. */
export async function attempt(
  db: Db,
  s: Student,
  courseId: number,
  number: number,
  status: AttemptStatus,
  submittedAt: Date,
  over: { correct?: number; total?: number; questions?: TestQuestion[]; answers?: TestAnswers; review?: OpenReview | null } = {},
) {
  const [row] = await db
    .insert(testAttempts)
    .values({
      clientId: s.client.id,
      courseId,
      number,
      questions: over.questions ?? QUESTIONS,
      answers: over.answers ?? ANSWERS,
      correct: over.correct ?? 1,
      total: over.total ?? 2,
      status,
      review: over.review ?? null,
      submittedAt,
    })
    .returning();
  return row;
}

/** Her practical work's protocol: POINTS without notes, `round` submissions so far, the last at `submittedAt`, `sentRound` assessed. */
export async function practical(db: Db, s: Student, round: number, sentRound: number | null, submittedAt: Date | null) {
  const [row] = await db
    .insert(protocols)
    .values({ accessId: s.access.id, stages: POINTS.map((title) => ({ title, note: "" })), verdicts: POINTS.map(() => null), round, sentRound, submittedAt })
    .returning();
  return row;
}

/** The tab pills of a rendered Hindamine or Tunnistused page (A4): each one's address, its text (the count bubble after the label) and whether it is the current one. */
export function tabsOf(html: string): { href: string | undefined; text: string; current: boolean }[] {
  const nav = /<nav [^>]*data-tab-pills=""[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1],
    text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    current: m[1].includes('aria-current="page"'),
  }));
}
