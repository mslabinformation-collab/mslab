"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ui from "./ui.module.css";
import styles from "./AssessmentQueue.module.css";

/** Where a row stands in the list, taken before its work is done: its own mark and the mark of the row that follows it (null: the last one). */
export type QueuePlace = { row: string; next: string | null };

type Queue = {
  /** The row (`data-queue-row`) `from` is in, and the one after it; null when `from` is in none. */
  place: (from: Element | null) => QueuePlace | null;
  /** A row's work is done and the page is about to take the row away: say it on the status line, and move the focus on once the row has left. */
  done: (place: QueuePlace | null, message: string) => void;
  /** The status line: its text, and a count that makes the same text a new line each time. */
  status: { text: string; n: number };
};

const QueueContext = createContext<Queue | null>(null);

/** The list's context, or null where there is none (the student's drawer shows the same buttons by itself). */
export function useQueue(): Queue | null {
  return useContext(QueueContext);
}

/**
 * Hindamine's page (admin UX pass, piece 2, Task 9; README A4; ledger L99): the page's root, with what a row's own button cannot keep. A row of
 * the list is taken away by the page itself once its work is done ("Ava test uuesti" revalidates the admin: the row leaves, and the button, its
 * answer and the focus with it), so the answer lives here, on the page's one status line (`QueueStatus`, a live region from the start), and the
 * focus goes on from where the row stood: to the first control of the row that followed it, or to the heading (`data-assessment-heading`) when
 * there is none. The rows are marked `data-queue-row="<key>"` by the server page; the row's button asks `place` before it sends and tells `done`
 * after the answer. The focus moves when the row is gone from the list, whichever came first, the answer or the refreshed page, and only once.
 */
export function AssessmentQueue({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const waiting = useRef<QueuePlace | null>(null);
  const [status, setStatus] = useState({ text: "", n: 0 });

  const queue = useMemo<Queue>(
    () => ({
      place: (from) => {
        const row = from?.closest("[data-queue-row]");
        if (!row) return null;
        return { row: row.getAttribute("data-queue-row") ?? "", next: row.nextElementSibling?.getAttribute("data-queue-row") ?? null };
      },
      done: (place, message) => {
        waiting.current = place;
        setStatus((s) => ({ text: message, n: s.n + 1 }));
      },
      status,
    }),
    [status],
  );

  // after every render: the page's refresh is a render of this component too (new children)
  useEffect(() => {
    const place = waiting.current;
    const el = root.current;
    if (!place || !el) return;
    const find = (key: string) => [...el.querySelectorAll<HTMLElement>("[data-queue-row]")].find((r) => r.getAttribute("data-queue-row") === key) ?? null;
    if (find(place.row)) return; // still on the page: the refresh has not come yet
    waiting.current = null;
    const next = place.next ? find(place.next) : null;
    const target = next?.querySelector<HTMLElement>("a[href], button:not([disabled])") ?? el.querySelector<HTMLElement>("[data-assessment-heading]");
    target?.focus();
  });

  return (
    <QueueContext.Provider value={queue}>
      <div ref={root} className={ui.page} data-assessment-page="">
        {children}
      </div>
    </QueueContext.Provider>
  );
}

/**
 * The page's status line: a status region from the start (an empty one is announced when it fills), under the tabs. The text is in a node of its
 * own that is new each time, so the same answer twice is heard twice.
 */
export function QueueStatus() {
  const queue = useQueue();
  return (
    <p role="status" className={`${ui.success} ${styles.status}`} data-queue-status="">
      {queue && queue.status.text && <span key={queue.status.n}>{queue.status.text}</span>}
    </p>
  );
}
