"use client";

import { useId, type HTMLAttributes, type ReactNode } from "react";
import { sectionCard } from "@/components/admin/SectionMap";
import { adminEt } from "@/i18n/dict/admin";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";

/**
 * One card of the course editor (README B2): a section the section map points at (`id`, scrolled to with the top clear of the phone's bar, focused
 * after the jump), with its title (an h2, or `label` when the editor inside draws its own heading), saved when the focus leaves it (`onLeave`, its
 * part's flush: README §1.3 "on blur"). After a conflict (another tab saved the part meanwhile) „Taasta minu tekst“ saves this card's text over it.
 */
export function Card({
  id,
  title,
  label,
  onLeave,
  conflict,
  onRestore,
  children,
  ...rest
}: {
  id: string;
  title?: string;
  label?: string;
  onLeave?: () => void;
  conflict?: boolean;
  onRestore?: () => void;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "id" | "title" | "children">) {
  const uid = useId();
  return (
    <section
      {...rest}
      id={id}
      className={`${ui.card} ${sectionCard}`}
      tabIndex={-1}
      aria-labelledby={title ? `${uid}-title` : undefined}
      aria-label={title ? undefined : label}
      onBlur={onLeave}
    >
      {title && (
        <h2 id={`${uid}-title`} className={`${ui.h2} ${styles.cardTitle}`}>
          {title}
        </h2>
      )}
      {children}
      {conflict && onRestore && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={onRestore} data-part-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
    </section>
  );
}
