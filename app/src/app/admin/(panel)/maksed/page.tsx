import type { Metadata } from "next";
import Link from "next/link";
import { ListRows } from "@/components/admin/ListRows";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { PAYMENT_TONE, paymentMethodText, paymentStatusLabel } from "@/components/admin/PaymentLines";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { pagePayments } from "@/db/queries/payments";
import type { PaymentStatus } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { parsePage } from "@/domain/paging";
import { needsCheck } from "@/domain/payments";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./payments.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.payments) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?staatus=makstud|pooleli|ebaonnestunud|tagastatud|kontroll (the filter), ?leht=<n> (50 a page). A new filter starts at page 1.
// A replaced order („Asendatud“, B22) has no filter of its own: it shows under „Kõik“ only (P-8), so no address leads to it.
const STATUS_PARAM: Record<string, PaymentStatus> = { makstud: "paid", pooleli: "pending", ebaonnestunud: "failed", tagastatud: "refunded", kontroll: "held" };
const PARAM_OF: Record<PaymentStatus, string> = { paid: "makstud", pending: "pooleli", failed: "ebaonnestunud", refunded: "tagastatud", held: "kontroll", replaced: "" };

type View = { staatus: PaymentStatus | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View {
  const staatus = one(sp.staatus);
  // (own keys only: "constructor" or "__proto__" in the address must not read the object's prototype)
  return { staatus: staatus && Object.hasOwn(STATUS_PARAM, staatus) ? STATUS_PARAM[staatus] : null, leht: parsePage(sp.leht) };
}

function href(view: View): string {
  const q = new URLSearchParams();
  if (view.staatus) q.set("staatus", PARAM_OF[view.staatus]);
  if (view.leht > 1) q.set("leht", String(view.leht));
  const s = q.toString();
  return `/admin/maksed${s ? `?${s}` : ""}`;
}

/**
 * Maksed (phase 2b, spec 8): the online payments, newest first, 50 a page, with the status filter. Each row: the date (the day it was paid,
 * else the day it was started), the payer (a link to the student when the payment has one), what it was for, the kind, the amount, how it
 * was paid (Pangalink · Swedbank, Kaart …), the status —
 * "Kontrolli Montonios" on a held payment or one voided after it was paid — and Montonio's id (to find it in Montonio's dashboard).
 * Read-only: refunds are made in Montonio's own dashboard.
 */
export default async function PaymentsPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const list = await pagePayments(getDb(), view.staatus ?? "all", view.leht);
  const t = adminEt.payments;
  const filters: { key: PaymentStatus | null; label: string }[] = [
    { key: null, label: t.filter.all },
    { key: "paid", label: t.filter.paid },
    { key: "pending", label: t.filter.pending },
    { key: "failed", label: t.filter.failed },
    { key: "refunded", label: t.filter.refunded },
    { key: "held", label: t.filter.held },
  ];

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        {/* the invoices (invoices Task 5, spec §11): reached from here, not from the menu */}
        <Link className={`${ui.btn} ${ui.secondary}`} href="/admin/arved" data-payments-invoices="">
          {adminEt.invoices.fromPayments}
        </Link>
      </div>

      <nav className={ui.filters} aria-label={t.filterLabel} data-payment-filter="">
        {filters.map((l) => (
          <Link key={l.label} className={ui.pill} href={href({ staatus: l.key, leht: 1 })} aria-current={view.staatus === l.key ? "true" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>

      <section className={`${ui.card} ${listTable.card} ${listTable.stackAt980}`} aria-label={t.title}>
        <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
        {list.rows.length === 0 ? (
          <p className={ui.empty}>{view.staatus ? t.emptyFiltered : t.empty}</p>
        ) : (
          <ListRows>

            <table className={`${ui.table} ${listTable.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.date}</th>
                  <th scope="col">{t.col.payer}</th>
                  <th scope="col">{t.col.what}</th>
                  <th scope="col">{t.col.kind}</th>
                  <th scope="col">{t.col.amount}</th>
                  <th scope="col">{t.col.method}</th>
                  <th scope="col">{t.col.status}</th>
                  <th scope="col">{t.col.provider}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((p) => {
                  const check = needsCheck(p);
                  // the day it was paid, else the day it was started: the list's own order (db/queries/payments.ts pagePayments)
                  const day = p.paidAt ?? p.createdAt;
                  return (
                    <tr key={p.id} className={check ? styles.check : undefined} data-payment={p.reference} data-payment-status={p.status}>
                      <td data-label={t.col.date} className={ui.nowrap}>
                        <span>
                          {formatDate(day, "et")}
                          <span className={`${ui.muted} ${styles.sub}`}>{formatTime(day, "et")}</span>
                        </span>
                      </td>
                      <td data-label={t.col.payer}>
                        <div className={listTable.who}>
                          {p.clientId ? (
                            <Link className={listTable.name} href={`/admin/opilased?id=${p.clientId}`}>
                              {p.name}
                            </Link>
                          ) : (
                            <span className={`${listTable.name} ${styles.plain}`}>{p.name}</span>
                          )}
                          <a className={`${ui.contactLink} ${styles.contact}`} href={`mailto:${p.email}`}>
                            {p.email}
                          </a>
                        </div>
                      </td>
                      <td data-label={t.col.what}>
                        {p.courseTitle ? pick(p.courseTitle, "et") : t.courseGone}
                        {p.startsAt && <span className={`${ui.muted} ${styles.sub}`}>{formatDate(p.startsAt, "et")}</span>}
                      </td>
                      <td data-label={t.col.kind}>{t.kind[p.kind]}</td>
                      <td data-label={t.col.amount} className={ui.nowrap}>
                        {formatEUR(p.amountCents, "et")}
                      </td>
                      <td data-label={t.col.method}>{paymentMethodText(p) ?? adminEt.common.none}</td>
                      <td data-label={t.col.status}>
                        <span className={styles.status}>
                          <span className={`${ui.tag} ${PAYMENT_TONE[p.status]}`}>{paymentStatusLabel(p)}</span>
                          {check && (
                            <span className={`${ui.tag} ${ui.bad}`} data-payment-check="">
                              {t.check}
                            </span>
                          )}
                        </span>
                      </td>
                      <td data-label={t.col.provider} className={styles.provider}>
                        {p.providerUuid ?? adminEt.common.none}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

          </ListRows>
        )}
        <Pager info={list} href={(n) => href({ ...view, leht: n })} />
      </section>
    </div>
  );
}
