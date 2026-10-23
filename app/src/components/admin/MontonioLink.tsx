"use client";

import { useEffect, useRef, useState } from "react";
import { adminEt } from "@/i18n/dict/admin";
import styles from "./MontonioLink.module.css";

/** How long „Montonio id kopeeritud.“ stays on the screen. */
export const COPIED_MS = 4000;

/**
 * „Montonios ↗“ (admin UX pass, piece 2, A6 Maksed; Dim 22.10). Montonio has no page for one order (Rempire's finding, 24.09: only Orders, searched
 * by the id), so one press does two things: the link opens the Partner System `href` (server/payments/montonio.ts montonioPartnerUrl; a new tab,
 * rel="noopener") and copies the order id `uuid` to the clipboard, for Maria to paste into Orders. A polite status line says „Montonio id
 * kopeeritud.“ — only when the copy was made. The press itself is never stopped: if the clipboard is refused, missing (an old browser) or throws,
 * the link still opens and nothing untrue is said; the id stays readable in the link's `title`.
 *
 * The status line is in the page before anything is said (an empty `role="status"`), so a screen reader hears what is put into it. The row of a
 * list is a link as a whole (ListRows); this link is a control of its own, so the press is its own and does not open the row.
 */
export function MontonioLink({ href, uuid }: { href: string; uuid: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const copy = () => {
    let written: Promise<void> | undefined;
    try {
      written = navigator.clipboard?.writeText(uuid);
    } catch {
      return;
    }
    if (!written) return;
    written.then(
      () => {
        if (!alive.current) return;
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          setCopied(false);
        }, COPIED_MS);
      },
      () => {},
    );
  };

  return (
    <>
      <a className={styles.link} href={href} target="_blank" rel="noopener" title={uuid} data-montonio-link="" onClick={copy}>
        {adminEt.payments.montonio} <span aria-hidden="true">↗</span>
      </a>
      <span className={styles.copied} role="status" aria-live="polite" data-montonio-copied="">
        {copied ? adminEt.payments.montonioCopied : ""}
      </span>
    </>
  );
}
