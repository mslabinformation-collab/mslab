import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { courses, courseSessions, protocols, registrations, type CourseSession, type Protocol, type ProtocolStage, type Registration } from "../schema";
import { protocolStatus, readStages, stagesFrom, type ProtocolStatus } from "@/domain/protocols";
import type { RegStatus } from "@/domain/registration";
import type { I18n } from "@/i18n/field";

// The protocols' reads (phase protocols, spec §8): the course day's screen (Task 2), today's sessions (Task 5), the student's page (Task 7) and
// the admin's feedback page (Task 9). Callers have checked the session (admin or client); nothing here does authorization.

/** A protocol as the screen edits it. `version` 0: none yet — the course's headings with empty notes. */
export type ProtocolDraft = {
  version: number;
  stages: ProtocolStage[];
  generalNote: string;
  sentVersion: number | null;
  sentAt: Date | null;
  /** The last saved change; null before the first. */
  updatedAt: Date | null;
};

/** The draft of a stored protocol, or of none yet with the course's `headings`. */
export function draftOf(row: Protocol | null, headings: readonly string[]): ProtocolDraft {
  if (!row) return { version: 0, stages: stagesFrom(headings), generalNote: "", sentVersion: null, sentAt: null, updatedAt: null };
  return { version: row.version, stages: row.stages, generalNote: row.generalNote, sentVersion: row.sentVersion, sentAt: row.sentAt, updatedAt: row.updatedAt };
}

export type ScreenStudent = { registrationId: number; name: string; status: RegStatus; protocol: ProtocolDraft; state: ProtocolStatus };

/**
 * The course day's screen (spec §4): "session" lists every registration of one session that is not cancelled (confirmed, and awaiting the
 * prepayment), "registration" one registration (an individual course). `hidden`: the cancelled ones left out.
 */
export type ScreenData = {
  kind: "session" | "registration";
  course: { id: number; title: I18n };
  session: { id: number; startsAt: Date; city: string; venue: string; cancelled: boolean } | null;
  students: ScreenStudent[];
  hidden: number;
};

const courseFields = { id: courses.id, title: courses.title, type: courses.type, protocolStages: courses.protocolStages };
const sessionOf = (s: CourseSession) => ({ id: s.id, startsAt: s.startsAt, city: s.city, venue: s.venue, cancelled: s.status === "cancelled" });

function screenOf(
  kind: ScreenData["kind"],
  course: { id: number; title: I18n; protocolStages: string[] },
  session: ScreenData["session"],
  rows: { registration: Registration; protocol: Protocol | null }[],
): ScreenData {
  const headings = readStages(course.protocolStages);
  const listed = rows.filter((r) => r.registration.status !== "cancelled");
  const students = listed
    .map((r) => ({ registrationId: r.registration.id, name: r.registration.name, status: r.registration.status, protocol: draftOf(r.protocol, headings), state: protocolStatus(r.protocol) }))
    .sort((a, b) => a.name.localeCompare(b.name, "et") || a.registrationId - b.registrationId);
  return { kind, course: { id: course.id, title: course.title }, session, students, hidden: rows.length - listed.length };
}

/**
 * The screen of one session (`sessionId`: its students, a called-off session's too, for the record) or of one registration; null when there
 * is no such session or registration, or it is not of a contact course (protocols are for contact courses only: spec assumption 1).
 */
export async function protocolScreen(db: Db, target: { sessionId: number } | { registrationId: number }): Promise<ScreenData | null> {
  if ("sessionId" in target) {
    const [s] = await db
      .select({ session: courseSessions, course: courseFields })
      .from(courseSessions)
      .innerJoin(courses, eq(courseSessions.courseId, courses.id))
      .where(eq(courseSessions.id, target.sessionId))
      .limit(1);
    if (!s || s.course.type !== "contact") return null;
    const rows = await db
      .select({ registration: registrations, protocol: protocols })
      .from(registrations)
      .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
      .where(eq(registrations.courseSessionId, target.sessionId));
    return screenOf("session", s.course, sessionOf(s.session), rows);
  }
  const [r] = await db
    .select({ registration: registrations, protocol: protocols, course: courseFields, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .where(eq(registrations.id, target.registrationId))
    .limit(1);
  if (!r || r.course.type !== "contact") return null;
  return screenOf("registration", r.course, r.session ? sessionOf(r.session) : null, [{ registration: r.registration, protocol: r.protocol }]);
}
