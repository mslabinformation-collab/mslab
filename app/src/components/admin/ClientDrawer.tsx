import Link from "next/link";
import { addMonths, DEFAULT_ACCESS_MONTHS, extendBase, MAX_ACCESS_YEARS, tallinnToday } from "@/domain/client-access";
import { formatEUR } from "@/domain/money";
import { registrationHeading } from "@/domain/registration-card";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatDayMonth, formatTime } from "@/i18n/format";
import { getDict } from "@/i18n/locales";
import type { ClientAccessRow, ClientDetail, ClientRegistrationRow, ClientRequestRow, EcourseOption } from "@/server/admin-clients";
import { AccessActions } from "./AccessActions";
import { GrantAccessForm } from "./ClientForms";
import { FeedbackAnswers } from "./FeedbackAnswers";
import { FoldRow } from "./FoldRow";
import { PaymentLines } from "./PaymentLines";
import { ReissueCertificate } from "./ReissueCertificate";
import { ReopenTest } from "./ReopenTest";
import { StatusPill } from "./StatusPill";
import { stepLine, stepLineShort } from "./step-line";
import ui from "./ui.module.css";
import styles from "./ClientDrawer.module.css";

/** The Päringud tab of each request kind (/admin/paringud?liik=…). */
const REQUEST_TAB = { contact: "kontakt", individual: "individuaal", practice: "praktika", waitlist: "ootenimekiri", change_request: "muutmine" } as const;

const stamp = (d: Date) => `${formatDate(d, "et")} ${formatTime(d, "et")}`;

/** A request named as Päringud names it: the wish of a change request, "E-õppe huvi" for the cart's purchase request, else its tab. */
function requestLabel(q: ClientRequestRow): string {
  if (q.wish) return adminEt.requests.wish[q.wish];
  if (q.interest) return adminEt.requests.interest;
  return adminEt.requests.tabs[REQUEST_TAB[q.kind]];
}

/**
 * Text that is shorter on a phone (the Part 2 phone frame: „E-ÕPE · AVATUD KUNI …“ for „E-ÕPE“, „3/3 · test läbitud · praktiline ootab“, „Registreering“ for „Ava
 * registreering“). The page holds one text, the wide one; `short` is the phone's, put in its place by the stylesheet below the drawer's 640 px (generated content from
 * `data-short`). So whoever reads the page's text — a test, a copy — sees one label, not two, and a screen reader reads the one that is drawn.
 */
function Swap({ wide, short }: { wide: string; short: string }) {
  return (
    <span className={styles.swap} data-swap="" data-short={short}>
      <span className={styles.wide} data-wide="">
        {wide}
      </span>
    </span>
  );
}

/**
 * One student in the Õpilased drawer (admin UX pass, README A5, the Part 2 prototype): who she is — name, phone, e-mail and one line "Konto loodud … · Keel … ·
 * Uudiskiri: …" — and "Vaata tema vaadet" (her account page, read-only); then "Koolitused", one list of her e-course accesses and her registrations,
 * newest first, a card each; then the folded rows "Ava ligipääs e-koolitusele", "Maksed", "Lepingud", "Päringud" and "Tagasiside", each with what is in it.
 *
 * - An e-course card: the kicker ("E-õpe"), the course, the pill ("Avatud kuni …", "Läbitud …" for a completed course — also one that has run out since —,
 *   "Ligipääs lõppes …" for one that ran out by date, "Ligipääs lõpetatud …" for one an admin ended), her steps ("Õppetunnid 8/8 · Test läbitud (85 %) ·
 *   Praktiline töö ootab hindamist": the lessons, the test, the practical work; none for a completed course), who opened it, her certificate (its number and day,
 *   Maria's download and "Paranda nimi", or that she has not confirmed her name yet; an ended access keeps the line and the download, marked "ligipääs
 *   tühistatud"), and the actions (AccessActions: "Hinda", "Pikenda ▾", "Veel ▾"; "Ava test uuesti" while her tries are used up). An access an admin ended
 *   keeps its history and nothing to open.
 * - A registration's card: the kicker ("Kontaktõpe · 14.11.2026 Pärnu", "Kontaktõpe · Aeg kokkuleppel", "E-õpe"), the course, the status, "Ava registreering"
 *   and, on a contact course's, "Ava protokoll" / "Lisa protokoll" (the course day's protocol: e-course completion, spec §5.5; the condition is the Registreerimised
 *   drawer's).
 * - On a phone (the drawer's 640 px) a card has no pill — its state is in the kicker ("E-õpe · Avatud kuni 17.03.2027") —, the steps are the short line
 *   and a registration's buttons are "Registreering" and "Protokoll".
 * - Folded rows, each with a one-line summary: how many (her online payments with the sum paid), her contracts (the contact course's and the e-course's, the newest
 *   acceptance first, a superseded one marked; an e-course contract has no drawer of its own), her requests, and her feedback answers (the e-courses' too, with the day the
 *   access was completed in place of a course day), each with whether she allowed publishing and the review's status (student reviews, Task 4).
 */
export function ClientDetailView({ detail, ecourses, now }: { detail: ClientDetail; ecourses: EcourseOption[]; now: Date }) {
  const t = adminEt.clients.drawer;
  const g = adminEt.clients.grant;
  const c = detail.client;
  const open = new Map(detail.access.filter((a) => a.state === "active").map((a) => [a.courseId, a.expiresAt]));
  // the first e-course she cannot open now: the likeliest one to grant
  const first = ecourses.find((e) => !open.has(e.id)) ?? ecourses[0];
  const untitled = getDict("et").account.dashboard.untitled;
  // „Pikenda“'s day field ends where the grant form's does: 10 years from today
  const extendMax = addMonths(tallinnToday(now), MAX_ACCESS_YEARS * 12)!;
  // „{course} · mustand · avatud kuni {date}“ (README A5): a draft is marked, a course she has open already says until when (granting it again moves the day)
  const courseLabel = (e: EcourseOption) => {
    const until = open.get(e.id);
    return [pick(e.title, "et"), e.published ? null : g.draft, until ? fill(g.openUntil, { date: formatDate(until, "et") }) : null].filter((x): x is string => x !== null).join(" · ");
  };

  // one list, newest first: an access by the day it was opened (or opened again), a registration by the day it was made
  type Item = { at: number; id: number; access?: ClientAccessRow; registration?: ClientRegistrationRow };
  const items: Item[] = [
    ...detail.access.map((a): Item => ({ at: a.grantedAt.getTime(), id: a.id, access: a })),
    ...detail.registrations.map((r): Item => ({ at: r.createdAt.getTime(), id: r.id, registration: r })),
  ].sort((x, y) => y.at - x.at || (x.access ? 0 : 1) - (y.access ? 0 : 1) || y.id - x.id);

  const paid = detail.payments.filter((p) => p.status === "paid").reduce((sum, p) => sum + p.amountCents, 0);

  return (
    <div className={styles.detail} data-client-detail={c.id}>
      <div className={styles.head}>
        <h2 className={ui.h2}>{c.name || t.noName}</h2>
        <p className={styles.meta}>
          {c.phone && (
            <a className={`${ui.contactLink} ${styles.headContact}`} href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>
              {c.phone}
            </a>
          )}
          <a className={`${ui.contactLink} ${styles.headContact}`} href={`mailto:${c.email}`}>
            {c.email}
          </a>
        </p>
        <p className={styles.account}>
          {fill(t.created, { date: formatDate(c.createdAt, "et") })} · {t.locale} {c.locale === "ru" ? adminEt.common.locale.ru : adminEt.common.locale.et} ·{" "}
          <span data-client-newsletter={detail.newsletter}>{fill(t.newsletter, { state: t.newsletterStates[detail.newsletter] })}</span>
        </p>
        <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/opilased/${c.id}/vaade`} data-view-as="">
          {t.viewAs}
        </Link>
      </div>

      <section className={styles.courses} aria-labelledby={`client-${c.id}-courses`} data-client-courses="">
        <h3 id={`client-${c.id}-courses`} className={ui.h3}>
          {t.courses}
        </h3>
        {items.length === 0 ? (
          <p className={styles.none}>{fill(adminEt.lists.empty, { Asju: t.coursesThing })}</p>
        ) : (
          <ul className={styles.cards}>
            {items.map((i) =>
              i.access ? (
                <AccessCard key={`a${i.id}`} clientId={c.id} a={i.access} now={now} extendMax={extendMax} />
              ) : (
                <RegistrationCard key={`r${i.id}`} r={i.registration!} untitled={untitled} />
              ),
            )}
          </ul>
        )}
      </section>

      <div className={styles.folds}>
        {/* the existing form, in a row of its own (README A5): "Ava ligipääs e-koolitusele", "vali koolitus" */}
        <FoldRow title={g.fold} summary={first ? g.foldSummary : ""}>
          {first ? (
            <GrantAccessForm
              clientId={c.id}
              courses={ecourses.map((e) => ({ id: e.id, label: courseLabel(e), until: e.until, defaulted: !e.accessMonths }))}
              initialCourseId={first.id}
              today={tallinnToday(now)}
              t={{ ...g, untilHintDefault: fill(g.untilHintDefault, { n: DEFAULT_ACCESS_MONTHS }), saving: adminEt.common.saving, error: adminEt.common.saveError }}
            />
          ) : (
            <p className={ui.notice}>{g.noCourses}</p>
          )}
        </FoldRow>

        {/* her online payments (phase 2b), newest first: how many, and the sum paid */}
        <FoldRow title={adminEt.payments.title} summary={detail.payments.length === 0 ? "0" : [detail.payments.length, formatEUR(paid, "et")].join(" · ")}>
          <div data-client-payments="">
            {detail.payments.length === 0 ? <p className={styles.none}>{adminEt.payments.noneForClient}</p> : <PaymentLines rows={detail.payments} withWhat />}
          </div>
        </FoldRow>

        {/* her contracts (contracts Task 5, spec §4): the contact course's and the e-course's, the newest acceptance first, a superseded one marked; this
            list is where Maria sees a purchaser's e-course contract too (the terms gate's list did not hold her). A contact contract links to its
            registration's drawer, where she can send a copy or ask again; an e-course contract has no drawer of its own */}
        <FoldRow title={t.contracts} summary={String(detail.contracts.length)}>
          <div data-client-contracts="">
            {detail.contracts.length === 0 ? (
              <p className={styles.none}>{t.noContracts}</p>
            ) : (
              <ul className={styles.rows}>
                {detail.contracts.map((k) => (
                  <li key={k.id} className={styles.row} data-client-contract={k.id} data-contract-state={k.supersededAt ? "superseded" : "current"}>
                    <div className={styles.rowHead}>
                      <strong>{k.title || adminEt.contracts.title}</strong>
                      {k.supersededAt && <span className={ui.tag}>{fill(adminEt.contracts.block.superseded, { date: formatDate(new Date(k.supersededAt), "et") })}</span>}
                    </div>
                    <p className={styles.meta}>{fill(adminEt.contracts.block.accepted, { date: formatDate(new Date(k.acceptedAt), "et"), way: adminEt.contracts.via[k.acceptedVia] })}</p>
                    <div className={styles.links}>
                      <a className={ui.link} href={`/api/admin/leping/${k.id}`} aria-label={fill(adminEt.contracts.block.downloadLabel, { id: k.id })} data-contract-download={k.id}>
                        {adminEt.contracts.block.download}
                      </a>
                      {k.registrationId !== null && (
                        <Link className={ui.link} href={`/admin/registreerimised?id=${k.registrationId}`} data-contract-registration={k.registrationId}>
                          {t.openRegistration}
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FoldRow>

        <FoldRow title={t.requests} summary={String(detail.requests.length)}>
          <div data-client-requests="">
            {detail.requests.length === 0 ? (
              <p className={styles.none}>{t.noRequests}</p>
            ) : (
              <ul className={styles.rows}>
                {detail.requests.map((q) => (
                  <li key={q.id} className={styles.row} data-client-request={q.id}>
                    <div className={styles.rowHead}>
                      <strong>{requestLabel(q)}</strong>
                      <span className={`${ui.tag} ${q.handled ? ui.ok : ui.warn}`}>{q.handled ? adminEt.requests.handled : adminEt.requests.open}</span>
                    </div>
                    {q.subject && <p className={styles.subject}>{q.subject}</p>}
                    <p className={styles.meta}>{fill(adminEt.requests.received, { date: stamp(q.createdAt) })}</p>
                    <Link className={ui.link} href={`/admin/paringud?liik=${REQUEST_TAB[q.kind]}`}>
                      {t.openRequests}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FoldRow>

        {/* her answers to the course feedback form (phase protocols, spec §7), newest first */}
        <FoldRow title={adminEt.feedback.section} summary={String(detail.feedback.length)}>
          <div data-client-feedback="">
            {detail.feedback.length === 0 ? (
              <p className={styles.none}>{adminEt.feedback.none}</p>
            ) : (
              <ul className={styles.rows}>
                {detail.feedback.map((f) => (
                  <li key={f.id} className={styles.row} data-client-feedback-row={f.id}>
                    <div className={styles.rowHead}>
                      <strong>{pick(f.course.title, "et")}</strong>
                    </div>
                    {f.startsAt && <p className={styles.meta}>{formatDate(f.startsAt, "et")}</p>}
                    {/* an e-course's answer has no course day: the day her access was completed */}
                    {f.completedAt && (
                      <p className={styles.meta} data-feedback-completed="">
                        {fill(adminEt.feedback.completed, { date: formatDate(f.completedAt, "et") })}
                      </p>
                    )}
                    {/* whether she allowed publishing, and what became of it (student reviews, Task 4) */}
                    <p className={styles.meta} data-feedback-review={f.review ? f.review.status : "none"}>
                      {f.review
                        ? fill(f.review.featured ? adminEt.reviews.drawer.allowedFeatured : adminEt.reviews.drawer.allowed, { status: adminEt.reviews.status[f.review.status] })
                        : adminEt.reviews.drawer.notAllowed}
                      {f.review && (
                        <>
                          {" "}
                          <Link className={ui.link} href="/admin/tagasiside?vaade=arvustused" data-feedback-review-link="">
                            {adminEt.reviews.drawer.open}
                          </Link>
                        </>
                      )}
                    </p>
                    <FeedbackAnswers answers={f.answers} locale={f.locale} submittedAt={f.submittedAt} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FoldRow>
      </div>
    </div>
  );
}

/** One e-course access as a card (see ClientDetailView). */
function AccessCard({ clientId, a, now, extendMax }: { clientId: number; a: ClientAccessRow; now: Date; extendMax: string }) {
  const t = adminEt.clients.drawer;
  const title = pick(a.title, "et");
  const reopen = { ...adminEt.assessment.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };
  const ct = adminEt.certificates.drawer;
  const reissue = { ...adminEt.certificates.reissue, saving: adminEt.common.saving, error: adminEt.common.saveError };
  // an access an admin ended keeps its line (her history); its screens answer "not found", so nothing opens from it
  const live = a.state !== "revoked";
  const completed = live && a.completedAt !== null;
  const day = (d: Date) => formatDate(d, "et");
  // the pill: a completed course says so even if its access has run out since; an ended one and one that ran out say which
  const pill = !live
    ? fill(t.state.revoked, { date: day(a.revokedAt ?? a.expiresAt) })
    : completed
      ? fill(t.state.completed, { date: day(a.completedAt!) })
      : fill(a.state === "active" ? t.state.active : t.state.expired, { date: day(a.expiresAt) });
  const tone = !live ? ui.bad : completed || a.state === "active" ? ui.ok : "";
  const stateId = `access-${a.id}-state`;
  const line = stepLine(a.steps, adminEt.clients.steps, a.testPercent);
  const short = stepLineShort(a.steps, adminEt.clients.steps);
  // "Hinda": the practical work (her protocol screen) first, else the test's open answers (the attempt waiting)
  const assessHref = !live
    ? null
    : a.steps.practical?.state === "review"
      ? `/admin/protokollid?ligipaas=${a.id}`
      : a.steps.test?.state === "review" && a.waitingAttemptId !== null
        ? `/admin/hindamine/test?id=${a.waitingAttemptId}`
        : null;

  return (
    <li className={styles.card} data-access={a.courseId} data-access-state={a.state} data-access-completed={completed || undefined}>
      <div className={styles.cardTop}>
        <div className={styles.what}>
          {/* (a phone's card has the state in its kicker, which is where the focus goes once the access is ended there) */}
          <span id={`${stateId}-phone`} tabIndex={-1} className={styles.kicker} data-access-kicker="">
            <Swap wide={adminEt.clients.type.e} short={`${adminEt.clients.type.e} · ${pill}`} />
          </span>
          <strong className={styles.cardTitle}>{title}</strong>
        </div>
        <span id={stateId} tabIndex={-1} className={`${ui.tag} ${tone} ${styles.pill}`} data-access-pill="">
          {pill}
        </span>
      </div>
      {line && (
        <p className={styles.steps} data-access-steps="">
          <Swap wide={line} short={short} />
        </p>
      )}
      <p className={styles.meta}>{fill(t.grantedBy, { who: a.grantedBy === "payment" ? t.byPayment : a.grantedBy, date: stamp(a.grantedAt) })}</p>
      {/* her certificate (phase 3d, spec §6): the number and day, the name printed, Maria's download and "Paranda nimi"; an access an admin ended keeps the
          line and the download, marked (Review Focus 5); a completed access without one says she has not confirmed her name yet */}
      {a.certificate ? (
        <div className={styles.certificate} data-access-certificate={a.certificate.id}>
          <p className={styles.meta}>
            <span>{fill(ct.line, { number: a.certificate.number, date: formatDate(new Date(a.certificate.issuedAt), "et") })}</span>
            {a.certificate.reissuedAt && <span>{fill(ct.reissued, { date: formatDate(new Date(a.certificate.reissuedAt), "et") })}</span>}
            {a.certificate.revoked && (
              <span className={`${ui.tag} ${ui.bad}`} data-certificate-revoked="">
                {ct.revoked}
              </span>
            )}
          </p>
          <p className={styles.meta}>{fill(ct.name, { name: a.certificate.name })}</p>
          <a
            className={ui.link}
            href={`/api/admin/tunnistus/${a.certificate.id}`}
            aria-label={fill(ct.downloadLabel, { number: a.certificate.number })}
            data-certificate-admin-download=""
          >
            {ct.download}
          </a>
          {live && <ReissueCertificate certificateId={a.certificate.id} name={a.certificate.name} t={reissue} />}
        </div>
      ) : (
        live &&
        a.steps.completedAt && (
          <p className={styles.meta} data-access-certificate="">
            {ct.notYet}
          </p>
        )
      )}
      <AccessActions
        clientId={clientId}
        accessId={a.id}
        courseId={a.courseId}
        course={title}
        state={a.state}
        expiresAt={a.expiresAt.toISOString()}
        extendMin={tallinnToday(extendBase(a.expiresAt, now))}
        extendMax={extendMax}
        assessHref={assessHref}
        protocol={{ href: `/admin/protokollid?ligipaas=${a.id}`, label: a.protocolId === null ? adminEt.clients.addProtocol : adminEt.clients.openProtocol }}
        attemptsHref={live && a.hasAttempts ? `/admin/hindamine/test?ligipaas=${a.id}` : null}
        // her page of the course answers 404 without active access, as her own does: no link to it otherwise
        viewHref={a.state === "active" && a.progress.total > 0 ? `/admin/opilased/${clientId}/vaade/${a.slug}` : null}
        lesson={a.state === "active" && a.nextLocked ? { id: a.nextLocked.id, title: pick(a.nextLocked.title, "et") } : null}
        stateId={stateId}
      />
      {live && a.steps.test && <ReopenTest accessId={a.id} course={title} used={a.steps.test.state === "used"} t={reopen} />}
    </li>
  );
}

/** One of her registrations as a card (see ClientDetailView). */
function RegistrationCard({ r, untitled }: { r: ClientRegistrationRow; untitled: Parameters<typeof registrationHeading>[1] }) {
  const t = adminEt.clients.drawer;
  const h = registrationHeading(r, untitled);
  const status = adminEt.registrations.status[r.status];
  const session = r.courseSession;
  // the kicker (P-7): "Kontaktõpe · 14.11.2026 Pärnu"; an individual one has its time agreed; an e-learning one has no place or day
  const form = r.contact ? adminEt.clients.type.k : adminEt.clients.type.e;
  const where =
    r.contact && r.kind === "individual"
      ? { wide: adminEt.registrations.agreed, phone: adminEt.registrations.agreed }
      : r.contact && session
        ? { wide: `${formatDate(session.startsAt, "et")} ${session.city}`, phone: `${formatDayMonth(session.startsAt, "et")} ${session.city}` }
        : null;
  return (
    <li className={styles.card} data-client-registration={r.id}>
      <div className={styles.cardTop}>
        <div className={styles.what}>
          <span className={styles.kicker} data-registration-kicker="">
            <Swap wide={where ? `${form} · ${where.wide}` : form} short={`${[form, where?.phone].filter(Boolean).join(" · ")} · ${status}`} />
          </span>
          <strong className={styles.cardTitle}>{h.title}</strong>
        </div>
        <span className={styles.pill}>
          <StatusPill status={r.status} />
        </span>
      </div>
      <div className={styles.cardButtons}>
        <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/registreerimised?id=${r.id}`} data-registration-open="">
          <Swap wide={t.openRegistration} short={t.openRegistrationShort} />
        </Link>
        {/* the course day's protocol of a contact registration (e-course completion, spec §5.5: the entry point Maria asked for); the condition is the
            Registreerimised drawer's */}
        {r.contact && r.status !== "cancelled" && (
          <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?registreering=${r.id}`} data-registration-protocol="">
            {r.protocolId === null ? adminEt.clients.addProtocol : <Swap wide={adminEt.clients.openProtocol} short={t.openProtocolShort} />}
          </Link>
        )}
      </div>
    </li>
  );
}
