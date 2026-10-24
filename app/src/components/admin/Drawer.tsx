"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { AdminIcon } from "./AdminIcon";
import { GuardScope, LeaveNotice, useLeaveGuard } from "./LeaveGuard";
import styles from "./Drawer.module.css";

/**
 * Detail panel on the right (full width on a phone), opened by a link with `?id=` so every detail has its own address.
 * A modal dialog: focus stays inside, the page behind does not scroll. Esc, the close button („Sulge“, `closeLabel`: adminEt.common.close)
 * and a click on the backdrop close it; then the address goes back to `closeHref` (the list without the id) and the focus to
 * `returnFocus` (the row's link). The dialog is closed first, so the page behind is no longer inert when it is focused.
 *
 * Each of the three asks the leave guard first (LeaveGuard.tsx, README §1.5, screens §2.4): an autosave inside the drawer that is not confirmed
 * is saved (the drawer waits for it, at most 3 s), or the guard's notice asks at the top of the drawer (an upload running asks too: its reason is
 * „Üleslaadimine käib.“). The drawer's content is the guard's "drawer" scope: a close leaves only its sources, not the page's. The guard is the only
 * question a close asks (README §1.5: the lesson drawer's own question about unsaved text went with piece 3a, Task 10, when the drawer moved to the
 * autosave).
 * `fallbackFocus`: when the drawer goes away by a navigation (its item deleted) and `returnFocus` is gone with it, the focus goes to this
 * element instead of <body>.
 */
export function Drawer({
  label,
  closeHref,
  closeLabel,
  returnFocus,
  fallbackFocus,
  children,
}: {
  label: string;
  closeHref: string;
  closeLabel: string;
  returnFocus?: string;
  fallbackFocus?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const overflow = useRef("");
  const router = useRouter();
  const guard = useLeaveGuard();
  /** The close is the drawer's own (the guard let it go): the dialog's close event goes on to the address and the focus. */
  const allowed = useRef(false);
  const focus = useRef({ returnFocus, fallbackFocus });
  useEffect(() => {
    focus.current = { returnFocus, fallbackFocus };
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

  const close = () => {
    allowed.current = true;
    ref.current?.close();
  };
  /** ✕, Esc and the backdrop: the leave guard first. */
  const requestClose = () => guard.requestLeave(close, "drawer");

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
        // Esc: the drawer closes itself (requestClose), after the guard
        e.preventDefault();
        requestClose();
      }}
      onClose={(e) => {
        // the close of something inside the drawer (a dialog in it), handed on by React: not the drawer's
        if (e.target !== e.currentTarget) return;
        const own = allowed.current;
        allowed.current = false;
        // a close the browser forced past the guard (a second Esc at once): open again and ask
        if (!own) {
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
      <div className={styles.body}>
        <button type="button" className={styles.close} aria-label={closeLabel} onClick={requestClose}>
          <AdminIcon name="close" size={20} />
        </button>
        <LeaveNotice where="drawer" />
        <GuardScope>{children}</GuardScope>
      </div>
    </dialog>
  );
}
