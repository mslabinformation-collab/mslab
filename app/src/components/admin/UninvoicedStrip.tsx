"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { createInvoicesForUnbilledAction } from "@/server/actions/admin-invoices";
import { ConfirmPanel } from "./ConfirmPanel";
import ui from "./ui.module.css";
import styles from "./UninvoicedStrip.module.css";

/** What a press of „Koosta {n} arvet“ did, as the action answers it (server/invoices.ts BatchResult). */
export type BatchOutcome = { made: string[]; already: number; failed: string[]; sellerMissing: boolean; linked: number };

/**
 * What a press made, in words (piece2-texts S3-l), one line each: one made is „Arve {number} on valmis.“ (the row button's own words), two or more
 * „Koostatud {n} arvet: {first}–{last}.“ — without „: {first}–{last}“ when some of them were invoices already made (`linked`: their numbers are
 * not a range); some billed meanwhile „Juba arvega: {n}.“; the payers whose invoice failed „Ei õnnestunud: {names}.
 * Proovi uuesti.“; Seaded's seller card empty the line the button gives way to, „Täida Seaded → Arve andmed“.
 */
export function resultLines(r: BatchOutcome): string[] {
  const t = adminEt.invoices.uninvoiced;
  const lines: string[] = [];
  if (r.made.length === 1) lines.push(fill(t.done, { number: r.made[0] }));
  else if (r.made.length > 1) lines.push(fill(r.linked > 0 ? t.result.manyLinked : t.result.many, { n: r.made.length, first: r.made[0], last: r.made[r.made.length - 1] }));
  if (r.already > 0) lines.push(fill(t.result.already, { n: r.already }));
  if (r.failed.length > 0) lines.push(fill(t.result.failed, { names: r.failed.join(", ") }));
  if (r.sellerMissing) lines.push(t.needSeller);
  return lines;
}

type Line = { tone: "idle" | "error" | "done"; text: string };
const IDLE: Line = { tone: "idle", text: "" };

/**
 * „Arveta maksed: {n}“ at the top of the Arved page (admin UX pass A6 and B11; README A6, the Part 2 prototype's Arved frame): a white strip with the
 * count, a summary line (what they are, the total, the first payers), „Näita ▸“ / „Peida ▾“ for the per-row list (`children`: the payments, each
 * with its own „Koosta arve“; P-8), and „Koosta {n} arvet“, which asks with a ConfirmPanel — „Kas koostan {n} arvet? Iga arve saab oma numbri
 * ({first}–{last}). Õpilastele neid ei saadeta.“ (n = 1: „Kas koostan 1 arve? Arve saab numbri {first}. Õpilasele seda ei saadeta.“, S3-l; and
 * without „({first}–{last})“ when a payment pays an invoice already made, whose number is no part of a range) — and then
 * says what was made, what had an invoice by now and whose failed (resultLines). The panel takes the button's place and gives the focus back to it;
 * the line that says what happened takes the focus when the press went through. The strip is the anchor #arveta (the overview's „Arveta makset“ row
 * links to it) and opens its list when the address names it.
 *
 * - `ids`: the payments the list shows, oldest first: what a press sends (the work walks them in that order); `first`, `last`: the numbers the first
 *   and the last newly issued invoice will take, and `linked` how many of the payments pay an invoice already made instead (server/invoices.ts
 *   unbilledPreview). `ready`: Seaded's seller card is filled in; if not, the link „Täida Seaded → Arve
 *   andmed“ stands in place of the button.
 * - When the press leaves nothing to bill the page draws the strip with no `ids`; it then draws only the line that says what was done (this
 *   component is the same one, so it keeps it), and nothing at all without one.
 */
export function UninvoicedStrip({
  ids,
  first,
  last,
  linked,
  summary,
  ready,
  children,
}: {
  ids: number[];
  first: string;
  last: string;
  linked: number;
  summary: string;
  ready: boolean;
  children?: ReactNode;
}) {
  const t = adminEt.invoices.uninvoiced;
  const titleId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const bulkButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  /** Where the focus goes now that the panel has gone (a new object each time): the button when it was cancelled, the line when it went through. */
  const [back, setBack] = useState<{ to: "button" | "line" } | null>(null);
  const n = ids.length;

  // the address names the strip (#arveta): its list is open, when the page is opened on it and when the address changes to it later
  useEffect(() => {
    const sync = () => {
      if (window.location.hash === "#arveta") setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    if (!back) return;
    (back.to === "button" ? (bulkButton.current ?? statusLine.current) : statusLine.current)?.focus();
  }, [back]);

  const cancel = () => {
    // (the batch makes invoices on the server whatever the panel does: while it runs there is nothing to cancel)
    if (pending) return;
    setAsking(false);
    setLine(IDLE);
    setBack({ to: "button" });
  };
  const make = () => {
    if (pending) return;
    setLine(IDLE);
    start(async () => {
      const r = await createInvoicesForUnbilledAction({ ids });
      if (!r.ok) return setLine({ tone: "error", text: r.text });
      const lines = resultLines(r);
      setAsking(false);
      setLine({ tone: r.failed.length > 0 || r.sellerMissing ? "error" : "done", text: lines.join(" ") });
      setBack({ to: "line" });
    });
  };

  const said = line.text !== "";
  if (n === 0 && !said) return null;
  const one = n === 1;
  // One tree whether or not anything is left to bill: the line that says what was done stays the same element when the refreshed page has none
  // (its place among the children is the same), so the focus the press gave it is not lost.
  return (
    <section id="arveta" className={styles.strip} aria-labelledby={n > 0 ? titleId : undefined} data-uninvoiced="">
      {n > 0 && (
        <div className={styles.head}>
          <div className={styles.text}>
            <h2 id={titleId} className={styles.title}>
              {fill(t.title, { n })}
            </h2>
            <p className={styles.summary} data-uninvoiced-summary="">
              {summary}
            </p>
          </div>
          <div className={styles.buttons}>
            <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)} data-uninvoiced-toggle="">
              {open ? t.hide : t.show}
            </button>
            {!ready ? (
              <Link className={ui.link} href="/admin/seaded#arve" data-uninvoiced-need-seller="">
                {t.needSeller}
              </Link>
            ) : (
              !asking && (
                <button ref={bulkButton} type="button" className={ui.btn} onClick={() => setAsking(true)} data-uninvoiced-bulk="">
                  {one ? t.bulk.one : fill(t.bulk.many, { n })}
                </button>
              )
            )}
          </div>
        </div>
      )}
      {n > 0 && asking && (
        <ConfirmPanel
          question={one ? t.panel.questionOne : fill(t.panel.questionMany, { n })}
          lines={[one ? fill(t.panel.lineOne, { first }) : linked > 0 ? t.panel.lineManyLinked : fill(t.panel.lineMany, { first, last })]}
          yesLabel={pending ? t.working : one ? t.panel.yesOne : fill(t.panel.yesMany, { n })}
          tone="send"
          busy={pending}
          onYes={make}
          onCancel={cancel}
        />
      )}
      <p ref={statusLine} tabIndex={-1} role="status" className={`${styles.status} ${line.tone === "error" ? ui.error : line.tone === "done" ? ui.success : ui.hint}`} data-uninvoiced-result="">
        {line.text}
      </p>
      {n > 0 && (
        <div id={listId} hidden={!open} data-uninvoiced-list="">
          {children}
        </div>
      )}
    </section>
  );
}
