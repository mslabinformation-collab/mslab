import { and, eq, isNull } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { clients, courseAccess, courseFeedback, courses, courseSessions, protocols, registrations, reviews } from "@/db/schema";
import { feedbackOpenFor, type FeedbackAnswers } from "@/domain/protocols";
import { checkConsent, shownNameFrom } from "@/domain/review";
import type { I18n } from "@/i18n/field";
import { feedbackSummary, type FeedbackNotice } from "./messages";
import { adminUrl, notifyMaria, type Env } from "./notify";

// The course feedback form (phase protocols, spec §3, §7; student reviews, D1, D3) for the signed-in client, without Next.js: account-api.ts takes
// the client from the session and calls these. The form is of one course of hers: a contact course's registration (hers by the dashboard's rule,
// registrations.client_id; open by domain/protocols.ts feedbackOpen) or an e-course she has completed (her access, course_access.client_id; open
// once `completed_at` is set and the access is not revoked, reached by the course's slug). One row per registration and per access: the submit
// (answers, submitted_at) or "Ei soovi" (dismissed_at). With her consent (the tick under the recommend question) the submit also makes a pending
// review of that answer, in its transaction. Logs carry the registration's or the access's id only.

/** The form's course: a contact course's registration, or the slug of an e-course she has access to. */
export type FeedbackTarget = { registrationId: number } | { courseSlug: string };

/** The row a feedback belongs to, as the table holds it: a registration or an access. */
type Owner = { registrationId: number } | { accessId: number };

type Own = {
  owner: Owner;
  courseId: number;
  /** Who answers, for Maria's notice: the registration's name; the account's (her address while she has no name) for an e-course. */
  name: string;
  email: string;
  /** The name the form offers under the tick (domain/review.ts shownNameFrom): the registration's name; for an e-course the account's, "" when it has none. */
  shownName: string;
  course: { slug: string; title: I18n };
  startsAt: Date | null;
  open: boolean;
  feedback: { submittedAt: Date | null; dismissedAt: Date | null } | null;
};

const ownerText = (o: Owner): string => ("registrationId" in o ? `registration ${o.registrationId}` : `access ${o.accessId}`);
/** The unique column and the condition that find the feedback row of `o`. */
const ownerColumn = (o: Owner) => ("registrationId" in o ? courseFeedback.registrationId : courseFeedback.accessId);
const ownerIs = (o: Owner) => ("registrationId" in o ? eq(courseFeedback.registrationId, o.registrationId) : eq(courseFeedback.accessId, o.accessId));

/**
 * One of the client's own courses to give feedback on, with whether the form is open and her feedback row; null when it is not hers.
 * `lock`: FOR SHARE of the registration or the access until the caller's transaction ends (an account deletion that is unlinking it waits, or
 * is waited for: client-data.ts deleteClient takes the registrations, then the accesses, FOR UPDATE, and this takes one of them only).
 */
async function own(q: Q, clientId: number, target: FeedbackTarget, now: Date, lock: boolean): Promise<Own | null> {
  return "registrationId" in target ? ownRegistration(q, clientId, target.registrationId, now, lock) : ownAccess(q, clientId, target.courseSlug, lock);
}

/** A registration of a contact course (the form opens by domain/protocols.ts feedbackOpen). */
async function ownRegistration(q: Q, clientId: number, registrationId: number, now: Date, lock: boolean): Promise<Own | null> {
  const query = q
    .select({
      id: registrations.id,
      courseId: registrations.courseId,
      name: registrations.name,
      email: registrations.email,
      status: registrations.status,
      kind: registrations.kind,
      type: courses.type,
      slug: courses.slug,
      title: courses.title,
      startsAt: courseSessions.startsAt,
      sessionStatus: courseSessions.status,
      protocolSentAt: protocols.sentAt,
      feedbackId: courseFeedback.id,
      submittedAt: courseFeedback.submittedAt,
      dismissedAt: courseFeedback.dismissedAt,
    })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .leftJoin(courseFeedback, eq(courseFeedback.registrationId, registrations.id))
    .where(and(eq(registrations.id, registrationId), eq(registrations.clientId, clientId)));
  const [r] = await (lock ? query.for("share", { of: registrations }) : query);
  if (!r || r.type !== "contact") return null;
  const open = feedbackOpenFor(r, now);
  return {
    owner: { registrationId: r.id },
    courseId: r.courseId,
    name: r.name,
    email: r.email,
    shownName: shownNameFrom(r.name),
    course: { slug: r.slug, title: r.title },
    startsAt: r.startsAt,
    open,
    feedback: r.feedbackId === null ? null : { submittedAt: r.submittedAt, dismissedAt: r.dismissedAt },
  };
}

/**
 * Her access to the e-course `slug`: open once the course is completed (`completed_at` set, never cleared) and the access is not revoked
 * (an ended one, past `expires_at`, still counts: she finished the course). The form has no day, so the notice carries none.
 */
async function ownAccess(q: Q, clientId: number, slug: string, lock: boolean): Promise<Own | null> {
  const query = q
    .select({
      id: courseAccess.id,
      courseId: courses.id,
      type: courses.type,
      slug: courses.slug,
      title: courses.title,
      completedAt: courseAccess.completedAt,
      revokedAt: courseAccess.revokedAt,
      accountName: clients.name,
      email: clients.email,
      feedbackId: courseFeedback.id,
      submittedAt: courseFeedback.submittedAt,
      dismissedAt: courseFeedback.dismissedAt,
    })
    .from(courseAccess)
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .leftJoin(courseFeedback, eq(courseFeedback.accessId, courseAccess.id))
    .where(and(eq(courseAccess.clientId, clientId), eq(courses.slug, slug)));
  const [a] = await (lock ? query.for("share", { of: courseAccess }) : query);
  if (!a || a.type !== "e_learning") return null;
  return {
    owner: { accessId: a.id },
    courseId: a.courseId,
    name: a.accountName.trim() || a.email,
    email: a.email,
    shownName: shownNameFrom(a.accountName),
    course: { slug: a.slug, title: a.title },
    startsAt: null,
    open: a.completedAt !== null && a.revokedAt === null,
    feedback: a.feedbackId === null ? null : { submittedAt: a.submittedAt, dismissedAt: a.dismissedAt },
  };
}

/** What the form needs: its course, whether she has answered already, and the name it offers under the tick (empty when her account has none). */
export type FeedbackFormState = { course: { slug: string; title: I18n }; sent: boolean; shownName: string };

/** The form of one of her courses; null when it is not hers, or the form is not open and she has sent nothing. */
export async function feedbackState(db: Db, clientId: number, target: FeedbackTarget, now: Date): Promise<FeedbackFormState | null> {
  const r = await own(db, clientId, target, now, false);
  if (!r) return null;
  const sent = r.feedback?.submittedAt != null;
  return sent || r.open ? { course: r.course, sent, shownName: r.shownName } : null;
}

/** `consentText` and `consentName`: the tick is set but the answer has no text, or the name is empty or over its limit (domain/review.ts checkConsent). */
export type SubmitResult = { kind: "submitted"; notice: FeedbackNotice } | { kind: "sent" } | { kind: "notFound" } | { kind: "consentText" } | { kind: "consentName" };

/**
 * Her answers (spec §7), checked already (account-input.ts parseFeedbackPost): once per course. A row "Ei soovi" made is answered now (the mail's
 * link still opens the form); a second submit, or two at the same moment, finds it answered: "sent". notFound: not hers, or the form is not open.
 * `consent` (student reviews, D1): her tick with the name to show, or null for none. It is checked first, before anything is read, against the
 * answers' `recommend` text: a refusal (`consentText`, `consentName`) writes nothing. Given, the review (a pending copy of the answer and the name,
 * `student`) is made after the feedback row, in the same transaction; one review per feedback (reviews_feedback), so a replay writes none. One
 * transaction, the registration or the access read FOR SHARE.
 */
export async function submitFeedback(
  db: Db,
  input: { clientId: number; target: FeedbackTarget; answers: FeedbackAnswers; locale: "et" | "ru"; consent: { name: string } | null },
  now: Date,
): Promise<SubmitResult> {
  let shown: string | null = null;
  if (input.consent) {
    const checked = checkConsent(input.answers.recommend, input.consent.name);
    if (!checked.ok) return { kind: checked.error };
    shown = checked.name;
  }
  const stored = await db.transaction(async (tx): Promise<{ kind: "submitted"; owner: Owner; reviewId: number | null; notice: FeedbackNotice } | { kind: "sent" } | { kind: "notFound" }> => {
    const r = await own(tx, input.clientId, input.target, now, true);
    if (!r) return { kind: "notFound" };
    if (r.feedback?.submittedAt) return { kind: "sent" };
    if (!r.open) return { kind: "notFound" };
    await tx.insert(courseFeedback).values({ ...r.owner, createdAt: now }).onConflictDoNothing({ target: ownerColumn(r.owner) });
    const [row] = await tx
      .update(courseFeedback)
      .set({ answers: input.answers, locale: input.locale, submittedAt: now })
      .where(and(ownerIs(r.owner), isNull(courseFeedback.submittedAt)))
      .returning();
    if (!row) return { kind: "sent" };
    let reviewId: number | null = null;
    if (shown !== null && typeof input.answers.recommend === "string") {
      // (checkConsent has seen that the answer has text; the review is a copy of it and of the name, which nothing updates afterwards)
      const [review] = await tx
        .insert(reviews)
        .values({ courseId: r.courseId, feedbackId: row.id, kind: "student", text: input.answers.recommend, name: shown, locale: input.locale, writtenAt: now, status: "pending", createdAt: now, updatedAt: now })
        .returning();
      reviewId = review.id;
    }
    return {
      kind: "submitted",
      owner: r.owner,
      reviewId,
      notice: { target: r.owner, name: r.name, email: r.email, course: r.course.title.et, startsAt: r.startsAt, answers: input.answers, publishable: shown !== null },
    };
  });
  if (stored.kind !== "submitted") return stored;
  // after the commit: a submit the database rolled back is never logged as stored
  console.info(`[feedback] ${ownerText(stored.owner)}: submitted`);
  if (stored.reviewId !== null) console.info(`[reviews] review ${stored.reviewId}: pending (${ownerText(stored.owner)})`);
  return { kind: "submitted", notice: stored.notice };
}

/** "Ei soovi" (spec §7): the dashboard's card is gone for good. false: not hers, or the form is not open (and nothing of hers is there). */
export async function hideFeedback(db: Db, input: { clientId: number; target: FeedbackTarget }, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await own(tx, input.clientId, input.target, now, true);
    if (!r || (!r.open && !r.feedback)) return false;
    await tx.insert(courseFeedback).values({ ...r.owner, dismissedAt: now, createdAt: now }).onConflictDoNothing({ target: ownerColumn(r.owner) });
    return true;
  });
}

/** Maria's "Uus tagasiside: …" by mail and Telegram (spec §6), after the response; never fails the answer. `opts.count`: the database of the day's mail count (notify.ts SendOptions). */
export async function notifyFeedback(env: Env, siteUrl: string, notice: FeedbackNotice, opts: { count?: Q } = {}): Promise<void> {
  const s = feedbackSummary(notice, adminUrl(siteUrl));
  const r = await notifyMaria(env, s.subject, s.text, { short: s.short, replyTo: notice.email, siteUrl, count: opts.count });
  console.info(`[feedback] ${ownerText(notice.target)}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
}
