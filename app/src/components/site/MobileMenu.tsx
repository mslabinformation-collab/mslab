"use client";

import { useEffect, useRef, useState } from "react";
import { lockPageScroll } from "@/lib/modal";
import { Icon } from "./Icon";
import styles from "./Header.module.css";

/** Burger button (below 1200px; Header.module.css) and B's menu dialog. Esc, the close button, the backdrop and any link close it. */
export function MobileMenu({
  openLabel,
  closeLabel,
  dialogLabel,
  children,
}: {
  openLabel: string;
  closeLabel: string;
  dialogLabel: string;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // Close when the window grows past the burger breakpoint.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1200px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) dialog.current?.close();
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // Keep the page behind the dialog still (B: body overflow hidden while a modal is open).
  useEffect(() => {
    if (!open) return;
    return lockPageScroll();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.menuToggle}
        aria-label={openLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        <Icon name="menu" />
      </button>
      <dialog
        ref={dialog}
        className={styles.menu}
        aria-label={dialogLabel}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target === e.currentTarget || target.closest("a")) dialog.current?.close();
        }}
      >
        <div className={styles.menuBody}>
          <button type="button" className={styles.menuClose} aria-label={closeLabel} onClick={() => dialog.current?.close()}>
            <Icon name="close" />
          </button>
          {children}
        </div>
      </dialog>
    </>
  );
}
