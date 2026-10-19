"use client";

import { useState, useTransition } from "react";
import { CONTACTS_WARN_AT, RESEND_FREE_CONTACTS } from "@/domain/newsletter-campaign";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { fullSyncAction } from "@/server/actions/admin-newsletter";
import type { SyncState } from "@/server/newsletter-admin";
import type { FullSyncReport } from "@/server/resend-marketing";
import ui from "./ui.module.css";
import styles from "./NewsletterSync.module.css";

type Answer = { kind: "report"; report: FullSyncReport } | { kind: "error"; code: keyof typeof adminEt.newsletter.sync.errors };

/**
 * The sync with Resend above Maria's „Uudiskiri“ list (newsletter campaigns Task 3, spec D2, D8, §5). Without the newsletter's key only
 * „Resendi uudiskirja saatmine pole veel seadistatud.“; the list and the CSV are not its business. With it:
 * - Resend's own count of the account's contacts against the free plan's 1000, beside the site's count of the subscribers it has synced (the site's
 *   alone when Resend does not answer);
 * - the warning from CONTACTS_WARN_AT (900) contacts, and the limit line once the plan is full and subscribers have no contact, both on the larger
 *   of the two counts, so that Maria sees the real number;
 * - „Sünkrooni Resendiga“, one press at a time. The answer stays until the page is left: the report in one line, with a line each for the addresses
 *   Resend blocks, the contacts that failed and the addresses Resend refused (ruling R17; only when there are some), the plan's limit (from the
 *   report: its number of subscribers left out),
 *   and „Sünkroonimine jätkub järgmisel korral.“ when the time ran out; or the refusal in words (the key that can only send is told apart from Resend
 *   being down; another sync running is „juba käib“). When Resend's count already refused the key, the page says so before any press.
 *   A sync that ran refreshes the page (the action), and this component stays, so the answer stays with the new counts.
 */
export function NewsletterSync({ state }: { state: SyncState }) {
  const t = adminEt.newsletter.sync;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [pending, start] = useTransition();
  if (!state.configured) {
    return (
      <div className={styles.sync}>
        <p className={ui.notice} data-sync-off="">
          {t.off}
        </p>
      </div>
    );
  }

  const run = () => {
    if (pending) return;
    setAnswer(null);
    start(async () => {
      try {
        const r = await fullSyncAction();
        setAnswer("error" in r ? { kind: "error", code: r.error } : { kind: "report", report: r });
      } catch {
        // the action could not be reached at all (the network)
        setAnswer({ kind: "error", code: "server" });
      }
    });
  };

  // the real number: the larger of Resend's count (the account's, the plan's) and the site's own
  const used = Math.max(state.resend ?? 0, state.site);
  // what the last press answered; before any press, the key's refusal the page already knows from Resend's count (a key that can only send)
  const shown: Answer | null = answer ?? (state.refused ? { kind: "error", code: "permission" } : null);
  const report = shown?.kind === "report" ? shown.report : null;
  const limitLeft = report?.limitReached ? report.unsynced : used >= RESEND_FREE_CONTACTS && state.missing > 0 ? state.missing : null;

  return (
    <div className={styles.sync} data-sync="">
      <div className={styles.counts}>
        {state.resend !== null && (
          <p className={styles.count} data-sync-resend="">
            {fill(t.resendContacts, { n: state.resend })}
          </p>
        )}
        <p className={styles.count} data-sync-site="">
          {fill(state.resend === null ? t.siteContactsOnly : t.siteContacts, { n: state.site })}
        </p>
      </div>
      {used >= CONTACTS_WARN_AT && (
        <p className={ui.notice} data-sync-warning="">
          {t.warn}
        </p>
      )}
      {limitLeft !== null && (
        <p className={ui.notice} data-sync-limit="">
          {fill(t.limit, { n: limitLeft })}
        </p>
      )}
      <div className={styles.run}>
        <button type="button" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} onClick={run} data-sync-run="">
          {pending ? t.working : t.button}
        </button>
        <div role="status" className={styles.status} data-sync-status="">
          {pending && <p className={ui.hint}>{t.working}</p>}
          {!pending && shown?.kind === "error" && (
            <p className={ui.error} data-sync-error={shown.code}>
              {t.errors[shown.code]}
            </p>
          )}
          {report && (
            <>
              <p className={ui.success} data-sync-report="">
                {fill(t.report, { added: report.added, removed: report.removed, unsubscribedPulled: report.unsubscribedPulled })}
              </p>
              {report.suppressed > 0 && (
                <p className={ui.hint} data-sync-report-suppressed="">
                  {fill(t.reportSuppressed, { n: report.suppressed })}
                </p>
              )}
              {report.failed > 0 && (
                <p className={ui.error} data-sync-report-failed="">
                  {fill(t.reportFailed, { n: report.failed })}
                </p>
              )}
              {report.rejected > 0 && (
                <p className={ui.hint} data-sync-report-rejected="">
                  {fill(t.reportRejected, { n: report.rejected })}
                </p>
              )}
              {!report.finished && (
                <p className={ui.hint} data-sync-unfinished="">
                  {t.unfinished}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
