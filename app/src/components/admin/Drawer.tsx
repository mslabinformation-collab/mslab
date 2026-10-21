"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { AdminIcon } from "./AdminIcon";
import { GuardScope, LeaveNotice, useLeaveGuard } from "./LeaveGuard";
import ui from "./ui.module.css";
import styles from "./Drawer.module.css";

/**
 * The question a drawer asks before it closes over unsaved changes ("Salvestamata muudatused lähevad kaotsi. Sulgen?").
 * @deprecated piece 3: LessonDrawer moves to useAutosave
 */
export type CloseQuestion = { question: string; yes: string; no: string };

/** What a part of the drawer reports while it has changes that are not saved: where "Ei" puts the focus back. */
type Unsaved = { focusBack: () => void };
const UnsavedContext = createContext<((part: string, unsaved: Unsaved | null) => void) | null>(null);

/**
 * A part of the drawer with its own "Salvesta" reports here while its fields differ from the stored values; the drawer then
 * asks before it closes (only when it was given `confirmClose`). `focusBack`: where "Ei" puts the focus (the changed field).
 * @deprecated piece 3: LessonDrawer moves to useAutosave
 */
export function useUnsavedInDrawer(dirty: boolean, focusBack: () => void): void {
  const report = useContext(UnsavedContext);
  const part = useId();
  const back = useRef(focusBack);
  useEffect(() => {
    back.current = focusBack;
  });
  useEffect(() => {
    report?.(part, dirty ? { focusBack: () => back.current() } : null);
  }, [report, part, dirty]);
  useEffect(() => () => report?.(part, null), [report, part]);
}

/**
 * Detail panel on the right (full width on a phone), opened by a link with `?id=` so every detail has its own address.
 * A modal dialog: focus stays inside, the page behind does not scroll. Esc, the close button („Sulge“, `closeLabel`: adminEt.common.close)
 * and a click on the backdrop close it; then the address goes back to `closeHref` (the list without the id) and the focus to
 * `returnFocus` (the row's link). The dialog is closed first, so the page behind is no longer inert when it is focused.
 *
 * Each of the three asks the leave guard first (LeaveGuard.tsx, README §1.5, screens §2.4): an autosave inside the drawer that is not confirmed
 * is saved (the drawer waits for it, at most 3 s), or the guard's notice asks at the top of the drawer. The drawer's content is the guard's
 * "drawer" scope: a close leaves only its sources, not the page's.
 *
 * `confirmClose` (deprecated, the lesson drawer until it autosaves): while a part of the drawer has unsaved changes (useUnsavedInDrawer), Esc,
 * the close button and the backdrop ask its question first, in place ("Jah, sulge" / "Ei"), as today; such a drawer does not ask the guard too.
 * `fallbackFocus`: when the drawer goes away by a navigation (its item deleted) and `returnFocus` is gone with it, the focus goes to this
 * element instead of <body>.
 */
export function Drawer({
  label,
  closeHref,
  closeLabel,
  returnFocus,
  fallbackFocus,
  confirmClose,
  children,
}: {
  label: string;
  closeHref: string;
  closeLabel: string;
  returnFocus?: string;
  fallbackFocus?: string;
  /** @deprecated piece 3: LessonDrawer moves to useAutosave */
  confirmClose?: CloseQuestion;
  children: React.ReactNode;
}) {
  const uid = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const overflow = useRef("");
  const router = useRouter();
  const guard = useLeaveGuard();
  /** The close is the drawer's own (the guard or the question let it go): the dialog's close event goes on to the address and the focus. */
  const allowed = useRef(false);
  const unsaved = useRef(new Map<string, Unsaved>());
  /** "Jah, sulge" was pressed: the next close goes through. */
  const confirmed = useRef(false);
  const [asking, setAsking] = useState(false);
  const question = useRef<HTMLParagraphElement>(null);
  const focus = useRef({ returnFocus, fallbackFocus });
  useEffect(() => {
    focus.current = { returnFocus, fallbackFocus };
  });
  const [report] = useState(() => (part: string, state: Unsaved | null) => {
    if (state) unsaved.current.set(part, state);
    else unsaved.current.delete(part);
  });

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    const root = document.documentElement;
    overflow.current = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow.current;
      // gone by a navigation (not by its own close): the focus goes back to the page instead of being lost
      const { returnFocus: back, fallbackFocus: fallback } = focus.current;
      if (!fallback) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        ((back && document.getElementById(back)) || document.getElementById(fallback))?.focus();
      });
    };
  }, []);

  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);

  /** Unsaved changes to ask about before closing (only with `confirmClose`). */
  const mustAsk = () => Boolean(confirmClose) && !confirmed.current && unsaved.current.size > 0;
  const close = () => {
    allowed.current = true;
    ref.current?.close();
  };
  /** ✕, Esc and the backdrop: the drawer's own question when it has one (deprecated), else the leave guard. */
  const requestClose = () => {
    if (confirmClose) {
      if (mustAsk()) setAsking(true);
      else close();
    } else guard.requestLeave(close, "drawer");
  };

  return (
    <dialog
      ref={ref}
      className={styles.drawer}
      aria-label={label}
      data-drawer=""
      onCancel={(e) => {
        // a file picker dismissed inside the drawer fires a bubbling cancel at its <input type=file>, which React hands on to here: not
        // the drawer's Esc
        if (e.target !== e.currentTarget) return;
        // Esc: the drawer closes itself (requestClose), after its question or the guard
        e.preventDefault();
        requestClose();
      }}
      onClose={(e) => {
        // the close of something inside the drawer (a dialog in it), handed on by React: not the drawer's
        if (e.target !== e.currentTarget) return;
        const own = allowed.current;
        allowed.current = false;
        // a close the browser forced past the question or the guard (a second Esc at once): open again and ask
        if (!own && (!confirmClose || mustAsk())) {
          ref.current?.showModal();
          requestClose();
          return;
        }
        document.documentElement.style.overflow = overflow.current;
        router.replace(closeHref, { scroll: false });
        if (returnFocus) document.getElementById(returnFocus)?.focus();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <UnsavedContext.Provider value={report}>
        <div className={styles.body}>
          <button type="button" className={styles.close} aria-label={closeLabel} onClick={requestClose}>
            <AdminIcon name="close" size={20} />
          </button>
          <LeaveNotice where="drawer" />
          {asking && confirmClose && (
            <div className={styles.ask} role="group" aria-labelledby={`${uid}-ask`} data-drawer-confirm="">
              <p id={`${uid}-ask`} ref={question} tabIndex={-1} className={`${ui.notice} ${styles.question}`}>
                {confirmClose.question}
              </p>
              <div className={styles.answers}>
                <button
                  type="button"
                  className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`}
                  onClick={() => {
                    confirmed.current = true;
                    setAsking(false);
                    close();
                  }}
                >
                  {confirmClose.yes}
                </button>
                <button
                  type="button"
                  className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
                  onClick={() => {
                    setAsking(false);
                    const first = unsaved.current.values().next().value;
                    requestAnimationFrame(() => first?.focusBack());
                  }}
                >
                  {confirmClose.no}
                </button>
              </div>
            </div>
          )}
          <GuardScope>{children}</GuardScope>
        </div>
      </UnsavedContext.Provider>
    </dialog>
  );
}
