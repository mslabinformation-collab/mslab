"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { checkCertificateName } from "@/domain/certificate";
import type { CourseSteps, StepState } from "@/domain/completion";
import { fill, formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import type { CertificateView } from "@/server/certificates";
import type { EcourseTexts } from "./texts";
import styles from "./CompletionSteps.module.css";

type CompletionTexts = EcourseTexts["completion"];
type CertificateTexts = EcourseTexts["certificate"];
type StepKey = "lessons" | "test" | "practical" | "done";
/** One row: the step, its state, its name, its one line, and where it leads (nothing while it is locked, nor for the lessons and the end). */
type Row = { key: StepKey; state: StepState; name: string; line: string; link: { to: string; label: string; main: boolean } | null };

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** A step she has to act in now: its link opens it ("Ava …"); otherwise the link shows her results. */
const acts = (state: StepState): boolean => state === "open" || state === "fix";

/** The test's line: why it waits, the tries left, Maria's turn, a fix, passed, or no tries left (spec §4.2's words). */
function testLine(state: StepState, triesLeft: number | null, c: CompletionTexts): string {
  switch (state) {
    case "locked":
      return c.lockedLessons;
    case "open":
      return triesLeft === null ? c.open : fill(c.testOpen, { n: triesLeft });
    case "review":
      return c.testReview;
    case "fix":
      return c.testFix;
    case "done":
      return c.testDone;
    case "used":
      return c.testUsed;
  }
}

/** The practical work's line; locked, it waits for the test, or (a course without questions) for the lessons. */
function practicalLine(state: StepState, hasTest: boolean, c: CompletionTexts): string {
  switch (state) {
    case "locked":
      return hasTest ? c.lockedTest : c.lockedLessons;
    case "review":
      return c.practicalReview;
    case "fix":
      return c.practicalFix;
    case "done":
      return c.practicalDone;
    default:
      return c.practicalOpen;
  }
}

/** The certificate in an answer of POST …/tunnistus (a 200's, or a 409 "already"'s): its view; null for anything that is not one. */
function certificateOf(value: unknown): CertificateView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "number" || typeof v.number !== "string" || typeof v.name !== "string" || typeof v.issuedAt !== "string") return null;
  return { id: v.id, number: v.number, name: v.name, issuedAt: v.issuedAt, reissuedAt: typeof v.reissuedAt === "string" ? v.reissuedAt : null };
}

/**
 * "Tunnistus" (phase 3d, spec §5), the row after "Lõpetatud" once the course is completed.
 * - **Before the certificate is made:** "Kontrolli, kuidas su nimi tunnistusel kirjas on", the field "Nimi tunnistusel" (her account's name
 *   to start with) with its hint "Ladina tähtedega, nagu passis." under it, always shown and named by the field's `aria-describedby` (her
 *   account's name may be in Cyrillic, which the rule refuses only on submit), and "Kinnita ja koosta tunnistus". The button checks the name
 *   here first (domain/certificate.ts checkCertificateName, the server's own rule), then POSTs it once; a second press waits for the first.
 * - **The answer:** its certificate, made now or by another of her devices first ("already"), turns the row into "Tunnistus nr. {number}"
 *   (which takes the focus), "Laadi tunnistus alla (PDF)" (a plain download link; the API names the file) and "Kui nimes on viga, kirjuta
 *   meile", to the contact page; the name is hers to change no more. A refusal is put in words under the hint, apart from it.
 * - **Its button** is the page's one primary (every step is done by now), unless "Jätka" is on the page (`quiet`: a lesson added after the
 *   completion); it is then an outline one.
 * `readOnly` (the admin's view as client): the same row, nothing to type, press or follow.
 */
function CertificateRow({ slug, mark, certificate, startName, locale, t, readOnly, quiet }: {
  slug: string;
  /** The row's number in the list, shown in its mark until the certificate is made. */
  mark: number;
  certificate: CertificateView | null;
  startName: string;
  locale: Locale;
  t: CertificateTexts;
  readOnly: boolean;
  quiet: boolean;
}) {
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();
  const [made, setMade] = useState<CertificateView | null>(null);
  const [name, setName] = useState(startName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // one request at a time, also between two quick presses (state is read after the render)
  const sending = useRef(false);
  const issued = made ?? certificate;
  const button = `${quiet ? ui.btnOutline : ui.btn} ${styles.action} ${styles.main}`;

  const issue = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || sending.current) return;
    const checked = checkCertificateName(name);
    if (!checked.ok) return setError(checked.error === "letters" ? t.letters : t.length);
    sending.current = true;
    setBusy(true);
    setError("");
    const answer = await sendJson(`/api/konto/kursus/${encodeURIComponent(slug)}/tunnistus`, { name: checked.name });
    sending.current = false;
    setBusy(false);
    const view = certificateOf(answer.data.certificate);
    // made now, or by another of her devices first: either way the one she has
    if (view && (isDone(answer) || answer.data.error === "already")) return setMade(view);
    if (answer.status === 400 && answer.data.error === "name") return setError(answer.data.reason === "letters" ? t.letters : t.length);
    setError(answer.status === 429 ? t.rate : t.failed);
  };

  return (
    <li className={styles.step} data-step-state={issued ? "done" : "open"} data-certificate="">
      <span className={styles.mark} aria-hidden="true">
        {issued ? <Icon name="check" size={16} /> : mark}
      </span>
      <div className={styles.body}>
        <p className={styles.name}>{t.title}</p>
        {issued ? (
          <>
            <p ref={made ? focusOnMount : undefined} className={`${styles.line} ${styles.number}`} tabIndex={-1} data-certificate-number="">
              {fill(t.number, { number: issued.number })}
            </p>
            {readOnly ? (
              <span className={button} aria-disabled="true" data-certificate-download="">
                {t.download}
              </span>
            ) : (
              <a className={button} href={`/api/konto/tunnistus/${issued.id}`} download data-certificate-download="">
                {t.download}
              </a>
            )}
            {readOnly ? (
              <span className={`${ui.link} ${styles.fix}`} aria-disabled="true" data-certificate-contact="">
                {t.fixName}
              </span>
            ) : (
              <Link className={`${ui.link} ${styles.fix}`} href={href(locale, "/kontakt")} data-certificate-contact="">
                {t.fixName}
              </Link>
            )}
          </>
        ) : (
          <form className={styles.certificate} onSubmit={issue} noValidate>
            <p className={styles.line}>{t.check}</p>
            <div className={styles.field}>
              <label htmlFor={nameId}>{t.nameLabel}</label>
              <input
                id={nameId}
                name="certificateName"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={readOnly}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${hintId} ${errorId}`}
                data-certificate-name=""
              />
            </div>
            <p id={hintId} className={styles.hint} data-certificate-hint="">
              {t.nameHint}
            </p>
            <p id={errorId} className={styles.error} role="alert" data-certificate-error="">
              {error}
            </p>
            {readOnly ? (
              <span className={button} aria-disabled="true" data-certificate-issue="">
                {t.issue}
              </span>
            ) : (
              <button type="submit" className={button} aria-disabled={busy || undefined} data-certificate-issue="">
                {busy ? t.issuing : t.issue}
              </button>
            )}
          </form>
        )}
      </div>
    </li>
  );
}

/**
 * "Lõpetamine" on the e-course page (e-course completion, spec §4.1), below the modules: Õppetunnid → Teadmiste test → Praktiline töö →
 * Lõpetatud. Each step: a round mark (its number while ahead, ✓ done, a lock while it waits), its name, its state in one line (a locked
 * step says why), and once open the way in — the test's page, the practical work's page. A step the course does not have (`steps.test` /
 * `steps.practical` null) is not shown. The link of the step she acts in is the page's one button once the lessons are done ("Jätka" is
 * gone by then); every other link is a text link. `protocolSent` (an e-course without points whose notes Maria sent, spec §4.3): "Vaata
 * protokolli", to the practical page that shows her notes. `readOnly` (the admin's view as client): the links are there and do nothing.
 * Once the course is completed the "Tunnistus" row follows "Lõpetatud" (CertificateRow, phase 3d): `certificate` once made, else her
 * account's name in its field (`certificateName`). Every step is done by then, so its button is the page's one primary, unless "Jätka" is
 * on the page (`resumeShown`: a lesson added after the completion).
 */
export function CompletionSteps({
  slug,
  steps,
  protocolSent,
  certificate,
  certificateName,
  resumeShown = false,
  locale,
  t,
  readOnly,
}: {
  slug: string;
  steps: CourseSteps;
  protocolSent: boolean;
  certificate: CertificateView | null;
  certificateName: string;
  resumeShown?: boolean;
  locale: Locale;
  t: EcourseTexts;
  readOnly: boolean;
}) {
  const c = t.completion;
  const headingId = useId();
  const base = `/konto/kursus/${slug}`;
  const lessonsDone = steps.lessons.state === "done";
  const rows: Row[] = [
    {
      key: "lessons",
      state: steps.lessons.state,
      name: c.steps.lessons,
      line: lessonsDone ? c.lessonsDone : fill(c.lessonsOpen, { done: steps.lessons.done, total: steps.lessons.total }),
      link: null,
    },
  ];
  if (steps.test) {
    const { state, triesLeft } = steps.test;
    rows.push({
      key: "test",
      state,
      name: c.steps.test,
      line: testLine(state, triesLeft, c),
      link: state === "locked" ? null : { to: `${base}/test`, label: acts(state) ? c.openTest : c.viewResult, main: acts(state) && lessonsDone },
    });
  }
  if (steps.practical) {
    const { state } = steps.practical;
    rows.push({
      key: "practical",
      state,
      name: c.steps.practical,
      line: practicalLine(state, steps.test !== null, c),
      // at most one primary button: when the test is hers to act in too (Maria added questions while the work was at "fix"), the test's is it
      link: state === "locked" ? null : { to: `${base}/praktiline`, label: acts(state) ? c.openPractical : c.viewPractical, main: acts(state) && lessonsDone && !rows.some((r) => r.link?.main) },
    });
  }
  rows.push({
    key: "done",
    state: steps.completedAt ? "done" : "locked",
    name: c.steps.done,
    line: steps.completedAt ? fill(c.completedOn, { date: formatDate(new Date(steps.completedAt), locale) }) : c.doneLocked,
    link: null,
  });

  /** A step's way in: a link, or (read-only) the same look doing nothing, as the page's "Jätka". */
  const way = (link: NonNullable<Row["link"]>) => {
    const cls = link.main ? `${ui.btn} ${styles.action} ${styles.main}` : `${ui.link} ${styles.action}`;
    const label = (
      <>
        {link.label}
        {link.main && <Icon name="arrow" />}
      </>
    );
    return readOnly ? (
      <span className={cls} aria-disabled="true" data-step-link="">
        {label}
      </span>
    ) : (
      <Link className={cls} href={href(locale, link.to)} data-step-link="">
        {label}
      </Link>
    );
  };

  return (
    <section className={styles.block} aria-labelledby={headingId} data-completion="">
      <h2 id={headingId} className={styles.title}>
        {c.title}
      </h2>
      <ol className={styles.steps}>
        {rows.map((row, i) => (
          <li key={row.key} className={styles.step} data-step={row.key} data-step-state={row.state}>
            <span className={styles.mark} aria-hidden="true">
              {row.state === "done" ? <Icon name="check" size={16} /> : row.state === "locked" ? <Icon name="lock" size={16} /> : i + 1}
            </span>
            <div className={styles.body}>
              <p className={styles.name} data-step-name="">
                {row.name}
              </p>
              <p className={styles.line} data-step-line="">
                {row.line}
              </p>
              {row.link && way(row.link)}
            </div>
          </li>
        ))}
        {steps.completedAt !== null && (
          <CertificateRow
            slug={slug}
            mark={rows.length + 1}
            certificate={certificate}
            startName={certificateName}
            locale={locale}
            t={t.certificate}
            readOnly={readOnly}
            quiet={resumeShown}
          />
        )}
      </ol>
      {protocolSent && (
        <p className={styles.protocol}>
          {readOnly ? (
            <span className={ui.btnOutline} aria-disabled="true" data-view-protocol="">
              {c.viewProtocol}
            </span>
          ) : (
            <Link className={ui.btnOutline} href={href(locale, `${base}/praktiline`)} data-view-protocol="">
              {c.viewProtocol}
            </Link>
          )}
        </p>
      )}
    </section>
  );
}
