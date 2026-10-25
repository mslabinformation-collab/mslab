import Link from "next/link";
import type { NewsletterCampaign } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDayMonth, formatTime } from "@/i18n/format";
import { campaignValues, type Progress } from "@/server/newsletter-campaigns";
import { DeletedNotice, NewLetterButton, NewsletterCampaignEditor, type Audience, type CampaignEditorView, type TestTarget } from "./NewsletterCampaignEditor";
import ui from "./ui.module.css";
import styles from "./CampaignsPanel.module.css";

// The „Kirjad“ tab of „Uudiskiri“ (newsletter campaigns, Task 4; spec D4; the 20.10 design §3; admin UX pass piece 3b, Task 6: README B5, the Part 3 frame
// „B5 Uudiskiri“ and the Part 4 „B5 Kirjad“, piece3-texts P-12, P-13): a 300 px list on the left — „Uus kiri +“, then the letters (drafts first, then the
// sent ones and the one going out, the newest first; server/newsletter-campaigns.ts listCampaigns), each its name over its state line („Mustand · muudetud
// {dd.mm hh:mm}“, „Saadetud {dd.mm} · {n} tellijale“, „Saatmine pooleli · {sent} / {n}“) — and the editor of the one chosen (?kampaania=<id>) on the
// right: its fields, then a 380 px column of the preview and the sends. On a phone (below 900 px) the list is its own screen: a letter open hides it.
// A server component: the list is links; „Uus kiri +“, the list's „Mustand kustutatud.“ and the editor are the browser's parts.

const BASE = "/admin/uudiskiri?vaade=kampaaniad";
export const campaignListHref = (id: number) => `${BASE}&kampaania=${id}`;

/**
 * A row of the list: its name, its status, its last change (a draft) or its send (ISO), how many the send reached, and, for a letter going out, where
 * its deliveries stand.
 */
export type CampaignListRow = { id: number; name: string; status: CampaignEditorView["status"]; at: string; reached: number | null; progress: Progress | null };

/**
 * A stored letter as the editor shows it: its fields as strings ("" for none), its autosave version, what its send recorded, and, once it is no draft,
 * where its deliveries stand (`progress`) and whether the last batch was refused by Resend (`refused`); the page reads them (server/newsletter-campaigns.ts
 * campaignVersion, progressOf, sendRefused).
 */
export function campaignEditorView(
  row: NewsletterCampaign,
  read: { version: string; progress?: Progress | null; refused?: boolean },
): CampaignEditorView {
  return {
    id: row.id,
    status: row.status,
    values: campaignValues(row),
    version: read.version,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    recipients: row.recipients ?? null,
    progress: row.status === "draft" ? null : (read.progress ?? null),
    refused: row.status === "sending" && read.refused === true,
  };
}

/** The subscribers a send was for: the counts of its two languages. */
const reachedBy = (row: NewsletterCampaign): number | null => (row.status === "sent" && row.recipients ? row.recipients.et + row.recipients.ru : null);

export const campaignListRow = (row: NewsletterCampaign, progress: Progress | null = null): CampaignListRow => ({
  id: row.id,
  name: row.name,
  status: row.status,
  // a send's time; a draft's last change
  at: (row.status !== "draft" && row.sentAt ? row.sentAt : row.updatedAt).toISOString(),
  reached: reachedBy(row),
  progress: row.status === "sending" ? progress : null,
});

/** What a row says under its name (P-13): a draft's last change, a sent letter's day and count, a letter going out its mails that went of all. */
function rowLine(c: CampaignListRow): string {
  const t = adminEt.newsletter.campaigns.row;
  const d = new Date(c.at);
  if (c.status === "sent") return fill(t.sent, { date: formatDayMonth(d, "et"), n: c.reached ?? 0 });
  if (c.status === "sending") return fill(t.sending, { sent: c.progress?.sent ?? 0, n: c.progress?.total ?? 0 });
  return fill(t.draft, { date: `${formatDayMonth(d, "et")} ${formatTime(d, "et")}` });
}

export function CampaignsPanel({
  campaigns,
  selected,
  editing,
  notFound,
  links,
  testTargets,
  gated,
  audience,
}: {
  campaigns: CampaignListRow[];
  /** The letter chosen (?kampaania=): its id, or null for none. */
  selected: number | null;
  /** The chosen letter, as the editor shows it (null when none is chosen or it is not there). */
  editing: CampaignEditorView | null;
  /** ?kampaania= names a letter that is not there (deleted, or a link from elsewhere). */
  notFound: boolean;
  links: string[];
  /** The addresses „Saada proov“ offers. */
  testTargets: TestTarget[];
  /** The coming-soon gate is on (the page reads it: NewsletterCampaignEditor never reads the environment). */
  gated: boolean;
  /** Who „Saada kõigile ({n})“ goes to, as the page read it (B9, R-h). */
  audience: Audience;
}) {
  const t = adminEt.newsletter.campaigns;
  const open = editing !== null;
  return (
    <div className={styles.panel} data-campaigns="" data-open={open ? "" : undefined}>
      <section className={`${ui.card} ${styles.listCard}`} aria-label={t.list} data-campaigns-list="">
        <NewLetterButton />
        <DeletedNotice selected={selected} />
        {campaigns.length === 0 ? (
          <p className={ui.empty}>{t.empty}</p>
        ) : (
          <ul className={styles.list}>
            {campaigns.map((c) => (
              <li key={c.id} className={styles.row} data-campaign-row={c.id}>
                <Link className={styles.rowLink} href={campaignListHref(c.id)} aria-current={selected === c.id ? "page" : undefined}>
                  <span className={styles.rowName}>{c.name}</span>
                  <span className={`${styles.rowLine} ${styles[c.status]}`} data-campaign-row-line="" data-campaign-status={c.status}>
                    {rowLine(c)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(open || notFound) && (
        <div className={styles.work}>
          {notFound && (
            <p className={ui.notice} data-campaign-not-found="">
              {t.notFound}
            </p>
          )}
          {/* (keyed by the letter: its autosave starts from the page's read of it, and another letter is another editor) */}
          {editing && <NewsletterCampaignEditor key={editing.id} campaign={editing} links={links} testTargets={testTargets} gated={gated} audience={audience} />}
        </div>
      )}
    </div>
  );
}
