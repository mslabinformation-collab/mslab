import Link from "next/link";
import { DEFAULT_ACCESS_MONTHS, tallinnToday } from "@/domain/client-access";
import { registrationHeading } from "@/domain/registration-card";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { getDict } from "@/i18n/locales";
import type { ClientDetail, ClientRequestRow, EcourseOption } from "@/server/admin-clients";
import { GrantAccessForm, RevokeAccess, UnlockNextLesson } from "./ClientForms";
import { FeedbackAnswers } from "./FeedbackAnswers";
import { PaymentLines } from "./PaymentLines";
import { ReissueCertificate } from "./ReissueCertificate";
import { ReopenTest } from "./ReopenTest";
import { StatusPill } from "./StatusPill";
import { stepLine } from "./step-line";
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
 * One student in the Õpilased drawer: who she is and "Vaata tema vaadet" (her account page, read-only); her e-courses
 * with "Ava ligipääs" right there (the reason Maria most often opens a student) and, on each open one, "Lõpeta ligipääs",
 * her lessons done ("5/24 tehtud"), her page of that course (read-only) and "Ava järgmine õppetund" while a lesson is still
 * locked for her (an e-course without lessons shows none of these three); on each e-course (e-course completion, spec §5.5) her steps
 * ("Õppetunnid 8/8 · Test: läbitud (85 %) · Praktiline töö: ootab hindamist", or "Lõpetatud 14.11.2026"), "Lisa protokoll" / "Ava protokoll",
 * "Testi katsed" and, while her tries are used up, "Ava test uuesti" (an access an admin ended keeps only its line); her certificate (phase 3d, spec §6): its
 * number and day with Maria's download and "Paranda nimi", or, on a completed access, that she has not confirmed her name yet (an ended access keeps the
 * certificate's line and download, marked "ligipääs tühistatud"); then her registrations
 * (each with a link to its own drawer, a contact course's with its protocol), her online payments (phase 2b), her requests and her contracts
 * (contracts Task 5: the contact course's and the e-course's, each with its PDF), and her feedback answers (the e-courses' too, with the day the access was
 * completed in place of a course day), each with whether she allowed publishing and the review's status (student reviews, Task 4).
 */
export function ClientDetailView({ detail, ecourses, now }: { detail: ClientDetail; ecourses: EcourseOption[]; now: Date }) {
  const t = adminEt.clients.drawer;
  const g = adminEt.clients.grant;
  const r = adminEt.clients.revoke;
  const reopen = { ...adminEt.assessment.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };
  const ct = adminEt.certificates.drawer;
  const reissue = { ...adminEt.certificates.reissue, saving: adminEt.common.saving, error: adminEt.common.saveError };
  const c = detail.client;
  const open = new Map(detail.access.filter((a) => a.state === "active").map((a) => [a.courseId, a.expiresAt]));
  // the first e-course she cannot open now: the likeliest one to grant
  const first = ecourses.find((e) => !open.has(e.id)) ?? ecourses[0];
  const untitled = getDict("et").account.dashboard.untitled;
  // a course she has open already says until when (granting it again moves the day)
  const courseLabel = (e: EcourseOption) => {
    const title = e.published ? pick(e.title, "et") : `${pick(e.title, "et")} (${g.draft})`;
    const until = open.get(e.id);
    return until ? `${title} ${fill(g.openUntil, { date: formatDate(until, "et") })}` : title;
  };

  return (
    <div className={styles.detail} data-client-detail={c.id}>
      <div className={styles.head}>
        <h2 className={ui.h2}>{c.name || t.noName}</h2>
        <p className={styles.meta}>
          <a className={ui.contactLink} href={`mailto:${c.email}`}>
            {c.email}
          </a>
          {c.phone && (
            <a className={ui.contactLink} href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>
              {c.phone}
            </a>
          )}
        </p>
        <p className={`${ui.muted} ${ui.small}`}>
          {fill(t.created, { date: formatDate(c.createdAt, "et") })} · {t.locale} {c.locale === "ru" ? adminEt.common.locale.ru : adminEt.common.locale.et}
        </p>
        <p className={`${ui.muted} ${ui.small}`} data-client-newsletter={detail.newsletter}>
          {fill(t.newsletter, { state: t.newsletterStates[detail.newsletter] })}
        </p>
        {detail.suppressed && (
          <p className={`${ui.small} ${styles.suppressed}`} data-client-suppressed="">
            {adminEt.newsletter.suppressed}
          </p>
        )}
        <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/opilased/${c.id}/vaade`} data-view-as="">
          {t.viewAs}
        </Link>
      </div>

      <section className={styles.section} aria-labelledby={`client-${c.id}-access`} data-client-access="">
        <h3 id={`client-${c.id}-access`} className={ui.h3}>
          {t.access}
        </h3>
        {detail.access.length === 0 ? (
          <p className={styles.none}>{t.noAccess}</p>
        ) : (
          <ul className={styles.rows}>
            {detail.access.map((a) => {
              const title = pick(a.title, "et");
              const until = formatDate(a.state === "revoked" && a.revokedAt ? a.revokedAt : a.expiresAt, "et");
              const line = stepLine(a.steps, adminEt.clients.steps, a.testPercent);
              // an access an admin ended keeps its line (her history); its screens answer "not found", so nothing opens from it
              const live = a.state !== "revoked";
              return (
                <li key={a.id} className={styles.row} data-access={a.courseId} data-access-state={a.state}>
                  <div className={styles.rowHead}>
                    <strong>{title}</strong>
                    <span id={`access-${a.id}-state`} tabIndex={-1} className={`${ui.tag} ${a.state === "active" ? ui.ok : a.state === "revoked" ? ui.bad : ""}`}>
                      {fill(t.state[a.state], { date: until })}
                    </span>
                  </div>
                  <p className={styles.meta}>{fill(t.grantedBy, { who: a.grantedBy === "payment" ? t.byPayment : a.grantedBy, date: stamp(a.grantedAt) })}</p>
                  {a.progress.total > 0 && (
                    <p className={styles.meta} data-access-progress="">
                      {fill(t.progress, a.progress)}
                    </p>
                  )}
                  {/* her steps of the course (e-course completion, spec §5.5): lessons, test, practical work, or "Lõpetatud" with its day */}
                  {line && (
                    <p className={styles.meta} data-access-steps="">
                      {line}
                    </p>
                  )}
                  {/* her certificate (phase 3d, spec §6): the number and day, the name printed, Maria's download and "Paranda nimi"; an access an
                      admin ended keeps the line and the download, marked (Review Focus 5); a completed access without one says she has not
                      confirmed her name yet */}
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
                  {/* her page of the course answers 404 without active access, as her own does: no link to it otherwise */}
                  {a.state === "active" && a.progress.total > 0 && (
                    <Link className={ui.link} href={`/admin/opilased/${c.id}/vaade/${a.slug}`} aria-label={fill(t.viewCourseLabel, { course: title })} data-view-course={a.courseId}>
                      {t.viewCourse}
                    </Link>
                  )}
                  {/* her practical work's protocol (Maria may write it before the student sends: "Lisa protokoll") and her test attempts */}
                  {live && (
                    <div className={styles.links}>
                      <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?ligipaas=${a.id}`} data-access-protocol="">
                        {a.protocolId === null ? adminEt.clients.addProtocol : adminEt.clients.openProtocol}
                      </Link>
                      {a.hasAttempts && (
                        <Link className={ui.link} href={`/admin/hindamine/test?ligipaas=${a.id}`} data-access-attempts="">
                          {adminEt.clients.attempts}
                        </Link>
                      )}
                    </div>
                  )}
                  {live && a.steps.test && <ReopenTest accessId={a.id} course={title} used={a.steps.test.state === "used"} t={reopen} />}
                  {a.state === "active" && (
                    <UnlockNextLesson
                      clientId={c.id}
                      courseId={a.courseId}
                      lesson={a.nextLocked ? { id: a.nextLocked.id, title: pick(a.nextLocked.title, "et") } : null}
                      t={{ ...adminEt.clients.unlock, saving: adminEt.common.saving, error: adminEt.common.saveError }}
                    />
                  )}
                  <RevokeAccess
                    clientId={c.id}
                    accessId={a.id}
                    course={title}
                    active={a.state === "active"}
                    stateId={`access-${a.id}-state`}
                    t={{ ...r, saving: adminEt.common.saving, error: adminEt.common.saveError }}
                  />
                </li>
              );
            })}
          </ul>
        )}
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
      </section>

      <section className={styles.section} aria-labelledby={`client-${c.id}-regs`} data-client-registrations="">
        <h3 id={`client-${c.id}-regs`} className={ui.h3}>
          {t.registrations}
        </h3>
        {detail.registrations.length === 0 ? (
          <p className={styles.none}>{t.noRegistrations}</p>
        ) : (
          <ul className={styles.rows}>
            {detail.registrations.map((reg) => {
              const h = registrationHeading(reg, untitled);
              return (
                <li key={reg.id} className={styles.row} data-client-registration={reg.id}>
                  <div className={styles.rowHead}>
                    <strong>{h.title}</strong>
                    <StatusPill status={reg.status} />
                  </div>
                  {(h.time || h.place) && <p className={styles.meta}>{[h.time, h.place].filter(Boolean).join(", ")}</p>}
                  <Link className={ui.link} href={`/admin/registreerimised?id=${reg.id}`}>
                    {t.openRegistration}
                  </Link>
                  {/* the course day's protocol of a contact registration (e-course completion, spec §5.5: the entry point Maria asked for); the
                      condition is the Registreerimised drawer's */}
                  {reg.contact && reg.status !== "cancelled" && (
                    <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?registreering=${reg.id}`} data-registration-protocol="">
                      {reg.protocolId === null ? adminEt.clients.addProtocol : adminEt.clients.openProtocol}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby={`client-${c.id}-payments`} data-client-payments="">
        <h3 id={`client-${c.id}-payments`} className={ui.h3}>
          {adminEt.payments.title}
        </h3>
        {detail.payments.length === 0 ? <p className={styles.none}>{adminEt.payments.noneForClient}</p> : <PaymentLines rows={detail.payments} withWhat />}
      </section>

      {/* her answers to the course feedback form (phase protocols, spec §7), newest first */}
      <section className={styles.section} aria-labelledby={`client-${c.id}-feedback`} data-client-feedback="">
        <h3 id={`client-${c.id}-feedback`} className={ui.h3}>
          {adminEt.feedback.section}
        </h3>
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
      </section>

      <section className={styles.section} aria-labelledby={`client-${c.id}-reqs`} data-client-requests="">
        <h3 id={`client-${c.id}-reqs`} className={ui.h3}>
          {t.requests}
        </h3>
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
      </section>

      {/* her contracts (contracts Task 5, spec §4): the contact course's and the e-course's, the newest acceptance first, a superseded one marked; this
          list is where Maria sees a purchaser's e-course contract too (the terms gate's list did not hold her). A contact contract links to its
          registration's drawer, where she can send a copy or ask again; an e-course contract has no drawer of its own */}
      <section className={styles.section} aria-labelledby={`client-${c.id}-contracts`} data-client-contracts="">
        <h3 id={`client-${c.id}-contracts`} className={ui.h3}>
          {t.contracts}
        </h3>
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
      </section>
    </div>
  );
}
