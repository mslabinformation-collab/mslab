import type { Q } from "@/db/client";
import type { PreviewBarTexts } from "@/components/site/PreviewBar";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { previewChangeCount } from "./course-parts";

// What the preview bar on the public course page needs (admin UX pass piece 3a, Task 6 review; components/site/PreviewBar.tsx): the course's id, how many
// changes wait, the way out, and the bar's words, which are the admin's (Estonian whatever the page's language): the PublishBar's count, „Loobu muudatustest“
// and its question (adminEt.publish), the top line's „Vaata kodulehte“ (adminEt.shell.preview) for the way out, and a failed discard's words (the
// PublishBar's: adminEt.common.saveError, or „Logi uuesti sisse.“ for an ended session). The page loads this module only for a request
// that is the admin's preview (server/preview.ts previewActive), so the dictionary and the draft layer never touch a visitor's render.

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
    exitHref: `/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(path)}`,
    t: {
      count: fill(t.phoneCount, { n: count }),
      exit: adminEt.shell.preview,
      discard: t.discard,
      question: fill(t.confirm, { n: count }),
      yes: t.confirmYes,
      // a discard that failed (piece 3a, Task 7 ruling: the admin's existing words, as the PublishBar's)
      failed: adminEt.common.saveError,
      signedOut: adminEt.leave.reasons.signedOut,
    },
  };
}
