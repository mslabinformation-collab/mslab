import type { Metadata } from "next";
import Link from "next/link";
import { AdminIcon } from "@/components/admin/AdminIcon";
import { CampaignsPanel, campaignEditorView, campaignListRow } from "@/components/admin/CampaignsPanel";
import { getAdminCounts } from "@/components/admin/data";
import { NewsletterSync } from "@/components/admin/NewsletterSync";
import type { TestTarget } from "@/components/admin/NewsletterCampaignEditor";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb, type Db } from "@/db/client";
import { pageSubscribers } from "@/db/queries/admin";
import { normalizeEmail } from "@/domain/email";
import { parsePage } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import { getCampaign, listCampaigns } from "@/server/newsletter-campaigns";
import { syncState } from "@/server/newsletter-admin";
import { isSubscriberAddress, marketingConfigured, suppressedAddresses } from "@/server/resend-marketing";
import { adminMarketingDeps } from "@/server/send-deps";
import { linkSuggestions } from "@/server/site-links";
import styles from "./newsletter.module.css";

export const dynamic = "force-dynamic";
/**
 * „Sünkrooni Resendiga“, „Saada proov“ and „Saada kõigile“ are server actions of this page (admin-newsletter.ts), so they run under this page's limit.
 * The longest is the send: its sync up to ADMIN_SYNC_BUDGET_MS (25 s) for the calls it starts, one begun at the end with 8 s and once more after a
 * 429 (resend-marketing.ts), then two broadcasts, each with the same (SEND_LEASE_MS, about 35 s): some 77 s at worst. 120 s is our own guard (a
 * function may run up to 300 s on Vercel Hobby). (tests/db/newsletter-page.test.ts pins it.)
 */
export const maxDuration = 120;
export const metadata: Metadata = { title: adminTitle(adminEt.nav.newsletter) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

const stamp = (d: Date) => `${formatDate(d, "et")} ${formatTime(d, "et")}`;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const CAMPAIGNS_HREF = "/admin/uudiskiri?vaade=kampaaniad";

/**
 * „Uudiskiri“: two views. The subscribers (no ?vaade=): e-mail, language, consent time, confirmed or not (new sign-ups are confirmed at once; "not" is
 * a row of the old double opt-in that was never confirmed), newest first, and the CSV downloads (confirmed only — the addresses a newsletter may go
 * to — or all). 50 a page (?leht=); the CSV has all. Above the list the sync with Resend (newsletter campaigns, Task 3): „Sünkrooni Resendiga“ with
 * Resend's count beside the site's, or that it is not set up yet. A row whose address Resend does not mail (a bounce or a spam mark, spec D10) says
 * so; all the page's addresses are asked in one query.
 * „Kampaaniad“ (?vaade=kampaaniad, Task 4): the campaigns and the editor of the one chosen (&kampaania=<id>, or `uus`; components/admin/CampaignsPanel.tsx).
 */
export default async function NewsletterPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const search = await searchParams;
  return search.vaade === "kampaaniad" ? campaignsPage(email, one(search.kampaania)) : subscribersPage(email, search);
}

/** The page's heading and its two views. */
function Top({ view }: { view: "subscribers" | "campaigns" }) {
  const t = adminEt.newsletter;
  return (
    <>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{view === "campaigns" ? t.campaigns.title : t.title}</h1>
          <p className={ui.lead}>{view === "campaigns" ? t.campaigns.lead : t.lead}</p>
        </div>
        {view === "subscribers" && (
          <div className={styles.downloads}>
            <a className={ui.btn} href="/api/admin/subscribers.csv?kinnitatud=1" download data-csv="confirmed">
              {t.csvConfirmed}
              <AdminIcon name="arrow" />
            </a>
            <a className={`${ui.btn} ${ui.secondary}`} href="/api/admin/subscribers.csv" download data-csv="all">
              {t.csvAll}
            </a>
          </div>
        )}
      </div>
      <nav className={ui.filters} aria-label={t.viewsLabel} data-newsletter-views="">
        <Link className={ui.pill} href="/admin/uudiskiri" aria-current={view === "subscribers" ? "page" : undefined} data-view="subscribers">
          {t.views.subscribers}
        </Link>
        <Link className={ui.pill} href={CAMPAIGNS_HREF} aria-current={view === "campaigns" ? "page" : undefined} data-view="campaigns">
          {t.views.campaigns}
        </Link>
      </nav>
    </>
  );
}

/** The subscribers' view. (A function of the page, not a component: it reads.) */
async function subscribersPage(email: string, search: Search) {
  const db = getDb();
  const [list, counts, sync] = await Promise.all([pageSubscribers(db, parsePage(search.leht)), getAdminCounts(), syncState(adminMarketingDeps())]);
  const rows = list.rows;
  const blocked = await suppressedAddresses(db, rows.map((r) => r.email));
  const t = adminEt.newsletter;

  return (
    <Shell email={email} active="newsletter">
      <div className={ui.page}>
        <Top view="subscribers" />

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

/**
 * The addresses „Saada proov“ offers: Maria's (MARIA_EMAIL) and the signed-in admin's, one when they are the same, Maria's left out when it is not
 * set; each with whether it is a subscriber's (ruling R7: then the test carries her real unsubscribe link, and the editor warns).
 */
async function testTargetsOf(db: Db, mariaEmail: string, adminEmail: string): Promise<TestTarget[]> {
  const maria = normalizeEmail(mariaEmail);
  const me = normalizeEmail(adminEmail);
  const wanted: { key: TestTarget["key"]; address: string }[] = [...(maria ? [{ key: "maria" as const, address: maria }] : []), ...(me && me !== maria ? [{ key: "me" as const, address: me }] : [])];
  return Promise.all(wanted.map(async (w) => ({ ...w, subscriber: await isSubscriberAddress(db, w.address) })));
}

/** The campaigns' view: the list, and the editor of the one chosen (`kampaania`: an id, `uus` for a new one, or nothing). (It reads.) */
async function campaignsPage(email: string, kampaania: string) {
  const db = getDb();
  const deps = adminMarketingDeps();
  const configured = marketingConfigured(deps.env);
  const id = kampaania === "uus" ? null : parseRowId(kampaania);
  const [rows, links, chosen, testTargets] = await Promise.all([
    listCampaigns(db),
    linkSuggestions(db),
    id === null ? Promise.resolve(null) : getCampaign(db, id),
    configured ? testTargetsOf(db, deps.env.MARIA_EMAIL, email) : Promise.resolve([]),
  ]);
  const selected = kampaania === "uus" ? "new" : chosen ? chosen.id : null;

  return (
    <Shell email={email} active="newsletter">
      <div className={ui.page}>
        <Top view="campaigns" />
        <CampaignsPanel
          campaigns={rows.map(campaignListRow)}
          selected={selected}
          editing={chosen ? campaignEditorView(chosen) : null}
          notFound={kampaania !== "" && kampaania !== "uus" && chosen === null}
          configured={configured}
          testTargets={testTargets}
          links={links}
        />
      </div>
    </Shell>
  );
}
