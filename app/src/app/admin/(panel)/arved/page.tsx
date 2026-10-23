import type { Metadata } from "next";
import { InvoiceCatchUp } from "@/components/admin/InvoiceCatchUp";
import { InvoiceRow } from "@/components/admin/InvoiceRow";
import { invoiceView } from "@/components/admin/invoice-view";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill, type ListScope } from "@/components/admin/ListToolbar";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { TabPills } from "@/components/admin/TabPills";
import { UninvoicedStrip } from "@/components/admin/UninvoicedStrip";
import { unbilledSummary } from "@/components/admin/uninvoiced-summary";
import ui from "@/components/admin/ui.module.css";
import blockStyles from "@/components/admin/InvoiceBlock.module.css";
import { getDb } from "@/db/client";
import { tallinnFormParts } from "@/domain/calendar";
import { euro, invoiceStatusText, parseMonth, sellerReady, type InvoiceStatus } from "@/domain/invoice";
import { parsePage, parseSearch } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatMonthLong } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { getInvoiceSettings, invoiceCounts, invoiceMonths, listInvoices, receiptTakeBacks, unbilledPreview, uninvoicedPaymentRows } from "@/server/invoices";
import styles from "./arved.module.css";

export const dynamic = "force-dynamic";
// „Koosta {n} arvet“ (B11) runs from this page: one catch-up after the other, each its own transaction
export const maxDuration = 60;
export const metadata: Metadata = { title: adminTitle(adminEt.invoices.page.title) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses (README A6, §1.10): ?otsi=<text> (the search across the invoice's number and its buyer's name and e-mail, B7), ?kuu=YYYY-MM (the month of the
// issue, Tallinn's calendar) or ?kuu=koik (every month); without one the list shows this month — the CSV button always names a month, and the
// list it follows is the one on the screen — unless a search is typed: then every month is searched (an unpaid invoice of last month is found), the
// select says „Kõik kuud“ and the CSV button still names this month. ?staatus=unpaid|paid|cancelled (the pill), ?leht=<n> (50 a page). A new search,
// month or pill starts at page 1.
const STATUSES: readonly InvoiceStatus[] = ["unpaid", "paid", "cancelled"];
/** ?kuu= for „Kõik kuud“: the choice of every month. */
const ALL_MONTHS = "koik";

type View = { kuu: string | null; staatus: InvoiceStatus | null; otsi: string; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View {
  const staatus = one(sp.staatus);
  const kuu = one(sp.kuu);
  return { kuu: kuu === ALL_MONTHS ? ALL_MONTHS : parseMonth(kuu), staatus: STATUSES.find((s) => s === staatus) ?? null, otsi: parseSearch(sp.otsi), leht: parsePage(sp.leht) };
}

function href(view: View): string {
  const q = new URLSearchParams();
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.kuu) q.set("kuu", view.kuu);
  if (view.staatus) q.set("staatus", view.staatus);
  if (view.leht > 1) q.set("leht", String(view.leht));
  const s = q.toString();
  return `/admin/arved${s ? `?${s}` : ""}`;
}

/** „oktoober 2026“ → „Oktoober 2026“ (an option's first word). */
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Arved (invoices Task 5, spec §5; admin UX pass A6 and B11): every invoice of the month on the screen, newest first, 50 a page (?leht=), by its state
 * (?staatus=, the pills with their counts) and the search (?otsi=: number, name, e-mail); each with the actions of the registration's „Arved“
 * (InvoiceRow), laid out as the Part 2 prototype draws it. The month is the select beside the search and applies on change (?kuu=; this month when none
 * is chosen — every month while a search is typed —, „Kõik kuud“ for every month); the header's „Laadi alla (CSV) · {kuu aasta}“ is the file of the month
 * on the screen (this month while every month is on it). On top, the strip „Arveta maksed: {n}“ (UninvoicedStrip) when there are any: the payments paid online that have no invoice (the
 * card was empty, or the invoice step failed), with „Koosta {n} arvet“ for all of them and, opened, each one's own „Koosta arve“ and the invoice it will
 * pay if it was started for one. The „Võta tasumine tagasi“ of a receipt says what the drawer's says (S3-f): the page reads the registrations of the
 * receipts it shows for it. Not in the menu: it is the second tab of Maksed (TabPills, A6), whose heading it shares, and the shell marks Maksed ja arved.
 */
export default async function InvoicesPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const now = new Date();
  const today = tallinnFormParts(now).date;
  const thisMonth = today.slice(0, 7);
  // the month on the screen: the chosen one; none (every month) for „Kõik kuud“; when none is chosen, this month — or every month while a search is
  // typed, so that a name or a number from an earlier month is found
  const month = view.kuu === ALL_MONTHS ? undefined : (view.kuu ?? (view.otsi !== "" ? undefined : thisMonth));
  const [list, counts, months, unbilled, seller] = await Promise.all([
    listInvoices(db, { month, status: view.staatus ?? undefined, search: view.otsi }, view.leht),
    invoiceCounts(db, { month, search: view.otsi }),
    invoiceMonths(db),
    uninvoicedPaymentRows(db),
    getInvoiceSettings(db, now),
  ]);
  const [preview, takeBacks] = await Promise.all([unbilledPreview(db, now, unbilled), receiptTakeBacks(db, list.rows)]);
  const t = adminEt.invoices.page;
  const u = adminEt.invoices.uninvoiced;
  const ready = sellerReady(seller);
  // the CSV is a month's file: the one on the screen, else this month's
  const csvMonth = month ?? thisMonth;
  const filtered = view.otsi !== "" || view.staatus !== null || months.length > 0;

  // the select's months: those that have invoices, this month (the list's own when none is chosen) and the chosen one, newest first
  const monthChoices = [...new Set([...months, thisMonth, ...(view.kuu && view.kuu !== ALL_MONTHS ? [view.kuu] : [])])].sort().reverse();
  const scope: ListScope = {
    label: t.month,
    value: month ?? ALL_MONTHS,
    options: [
      { value: ALL_MONTHS, label: t.monthAll, href: href({ ...view, kuu: ALL_MONTHS, leht: 1 }) },
      ...monthChoices.map((m) => ({ value: m, label: capitalise(formatMonthLong(m, "et")), href: href({ ...view, kuu: m, leht: 1 }) })),
    ],
  };
  // each pill goes to the list with that pill chosen, the search and the month kept, from page 1; its count is the rows it then shows
  const pills: ListPill[] = [
    { key: null, label: t.all, count: counts.all },
    ...STATUSES.map((s) => ({ key: s, label: invoiceStatusText(s), count: counts[s] })),
  ].map((p) => ({ href: href({ ...view, staatus: p.key, leht: 1 }), label: p.label, count: p.count, current: view.staatus === p.key }));

  return (
    <div className={ui.page} data-invoices-page="">
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{adminEt.payments.eyebrow}</p>
          <h1 className={ui.h1}>{adminEt.payments.heading}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={styles.csv}>
          <a className={`${ui.btn} ${ui.secondary}`} href={`/api/admin/arved?kuu=${csvMonth}`} data-invoices-csv="">
            {fill(t.csv, { month: formatMonthLong(csvMonth, "et") })}
          </a>
        </div>
      </div>

      <TabPills
        label={adminEt.nav.payments}
        tabs={[
          { href: "/admin/maksed", label: adminEt.payments.tabs.payments, current: false },
          { href: "/admin/arved", label: adminEt.payments.tabs.invoices, current: true },
        ]}
      />

      <UninvoicedStrip
        ids={preview?.ids ?? []}
        first={preview?.first ?? ""}
        last={preview?.last ?? ""}
        linked={preview?.linked ?? 0}
        summary={unbilledSummary(unbilled.map(({ payment: p }) => ({ name: p.name, amountCents: p.amountCents })))}
        ready={ready}
      >
        <ul className={styles.payments}>
          {unbilled.map(({ payment: p, courseTitle, pays }) => (
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
      </UninvoicedStrip>

      <ListToolbar placeholder={t.searchPlaceholder} scope={scope} pillRows={[{ label: t.filterLabel, pills }]} />

      <section className={`${ui.card} ${listTable.card}`} aria-label={t.list}>
        <p className={`${ui.muted} ${ui.small} ${styles.count}`} data-invoices-count="">
          {fill(t.count, { n: list.total })}
        </p>
        {list.rows.length === 0 ? (
          <ListEmpty things={t.things} filtered={filtered} search={view.otsi} clearHref={view.otsi !== "" || view.staatus !== null || view.kuu !== null ? "/admin/arved" : undefined} />
        ) : (
          <ul className={blockStyles.list} data-invoice-list="">
            {list.rows.map((inv) => (
              <InvoiceRow key={inv.id} invoice={invoiceView(inv, takeBacks.get(inv.id) ?? null)} today={today} showWho />
            ))}
          </ul>
        )}
        <Pager info={list} href={(n) => href({ ...view, leht: n })} />
      </section>
    </div>
  );
}
