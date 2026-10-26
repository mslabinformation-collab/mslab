"use client";

import { useId, type HTMLAttributes, type ReactNode } from "react";
import { sectionCard } from "@/components/admin/SectionMap";
import { adminEt } from "@/i18n/dict/admin";
import { UnpublishedTag } from "../UnpublishedTag";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";

/**
 * One card of the course editor (README B2): a section the section map points at (`id`, scrolled to with the top clear of the phone's bar, focused
 * after the jump), with its title (an h2, or `label` when the editor inside draws its own heading), saved when the focus leaves it (`onLeave`, its
 * part's flush: README §1.3 "on blur"). After a conflict (another tab saved the part meanwhile) „Taasta minu tekst“ saves this card's text over it.
 * `unpublished`: the card's title is its field's label (the gallery) and its value waits for „Avalda muudatused“: „· avaldamata“ after the title
 * (README §1.8), the card's description, not part of its name.
 *
 * The site editors' cards are this card too (../site/SiteCard.tsx binds it to their parts): `className` adds a screen's own layout to the card's
 * section, `titleClassName` gives its title the screen's look instead of the course cards' (Praktika's package name). The course cards pass neither.
 */
export function Card({
  id,
  title,
  label,
  onLeave,
  conflict,
  onRestore,
  unpublished,
  className,
  titleClassName,
  children,
  ...rest
}: {
  id: string;
  title?: string;
  label?: string;
  onLeave?: () => void;
  conflict?: boolean;
  onRestore?: () => void;
  unpublished?: boolean;
  className?: string;
  titleClassName?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "id" | "title" | "children" | "className">) {
  const uid = useId();
  return (
    <section
      {...rest}
      id={id}
      className={className ? `${ui.card} ${sectionCard} ${className}` : `${ui.card} ${sectionCard}`}
      tabIndex={-1}
      aria-labelledby={title ? `${uid}-title` : undefined}
      aria-label={title ? undefined : label}
      aria-describedby={title && unpublished ? `${uid}-unpublished` : undefined}
      onBlur={onLeave}
    >
      {title && (
        <h2 id={`${uid}-title`} className={titleClassName ?? `${ui.h2} ${styles.cardTitle}`}>
          {title}
          {unpublished && (
            <>
              {" "}
              <UnpublishedTag id={`${uid}-unpublished`} hidden />
            </>
          )}
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
