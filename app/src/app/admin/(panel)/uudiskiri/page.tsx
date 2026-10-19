import type { Metadata } from "next";
import { AdminIcon } from "@/components/admin/AdminIcon";
import { getAdminCounts } from "@/components/admin/data";
import { NewsletterSync } from "@/components/admin/NewsletterSync";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { pageSubscribers } from "@/db/queries/admin";
import { normalizeEmail } from "@/domain/email";
import { parsePage } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { syncState } from "@/server/newsletter-admin";
import { suppressedAddresses } from "@/server/resend-marketing";
import { adminMarketingDeps } from "@/server/send-deps";
import styles from "./newsletter.module.css";

export const dynamic = "force-dynamic";
/**
 * „Sünkrooni Resendiga“ is a server action of this page (fullSyncAction), so its sync runs under this page's limit: up to ADMIN_SYNC_BUDGET_MS (25 s)
 * for the calls it starts, and one begun at the end has 8 s, and once more after a 429 (resend-marketing.ts). 60 s is our own guard, as the daily
 * sweep's (a function may run up to 300 s on Vercel Hobby). (tests/db/newsletter-page.test.ts pins it.)
 */
export const maxDuration = 60;
export const metadata: Metadata = { title: adminTitle(adminEt.nav.newsletter) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const stamp = (d: Date) => `${formatDate(d, "et")} ${formatTime(d, "et")}`;

/**
 * Newsletter subscribers: e-mail, language, consent time, confirmed or not (new sign-ups are confirmed at once; "not" is a row of the old
 * double opt-in that was never confirmed), newest first, and the CSV
 * downloads (confirmed only — the addresses a newsletter may go to — or all). 50 a page (?leht=); the CSV has all.
 * Above the list the sync with Resend (newsletter campaigns, Task 3): „Sünkrooni Resendiga“ with Resend's count beside the site's, or that it is not set
 * up yet. A row whose address Resend does not mail (a bounce or a spam mark, spec D10) says so; all the page's addresses are asked in one query.
 */
export default async function NewsletterPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const db = getDb();
  const [list, counts, sync] = await Promise.all([pageSubscribers(db, parsePage((await searchParams).leht)), getAdminCounts(), syncState(adminMarketingDeps())]);
  const rows = list.rows;
  const blocked = await suppressedAddresses(db, rows.map((r) => r.email));
  const t = adminEt.newsletter;

  return (
    <Shell email={email} active="newsletter">
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          <div className={styles.downloads}>
            <a className={ui.btn} href="/api/admin/subscribers.csv?kinnitatud=1" download data-csv="confirmed">
              {t.csvConfirmed}
              <AdminIcon name="arrow" />
            </a>
            <a className={`${ui.btn} ${ui.secondary}`} href="/api/admin/subscribers.csv" download data-csv="all">
              {t.csvAll}
            </a>
          </div>
        </div>

        <section className={`${ui.card} ${styles.sync}`} aria-label={t.sync.button} data-newsletter-sync="">
          <NewsletterSync state={sync} />
        </section>

        <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small}`}>{fill(t.count, { n: counts.subscribers, confirmed: counts.confirmedSubscribers })}</p>
          {rows.length === 0 ? (
            <p className={ui.empty}>{t.empty}</p>
          ) : (
            <table className={`${ui.table} ${styles.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.email}</th>
                  <th scope="col">{t.col.locale}</th>
                  <th scope="col">{t.col.consent}</th>
                  <th scope="col">{t.col.confirmed}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-subscriber={r.id}>
                    <td data-label={t.col.email} className={styles.email}>
                      <div>
                        {r.email}
                        {blocked.has(normalizeEmail(r.email)) && (
                          <p className={styles.blocked} data-subscriber-suppressed="">
                            {t.suppressed}
                          </p>
                        )}
                      </div>
                    </td>
                    <td data-label={t.col.locale}>{r.locale === "ru" ? adminEt.common.locale.ru : adminEt.common.locale.et}</td>
                    <td data-label={t.col.consent} className={ui.nowrap}>
                      {stamp(r.consentAt)}
                    </td>
                    <td data-label={t.col.confirmed}>
                      {r.confirmedAt ? (
                        <span className={`${ui.tag} ${ui.ok}`}>{stamp(r.confirmedAt)}</span>
                      ) : (
                        <span className={`${ui.tag} ${ui.warn}`}>{t.pending}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager info={list} href={(n) => `/admin/uudiskiri${n > 1 ? `?leht=${n}` : ""}`} />
        </section>
      </div>
    </Shell>
  );
}
