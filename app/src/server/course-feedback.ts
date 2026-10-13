import { and, eq, isNull } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { courseFeedback, courses, courseSessions, protocols, registrations } from "@/db/schema";
import { feedbackOpenFor, type FeedbackAnswers } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { feedbackSummary, type FeedbackNotice } from "./messages";
import { adminUrl, notifyMaria, type Env } from "./notify";

// The course feedback form (phase protocols, spec §3, §7) for the signed-in client, without Next.js: account-api.ts takes the client from the
// session and calls these. A registration is hers by the dashboard's rule (registrations.client_id), and the form opens by domain/protocols.ts
// feedbackOpen. One row per registration: the submit (answers, submitted_at) or "Ei soovi" (dismissed_at). Logs carry the registration's id only.

type Own = {
  registrationId: number;
  name: string;
  email: string;
  course: { slug: string; title: I18n };
  startsAt: Date | null;
  open: boolean;
  feedback: { submittedAt: Date | null; dismissedAt: Date | null } | null;
};

/**
 * One of the client's own registrations of a contact course, with whether the form is open and her feedback row; null when it is not hers.
 * `lock`: FOR SHARE of the registration until the caller's transaction ends (an account deletion that is unlinking it waits, or is waited for).
 */
async function own(q: Q, clientId: number, registrationId: number, now: Date, lock: boolean): Promise<Own | null> {
  const query = q
    .select({
      id: registrations.id,
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
    registrationId: r.id,
    name: r.name,
    email: r.email,
    course: { slug: r.slug, title: r.title },
    startsAt: r.startsAt,
    open,
    feedback: r.feedbackId === null ? null : { submittedAt: r.submittedAt, dismissedAt: r.dismissedAt },
  };
}

/** What the form needs: its course, and whether she has answered already. */
export type FeedbackFormState = { course: { slug: string; title: I18n }; sent: boolean };

/** The form of one of her registrations; null when it is not hers, or the form is not open and she has sent nothing. */
export async function feedbackState(db: Db, clientId: number, registrationId: number, now: Date): Promise<FeedbackFormState | null> {
  const r = await own(db, clientId, registrationId, now, false);
  if (!r) return null;
  const sent = r.feedback?.submittedAt != null;
  return sent || r.open ? { course: r.course, sent } : null;
}

export type SubmitResult = { kind: "submitted"; notice: FeedbackNotice } | { kind: "sent" } | { kind: "notFound" };

/**
 * Her answers (spec §7), checked already (account-input.ts parseFeedbackPost): once per registration. A row "Ei soovi" made is answered now
 * (the mail's link still opens the form); a second submit, or two at the same moment, finds it answered: "sent". notFound: not hers, or the
 * form is not open. One transaction, the registration read FOR SHARE.
 */
export async function submitFeedback(
  db: Db,
  input: { clientId: number; registrationId: number; answers: FeedbackAnswers; locale: "et" | "ru" },
  now: Date,
): Promise<SubmitResult> {
  const result = await db.transaction(async (tx): Promise<SubmitResult> => {
    const r = await own(tx, input.clientId, input.registrationId, now, true);
    if (!r) return { kind: "notFound" };
    if (r.feedback?.submittedAt) return { kind: "sent" };
    if (!r.open) return { kind: "notFound" };
    await tx.insert(courseFeedback).values({ registrationId: input.registrationId, createdAt: now }).onConflictDoNothing({ target: courseFeedback.registrationId });
    const [row] = await tx
      .update(courseFeedback)
      .set({ answers: input.answers, locale: input.locale, submittedAt: now })
      .where(and(eq(courseFeedback.registrationId, input.registrationId), isNull(courseFeedback.submittedAt)))
      .returning();
    if (!row) return { kind: "sent" };
    return { kind: "submitted", notice: { registrationId: r.registrationId, name: r.name, email: r.email, course: r.course.title.et, startsAt: r.startsAt, answers: input.answers } };
  });
  // after the commit: a submit the database rolled back is never logged as stored
  if (result.kind === "submitted") console.info(`[feedback] registration ${input.registrationId}: submitted`);
  return result;
}

/** "Ei soovi" (spec §7): the dashboard's card is gone for good. false: not hers, or the form is not open (and nothing of hers is there). */
export async function hideFeedback(db: Db, input: { clientId: number; registrationId: number }, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await own(tx, input.clientId, input.registrationId, now, true);
    if (!r || (!r.open && !r.feedback)) return false;
    await tx.insert(courseFeedback).values({ registrationId: input.registrationId, dismissedAt: now, createdAt: now }).onConflictDoNothing({ target: courseFeedback.registrationId });
    return true;
  });
}

/** Maria's "Uus tagasiside: …" by mail and Telegram (spec §6), after the response; never fails the answer. */
export async function notifyFeedback(env: Env, siteUrl: string, notice: FeedbackNotice): Promise<void> {
  const s = feedbackSummary(notice, adminUrl(siteUrl));
  const r = await notifyMaria(env, s.subject, s.text, { short: s.short, replyTo: notice.email, siteUrl });
  console.info(`[feedback] registration ${notice.registrationId}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
}
