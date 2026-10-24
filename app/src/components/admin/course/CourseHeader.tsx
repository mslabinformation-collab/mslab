"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { CourseType } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { LangSwitch } from "../EditLang";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";

/**
 * The course editor's header (README B2): „← Koolitused“, the H1, the tags (Avaldatud / Mustand, the type, „Näidis“), then at the right of the H1 row
 * the page's LangSwitch, the screen's one status (`status`: SaveStatus, or the new-course page's line and „Lisa koolitus“) and „Vaata lehel ↗“ while
 * the course is on the public site (README §1.4: the chip before it). On a phone the right side wraps under the H1. The H1 takes the focus after a
 * publish or a discard, when the bar it was pressed in is gone.
 */
export function CourseHeader({
  title,
  published,
  sample,
  type,
  status,
  publicHref,
}: {
  title: string;
  published: boolean;
  sample: boolean;
  type: CourseType;
  status: ReactNode;
  publicHref: string | null;
}) {
  const t = adminEt.courseEditor;
  return (
    <div className={ui.heading}>
      <div className={styles.headText}>
        <p className={styles.back}>
          <Link className={ui.link} href="/admin/koolitused">
            {t.backLink}
          </Link>
        </p>
        <h1 className={`${ui.h1} ${styles.title}`} tabIndex={-1} data-course-title="">
          {title}
        </h1>
        <div className={styles.tags}>
          <span className={`${ui.tag} ${published ? ui.ok : ui.warn}`} data-course-state="">
            {published ? adminEt.courses.published : adminEt.courses.draft}
          </span>
          <span className={`${ui.tag} ${type === "e_learning" ? ui.dark : ""}`}>{adminEt.courses.type[type]}</span>
          {sample && (
            <span className={`${ui.tag} ${styles.sample}`} title={adminEt.courses.sampleTitle} data-sample="">
              {adminEt.courses.sample}
            </span>
          )}
        </div>
      </div>
      <div className={ui.headAside}>
        <LangSwitch />
        {status}
        {publicHref && (
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={publicHref} target="_blank" rel="noopener">
            {t.viewSite} ↗
          </a>
        )}
      </div>
    </div>
  );
}
