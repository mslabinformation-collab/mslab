"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Icon, type IconName } from "@/components/site/Icon";
import lists from "@/components/site/CourseLists.module.css";
import ui from "@/components/site/ui.module.css";
import type { LessonState } from "@/domain/lessons";
import { fill, formatDate } from "@/i18n/format";
import { pick } from "@/i18n/field";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import type { EcourseView as EcourseData } from "@/server/client-data";
import { CompletionSteps } from "./CompletionSteps";
import { ProgressBar } from "./ProgressBar";
import type { EcourseTexts } from "./texts";
import page from "./EcoursePage.module.css";
import styles from "./EcourseView.module.css";

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** Each lesson state's icon (hidden from screen readers, which hear the state's word instead). */
const STATE_ICON: Record<LessonState, IconName> = { done: "check", current: "play", locked: "lock" };

/** A wider screen than a phone: every module starts open there. */
const WIDE = "(min-width: 768px)";

/**
 * The e-course the client has access to, once the terms are accepted (spec 3a section 5), top to bottom:
 * - the title and "Ligipääs kuni {date}" (Estonian time, as on the dashboard's card);
 * - with lessons: "5 / 24 õppetundi tehtud", a thin bar, and the page's one button, "Jätka" ("Alusta" before the first lesson), to
 *   the next lesson that is open and not done (none when every lesson is done);
 * - the numbered modules (the public course page's look), each with its lessons: ✓ done and ▶ open ones link to their pages, a
 *   locked one is plain text with a lock, and "Avaneb, kui eelmine õppetund on tehtud." stands under the first locked lesson. On a
 *   phone the modules are folded, and the module of the next lesson starts open; on a wider screen every module starts open;
 * - without any lesson yet: the module titles and "Sisu lisandub peagi.";
 * - below them, "Lõpetamine" (CompletionSteps, e-course completion): the path's steps, once the course has lessons (or is completed, or Maria
 *   sent her notes: "Vaata protokolli"); once completed, its "Tunnistus" row (phase 3d), whose button gives way to "Jätka" when that is shown.
 * `focusHeading`: the notice has just been accepted, so the title takes the focus. `readOnly` (the admin's "view as client", rendered
 * by a server component too): nothing is a link, the button and the lesson titles are aria-disabled, and every module is open.
 */
export function EcourseView({
  data,
  locale,
  t,
  focusHeading = false,
  readOnly = false,
}: {
  data: EcourseData;
  locale: Locale;
  t: EcourseTexts;
  focusHeading?: boolean;
  readOnly?: boolean;
}) {
  // read once: the page does not fold or unfold modules under the student's hand when the window changes
  const [wide] = useState(() => readOnly || (typeof window !== "undefined" && window.matchMedia(WIDE).matches));
  const progressId = useId();
  const { slug } = data.course;
  const { done, total, next } = data.progress;
  const lessonHref = (id: number) => href(locale, `/konto/kursus/${slug}/${id}`);
  const progressText = fill(t.progress, { done, total });
  const firstLocked = data.course.modules.flatMap((m) => m.lessons).find((l) => l.state === "locked")?.id;
  const nextLabel = (
    <>
      {done === 0 ? t.begin : t.resume}
      <Icon name="arrow" />
    </>
  );

  return (
    <div className={`${ui.wrap} ${page.page}`} data-ecourse="">
      <h1 ref={focusHeading ? focusOnMount : undefined} className={page.title} tabIndex={-1}>
        {pick(data.course.title, locale)}
      </h1>
      <p className={styles.access} data-ecourse-access="">
        {fill(t.access, { date: formatDate(new Date(data.access.expiresAt), locale) })}
      </p>
      {total > 0 && (
        <div className={styles.progress}>
          <p id={progressId} className={styles.count} data-ecourse-progress="">
            {progressText}
          </p>
          {/* named by the line above (not a second copy of its text) */}
          <ProgressBar done={done} total={total} labelledBy={progressId} />
          {next !== null &&
            (readOnly ? (
              <span className={`${ui.btn} ${styles.next}`} aria-disabled="true" data-ecourse-next="">
                {nextLabel}
              </span>
            ) : (
              <Link className={`${ui.btn} ${styles.next}`} href={lessonHref(next)} data-ecourse-next="">
                {nextLabel}
              </Link>
            ))}
        </div>
      )}
      {data.course.modules.length > 0 && (
        <ol className={styles.modules} data-modules="">
          {data.course.modules.map((m, i) => {
            const head = (
              <>
                <span className={lists.num}>{String(i + 1).padStart(2, "0")}</span>
                <span className={lists.moduleTitle} data-module-title="">
                  {pick(m.title, locale)}
                </span>
              </>
            );
            if (m.lessons.length === 0)
              return (
                <li key={m.id} className={styles.module} data-module={m.id}>
                  <div className={styles.head}>{head}</div>
                </li>
              );
            const doneHere = m.lessons.filter((l) => l.state === "done").length;
            return (
              <li key={m.id} className={styles.module} data-module={m.id}>
                <details className={styles.fold} open={wide || m.lessons.some((l) => l.id === next)}>
                  <summary className={`${styles.head} ${styles.summary}`}>
                    {head}
                    <span className={styles.tally} aria-hidden="true">
                      {doneHere}/{m.lessons.length}
                    </span>
                    <span className={ui.srOnly}>{fill(t.moduleProgress, { done: doneHere, total: m.lessons.length })}</span>
                  </summary>
                  <ol className={styles.lessons}>
                    {m.lessons.map((l) => {
                      const title = pick(l.title, locale);
                      const label = l.state === "done" ? t.stateDone : l.state === "current" ? t.stateCurrent : t.locked;
                      return (
                        <li key={l.id} className={styles.lesson} data-lesson={l.id} data-state={l.state}>
                          <span className={styles.icon}>
                            <Icon name={STATE_ICON[l.state]} size={17} />
                          </span>
                          {l.state === "locked" ? (
                            <span className={styles.title}>{title}</span>
                          ) : readOnly ? (
                            <span className={styles.title} aria-disabled="true">
                              {title}
                            </span>
                          ) : (
                            <Link className={styles.title} href={lessonHref(l.id)}>
                              {title}
                            </Link>
                          )}
                          <span className={ui.srOnly}>{label}</span>
                          {l.id === firstLocked && (
                            <p className={styles.hint} data-locked-hint="">
                              {t.lockedHint}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      {total === 0 && (
        <p className={styles.soon} data-ecourse-soon="">
          {t.soon}
        </p>
      )}
      {(total > 0 || data.completion.completedAt !== null || data.completion.protocolSent) && (
        <CompletionSteps
          slug={slug}
          steps={data.completion}
          protocolSent={data.completion.protocolSent}
          certificate={data.completion.certificate}
          certificateName={data.completion.certificateName}
          resumeShown={total > 0 && next !== null}
          locale={locale}
          t={t}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
