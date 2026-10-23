import type { RegistrationRow } from "@/db/queries/admin";
import type { CourseSession, Request as RequestRow } from "@/db/schema";
import { isInterest, KIND_TAB, replySubject, requestFacts, type RequestPayload, type TabKey } from "@/domain/requests";
import { adminEt } from "@/i18n/dict/admin";
import { pick, type I18n } from "@/i18n/field";
import { fill, formatDate, formatDayMonth, formatTime } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";

// A request as Päringud's card shows it (admin UX pass, README A7, piece 2 Task 15): the parts of the card, worked out from the stored row and what the page
// looked up for it (a course's title, a session's day, a registration's name). Pure: no database, no React, so a test builds a card from a row.

/** What a card needs looked up: the requests store a course's slug, a session's id and a registration's id. */
export type RequestLookup = {
  /** Course titles by slug (the individual, waitlist and interest requests). */
  courses: Map<string, I18n>;
  /** The sessions the waitlist entries are for, by id. */
  sessions: Map<number, CourseSession>;
  /** The registrations the change requests are about, by id. */
  registrations: Map<number, RegistrationRow>;
};

export type RequestView = {
  id: number;
  handled: boolean;
  tab: TabKey;
  /** The name; the e-mail address when there is none (the e-learning interest); a change request's is its registration's name. */
  title: string;
  /** „19.10.2026 07:24 · RU · julia@example.test“ and, on a phone, „19.10 · RU“. */
  meta: string;
  metaShort: string;
  /** The type tag: the tab's name, or „E-õppe huvi“ for the cart's interest (`interest`: the dark one). */
  tag: string;
  interest: boolean;
  message: string;
  facts: string;
  /** `mailto:` to the requester with the subject filled in (S3-k); null when there is no address. */
  reply: string | null;
  /** „Ava toimumine →“ (a waitlist entry) or „Ava registreering →“ (a change request); null when what it names is gone. */
  go: { href: string; text: string } | null;
};

const MAX_ID = 2_147_483_647;
const plainId = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_ID ? v : null);

/** The registration a change request is about (its payload's registrationId), when that is a plain positive number. */
export const changedRegistration = (r: Pick<RequestRow, "kind" | "payload">): number | null => (r.kind === "change_request" ? plainId(r.payload.registrationId) : null);
/** The session a waitlist entry is for (its payload's session), when that is a plain positive number. */
export const waitedSession = (r: Pick<RequestRow, "kind" | "payload">): number | null => (r.kind === "waitlist" ? plainId(Number(r.payload.session)) : null);

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** `mailto:` with the address readable (an „@“ stays) and the subject encoded, whatever the characters of either. */
function mailto(address: string, subject: string): string {
  return `mailto:${encodeURIComponent(address).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}`;
}

export function requestView(r: RequestRow, lookup: RequestLookup): RequestView {
  const t = adminEt.requests;
  const p = r.payload;
  const interest = isInterest(r.kind, p);
  const registrationId = changedRegistration(r);
  const registration = registrationId === null ? undefined : lookup.registrations.get(registrationId);
  const sessionId = waitedSession(r);
  const session = sessionId === null ? undefined : lookup.sessions.get(sessionId);

  // The language she wrote in. A change request has none of its own: it is the registration's.
  const lang: Locale | null = p.locale === "ru" || p.locale === "et" ? p.locale : registration ? (registration.locale === "ru" ? "ru" : "et") : null;

  const email = text(p.email);
  const title = (registration ? registration.name.trim() : text(p.name)) || email;

  // The course, for the facts and the subject: the stored slug is looked up (a course that is gone is named by its slug); a practice request's `course` is
  // free text, and her package is what she asked for.
  const slug = text(p.course);
  const named = r.kind === "individual" || r.kind === "waitlist" || interest;
  const course: I18n | undefined = registration ? registration.course.title : named ? lookup.courses.get(slug) : undefined;
  const courseEt = course ? pick(course, "et") : named ? slug : "";

  const when = registration?.courseSession ?? session;
  const facts: RequestPayload = { ...p, ...(lang ? { locale: lang } : {}) };
  if (r.kind !== "practice") facts.course = courseEt;
  if (when) {
    facts.startsAt = when.startsAt.toISOString();
    facts.city = when.city;
  }

  const message = interest ? (courseEt ? fill(t.interestMessage, { course: courseEt }) : "") : r.kind === "contact" || r.kind === "individual" || r.kind === "change_request" ? text(p.message) : "";

  const subjectTitle = r.kind === "practice" ? text(p.package) : course ? pick(course, lang ?? "et") : named ? slug : "";

  const upper = lang ? lang.toUpperCase() : "";
  const meta = [`${formatDate(r.createdAt, "et")} ${formatTime(r.createdAt, "et")}`, upper, email && email !== title ? email : ""].filter(Boolean).join(" · ");
  const metaShort = [formatDayMonth(r.createdAt, "et"), upper].filter(Boolean).join(" · ");

  const go: RequestView["go"] = registration
    ? { href: `/admin/registreerimised?id=${registration.id}`, text: t.openRegistration }
    : session
      ? { href: `/admin/kalender?id=${session.id}`, text: t.openSession }
      : null;

  return {
    id: r.id,
    handled: r.handled,
    tab: KIND_TAB[r.kind],
    title,
    meta,
    metaShort,
    tag: interest ? t.interest : t.tabs[KIND_TAB[r.kind]],
    interest,
    message,
    facts: requestFacts(r.kind, facts),
    reply: email ? mailto(email, replySubject(lang ?? "et", subjectTitle)) : null,
    go,
  };
}
