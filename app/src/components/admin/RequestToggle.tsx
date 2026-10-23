"use client";

import { useState, useTransition } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { toggleRequestHandled } from "@/server/actions/admin";
import { useUndo } from "./UndoBar";
import ui from "./ui.module.css";

/**
 * „Märgi tehtuks“ / „Märgi tegemata“ of one request (README A7). „Märgi tehtuks“ applies at once and the UndoBar says „Märgitud tehtuks.“ with „Võta tagasi“;
 * „Märgi tegemata“, in the fold „Tehtud ({n})“, is its own reverse and shows no bar (piece2-texts P-14). The page is refreshed by the action, so the card
 * moves between the list and the fold.
 *
 * Every press says which state the card showed (`expected`), and „Võta tagasi“ also the version the marking left: the server writes only while the request is
 * still that, so an undo never overwrites a newer change (a request reopened elsewhere, or reopened and marked done again). A refusal at the button is the
 * generic „Salvestamine ei õnnestunud. Proovi uuesti.“, as is an undo's in the bar: no existing text names a request that changed meanwhile.
 */
export function RequestToggle({ id, handled }: { id: number; handled: boolean }) {
  const t = adminEt.requests;
  const undo = useUndo();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);

  const press = () => {
    if (pending) return;
    setFailed(false);
    start(async () => {
      let answer: Awaited<ReturnType<typeof toggleRequestHandled>>;
      try {
        answer = await toggleRequestHandled({ id, handled: !handled, expected: handled });
      } catch {
        answer = { ok: false, error: "server" };
      }
      if (!answer.ok) {
        setFailed(true);
        return;
      }
      if (handled) return;
      const { version } = answer;
      undo.show({
        text: t.markedDone,
        // asks for the request as the marking left it: done, and that version
        undo: async () => (await toggleRequestHandled({ id, handled: false, expected: true, version })).ok,
      });
    });
  };

  return (
    <div data-request-toggle="">
      <button type="button" className={`${ui.btn} ${ui.smallBtn} ${handled ? ui.secondary : ""}`} aria-disabled={pending || undefined} onClick={press}>
        {pending ? adminEt.common.saving : handled ? t.markOpen : t.markDone}
      </button>
      <p role="status" className={ui.error}>
        {failed ? adminEt.common.saveError : ""}
      </p>
    </div>
  );
}
