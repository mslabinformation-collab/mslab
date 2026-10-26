import type { Metadata } from "next";
import { CampaignsPanel, campaignEditorView, campaignListRow } from "@/components/admin/CampaignsPanel";
import { LangSwitch } from "@/components/admin/EditLang";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill } from "@/components/admin/ListToolbar";
import type { TestTarget } from "@/components/admin/NewsletterCampaignEditor";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { TabPills } from "@/components/admin/TabPills";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { pageSubscribers, subscriberCounts } from "@/db/queries/admin";
import { normalizeEmail } from "@/domain/email";
import { parsePage } from "@/domain/paging";
import { PARAM_OF_STATE, subscriberFilterOf, type SubscriberState } from "@/domain/subscribers";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { gateOn } from "@/lib/site-gate";
import { requireAdmin } from "@/server/auth";
import { gateEnv, serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { campaignVersion, getCampaign, listCampaigns, progressOf, sendCountsNow, sendRefused } from "@/server/newsletter-campaigns";
import { linkSuggestions } from "@/server/site-links";
import styles from "./newsletter.module.css";

export const dynamic = "force-dynamic";
/**
 * „Saada kõigile“, „Peata saatmine“ and „Saada proov“ are server actions of this page (actions/admin-newsletter.ts), so they run under this page's
 * limit. The longest is the press: its first batch sends for PRESS_BUDGET_MS (60 s), and a send begun at its end has 8 s, and once more after a 429
 * (notify.ts): some 77 s at worst with its queries. 120 s is our own guard (a function may run up to 300 s on Vercel Hobby).
 * (tests/db/newsletter-page.test.ts pins it.)
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
 * a row of the old double opt-in that was never confirmed), newest first, under the search of an address and the pills „Kinnitatud“ / „Ootab kinnitust“
 * with their counts (?otsi=, ?olek=), and „Laadi alla (CSV)“ of that filter. 50 a page (?leht=); the CSV has all the rows the filter finds.
 * „Kirjad“ (?vaade=kampaaniad, the address kept: README B5): the letters and the editor of the one chosen (&kampaania=<id>; components/admin/CampaignsPanel.tsx).
 * The two views are tabs („Tellijad“ | „Kirjad“, TabPills).
 */
export default async function NewsletterPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const search = await searchParams;
  return search.vaade === "kampaaniad" ? campaignsPage(email, one(search.kampaania)) : subscribersPage(search);
}

/** The two views as tabs (README B5: „Tellijad“ | „Kirjad“; every tab a page of its own). */
function Views({ view }: { view: "subscribers" | "campaigns" }) {
  const t = adminEt.newsletter;
  return (
    <TabPills
      label={t.viewsLabel}
      tabs={[
        { href: "/admin/uudiskiri", label: t.views.subscribers, current: view === "subscribers" },
        { href: CAMPAIGNS_HREF, label: t.views.campaigns, current: view === "campaigns" },
      ]}
    />
  );
}

/** The filter of a Tellijad view as address parameters: its search (?otsi=) and its state (?olek=); nothing for what is not chosen. */
function filterParams(view: { otsi: string; state: SubscriberState | undefined }): URLSearchParams {
  const q = new URLSearchParams();
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.state) q.set("olek", PARAM_OF_STATE[view.state]);
  return q;
}

/** The address of a Tellijad view: its filter and its page (?leht=, 50 a page). */
function subscribersHref(view: { otsi: string; state: SubscriberState | undefined; leht?: number }): string {
  const q = filterParams(view);
  if (view.leht && view.leht > 1) q.set("leht", String(view.leht));
  const s = q.toString();
  return `/admin/uudiskiri${s ? `?${s}` : ""}`;
}

/** The CSV of the same view: the filter, not the page (the file has every row the filter finds). */
function subscribersCsvHref(view: { otsi: string; state: SubscriberState | undefined }): string {
  const s = filterParams(view).toString();
  return `/api/admin/subscribers.csv${s ? `?${s}` : ""}`;
}

/**
 * The subscribers' view (README B5, piece3-texts P-13). (A function of the page, not a component: it reads.) ListToolbar with the search of an address
 * (?otsi=, a part of it; the query matches it literally) and the pills „Kinnitatud“ / „Ootab kinnitust“ with their counts (?olek=), drawn without „Kõik“:
 * everyone is listed until a pill is pressed, and a pressed pill toggles off. The counts are the rows each pill shows under the search, every row
 * counted, sample addresses too (ruling R-h: only the send leaves them out). „Laadi alla (CSV)“ is the file of the view on the screen: the same search
 * and state go to api/admin/subscribers.csv, which reads them with the same domain/subscribers.ts subscriberFilterOf, so the file holds the rows the list
 * shows, all of them. The count line keeps its words („Tellijaid: {n}, neist kinnitatud {confirmed}“), now of the rows shown.
 */
async function subscribersPage(search: Search) {
  const db = getDb();
  const filter = subscriberFilterOf(search);
  const view = { otsi: filter.search, state: filter.state };
  const [list, counts] = await Promise.all([pageSubscribers(db, filter, parsePage(search.leht)), subscriberCounts(db, filter)]);
  const rows = list.rows;
  const t = adminEt.newsletter;
  const filtered = view.otsi !== "" || view.state !== undefined;
  // each pill goes to the list with that pill chosen and the search kept, from page 1; the chosen pill goes to the list without it
  const pills: ListPill[] = ([
    { key: "confirmed", label: t.col.confirmed },
    { key: "pending", label: t.pending },
  ] as const).map((p) => ({
    href: subscribersHref({ ...view, state: view.state === p.key ? undefined : p.key }),
    label: p.label,
    count: counts[p.key],
    current: view.state === p.key,
  }));

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={styles.downloads}>
          <a className={`${ui.btn} ${ui.secondary}`} href={subscribersCsvHref(view)} download data-csv="">
            {t.csvDownload}
          </a>
        </div>
      </div>
      <Views view="subscribers" />

      <ListToolbar placeholder={t.searchPlaceholder} pillRows={[{ label: t.statusLabel, pills }]} />

      <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
        <p className={`${ui.muted} ${ui.small}`}>{fill(t.count, { n: list.total, confirmed: view.state === "pending" ? 0 : counts.confirmed })}</p>
        {rows.length === 0 ? (
          <ListEmpty things={t.things} filtered={filtered} search={view.otsi} clearHref="/admin/uudiskiri" />
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
                    {r.email}
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
        <Pager info={list} href={(n) => subscribersHref({ ...view, leht: n })} />
      </section>
    </div>
  );
}

/**
 * The addresses „Saada proov“ offers: Maria's (MARIA_EMAIL) and the signed-in admin's, one when they are the same, Maria's left out when it is not set
 * (actions/admin-newsletter.ts sendTestAction takes the address from the same two sources, never from the browser).
 */
function testTargetsOf(mariaEmail: string, adminEmail: string): TestTarget[] {
  const maria = normalizeEmail(mariaEmail);
  const me = normalizeEmail(adminEmail);
  return [...(maria ? [{ key: "maria" as const, address: maria }] : []), ...(me && me !== maria ? [{ key: "me" as const, address: me }] : [])];
}

/**
 * The letters' view (README B5; the Part 3 frame „B5 Uudiskiri“): the eyebrow „Uudiskiri“, the H1 „Kirjad“ and the tabs at its right (no lead: none is
 * drawn); the list (each letter going out with its progress), and the editor of the one chosen (`kampaania`: an id, or nothing; the old `uus` is
 * nothing now, „Uus kiri +“ makes its draft at once), which once it is no draft carries where its deliveries stand and whether the last batch was refused.
 * While a letter is open the heading has the page's ET | RU switch for its fields and its preview. A draft's „Saada kõigile ({n})“ is given the count of
 * the confirmed subscribers as read now, without the press's lock (B9, ruling R-h: server/newsletter-campaigns.ts sendCountsNow; the panel reads it again
 * under the lock). (It reads.) `gated`: the coming-soon gate is on (SITE_GATE, read as the middleware reads it), so the panel of „Saada kõigile“ and the
 * result of „Saada proov“ say that the mail's links open „Tulekul“ (final review I1); the editor, a browser component, never reads the environment.
 * On a phone (below 900 px) an open letter is a screen of its own: the H1 and the tabs give way to its „← Kirjad“ (newsletter.module.css).
 */
async function campaignsPage(email: string, kampaania: string) {
  const db = getDb();
  const id = kampaania === "" || kampaania === "uus" ? null : parseRowId(kampaania);
  const [rows, links, chosen] = await Promise.all([listCampaigns(db), linkSuggestions(db), id === null ? Promise.resolve(null) : getCampaign(db, id)]);
  // the deliveries of every letter going out (one at a time, by the design) and of the one chosen, if it is no draft
  const shown = new Set([...rows.filter((r) => r.status === "sending").map((r) => r.id), ...(chosen && chosen.status !== "draft" ? [chosen.id] : [])]);
  const progress = new Map(await Promise.all([...shown].map(async (campaignId) => [campaignId, await progressOf(db, campaignId)] as const)));
  const refused = chosen?.status === "sending" ? await sendRefused(serverKv(), chosen.id) : false;
  const audience = chosen?.status === "draft" ? await sendCountsNow(db) : { et: 0, ru: 0, samples: 0 };
  const t = adminEt.newsletter;

  return (
    <div className={ui.page} data-letter-open={chosen ? "" : undefined}>
      <div className={`${ui.heading} ${styles.lettersHeading}`}>
        <div className={styles.lettersTitle}>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.campaigns.title}</h1>
        </div>
        <div className={`${ui.headAside} ${styles.lettersAside}`}>
          <div className={styles.lettersTabs}>
            <Views view="campaigns" />
          </div>
          {chosen && <LangSwitch />}
        </div>
      </div>
      <CampaignsPanel
        campaigns={rows.map((r) => campaignListRow(r, progress.get(r.id) ?? null))}
        selected={chosen ? chosen.id : null}
        editing={chosen ? campaignEditorView(chosen, { version: await campaignVersion(chosen), progress: progress.get(chosen.id) ?? null, refused }) : null}
        notFound={id !== null && chosen === null}
        links={links}
        testTargets={testTargetsOf(serverEnv().MARIA_EMAIL, email)}
        gated={gateOn(gateEnv().SITE_GATE)}
        audience={audience}
      />
    </div>
  );
}
