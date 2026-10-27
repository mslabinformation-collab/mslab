"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { dropSiteCopies } from "@/lib/site-copies";
import { ConfirmPanel } from "../ConfirmPanel";
import { postTo, pressFailedLine } from "../useEditorRestarts";
import ui from "../ui.module.css";
import { newsHref } from "./news-view";
import styles from "./PostFoot.module.css";

/**
 * The post card's footer (admin UX pass piece 4b, Task 2; S4-20, S4-23): where the post is (`line`) and „Kustuta postitus“, which asks in its place —
 * „Kas kustutan selle postituse?“, for a published post „Postitus kaob blogist ja avalehelt.“, „Seda ei saa tagasi võtta.“, „Jah, kustuta“ /
 * „Katkesta“ (the focus back on the button). Yes: POST /api/admin/uudised/<id>/kustuta (the post goes with its drafts, R-h); done, nothing of the
 * post is sent or kept any more in this browser (`discardCopy`, and every copy of the post), and the list opens with „Postitus kustutatud.“ and its
 * search (`search`), read again; refused, its line (a post already gone: „Seda postitust ei leitud.“), the question open.
 */
export function PostFoot({ id, published, line, search, discardCopy }: { id: number; published: boolean; line: string; search: string; discardCopy: () => void }) {
  const t = adminEt.post;
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  // the question closed: the focus back on „Kustuta postitus“ (ConfirmPanel's rule)
  useEffect(() => {
    if (asking || !back.current) return;
    back.current = false;
    trigger.current?.focus();
  }, [asking]);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    const answer = await postTo(`/api/admin/uudised/${id}/kustuta`);
    if (answer.ok) {
      discardCopy();
      dropSiteCopies({ entity: "post", id });
      startTransition(() => {
        router.push(newsHref("/admin/uudised", search, { kustutatud: "1" }));
        router.refresh();
      });
      return;
    }
    setFailed(answer.status === 404 ? t.notFound : pressFailedLine(answer.signedOut));
    setBusy(false);
  };

  return (
    <div className={styles.foot} data-post-foot="">
      <div className={styles.row}>
        <span className={styles.where} data-post-where="">
          {line}
        </span>
        {!asking && (
          <button ref={trigger} type="button" className={styles.remove} onClick={() => setAsking(true)} data-post-delete="">
            {t.remove.button}
          </button>
        )}
      </div>
      {asking && (
        <ConfirmPanel
          question={t.remove.question}
          lines={published ? [t.remove.public, t.remove.final] : [t.remove.final]}
          yesLabel={t.remove.yes}
          tone="danger"
          busy={busy}
          onYes={() => void remove()}
          onCancel={() => {
            back.current = true;
            setAsking(false);
            setFailed(null);
          }}
        />
      )}
      {failed && (
        <p role="alert" className={ui.error}>
          {failed}
        </p>
      )}
    </div>
  );
}
