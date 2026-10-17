"use client";

import { useId, useState, useTransition } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { requestContractAction, sendContractCopyAction } from "@/server/actions/admin-contracts";
import type { ContractView } from "./contract-view";
import ui from "./ui.module.css";
import styles from "./ContractBlock.module.css";

// The registration drawer's „Leping“ (contracts Task 5, spec §4, D4, D7): the registration's contracts — the current one first, with the day it was
// accepted and the way, „Laadi alla (PDF)“ and „Saada koopia õpilasele“, then the superseded ones with „Asendatud {date}“ (they can be downloaded, not
// sent) — and „Saada leping kinnitamiseks“. The ask is offered to a registration linked to an account and not cancelled, whether or not it has a contract
// (D4: none, or the session or the terms changed since). Without an account the block says so in words and offers no button; a cancelled registration
// shows its contracts and no button (and no word about an account: there is nothing left to ask). Once Maria has asked, the block says „Kinnitamist
// ootab (saadetud {date})“ until the student accepts (the page's `contract_requested_at`). The page is refreshed by the action, so the block then shows
// the new state. This file runs on old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

export function ContractBlock({
  registrationId,
  contracts,
  requestedAt,
  linked,
  cancelled,
}: {
  registrationId: number;
  /** The registration's contracts: the current one first, then the superseded ones, the newest first (server/contracts.ts contractsOfRegistration). */
  contracts: ContractView[];
  /** When Maria last asked the student to accept (ISO), or null: the ask is open until she accepts. */
  requestedAt: string | null;
  /** The registration is linked to an account (an ask can reach her there). */
  linked: boolean;
  /** The registration is cancelled: its contracts stay, nothing is asked. */
  cancelled: boolean;
}) {
  const t = adminEt.contracts.block;
  const uid = useId();
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();

  const when = (iso: string) => formatDate(new Date(iso), "et");

  const ask = () => {
    if (pending) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      const r = await requestContractAction({ registrationId });
      if (!r.ok) return setLine({ tone: "error", text: r.text });
      setLine({ tone: "done", text: r.mailed ? t.requestDone : t.requestDoneNoMail });
    });
  };
  const copy = (id: number) => {
    if (pending) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      const r = await sendContractCopyAction({ id });
      setLine(r.ok ? { tone: "done", text: t.sendCopyDone } : { tone: "error", text: r.text });
    });
  };

  return (
    <section className={styles.block} aria-labelledby={`${uid}-title`} data-registration-contracts="">
      <h3 id={`${uid}-title`} className={ui.h3}>
        {adminEt.contracts.title}
      </h3>
      {contracts.length === 0 ? (
        <p className={ui.muted} data-contracts-none="">
          {t.none}
        </p>
      ) : (
        <ul className={styles.list} data-contract-list="">
          {contracts.map((c) => {
            const current = c.supersededAt === null;
            return (
              <li key={c.id} className={styles.row} data-contract={c.id} data-contract-state={current ? "current" : "superseded"}>
                <div className={styles.head}>
                  <strong className={styles.name}>{c.title || adminEt.contracts.title}</strong>
                  {!current && (
                    <span className={ui.tag} data-contract-superseded="">
                      {fill(t.superseded, { date: when(c.supersededAt!) })}
                    </span>
                  )}
                </div>
                <p className={styles.meta} data-contract-facts="">
                  {fill(t.accepted, { date: when(c.acceptedAt), way: adminEt.contracts.via[c.acceptedVia] })}
                </p>
                {current && c.sentAt && (
                  <p className={styles.meta} data-contract-sent="">
                    {fill(t.sent, { date: when(c.sentAt) })}
                  </p>
                )}
                <div className={styles.actions}>
                  {current && (
                    <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={() => copy(c.id)} data-contract-send-copy={c.id}>
                      {t.sendCopy}
                    </button>
                  )}
                  <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/api/admin/leping/${c.id}`} aria-label={fill(t.downloadLabel, { id: c.id })} data-contract-download={c.id}>
                    {t.download}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {requestedAt !== null && (
        <p className={styles.line} data-contract-pending="">
          {fill(t.pending, { date: when(requestedAt) })}
        </p>
      )}

      {linked && !cancelled && (
        <div className={styles.ask}>
          <button type="button" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={ask} data-contract-request="">
            {t.request}
          </button>
          <p className={ui.hint}>{t.requestHint}</p>
        </div>
      )}
      {!linked && !cancelled && (
        <p className={ui.notice} data-contract-no-account="">
          {t.noAccount}
        </p>
      )}
      <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-contract-status="">
        {line.text}
      </p>
    </section>
  );
}
