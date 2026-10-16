"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { euro, INVOICE_LIMITS, invoiceStatusText, paidMethodText, REFUNDED } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { cancelInvoiceAction, markInvoicePaidAction, sendInvoiceAction, undoInvoicePaidAction, updateInvoiceBuyerAction } from "@/server/actions/admin-invoices";
import type { InvoiceView } from "./invoice-view";
import { PaidFields, type ManualMethod } from "./PaidFields";
import ui from "./ui.module.css";
import styles from "./InvoiceBlock.module.css";

// One invoice with the actions its state allows (spec §5, D6, ruling R10), in the registration drawer and on the „Arved“ list:
// - Tasumata: „Saada õpilasele“, „Muuda saajat“, „Märgi tasutuks“, „Tühista arve“; one whose online payment is paid and waits for its catch-up
//   (R14, the final review's m2) says so and has neither „Saada õpilasele“ (a request for money already in) nor „Märgi tasutuks“ (refused);
// - Tasutud: „Saada õpilasele“, and „Võta tasumine tagasi“ when Maria marked it (an online payment's invoice is never changed by the site); one
//   whose online payment was refunded or voided reads „Tagastatud“ (I3), its actions as they were;
// - Tühistatud: nothing but the download.
// „Laadi alla (PDF)“ is on every invoice. An action that needs more than a tap opens a panel under the buttons (the second address, the day and
// the way, the buyer's fields) or asks to be confirmed (undo, cancel), saying what will happen; the page is refreshed by the action when it
// succeeds, so this row then shows the new state. This file runs on old iPads: no regular expression with a lookbehind, here or in anything it
// imports (tests/unit/old-safari.test.ts).

type Panel = "send" | "paid" | "buyer" | "undo" | "cancel";
/** The status line: empty, on its way, done or refused (`code` is the refusal's, so a field can be marked). */
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string; code?: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);
const TAG = { unpaid: ui.warn, paid: ui.ok, cancelled: "" } as const;

/** The buyer editor's fields as typed. */
type BuyerDraft = { name: string; address: string; company: string; companyCode: string; companyAddress: string };
const buyerDraft = (b: InvoiceView["buyer"]): BuyerDraft => ({ name: b.name, address: b.address, company: b.company, companyCode: b.companyCode, companyAddress: b.companyAddress });

export function InvoiceRow({ invoice: v, today, showWho = false }: { invoice: InvoiceView; today: string; showWho?: boolean }) {
  const t = adminEt.invoices.row;
  const uid = useId();
  const panelBox = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const [also, setAlso] = useState("");
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<ManualMethod>("bank");
  const [buyer, setBuyer] = useState<BuyerDraft>(() => buyerDraft(v.buyer));
  const [fields, setFields] = useState<Record<string, string>>({});

  // an opened panel takes the focus, so the keyboard follows the tap: its first field, or for a confirmation (which undoes or cancels something)
  // the harmless „Katkesta“, never the button that does it
  useEffect(() => {
    if (panel) panelBox.current?.querySelector<HTMLElement>(panel === "undo" || panel === "cancel" ? "[data-invoice-close]" : "input, button")?.focus();
  }, [panel]);

  const open = (p: Panel) => {
    setPanel(p);
    setLine(IDLE);
    setFields({});
    if (p === "buyer") setBuyer(buyerDraft(v.buyer));
  };
  const close = () => {
    setPanel(null);
    setLine(IDLE);
    setFields({});
  };
  const busy = (text: string) => setLine({ tone: "busy", text });
  const finish = (text: string) => {
    setPanel(null);
    setFields({});
    setLine({ tone: "done", text });
  };
  const refuse = (text: string, code?: string) => setLine({ tone: "error", text, code });

  /** A confirm button or a form's submit: runs `work` once at a time. */
  const submit = (text: string, work: () => Promise<void>) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (pending) return;
    busy(text);
    start(work);
  };

  const send = submit(t.sendPanel.sending, async () => {
    const r = await sendInvoiceAction({ id: v.id, also });
    if (!r.ok) return refuse(r.text, r.error);
    setAlso("");
    finish("secondFailed" in r && r.secondFailed ? t.sendPanel.secondFailed : t.sendPanel.sent);
  });
  const markPaid = submit(t.paidPanel.saving, async () => {
    const r = await markInvoicePaidAction({ id: v.id, paidAt: date, method });
    if (!r.ok) return refuse(r.text, r.error);
    finish(r.full ? `${t.paidPanel.done} ${t.paidPanel.full}` : t.paidPanel.done);
  });
  const undo = submit(adminEt.common.saving, async () => {
    const r = await undoInvoicePaidAction({ id: v.id });
    if (!r.ok) return refuse(r.text, r.error);
    // (ruling R10: the screen says which of the two it was)
    finish(r.status === "cancelled" ? t.undoPanel.doneReceipt : t.undoPanel.doneRequest);
  });
  const cancel = submit(adminEt.common.saving, async () => {
    const r = await cancelInvoiceAction({ id: v.id });
    if (!r.ok) return refuse(r.text, r.error);
    finish(t.cancelPanel.done);
  });
  const saveBuyer = submit(t.buyerPanel.saving, async () => {
    const r = await updateInvoiceBuyerAction({ id: v.id, ...buyer });
    if (r.ok) return finish(t.buyerPanel.done);
    if ("fields" in r && r.fields) {
      setFields(r.fields);
      return refuse(adminEt.invoices.settings.invalid, r.error);
    }
    refuse(r.text, r.error);
  });

  // a refused buyer field: the first one marked takes the focus
  useEffect(() => {
    if (panel === "buyer" && Object.keys(fields).length > 0) panelBox.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [panel, fields]);

  const status = v.status;
  const sendable = status !== "cancelled" && !v.paidOnline;
  const when = (iso: string) => formatDate(new Date(iso), "et");
  const facts = [
    v.part,
    fill(t.issued, { date: when(v.issuedAt) }),
    status === "unpaid" && v.dueAt ? fill(t.due, { date: when(v.dueAt) }) : null,
    status === "paid" && v.paidAt ? fill(t.paid, { date: when(v.paidAt), method: v.paidMethod ? paidMethodText(v.paidMethod) : adminEt.common.none }) : null,
  ].filter((x): x is string => x !== null);
  const sentLine = v.sentAt ? fill(v.sentNote ? t.sentAlso : t.sent, { date: when(v.sentAt), address: v.sentNote }) : null;

  const buyerField = (key: keyof BuyerDraft, label: string, limit: number, wide = false) => {
    const code = fields[key];
    const message = code === "required" ? t.buyerPanel.errors.required : code === "tooLong" ? t.buyerPanel.errors.tooLong : code ? t.buyerPanel.errors.other : null;
    const id = `${uid}-${key}`;
    return (
      <div className={`${ui.field} ${wide ? styles.wide : ""}`}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className={ui.input}
          type="text"
          autoComplete="off"
          maxLength={limit}
          value={buyer[key]}
          onChange={(e) => setBuyer((b) => ({ ...b, [key]: e.target.value }))}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-error` : undefined}
          data-buyer-field={key}
        />
        {message && (
          <p id={`${id}-error`} className={ui.error}>
            {message}
          </p>
        )}
      </div>
    );
  };

  return (
    <li className={styles.row} data-invoice={v.number} data-invoice-id={v.id} data-invoice-status={status} data-invoice-refunded={v.refunded || undefined}>
      <div className={styles.head}>
        <strong className={styles.number}>{v.number}</strong>
        <span className={`${ui.tag} ${v.refunded ? ui.warn : TAG[status]}`} data-invoice-state="">
          {v.refunded ? REFUNDED : invoiceStatusText(status)}
        </span>
        <strong className={styles.amount} data-invoice-amount="">
          {euro(v.amountCents)}
        </strong>
      </div>
      {showWho && (
        <p className={styles.who} data-invoice-who="">
          <span>
            {v.buyer.name}
            {v.course ? ` · ${v.course}` : ""}
          </span>
          {v.registrationId !== null && (
            <Link className={ui.link} href={`/admin/registreerimised?id=${v.registrationId}`}>
              {t.openRegistration}
            </Link>
          )}
        </p>
      )}
      <p className={styles.meta} data-invoice-facts="">
        {facts.join(" · ")}
      </p>
      {v.paidOnline && (
        <p className={styles.meta} data-invoice-paid-online="">
          {t.paidOnline}
        </p>
      )}
      {sentLine && (
        <p className={styles.meta} data-invoice-sent="">
          {sentLine}
        </p>
      )}

      <div className={styles.actions} role="group" aria-label={fill(t.actionsLabel, { number: v.number })}>
        {sendable && (
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => open("send")} aria-expanded={panel === "send"} data-invoice-send="">
            {t.send}
          </button>
        )}
        {status === "unpaid" && (
          <>
            <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => open("buyer")} aria-expanded={panel === "buyer"} data-invoice-buyer="">
              {t.editBuyer}
            </button>
            {!v.paidOnline && (
              <button type="button" className={`${ui.btn} ${ui.smallBtn}`} onClick={() => open("paid")} aria-expanded={panel === "paid"} data-invoice-mark-paid="">
                {t.markPaid}
              </button>
            )}
            <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} onClick={() => open("cancel")} aria-expanded={panel === "cancel"} data-invoice-cancel="">
              {t.cancelInvoice}
            </button>
          </>
        )}
        {status === "paid" && !v.online && (
          <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} onClick={() => open("undo")} aria-expanded={panel === "undo"} data-invoice-undo="">
            {t.undoPaid}
          </button>
        )}
        <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/api/admin/arve/${v.id}`} aria-label={fill(t.downloadLabel, { number: v.number })} data-invoice-download="">
          {t.download}
        </a>
      </div>

      <div ref={panelBox} className={styles.panelBox}>
        {panel === "send" && (
          <form className={styles.panel} onSubmit={send} noValidate data-invoice-panel="send">
            <p>{fill(t.sendPanel.to, { email: v.buyer.email })}</p>
            <div className={ui.field}>
              <label htmlFor={`${uid}-also`}>{t.sendPanel.also}</label>
              <input
                id={`${uid}-also`}
                className={ui.input}
                type="email"
                autoComplete="off"
                maxLength={254}
                value={also}
                onChange={(e) => setAlso(e.target.value)}
                aria-invalid={line.code === "email" ? true : undefined}
                aria-describedby={`${uid}-also-hint`}
                data-invoice-also=""
              />
              <p id={`${uid}-also-hint`} className={ui.hint}>
                {t.sendPanel.alsoHint}
              </p>
            </div>
            <div className={styles.panelActions}>
              <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-invoice-send-confirm="">
                {pending ? t.sendPanel.sending : t.sendPanel.submit}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={close} data-invoice-close="">
                {t.close}
              </button>
            </div>
          </form>
        )}

        {panel === "paid" && (
          <form className={styles.panel} onSubmit={markPaid} noValidate data-invoice-panel="paid">
            <PaidFields name={`${uid}-mark`} date={date} method={method} today={today} onDate={setDate} onMethod={setMethod} dateLabel={t.paidPanel.date} methodLabel={t.paidPanel.method} />
            <p className={ui.hint}>{t.paidPanel.hint}</p>
            <div className={styles.panelActions}>
              <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-invoice-paid-confirm="">
                {pending ? t.paidPanel.saving : t.paidPanel.submit}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={close} data-invoice-close="">
                {t.close}
              </button>
            </div>
          </form>
        )}

        {panel === "buyer" && (
          <form className={styles.panel} onSubmit={saveBuyer} noValidate data-invoice-panel="buyer">
            <div className={styles.grid}>
              {buyerField("name", t.buyerPanel.name, INVOICE_LIMITS.name)}
              {buyerField("address", t.buyerPanel.address, INVOICE_LIMITS.buyerAddress)}
              {buyerField("company", t.buyerPanel.company, INVOICE_LIMITS.company)}
              {buyerField("companyCode", t.buyerPanel.companyCode, INVOICE_LIMITS.registryCode)}
              {buyerField("companyAddress", t.buyerPanel.companyAddress, INVOICE_LIMITS.buyerAddress, true)}
            </div>
            <p className={ui.hint}>{t.buyerPanel.hint}</p>
            <div className={styles.panelActions}>
              <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-invoice-buyer-confirm="">
                {pending ? t.buyerPanel.saving : t.buyerPanel.submit}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={close} data-invoice-close="">
                {t.close}
              </button>
            </div>
          </form>
        )}

        {panel === "undo" && (
          <div className={styles.panel} role="group" aria-label={t.undoPaid} data-invoice-panel="undo">
            {/* ruling R10: the words say what will happen — a receipt asked for no money, so it is cancelled; a marked request is unpaid again */}
            <p data-invoice-undo-text="">{v.paidAdds ? t.undoPanel.request : t.undoPanel.receipt}</p>
            <div className={styles.panelActions}>
              <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={undo} data-invoice-undo-confirm="">
                {t.undoPanel.confirm}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={close} data-invoice-close="">
                {t.close}
              </button>
            </div>
          </div>
        )}

        {panel === "cancel" && (
          <div className={styles.panel} role="group" aria-label={t.cancelInvoice} data-invoice-panel="cancel">
            <p>{t.cancelPanel.text}</p>
            <div className={styles.panelActions}>
              <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={cancel} data-invoice-cancel-confirm="">
                {t.cancelPanel.confirm}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={close} data-invoice-close="">
                {t.close}
              </button>
            </div>
          </div>
        )}

      </div>

      <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-invoice-status-line="">
        {line.text}
      </p>
    </li>
  );
}
