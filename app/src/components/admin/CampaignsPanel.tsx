import Link from "next/link";
import type { NewsletterCampaign } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import type { Progress } from "@/server/newsletter-campaigns";
import { NewsletterCampaignEditor, type CampaignEditorView, type TestTarget } from "./NewsletterCampaignEditor";
import ui from "./ui.module.css";
import styles from "./CampaignsPanel.module.css";

// The „Kampaaniad“ tab of „Uudiskiri“ (newsletter campaigns, Task 4; spec D4; the 20.10 design §3): the campaigns (drafts first, then the sent ones and
// the one going out, the newest first; server/newsletter-campaigns.ts listCampaigns) each with its state and, for the one going out, its progress
// („Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval.“), „Uus kampaania“, and the editor of the one chosen (?kampaania=<id>, or `uus`).
// A server component: the list is links; the editor (NewsletterCampaignEditor) is the browser's part.

const BASE = "/admin/uudiskiri?vaade=kampaaniad";
export const campaignListHref = (id: number | "new") => `${BASE}&kampaania=${id === "new" ? "uus" : id}`;

/**
 * A row of the list: its name, its status, its last change (a draft) or its send (ISO), how many the send reached, and, for a campaign going out,
 * where its deliveries stand.
 */
export type CampaignListRow = { id: number; name: string; status: CampaignEditorView["status"]; at: string; reached: number | null; progress: Progress | null };

const both = (v: { et: string; ru?: string } | null) => ({ et: v?.et ?? "", ru: v?.ru ?? "" });

/**
 * A stored campaign as the editor shows it: its fields as strings ("" for none), what its send recorded, and, once it is no draft, where its deliveries
 * stand (`progress`) and whether the last batch was refused by Resend (`refused`); the page reads both (server/newsletter-campaigns.ts progressOf, sendRefused).
 */
export function campaignEditorView(row: NewsletterCampaign, delivery: { progress: Progress | null; refused: boolean } = { progress: null, refused: false }): CampaignEditorView {
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
    updatedAt: row.updatedAt.toISOString(),
    recipients: row.recipients ?? null,
    progress: row.status === "draft" ? null : delivery.progress,
    refused: row.status === "sending" && delivery.refused,
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

// (a campaign going out is the routine state of a big one: the plain tag, never the red of an error)
const STATUS_TAG: Record<CampaignListRow["status"], string> = { draft: ui.warn, sending: "", sent: ui.ok };
const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${formatDate(d, "et")} ${formatTime(d, "et")}`;
};

/** What a row says under its name: the send's line (sent), the progress (going out), or the last change (a draft). */
function rowLine(c: CampaignListRow): string {
  const t = adminEt.newsletter.campaigns;
  if (c.status === "sent" && c.reached !== null) return fill(t.sentLine, { date: stamp(c.at), n: c.reached });
  if (c.status === "sending" && c.progress) return fill(t.progress, { sent: c.progress.sent, n: c.progress.total, left: c.progress.waiting });
  return fill(t.changed, { date: stamp(c.at) });
}

export function CampaignsPanel({
  campaigns,
  selected,
  editing,
  notFound,
  links,
  testTargets,
  gated,
}: {
  campaigns: CampaignListRow[];
  /** The campaign chosen (?kampaania=): its id, "new" for „Uus kampaania“, or null for none. */
  selected: number | "new" | null;
  /** The chosen campaign, as the editor shows it (null for a new one, or when none is chosen or it is not there). */
  editing: CampaignEditorView | null;
  /** ?kampaania= names a campaign that is not there (deleted, or a link from elsewhere). */
  notFound: boolean;
  links: string[];
  /** The addresses „Saada proov“ offers. */
  testTargets: TestTarget[];
  /** The coming-soon gate is on (the page reads it: NewsletterCampaignEditor never reads the environment). */
  gated: boolean;
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
                <span className={`${ui.muted} ${ui.small} ${styles.rowLine}`} data-campaign-row-line="">
                  {rowLine(c)}
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
      {(selected === "new" || editing) && <NewsletterCampaignEditor campaign={editing} links={links} testTargets={testTargets} gated={gated} />}
    </div>
  );
}
