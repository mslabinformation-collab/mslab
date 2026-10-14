"use client";

import Link from "next/link";
import { useId } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import type { CourseSteps, StepState } from "@/domain/completion";
import { fill, formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import type { EcourseTexts } from "./texts";
import styles from "./CompletionSteps.module.css";

type CompletionTexts = EcourseTexts["completion"];
type StepKey = "lessons" | "test" | "practical" | "done";
/** One row: the step, its state, its name, its one line, and where it leads (nothing while it is locked, nor for the lessons and the end). */
type Row = { key: StepKey; state: StepState; name: string; line: string; link: { to: string; label: string; main: boolean } | null };

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

/**
 * "Lõpetamine" on the e-course page (e-course completion, spec §4.1), below the modules: Õppetunnid → Teadmiste test → Praktiline töö →
 * Lõpetatud. Each step: a round mark (its number while ahead, ✓ done, a lock while it waits), its name, its state in one line (a locked
 * step says why), and once open the way in — the test's page, the practical work's page. A step the course does not have (`steps.test` /
 * `steps.practical` null) is not shown. The link of the step she acts in is the page's one button once the lessons are done ("Jätka" is
 * gone by then); every other link is a text link. `protocolSent` (an e-course without points whose notes Maria sent, spec §4.3): "Vaata
 * protokolli", to the practical page that shows her notes. `readOnly` (the admin's view as client): the links are there and do nothing.
 */
export function CompletionSteps({ slug, steps, protocolSent, locale, t, readOnly }: { slug: string; steps: CourseSteps; protocolSent: boolean; locale: Locale; t: EcourseTexts; readOnly: boolean }) {
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
