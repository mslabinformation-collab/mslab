import type { Metadata } from "next";
import Link from "next/link";
import { Drawer } from "@/components/admin/Drawer";
import { ListRows } from "@/components/admin/ListRows";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill, type ListScope } from "@/components/admin/ListToolbar";
import listTable from "@/components/admin/list-table.module.css";
import { adminTitle } from "@/components/admin/sections";
import { NewSession, SessionDrawer } from "@/components/admin/SessionForm";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { countSessionRegistrations, listAdminSessions, listContactCourses, listSessionCities, sessionCounts, type AdminSessionRow, type SessionFilter } from "@/db/queries/admin";
import { startOfDayTallinn } from "@/domain/calendar";
import type { SessionFields } from "@/domain/session-fields";
import { seatsLeft } from "@/domain/sessions";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatDayShortMonth, formatTime, formatWeekday } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { readSession, type SessionValue } from "@/server/session-edit";
import styles from "./calendar.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.calendar) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
/** The drawer's fields of a stored session (server/session-edit.ts readSession's value without the status, which is not an autosaved field). */
const fieldsOf = (v: SessionValue): SessionFields => ({ courseId: v.courseId, date: v.date, time: v.time, city: v.city, venue: v.venue, language: v.language, capacity: v.capacity });
const parseId = (v: string | undefined) => (v && /^\d{1,10}$/.test(v) && Number(v) > 0 && Number(v) <= 2_147_483_647 ? Number(v) : null);

// Addresses (README B3, piece 3b Task 1): ?aeg=moodunud (the past sessions; none: the upcoming ones), ?koolitus=<course id> and ?linn=<city> (the two
// selects), ?id=<n> | uus (the drawer over the list). The drawer's close link, the pills and the add button keep the course and the city.
type View = {
  past: boolean;
  /** The course the list is limited to (a contact course that exists), or null. */
  koolitus: number | null;
  /** The city the list is limited to (one that has a session), or null. */
  linn: string | null;
};

function href(view: View, id?: number | "uus"): string {
  const q = new URLSearchParams();
  if (view.past) q.set("aeg", "moodunud");
  if (view.koolitus !== null) q.set("koolitus", String(view.koolitus));
  if (view.linn !== null) q.set("linn", view.linn);
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
 * Kalender (B3, the list; admin UX pass, piece 3b Task 1): the sessions of the contact courses, upcoming first (or the past ones), under ListToolbar's
 * course select, city select and the pills „Tulevased“ / „Möödunud“ with their counts (no search: the two selects are the filters). The table is the
 * shared list table and each row is a link as a whole (ListRows): the course is the real Link, a click anywhere else on the row is forwarded to it. A
 * row opens the session in a drawer (?id=<n>; components/admin/SessionForm.tsx SessionDrawer, which autosaves, piece 3b Task 3), „Lisa toimumine +“ a
 * new one (?id=uus, NewSession): its „Lisa toimumine“ creates it and the drawer goes on at ?id=<n>&lisatud=<n>, the row highlighted and „Toimumine
 * lisatud.“ in the drawer. Part 3 draws four columns (date and weekday | course and place | seats with a bar | state); below 760 px of the box (calendar.module.css
 * `.box`, as courses.module.css is for Koolitused; Part 4) the section loses its card and each row is a white card of its own: the day over the month, the
 * course, „{linn} · {koht}“ („{linn} · tühistatud“ of a cancelled session), the seat bar with „{k}/{cap}“. The seats are only the figure („3 / 4“,
 * on a phone „4/4“) and the bar, as Part 3 and Part 4 draw them (Dim, 25.10): the list no longer says „kinnitatud“, „Vabu kohti“, „ootab ettemaksu“ or
 * „Ootenimekirjas“ (the drawer's header and notice, Task 3, carry the waitlist and the registrations).
 */
export default async function CalendarAdminPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const rawId = one(sp.id);
  const openId = rawId === "uus" ? "uus" : parseId(rawId);
  const added = parseId(one(sp.lisatud));
  const db = getDb();
  const now = new Date();
  const [courses, cities] = await Promise.all([listContactCourses(db), listSessionCities(db)]);
  // the selects' choices are ones that exist (an old link to a removed course or a city without sessions lists everything)
  const koolitus = parseId(one(sp.koolitus));
  const linn = one(sp.linn);
  const view: View = {
    past: one(sp.aeg) === "moodunud",
    koolitus: koolitus !== null && courses.some((c) => c.id === koolitus) ? koolitus : null,
    linn: linn !== undefined && cities.includes(linn) ? linn : null,
  };
  const filter: SessionFilter = { courseId: view.koolitus ?? undefined, city: view.linn ?? undefined };
  const filtered = view.koolitus !== null || view.linn !== null;
  const [sessions, counts, [open], [stored, regs]] = await Promise.all([
    listAdminSessions(db, { from: startOfDayTallinn(now), upcoming: !view.past, ...filter }, now),
    sessionCounts(db, filter, now),
    // the drawer's session with its counts, also when it is in the other list (upcoming / past) or outside the selects' choice; its fields and version
    // as the autosave reads them (R-a), and its registrations as the rules count them (R-b)
    typeof openId === "number" ? listAdminSessions(db, { ids: [openId] }, now) : [],
    typeof openId === "number" ? Promise.all([readSession(db, openId), countSessionRegistrations(db, openId)]) : [null, null],
  ]);
  const t = adminEt.calendar;
  const courseOptions = courses.map((c) => ({ id: c.id, title: pick(c.title, "et"), published: c.published }));
  // the session's own course is always an option (even one that is no longer a contact course), so opening and saving
  // the form can never move the session to another course by default
  if (open && !courseOptions.some((c) => c.id === open.courseId))
    courseOptions.push({ id: open.course.id, title: pick(open.course.title, "et"), published: open.course.published });

  // The toolbar: each option goes to the list with that choice and the rest as it is (the time pill and the other select), from the top. The pills carry
  // the counts of the sessions each then shows, under the two selects.
  const scopes: ListScope[] = [
    {
      label: t.form.course,
      value: view.koolitus !== null ? String(view.koolitus) : "",
      params: ["koolitus"],
      options: [
        { value: "", label: t.allCourses, href: href({ ...view, koolitus: null }) },
        ...courses.map((c) => ({ value: String(c.id), label: pick(c.title, "et"), href: href({ ...view, koolitus: c.id }) })),
      ],
    },
    {
      label: t.form.city,
      value: view.linn ?? "",
      params: ["linn"],
      short: t.form.city,
      options: [{ value: "", label: t.allCities, href: href({ ...view, linn: null }) }, ...cities.map((c) => ({ value: c, label: c, href: href({ ...view, linn: c }) }))],
    },
  ];
  const pills: ListPill[] = [
    { label: t.upcoming, count: counts.upcoming, href: href({ ...view, past: false }), current: !view.past },
    { label: t.past, count: counts.past, href: href({ ...view, past: true }), current: view.past },
  ];

  let drawer: React.ReactNode = null;
  if (openId === "uus" && courses.length > 0) {
    drawer = (
      <Drawer label={t.drawer.newLabel} closeHref={href(view)} closeLabel={adminEt.common.close} returnFocus="add-session">
        <NewSession courses={courseOptions} listHref={href(view)} />
      </Drawer>
    );
  } else if (typeof openId === "number") {
    const name = open ? pick(open.course.title, "et") : "";
    const label = open ? fill(t.drawer.editLabel, { name: `${name}, ${formatDate(open.startsAt, "et")}` }) : t.drawer.notFound;
    drawer = (
      <Drawer label={label} closeHref={href(view)} closeLabel={adminEt.common.close} returnFocus={`session-${openId}`}>
        {open && stored && regs ? (
          <SessionDrawer
            key={open.id}
            id={open.id}
            version={stored.version}
            fields={fieldsOf(stored.value)}
            status={stored.value.status}
            counts={regs}
            waitlist={open.waitlist}
            title={name}
            when={formatDate(open.startsAt, "et")}
            contact={open.course.type === "contact"}
            courses={courseOptions}
            added={added === open.id}
          />
        ) : (
          <p className={ui.empty}>{t.drawer.notFound}</p>
        )}
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
            <Link id="add-session" className={ui.btn} href={href(view, "uus")} scroll={false} data-add-session="">
              {t.add} +
            </Link>
          )}
        </div>

        {courses.length === 0 && <p className={ui.notice}>{t.noCourses}</p>}
        {/* (a session just created from its drawer says it in the drawer: the page behind a modal drawer cannot be read) */}
        {added && added !== openId && (
          <p className={ui.notice} role="status" data-flash="added">
            {t.added}
          </p>
        )}
        {one(sp.kustutatud) === "1" && (
          <p className={ui.notice} role="status" data-flash="deleted">
            {t.deleted}
          </p>
        )}

        <ListToolbar scopes={scopes} pillRows={[{ label: t.whenLabel, pills }]} />

        <div className={styles.box}>
          <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
            <p className={`${ui.muted} ${ui.small} ${styles.count}`} data-calendar-count="">
              {fill(t.count, { n: sessions.length })}
            </p>
            {sessions.length === 0 ? (
              filtered ? (
                <ListEmpty things={t.things} filtered clearHref={href({ ...view, koolitus: null, linn: null })} />
              ) : (
                <p className={ui.empty} data-calendar-empty="">
                  {view.past ? t.emptyPast : t.empty}
                </p>
              )
            ) : (
              <ListRows>
                <table className={`${ui.table} ${listTable.table} ${styles.list}`}>
                  <thead>
                    <tr>
                      <th scope="col">{t.col.date}</th>
                      <th scope="col">{t.col.course}</th>
                      <th scope="col">{t.col.seats}</th>
                      <th scope="col">{t.col.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const name = pick(s.course.title, "et");
                      const state = stateTag(s);
                      const cancelled = s.status === "cancelled";
                      const full = !cancelled && seatsLeft(s.capacity, s.taken) === 0;
                      const day = formatDayShortMonth(s.startsAt, "et");
                      const filled = s.capacity > 0 ? Math.min(100, Math.round((s.confirmed / s.capacity) * 100)) : 0;
                      return (
                        <tr
                          key={s.id}
                          data-session-row={s.id}
                          data-highlight={added === s.id ? "" : undefined}
                          className={added === s.id ? styles.added : s.id === openId ? styles.selected : undefined}
                        >
                          <td data-label={t.col.date} className={`${ui.nowrap} ${styles.dateCell}`}>
                            <span className={styles.when}>
                              <strong>{formatDate(s.startsAt, "et")}</strong>
                              <span className={`${ui.muted} ${styles.sub}`}>
                                {formatWeekday(s.startsAt, "et")} {formatTime(s.startsAt, "et")}
                              </span>
                            </span>
                            {/* the phone card's date (the full one above stays for the screen reader) */}
                            <span className={styles.day} data-session-day="" aria-hidden="true">
                              <b>{day.day}</b>
                              <span>{day.month}</span>
                            </span>
                          </td>
                          <td data-label={t.col.course} className={styles.courseCell}>
                            <span className={styles.courseLine}>
                              <Link
                                id={`session-${s.id}`}
                                className={listTable.name}
                                href={href(view, s.id)}
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
                            <span className={cancelled ? `${styles.place} ${styles.placeApart}` : styles.place} data-session-place="">
                              {[s.city, s.venue].filter(Boolean).join(" · ")}
                            </span>
                            {cancelled && (
                              <span className={styles.placeCancelled} data-session-place-cancelled="">
                                {s.city} · {t.cancelledShort}
                              </span>
                            )}
                          </td>
                          <td data-label={t.col.seats} className={styles.seatsCell}>
                            <span className={styles.seats}>
                              <span className={styles.seatsLong} data-session-seats="">
                                {s.confirmed} / {s.capacity}
                              </span>
                              <span className={styles.bar} data-seats-bar="" data-full={full ? "" : undefined} aria-hidden="true">
                                <span style={{ width: `${filled}%` }} />
                              </span>
                              <span className={styles.seatsShort} data-seats-short="">
                                {s.confirmed}/{s.capacity}
                              </span>
                            </span>
                          </td>
                          <td data-label={t.col.status} className={styles.statusCell}>
                            <span className={`${ui.tag} ${state.cls}`} data-session-state="">
                              {state.text}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ListRows>
            )}
          </section>
        </div>
      </div>
      {drawer}
    </>
  );
}
