import Link from "next/link";
import type { ProtocolIndex as IndexData } from "@/db/queries/protocols";
import { tallinnFormParts } from "@/domain/calendar";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDayMonth, formatTime, formatWeekday } from "@/i18n/format";
import styles from "./ProtocolIndex.module.css";
import ui from "./ui.module.css";

// The Protokollid index (admin UX pass, B8; README A3): the card under the page's heading, with a row for each course day of today and the 14 days
// before it, newest first, then the open individual registrations. A server component: it only links (a row's „Ava“ opens the unchanged screen at
// ?sessioon= / ?registreering=). „Täna“ is Tallinn's date, like the menu's badge and the 14-day window itself.

export function ProtocolIndex({ data, now }: { data: IndexData; now: Date }) {
  const t = adminEt.protocols;
  const x = t.index;
  const today = tallinnFormParts(now).date;
  return (
    <section className={`${ui.card} ${styles.card}`} data-protocol-index="">
      {data.sessions.length === 0 ? (
        <div className={styles.empty} data-index-empty="">
          <p className={ui.empty}>{x.empty}</p>
          <Link className={ui.link} href="/admin/kalender">
            {x.toCalendar}
          </Link>
        </div>
      ) : (
        <ul className={styles.rows} data-index-sessions="">
          {data.sessions.map((s) => {
            const isToday = tallinnFormParts(s.startsAt).date === today;
            const weekday = formatWeekday(s.startsAt, "et");
            const day = formatDayMonth(s.startsAt, "et");
            const done = s.students > 0 && s.sent === s.students;
            return (
              <li key={s.id} className={styles.row} data-index-session={s.id} data-today={isToday ? "" : undefined}>
                <span className={styles.when}>
                  <b className={styles.day}>{isToday ? x.today : day}</b>
                  <span className={styles.sub}>{isToday ? `${weekday}, ${day}` : weekday}</span>
                </span>
                <span className={styles.what}>
                  <b className={styles.strong}>{s.course}</b>
                  <span className={styles.sub}>{s.place ? `${formatTime(s.startsAt, "et")} · ${s.place}` : formatTime(s.startsAt, "et")}</span>
                </span>
                <span className={`${styles.counts} ${done ? styles.done : ""}`} data-index-counts={done ? "done" : "open"}>
                  {done ? fill(x.allSent, { n: s.students }) : fill(x.counts, { n: s.students, a: s.sent, b: s.drafts })}
                </span>
                <Link className={`${ui.btn} ${ui.smallBtn} ${isToday ? "" : ui.secondary} ${styles.open}`} href={`/admin/protokollid?sessioon=${s.id}`} data-index-open="">
                  {x.open}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {data.individual.length > 0 && (
        <div className={styles.individual} data-index-individual="">
          <h2 className={styles.sectionLabel}>{x.individual}</h2>
          <ul className={styles.rows}>
            {data.individual.map((r) => (
              <li key={r.registrationId} className={`${styles.row} ${styles.individualRow}`} data-index-registration={r.registrationId}>
                <span className={styles.agreed}>{adminEt.registrations.agreed}</span>
                <span className={styles.what}>
                  <b className={styles.strong}>{r.name}</b>
                  <span className={styles.sub}>{r.course}</span>
                </span>
                <span className={styles.counts} data-index-state={r.draft ? "draft" : "none"}>
                  {r.draft ? t.mark.draft : x.notStarted}
                </span>
                <Link className={`${ui.btn} ${ui.smallBtn} ${ui.secondary} ${styles.open}`} href={`/admin/protokollid?registreering=${r.registrationId}`} data-index-open="">
                  {x.open}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
