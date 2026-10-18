"use client";

import { useId, useState } from "react";
import { paragraphs } from "@/domain/catalogue";
import styles from "./ContractPreview.module.css";

/**
 * What a form needs to show its contract inline (contracts, D1): the text the server reads for the form's page (contracts.ts contractTemplate:
 * Maria's text, or the public „Õppetingimused“ until she writes the contact one), unfilled, in the language it is in; the course's name in that
 * language (domain/contract.ts contractCourseName); the price in cents (the group price, the e-course's price). The form fills the rest from
 * what she types and chooses (domain/contract.ts filledContract), as the server does when it freezes the contract. `version` is the text's
 * version, which the form sends with the box (ruling R6): the server freezes nothing from another text than the one shown here.
 */
export type FormContract = { version: string; title: string; body: string; locale: "et" | "ru"; course: string; priceCents: number | null };

/**
 * „Loe lepingut“ under the box of the registration form and of the cart (D1): a button that opens the contract's text in the form, below it, and
 * closes it again — the page does not change, nothing is ticked or sent. The text is the one the form filled (`text`), its paragraphs split on
 * blank lines as the PDF and the legal pages split them. The open text is a region of its own that scrolls inside the form (a long contract
 * never pushes the button out of reach) and takes the keyboard's focus to scroll. Nothing to read (no title and no text at all): no button.
 */
export function ContractPreview({ label, text }: { label: string; text: { title: string; body: string } }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const shown = paragraphs(text.body);
  if (!text.title.trim() && shown.length === 0) return null;
  return (
    <div className={styles.contract}>
      <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={`${id}-contract`} onClick={() => setOpen((o) => !o)} data-contract-toggle="">
        {label}
        <span className={styles.chevron} aria-hidden="true" data-open={open || undefined} />
      </button>
      <div id={`${id}-contract`} className={styles.panel} role="region" aria-label={label} tabIndex={0} hidden={!open} data-contract-preview="">
        {text.title.trim() && <p className={styles.title}>{text.title}</p>}
        {shown.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </div>
  );
}
