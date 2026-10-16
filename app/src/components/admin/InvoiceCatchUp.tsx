"use client";

import { useState, useTransition } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { catchUpInvoiceAction } from "@/server/actions/admin-invoices";
import ui from "./ui.module.css";
import styles from "./InvoiceBlock.module.css";

type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/**
 * „Koosta arve“ of one row of „Arveta maksed“ (invoices Task 5, spec §6.3, ruling R13): the paid payment gets its invoice — the unpaid one it
 * was started for, paid, or a new one born paid on the payment's day, not mailed. No bulk button: each one is a real number. The page is
 * refreshed by the action, so the row then leaves the list.
 */
export function InvoiceCatchUp({ paymentId }: { paymentId: number }) {
  const t = adminEt.invoices.uninvoiced;
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const make = () => {
    if (pending) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      const r = await catchUpInvoiceAction({ paymentId });
      setLine(r.ok ? { tone: "done", text: fill(t.done, { number: r.number }) } : { tone: "error", text: r.text });
    });
  };
  return (
    <div className={styles.catchUp}>
      <button type="button" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={make} data-uninvoiced-create={paymentId}>
        {pending ? t.working : t.create}
      </button>
      <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-uninvoiced-status="">
        {line.text}
      </p>
    </div>
  );
}
