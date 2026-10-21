import type { Metadata } from "next";
import Link from "next/link";
import { ContractBlock } from "@/components/admin/ContractBlock";
import { contractView, type ContractView } from "@/components/admin/contract-view";
import { Drawer } from "@/components/admin/Drawer";
import { FeedbackAnswers } from "@/components/admin/FeedbackAnswers";
import { InvoiceBlock, type UninvoicedView } from "@/components/admin/InvoiceBlock";
import { invoiceView } from "@/components/admin/invoice-view";
import { Pager } from "@/components/admin/Pager";
import { PaymentLines } from "@/components/admin/PaymentLines";
import { RegistrationForms } from "@/components/admin/RegistrationForms";
import { adminTitle } from "@/components/admin/sections";
import { ListRows } from "@/components/admin/ListRows";
import listTable from "@/components/admin/list-table.module.css";
import { StatusPill } from "@/components/admin/StatusPill";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { getRegistration, pageRegistrations, type RegistrationFilter, type RegistrationRow } from "@/db/queries/admin";
import { listPaymentsOf, type PaymentRow } from "@/db/queries/payments";
import { feedbackOf, type FeedbackRow } from "@/db/queries/protocols";
import { tallinnFormParts } from "@/domain/calendar";
import { coveringInvoices, openAmounts, sellerReady, uninvoicedOf } from "@/domain/invoice";
import { formatEUR } from "@/domain/money";
import { parsePage } from "@/domain/paging";
import { prepaymentDue, registrationPrice, type RegStatus } from "@/domain/registration";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { contractsOfRegistration } from "@/server/contracts";
import { getInvoiceSettings, invoicesOfRegistration, type AdminInvoice } from "@/server/invoices";
import styles from "./registrations.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.registrations) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?vorm=e|k (as the public catalogue), ?staatus=ootab|kinnitatud|tuhistatud, ?leht=<n> (50 a page),
// ?id=<registration> (drawer). A new filter starts again at page 1; the drawer keeps the page it was opened from.
const FORMS = { e: "e_learning", k: "contact" } as const;
const STATUS_PARAM: Record<string, RegStatus> = { ootab: "awaiting_prepayment", kinnitatud: "confirmed", tuhistatud: "cancelled" };
const PARAM_OF: Record<RegStatus, string> = { awaiting_prepayment: "ootab", confirmed: "kinnitatud", cancelled: "tuhistatud" };

type View = { vorm: "e" | "k" | null; staatus: RegStatus | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View & { id: number | null } {
  const vorm = one(sp.vorm);
  const staatus = one(sp.staatus);
  const id = Number(one(sp.id));
  return {
    vorm: vorm === "e" || vorm === "k" ? vorm : null,
    // (own keys only: "constructor" or "__proto__" in the address must not read the object's prototype, as on Maksed)
    staatus: staatus && Object.hasOwn(STATUS_PARAM, staatus) ? STATUS_PARAM[staatus] : null,
    leht: parsePage(sp.leht),
    id: Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null,
  };
}

function href(view: View, id?: number): string {
  const q = new URLSearchParams();
  if (view.vorm) q.set("vorm", view.vorm);
  if (view.staatus) q.set("staatus", PARAM_OF[view.staatus]);
  if (view.leht > 1) q.set("leht", String(view.leht));
  if (id) q.set("id", String(id));
  const s = q.toString();
  return `/admin/registreerimised${s ? `?${s}` : ""}`;
}

const tel = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/** Where and when: the session of a group registration; an individual one has its time agreed; e-learning has none. */
function sessionText(r: RegistrationRow, withTime = false): string {
  const t = adminEt.registrations;
  if (r.course.type === "e_learning") return adminEt.common.none;
  if (r.kind === "individual") return t.agreed;
  const s = r.courseSession;
  if (!s) return adminEt.common.none;
  return [formatDate(s.startsAt, "et") + (withTime ? ` ${formatTime(s.startsAt, "et")}` : ""), s.city, withTime ? s.venue : ""].filter(Boolean).join(", ");
}

/**
 * Registrations (A4): Kõik / E-õpe / Kontaktõpe at the top, a status filter, the table, and a drawer per registration
 * with the payment that has arrived (status recomputed: confirmed from 50%), status + note, and "Tühista".
 */
export default async function RegistrationsPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const filter: RegistrationFilter = { type: view.vorm ? FORMS[view.vorm] : undefined, status: view.staatus ?? undefined };
  const now = new Date();
  const [list, open, online, answers, invoiceList, invoiceSeller, contractList] = await Promise.all([
    pageRegistrations(db, filter, view.leht),
    view.id ? getRegistration(db, view.id) : null,
    view.id ? listPaymentsOf(db, { registrationId: view.id }) : [],
    view.id ? feedbackOf(db, { registrationId: view.id }) : [],
    // the drawer's „Arved“ (invoices Task 5): the registration's invoices, and whether Seaded → Arve andmed has a seller to make one
    view.id ? invoicesOfRegistration(db, view.id) : [],
    view.id ? getInvoiceSettings(db, now) : null,
    // the drawer's „Leping“ (contracts Task 5): the registration's contracts, the current one first
    view.id ? contractsOfRegistration(db, view.id) : [],
  ]);
  const rows = list.rows;
  const t = adminEt.registrations;
  const filtered = view.vorm !== null || view.staatus !== null;

  const typeLinks: { key: View["vorm"]; label: string }[] = [
    { key: null, label: t.type.all },
    { key: "e", label: t.type.e },
    { key: "k", label: t.type.k },
  ];
  const statusLinks: { key: RegStatus | null; label: string }[] = [
    { key: null, label: t.statusAll },
    { key: "awaiting_prepayment", label: t.status.awaiting_prepayment },
    { key: "confirmed", label: t.status.confirmed },
    { key: "cancelled", label: t.status.cancelled },
  ];

  return (
    <>
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>

        <nav className={ui.filters} aria-label={t.typeLabel} data-type-filter="">
          {typeLinks.map((l) => (
            <Link key={l.label} className={ui.pill} href={href({ ...view, vorm: l.key, leht: 1 })} aria-current={view.vorm === l.key ? "true" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <nav className={ui.filters} aria-label={t.statusLabel} data-status-filter="">
          <span className={ui.filtersLabel} aria-hidden="true">
            {t.statusLabel}:
          </span>
          {statusLinks.map((l) => (
            <Link
              key={l.label}
              className={`${ui.pill} ${ui.pillSmall}`}
              href={href({ ...view, staatus: l.key, leht: 1 })}
              aria-current={view.staatus === l.key ? "true" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <section className={`${ui.card} ${listTable.card} ${listTable.stackAt980}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {rows.length === 0 ? (
            <p className={ui.empty}>{filtered ? t.emptyFiltered : t.empty}</p>
          ) : (
            <ListRows>
              <table className={`${ui.table} ${listTable.table}`}>
                <thead>
                  <tr>
                    <th scope="col">{t.col.date}</th>
                    <th scope="col">{t.col.name}</th>
                    <th scope="col">{t.col.kind}</th>
                    <th scope="col">{t.col.course}</th>
                    <th scope="col">{t.col.session}</th>
                    <th scope="col">{t.col.payment}</th>
                    <th scope="col">{t.col.modelHelp}</th>
                    <th scope="col">{t.col.account}</th>
                    <th scope="col">{t.col.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-registration={r.id}>
                      <td data-label={t.col.date} className={ui.nowrap}>
                        <span>
                          {formatDate(r.createdAt, "et")}
                          <span className={`${ui.muted} ${styles.sub}`}>{formatTime(r.createdAt, "et")}</span>
                        </span>
                      </td>
                      <td data-label={t.col.name}>
                        <div className={listTable.who}>
                          <Link id={`reg-${r.id}`} className={listTable.name} href={href(view, r.id)} scroll={false} aria-label={fill(t.open, { name: r.name })}>
                            {r.name}
                          </Link>
                          <a className={`${ui.contactLink} ${styles.contact}`} href={`mailto:${r.email}`}>
                            {r.email}
                          </a>
                          {r.phone && (
                            <a className={`${ui.contactLink} ${styles.contact}`} href={tel(r.phone)}>
                              {r.phone}
                            </a>
                          )}
                        </div>
                      </td>
                      <td data-label={t.col.kind}>
                        <span className={styles.kind}>
                          <span className={`${ui.tag} ${r.course.type === "e_learning" ? ui.dark : ""}`}>{r.course.type === "e_learning" ? t.type.e : t.type.k}</span>
                          {r.course.type === "contact" && <span className={styles.participation}>{r.kind === "group" ? t.group : t.individual}</span>}
                        </span>
                      </td>
                      <td data-label={t.col.course}>{pick(r.course.title, "et")}</td>
                      <td data-label={t.col.session}>{sessionText(r)}</td>
                      <td data-label={t.col.payment} className={ui.nowrap}>
                        {t.payment[r.paymentChoice]}
                      </td>
                      <td data-label={t.col.modelHelp}>{r.wantsModelHelp ? adminEt.common.yes : adminEt.common.none}</td>
                      <td data-label={t.col.account}>{r.wantsAccount ? adminEt.common.yes : adminEt.common.none}</td>
                      <td data-label={t.col.status}>
                        <StatusPill status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListRows>
          )}
          <Pager info={list} href={(n) => href({ ...view, leht: n })} />
        </section>
      </div>

      {view.id !== null && (
        <Drawer
          label={open ? fill(t.drawer.label, { name: open.name }) : t.drawer.notFound}
          closeHref={href(view)}
          closeLabel={adminEt.common.close}
          returnFocus={open ? `reg-${open.id}` : undefined}
        >
          {open ? (
            <RegistrationDetail
              r={open}
              payments={online}
              feedback={answers[0] ?? null}
              invoices={invoiceList}
              contracts={contractList.map(contractView)}
              sellerReady={invoiceSeller !== null && sellerReady(invoiceSeller)}
              today={tallinnFormParts(now).date}
            />
          ) : (
            <p className={ui.empty}>{t.drawer.notFound}</p>
          )}
        </Drawer>
      )}
    </>
  );
}

function RegistrationDetail({
  r,
  payments,
  feedback,
  invoices,
  contracts,
  sellerReady: seller,
  today,
}: {
  r: RegistrationRow;
  payments: PaymentRow[];
  feedback: FeedbackRow | null;
  invoices: AdminInvoice[];
  contracts: ContractView[];
  sellerReady: boolean;
  today: string;
}) {
  const t = adminEt.registrations.drawer;
  // its paid online payments that no invoice names yet („Arveta maksed“, the final review's I1): listed on the block with their own catch-up,
  // and counted as covered — their money is in Laekunud summa — so „Koosta arve“ never offers it again (coveringInvoices, as createInvoice does)
  const uninvoiced = uninvoicedOf(payments, invoices);
  const uninvoicedViews: UninvoicedView[] = uninvoiced.map((p) => {
    const linked = invoices.find((i) => i.id === p.invoiceId && i.status === "unpaid" && i.amountCents === p.amountCents);
    return { paymentId: p.id, amountCents: p.amountCents, paidAt: (p.paidAt ?? p.createdAt).toISOString(), pays: linked ? linked.number : null };
  });
  const yesNo = (v: boolean) => (v ? adminEt.common.yes : adminEt.common.no);
  const total = registrationPrice(r.course, r.kind);
  const half = total == null ? null : prepaymentDue(total, "half");
  const details: [string, React.ReactNode][] = [
    [t.email, <a key="e" className={ui.contactLink} href={`mailto:${r.email}`}>{r.email}</a>],
    [t.phone, r.phone ? <a key="p" className={ui.contactLink} href={tel(r.phone)}>{r.phone}</a> : adminEt.common.none],
    [t.course, pick(r.course.title, "et")],
    [t.session, sessionText(r, true)],
    [t.type, r.course.type === "e_learning" ? adminEt.registrations.type.e : adminEt.registrations.type.k],
    [t.kind, r.course.type === "e_learning" ? adminEt.common.none : r.kind === "group" ? t.group : t.individual],
    [t.created, `${formatDate(r.createdAt, "et")} ${formatTime(r.createdAt, "et")}`],
    [t.locale, r.locale === "ru" ? adminEt.common.locale.ru : adminEt.common.locale.et],
    [t.payment, r.paymentChoice === "full" ? t.paymentFull : t.paymentHalf],
    [t.modelHelp, yesNo(r.wantsModelHelp)],
    [t.account, yesNo(r.wantsAccount)],
  ];
  if (r.preferredPeriod) details.push([t.period, r.preferredPeriod]);
  if (r.message) details.push([t.message, r.message]);

  return (
    <div className={styles.detail} data-registration-detail={r.id}>
      <div className={styles.detailHead}>
        <StatusPill status={r.status} />
        <h2 className={ui.h2}>{r.name}</h2>
        <p className={ui.muted}>{pick(r.course.title, "et")}</p>
        {/* the protocol of a contact course's registration (phase protocols, spec §4): one tap to its screen */}
        {r.course.type === "contact" && r.status !== "cancelled" && (
          <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?registreering=${r.id}`} data-registration-protocol="">
            {adminEt.protocols.openOne}
          </Link>
        )}
      </div>

      <section className={styles.money} aria-label={t.priceTitle}>
        {total == null ? (
          <p className={ui.notice}>{t.noPrice}</p>
        ) : (
          <dl className={styles.moneyList}>
            <div>
              <dt>{t.price}</dt>
              <dd>{formatEUR(total, "et")}</dd>
            </div>
            <div>
              <dt>{t.half}</dt>
              <dd>{formatEUR(half!, "et")}</dd>
            </div>
            <div>
              <dt>{t.due}</dt>
              <dd>{formatEUR(prepaymentDue(total, r.paymentChoice), "et")}</dd>
            </div>
            <div>
              <dt>{t.paid}</dt>
              <dd data-paid="">{formatEUR(r.paidCents, "et")}</dd>
            </div>
          </dl>
        )}
        {/* the online payments under "Laekunud" (phase 2b, spec 8); Maria's own "amount received" form below stays */}
        {payments.length > 0 && (
          <div className={styles.online} data-registration-payments="">
            <h3 className={ui.h3}>{adminEt.payments.online}</h3>
            <PaymentLines rows={payments} />
          </div>
        )}
      </section>

      {/* the registration's invoices, its paid payments without one, and „Koosta arve“ (invoices Task 5, spec §5): the amounts still open are those
          no unpaid or paid invoice, nor such a payment, covers; money typed into „Laekunud summa“ by hand is offered as a receipt only (m4) */}
      <InvoiceBlock
        registrationId={r.id}
        invoices={invoices.map(invoiceView)}
        uninvoiced={uninvoicedViews}
        open={
          total == null
            ? { request: [], receipt: [] }
            : openAmounts({ priceCents: total, paymentChoice: r.paymentChoice, paidCents: r.paidCents }, coveringInvoices(r, invoices, uninvoiced))
        }
        sellerReady={seller}
        canCreate={total != null}
        today={today}
      />

      {/* the registration's contract (contracts Task 5, spec §4): a group registration on a contact course has one (the form's tick), an individual
          one and an e-learning one do not (D1) */}
      {r.course.type === "contact" && r.kind === "group" && (
        <ContractBlock
          registrationId={r.id}
          contracts={contracts}
          requestedAt={r.contractRequestedAt ? r.contractRequestedAt.toISOString() : null}
          linked={r.clientId !== null}
          cancelled={r.status === "cancelled"}
        />
      )}

      {/* her answers to the course feedback form (phase protocols, spec §7): none, or the one */}
      {feedback && (
        <section className={styles.feedback} aria-label={adminEt.feedback.section} data-registration-feedback="">
          <h3 className={ui.h3}>{adminEt.feedback.section}</h3>
          <FeedbackAnswers answers={feedback.answers} locale={feedback.locale} submittedAt={feedback.submittedAt} />
        </section>
      )}

      <RegistrationForms
        id={r.id}
        status={r.status}
        note={r.note}
        paidCents={r.paidCents}
        t={{
          paidLabel: t.paidLabel,
          paidHint: half == null ? t.noPriceHint : fill(t.paidHint, { half: formatEUR(half, "et") }),
          paidSave: t.paidSave,
          paidSaved: t.paidSaved,
          paidInvalid: t.paidInvalid,
          statusLabel: t.statusLabel,
          noteLabel: t.noteLabel,
          noteHint: t.noteHint,
          noteTooLong: t.noteTooLong,
          statusSave: t.statusSave,
          statusSaved: t.statusSaved,
          stale: t.stale,
          cancel: t.cancel,
          cancelled: t.cancelled,
          saving: adminEt.common.saving,
          error: adminEt.common.saveError,
          status: adminEt.registrations.status,
        }}
      />

      <h3 className={`${ui.h3} ${styles.detailsTitle}`}>{t.details}</h3>
      <dl className={styles.dl}>
        {details.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
