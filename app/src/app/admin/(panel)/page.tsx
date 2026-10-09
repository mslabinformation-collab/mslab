import type { Metadata } from "next";
import Link from "next/link";
import { AdminIcon, type AdminIconName } from "@/components/admin/AdminIcon";
import { getAdminCounts } from "@/components/admin/data";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listUpcomingSessions } from "@/db/queries/public";
import { startOfDayTallinn } from "@/domain/calendar";
import { seatsLeft } from "@/domain/sessions";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatLongDate } from "@/i18n/format";
import { adminName, requireAdmin } from "@/server/auth";
import styles from "./overview.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.overview) };

const DAY = 24 * 60 * 60_000;
/** Rows of the "Tulevased koolitused" table. */
const UPCOMING_ROWS = 5;

/**
 * Overview (prototype B `adminHome()`): greeting, the four numbers Maria acts on (registrations waiting for their
 * prepayment, open requests, sessions in the next 30 days, confirmed newsletter subscribers), the next sessions, the
 * open requests per kind and quick links.
 */
export default async function Overview() {
  const email = await requireAdmin();
  const name = adminName(email);
  const now = new Date();
  const [counts, sessions] = await Promise.all([getAdminCounts(), listUpcomingSessions(getDb(), startOfDayTallinn(now))]);
  const scheduled = sessions.filter((s) => s.status === "scheduled");
  const soon = scheduled.filter((s) => s.startsAt.getTime() < now.getTime() + 30 * DAY).length;
  const open = counts.openRequests;
  const openTotal = Object.values(open).reduce((a, b) => a + b, 0);
  const t = adminEt.overview;
  const tabs = adminEt.requests.tabs;

  const stats: { key: string; n: number; label: string; href: string }[] = [
    { key: "awaiting", n: counts.awaitingPrepayment, label: t.stats.awaiting, href: "/admin/registreerimised?staatus=ootab" },
    { key: "requests", n: openTotal, label: t.stats.requests, href: "/admin/paringud" },
    { key: "sessions", n: soon, label: t.stats.sessions, href: "/admin/kalender" },
    { key: "subscribers", n: counts.confirmedSubscribers, label: t.stats.subscribers, href: "/admin/uudiskiri" },
  ];
  const inbox: { key: string; label: string; n: number; href: string; icon: AdminIconName }[] = [
    { key: "contact", label: tabs.kontakt, n: open.contact - counts.openPurchaseInterest, href: "/admin/paringud?liik=kontakt", icon: "mail" },
    { key: "interest", label: adminEt.requests.interest, n: counts.openPurchaseInterest, href: "/admin/paringud?liik=kontakt", icon: "book" },
    { key: "individual", label: tabs.individuaal, n: open.individual, href: "/admin/paringud?liik=individuaal", icon: "user" },
    { key: "practice", label: tabs.praktika, n: open.practice, href: "/admin/paringud?liik=praktika", icon: "flower" },
    { key: "waitlist", label: tabs.ootenimekiri, n: open.waitlist, href: "/admin/paringud?liik=ootenimekiri", icon: "calendar" },
  ];

  return (
    <Shell email={email} active="overview">
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{formatLongDate(now, "et")}</p>
            <h1 className={ui.h1}>{name ? fill(adminEt.panel.hello, { name }) : adminEt.panel.helloNoName}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          <Link className={ui.btn} href="/admin/registreerimised">
            {t.primary}
            <AdminIcon name="arrow" />
          </Link>
        </div>

        <ul className={`${ui.stats} ${styles.stats}`}>
          {stats.map((s) => (
            <li key={s.key}>
              <Link className={ui.stat} href={s.href} data-stat={s.key}>
                <strong className={ui.statNumber}>{s.n}</strong>
                <span className={ui.statLabel}>{s.label}</span>
                <span className={ui.statMore} aria-hidden="true">
                  {t.more} ↗
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <div className={ui.columns}>
          <section className={ui.card} aria-labelledby="upcoming-title">
            <div className={ui.cardHead}>
              <h2 id="upcoming-title" className={ui.h2}>
                {t.upcoming.title}
              </h2>
              <Link className={ui.link} href="/admin/kalender">
                {t.upcoming.calendar}
              </Link>
            </div>
            {scheduled.length === 0 ? (
              <p className={ui.empty}>{t.upcoming.empty}</p>
            ) : (
              <div className={ui.tableWrap}>
                <table className={`${ui.table} ${styles.upcoming}`}>
                  <thead>
                    <tr>
                      <th scope="col">{t.upcoming.course}</th>
                      <th scope="col">{t.upcoming.date}</th>
                      <th scope="col">{t.upcoming.city}</th>
                      <th scope="col">{t.upcoming.seats}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduled.slice(0, UPCOMING_ROWS).map((s) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{pick(s.course.title, "et")}</strong>
                        </td>
                        <td className={ui.nowrap}>{formatDate(s.startsAt, "et")}</td>
                        <td>{s.city}</td>
                        <td>
                          {seatsLeft(s.capacity, s.taken)} / {s.capacity}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className={ui.stack}>
            <section className={ui.card} aria-labelledby="inbox-title">
              <h2 id="inbox-title" className={ui.h2}>
                {t.inbox.title}
              </h2>
              <ul className={ui.rows}>
                {inbox.map((row) => (
                  <li key={row.key}>
                    <Link className={ui.row} href={row.href} data-inbox={row.key}>
                      <AdminIcon name={row.icon} />
                      <span className={ui.rowLabel}>{row.label}</span>
                      <span className={`${ui.tag} ${row.n > 0 ? ui.warn : ""}`}>{row.n > 0 ? fill(t.inbox.open, { n: row.n }) : t.inbox.done}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className={ui.card} aria-labelledby="links-title">
              <h2 id="links-title" className={ui.h2}>
                {t.links.title}
              </h2>
              <ul className={ui.rows}>
                <li>
                  <Link className={ui.row} href="/admin/uudiskiri">
                    <AdminIcon name="mail" />
                    <span className={ui.rowLabel}>{t.links.newsletter}</span>
                  </Link>
                </li>
                <li>
                  <a className={ui.row} href="/api/admin/subscribers.csv?kinnitatud=1" download>
                    <AdminIcon name="arrow" />
                    <span className={ui.rowLabel}>{t.links.csv}</span>
                  </a>
                </li>
                <li>
                  {/* The home page through the coming-soon gate, like the sidebar's and the top line's links: api/admin/preview
                      gives this admin the preview cookie, then opens "/" (a plain <a>: it is an API route, not a page). */}
                  <a className={ui.row} href="/api/admin/preview" target="_blank" rel="noopener">
                    <AdminIcon name="up" />
                    <span className={ui.rowLabel}>
                      {t.links.site} <span aria-hidden="true">↗</span>
                      <span className={ui.sr}> ({adminEt.shell.newWindow})</span>
                    </span>
                  </a>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
