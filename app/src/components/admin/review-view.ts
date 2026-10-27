import type { ReviewKind, ReviewStatus } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import type { AdminReviewRow } from "@/server/reviews";

// A review as Maria's „Arvustused“ gets it (student reviews, Task 4): the admin's row without a Date (a client component's props are JSON), with the
// course named in Estonian. The page builds it (tagasiside/page.tsx); ReviewsPanel and ManualReviewForm read it. Types only from the server file.

/** What Maria judges a student's review by (D2): the registration's status and whether a protocol was sent, or the day the e-course was completed. */
export type ReviewProofView = { kind: "registration"; status: string; protocolSent: boolean } | { kind: "completed"; completedAt: string };

export type ReviewRowView = {
  id: number;
  kind: ReviewKind;
  status: ReviewStatus;
  featured: boolean;
  text: string;
  name: string;
  locale: "et" | "ru";
  /** The day written, as an ISO instant. */
  writtenAt: string;
  /** `published`: the course is on the public site; a draft's reviews show nowhere until it is (the final review's M2). */
  course: { id: number; title: string; published: boolean };
  /** Maria's internal source note: a review she added has one, a student's never. */
  note: string | null;
  /** A student's review has its proof; one Maria added has none. */
  proof: ReviewProofView | null;
  /** The feedback answer a student's review was made from (piece 4c); null for one Maria added. */
  feedbackId: number | null;
  /** That answer's „Hinne“, 0–10: the card's stars (domain/review.ts starsOf). Null for one Maria added and for an answer without a score. */
  score: number | null;
};

/** A course „Lisa arvustus“ can name: its id and the words in the list (a draft says so). */
export type ReviewCourseOption = { id: number; label: string };

/** A course's name as the admin's lists say it: the title, and „(mustand)“ after it while the course is a draft (the `published` flag; the mark of the grant form's list too). */
export const courseLabel = (title: string, published: boolean): string => (published ? title : `${title} (${adminEt.clients.grant.draft})`);

export function reviewRowView(row: AdminReviewRow): ReviewRowView {
  const proof = row.proof;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    featured: row.featured,
    text: row.text,
    name: row.name,
    locale: row.locale,
    writtenAt: row.writtenAt.toISOString(),
    course: { id: row.course.id, title: pick(row.course.title, "et"), published: row.course.published },
    note: row.note,
    proof: proof === null ? null : "completedAt" in proof ? { kind: "completed", completedAt: proof.completedAt.toISOString() } : { kind: "registration", status: proof.registrationStatus, protocolSent: proof.protocolSent },
    feedbackId: row.feedbackId,
    score: row.score,
  };
}
