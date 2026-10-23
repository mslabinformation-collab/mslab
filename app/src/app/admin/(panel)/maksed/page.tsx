import type { Metadata } from "next";
import Link from "next/link";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListRows } from "@/components/admin/ListRows";
import { ListToolbar, type ListPill } from "@/components/admin/ListToolbar";
import listTable from "@/components/admin/list-table.module.css";
import { MontonioLink } from "@/components/admin/MontonioLink";
import { Pager } from "@/components/admin/Pager";
import { PAYMENT_TONE, checkText, paymentMethodText, paymentStatusLabel } from "@/components/admin/PaymentLines";
import { adminTitle } from "@/components/admin/sections";
import { TabPills } from "@/components/admin/TabPills";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { pagePayments, paymentCounts, type PaymentFilter, type PaymentRow } from "@/db/queries/payments";
import { formatEUR } from "@/domain/money";
import { parsePage, parseSearch } from "@/domain/paging";
import { needsCheck } from "@/domain/payments";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatDayMonth, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { montonioPartnerUrl } from "@/server/payments/montonio";
import styles from "./payments.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.payments) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses (README A6, §1.10): ?otsi=<text> (the search across name, e-mail, Montonio id and reference, B7), ?staatus=makstud|pooleli|ebaonnestunud|
// tagastatud|kontroll (the pill), ?leht=<n> (50 a page). A new search or pill starts at page 1.
// The pills are the words of the address (db/queries/payments.ts PaymentFilter, B14): „Ootel kontrollil“ (kontroll) holds what Maria must look at in
// Montonio, the payments voided after they were paid („Tühistatud pangas“) too; „Ebaõnnestunud“ only those never paid. A replaced order („Asendatud“,
// B22) has no pill of its own: it shows under „Kõik“ only (P-8), so no address names it.
type Pill = Exclude<PaymentFilter, "all">;
const PILLS: readonly Pill[] = ["makstud", "pooleli", "ebaonnestunud", "tagastatud", "kontroll"];

type View = { staatus: Pill | null; otsi: string; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View {
  const staatus = one(sp.staatus);
  // (a name from the list only: "constructor" or "__proto__" in the address is no pill)
  return { staatus: PILLS.find((p) => p === staatus) ?? null, otsi: parseSearch(sp.otsi), leht: parsePage(sp.leht) };
}

function href(view: View): string {
  const q = new URLSearchParams();
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.staatus) q.set("staatus", view.staatus);
  if (view.leht > 1) q.set("leht", String(view.leht));
  const s = q.toString();
  return `/admin/maksed${s ? `?${s}` : ""}`;
}

/**
 * Where a payment's row leads (README A6, P-8): the drawer of its registration, else — an e-course payment has none — its student; a payment whose
 * registration and student are both gone (their rows were deleted) leads nowhere.
 */
function leadsTo(p: PaymentRow): { href: string; text: string } | null {
  const t = adminEt.payments;
  if (p.registrationId !== null) return { href: `/admin/registreerimised?id=${p.registrationId}`, text: t.openRegistration };
  if (p.clientId !== null) return { href: `/admin/opilased?id=${p.clientId}`, text: t.openStudent };
  return null;
}

/**
 * Maksed (phase 2b, spec 8; A6): the online payments, newest first, 50 a page. The tabs „Maksed“ | „Arved“, the search (name, e-mail, Montonio id,
 * reference), the pills with their counts (B9), and the table of six columns (below 760 px of the card: a card per payment, as the Part 2 phone frame
 * draws it). The Part 2 prototype draws no desktop frame of Maksed, so the columns are the list's own, fitted to the card of a 1180 px laptop: each row
 * is the date (the day it was paid, else the day it was started), the payer (a link to the registration's drawer, or to the student of an e-course
 * payment; the e-mail under it), what it was for (the course, and under it the kind and the session's day), the sum (and under it how it was paid:
 * Pangalink · Swedbank, Kaart …), the status — "Kontrolli Montonios" on a held payment or one voided after it was paid, or its check reason's words
 * („Topeltmakse — tagasta“) — and „Montonios ↗“, which opens Montonio's Partner System and copies the order id (MontonioLink). Read-only: refunds are
 * made in Montonio's own dashboard.
 */
export default async function PaymentsPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const [list, counts] = await Promise.all([
    pagePayments(db, { filter: view.staatus ?? "all", search: view.otsi }, view.leht),
    paymentCounts(db, { search: view.otsi }),
  ]);
  const t = adminEt.payments;
  const partner = montonioPartnerUrl();
  const filtered = view.staatus !== null || view.otsi !== "";

  // each pill goes to the list with that pill chosen and the search kept, from page 1; its count is the rows it then shows (B9)
  const pills: ListPill[] = [
    { key: null, label: t.filter.all, count: counts.all },
    { key: "makstud" as const, label: t.filter.paid, count: counts.makstud },
    { key: "pooleli" as const, label: t.filter.pending, count: counts.pooleli },
    { key: "ebaonnestunud" as const, label: t.filter.failed, count: counts.ebaonnestunud },
    { key: "tagastatud" as const, label: t.filter.refunded, count: counts.tagastatud },
    { key: "kontroll" as const, label: t.filter.held, count: counts.kontroll },
  ].map((p) => ({ href: href({ ...view, staatus: p.key, leht: 1 }), label: p.label, count: p.count, current: view.staatus === p.key }));

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.heading}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
      </div>

      <TabPills
        label={adminEt.nav.payments}
        tabs={[
          { href: "/admin/maksed", label: t.tabs.payments, current: true },
          { href: "/admin/arved", label: t.tabs.invoices, current: false },
        ]}
      />
      <ListToolbar placeholder={t.searchPlaceholder} pillRows={[{ label: t.filterLabel, pills }]} />

      <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
        <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
        {list.rows.length === 0 ? (
          <ListEmpty things={t.things} filtered={filtered} search={view.otsi} clearHref="/admin/maksed" />
        ) : (
          <ListRows>
            <table className={`${ui.table} ${listTable.table} ${styles.list}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.date}</th>
                  <th scope="col">{t.col.payer}</th>
                  <th scope="col">{t.col.what}</th>
                  <th scope="col">{t.col.amount}</th>
                  <th scope="col">{t.col.status}</th>
                  <th scope="col">{t.col.provider}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((p) => {
                  const check = needsCheck(p);
                  // the day it was paid, else the day it was started: the list's own order (db/queries/payments.ts pagePayments)
                  const day = p.paidAt ?? p.createdAt;
                  const lead = leadsTo(p);
                  const course = p.courseTitle ? pick(p.courseTitle, "et") : t.courseGone;
                  const method = paymentMethodText(p);
                  return (
                    <tr key={p.id} className={check ? styles.check : undefined} data-payment={p.reference} data-payment-status={p.status}>
                      <td data-label={t.col.date} className={`${ui.nowrap} ${styles.dateCell}`}>
                        <span>
                          {formatDate(day, "et")}
                          <span className={`${ui.muted} ${styles.sub}`}>{formatTime(day, "et")}</span>
                        </span>
                      </td>
                      <td data-label={t.col.payer} className={styles.whoCell}>
                        <div className={`${listTable.who} ${styles.who}`}>
                          {lead ? (
                            <Link className={listTable.name} href={lead.href} aria-label={fill(t.open, { name: p.name })}>
                              {p.name}
                            </Link>
                          ) : (
                            <span className={`${listTable.name} ${styles.plain}`}>{p.name}</span>
                          )}
                          <a className={`${ui.contactLink} ${styles.contact}`} href={`mailto:${p.email}`}>
                            {p.email}
                          </a>
                        </div>
                        {/* the phone card (below 760 px of the card; the Part 2 phone frame): „19.10 · Lash Lift BOTOX · Pangalink“ under the name and the sum, and where the row leads */}
                        <span className={styles.meta} data-payment-meta="">
                          {[formatDayMonth(day, "et"), course, method].filter(Boolean).join(" · ")}
                        </span>
                        {lead && (
                          <span className={styles.go} aria-hidden="true">
                            {lead.text}
                          </span>
                        )}
                      </td>
                      <td data-label={t.col.what} className={styles.whatCell}>
                        <span className={styles.course}>{course}</span>
                        <span className={`${ui.muted} ${styles.sub}`}>
                          <span data-payment-kind="">{t.kind[p.kind]}</span>
                          {p.startsAt && ` · ${formatDate(p.startsAt, "et")}`}
                        </span>
                      </td>
                      <td data-label={t.col.amount} className={styles.amountCell}>
                        <span className={styles.amount}>{formatEUR(p.amountCents, "et")}</span>
                        {method && (
                          <span className={`${ui.muted} ${styles.sub} ${styles.method}`} data-payment-method="">
                            {method}
                          </span>
                        )}
                      </td>
                      <td data-label={t.col.status} className={styles.statusCell}>
                        <span className={styles.status}>
                          <span className={`${ui.tag} ${PAYMENT_TONE[p.status]}`}>{paymentStatusLabel(p)}</span>
                          {check && (
                            <span className={`${ui.tag} ${ui.bad}`} data-payment-check="">
                              {checkText(p)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td data-label={t.col.provider} className={styles.montonioCell}>
                        {p.providerUuid ? <MontonioLink href={partner} uuid={p.providerUuid} /> : adminEt.common.none}
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
