"use client";

import type { ComponentProps } from "react";
import { Card } from "../course/Card";
import type { SitePartApi } from "./useSitePart";
import styles from "./SiteCard.module.css";

/** What a card needs of a part it shows: its save on leaving, and its conflict with the way back. */
type CardPart = Pick<SitePartApi, "flush" | "conflict" | "restore">;

/**
 * One card of a site editor (admin UX pass piece 4a; README B2 / §4 "the template"): the course editor's Card (../course/Card.tsx) as it is — a section
 * the section map points at (`id`, `tabIndex={-1}`, scrolled to clear of the phone's bar), its title (an h2) naming it, every part it shows saved when
 * the focus leaves it (README §1.3 "on blur"), and after a conflict (another tab saved one of them meanwhile) „Taasta minu tekst“, which saves this
 * text over each part in conflict — bound to the card's `parts`. A card may show the fields of several parts (ruling R-a: Koolitaja's „Portree ja
 * tutvustus“ shows `trainer` and `bio`), as the course's TypeCard does. Praktika's packages (Task 4), Koolitaja's and Avaleht's cards (Tasks 5–6) are
 * this card; `className` and `titleClassName` give a screen its own layout and heading.
 */
export function SiteCard({ parts, className, ...card }: { parts: readonly CardPart[] } & Omit<ComponentProps<typeof Card>, "onLeave" | "conflict" | "onRestore">) {
  return (
    <Card
      {...card}
      className={className ? `${styles.card} ${className}` : styles.card}
      onLeave={() => {
        for (const part of parts) void part.flush();
      }}
      conflict={parts.some((part) => part.conflict)}
      onRestore={() => {
        for (const part of parts) if (part.conflict) part.restore();
      }}
    />
  );
}
