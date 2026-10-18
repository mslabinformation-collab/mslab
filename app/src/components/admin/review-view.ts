import type { ReviewKind, ReviewStatus } from "@/domain/review";
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
  course: { id: number; title: string };
  /** Maria's internal source note: a review she added has one, a student's never. */
  note: string | null;
  /** A student's review has its proof; one Maria added has none. */
  proof: ReviewProofView | null;
};

/** A course „Lisa arvustus“ can name: its id and the words in the list (a draft says so). */
export type ReviewCourseOption = { id: number; label: string };

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
    course: { id: row.course.id, title: pick(row.course.title, "et") },
    note: row.note,
    proof: proof === null ? null : "completedAt" in proof ? { kind: "completed", completedAt: proof.completedAt.toISOString() } : { kind: "registration", status: proof.registrationStatus, protocolSent: proof.protocolSent },
  };
}
