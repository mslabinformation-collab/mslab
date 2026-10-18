"use client";

import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import ui from "./ui.module.css";
import styles from "./ReviewList.module.css";

/**
 * „Näita kõiki“ (student reviews, spec D5): the list of the course page's block when it has more reviews than it shows at first. `children` are
 * the reviews shown at first and `rest` the others, both made on the server (ReviewList); the rest is part of the page's data but not of its
 * HTML, and the button opens it in place, with no request. The button then goes, and the keyboard focus goes to the first review newly shown (an
 * <li> with tabIndex -1), so that a keyboard or screen reader user continues where the new reviews begin and not at the top of the page.
 * `label` is the button's text, with the count of the reviews it will show.
 */
export function ReviewMore({ label, className, rest, children }: { label: string; className: string; rest: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const focusAt = useRef<number | null>(null);

  const openAll = () => {
    focusAt.current = Children.count(children); // (the position of the first review that is new)
    setOpen(true);
  };

  useEffect(() => {
    if (focusAt.current === null) return;
    (list.current?.children[focusAt.current] as HTMLElement | undefined)?.focus();
    focusAt.current = null;
  }, [open]);

  return (
    <>
      <ul ref={list} className={className}>
        {children}
        {open && rest}
      </ul>
      {!open && (
        <div className={styles.more}>
          <button type="button" className={ui.btnOutline} data-reviews-more="" onClick={openAll}>
            {label}
          </button>
        </div>
      )}
    </>
  );
}
