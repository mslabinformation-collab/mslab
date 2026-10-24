import type { Q } from "@/db/client";
import type { PreviewBarTexts, PreviewLabelTexts } from "@/components/site/PreviewBar";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { previewChangeCount } from "./course-parts";

// What the preview bars of the public pages need (admin UX pass piece 3a, Task 6 review; components/site/PreviewBar.tsx). The course page's: the course's
// id, how many changes wait, the way out, and the bar's words, which are the admin's (Estonian whatever the page's language): the PublishBar's count,
// „Loobu muudatustest“ and its question (adminEt.publish), the preview's own way out „Lõpeta eelvaade“ (Dim 24.10, D-1: adminEt.publish.previewExit),
// and a failed discard's words (the PublishBar's, D-2: „Muudatustest loobumine ei õnnestunud. Proovi uuesti.“, or „Logi uuesti sisse.“ for an ended
// session). The catalogue's (D-4): „Eelvaade“ (adminEt.publish.phonePreview, the phone bar's same word) and the same way out, nothing to discard.
// A page loads this module only for a request that is the admin's preview (server/preview.ts previewActive), so the dictionary and the draft layer
// never touch a visitor's render: the bars (components/site/PreviewBar.tsx) get their words as props.

/** The way out of the preview: draft mode off, back to `path` as a visitor sees it (api/admin/eelvaade?lopeta=1&tee=<path>). */
const exitOf = (path: string) => `/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(path)}`;

/**
 * `path`: this page's path as the visitor sees it (with the locale prefix of the Russian page): the way out returns to it, with draft mode off
 * (api/admin/eelvaade?lopeta=1&tee=<path>).
 */
export async function previewBarProps(db: Q, courseId: number, path: string): Promise<{ courseId: number; count: number; exitHref: string; t: PreviewBarTexts }> {
  const count = await previewChangeCount(db, courseId);
  const t = adminEt.publish;
  return {
    courseId,
    count,
    exitHref: exitOf(path),
    t: {
      count: fill(t.phoneCount, { n: count }),
      exit: t.previewExit,
      discard: t.discard,
      question: fill(t.confirm, { n: count }),
      yes: t.confirmYes,
      // a discard that failed (Dim 24.10, D-2: the PublishBar's words)
      failed: t.discardFailed,
      signedOut: adminEt.leave.reasons.signedOut,
    },
  };
}

/** The catalogue's bar (D-4): „Eelvaade“ and the way out to `path` (this catalogue page as the visitor sees it, with the Russian page's prefix). */
export function catalogueBarProps(path: string): { exitHref: string; t: PreviewLabelTexts } {
  const t = adminEt.publish;
  return { exitHref: exitOf(path), t: { label: t.phonePreview, exit: t.previewExit } };
}
