import Link from "next/link";
import { paragraphs } from "@/domain/catalogue";
import { COURSE_REVIEWS_SHOWN, reviewMonth } from "@/domain/review";
import { pick } from "@/i18n/field";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import type { PublicReview } from "@/server/reviews";
import { ReviewMore } from "./ReviewMore";
import ui from "./ui.module.css";
import styles from "./ReviewList.module.css";

/**
 * The student reviews on the public pages (student reviews, spec D5, D7): the block „Õpilaste tagasiside“ of a course page (`course`: the newest
 * COURSE_REVIEWS_SHOWN, and „Näita kõiki (n)“ for the rest) and the section „Õpilaste kogemused“ of the home page (`home`: every review it is
 * given, each naming its course, linked). `reviews` come as the public reads give them (server/reviews.ts courseReviews, homeReviews): published
 * ones only, newest first. Each is shown as written, in its own language (its words and its shown name are marked with `lang` where that is not the
 * page's; the month and the course's title are the page's own), with the name and the month and year; no stars, no score and no average. The notice sits under both. With nothing to show nothing is rendered: no heading,
 * no notice.
 */
export function ReviewList({ reviews, locale, variant }: { reviews: PublicReview[]; locale: Locale; variant: "course" | "home" }) {
  if (reviews.length === 0) return null;
  const d = getDict(locale).reviews;
  const home = variant === "home";
  const titleId = `reviews-title-${variant}`;

  // the language to mark the review's words and shown name with: its own, where that is not the page's
  const langOf = (r: PublicReview) => (r.locale === locale ? undefined : r.locale);

  const item = (r: PublicReview) => (
    <li key={r.id} className={styles.item} data-review={r.id} tabIndex={-1}>
      <figure className={styles.card}>
        <blockquote className={styles.text} lang={langOf(r)}>
          {paragraphs(r.text).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </blockquote>
        <figcaption className={styles.who}>
          <span className={styles.person}>
            <span className={styles.name} lang={langOf(r)}>
              {r.name}
            </span>
            <span className={styles.month}>{reviewMonth(r.writtenAt, locale)}</span>
          </span>
          {home && (
            <Link className={styles.courseLink} href={href(locale, `/koolitused/${r.course.slug}`)}>
              {pick(r.course.title, locale)}
            </Link>
          )}
        </figcaption>
      </figure>
    </li>
  );

  const first = home ? reviews : reviews.slice(0, COURSE_REVIEWS_SHOWN);
  const rest = home ? [] : reviews.slice(COURSE_REVIEWS_SHOWN);

  return (
    <section className={home ? styles.homeSection : styles.courseSection} data-reviews={variant} aria-labelledby={titleId}>
      <div className={ui.wrap}>
        <h2 id={titleId} className={home ? `${ui.h2} ${styles.homeTitle}` : styles.courseTitle}>
          {home ? d.homeTitle : d.courseTitle}
        </h2>
        {rest.length > 0 ? (
          <ReviewMore label={`${d.showAll} (${rest.length})`} className={styles.list} rest={rest.map(item)}>
            {first.map(item)}
          </ReviewMore>
        ) : (
          <ul className={styles.list}>{first.map(item)}</ul>
        )}
        <p className={styles.notice} data-reviews-notice="">
          {d.notice}
        </p>
      </div>
    </section>
  );
}
