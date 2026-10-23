"use client";

import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ui from "./ui.module.css";
import styles from "./PhoneFold.module.css";

/**
 * A block of the registration drawer that folds on a phone only (the A screens, Task 6; README A2: "Phone drawer: … Invoices and the contract are
 * folded rows", the Part 2 phone frame's „Arved … 1 tasumata ▸“). Above 640 px (the drawer's phone width) it is the desktop frame's section: the
 * title as an h3 over its content. Below, the heading gives way to a 52 px row — the title on the left, the one-line `summary` and a „▸“ on the right
 * — and the content is shown only while the row is open; it starts closed. One DOM for both widths (the stylesheet picks): nothing is drawn twice,
 * and a server page's first HTML is already right for either. The state is the row's alone, so a refresh of the page by an action leaves it as
 * she left it.
 *
 * `className` goes on the section and `bodyClassName` on the box round the children (the block's own spacing); other props, such as the page's
 * `data-…` marks, land on the section.
 */
export function PhoneFold({
  title,
  summary,
  className,
  bodyClassName,
  children,
  ...rest
}: {
  title: string;
  summary: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"section">, "title" | "className" | "children">) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  return (
    <section {...rest} className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={`${uid}-title`} data-phone-fold="" data-open={open ? "true" : "false"}>
      <h3 id={`${uid}-title`} className={`${ui.h3} ${styles.heading}`}>
        {title}
      </h3>
      <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={`${uid}-body`} onClick={() => setOpen((o) => !o)} data-phone-fold-toggle="">
        <span className={styles.row}>
          <span className={styles.title}>{title}</span>{" "}
          <span className={styles.aside}>
            {summary !== "" && (
              <>
                <span className={styles.text} data-fold-summary="">
                  {summary}
                </span>{" "}
              </>
            )}
            <span className={styles.arrow} aria-hidden="true">
              ▸
            </span>
          </span>
        </span>
      </button>
      <div id={`${uid}-body`} className={[styles.body, bodyClassName].filter(Boolean).join(" ")}>
        {children}
      </div>
    </section>
  );
}
