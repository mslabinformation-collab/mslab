"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
 * still that, so an undo never overwrites a newer change (a request reopened elsewhere, or reopened and marked done again). A press or an undo refused for that
 * reason (`stale`) says „Päringut muudeti vahepeal. Vaata see üle.“ (W7), at the button or in the bar; any other refusal is the generic „Salvestamine ei
 * õnnestunud. Proovi uuesti.“.
 *
 * The pressed button goes with its card, which moves to the other list. So that the keyboard focus does not fall to the page, the press works out
 * where it goes next, from the page as it is (`planFocus`), and does it when this button is gone (the card's own toggle in its new place is another instance).
 */
export function RequestToggle({ id, handled }: { id: number; handled: boolean }) {
  const t = adminEt.requests;
  const undo = useUndo();
  const [pending, start] = useTransition();
  /** What the last press was refused with, in words (null: nothing). */
  const [failed, setFailed] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** Where the focus goes once this button is gone: set by a press that went through, done when the card (and with it this component) leaves the page. */
  const afterGone = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      const move = afterGone.current;
      afterGone.current = null;
      move?.();
    },
    [],
  );

  const press = () => {
    if (pending) return;
    setFailed(null);
    // (worked out now, while the card is where it is)
    const focusNext = planFocus(root.current, handled);
    start(async () => {
      let answer: Awaited<ReturnType<typeof toggleRequestHandled>>;
      try {
        answer = await toggleRequestHandled({ id, handled: !handled, expected: handled });
      } catch {
        answer = { ok: false, error: "server" };
      }
      if (!answer.ok) {
        setFailed(answer.error === "stale" ? t.stale : adminEt.common.saveError);
        return;
      }
      afterGone.current = focusNext;
      if (handled) return;
      const { version } = answer;
      undo.show({
        text: t.markedDone,
        // asks for the request as the marking left it: done, and that version
        undo: async () => {
          const r = await toggleRequestHandled({ id, handled: false, expected: true, version });
          return r.ok || (r.error === "stale" ? t.stale : false);
        },
      });
    });
  };

  return (
    <div ref={root} data-request-toggle="">
      <button type="button" className={`${ui.btn} ${ui.smallBtn} ${handled ? ui.secondary : ""}`} aria-disabled={pending || undefined} onClick={press}>
        {pending ? adminEt.common.saving : handled ? t.markOpen : t.markDone}
      </button>
      <p role="status" className={ui.error}>
        {failed ?? ""}
      </p>
    </div>
  );
}

/**
 * Where the focus goes after a press, worked out from the page before the card moves. The next card of the list the pressed card is in, its first control (the
 * „Märgi …“ button), else the one before it; with none left: for „Märgi tehtuks“ the fold „Tehtud ({n})“ (the card is in it now), for „Märgi tegemata“ the
 * reopened card itself (it is in the list now); else the page's heading (the one the page marks `data-requests-heading`, focusable). The returned function
 * does it, and only if the focus has fallen to the page: when she has moved on to something else meanwhile, it is left where she put it.
 */
function planFocus(from: HTMLElement | null, wasDone: boolean): () => void {
  const card = from?.closest("article[data-request]") ?? null;
  const cell = card?.parentElement ?? null;
  const neighbour = cell?.nextElementSibling ?? cell?.previousElementSibling ?? null;
  const nextId = neighbour?.querySelector("article[data-request]")?.getAttribute("data-request") ?? null;
  const ownId = card?.getAttribute("data-request") ?? null;
  return () => {
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    const button = (cardId: string | null) => (cardId ? document.querySelector<HTMLElement>(`article[data-request="${cardId}"] [data-request-toggle] button`) : null);
    const candidates = [button(nextId), wasDone ? button(ownId) : document.querySelector<HTMLElement>("details[data-fold] > summary"), document.querySelector<HTMLElement>("[data-requests-heading]")];
    // (the first that takes the focus: a control inside a shut fold does not)
    for (const target of candidates) {
      target?.focus();
      if (target && document.activeElement === target) return;
    }
  };
}
