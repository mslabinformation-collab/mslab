import type { Metadata } from "next";
import Link from "next/link";
import { ContractBlock } from "@/components/admin/ContractBlock";
import { contractView, type ContractView } from "@/components/admin/contract-view";
import { Drawer } from "@/components/admin/Drawer";
import { FeedbackAnswers } from "@/components/admin/FeedbackAnswers";
import { FoldRow } from "@/components/admin/FoldRow";
import { InvoiceBlock, type UninvoicedView } from "@/components/admin/InvoiceBlock";
import { invoiceView } from "@/components/admin/invoice-view";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill, type ListScope } from "@/components/admin/ListToolbar";
import { Pager } from "@/components/admin/Pager";
import { MoneyCard } from "@/components/admin/MoneyCard";
import { NoteSaveStatus, RegistrationCancel, RegistrationNote, StatusAndNote } from "@/components/admin/RegistrationForms";
import { PaymentLines } from "@/components/admin/PaymentLines";
import { adminTitle } from "@/components/admin/sections";
import { ListRows } from "@/components/admin/ListRows";
import listTable from "@/components/admin/list-table.module.css";
import { StatusPill } from "@/components/admin/StatusPill";
import ui from "@/components/admin/ui.module.css";
import { getDb, type Db } from "@/db/client";
import {
  getRegistration,
  listRegistrationScopes,
  pageRegistrations,
  registrationCounts,
  type RegistrationFilter,
  type RegistrationRow,
} from "@/db/queries/admin";
import { listPaymentsOf, type PaymentRow } from "@/db/queries/payments";
import { feedbackOf, type FeedbackRow } from "@/db/queries/protocols";
import { seatsTaken } from "@/db/queries/seats";
import { tallinnFormParts } from "@/domain/calendar";
import { coveringInvoices, openAmounts, receiptTakeBack, sellerReady, uninvoicedOf } from "@/domain/invoice";
import { euro, euroBare } from "@/domain/money-text";
import { parsePage, parseSearch } from "@/domain/paging";
import { registrationPrice, type RegStatus } from "@/domain/registration";
import { holdsSeat } from "@/domain/sessions";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatDayMonth, formatTime } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { contractsOfRegistration } from "@/server/contracts";
import { getInvoiceSettings, invoicesOfRegistration, type AdminInvoice } from "@/server/invoices";
import { noteVersion } from "@/server/registration-note";
import styles from "./registrations.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.registrations) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses (README A2, §1.10): ?otsi=<text> (the search across name, e-mail and phone, B7), ?koolitus=<course id> or ?toimumine=<session id> (the scope
// select: one or the other, a session wins), ?vorm=e|k (as the public catalogue), ?staatus=ootab|kinnitatud|tuhistatud, ?leht=<n> (50 a page),
// ?id=<registration> (drawer). A new search, scope or filter starts again at page 1; the drawer keeps all of them, and the page it was opened from.
const FORMS = { e: "e_learning", k: "contact" } as const;
const STATUS_PARAM: Record<string, RegStatus> = { ootab: "awaiting_prepayment", kinnitatud: "confirmed", tuhistatud: "cancelled" };
const PARAM_OF: Record<RegStatus, "ootab" | "kinnitatud" | "tuhistatud"> = { awaiting_prepayment: "ootab", confirmed: "kinnitatud", cancelled: "tuhistatud" };

type View = {
  vorm: "e" | "k" | null;
  staatus: RegStatus | null;
  otsi: string;
  /** The scope: one course, or one session (never both). */
  koolitus: number | null;
  toimumine: number | null;
  leht: number;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
/** A record id from the address: a whole number from 1 to the largest the database holds, else null. */
const idOf = (v: string | string[] | undefined) => {
  const n = Number(one(v));
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
};

function parse(sp: Search): View & { id: number | null } {
  const vorm = one(sp.vorm);
  const staatus = one(sp.staatus);
  return {
    vorm: vorm === "e" || vorm === "k" ? vorm : null,
    // (own keys only: "constructor" or "__proto__" in the address must not read the object's prototype, as on Maksed)
    staatus: staatus && Object.hasOwn(STATUS_PARAM, staatus) ? STATUS_PARAM[staatus] : null,
    otsi: parseSearch(sp.otsi),
    koolitus: idOf(sp.koolitus),
    toimumine: idOf(sp.toimumine),
    leht: parsePage(sp.leht),
    id: idOf(sp.id),
  };
}

function href(view: View, id?: number): string {
  const q = new URLSearchParams();
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.toimumine) q.set("toimumine", String(view.toimumine));
  else if (view.koolitus) q.set("koolitus", String(view.koolitus));
  if (view.staatus) q.set("staatus", PARAM_OF[view.staatus]);
  if (view.vorm) q.set("vorm", view.vorm);
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

/** The list's second line under the course (the prototype's „12.12 · Tallinn“): the session's day and city; no session: the form says what it is. */
function listSession(r: RegistrationRow): string {
  const t = adminEt.registrations;
  if (r.course.type === "e_learning") return t.type.e;
  if (r.kind === "individual") return t.agreed;
  const s = r.courseSession;
  return s ? `${formatDayMonth(s.startsAt, "et")} · ${s.city}` : adminEt.common.none;
}

/** „Laekunud“: „{paid} / {price} €“ (the euro sign once, after the price); a course with no price: the money alone. */
function paidText(r: RegistrationRow): string {
  const price = registrationPrice(r.course, r.kind);
  if (price == null) return euro(r.paidCents);
  return fill(adminEt.registrations.paidOf, { paid: euroBare(r.paidCents), price: euro(price) });
}

/** The indent of a session under its course in the scope select: two no-break spaces (a browser cuts plain ones off an option's text). */
const INDENT = String.fromCharCode(160, 160);

/**
 * Registrations (A2): the toolbar (search across name, e-mail and phone, the course / session scope, the status and form pills with their
 * counts), the table of five columns (below 760 px of the card: a card per registration), and a drawer per registration (RegistrationDetail: Raha with
 * „Lisa laekumine“, the status pills and the autosaved note, the invoices, the folded rows Leping, Tagasiside and Registreerimise andmed, and
 * „Tühista registreerimine“).
 */
export default async function RegistrationsPage({ searchParams }: Props) {
  await requireAdmin();
  const parsed = parse(await searchParams);
  const db = getDb();
  const now = new Date();
  const scopes = await listRegistrationScopes(db, now);
  // the scope is one that exists (an old link to a removed course or session lists everything), and a session wins over its course
  const hasSession = scopes.some((s) => s.sessions.some((x) => x.id === parsed.toimumine));
  const hasCourse = scopes.some((s) => s.course.id === parsed.koolitus);
  const view: View = { ...parsed, toimumine: hasSession ? parsed.toimumine : null, koolitus: !hasSession && hasCourse ? parsed.koolitus : null };
  const filter: RegistrationFilter = {
    type: view.vorm ? FORMS[view.vorm] : undefined,
    status: view.staatus ?? undefined,
    search: view.otsi || undefined,
    courseId: view.koolitus ?? undefined,
    sessionId: view.toimumine ?? undefined,
  };
  const openId = parsed.id;
  const [list, counts, open, online, answers, invoiceList, invoiceSeller, contractList] = await Promise.all([
    pageRegistrations(db, filter, view.leht),
    registrationCounts(db, filter),
    openId ? getRegistration(db, openId) : null,
    openId ? listPaymentsOf(db, { registrationId: openId }) : [],
    openId ? feedbackOf(db, { registrationId: openId }) : [],
    // the drawer's „Arved“ (invoices Task 5): the registration's invoices, and whether Seaded → Arve andmed has a seller to make one
    openId ? invoicesOfRegistration(db, openId) : [],
    openId ? getInvoiceSettings(db, now) : null,
    // the drawer's „Leping“ (contracts Task 5): the registration's contracts, the current one first
    openId ? contractsOfRegistration(db, openId) : [],
  ]);
  // the drawer's Raha card counts its session's seats now; its note is drawn with the version a save must come from (Task 5)
  const [openSeats, openNoteVersion] = open ? await Promise.all([seatsOf(db, open, now), noteVersion(open.note)]) : [null, ""];
  const rows = list.rows;
  const t = adminEt.registrations;
  const filtered = view.vorm !== null || view.staatus !== null || view.otsi !== "" || view.koolitus !== null || view.toimumine !== null;

  // each pill goes to the list with that pill chosen and the rest as it is (the search too), from page 1. The status pills carry the count of what they
  // then show (B9); the form pills, drawn light, have none (README A2: counts on the status pills only)
  const statusPills: ListPill[] = [
    { key: null, label: t.statusAll, count: counts.status.all },
    { key: "awaiting_prepayment" as const, label: t.status.awaiting_prepayment, count: counts.status.ootab },
    { key: "confirmed" as const, label: t.status.confirmed, count: counts.status.kinnitatud },
    { key: "cancelled" as const, label: t.status.cancelled, count: counts.status.tuhistatud },
  ].map((p) => ({ href: href({ ...view, staatus: p.key, leht: 1 }), label: p.label, count: p.count, current: view.staatus === p.key }));
  const typePills: ListPill[] = [
    { key: null, label: t.type.all },
    { key: "e" as const, label: t.type.e },
    { key: "k" as const, label: t.type.k },
  ].map((p) => ({ href: href({ ...view, vorm: p.key, leht: 1 }), label: p.label, current: view.vorm === p.key }));
  const scope: ListScope = {
    label: t.col.course,
    value: view.toimumine !== null ? `s${view.toimumine}` : view.koolitus !== null ? `k${view.koolitus}` : "",
    options: [
      { value: "", label: t.scopeAll, href: href({ ...view, koolitus: null, toimumine: null, leht: 1 }) },
      ...scopes.flatMap(({ course, sessions }) => [
        { value: `k${course.id}`, label: pick(course.title, "et"), href: href({ ...view, koolitus: course.id, toimumine: null, leht: 1 }) },
        ...sessions.map((s) => ({
          value: `s${s.id}`,
          label: `${INDENT}${formatDate(s.startsAt, "et")} ${s.city}`,
          href: href({ ...view, koolitus: null, toimumine: s.id, leht: 1 }),
        })),
      ]),
    ],
  };

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

        <ListToolbar
          placeholder={t.searchPlaceholder}
          scope={scope}
          pillRows={[
            { label: t.statusLabel, pills: statusPills },
            { label: t.typeLabel, pills: typePills, tone: "light" },
          ]}
        />

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {rows.length === 0 ? (
            <ListEmpty things={t.things} filtered={filtered} search={view.otsi} clearHref="/admin/registreerimised" />
          ) : (
            <ListRows>
              <table className={`${ui.table} ${listTable.table} ${styles.list}`}>
                <thead>
                  <tr>
                    <th scope="col">{t.col.date}</th>
                    <th scope="col">{t.col.name}</th>
                    <th scope="col">{t.col.course}</th>
                    <th scope="col">{t.col.paid}</th>
                    <th scope="col">{t.col.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-registration={r.id} className={r.id === openId ? styles.selected : undefined}>
                      <td data-label={t.col.date} className={`${ui.nowrap} ${styles.date}`}>
                        {formatDate(r.createdAt, "et")}
                      </td>
                      <td data-label={t.col.name} className={styles.whoCell}>
                        <div className={listTable.who}>
                          <Link id={`reg-${r.id}`} className={listTable.name} href={href(view, r.id)} scroll={false} aria-label={fill(t.open, { name: r.name })}>
                            {r.name}
                          </Link>
                          {r.phone && (
                            <a className={`${ui.contactLink} ${styles.contact}`} href={tel(r.phone)}>
                              {r.phone}
                            </a>
                          )}
                        </div>
                      </td>
                      <td data-label={t.col.course} className={styles.courseCell}>
                        <span className={styles.course}>{pick(r.course.title, "et")}</span>
                        <span className={styles.session}>{listSession(r)}</span>
                      </td>
                      <td data-label={t.col.paid} data-paid-word={t.paidWord} className={`${ui.nowrap} ${styles.paid}`}>
                        {paidText(r)}
                      </td>
                      <td data-label={t.col.status} className={styles.statusCell}>
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

      {openId !== null && (
        <Drawer
          label={open ? fill(t.drawer.label, { name: open.name }) : t.drawer.notFound}
          closeHref={href(view)}
          closeLabel={adminEt.common.close}
          returnFocus={open ? `reg-${open.id}` : undefined}
        >
          {open ? (
            <RegistrationDetail
              key={open.id}
              r={open}
              session={openSeats}
              noteVersion={openNoteVersion}
              payments={online}
              feedback={answers[0] ?? null}
              invoices={invoiceList}
              contracts={contractList.map(contractView)}
              sellerReady={invoiceSeller !== null && sellerReady(invoiceSeller)}
              takesSeat={holdsSeat(open, now)}
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

/** The drawer header's line (README A2 drawer 1): „{course} · {date time} · {city, venue} · {Grupp|Individuaal}“; without a session P-4's. */
function headerLine(r: RegistrationRow): string {
  const t = adminEt.registrations;
  const course = pick(r.course.title, "et");
  if (r.course.type === "e_learning") return [course, t.type.e].join(" · ");
  if (r.kind === "individual") return [course, t.agreed, t.individual].join(" · ");
  const s = r.courseSession;
  const when = s ? `${formatDate(s.startsAt, "et")} ${formatTime(s.startsAt, "et")}` : "";
  const where = s ? [s.city, s.venue].filter(Boolean).join(", ") : "";
  return [course, when, where, t.group].filter(Boolean).join(" · ");
}

/** The seats of a group registration's session now (anyone's: the public count), for the Raha card; null without a session. */
async function seatsOf(db: Db, r: RegistrationRow, now: Date): Promise<{ taken: number; capacity: number } | null> {
  const s = r.courseSession;
  if (!s || r.course.type !== "contact" || r.kind !== "group") return null;
  return { taken: (await seatsTaken(db, [s.id], now)).get(s.id) ?? 0, capacity: s.capacity };
}

/**
 * A registration's drawer, in README A2's order (piece 2, Tasks 5 and 6): the header (the status pill, the note's SaveStatus left of the
 * Drawer's ✕, the name, the course and the session, the phone and the e-mail, „Ava protokoll“ for a contact course); Raha (MoneyCard, with „Lisa
 * laekumine“); „Staatus ja märkus“; Arved (a section; a folded row on a phone); the folded rows (FoldRow, 52 px, each with a one-line summary, P-3)
 * Leping, Tagasiside and Registreerimise andmed; and „Tühista registreerimine“. The note's engine is around the whole drawer (RegistrationNote): its
 * status chip is in the header, its field in „Staatus ja märkus“.
 */
function RegistrationDetail({
  r,
  session,
  noteVersion: version,
  payments,
  feedback,
  invoices,
  contracts,
  sellerReady: seller,
  takesSeat,
  today,
}: {
  r: RegistrationRow;
  session: { taken: number; capacity: number } | null;
  noteVersion: string;
  payments: PaymentRow[];
  feedback: FeedbackRow | null;
  invoices: AdminInvoice[];
  contracts: ContractView[];
  sellerReady: boolean;
  /** The registration holds a seat of its session now (confirmed, or awaiting with a live hold: domain/sessions.ts holdsSeat): cancelling frees it at once. */
  takesSeat: boolean;
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
  // „Võta tasumine tagasi“ of a receipt (S3-f) says what it will do: the sum the server takes off Laekunud summa (capped at what no other paid invoice
  // covers) and whether a confirmed registration then falls under 50 % — domain/invoice.ts receiptTakeBack, the server's own rule
  const invoiceOf = (inv: AdminInvoice) => {
    const view = invoiceView(inv);
    return view.status === "paid" && view.dueAt === null && !view.online ? { ...view, takeBack: receiptTakeBack(r, total, inv, invoices, uninvoiced) } : view;
  };
  const details: [string, React.ReactNode][] = [
    [t.email, <a key="e" className={ui.contactLink} href={`mailto:${r.email}`}>{r.email}</a>],
    [t.phone, r.phone ? <a key="p" className={ui.contactLink} href={tel(r.phone)}>{r.phone}</a> : adminEt.common.none],
    [t.course, pick(r.course.title, "et")],
    [t.session, sessionText(r, true)],
    [t.type, r.course.type === "e_learning" ? adminEt.registrations.type.e : adminEt.registrations.type.k],
    [t.kind, r.course.type === "e_learning" ? adminEt.common.none : r.kind === "group" ? t.group : t.individual],
    [t.created, `${formatDate(r.createdAt, "et")} ${formatTime(r.createdAt, "et")}`],
    [t.locale, r.locale === "ru" ? adminEt.common.locale.ru : adminEt.common.locale.et],
    [t.payment, { full: t.paymentFull, half: t.paymentHalf, financing: t.paymentFinancing }[r.paymentChoice]],
    [t.modelHelp, yesNo(r.wantsModelHelp)],
    [t.account, yesNo(r.wantsAccount)],
  ];
  if (r.preferredPeriod) details.push([t.period, r.preferredPeriod]);
  if (r.message) details.push([t.message, r.message]);
  // her answers to the course feedback form (phase protocols, spec §7): a contact course's registration has none, or the one
  const showFeedback = feedback !== null || r.course.type === "contact";

  return (
    <RegistrationNote id={r.id} note={r.note} version={version}>
      <div className={styles.detail} data-registration-detail={r.id}>
        <header className={styles.detailHead}>
          <div className={styles.headTop}>
            <StatusPill status={r.status} />
            <NoteSaveStatus />
          </div>
          <h2 className={styles.name}>{r.name}</h2>
          <p className={styles.headLine} data-registration-line="">
            {headerLine(r)}
          </p>
          <div className={styles.contacts}>
            {r.phone && (
              <a className={`${ui.contactLink} ${styles.headContact}`} href={tel(r.phone)}>
                {r.phone}
              </a>
            )}
            <a className={`${ui.contactLink} ${styles.headContact}`} href={`mailto:${r.email}`}>
              {r.email}
            </a>
          </div>
          {/* the protocol of a contact course's registration (phase protocols, spec §4): one tap to its screen */}
          {r.course.type === "contact" && r.status !== "cancelled" && (
            <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?registreering=${r.id}`} data-registration-protocol="">
              {adminEt.protocols.openOne}
            </Link>
          )}
        </header>

        <MoneyCard
          registration={{ id: r.id, paidCents: r.paidCents, priceCents: total, status: r.status, cancelled: r.status === "cancelled", choice: r.paymentChoice }}
          session={session}
          takesSeat={takesSeat}
          sellerReady={seller}
          paymentLines={payments.length > 0 ? <PaymentLines rows={payments} /> : null}
          today={today}
        />

        <StatusAndNote id={r.id} status={r.status} />

        <div className={styles.rest}>
          {/* the registration's invoices, its paid payments without one, and „Koosta arve“ (invoices Task 5, spec §5): the amounts still open are those
              no unpaid or paid invoice, nor such a payment, covers; money recorded with „Lisa laekumine“ and no receipt is offered as a receipt only.
              A folded row on a phone (README A2 phone drawer) */}
          <InvoiceBlock
            registrationId={r.id}
            invoices={invoices.map(invoiceOf)}
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

          {/* the folded rows (README A2 drawer 5; 52 px, „▸“, each with a one-line summary, P-3) */}
          <div className={styles.folds}>
            {/* the registration's contract (contracts Task 5, spec §4): a group registration on a contact course has one (the form's tick), an
                individual one and an e-learning one do not (D1) */}
            {r.course.type === "contact" && r.kind === "group" && (
              <ContractBlock
                registrationId={r.id}
                contracts={contracts}
                requestedAt={r.contractRequestedAt ? r.contractRequestedAt.toISOString() : null}
                linked={r.clientId !== null}
                cancelled={r.status === "cancelled"}
              />
            )}

            {showFeedback && (
              <FoldRow title={adminEt.feedback.section} summary={feedback ? fill(adminEt.feedback.submitted, { date: formatDate(feedback.submittedAt, "et") }) : adminEt.feedback.foldNone}>
                {feedback ? (
                  <div className={styles.feedback} data-registration-feedback="">
                    <FeedbackAnswers answers={feedback.answers} locale={feedback.locale} submittedAt={feedback.submittedAt} />
                  </div>
                ) : (
                  <p className={ui.muted}>{adminEt.feedback.none}</p>
                )}
              </FoldRow>
            )}

            <FoldRow title={t.details} summary={fill(t.rows, { n: details.length })}>
              <dl className={styles.dl}>
                {details.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </FoldRow>
          </div>
        </div>

        <RegistrationCancel
          id={r.id}
          name={r.name}
          status={r.status}
          seat={r.courseSession && takesSeat ? `${formatDayMonth(r.courseSession.startsAt, "et")} ${r.courseSession.city}` : null}
          paidCents={r.paidCents}
          hasInvoices={invoices.length > 0}
        />
      </div>
    </RegistrationNote>
  );
}
