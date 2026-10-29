import type { ReviewKind, ReviewStatus } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import type { AdminReviewRow } from "@/server/reviews";
import type { ListPill } from "./ListToolbar";

// A review as Maria's „Arvustused“ gets it (student reviews, Task 4): the admin's row without a Date (a client component's props are JSON), with the
// course named in Estonian. The page builds it (tagasiside/page.tsx); ReviewsPanel and ManualReviewForm read it. Types only from the server file.
// Admin UX pass piece 4c: the view's addresses (?olek=, the drawers' ?id=), its status pills and the cards' anchors, shared by the page and the panel.

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

/** The reviews' status filter (?olek=): the address's word and the status it stands for. */
export const REVIEW_STATUS_WORD = { ootel: "pending", avaldatud: "published", peidetud: "hidden" } as const satisfies Record<string, ReviewStatus>;
export type ReviewStatusWord = keyof typeof REVIEW_STATUS_WORD;
export const REVIEW_STATUS_WORDS = Object.keys(REVIEW_STATUS_WORD) as ReviewStatusWord[];

/** „Arvustused“, Tagasiside's second view, of every status. */
export const REVIEWS_HREF = "/admin/tagasiside?vaade=arvustused";
/** The view narrowed to one status (the menu badge's `ootel`), or of every status. A drawer goes on top of it with `&id=uus` or `&id=<review>`. */
export const reviewsHref = (olek: ReviewStatusWord | null): string => (olek === null ? REVIEWS_HREF : `${REVIEWS_HREF}&olek=${olek}`);

/**
 * The status pills (piece 4c, R-e; S4-36 „Ootab kinnitust {n}“ · „Avaldatud {n}“ · „Peidetud {n}“): each status with its count (server/reviews.ts
 * reviewCounts), no „Kõik“ — every review is listed until a pill is pressed, and the pressed pill goes back to that list (it toggles off).
 */
export function reviewPills(olek: ReviewStatusWord | null, counts: Record<ReviewStatus, number>): ListPill[] {
  return REVIEW_STATUS_WORDS.map((word) => {
    const status = REVIEW_STATUS_WORD[word];
    return { href: reviewsHref(olek === word ? null : word), label: adminEt.reviews.status[status], count: counts[status], current: olek === word };
  });
}

/** A feedback answer's „Hinne“ as the Vastused list's cell writes it under its column „Hinne“: „9/10“ (tagasiside/page.tsx). */
export const scoreOutOfTen = (score: number): string => `${score}/10`;
/**
 * A review card's score for a screen reader (Dim 29.10: the stars are aria-hidden, so the card says the score in a visually hidden line): the
 * Vastused list's column word and cell, „Hinne 9/10“. None on a card without stars (a review Maria added, an answer without a score).
 */
export const spokenScore = (score: number): string => `${adminEt.feedback.col.score} ${scoreOutOfTen(score)}`;

/** A review card's element id (piece 4c, R-d): the anchor of `/admin/tagasiside?vaade=arvustused#arvustus-<id>`, and the card the focus stays on (D5). */
export const reviewCardId = (id: number): string => `arvustus-${id}`;
