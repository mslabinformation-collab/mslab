import type { ReactNode } from "react";
import styles from "./FoldRow.module.css";

/**
 * A folded row of a drawer or a page (the A screens, Task 1; the Part 2 prototype's „Leping … puudub ▸“, „Tehtud (1) ▸“): a native
 * `<details data-fold>` whose 52 px summary row has the title on the left (with the count in brackets when there is one: „Tehtud (1)“) and the
 * one-line `summary` on the right, then a „▸“ that turns a quarter when the row is open (without the animation under reduced motion). Closed, the
 * summary line says what is inside, so the row is rarely opened for nothing. The browser does the rest: the keyboard (Enter and Space on the
 * summary), the open state in the first HTML, and an `id` anchor that a link such as `#arveta` can point at.
 *
 * - `defaultOpen`: starts open (a row that has something to do). It is a start only: a row the visitor opened or closed stays as she left it
 *   when the page renders again with the same value.
 * - `summary` may be "" (the row says only its title and count); `count` of 0 is shown.
 *
 * No state and no event handlers, so there is no "use client" line: a server page draws it as it is, a client component too
 * (tests/unit/old-safari.test.ts lists it).
 */
export function FoldRow({
  title,
  summary,
  count,
  id,
  defaultOpen,
  children,
}: {
  title: string;
  summary: string;
  count?: number;
  id?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  return (
    <details className={styles.fold} data-fold="" id={id} open={defaultOpen ? true : undefined}>
      {/* the summary stays a block and the flex row is inside it: an old Safari does not lay a <summary> out as a flex box */}
      <summary className={styles.summary}>
        <span className={styles.row}>
          <span className={styles.title}>
            {title}
            {count !== undefined && (
              <>
                {" "}
                <span data-fold-count="">({count})</span>
              </>
            )}
          </span>{" "}
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
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
