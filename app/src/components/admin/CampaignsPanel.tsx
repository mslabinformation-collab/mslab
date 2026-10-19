import Link from "next/link";
import type { NewsletterCampaign } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { NewsletterCampaignEditor, type CampaignEditorView, type TestTarget } from "./NewsletterCampaignEditor";
import ui from "./ui.module.css";
import styles from "./CampaignsPanel.module.css";

// The „Kampaaniad“ tab of „Uudiskiri“ (newsletter campaigns, Task 4; spec D4, D6): the campaigns (drafts first, then the sent ones, the newest first;
// server/newsletter-campaigns.ts listCampaigns), „Uus kampaania“, and the editor of the one chosen (?kampaania=<id>, or `uus`). A server component:
// the list is links; the editor (NewsletterCampaignEditor) is the browser's part.

const BASE = "/admin/uudiskiri?vaade=kampaaniad";
export const campaignListHref = (id: number | "new") => `${BASE}&kampaania=${id === "new" ? "uus" : id}`;

/** A row of the list: its name, its status, its last change (a draft) or its send (ISO), and how many the send reached. */
export type CampaignListRow = { id: number; name: string; status: CampaignEditorView["status"]; at: string; reached: number | null };

const both = (v: { et: string; ru?: string } | null) => ({ et: v?.et ?? "", ru: v?.ru ?? "" });

/** A stored campaign as the editor shows it: its fields as strings ("" for none), and what its send recorded. */
export function campaignEditorView(row: NewsletterCampaign): CampaignEditorView {
  return {
    id: row.id,
    status: row.status,
    values: {
      name: row.name,
      subject: both(row.subject),
      preheader: both(row.preheader),
      imageKey: row.imageKey ?? "",
      body: both(row.body),
      code: row.code ?? "",
      buttonLabel: both(row.buttonLabel),
      buttonHref: row.buttonHref ?? "",
    },
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    recipients: row.recipients ?? null,
    broadcasts: row.broadcasts ?? null,
  };
}

/** The subscribers a send reached: the counts of the languages whose broadcast went. */
const reachedBy = (row: NewsletterCampaign): number | null => {
  if (row.status !== "sent" || !row.recipients) return null;
  const went = row.broadcasts ?? {};
  return (went.et ? row.recipients.et : 0) + (went.ru ? row.recipients.ru : 0);
};

export const campaignListRow = (row: NewsletterCampaign): CampaignListRow => ({
  id: row.id,
  name: row.name,
  status: row.status,
  at: (row.status === "sent" && row.sentAt ? row.sentAt : row.updatedAt).toISOString(),
  reached: reachedBy(row),
});

const STATUS_TAG: Record<CampaignListRow["status"], string> = { draft: ui.warn, sending: ui.bad, sent: ui.ok };
const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${formatDate(d, "et")} ${formatTime(d, "et")}`;
};

export function CampaignsPanel({
  campaigns,
  selected,
  editing,
  notFound,
  configured,
  testTargets,
  links,
}: {
  campaigns: CampaignListRow[];
  /** The campaign chosen (?kampaania=): its id, "new" for „Uus kampaania“, or null for none. */
  selected: number | "new" | null;
  /** The chosen campaign, as the editor shows it (null for a new one, or when none is chosen or it is not there). */
  editing: CampaignEditorView | null;
  /** ?kampaania= names a campaign that is not there (deleted, or a link from elsewhere). */
  notFound: boolean;
  configured: boolean;
  testTargets: TestTarget[];
  links: string[];
}) {
  const t = adminEt.newsletter.campaigns;
  return (
    <div className={styles.panel} data-campaigns="">
      <section className={ui.card} aria-label={t.list} data-campaigns-list="">
        <div className={styles.listHead}>
          <h2 className={ui.h3}>{t.list}</h2>
          <Link className={`${ui.btn} ${ui.smallBtn}`} href={campaignListHref("new")} aria-current={selected === "new" ? "page" : undefined} data-campaign-new="">
            {t.new}
          </Link>
        </div>
        {campaigns.length === 0 ? (
          <p className={ui.empty}>{t.empty}</p>
        ) : (
          <ul className={styles.list}>
            {campaigns.map((c) => (
              <li key={c.id} className={styles.row} data-campaign-row={c.id}>
                <Link className={styles.rowLink} href={campaignListHref(c.id)} aria-current={selected === c.id ? "page" : undefined}>
                  {c.name}
                </Link>
                <span className={`${ui.tag} ${STATUS_TAG[c.status]}`} data-campaign-status={c.status}>
                  {t.status[c.status]}
                </span>
                <span className={`${ui.muted} ${ui.small}`}>
                  {c.status === "sent" && c.reached !== null ? fill(t.sentLine, { date: stamp(c.at), n: c.reached }) : fill(t.changed, { date: stamp(c.at) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {notFound && (
        <p className={ui.notice} data-campaign-not-found="">
          {t.notFound}
        </p>
      )}
      {/* (no key: the editor follows another campaign itself, and keeps its state when the page comes back with the one it has just saved) */}
      {(selected === "new" || editing) && <NewsletterCampaignEditor campaign={editing} configured={configured} testTargets={testTargets} links={links} />}
    </div>
  );
}
