"use client";

import { useId, useState } from "react";
import { POST_PART } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { InstantSwitch } from "../site/InstantSwitch";
import type { SitePage } from "../site/SiteEditorPage";
import { stampOf, type HeldPart } from "../useEditorRestarts";
import ui from "../ui.module.css";
import styles from "./PublishedCard.module.css";

/**
 * A post's „Avaldamine“ (admin UX pass piece 4b, Task 2; ruling R-b): the instant switch „Avaldatud“ with its hint (kept, builder notes §5), pressed as
 * the page's instant press (site/SiteEditorPage.tsx SitePage.instant: what is typed saved first, the cards waiting, the page read from the answer's
 * stamp) on POST /api/admin/uudised/<id>/avaldatud `{ on }`. The switch (site/InstantSwitch.tsx) shows what was asked until the editor starts over from
 * that read, or until the press ends otherwise. Refused on (a post that is not published): `Puudub: …` under the switch (S4-22), until the post's next
 * save; the address another post has is said at „Aadress“ ("invalid", ADM:2281). Refused off: a draft changed meanwhile, listed on the bar after the
 * page's read. A failure says its line under the switch. `className`: the card's place in the post's layout.
 */
export function PublishedCard({ page, id, published, className }: { page: SitePage; id: number; published: boolean; className?: string }) {
  const t = adminEt.post;
  const uid = useId();
  const [failed, setFailed] = useState<string | null>(null);
  const missing = published ? [] : page.held.filter((b) => b.reason === "missing").flatMap((b) => b.fields);
  const said = failed ?? (missing.length > 0 ? fill(adminEt.publish.missing, { fields: missing.join(", ") }) : null);

  const press = async (on: boolean): Promise<boolean> => {
    setFailed(null);
    const result = await page.instant(`/api/admin/uudised/${id}/avaldatud`, { on }, (answer) => {
      if (answer.ok === true) return { done: true, stamp: stampOf(answer) };
      if (Array.isArray(answer.missing)) return { held: [{ part: POST_PART, reason: "missing", fields: answer.missing as string[] }] };
      if (Array.isArray(answer.blocked)) return { held: answer.blocked as HeldPart[] };
      return null;
    });
    // done, or past the bound: the editor starts over from the page's read (this card with it)
    if (result.kind === "done" || result.kind === "late") return true;
    if (result.kind === "failed") setFailed(result.line);
    return false;
  };

  return (
    <section className={className ? `${ui.card} ${styles.card} ${className}` : `${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-post-publish="">
      <h2 id={`${uid}-title`} className={`${ui.h3} ${styles.title}`}>
        {t.sections.publish}
      </h2>
      <InstantSwitch page={page} label={t.published} checked={published} hint={t.publishedHint} said={said} press={press} data-field="post.published" />
    </section>
  );
}
