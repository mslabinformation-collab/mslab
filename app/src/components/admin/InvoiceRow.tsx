"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { euro, INVOICE_LIMITS, invoiceStatusText, paidMethodText, REFUNDED } from "@/domain/invoice";
import { euroBare } from "@/domain/money-text";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatDayMonth } from "@/i18n/format";
import { cancelInvoiceAction, markInvoicePaidAction, sendInvoiceAction, undoInvoicePaidAction, updateInvoiceBuyerAction } from "@/server/actions/admin-invoices";
import { ConfirmPanel } from "./ConfirmPanel";
import type { InvoiceView } from "./invoice-view";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import { PaidFields, type ManualMethod } from "./PaidFields";
import ui from "./ui.module.css";
import styles from "./InvoiceBlock.module.css";

// One invoice with the actions its state allows (spec §5, D6, ruling R10), in the registration drawer and on the „Arved“ list. In view (README A2
// drawer 4, the Part 2 prototype's Arved row): „Saada õpilasele“ and „Laadi alla (PDF)“; the rest under „Veel ▾“ (MoreMenu), as the state allows:
// - Tasumata: „Saada õpilasele“; Muuda saajat, Märgi tasutuks, Tühista arve under „Veel ▾“. One whose online payment is paid and waits for its
//   catch-up (R14, the final review's m2) says so and has neither „Saada õpilasele“ (a request for money already in) nor „Märgi tasutuks“ (refused);
// - Tasutud: „Saada õpilasele“, and „Võta tasumine tagasi“ under „Veel ▾“ when Maria marked or recorded it (an online payment's invoice is never
//   changed by the site: no menu); one whose online payment was refunded or voided reads „Tagastatud“ (I3) and is not sent again (README);
// - Tühistatud: nothing but the download.
// „Laadi alla (PDF)“ is on every invoice. An action that needs more than a tap opens a panel under the buttons (the second address, the day and the
// way, the buyer's fields) or asks to be confirmed with a ConfirmPanel, saying what will happen: „Tühista arve“ (P-11) and „Võta tasumine tagasi“
// (S3-f for a receipt — a paid invoice with no due date —, which lowers „Laekunud summa“ by the sum the server will really take back, the
// InvoiceView's `takeBack`; a request Maria marked paid keeps its words). The focus goes back to the trigger when a panel is cancelled; the page is
// refreshed by an action when it succeeds, so this row then shows the new state. This file runs on old iPads: no regular expression with a
// lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

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
  const actionsBox = useRef<HTMLDivElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  /** The button the open panel came from: „Saada õpilasele“, or „Veel ▾“ for the menu's items. */
  const [from, setFrom] = useState<"send" | "menu">("menu");
  /**
   * Where the focus goes now that a panel has gone (a new object each time, so the same place again is a change too): the button it was opened from
   * when it was cancelled, the line that says what happened when the action went through (the trigger may be gone by the time the page is refreshed).
   */
  const [back, setBack] = useState<{ to: "send" | "menu" | "line" } | null>(null);

  // an opened panel takes the focus, so the keyboard follows the tap: its first field. A ConfirmPanel (undo, cancel) takes the focus itself.
  useEffect(() => {
    if (panel && panel !== "undo" && panel !== "cancel") panelBox.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [panel]);

  // the panel cancelled (or done): the focus goes back to its trigger when there is one, else to the line that says what happened
  useEffect(() => {
    if (!back) return;
    const trigger = back.to === "send" ? sendButton.current : back.to === "menu" ? actionsBox.current?.querySelector<HTMLElement>("[data-more-menu] > button") : null;
    (trigger ?? statusLine.current)?.focus();
  }, [back]);

  /** `opener`: the button the panel opens from, which gets the focus back. */
  const open = (p: Panel, opener: "send" | "menu") => {
    setFrom(opener);
    setPanel(p);
    setLine(IDLE);
    setFields({});
    if (p === "buyer") setBuyer(buyerDraft(v.buyer));
  };
  const close = () => {
    setBack({ to: from });
    setPanel(null);
    setLine(IDLE);
    setFields({});
  };
  const busy = (text: string) => setLine({ tone: "busy", text });
  const finish = (text: string) => {
    setBack({ to: "line" });
    setPanel(null);
    setFields({});
    setLine({ tone: "done", text });
  };
  const refuse = (text: string, code?: string) => setLine({ tone: "error", text, code });

  /** A confirmation's yes or a form's submit: runs `work` once at a time. */
  const run = (text: string, work: () => Promise<void>) => {
    if (pending) return;
    busy(text);
    start(work);
  };
  const submit = (text: string, work: () => Promise<void>) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    run(text, work);
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
  const undo = () =>
    run(adminEt.common.saving, async () => {
      const r = await undoInvoicePaidAction({ id: v.id });
      if (!r.ok) return refuse(r.text, r.error);
      // (ruling R10: the screen says which of the two it was)
      finish(r.status === "cancelled" ? t.undoPanel.doneReceipt : t.undoPanel.doneRequest);
    });
  const cancel = () =>
    run(adminEt.common.saving, async () => {
      const r = await cancelInvoiceAction({ id: v.id });
      if (!r.ok) return refuse(r.text, r.error);
      finish(t.cancelPanel.done);
    });
  const saveBuyer = submit(t.buyerPanel.saving, async () => {
    const r = await updateInvoiceBuyerAction({ id: v.id, ...buyer });
    if (r.ok) return finish(t.buyerPanel.done);
    if ("fields" in r && r.fields) {
      setFields(r.fields);
      return refuse(adminEt.editor.invalid, r.error);
    }
    refuse(r.text, r.error);
  });

  // a refused buyer field: the first one marked takes the focus
  useEffect(() => {
    if (panel === "buyer" && Object.keys(fields).length > 0) panelBox.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [panel, fields]);

  const status = v.status;
  // (not to a cancelled invoice, one whose online payment is paid — a request for money already in —, nor to „Tagastatud“: README A2 drawer 4)
  const sendable = status !== "cancelled" && !v.paidOnline && !v.refunded;
  // a receipt („Juba tasutud“, „Lisa laekumine“'s) is born paid, with no due date: its undo cancels it and lowers „Laekunud summa“ (S3-f); a request
  // Maria marked paid has its due date and is unpaid again
  const receipt = status === "paid" && v.dueAt === null;
  const more: MoreMenuItem[] = [];
  if (status === "unpaid") {
    more.push({ label: t.editBuyer, onSelect: () => open("buyer", "menu") });
    if (!v.paidOnline) more.push({ label: t.markPaid, onSelect: () => open("paid", "menu") });
    more.push({ label: t.cancelInvoice, tone: "danger", onSelect: () => open("cancel", "menu") });
  }
  if (status === "paid" && !v.online) more.push({ label: t.undoPaid, tone: "danger", onSelect: () => open("undo", "menu") });
  /**
   * What S3-f's panel says comes off: the sum the server will take back (capped), else — where the page has not worked it out — the receipt's own amount.
   * A receipt whose registration is gone (`registrationId` null) is only cancelled by the server, so nothing comes off: no sum (0 leaves the line out).
   */
  const takeBackCents = v.takeBack ? v.takeBack.cents : v.registrationId === null ? 0 : v.amountCents;
  const when = (iso: string) => formatDate(new Date(iso), "et");
  const short = (iso: string) => formatDayMonth(new Date(iso), "et");
  // The drawer's meta line: every date in full. The list's (`showWho`) is the Part 2 prototype's: „Osamakse · koostatud 20.10 · tasutud 15.10 · sularaha“,
  // „Ettemaks 50% · maksta kuni 27.10“ — short dates, and the day it was made only where it tells something: not beside „maksta kuni“ and not
  // when it was paid the very day it was made. A way Maria typed reads in lower case in the line („sularaha“); Montonio and Inbank are names.
  const manualWay = (m: NonNullable<InvoiceView["paidMethod"]>) => (m === "montonio" || m === "financing" ? paidMethodText(m) : paidMethodText(m).toLowerCase());
  const factsList = [
    v.part,
    status !== "unpaid" && !(status === "paid" && v.paidAt && when(v.paidAt) === when(v.issuedAt)) ? fill(t.listIssued, { date: short(v.issuedAt) }) : null,
    status === "unpaid" && v.dueAt ? fill(t.listDue, { date: short(v.dueAt) }) : null,
    status === "paid" && v.paidAt ? [fill(t.listPaid, { date: short(v.paidAt) }), v.paidMethod ? manualWay(v.paidMethod) : adminEt.common.none].join(" · ") : null,
  ];
  const factsDrawer = [
    v.part,
    fill(t.issued, { date: when(v.issuedAt) }),
    status === "unpaid" && v.dueAt ? fill(t.due, { date: when(v.dueAt) }) : null,
    status === "paid" && v.paidAt ? fill(t.paid, { date: when(v.paidAt), method: v.paidMethod ? paidMethodText(v.paidMethod) : adminEt.common.none }) : null,
  ];
  const facts = (showWho ? factsList : factsDrawer).filter((x): x is string => x !== null);
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
    <li className={`${styles.row} ${showWho ? styles.listRow : ""}`.trim()} data-invoice={v.number} data-invoice-id={v.id} data-invoice-status={status} data-invoice-refunded={v.refunded || undefined}>
      {/* the number and its state, and the sum: one line in the drawer; on the list (a wide card) the head gives them to the row's columns (InvoiceBlock.module.css) */}
      <div className={styles.head}>
        <div className={styles.ident}>
          <strong className={styles.number}>{v.number}</strong>
          <span className={`${ui.tag} ${v.refunded ? ui.warn : TAG[status]}`} data-invoice-state="">
            {v.refunded ? REFUNDED : invoiceStatusText(status)}
          </span>
        </div>
        <strong className={styles.amount} data-invoice-amount="">
          {euro(v.amountCents)}
        </strong>
      </div>
      {/* who it is for and the lines under it: the middle column of the list's row; the drawer's lines sit in the row's own column */}
      <div className={styles.body}>
        {showWho && (
          <p className={styles.who} data-invoice-who="">
            <span>
              <strong>{v.buyer.name}</strong>
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
      </div>

      <div ref={actionsBox} className={styles.actions} role="group" aria-label={fill(t.actionsLabel, { number: v.number })}>
        {sendable && (
          <button
            ref={sendButton}
            type="button"
            className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
            onClick={() => open("send", "send")}
            aria-expanded={panel === "send"}
            data-invoice-send=""
          >
            {t.send}
          </button>
        )}
        <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/api/admin/arve/${v.id}`} aria-label={fill(t.downloadLabel, { number: v.number })} data-invoice-download="">
          {t.download}
        </a>
        {more.length > 0 && <MoreMenu items={more} buttonLabel={fill(t.moreLabel, { number: v.number })} />}
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

        {/* S3-f: the undo of a receipt asks the question and lists what follows; a request Maria marked paid keeps its words (ruling R10: the words say
            what will happen — a receipt is cancelled and keeps its number, a marked request is unpaid again) */}
        {panel === "undo" && (
          <div data-invoice-panel="undo">
            <ConfirmPanel
              question={fill(receipt ? t.undoPanel.receiptQuestion : t.undoPanel.requestQuestion, { number: v.number })}
              lines={
                receipt
                  ? [
                      t.undoPanel.receiptCancelled,
                      // (a cap that leaves nothing to take back — an old receipt for money the online payment covers — has no sum to say)
                      ...(takeBackCents > 0 ? [fill(t.undoPanel.receiptSum, { x: euroBare(takeBackCents) })] : []),
                      ...(v.takeBack?.backToAwaiting ? [t.undoPanel.receiptBack] : []),
                    ]
                  : [t.undoPanel.request]
              }
              yesLabel={t.undoPanel.confirm}
              tone="danger"
              busy={pending}
              onYes={undo}
              onCancel={close}
            />
          </div>
        )}

        {/* P-11 */}
        {panel === "cancel" && (
          <div data-invoice-panel="cancel">
            <ConfirmPanel question={fill(t.cancelPanel.question, { number: v.number })} lines={[t.cancelPanel.text]} yesLabel={t.cancelPanel.confirm} tone="danger" busy={pending} onYes={cancel} onCancel={close} />
          </div>
        )}

      </div>

      <p ref={statusLine} tabIndex={-1} role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-invoice-status-line="">
        {line.text}
      </p>
    </li>
  );
}
