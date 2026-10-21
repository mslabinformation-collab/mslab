import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import { InvoiceCatchUp } from "@/components/admin/InvoiceCatchUp";
import { InvoiceRow } from "@/components/admin/InvoiceRow";
import { invoiceView } from "@/components/admin/invoice-view";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import blockStyles from "@/components/admin/InvoiceBlock.module.css";
import { getDb } from "@/db/client";
import { tallinnFormParts } from "@/domain/calendar";
import { euro, invoiceStatusText, parseMonth, sellerReady, type InvoiceStatus } from "@/domain/invoice";
import { parsePage } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { getInvoiceSettings, listInvoices, uninvoicedPaymentRows } from "@/server/invoices";
import styles from "./arved.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.invoices.page.title) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?kuu=YYYY-MM (the month of the issue, Tallinn's calendar), ?staatus=unpaid|paid|cancelled, ?leht=<n> (50 a page). A new filter
// starts at page 1.
const STATUSES: readonly InvoiceStatus[] = ["unpaid", "paid", "cancelled"];

type View = { kuu: string | null; staatus: InvoiceStatus | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View {
  const staatus = one(sp.staatus);
  return { kuu: parseMonth(one(sp.kuu)), staatus: STATUSES.find((s) => s === staatus) ?? null, leht: parsePage(sp.leht) };
}

function href(view: View): string {
  const q = new URLSearchParams();
  if (view.kuu) q.set("kuu", view.kuu);
  if (view.staatus) q.set("staatus", view.staatus);
  if (view.leht > 1) q.set("leht", String(view.leht));
  const s = q.toString();
  return `/admin/arved${s ? `?${s}` : ""}`;
}

/**
 * Arved (invoices Task 5, spec §5): every invoice, newest first, 50 a page (?leht=), by the month it was issued in (?kuu=) and its state
 * (?staatus=); each with the actions of the registration's „Arved“ (InvoiceRow). On top, „Arveta maksed“ (D3, §6.3, R13) when there are any: the
 * payments paid online that have no invoice (the card was empty, or the invoice step failed), each with its own „Koosta arve“ and the invoice
 * it will pay if it was started for one. „Laadi alla (CSV)“ is the chosen month's file for the accountant (this month when none is chosen).
 * Not in the menu: it is reached from Maksed, which the shell marks.
 */
export default async function InvoicesPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const now = new Date();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list, uninvoiced, seller] = await Promise.all([
    listInvoices(db, { month: view.kuu ?? undefined, status: view.staatus ?? undefined }, view.leht),
    uninvoicedPaymentRows(db),
    getInvoiceSettings(db, now),
    getAdminCounts(),
  ]);
  const t = adminEt.invoices.page;
  const u = adminEt.invoices.uninvoiced;
  const today = tallinnFormParts(now).date;
  const csvMonth = view.kuu ?? today.slice(0, 7);
  const filters: { key: InvoiceStatus | null; label: string }[] = [{ key: null, label: t.all }, ...STATUSES.map((s) => ({ key: s, label: invoiceStatusText(s) }))];
  const filtered = view.kuu !== null || view.staatus !== null;
  const ready = sellerReady(seller);

  return (
    <div className={ui.page} data-invoices-page="">
      <p className={styles.back}>
        <Link className={ui.link} href="/admin/maksed">
          <span aria-hidden="true">←</span> {t.eyebrow}
        </Link>
      </p>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={styles.csv}>
          <a className={`${ui.btn} ${ui.secondary}`} href={`/api/admin/arved?kuu=${csvMonth}`} data-invoices-csv="">
            {t.csv}
          </a>
          <p className={ui.hint}>{fill(t.csvNote, { month: `${csvMonth.slice(5)}.${csvMonth.slice(0, 4)}` })}</p>
        </div>
      </div>

      {uninvoiced.length > 0 && (
        <section className={`${ui.card} ${styles.uninvoiced}`} aria-labelledby="uninvoiced-title" data-uninvoiced="">
          <h2 id="uninvoiced-title" className={ui.h2}>
            {u.title}
          </h2>
          <p className={ui.muted}>{u.lead}</p>
          {!ready && (
            <p className={ui.notice} data-uninvoiced-need-seller="">
              <Link className={ui.link} href="/admin/seaded#arve">
                {u.needSeller}
              </Link>
            </p>
          )}
          <ul className={styles.payments}>
            {uninvoiced.map(({ payment: p, courseTitle, pays }) => (
              <li key={p.id} className={styles.payment} data-uninvoiced-payment={p.id}>
                <div>
                  <p className={styles.paymentWho}>
                    {p.name} · {euro(p.amountCents)}
                  </p>
                  <p className={styles.paymentMeta}>
                    {[courseTitle ? pick(courseTitle, "et") : null, fill(u.paidOn, { date: formatDate(p.paidAt ?? p.createdAt, "et") })].filter(Boolean).join(" · ")}
                  </p>
                  <p className={styles.pays} data-uninvoiced-pays="">
                    {pays ? fill(u.pays, { number: pays }) : u.makes}
                  </p>
                </div>
                {ready && <InvoiceCatchUp paymentId={p.id} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className={ui.filters} aria-label={t.filterLabel} data-invoice-filter="">
        {filters.map((f) => (
          <Link key={f.label} className={ui.pill} href={href({ ...view, staatus: f.key, leht: 1 })} aria-current={view.staatus === f.key ? "true" : undefined}>
            {f.label}
          </Link>
        ))}
      </nav>
      <form className={styles.month} method="get" action="/admin/arved" data-invoice-month-form="">
        <div className={ui.field}>
          <label htmlFor="invoice-month">{t.month}</label>
          <input id="invoice-month" className={ui.input} type="month" name="kuu" defaultValue={view.kuu ?? ""} placeholder="2026-10" />
        </div>
        {view.staatus && <input type="hidden" name="staatus" value={view.staatus} />}
        <button type="submit" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}>
          {t.monthShow}
        </button>
        {view.kuu && (
          <Link className={`${ui.pill} ${ui.pillSmall}`} href={href({ ...view, kuu: null, leht: 1 })}>
            {t.monthAll}
          </Link>
        )}
      </form>

      <section className={ui.card} aria-label={t.list}>
        <p className={`${ui.muted} ${ui.small} ${styles.count}`} data-invoices-count="">
          {fill(t.count, { n: list.total })}
        </p>
        {list.rows.length === 0 ? (
          <p className={ui.empty}>{filtered ? t.emptyFiltered : t.empty}</p>
        ) : (
          <ul className={blockStyles.list} data-invoice-list="">
            {list.rows.map((inv) => (
              <InvoiceRow key={inv.id} invoice={invoiceView(inv)} today={today} showWho />
            ))}
          </ul>
        )}
        <Pager info={list} href={(n) => href({ ...view, leht: n })} />
      </section>
    </div>
  );
}
