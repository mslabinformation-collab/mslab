import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import { Drawer } from "@/components/admin/Drawer";
import { FeedbackAnswers, formatScore } from "@/components/admin/FeedbackAnswers";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { feedbackById, feedbackStats, pageFeedback, type CourseFeedbackStats, type FeedbackRow } from "@/db/queries/protocols";
import { parsePage } from "@/domain/paging";
import { FEEDBACK_CHOICES, feedbackQuestions, type ChoiceKey } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import styles from "./feedback.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.feedback) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?koolitus=<course id> (the filter), ?leht=<n> (50 a page), ?id=<answer> (the drawer). A new filter starts at page 1; the drawer
// keeps the page it was opened from.
type View = { koolitus: number | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

function parse(sp: Search): View & { id: number | null } {
  return { koolitus: parseRowId(one(sp.koolitus)), leht: parsePage(sp.leht), id: parseRowId(one(sp.id)) };
}

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
 * score and every option of the seven choice questions with its count. A row's name opens its answers (the drawer, ?id=). Read-only.
 */
export default async function FeedbackPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list, stats, open] = await Promise.all([pageFeedback(db, view.koolitus, view.leht), feedbackStats(db), view.id ? feedbackById(db, view.id) : null, getAdminCounts()]);
  const t = adminEt.feedback;
  const chosen = view.koolitus === null ? null : (stats.find((s) => s.course.id === view.koolitus) ?? null);
  const filters: { key: number | null; label: string }[] = [{ key: null, label: t.all }, ...stats.map((s) => ({ key: s.course.id, label: pick(s.course.title, "et") }))];

  return (
    <Shell email={email} active="feedback">
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>

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
        <p className={ui.muted}>{f.startsAt ? `${pick(f.course.title, "et")}, ${formatDate(f.startsAt, "et")}` : pick(f.course.title, "et")}</p>
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
