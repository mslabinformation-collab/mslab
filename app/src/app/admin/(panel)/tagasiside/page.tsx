import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import { Drawer } from "@/components/admin/Drawer";
import { FeedbackAnswers, formatScore } from "@/components/admin/FeedbackAnswers";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { reviewRowView } from "@/components/admin/review-view";
import { ReviewsPanel } from "@/components/admin/ReviewsPanel";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { feedbackById, feedbackStats, pageFeedback, type CourseFeedbackStats, type FeedbackRow } from "@/db/queries/protocols";
import { tallinnToday } from "@/domain/client-access";
import { parsePage } from "@/domain/paging";
import { FEEDBACK_CHOICES, feedbackQuestions, type ChoiceKey } from "@/domain/protocols";
import type { ReviewStatus } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import { adminReviews, pendingReviewCount, reviewCourses } from "@/server/reviews";
import styles from "./feedback.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.feedback) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?koolitus=<course id> (the filter), ?leht=<n> (50 a page), ?id=<answer> (the drawer). A new filter starts at page 1; the drawer
// keeps the page it was opened from. ?vaade=arvustused is the page's second view, the student reviews (student reviews, Task 4; a view of its own
// because the answers' list, its numbers and its drawer already fill the page), with ?olek=ootel|avaldatud|peidetud narrowing it to one status.
// ?vaade=vastused (or none) is the answers' view; its own filters and pager keep no ?vaade.
type View = { koolitus: number | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** The reviews' status filter: the address's word and the status it stands for. */
const STATUS_WORD = { ootel: "pending", avaldatud: "published", peidetud: "hidden" } as const satisfies Record<string, ReviewStatus>;
type StatusWord = keyof typeof STATUS_WORD;
const STATUS_WORDS = Object.keys(STATUS_WORD) as StatusWord[];

type Parsed = View & { id: number | null; reviews: boolean; olek: StatusWord | null };

function parse(sp: Search): Parsed {
  return {
    koolitus: parseRowId(one(sp.koolitus)),
    leht: parsePage(sp.leht),
    id: parseRowId(one(sp.id)),
    reviews: sp.vaade === "arvustused",
    olek: STATUS_WORDS.find((word) => word === sp.olek) ?? null,
  };
}

const REVIEWS_HREF = "/admin/tagasiside?vaade=arvustused";
const reviewsHref = (olek: StatusWord | null) => (olek === null ? REVIEWS_HREF : `${REVIEWS_HREF}&olek=${olek}`);

function href(view: View, id?: number): string {
  const q = new URLSearchParams();
  if (view.koolitus) q.set("koolitus", String(view.koolitus));
  if (view.leht > 1) q.set("leht", String(view.leht));
  if (id) q.set("id", String(id));
  const s = q.toString();
  return `/admin/tagasiside${s ? `?${s}` : ""}`;
}

// The form's questions in Maria's wording (et.ts account.feedback): the counts are labelled with them.
const QUESTIONS = feedbackQuestions(et.account.feedback.questions);
const CHOICE_KEYS = Object.keys(FEEDBACK_CHOICES) as ChoiceKey[];

/**
 * Tagasiside (phase protocols, spec §7): the students' answers to the course feedback form, newest first, 50 a page, with the course filter.
 * Without a filter, every course that has answers with its count and average (a link to the filter); with one, its numbers: the average
 * score and every option of the seven choice questions with its count. A row's name opens its answers (the drawer, ?id=). Read-only. An e-course's
 * answer has no course day: "Lõpetatud {date}", the day her access was completed, stands in its place.
 *
 * The second view, "Arvustused" (?vaade=arvustused): the student reviews and "Lisa arvustus" (components/admin/ReviewsPanel.tsx). The heading counts the
 * reviews waiting for Maria on both views, and the count opens the ones waiting.
 */
export default async function FeedbackPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const view = parse(await searchParams);
  return view.reviews ? reviewsPage(email, view.olek) : answersPage(email, view);
}

/** The page's heading, the count of the reviews waiting for Maria (nothing when none wait) and the two views. */
function Top({ pending, active }: { pending: number; active: "answers" | "reviews" }) {
  const t = adminEt.feedback;
  return (
    <>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{active === "reviews" ? adminEt.reviews.lead : t.lead}</p>
        </div>
        {pending > 0 && (
          <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={reviewsHref("ootel")} data-pending-reviews={pending}>
            {fill(t.pendingReviews, { n: pending })}
          </Link>
        )}
      </div>
      <nav className={ui.filters} aria-label={t.viewsLabel} data-feedback-views="">
        <Link className={ui.pill} href="/admin/tagasiside?vaade=vastused" aria-current={active === "answers" ? "page" : undefined} data-view="answers">
          {t.views.answers}
        </Link>
        <Link className={ui.pill} href={REVIEWS_HREF} aria-current={active === "reviews" ? "page" : undefined} data-view="reviews">
          {t.views.reviews}
        </Link>
      </nav>
    </>
  );
}

/** "Arvustused": the reviews (by status, waiting first, then published, then hidden; the newest written first within each), narrowed by the status filter, and "Lisa arvustus". (A function of the page, not a component: it reads.) */
async function reviewsPage(email: string, olek: StatusWord | null) {
  const db = getDb();
  const t = adminEt.reviews;
  const [rows, courses, pending] = await Promise.all([adminReviews(db, olek === null ? {} : { status: STATUS_WORD[olek] }), reviewCourses(db), pendingReviewCount(db), getAdminCounts()]);
  const filters: { key: StatusWord | null; label: string }[] = [{ key: null, label: t.all }, ...STATUS_WORDS.map((word) => ({ key: word, label: t.status[STATUS_WORD[word]] }))];

  return (
    <Shell email={email} active="feedback">
      <div className={ui.page}>
        <Top pending={pending} active="reviews" />
        <nav className={ui.filters} aria-label={t.filterLabel} data-review-filter="">
          {filters.map((f) => (
            <Link key={f.key ?? "all"} className={ui.pill} href={reviewsHref(f.key)} aria-current={olek === f.key ? "true" : undefined} data-review-filter-status={f.key ?? "all"}>
              {f.label}
            </Link>
          ))}
        </nav>
        <ReviewsPanel
          rows={rows.map(reviewRowView)}
          courses={courses.map((c) => ({ id: c.id, label: c.published ? pick(c.title, "et") : `${pick(c.title, "et")} (${adminEt.clients.grant.draft})` }))}
          today={tallinnToday(new Date())}
          filtered={olek !== null}
        />
      </div>
    </Shell>
  );
}

/** "Vastused": the answers (see FeedbackPage). */
async function answersPage(email: string, view: Parsed) {
  const db = getDb();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list, stats, open, pending] = await Promise.all([pageFeedback(db, view.koolitus, view.leht), feedbackStats(db), view.id ? feedbackById(db, view.id) : null, pendingReviewCount(db), getAdminCounts()]);
  const t = adminEt.feedback;
  const chosen = view.koolitus === null ? null : (stats.find((s) => s.course.id === view.koolitus) ?? null);
  const filters: { key: number | null; label: string }[] = [{ key: null, label: t.all }, ...stats.map((s) => ({ key: s.course.id, label: pick(s.course.title, "et") }))];

  return (
    <Shell email={email} active="feedback">
      <div className={ui.page}>
        <Top pending={pending} active="answers" />

        {stats.length > 0 && (
          <nav className={ui.filters} aria-label={t.filterLabel} data-feedback-filter="">
            {filters.map((f) => (
              <Link key={f.key ?? 0} className={ui.pill} href={href({ koolitus: f.key, leht: 1 })} aria-current={view.koolitus === f.key ? "true" : undefined}>
                {f.label}
              </Link>
            ))}
          </nav>
        )}

        {view.koolitus === null && stats.length > 0 && <CourseTable stats={stats} />}
        {chosen && <CourseNumbers stats={chosen} />}

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {list.rows.length === 0 ? (
            <p className={ui.empty}>{view.koolitus ? t.emptyFiltered : t.empty}</p>
          ) : (
            <table className={`${ui.table} ${listTable.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.date}</th>
                  <th scope="col">{t.col.student}</th>
                  <th scope="col">{t.col.course}</th>
                  <th scope="col">{t.col.score}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((f) => (
                  <tr key={f.id} data-feedback-row={f.id}>
                    <td data-label={t.col.date} className={ui.nowrap}>
                      {formatDate(f.submittedAt, "et")}
                    </td>
                    <td data-label={t.col.student}>
                      <div className={listTable.who}>
                        <Link id={`feedback-${f.id}`} className={listTable.name} href={href(view, f.id)} scroll={false}>
                          {f.name}
                        </Link>
                      </div>
                    </td>
                    <td data-label={t.col.course}>
                      {pick(f.course.title, "et")}
                      {f.startsAt && <span className={`${ui.muted} ${styles.sub}`}>{formatDate(f.startsAt, "et")}</span>}
                      {f.completedAt && <span className={`${ui.muted} ${styles.sub}`}>{fill(t.completed, { date: formatDate(f.completedAt, "et") })}</span>}
                    </td>
                    <td data-label={t.col.score} className={ui.nowrap}>
                      {f.answers.score === undefined ? adminEt.common.none : `${f.answers.score}/10`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager info={list} href={(n) => href({ ...view, leht: n })} />
        </section>
      </div>

      {view.id !== null && (
        <Drawer label={open ? fill(t.drawer.label, { name: open.name }) : t.drawer.notFound} closeHref={href(view)} closeLabel={t.drawer.close} returnFocus={open ? `feedback-${open.id}` : undefined}>
          {open ? <FeedbackDetail f={open} /> : <p className={ui.empty}>{t.drawer.notFound}</p>}
        </Drawer>
      )}
    </Shell>
  );
}

const averageText = (average: number | null) => (average === null ? adminEt.feedback.noScore : `${formatScore(average)} / 10`);

/** Every course with answers: how many, and the average score; the course's name filters the page to it. */
function CourseTable({ stats }: { stats: CourseFeedbackStats[] }) {
  const t = adminEt.feedback;
  return (
    <section className={`${ui.card} ${listTable.card} ${styles.block}`} aria-labelledby="feedback-courses" data-feedback-courses="">
      <h2 id="feedback-courses" className={ui.h2}>
        {t.byCourse}
      </h2>
      <table className={`${ui.table} ${listTable.table}`}>
        <thead>
          <tr>
            <th scope="col">{t.col.course}</th>
            <th scope="col">{t.col.answers}</th>
            <th scope="col">{t.col.average}</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.course.id} data-feedback-course={s.course.id}>
              <td data-label={t.col.course}>
                <Link className={ui.link} href={href({ koolitus: s.course.id, leht: 1 })}>
                  {pick(s.course.title, "et")}
                </Link>
              </td>
              <td data-label={t.col.answers}>{s.summary.count}</td>
              <td data-label={t.col.average} className={ui.nowrap}>
                {averageText(s.summary.average)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** One course's numbers (spec §7): the answers, the scores and their average, and every option of every choice question with its count. */
function CourseNumbers({ stats }: { stats: CourseFeedbackStats }) {
  const t = adminEt.feedback;
  const s = stats.summary;
  return (
    <section className={`${ui.card} ${styles.block}`} aria-labelledby="feedback-summary" data-feedback-summary={stats.course.id}>
      <h2 id="feedback-summary" className={ui.h2}>
        {pick(stats.course.title, "et")}
      </h2>
      <p className={styles.numbers}>
        <span>{fill(t.count, { n: s.count })}</span>
        <span>{fill(t.scored, { n: s.scored })}</span>
        <strong data-feedback-average="">{s.average === null ? t.noScore : fill(t.average, { score: formatScore(s.average) })}</strong>
      </p>
      <div className={styles.questions}>
        {CHOICE_KEYS.map((key) => {
          const counts = s.options[key] as Record<string, number>;
          return (
            <div key={key} className={styles.question} data-feedback-counts={key}>
              <h3 className={ui.h3}>{QUESTIONS[key].label}</h3>
              <ul className={styles.counts}>
                {(FEEDBACK_CHOICES[key] as readonly string[]).map((option) => (
                  <li key={option} data-option={option}>
                    <span>{QUESTIONS[key].options?.[option]}</span>
                    <strong>{counts[option]}</strong>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The drawer: who, the course and its day, the ways to the student and the registration, and the answers. */
function FeedbackDetail({ f }: { f: FeedbackRow }) {
  const t = adminEt.feedback;
  return (
    <div className={styles.detail} data-feedback-detail={f.id}>
      <div className={styles.detailHead}>
        <h2 className={ui.h2}>{f.name}</h2>
        <a className={ui.contactLink} href={`mailto:${f.email}`}>
          {f.email}
        </a>
        <p className={ui.muted} data-feedback-course-day="">
          {f.startsAt
            ? `${pick(f.course.title, "et")}, ${formatDate(f.startsAt, "et")}`
            : f.completedAt
              ? `${pick(f.course.title, "et")}, ${fill(t.completed, { date: formatDate(f.completedAt, "et") })}`
              : pick(f.course.title, "et")}
        </p>
        <p className={styles.links}>
          {f.clientId !== null && (
            <Link className={ui.link} href={`/admin/opilased?id=${f.clientId}`}>
              {t.toStudent}
            </Link>
          )}
          {f.registrationId !== null && (
            <Link className={ui.link} href={`/admin/registreerimised?id=${f.registrationId}`}>
              {t.toRegistration}
            </Link>
          )}
        </p>
      </div>
      <FeedbackAnswers answers={f.answers} locale={f.locale} submittedAt={f.submittedAt} />
    </div>
  );
}
