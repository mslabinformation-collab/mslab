import type { Metadata } from "next";
import Link from "next/link";
import { checkReasonLabel } from "@/components/admin/PaymentLines";
import { adminTitle } from "@/components/admin/sections";
import { TestplanCard } from "@/components/admin/TestplanCard";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listAdminSessions, type RequestKind } from "@/db/queries/admin";
import { overviewQueue, type Oldest } from "@/db/queries/overview";
import { protocolIndex } from "@/db/queries/protocols";
import { startOfDayTallinn, tallinnFormParts } from "@/domain/calendar";
import { endOfDayTallinn, tallinnToday } from "@/domain/client-access";
import { seatsLeft } from "@/domain/sessions";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDayMonth, formatLongDate, formatTime } from "@/i18n/format";
import { adminName, requireAdmin } from "@/server/auth";
import { serverEnv } from "@/server/env";
import { logFailure } from "@/server/log";
import { testplanCard } from "@/server/testplan";
import styles from "./overview.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.overview) };

/** Rows of the „Tulevased koolitused“ list. */
const UPCOMING_ROWS = 5;
/** „järgmise 30 päeva jooksul“: today and the 30 Tallinn days after it. */
const UPCOMING_DAYS = 30;
/** The kinds of request in the hint of „Päringut tegemata“, in the order P-1 writes them. */
const REQUEST_KINDS: RequestKind[] = ["contact", "individual", "practice", "waitlist", "change_request"];

/** The date text "2026-10-21" `days` calendar days later: plain calendar arithmetic, so the two days the clocks change cannot move it. */
function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Overview (admin UX pass piece 2, A1; README A1 and the Part 2 prototype): the date and „Tere, {name}.“; a dark „Täna“ card for each session today,
 * with its protocols' progress and one tap to them; „Sinu järjekord“, one row for each thing Maria has to act on (a count, a label, a hint, the page
 * that lists them; a row with 0 is not drawn, and an empty queue says so); and „Tulevased koolitused“, the next five sessions, each opening its
 * Kalender drawer. On a phone the parts stack in that order; the Testimine card, while checks are open, comes last.
 */
export default async function Overview() {
  const email = await requireAdmin();
  const name = adminName(email);
  const now = new Date();
  const db = getDb();
  const [queue, index, sessions, testing] = await Promise.all([
    overviewQueue(db, now),
    protocolIndex(db, now),
    // every session from the start of today's Tallinn day, drafts' too and called-off ones included (left out below), as the Kalender lists them
    listAdminSessions(db, { from: startOfDayTallinn(now), upcoming: true }, now),
    // the test page's card (phase 4, piece 1): a failing read leaves the card out, never the overview
    testplanCard(db, email, serverEnv().ADMIN_NAMES).catch((e) => {
      logFailure("[testplan] the card's numbers could not be read", e);
      return null;
    }),
  ]);
  const t = adminEt.overview;
  const q = t.queue;

  // „Täna“: the index (14 days back, today and later today) holds today's sessions, newest first; the cards go earliest first
  const today = tallinnToday(now);
  const todays = index.sessions.filter((s) => tallinnFormParts(s.startsAt).date === today).reverse();

  const scheduled = sessions.filter((s) => s.status !== "cancelled");
  const windowEnd = endOfDayTallinn(plusDays(today, UPCOMING_DAYS))!;
  const soon = scheduled.filter((s) => s.startsAt.getTime() <= windowEnd.getTime()).length;

  const oldest = (o: Oldest | null) => (o ? fill(q.oldest, { date: formatDayMonth(o.at, "et"), name: o.name }) : "");
  /** "3 kontakt · 2 individuaal": the parts with a number, joined. */
  const parts = (list: [number, string][]) => list.filter(([n]) => n > 0).map(([n, template]) => fill(template, { n })).join(" · ");
  const checkWhy = queue.check.reason ? checkReasonLabel(queue.check.reason) : q.checkAt;
  // README order; a row with 0 is left out
  const rows = [
    { key: "awaiting", n: queue.awaiting.count, href: "/admin/registreerimised?staatus=ootab", hint: oldest(queue.awaiting.oldest) },
    {
      key: "assessment",
      n: queue.assessment.count,
      href: "/admin/hindamine",
      hint: parts([
        [queue.assessment.practical, q.assessmentParts.practical],
        [queue.assessment.test, q.assessmentParts.test],
        [queue.assessment.triesUsed, q.assessmentParts.triesUsed],
      ]),
    },
    { key: "requests", n: queue.requests.count, href: "/admin/paringud", hint: parts(REQUEST_KINDS.map((kind): [number, string] => [queue.requests.byKind[kind], q.requestParts[kind]])) },
    // (#arveta is the strip „Arveta maksed: {n}“ on the Arved page; it opens its list when the address names it)
    { key: "unbilled", n: queue.unbilled.count, href: "/admin/arved#arveta", hint: oldest(queue.unbilled.oldest) },
    { key: "reviews", n: queue.reviews.count, href: "/admin/tagasiside?vaade=arvustused&olek=ootel", hint: oldest(queue.reviews.oldest) },
    { key: "check", n: queue.check.count, href: "/admin/maksed?staatus=kontroll", hint: `${oldest(queue.check.oldest)} · ${checkWhy}` },
  ] as const;
  const waiting = rows.filter((r) => r.n > 0);

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{formatLongDate(now, "et")}</p>
          <h1 className={ui.h1}>{name ? fill(adminEt.panel.hello, { name }) : adminEt.panel.helloNoName}</h1>
        </div>
      </div>

      {/* „Täna“: one dark card for each session today, with its protocols' progress and the way to them; none on a day without a session */}
      {todays.length > 0 && (
        <>
          {todays.map((s) => {
            // „alustamata“: students with no protocol yet (a protocol sent and edited since is a draft, protocolIndex)
            const notStarted = Math.max(0, s.students - s.sent - s.drafts);
            const when = fill(t.today.when, { time: formatTime(s.startsAt, "et"), place: s.place }).replace(/ · $/, "");
            return (
              <section key={s.id} className={styles.today} aria-labelledby={`today-${s.id}`} data-today-session={s.id}>
                <div className={styles.todayText}>
                  <p className={styles.todayWhen}>{when}</p>
                  <h2 id={`today-${s.id}`} className={styles.todayCourse}>
                    {s.course}
                  </h2>
                  <p className={styles.todayCounts}>{fill(t.today.counts, { n: s.students, a: s.sent, b: s.drafts, c: notStarted })}</p>
                </div>
                <Link className={styles.todayOpen} href={`/admin/protokollid?sessioon=${s.id}`}>
                  {t.today.open}
                </Link>
              </section>
            );
          })}
        </>
      )}

      <div className={styles.grid}>
        {waiting.length === 0 ? (
          <section className={`${styles.card} ${styles.empty}`}>
            <h2 className={styles.emptyTitle}>{q.empty}</h2>
            <p className={styles.emptyHint}>{q.emptyHint}</p>
          </section>
        ) : (
          <section className={styles.card} aria-labelledby="queue-title" data-overview-queue="">
            <h2 id="queue-title" className={styles.cardTitle}>
              {q.title}
            </h2>
            <ul className={styles.queue}>
              {waiting.map((r) => (
                <li key={r.key}>
                  <Link className={styles.queueRow} href={r.href} data-overview-row={r.key}>
                    <strong className={styles.count}>{r.n}</strong>
                    <span className={styles.what}>
                      <b className={styles.label}>{q.label[r.key]}</b>
                      <span className={styles.hint}>{r.hint}</span>
                    </span>
                    <span className={styles.arrow} aria-hidden="true">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.card} aria-labelledby="upcoming-title" data-overview-upcoming="">
          <div className={styles.cardHead}>
            <h2 id="upcoming-title" className={styles.cardTitle}>
              {t.upcoming.title}
            </h2>
            <p className={styles.note}>{fill(t.upcoming.window, { n: soon })}</p>
          </div>
          {scheduled.length > 0 && (
            <>
              <div className={`${styles.upRow} ${styles.upHead}`} aria-hidden="true">
                <span>{t.upcoming.date}</span>
                <span>{t.upcoming.course}</span>
                <span className={styles.seats}>{t.upcoming.seats}</span>
              </div>
              <ul className={styles.upList}>
                {scheduled.slice(0, UPCOMING_ROWS).map((s) => {
                  const left = seatsLeft(s.capacity, s.taken);
                  return (
                    <li key={s.id}>
                      <Link className={styles.upRow} href={`/admin/kalender?id=${s.id}`} data-upcoming-session={s.id} data-seats-left={left}>
                        <span>{formatDayMonth(s.startsAt, "et")}</span>
                        <span className={styles.upWhat}>
                          <b>{pick(s.course.title, "et")}</b>
                          <span>{s.city}</span>
                        </span>
                        <span className={`${styles.seats} ${left === 0 ? styles.full : ""}`}>
                          <span className={ui.sr}>{t.upcoming.seats} </span>
                          {left} / {s.capacity}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <Link className={styles.calendar} href="/admin/kalender">
            {t.upcoming.calendar}
          </Link>
        </section>
      </div>

      {/* "Testimine: N avatud, M viga" (phase 4, piece 1, spec D1, §5): the signed-in admin's open and failed checks; hidden when there are none.
          README fixes the order Täna → queue → upcoming and says only that this card "stays the same": it comes last, so that order is unbroken. */}
      {testing && <TestplanCard open={testing.open} bad={testing.bad} />}
    </div>
  );
}
