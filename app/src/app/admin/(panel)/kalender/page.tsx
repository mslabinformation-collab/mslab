import type { Metadata } from "next";
import Link from "next/link";
import { Drawer } from "@/components/admin/Drawer";
import { adminTitle } from "@/components/admin/sections";
import { SessionForm, type SessionValues } from "@/components/admin/SessionForm";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listAdminSessions, listContactCourses, type AdminSessionRow } from "@/db/queries/admin";
import { startOfDayTallinn, tallinnFormParts } from "@/domain/calendar";
import { seatsLeft } from "@/domain/sessions";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime, formatWeekday } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./calendar.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.calendar) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const parseId = (v: string | undefined) => (v && /^\d{1,10}$/.test(v) && Number(v) > 0 && Number(v) <= 2_147_483_647 ? Number(v) : null);

/** The list's address: ?aeg=moodunud for past sessions, ?id=<n> | uus for the drawer. */
function href(past: boolean, id?: number | "uus"): string {
  const q = new URLSearchParams();
  if (past) q.set("aeg", "moodunud");
  if (id) q.set("id", String(id));
  const s = q.toString();
  return `/admin/kalender${s ? `?${s}` : ""}`;
}

function stateTag(s: AdminSessionRow): { text: string; cls: string } {
  const t = adminEt.calendar;
  if (s.status === "cancelled") return { text: t.status.cancelled, cls: ui.bad };
  if (seatsLeft(s.capacity, s.taken) === 0) return { text: t.full, cls: ui.warn };
  return { text: t.status.scheduled, cls: ui.ok };
}

/**
 * Kalender (B adminOther "calendar"): the sessions of the contact courses, upcoming first (or the past ones), with
 * seats, registrations and the waitlist. "Lisa toimumine" and each row open the session form in a drawer (?id=uus,
 * ?id=<n>); a saved new session closes it and is highlighted (?lisatud=<n>).
 */
export default async function CalendarAdminPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const past = one(sp.aeg) === "moodunud";
  const rawId = one(sp.id);
  const openId = rawId === "uus" ? "uus" : parseId(rawId);
  const added = parseId(one(sp.lisatud));
  const db = getDb();
  const [sessions, courses, [open]] = await Promise.all([
    listAdminSessions(db, { from: startOfDayTallinn(new Date()), upcoming: !past }),
    listContactCourses(db),
    // the drawer's session with its counts, also when it is in the other list (upcoming / past)
    typeof openId === "number" ? listAdminSessions(db, { ids: [openId] }) : [],
  ]);
  const t = adminEt.calendar;
  const courseOptions = courses.map((c) => ({ id: c.id, title: pick(c.title, "et"), published: c.published }));
  // the session's own course is always an option (even one that is no longer a contact course), so opening and saving
  // the form can never move the session to another course by default
  if (open && !courseOptions.some((c) => c.id === open.courseId))
    courseOptions.push({ id: open.course.id, title: pick(open.course.title, "et"), published: open.course.published });

  let drawer: React.ReactNode = null;
  if (openId === "uus" && courses.length > 0) {
    const initial: SessionValues = { id: null, courseId: null, date: "", time: "10:00", city: "", venue: "", language: "ET", capacity: 4, status: "scheduled" };
    drawer = (
      <Drawer label={t.drawer.newLabel} closeHref={href(past)} closeLabel={adminEt.common.close} returnFocus="add-session">
        <div className={styles.drawer}>
          <h2 className={ui.h2}>{t.drawer.newLabel}</h2>
          <SessionForm initial={initial} courses={courseOptions} />
        </div>
      </Drawer>
    );
  } else if (typeof openId === "number") {
    const name = open ? pick(open.course.title, "et") : "";
    const label = open ? fill(t.drawer.editLabel, { name: `${name}, ${formatDate(open.startsAt, "et")}` }) : t.drawer.notFound;
    drawer = (
      <Drawer label={label} closeHref={href(past)} closeLabel={adminEt.common.close} returnFocus={`session-${openId}`}>
        <div className={styles.drawer}>
          {open ? (
            <>
              <h2 className={ui.h2}>{name}</h2>
              {/* the session's protocols (phase protocols, spec §4): one tap to the course day's screen; contact courses only (a row of
                  another course's session can be left from before its type was locked) */}
              {open.course.type === "contact" && (
                <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.protocols}`} href={`/admin/protokollid?sessioon=${open.id}`} data-session-protocols="">
                  {adminEt.protocols.open}
                </Link>
              )}
              <SessionForm
                key={open.id}
                initial={{ id: open.id, courseId: open.courseId, ...tallinnFormParts(open.startsAt), city: open.city, venue: open.venue, language: open.language, capacity: open.capacity, status: open.status }}
                courses={courseOptions}
                registrations={{ confirmed: open.confirmed, awaiting: open.awaiting }}
              />
            </>
          ) : (
            <p className={ui.empty}>{t.drawer.notFound}</p>
          )}
        </div>
      </Drawer>
    );
  }

  return (
    <>
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          {courses.length > 0 && (
            <Link id="add-session" className={ui.btn} href={href(past, "uus")} scroll={false} data-add-session="">
              {t.add} +
            </Link>
          )}
        </div>

        {courses.length === 0 && <p className={ui.notice}>{t.noCourses}</p>}
        {added && (
          <p className={ui.notice} role="status" data-flash="added">
            {t.added}
          </p>
        )}
        {one(sp.kustutatud) === "1" && (
          <p className={ui.notice} role="status" data-flash="deleted">
            {t.deleted}
          </p>
        )}

        <nav className={ui.filters} aria-label={t.whenLabel} data-when-filter="">
          <Link className={ui.pill} href={href(false)} aria-current={!past ? "true" : undefined}>
            {t.upcoming}
          </Link>
          <Link className={ui.pill} href={href(true)} aria-current={past ? "true" : undefined}>
            {t.past}
          </Link>
        </nav>

        <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
          {sessions.length === 0 ? (
            <p className={ui.empty}>{past ? t.emptyPast : t.empty}</p>
          ) : (
            <table className={`${ui.table} ${styles.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.date}</th>
                  <th scope="col">{t.col.course}</th>
                  <th scope="col">{t.col.place}</th>
                  <th scope="col">{t.col.language}</th>
                  <th scope="col">{t.col.seats}</th>
                  <th scope="col">{t.col.status}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const name = pick(s.course.title, "et");
                  const state = stateTag(s);
                  return (
                    <tr key={s.id} data-session-row={s.id} data-highlight={added === s.id ? "" : undefined} className={added === s.id ? styles.added : undefined}>
                      <td data-label={t.col.date} className={ui.nowrap}>
                        <span className={styles.when}>
                          <strong>{formatDate(s.startsAt, "et")}</strong>
                          <span className={`${ui.muted} ${styles.sub}`}>
                            {formatWeekday(s.startsAt, "et")} · {formatTime(s.startsAt, "et")}
                          </span>
                        </span>
                      </td>
                      <td data-label={t.col.course}>
                        <span className={styles.courseCell}>
                          <Link
                            id={`session-${s.id}`}
                            className={styles.name}
                            href={href(past, s.id)}
                            scroll={false}
                            aria-label={fill(t.edit, { name: `${name}, ${formatDate(s.startsAt, "et")}, ${s.city}` })}
                          >
                            {name}
                          </Link>
                          {!s.course.published && (
                            <span className={`${ui.tag} ${ui.warn}`} title={t.draftTitle}>
                              {t.draft}
                            </span>
                          )}
                        </span>
                      </td>
                      <td data-label={t.col.place}>
                        <span className={styles.when}>
                          <strong data-session-city="">{s.city}</strong>
                          {s.venue && <span className={`${ui.muted} ${styles.sub}`}>{s.venue}</span>}
                        </span>
                      </td>
                      <td data-label={t.col.language}>{s.language}</td>
                      <td data-label={t.col.seats}>
                        <span className={styles.when}>
                          <span>{fill(t.seats, { confirmed: s.confirmed, capacity: s.capacity })}</span>
                          <span className={`${ui.muted} ${styles.sub}`}>
                            {[
                              s.status === "scheduled" ? fill(t.left, { n: seatsLeft(s.capacity, s.taken) }) : "",
                              s.awaiting ? fill(t.awaiting, { n: s.awaiting }) : "",
                              s.waitlist ? fill(t.waitlist, { n: s.waitlist }) : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                      </td>
                      <td data-label={t.col.status}>
                        <span className={`${ui.tag} ${state.cls}`} data-session-state="">
                          {state.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {drawer}
    </>
  );
}
